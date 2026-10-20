import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Settings are resolved in layers; a later layer wins:
 *   defaults → config file → saved from the web UI → environment → CLI flags
 * A key set by env or CLI is "locked": the UI shows it read-only.
 * AWS credentials are never part of this config — the AWS SDK default chain
 * (env vars, ~/.aws, SSO, instance/task roles) provides them.
 */

export const STATES = ["SUCCEEDED", "FAILED", "CANCELLED", "RUNNING", "QUEUED"];
export const MAX_DAYS = 45; // Athena keeps query history for 45 days

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const ROLE_ARN_RE = /^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@\/-]+$/;
const WORKGROUP_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const PROFILE_RE = /^[\w.@+-]{1,128}$/;

// key → { type, env, flag, ui, check }
export const FIELDS = {
    profile:        { type: "string", env: "ATHENA_INSIGHTS_PROFILE", flag: "profile", ui: true, check: v => PROFILE_RE.test(v) || "invalid profile name" },
    regions:        { type: "list", env: "ATHENA_INSIGHTS_REGIONS", flag: "region", ui: true, check: v => v.every(r => REGION_RE.test(r)) || "invalid region" },
    roleArns:       { type: "list", env: "ATHENA_INSIGHTS_ROLE_ARNS", flag: "role-arn", ui: true, check: v => v.every(r => ROLE_ARN_RE.test(r)) || "invalid role ARN" },
    workgroups:     { type: "list", env: "ATHENA_INSIGHTS_WORKGROUPS", flag: "workgroup", ui: true, check: v => v.every(w => WORKGROUP_RE.test(w)) || "invalid workgroup name" },
    states:         { type: "list", env: "ATHENA_INSIGHTS_STATES", flag: "state", ui: true, check: v => v.every(s => STATES.includes(s)) || `states must be from ${STATES.join(", ")}` },
    days:           { type: "int", env: "ATHENA_INSIGHTS_DAYS", flag: "days", ui: true, check: v => (v >= 1 && v <= MAX_DAYS) || `days must be 1-${MAX_DAYS}` },
    storeQueryText: { type: "bool", env: "ATHENA_INSIGHTS_STORE_QUERY_TEXT", flag: "query-text", ui: true },
    pricePerTb:     { type: "float", env: "ATHENA_INSIGHTS_PRICE_PER_TB", flag: "price-per-tb", ui: true, check: v => v >= 0 || "price must be >= 0" },
    dbPath:         { type: "string", env: "ATHENA_INSIGHTS_DB", flag: "db", ui: false },
    host:           { type: "string", env: "ATHENA_INSIGHTS_HOST", flag: "host", ui: false },
    port:           { type: "int", env: "ATHENA_INSIGHTS_PORT", flag: "port", ui: false, check: v => (v > 0 && v < 65536) || "invalid port" },
};

export const DEFAULTS = {
    profile: null,
    regions: [],
    roleArns: [],
    workgroups: [],
    states: [],
    days: 7,
    storeQueryText: true,
    pricePerTb: 5,
    dbPath: "athena-insights.db",
    host: "127.0.0.1",
    port: 4567,
};

export const UI_KEYS = Object.keys(FIELDS).filter(k => FIELDS[k].ui);

