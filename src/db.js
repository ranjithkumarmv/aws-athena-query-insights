import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { COLUMNS } from "./normalize.js";

export const FINAL_STATES = ["SUCCEEDED", "FAILED", "CANCELLED"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queries (
    query_execution_id TEXT PRIMARY KEY,
    account_id         TEXT NOT NULL,
    region             TEXT NOT NULL,
    workgroup          TEXT,
    catalog            TEXT,
    database           TEXT,
    statement_type     TEXT,
    substatement_type  TEXT,
    state              TEXT,
    state_change_reason TEXT,
    error_category     TEXT,
    error_type         INTEGER,
    error_message      TEXT,
    retryable          INTEGER,
    submitted_at       TEXT,
    completed_at       TEXT,
    total_ms           INTEGER,
    engine_ms          INTEGER,
    queue_ms           INTEGER,
    planning_ms        INTEGER,
    preprocessing_ms   INTEGER,
    processing_ms      INTEGER,
    bytes_scanned      INTEGER,
    billable_bytes     INTEGER NOT NULL DEFAULT 0,
    result_reused      INTEGER NOT NULL DEFAULT 0,
    dpu_count          REAL,
    engine_version     TEXT,
    output_location    TEXT,
    query_hash         TEXT,
    query_text         TEXT,
    fetched_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS queries_submitted ON queries (submitted_at);
CREATE INDEX IF NOT EXISTS queries_scope ON queries (account_id, region, workgroup, submitted_at);
CREATE INDEX IF NOT EXISTS queries_database ON queries (database, submitted_at);
CREATE INDEX IF NOT EXISTS queries_hash ON queries (query_hash);
CREATE INDEX IF NOT EXISTS queries_state ON queries (state, submitted_at);

CREATE TABLE IF NOT EXISTS fetch_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT NOT NULL,
    params      TEXT NOT NULL,
    stats       TEXT,
    error       TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export function openDb(path) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    return new Store(db, path);
}

export class Store {
    constructor(db, path) {
        this.db = db;
        this.path = path;
        const cols = COLUMNS.join(", ");
        const params = COLUMNS.map(c => "@" + c).join(", ");
        const updates = COLUMNS.filter(c => c !== "query_execution_id")
            .map(c => `${c} = excluded.${c}`)
            .join(", ");
        this.upsertStmt = db.prepare(
            `INSERT INTO queries (${cols}) VALUES (${params})
             ON CONFLICT (query_execution_id) DO UPDATE SET ${updates}`,
        );
    }

    close() {
        this.db.close();
    }

    /** id → { state, submitted_at } for the ids already stored. */
    existing(ids) {
        const out = new Map();
        if (!ids.length) return out;
        const rows = this.db
            .prepare(`SELECT query_execution_id, state, submitted_at FROM queries
                      WHERE query_execution_id IN (${ids.map(() => "?").join(",")})`)
            .all(...ids);
        for (const r of rows) out.set(r.query_execution_id, { state: r.state, submitted_at: r.submitted_at });
        return out;
    }

    /** Insert or update rows in one transaction. */
    upsert(rows) {
        if (!rows.length) return;
        this.db.exec("BEGIN");
        try {
            for (const row of rows) {
                const bound = {};
                for (const c of COLUMNS) bound[c] = row[c] ?? null;
                this.upsertStmt.run(bound);
            }
            this.db.exec("COMMIT");
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }

    getSettings() {
        const out = {};
        for (const { key, value } of this.db.prepare("SELECT key, value FROM settings").all()) {
            out[key] = JSON.parse(value);
        }
        return out;
    }

    saveSettings(values) {
        const put = this.db.prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        );
        const del = this.db.prepare("DELETE FROM settings WHERE key = ?");
        this.db.exec("BEGIN");
        try {
            for (const [key, value] of Object.entries(values)) {
                if (value === null || value === undefined) del.run(key);
                else put.run(key, JSON.stringify(value));
            }
            this.db.exec("COMMIT");
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }

    startRun(params) {
        const r = this.db
            .prepare("INSERT INTO fetch_runs (started_at, status, params) VALUES (?, 'running', ?)")
            .run(new Date().toISOString(), JSON.stringify(params));
        return Number(r.lastInsertRowid);
    }

    finishRun(id, { status, stats, error }) {
        this.db
            .prepare("UPDATE fetch_runs SET finished_at = ?, status = ?, stats = ?, error = ? WHERE id = ?")
            .run(new Date().toISOString(), status, JSON.stringify(stats ?? null), error ?? null, id);
    }

    /** Runs left 'running' by a process that died. */
    markAbandonedRuns() {
        this.db
            .prepare("UPDATE fetch_runs SET status = 'abandoned', finished_at = ? WHERE status = 'running'")
            .run(new Date().toISOString());
    }

    listRuns(limit = 20) {
        return this.db
            .prepare("SELECT * FROM fetch_runs ORDER BY id DESC LIMIT ?")
            .all(limit)
            .map(r => ({ ...r, params: JSON.parse(r.params), stats: r.stats ? JSON.parse(r.stats) : null }));
    }

    /** What is in the store, per account/region/workgroup. */
    inventory() {
        const totals = this.db
            .prepare(`SELECT COUNT(*) AS queries, MIN(submitted_at) AS first_at, MAX(submitted_at) AS last_at,
                             SUM(billable_bytes) AS billable_bytes, SUM(state = 'FAILED') AS failed
                      FROM queries`)
            .get();
        const scopes = this.db
            .prepare(`SELECT account_id, region, workgroup, COUNT(*) AS queries,
                             MIN(submitted_at) AS first_at, MAX(submitted_at) AS last_at,
                             SUM(billable_bytes) AS billable_bytes, SUM(state = 'FAILED') AS failed
                      FROM queries GROUP BY account_id, region, workgroup
                      ORDER BY queries DESC`)
            .all();
        return { totals: { ...totals }, scopes: scopes.map(s => ({ ...s })) };
    }
}
