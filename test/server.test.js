import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.js";
import { FetchManager } from "../src/jobs.js";
import { startServer } from "../src/server.js";

async function withServer(fn, env = {}) {
    const store = openDb(":memory:");
    const server = await startServer({ store, jobs: new FetchManager(store), flags: {}, env }, { host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await fn(base);
    } finally {
        server.close();
        store.close();
    }
}

test("unknown static path is a 404, and the server keeps running", () =>
    withServer(async base => {
        assert.equal((await fetch(base + "/favicon.ico")).status, 404);
        assert.equal((await fetch(base + "/../../etc/passwd")).status, 404);
        assert.equal((await fetch(base + "/")).status, 200);
        assert.equal((await fetch(base + "/vendor/vue.js")).status, 200);
        assert.equal((await fetch(base + "/vendor/chart.js")).status, 200);
    }));

test("settings save from the UI, env-locked keys are refused", () =>
    withServer(async base => {
        const put = body => fetch(base + "/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        let r = await put({ days: 3, workgroups: ["a", "b"] });
        assert.equal(r.status, 200);
        const c = await r.json();
        assert.equal(c.values.days, 3);
        assert.equal(c.sources.days, "ui");
        assert.deepEqual(c.values.workgroups, ["a", "b"]);

        r = await put({ pricePerTb: 7 });
        assert.equal(r.status, 400);
        assert.match((await r.json()).error, /pricePerTb/);

        r = await put({ days: 99 });
        assert.equal(r.status, 400);

        r = await fetch(base + "/api/config", { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "{}" });
        assert.equal(r.status, 415, "non-JSON writes are refused (CSRF guard)");
    }, { ATHENA_INSIGHTS_PRICE_PER_TB: "6" }));

test("analysis routes answer on an empty store and validate filters", () =>
    withServer(async base => {
        for (const page of ["meta", "filters", "overview", "expensive", "slow", "failures"]) {
            assert.equal((await fetch(`${base}/api/${page}?tz=60`)).status, 200, page);
        }
        assert.equal((await fetch(base + "/api/overview?from=bad")).status, 400);
        assert.equal((await fetch(base + "/api/query/missing")).status, 404);
    }));
