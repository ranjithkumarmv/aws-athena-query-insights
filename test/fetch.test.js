import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.js";
import { runFetch } from "../src/fetch.js";

const NOW = new Date("2026-10-21T12:00:00Z");
const HOUR = 3600 * 1000;

/** Fake Athena: `queries` per workgroup, newest first; counts calls. */
function fakeApi(byWorkgroup) {
    const calls = { list: 0, batch: 0, batchIds: 0 };
    const api = {
        calls,
        accountId: async () => "111122223333",
        listWorkGroups: async () => Object.keys(byWorkgroup).map(name => ({ name, state: "ENABLED" })),
        listQueryExecutions: async (wg, token) => {
            calls.list++;
            const all = byWorkgroup[wg];
            const start = token ? Number(token) : 0;
            const ids = all.slice(start, start + 50).map(q => q.QueryExecutionId);
            return { ids, nextToken: start + 50 < all.length ? String(start + 50) : undefined };
        },
        batchGetQueryExecution: async ids => {
            calls.batch++;
            calls.batchIds += ids.length;
            const all = Object.values(byWorkgroup).flat();
            return { executions: ids.map(id => all.find(q => q.QueryExecutionId === id)), unprocessed: [] };
        },
    };
    return api;
}

function makeQueries(wg, count, { stepHours = 1, state = "SUCCEEDED" } = {}) {
    return Array.from({ length: count }, (_, i) => ({
        QueryExecutionId: `${wg}-${i}`,
        Query: `select * from t where id = ${i}`,
        StatementType: "DML",
        WorkGroup: wg,
        QueryExecutionContext: { Database: "db" },
        Status: { State: typeof state === "function" ? state(i) : state, SubmissionDateTime: new Date(NOW - i * stepHours * HOUR) },
        Statistics: { DataScannedInBytes: 1024, TotalExecutionTimeInMillis: 100 },
    }));
}

const baseConfig = { profile: null, regions: ["us-east-1"], roleArns: [], workgroups: [], states: [], days: 2, storeQueryText: true };

test("fetches every workgroup, stops at the cutoff, and re-runs only fetch unfinished queries", async () => {
    const data = {
        primary: makeQueries("primary", 120), // one per hour: 48 within 2 days
        etl: makeQueries("etl", 10, { state: i => (i === 0 ? "RUNNING" : "SUCCEEDED") }),
    };
    const store = openDb(":memory:");
    const api = fakeApi(data);
    const events = [];
    const stats = await runFetch(baseConfig, { store, makeApi: () => api, now: NOW, onEvent: e => events.push(e) });

    assert.equal(stats.workgroups, 2);
    // primary: pages of 50 → page 1 (0-49) crosses the cutoff, page 2 (50-99) is all older → stop; page 3 never listed
    assert.equal(api.calls.list, 3);
    const inv = store.inventory();
    assert.equal(inv.totals.queries, 49 + 10); // hours 0..48 inclusive, plus etl
    assert.ok(events.some(e => e.type === "progress" && e.percent === 100));

    // Second run: only the RUNNING query is fetched again.
    data.etl[0].Status.State = "SUCCEEDED";
    const before = api.calls.batchIds;
    const stats2 = await runFetch(baseConfig, { store, makeApi: () => api, now: NOW });
    // etl-0 (was RUNNING) + primary-49 (just past the cutoff, so never stored) + page 2 of primary (all older)
    assert.equal(api.calls.batchIds - before, 1 + 1 + 50);
    assert.equal(stats2.inserted, 0);
    assert.equal(stats2.updated, 1);
    assert.equal(store.existing(["etl-0"]).get("etl-0").state, "SUCCEEDED");
});

test("workgroup and state filters", async () => {
    const data = {
        primary: makeQueries("primary", 5),
        etl: makeQueries("etl", 6, { state: i => (i % 2 ? "FAILED" : "SUCCEEDED") }),
    };
    const store = openDb(":memory:");
    const events = [];
    const stats = await runFetch(
        { ...baseConfig, workgroups: ["etl", "missing"], states: ["FAILED"] },
        { store, makeApi: () => fakeApi(data), now: NOW, onEvent: e => events.push(e) },
    );
    assert.equal(store.inventory().totals.queries, 3);
    assert.equal(stats.warnings.length, 1);
    assert.match(stats.warnings[0].message, /"missing" not found/);
});

test("an AWS error on one region becomes a warning, not a crash", async () => {
    const store = openDb(":memory:");
    const stats = await runFetch(
        { ...baseConfig, regions: ["us-east-1", "eu-west-1"] },
        {
            store,
            now: NOW,
            makeApi: ({ region }) => {
                const api = fakeApi({ primary: makeQueries("primary", 3) });
                if (region === "eu-west-1") api.listWorkGroups = async () => { throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }); };
                return api;
            },
        },
    );
    assert.equal(store.inventory().totals.queries, 3);
    assert.equal(stats.warnings.length, 1);
    assert.match(stats.warnings[0].message, /eu-west-1: AccessDeniedException/);
});

test("cancel stops the run", async () => {
    const store = openDb(":memory:");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        runFetch(baseConfig, { store, makeApi: () => fakeApi({ primary: makeQueries("primary", 3) }), now: NOW, signal: controller.signal }),
        /cancelled/,
    );
});
