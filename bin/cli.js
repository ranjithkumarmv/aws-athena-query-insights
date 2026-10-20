#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on Node 22; it's stable enough for this use.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
    const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
    if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
    return emitWarning.call(process, warning, ...args);
};

const { parseArgs } = await import("node:util");
const { resolveConfig } = await import("../src/config.js");
const { openDb } = await import("../src/db.js");
const { FetchManager } = await import("../src/jobs.js");
const { startServer } = await import("../src/server.js");
const { TB } = await import("../src/normalize.js");

const HELP = `athena-query-insights — Athena query history → SQLite → browser

Usage:
  athena-query-insights [serve]   start the web UI (default)
  athena-query-insights fetch     pull query history, then exit
  athena-query-insights config    print the effective settings and where each came from

Options (each also settable as an env var, in athena-insights.config.json, or in the UI):
  --profile <name>        AWS profile                         ATHENA_INSIGHTS_PROFILE (or AWS_PROFILE)
  --region <r[,r]>        region(s), repeatable               ATHENA_INSIGHTS_REGIONS (or AWS_REGION)
  --role-arn <arn>        assume role(s) for other accounts   ATHENA_INSIGHTS_ROLE_ARNS
  --workgroup <wg>        only these workgroups (default all) ATHENA_INSIGHTS_WORKGROUPS
  --state <s>             only these states (default all)     ATHENA_INSIGHTS_STATES
  --days <n>              history to pull, 1-45 (default 7)   ATHENA_INSIGHTS_DAYS
  --no-query-text         store a hash, not the SQL text      ATHENA_INSIGHTS_STORE_QUERY_TEXT=false
  --price-per-tb <usd>    on-demand price (default 5)         ATHENA_INSIGHTS_PRICE_PER_TB
  --db <path>             SQLite file                         ATHENA_INSIGHTS_DB
  --host <host>           bind address (default 127.0.0.1)    ATHENA_INSIGHTS_HOST
  --port <port>           port (default 4567)                 ATHENA_INSIGHTS_PORT
  --config <file>         JSON config file                    ATHENA_INSIGHTS_CONFIG
  --fetch                 with serve: start a fetch on startup
  -h, --help

Precedence: defaults < config file < saved in UI < env < CLI. Env/CLI values are read-only in the UI.
AWS credentials come from the standard AWS chain (env, ~/.aws, SSO, instance or task role).`;

let parsed;
try {
    parsed = parseArgs({
        allowPositionals: true,
        options: {
            profile: { type: "string" },
            region: { type: "string", multiple: true },
            "role-arn": { type: "string", multiple: true },
            workgroup: { type: "string", multiple: true },
            state: { type: "string", multiple: true },
            days: { type: "string" },
            "query-text": { type: "boolean" },
            "no-query-text": { type: "boolean" },
            "price-per-tb": { type: "string" },
            db: { type: "string" },
            host: { type: "string" },
            port: { type: "string" },
            config: { type: "string" },
            fetch: { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    });
} catch (e) {
    console.error(e.message + "\n\n" + HELP);
    process.exit(2);
}

const { values: flags, positionals } = parsed;
if (flags["no-query-text"]) flags["query-text"] = false;
const command = positionals[0] ?? "serve";
if (flags.help || !["serve", "fetch", "config"].includes(command)) {
    console.log(HELP);
    process.exit(flags.help ? 0 : 2);
}

function fail(message) {
    console.error("error: " + message);
    process.exit(1);
}

let base, store;
try {
    // dbPath can't come from the UI layer, so resolve it first.
    base = resolveConfig({ flags, env: process.env });
    store = openDb(base.values.dbPath);
} catch (e) {
    fail(e.message);
}
store.markAbandonedRuns();
const current = () => resolveConfig({ flags, env: process.env, ui: store.getSettings() });

if (command === "config") {
    const c = current();
    console.log(`config file: ${c.configFile ?? "(none)"}\n`);
    for (const [k, v] of Object.entries(c.values)) {
        console.log(`${k.padEnd(15)} ${JSON.stringify(v).padEnd(40)} ${c.sources[k]}`);
    }
    process.exit(0);
}

const jobs = new FetchManager(store);

if (command === "fetch") {
    const config = current().values;
    const isTty = process.stderr.isTTY;
    let lastLine = "";
    jobs.subscribe(e => {
        if (e.type === "progress") {
            const u = e.unit ? `${e.unit.index}/${e.unit.total} ${e.unit.region}/${e.unit.workgroup}` : "discovering";
            const line = `[${e.percent.toFixed(0).padStart(3)}%] ${u}  listed ${e.stats.listed}  new ${e.stats.inserted}  refreshed ${e.stats.updated}  already stored ${e.stats.skipped}`;
            if (isTty) process.stderr.write("\r\x1b[K" + line);
            else if (line !== lastLine && e.percent % 10 < 1) console.error(line);
            lastLine = line;
        } else if (e.type === "log" || e.type === "warning") {
            if (isTty) process.stderr.write("\r\x1b[K");
            console.error((e.type === "warning" ? "warning: " : "") + e.message);
        }
    });
    process.on("SIGINT", () => jobs.cancel());
    console.error(`Fetching ${config.days} day(s) of history into ${store.path}`);
    const { done } = jobs.start(config);
    const result = await done;
    if (isTty) process.stderr.write("\r\x1b[K" + lastLine + "\n");
    if (result.error) fail(`${result.status}: ${result.error}`);
    const s = result.stats;
    const inv = store.inventory().totals;
    console.error(`${result.status}: ${s.workgroups} workgroup(s), ${s.listed} listed, ${s.inserted} new, ${s.updated} refreshed, ${s.skipped} already stored, ${s.warnings.length} warning(s)`);
    console.error(`store now holds ${inv.queries} queries, ${inv.first_at ?? "-"} → ${inv.last_at ?? "-"}, ~$${(((inv.billable_bytes ?? 0) / TB) * config.pricePerTb).toFixed(2)} on-demand cost`);
    store.close();
    process.exit(s.warnings.length && !s.listed ? 1 : 0);
}

// serve
const { host, port } = base.values;
try {
    await startServer({ store, jobs, flags, env: process.env }, { host, port });
} catch (e) {
    fail(e.code === "EADDRINUSE" ? `port ${port} is already in use (use --port)` : e.message);
}
const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
console.log(`athena-query-insights: http://${shown}:${port}  (db: ${store.path})`);
if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.log("note: listening beyond localhost with no authentication — keep it on a trusted network.");
}
if (flags.fetch) jobs.start(current().values);
const shutdown = () => {
    jobs.cancel();
    store.close();
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
