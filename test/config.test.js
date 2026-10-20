import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { coerce, resolveConfig } from "../src/config.js";

function tmpConfig(obj) {
    const dir = mkdtempSync(join(tmpdir(), "aqi-"));
    const path = join(dir, "c.json");
    writeFileSync(path, JSON.stringify(obj));
    return path;
}

test("layers: default < file < ui < env < cli, env/cli lock", () => {
    const configFile = tmpConfig({ days: 10, workgroups: ["a"], pricePerTb: 6 });
    const c = resolveConfig({
        configFile,
        ui: { days: 20, workgroups: ["b"] },
        env: { ATHENA_INSIGHTS_WORKGROUPS: "c, d", AWS_REGION: "eu-west-1" },
        flags: { days: "30" },
    });
    assert.equal(c.values.days, 30);
    assert.equal(c.sources.days, "cli");
    assert.deepEqual(c.values.workgroups, ["c", "d"]);
    assert.equal(c.sources.workgroups, "env");
    assert.equal(c.values.pricePerTb, 6);
    assert.equal(c.sources.pricePerTb, "file");
    assert.deepEqual(c.values.regions, ["eu-west-1"]);
    assert.equal(c.sources.regions, "aws-env");
    assert.deepEqual(c.locked.sort(), ["days", "workgroups"]);
    assert.equal(c.values.port, 4567);
});

test("ui null falls back to lower layers", () => {
    const c = resolveConfig({ configFile: null, ui: { profile: null }, env: { AWS_PROFILE: "dev" }, flags: {} });
    assert.equal(c.values.profile, "dev");
});

test("validation", () => {
    assert.throws(() => coerce("days", "90"), /1-45/);
    assert.throws(() => coerce("regions", "us-east-1,nowhere"), /invalid region/);
    assert.throws(() => coerce("roleArns", "arn:aws:iam::123:role/x"), /role ARN/);
    assert.deepEqual(coerce("states", "failed, succeeded"), ["FAILED", "SUCCEEDED"]);
    assert.equal(coerce("storeQueryText", "false"), false);
    assert.deepEqual(coerce("regions", ["us-east-1", "us-east-1,ca-central-1"]), ["us-east-1", "ca-central-1"]);
});
