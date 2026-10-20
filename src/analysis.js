import { TB } from "./normalize.js";

/**
 * All analysis SQL lives here. Every function takes the same filter object:
 *   { from, to, account[], region[], workgroup[], database[], state[], tz, limit }
 * `from`/`to` are ISO UTC strings (to is exclusive); `tz` is the viewer's UTC
 * offset in minutes, used only to bucket time series in local time.
 */

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DIMENSIONS = {
    account: "account_id",
    region: "region",
    workgroup: "workgroup",
    database: "COALESCE(database, '(none)')",
    state: "state",
};
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ID_RE = /^[\w-]{1,128}$/;
const HASH_RE = /^[0-9a-f]{16}$/;

/** Filters from URL search params. Throws on malformed values. */
export function parseFilters(params) {
    const f = { tz: 0, limit: 50 };
    for (const key of ["from", "to"]) {
        const v = params.get(key);
        if (!v) continue;
        if (!ISO_RE.test(v) || Number.isNaN(Date.parse(v))) throw new Error(`${key}: expected an ISO UTC timestamp`);
        f[key] = new Date(v).toISOString();
    }
    for (const key of Object.keys(DIMENSIONS)) {
        const v = params.getAll(key).flatMap(s => s.split(",")).map(s => s.trim()).filter(Boolean);
        if (v.length) f[key] = [...new Set(v)].slice(0, 100);
    }
    if (params.has("tz")) {
        const tz = Number(params.get("tz"));
        if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) throw new Error("tz: expected minutes east of UTC");
        f.tz = tz;
    }
    if (params.has("limit")) {
        const limit = Number(params.get("limit"));
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit: 1-500");
        f.limit = limit;
    }
    return f;
}