/** Coerce a raw value (string from env/CLI, or JSON value) to the field's type. Throws on bad input. */
export function coerce(key, raw) {
    const field = FIELDS[key];
    if (!field) throw new Error(`unknown setting "${key}"`);
    if (raw === null || raw === undefined || raw === "") {
        return field.type === "list" ? [] : null;
    }
    let value;
    switch (field.type) {
        case "string":
            value = String(raw).trim();
            break;
        case "list":
            value = (Array.isArray(raw) ? raw : String(raw).split(","))
                .flatMap(v => String(v).split(","))
                .map(v => v.trim())
                .filter(Boolean);
            value = [...new Set(key === "states" ? value.map(v => v.toUpperCase()) : value)];
            break;
        case "int":
            value = typeof raw === "number" ? raw : Number(String(raw).trim());
            if (!Number.isInteger(value)) throw new Error(`${key}: expected an integer, got "${raw}"`);
            break;
        case "float":
            value = typeof raw === "number" ? raw : Number(String(raw).trim());
            if (!Number.isFinite(value)) throw new Error(`${key}: expected a number, got "${raw}"`);
            break;
        case "bool":
            if (typeof raw === "boolean") value = raw;
            else if (/^(1|true|yes|on)$/i.test(String(raw).trim())) value = true;
            else if (/^(0|false|no|off)$/i.test(String(raw).trim())) value = false;
            else throw new Error(`${key}: expected true/false, got "${raw}"`);
            break;
    }
    if (field.check && !(field.type === "list" && value.length === 0)) {
        const ok = field.check(value);
        if (ok !== true) throw new Error(`${key}: ${ok}`);
    }
    return value;
}

/** Validate and coerce a whole object of settings; unknown keys are rejected. */
export function coerceAll(obj, { only } = {}) {
    const out = {};
    for (const [key, raw] of Object.entries(obj ?? {})) {
        if (only && !only.includes(key)) throw new Error(`setting "${key}" cannot be changed here`);
        out[key] = coerce(key, raw);
    }
    return out;
}

export function readConfigFile(path) {
    const text = readFileSync(path, "utf8");
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new Error(`config file ${path}: ${e.message}`);
    }
    try {
        return coerceAll(json);
    } catch (e) {
        throw new Error(`config file ${path}: ${e.message}`);
    }
}

export function fromEnv(env) {
    const out = {};
    for (const [key, field] of Object.entries(FIELDS)) {
        const raw = env[field.env];
        if (raw !== undefined && raw !== "") out[key] = coerce(key, raw);
    }
    return out;
}

/** Values parsed by node:util parseArgs (see bin/cli.js). */
export function fromFlags(flags) {
    const out = {};
    for (const [key, field] of Object.entries(FIELDS)) {
        const raw = flags[field.flag];
        if (raw !== undefined) out[key] = coerce(key, raw);
    }
    return out;
}

/** Defaults that come from the usual AWS env vars; they don't lock the UI. */
function awsEnvDefaults(env) {
    const out = {};
    if (env.AWS_PROFILE) out.profile = env.AWS_PROFILE;
    const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
    if (region) out.regions = [region];
    return out;
}

export function findConfigFile({ flags = {}, env = process.env, cwd = process.cwd() } = {}) {
    const explicit = flags.config ?? env.ATHENA_INSIGHTS_CONFIG;
    if (explicit) {
        const path = resolve(cwd, explicit);
        if (!existsSync(path)) throw new Error(`config file not found: ${path}`);
        return path;
    }
    const fallback = resolve(cwd, "athena-insights.config.json");
    return existsSync(fallback) ? fallback : null;
}

/**
 * Merge all layers. `ui` is the object saved from the web page (stored in SQLite).
 * Returns { values, sources, locked, configFile }.
 */
export function resolveConfig({ flags = {}, env = process.env, ui = {}, configFile } = {}) {
    if (configFile === undefined) configFile = findConfigFile({ flags, env });
    const layers = [
        ["default", DEFAULTS],
        ["aws-env", awsEnvDefaults(env)],
        ["file", configFile ? readConfigFile(configFile) : {}],
        ["ui", coerceAll(pick(ui, UI_KEYS))],
        ["env", fromEnv(env)],
        ["cli", fromFlags(flags)],
    ];
    const values = {};
    const sources = {};
    for (const [source, layer] of layers) {
        for (const [key, value] of Object.entries(layer)) {
            // null means "not set" everywhere except the defaults layer
            if (value === undefined || (value === null && source !== "default")) continue;
            values[key] = value;
            sources[key] = source;
        }
    }
    const locked = Object.keys(sources).filter(k => sources[k] === "env" || sources[k] === "cli");
    return { values, sources, locked, configFile };
}

function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
}
