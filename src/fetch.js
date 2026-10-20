import { AwsApi, baseCredentials, defaultRegion, roleCredentials } from "./aws.js";
import { FINAL_STATES } from "./db.js";
import { normalizeQueryExecution } from "./normalize.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pull query history into the store.
 *
 * For every (account, region, workgroup): page through ListQueryExecutions
 * (newest first, 50 ids a page), call BatchGetQueryExecution only for ids that
 * are new or not yet finished, and stop once a whole page is older than the
 * cutoff. Re-runs are therefore cheap, and widening `days` just pages further.
 *
 * `onEvent` receives { type: "log" | "progress" | "warning", ... }.
 * `makeApi` exists for tests.
 */
export async function runFetch(config, { store, onEvent = () => {}, signal, makeApi = opts => new AwsApi(opts), now = new Date() }) {
    const cutoffMs = now.getTime() - config.days * DAY_MS;
    const stats = { workgroups: 0, pages: 0, listed: 0, fetched: 0, inserted: 0, updated: 0, skipped: 0, warnings: [] };

    const warn = (message, extra = {}) => {
        stats.warnings.push({ message, ...extra });
        onEvent({ type: "warning", message, ...extra });
    };
    const log = message => onEvent({ type: "log", message });

    const regions = config.regions.length ? config.regions : [await defaultRegion(config.profile)].filter(Boolean);
    if (!regions.length) throw new Error("No region configured. Set regions in the UI, ATHENA_INSIGHTS_REGIONS, --region, or AWS_REGION.");

    const base = baseCredentials(config.profile);
    const targets = config.roleArns.length
        ? config.roleArns.map(roleArn => ({ label: roleArn, credentials: roleCredentials(base, roleArn) }))
        : [{ label: config.profile ? `profile ${config.profile}` : "default credentials", credentials: base }];

    // Discover every (account, region, workgroup) first so progress has a denominator.
    const units = [];
    for (const target of targets) {
        for (const region of regions) {
            throwIfAborted(signal);
            const api = makeApi({ region, credentials: target.credentials });
            let accountId, workgroups;
            try {
                accountId = await api.accountId();
                workgroups = await api.listWorkGroups(signal);
            } catch (e) {
                if (signal?.aborted) throw e;
                warn(`${target.label} / ${region}: ${describeError(e)}`, { target: target.label, region });
                continue;
            }
            const names = new Set(workgroups.map(w => w.name));
            for (const wanted of config.workgroups) {
                if (!names.has(wanted)) warn(`workgroup "${wanted}" not found in ${accountId} / ${region}`, { accountId, region });
            }
            const selected = config.workgroups.length ? workgroups.filter(w => config.workgroups.includes(w.name)) : workgroups;
            log(`${accountId} / ${region}: ${selected.length} workgroup(s): ${selected.map(w => w.name).join(", ")}`);
            for (const wg of selected) units.push({ api, accountId, region, workgroup: wg.name });
        }
    }

    // `done` units finished plus `fraction` of unit number `i` (0-based).
    const progress = (done, fraction, i, extra = {}) => {
        const unit = units[i];
        onEvent({
            type: "progress",
            percent: units.length ? Math.min(100, ((done + fraction) / units.length) * 100) : 100,
            unit: unit ? { accountId: unit.accountId, region: unit.region, workgroup: unit.workgroup, index: i + 1, total: units.length } : null,
            stats: { ...stats, warnings: stats.warnings.length },
            ...extra,
        });
    };

    progress(0, 0, -1);
    for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        try {
            await fetchWorkgroup(unit, { config, store, signal, cutoffMs, now, stats, warn, onPage: oldestMs => {
                const fraction = oldestMs == null ? 0 : (now.getTime() - oldestMs) / (now.getTime() - cutoffMs);
                progress(i, Math.max(0, Math.min(1, fraction)), i);
            } });
        } catch (e) {
            if (signal?.aborted) throw e;
            warn(`${unit.accountId} / ${unit.region} / ${unit.workgroup}: ${describeError(e)}`, { accountId: unit.accountId, region: unit.region, workgroup: unit.workgroup });
        }
        stats.workgroups++;
        progress(i + 1, 0, i);
    }
    return stats;
}

async function fetchWorkgroup(unit, { config, store, signal, cutoffMs, now, stats, warn, onPage }) {
    const { api, accountId, region, workgroup } = unit;
    let nextToken;
    do {
        throwIfAborted(signal);
        const page = await api.listQueryExecutions(workgroup, nextToken, signal);
        nextToken = page.nextToken;
        if (!page.ids.length) break;
        stats.pages++;
        stats.listed += page.ids.length;

        const known = store.existing(page.ids);
        const toGet = page.ids.filter(id => !FINAL_STATES.includes(known.get(id)?.state));
        stats.skipped += page.ids.length - toGet.length;

        // Submission times for every id on the page, to decide when to stop.
        const times = page.ids.map(id => known.get(id)?.submitted_at).filter(Boolean).map(t => Date.parse(t));

        if (toGet.length) {
            const { executions, unprocessed } = await api.batchGetQueryExecution(toGet, signal);
            if (unprocessed.length) {
                warn(`${unprocessed.length} query id(s) not returned by BatchGetQueryExecution in ${workgroup}`, {
                    accountId, region, workgroup, sample: unprocessed.slice(0, 3).map(u => `${u.QueryExecutionId}: ${u.ErrorMessage ?? u.ErrorCode}`),
                });
            }
            const rows = executions.map(qe => normalizeQueryExecution(qe, { accountId, region, storeQueryText: config.storeQueryText, now }));
            for (const r of rows) if (r.submitted_at) times.push(Date.parse(r.submitted_at));

            const keep = rows.filter(r =>
                (!config.states.length || config.states.includes(r.state)) &&
                (!r.submitted_at || Date.parse(r.submitted_at) >= cutoffMs));
            store.upsert(keep);
            stats.fetched += rows.length;
            for (const r of keep) known.has(r.query_execution_id) ? stats.updated++ : stats.inserted++;
        }

        const oldest = times.length ? Math.min(...times) : null;
        const newest = times.length ? Math.max(...times) : null;
        onPage(oldest);
        // Pages come newest first; once a whole page is before the cutoff we're done.
        if (newest != null && newest < cutoffMs) break;
    } while (nextToken);
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const e = new Error("Fetch cancelled");
        e.name = "AbortError";
        throw e;
    }
}

export function describeError(e) {
    const code = e?.name && e.name !== "Error" ? e.name : null;
    const msg = e?.message ?? String(e);
    if (code === "CredentialsProviderError") return `no AWS credentials found (${msg})`;
    return code ? `${code}: ${msg}` : msg;
}
