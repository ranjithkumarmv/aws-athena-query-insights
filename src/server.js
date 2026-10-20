import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Analysis, parseFilters } from "./analysis.js";
import { AwsApi, baseCredentials, defaultRegion, listProfiles } from "./aws.js";
import { FIELDS, MAX_DAYS, STATES, UI_KEYS, coerceAll, resolveConfig } from "./config.js";
import { describeError } from "./fetch.js";
import { TB } from "./normalize.js";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const require = createRequire(import.meta.url);
const VENDOR = {
    "/vendor/vue.js": require.resolve("vue/dist/vue.global.prod.js"),
    // chart.js only exports its ESM/CJS entry points; the UMD build sits next to them.
    "/vendor/chart.js": join(dirname(require.resolve("chart.js")), "chart.umd.js"),
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/**
 * `ctx`: { store, jobs, flags, env } — flags/env are the CLI/env layers, re-read
 * on every request so UI saves apply immediately.
 */
export function createApp(ctx) {
    const { store, jobs } = ctx;
    const config = () => resolveConfig({ flags: ctx.flags, env: ctx.env, ui: store.getSettings() });
    const analysis = new Analysis(store);
    const price = () => config().values.pricePerTb;

    const routes = {
        "GET /api/config": () => {
            const c = config();
            return {
                values: c.values,
                sources: c.sources,
                locked: c.locked,
                configFile: c.configFile,
                editable: UI_KEYS,
                fields: Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, { type: f.type, env: f.env, flag: "--" + f.flag }])),
                options: { states: STATES, maxDays: MAX_DAYS },
            };
        },
        "PUT /api/config": async req => {
            const body = await readJson(req);
            const locked = config().locked;
            const lockedChanges = Object.keys(body).filter(k => locked.includes(k));
            if (lockedChanges.length) throw httpError(400, `set by env/CLI, can't change from the UI: ${lockedChanges.join(", ")}`);
            const values = coerceAll(body, { only: UI_KEYS });
            store.saveSettings(values);
            return routes["GET /api/config"]();
        },
        "GET /api/aws/profiles": () => ({ profiles: listProfiles(ctx.env) }),
        "GET /api/aws/workgroups": async (req, url) => {
            const c = config().values;
            const region = url.searchParams.get("region") || c.regions[0] || (await defaultRegion(c.profile));
            if (!region) throw httpError(400, "no region");
            try {
                const api = new AwsApi({ region, credentials: baseCredentials(c.profile) });
                return { region, workgroups: await api.listWorkGroups() };
            } catch (e) {
                throw httpError(502, describeError(e));
            }
        },
        "GET /api/status": () => ({
            running: jobs.snapshot(),
            runs: store.listRuns(20),
            inventory: withCost(store.inventory(), config().values.pricePerTb),
            dbPath: store.path,
        }),
        "POST /api/fetch": async req => {
            const overrides = await readJson(req);
            const c = config();
            // One-off overrides for this run (not saved); locked keys still win.
            const once = coerceAll(Object.fromEntries(Object.entries(overrides).filter(([k]) => !c.locked.includes(k))), { only: UI_KEYS });
            const { runId } = jobs.start({ ...c.values, ...once });
            return { runId };
        },
        "POST /api/fetch/cancel": () => ({ cancelled: jobs.cancel() }),
        "GET /api/filters": () => analysis.filterOptions(),
        "GET /api/overview": (req, url) => analysis.overview(parseFilters(url.searchParams), price()),
        "GET /api/expensive": (req, url) => analysis.expensive(parseFilters(url.searchParams), price()),
        "GET /api/slow": (req, url) => analysis.slow(parseFilters(url.searchParams), price()),
        "GET /api/failures": (req, url) => analysis.failures(parseFilters(url.searchParams), price()),
    };

    return async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        try {
            if (req.method !== "GET" && req.method !== "HEAD") checkSameOrigin(req);
            if (url.pathname === "/api/fetch/events" && req.method === "GET") return sse(req, res, jobs);
            const queryMatch = req.method === "GET" && url.pathname.match(/^\/api\/query\/([^/]+)$/);
            if (queryMatch) {
                const detail = analysis.query(decodeURIComponent(queryMatch[1]), price());
                if (!detail) throw httpError(404, "query not found");
                return sendJson(res, 200, detail);
            }
            const route = routes[`${req.method} ${url.pathname}`];
            if (route) return sendJson(res, 200, await route(req, url));
            if (url.pathname.startsWith("/api/")) throw httpError(404, "not found");
            if (req.method === "GET" || req.method === "HEAD") return await serveStatic(url.pathname, res);
            throw httpError(405, "method not allowed");
        } catch (e) {
            const status = e.status ?? 400;
            if (status >= 500 && status !== 502) console.error(e);
            sendJson(res, status, { error: e.message });
        }
    };
}

export function startServer(ctx, { host, port }) {
    const server = createServer(createApp(ctx));
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server));
    });
}

function withCost(inv, pricePerTb) {
    const cost = b => ((b ?? 0) / TB) * pricePerTb;
    return {
        totals: { ...inv.totals, cost_usd: cost(inv.totals.billable_bytes) },
        scopes: inv.scopes.map(s => ({ ...s, cost_usd: cost(s.billable_bytes) })),
        pricePerTb,
    };
}

function sse(req, res, jobs) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "snapshot", running: jobs.snapshot() });
    const unsubscribe = jobs.subscribe(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
        clearInterval(ping);
        unsubscribe();
    });
}

async function serveStatic(pathname, res) {
    let file = VENDOR[pathname];
    if (!file) {
        const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
        file = join(WEB_DIR, rel);
        if (!file.startsWith(WEB_DIR)) throw httpError(404, "not found");
    }
    let body;
    try {
        body = await readFile(file);
    } catch {
        throw httpError(404, "not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
}

/** Basic CSRF guard: writes must be JSON and come from this page. */
function checkSameOrigin(req) {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw httpError(403, "cross-origin request refused");
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw httpError(415, "expected application/json");
}

async function readJson(req) {
    let text = "";
    for await (const chunk of req) {
        text += chunk;
        if (text.length > 100_000) throw httpError(413, "body too large");
    }
    if (!text) return {};
    try {
        const v = JSON.parse(text);
        if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
        return v;
    } catch {
        throw httpError(400, "invalid JSON body");
    }
}

function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}