function where(f, extra = []) {
    const clauses = [...extra];
    const params = [];
    if (f.from) {
        clauses.push("submitted_at >= ?");
        params.push(f.from);
    }
    if (f.to) {
        clauses.push("submitted_at < ?");
        params.push(f.to);
    }
    for (const [key, col] of Object.entries(DIMENSIONS)) {
        if (!f[key]?.length) continue;
        clauses.push(`${col} IN (${f[key].map(() => "?").join(",")})`);
        params.push(...f[key]);
    }
    return { sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}

const costOf = (bytes, price) => ((bytes ?? 0) / TB) * price;
const plain = row => (row ? { ...row } : row);

export class Analysis {
    constructor(store) {
        this.db = store.db;
    }

    all(sql, params) {
        return this.db.prepare(sql).all(...params).map(plain);
    }

    get(sql, params) {
        return plain(this.db.prepare(sql).get(...params));
    }

    /** Values for the filter dropdowns, with counts, ignoring the current filters. */
    filterOptions() {
        const opts = {};
        for (const [key, col] of Object.entries(DIMENSIONS)) {
            opts[key] = this.all(`SELECT ${col} AS value, COUNT(*) AS n FROM queries GROUP BY 1 ORDER BY n DESC LIMIT 200`, []);
        }
        const range = this.get("SELECT MIN(submitted_at) AS first_at, MAX(submitted_at) AS last_at, COUNT(*) AS queries FROM queries", []);
        return { ...opts, range };
    }

    kpis(f, price) {
        const w = where(f);
        const k = this.get(
            `SELECT COUNT(*) AS queries,
                    SUM(state = 'SUCCEEDED') AS succeeded,
                    SUM(state = 'FAILED') AS failed,
                    SUM(state = 'CANCELLED') AS cancelled,
                    SUM(billable_bytes) AS billable_bytes,
                    SUM(bytes_scanned) AS bytes_scanned,
                    SUM(result_reused) AS reused,
                    COUNT(DISTINCT query_hash) AS distinct_queries,
                    AVG(CASE WHEN state = 'SUCCEEDED' THEN total_ms END) AS avg_ms,
                    AVG(CASE WHEN state = 'SUCCEEDED' THEN queue_ms END) AS avg_queue_ms
             FROM queries ${w.sql}`,
            w.params,
        );
        const finished = (k.succeeded ?? 0) + (k.failed ?? 0) + (k.cancelled ?? 0);
        return {
            ...k,
            cost_usd: costOf(k.billable_bytes, price),
            fail_pct: finished ? (k.failed / finished) * 100 : null,
            p50_ms: this.percentile(f, 0.5),
            p95_ms: this.percentile(f, 0.95),
        };
    }

    /** Nearest-rank percentile of total_ms over succeeded queries. */
    percentile(f, p) {
        const w = where(f, ["state = 'SUCCEEDED'", "total_ms IS NOT NULL"]);
        const n = this.get(`SELECT COUNT(*) AS n FROM queries ${w.sql}`, w.params).n;
        if (!n) return null;
        const offset = Math.max(0, Math.ceil(p * n) - 1);
        return this.get(`SELECT total_ms FROM queries ${w.sql} ORDER BY total_ms LIMIT 1 OFFSET ?`, [...w.params, offset]).total_ms;
    }

    /**
     * Time buckets (hour or day, in the viewer's time zone), zero-filled.
     * Returns { granularity, buckets: [{ t, queries, failed, billable_bytes, cost_usd, avg_queue_ms, avg_engine_ms, ... }] }.
     */
    timeseries(f, price) {
        const bounds = this.bounds(f);
        if (!bounds) return { granularity: "day", buckets: [] };
        const granularity = bounds.to - bounds.from <= 3 * DAY_MS ? "hour" : "day";
        const fmt = granularity === "hour" ? "%Y-%m-%dT%H:00" : "%Y-%m-%d";
        const shift = `${f.tz >= 0 ? "+" : ""}${f.tz} minutes`;
        const w = where(f);
        const rows = this.all(
            `SELECT strftime('${fmt}', submitted_at, ?) AS t,
                    COUNT(*) AS queries,
                    SUM(state = 'FAILED') AS failed,
                    SUM(state = 'CANCELLED') AS cancelled,
                    SUM(billable_bytes) AS billable_bytes,
                    AVG(CASE WHEN state = 'SUCCEEDED' THEN queue_ms END) AS avg_queue_ms,
                    AVG(CASE WHEN state = 'SUCCEEDED' THEN engine_ms END) AS avg_engine_ms,
                    AVG(CASE WHEN state = 'SUCCEEDED' THEN total_ms END) AS avg_total_ms
             FROM queries ${w.sql}
             GROUP BY 1 ORDER BY 1`,
            [shift, ...w.params],
        );
        const byT = new Map(rows.map(r => [r.t, r]));
        const step = granularity === "hour" ? HOUR_MS : DAY_MS;
        const label = ms => {
            const iso = new Date(ms).toISOString();
            return granularity === "hour" ? iso.slice(0, 13) + ":00" : iso.slice(0, 10);
        };
        // Walk local-time buckets: shift by tz, truncate, step.
        const tzMs = f.tz * 60 * 1000;
        let cur = Math.floor((bounds.from + tzMs) / step) * step;
        const end = bounds.to + tzMs;
        const buckets = [];
        for (let i = 0; cur < end && i < 5000; i++, cur += step) {
            const t = label(cur);
            const r = byT.get(t) ?? { queries: 0, failed: 0, cancelled: 0, billable_bytes: 0, avg_queue_ms: null, avg_engine_ms: null, avg_total_ms: null };
            buckets.push({ ...r, t, cost_usd: costOf(r.billable_bytes, price) });
        }
        return { granularity, buckets };
    }

    bounds(f) {
        if (f.from && f.to) return { from: Date.parse(f.from), to: Date.parse(f.to) };
        const w = where(f);
        const r = this.get(`SELECT MIN(submitted_at) AS a, MAX(submitted_at) AS b FROM queries ${w.sql}`, w.params);
        if (!r.a) return null;
        return { from: f.from ? Date.parse(f.from) : Date.parse(r.a), to: f.to ? Date.parse(f.to) : Date.parse(r.b) + 1 };
    }

    /** Totals by a dimension; the tail past `top` folds into "Other". */
    breakdown(f, price, dimension, top = 8) {
        const col = DIMENSIONS[dimension];
        const w = where(f);
        const rows = this.all(
            `SELECT ${col} AS name, COUNT(*) AS queries, SUM(billable_bytes) AS billable_bytes,
                    SUM(state = 'FAILED') AS failed,
                    AVG(CASE WHEN state = 'SUCCEEDED' THEN total_ms END) AS avg_ms
             FROM queries ${w.sql} GROUP BY 1 ORDER BY billable_bytes DESC, queries DESC`,
            w.params,
        );
        const head = rows.slice(0, top);
        const tail = rows.slice(top);
        if (tail.length) {
            head.push({
                name: `Other (${tail.length})`,
                other: true,
                queries: tail.reduce((s, r) => s + r.queries, 0),
                billable_bytes: tail.reduce((s, r) => s + (r.billable_bytes ?? 0), 0),
                failed: tail.reduce((s, r) => s + (r.failed ?? 0), 0),
                avg_ms: null,
            });
        }
        return head.map(r => ({ ...r, cost_usd: costOf(r.billable_bytes, price) }));
    }

    scanBuckets(f) {
        const w = where(f, ["state = 'SUCCEEDED'"]);
        const rows = this.all(
            `SELECT CASE
                      WHEN bytes_scanned IS NULL OR bytes_scanned < 10485760 THEN 0
                      WHEN bytes_scanned < 104857600 THEN 1
                      WHEN bytes_scanned < 1073741824 THEN 2
                      WHEN bytes_scanned < 10737418240 THEN 3
                      WHEN bytes_scanned < 107374182400 THEN 4
                      ELSE 5 END AS bucket,
                    COUNT(*) AS queries, SUM(billable_bytes) AS billable_bytes
             FROM queries ${w.sql} GROUP BY 1`,
            w.params,
        );
        const labels = ["< 10 MB", "10–100 MB", "100 MB–1 GB", "1–10 GB", "10–100 GB", "≥ 100 GB"];
        return labels.map((label, i) => ({ label, queries: rows.find(r => r.bucket === i)?.queries ?? 0, billable_bytes: rows.find(r => r.bucket === i)?.billable_bytes ?? 0 }));
    }

    /**
     * Same-length window just before `from`, for deltas. Null when stored
     * history doesn't cover that whole window: a partial baseline gives
     * meaningless percentages.
     */
    previous(f) {
        if (!f.from || !f.to) return null;
        const len = Date.parse(f.to) - Date.parse(f.from);
        const prevFrom = Date.parse(f.from) - len;
        const first = this.get("SELECT MIN(submitted_at) AS first_at FROM queries", []).first_at;
        if (!first || Date.parse(first) > prevFrom) return null;
        return { ...f, from: new Date(prevFrom).toISOString(), to: f.from };
    }

    overview(f, price) {
        const prev = this.previous(f);
        return {
            kpis: this.kpis(f, price),
            previous: prev ? this.kpis(prev, price) : null,
            series: this.timeseries(f, price),
            byWorkgroup: this.breakdown(f, price, "workgroup"),
            byDatabase: this.breakdown(f, price, "database"),
        };
    }

    expensive(f, price) {
        const w = where(f, ["billable_bytes > 0"]);
        const top = this.all(
            `SELECT query_execution_id, account_id, region, workgroup, database, state, submitted_at,
                    total_ms, bytes_scanned, billable_bytes, query_hash, substr(query_text, 1, 400) AS query_text
             FROM queries ${w.sql} ORDER BY billable_bytes DESC LIMIT ?`,
            [...w.params, f.limit],
        ).map(r => ({ ...r, cost_usd: costOf(r.billable_bytes, price) }));
        return {
            kpis: this.kpis(f, price),
            top,
            repeated: this.byHash(f, price, "total_billable DESC"),
            scanBuckets: this.scanBuckets(f).map(b => ({ ...b, cost_usd: costOf(b.billable_bytes, price) })),
            byDatabase: this.breakdown(f, price, "database"),
        };
    }

    /** Queries grouped by normalized-SQL hash. */
    byHash(f, price, order) {
        const w = where(f, ["query_hash IS NOT NULL"]);
        return this.all(
            `WITH g AS (
                SELECT query_hash, COUNT(*) AS runs,
                       SUM(billable_bytes) AS total_billable,
                       AVG(bytes_scanned) AS avg_bytes,
                       SUM(state = 'FAILED') AS failed,
                       AVG(CASE WHEN state = 'SUCCEEDED' THEN total_ms END) AS avg_ms,
                       MAX(CASE WHEN state = 'SUCCEEDED' THEN total_ms END) AS max_ms,
                       MAX(submitted_at) AS last_at,
                       COUNT(DISTINCT workgroup) AS workgroups,
                       MAX(query_execution_id) AS sample_id
                FROM queries ${w.sql} GROUP BY query_hash
            )
            SELECT g.*, substr(q.query_text, 1, 400) AS query_text, q.database, q.workgroup
            FROM g JOIN queries q ON q.query_execution_id = g.sample_id
            ORDER BY ${order} LIMIT ?`,
            [...w.params, f.limit],
        ).map(r => ({ ...r, total_cost_usd: costOf(r.total_billable, price) }));
    }

    slow(f, price) {
        const w = where(f, ["state = 'SUCCEEDED'", "total_ms IS NOT NULL"]);
        const top = this.all(
            `SELECT query_execution_id, workgroup, database, submitted_at, total_ms, queue_ms, planning_ms, engine_ms,
                    processing_ms, bytes_scanned, billable_bytes, query_hash, substr(query_text, 1, 400) AS query_text
             FROM queries ${w.sql} ORDER BY total_ms DESC LIMIT ?`,
            [...w.params, f.limit],
        ).map(r => ({ ...r, cost_usd: costOf(r.billable_bytes, price) }));

        // p50 / p95 per database, nearest rank, via window functions.
        const perDatabase = this.all(
            `WITH r AS (
                SELECT COALESCE(database, '(none)') AS name, total_ms, queue_ms,
                       ROW_NUMBER() OVER (PARTITION BY COALESCE(database, '(none)') ORDER BY total_ms) AS rn,
                       COUNT(*) OVER (PARTITION BY COALESCE(database, '(none)')) AS n
                FROM queries ${w.sql}
            )
            SELECT name, MAX(n) AS queries, AVG(total_ms) AS avg_ms, AVG(queue_ms) AS avg_queue_ms,
                   MAX(CASE WHEN rn = CAST(0.5 * n + 0.999999 AS INTEGER) THEN total_ms END) AS p50_ms,
                   MAX(CASE WHEN rn = CAST(0.95 * n + 0.999999 AS INTEGER) THEN total_ms END) AS p95_ms,
                   MAX(total_ms) AS max_ms
            FROM r GROUP BY name ORDER BY p95_ms DESC LIMIT 50`,
            w.params,
        );

        const phases = this.get(
            `SELECT SUM(queue_ms) AS queue_ms, SUM(planning_ms) AS planning_ms, SUM(engine_ms) AS engine_ms,
                    SUM(processing_ms) AS processing_ms, SUM(preprocessing_ms) AS preprocessing_ms
             FROM queries ${w.sql}`,
            w.params,
        );

        return {
            kpis: this.kpis(f, price),
            series: this.timeseries(f, price),
            top,
            perDatabase,
            phases,
            repeated: this.byHash(f, price, "avg_ms * runs DESC"),
        };
    }

    failures(f, price) {
        const series = this.timeseries(f, price);
        const byDatabase = this.failRate(f, "database");
        const byWorkgroup = this.failRate(f, "workgroup");

        // Group failures by error type + message with ids, paths and numbers masked.
        const w = where(f, ["state = 'FAILED'"]);
        const rows = this.all(
            `SELECT query_execution_id, submitted_at, database, workgroup, error_category, error_type, retryable,
                    COALESCE(error_message, state_change_reason) AS message
             FROM queries ${w.sql} ORDER BY submitted_at DESC LIMIT 20000`,
            w.params,
        );
        const groups = new Map();
        for (const r of rows) {
            const pattern = maskError(r.message);
            const key = `${r.error_type ?? ""}|${pattern}`;
            let g = groups.get(key);
            if (!g) {
                g = { pattern, error_type: r.error_type, error_category: r.error_category, retryable: r.retryable, count: 0, databases: new Set(), last_at: r.submitted_at, sample_id: r.query_execution_id, sample_message: r.message };
                groups.set(key, g);
            }
            g.count++;
            g.databases.add(r.database ?? "(none)");
        }
        const errors = [...groups.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, f.limit)
            .map(g => ({ ...g, databases: [...g.databases].slice(0, 5), database_count: g.databases.size }));

        const recent = rows.slice(0, f.limit);
        return { kpis: this.kpis(f, price), series, byDatabase, byWorkgroup, errors, recent };
    }

    failRate(f, dimension) {
        const col = DIMENSIONS[dimension];
        const w = where(f, ["state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')"]);
        return this.all(
            `SELECT ${col} AS name, COUNT(*) AS queries, SUM(state = 'FAILED') AS failed,
                    ROUND(SUM(state = 'FAILED') * 100.0 / COUNT(*), 2) AS fail_pct
             FROM queries ${w.sql} GROUP BY 1 HAVING failed > 0
             ORDER BY failed DESC LIMIT 20`,
            w.params,
        );
    }

    /** One execution plus every stored run of the same normalized query. */
    query(id, price) {
        if (!ID_RE.test(id)) return null;
        const row = this.get("SELECT * FROM queries WHERE query_execution_id = ?", [id]);
        if (!row) return null;
        row.cost_usd = costOf(row.billable_bytes, price);
        let runs = [];
        let summary = null;
        if (row.query_hash && HASH_RE.test(row.query_hash)) {
            runs = this.all(
                `SELECT query_execution_id, submitted_at, state, workgroup, database, total_ms, queue_ms, engine_ms,
                        bytes_scanned, billable_bytes, result_reused, error_message
                 FROM queries WHERE query_hash = ? ORDER BY submitted_at DESC LIMIT 200`,
                [row.query_hash],
            ).map(r => ({ ...r, cost_usd: costOf(r.billable_bytes, price) }));
            const s = this.get(
                `SELECT COUNT(*) AS runs, SUM(billable_bytes) AS billable_bytes, SUM(state = 'FAILED') AS failed,
                        AVG(CASE WHEN state = 'SUCCEEDED' THEN total_ms END) AS avg_ms,
                        MIN(submitted_at) AS first_at, MAX(submitted_at) AS last_at
                 FROM queries WHERE query_hash = ?`,
                [row.query_hash],
            );
            summary = { ...s, cost_usd: costOf(s.billable_bytes, price) };
        }
        return { query: row, summary, runs };
    }
}

export function maskError(message) {
    if (!message) return "(no message)";
    return message
        .replace(/s3a?:\/\/[^\s'"]+/gi, "s3://…")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
        .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "'…'")
        .replace(/\b\d+\b/g, "N")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
}
