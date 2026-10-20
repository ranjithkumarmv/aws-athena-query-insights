import assert from "node:assert/strict";
import { test } from "node:test";
import { Analysis, maskError, parseFilters } from "../src/analysis.js";
import { openDb } from "../src/db.js";
import { normalizeQueryExecution } from "../src/normalize.js";

const MB = 1024 * 1024;
const T0 = Date.parse("2026-10-01T00:00:00Z");

function seed() {
    const store = openDb(":memory:");
    const rows = [];
    // 10 days × 10 queries: db "sales" (expensive, repeated), db "lake" (slow), every 5th fails
    for (let d = 0; d < 10; d++) {
        for (let i = 0; i < 10; i++) {
            const n = d * 10 + i;
            const failed = n % 5 === 4;
            rows.push(normalizeQueryExecution({
                QueryExecutionId: `q-${n}`,
                Query: i % 2 ? `SELECT * FROM sales.orders WHERE id = ${n}` : `SELECT count(*) FROM lake.events WHERE day = '${d}'`,
                StatementType: "DML",
                WorkGroup: i % 3 ? "primary" : "etl",
                QueryExecutionContext: { Database: i % 2 ? "sales" : "lake" },
                Status: {
                    State: failed ? "FAILED" : "SUCCEEDED",
                    SubmissionDateTime: new Date(T0 + d * 86400000 + i * 3600000),
                    ...(failed ? { AthenaError: { ErrorCategory: 2, ErrorType: 1301, ErrorMessage: `Table 'lake.t${n}' not found at s3://bucket/${n}/` } } : {}),
                },
                Statistics: { DataScannedInBytes: i % 2 ? 1024 * MB : 0, TotalExecutionTimeInMillis: i % 2 ? 1000 : 1000 * (n + 1), QueryQueueTimeInMillis: 50, EngineExecutionTimeInMillis: 900 },
            }, { accountId: "111122223333", region: "ca-central-1" }));
        }
    }
    store.upsert(rows);
    return { store, analysis: new Analysis(store) };
}

const filters = q => parseFilters(new URLSearchParams(q));

test("parseFilters validates input", () => {
    assert.throws(() => filters("from=yesterday"), /ISO/);
    assert.throws(() => filters("limit=9999"), /limit/);
    assert.throws(() => filters("tz=10000"), /tz/);
    assert.deepEqual(filters("workgroup=a,b&workgroup=c").workgroup, ["a", "b", "c"]);
});

test("overview: KPIs, zero-filled daily series, breakdowns, previous period", () => {
    const { analysis } = seed();
    const o = analysis.overview(filters("from=2026-10-06T00:00:00.000Z&to=2026-10-16T00:00:00.000Z"), 5);
    assert.equal(o.kpis.queries, 50); // seeded days 5-9 (Oct 6-10)
    assert.equal(o.kpis.failed, 10);
    assert.equal(o.kpis.fail_pct, 20);
    assert.equal(o.series.granularity, "day");
    assert.equal(o.series.buckets.length, 10); // 10 days requested, 5 empty
    assert.equal(o.series.buckets.at(-1).queries, 0);
    assert.equal(o.previous.queries, 50); // days 0-4
    const sales = o.byDatabase.find(r => r.name === "sales");
    assert.ok(sales.cost_usd > 0);
    assert.ok(o.kpis.p95_ms >= o.kpis.p50_ms);
});

test("hourly buckets for short ranges, shifted to the viewer's time zone", () => {
    const { analysis } = seed();
    const s = analysis.timeseries(filters("from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z&tz=330"), 5);
    assert.equal(s.granularity, "hour");
    assert.equal(s.buckets[0].t, "2026-10-01T05:00"); // 00:00 UTC = 05:30 IST → bucket 05:00
    assert.equal(s.buckets.reduce((a, b) => a + b.queries, 0), 10);
});

test("expensive groups repeated queries by hash", () => {
    const { analysis } = seed();
    const e = analysis.expensive(filters(""), 5);
    assert.equal(e.repeated[0].database, "sales");
    assert.equal(e.repeated[0].runs, 50);
    assert.ok(e.top.every(r => r.billable_bytes > 0));
    assert.equal(e.scanBuckets.length, 6);
});

test("slow: per-database percentiles", () => {
    const { analysis } = seed();
    const s = analysis.slow(filters("database=lake"), 5);
    assert.equal(s.perDatabase.length, 1);
    const lake = s.perDatabase[0];
    assert.ok(lake.p95_ms > lake.p50_ms);
    assert.equal(s.top[0].database, "lake");
});

test("failures: errors grouped with ids/paths masked", () => {
    const { analysis } = seed();
    const f = analysis.failures(filters(""), 5);
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].count, 20);
    assert.equal(f.errors[0].pattern, "Table '…' not found at s3://…");
    assert.equal(maskError("line 3:14: Column 'x' cannot be resolved"), "line N:N: Column '…' cannot be resolved");
});

test("query detail returns runs of the same normalized query", () => {
    const { analysis } = seed();
    const d = analysis.query("q-1", 5);
    assert.equal(d.summary.runs, 50);
    assert.equal(d.runs.length, 50);
    assert.equal(analysis.query("nope", 5), null);
    assert.equal(analysis.query("../etc", 5), null);
});
