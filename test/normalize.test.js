import assert from "node:assert/strict";
import { test } from "node:test";
import { billableBytes, normalizeQueryExecution, normalizeSql, queryHash } from "../src/normalize.js";

const MB = 1024 * 1024;

test("normalizeSql strips literals, comments and IN lists", () => {
    const a = normalizeSql(`SELECT * FROM t2 -- note\nWHERE id IN (1, 2, 3) AND name = 'it''s' /* x */ AND d > 10.5`);
    assert.equal(a, "select * from t2 where id in (?) and name = ? and d > ?");
    assert.equal(queryHash("select 1 from t where x='a'"), queryHash("SELECT  2 FROM t WHERE x = 'bbb'"));
    assert.notEqual(queryHash("select a from t"), queryHash("select b from t"));
    assert.equal(queryHash(""), null);
});

test("billableBytes: 10 MB minimum, MB rounding, free cases", () => {
    const dml = { statement_type: "DML", state: "SUCCEEDED", result_reused: 0 };
    assert.equal(billableBytes({ ...dml, bytes_scanned: 0 }), 10 * MB);
    assert.equal(billableBytes({ ...dml, bytes_scanned: 50 * MB + 1 }), 51 * MB);
    assert.equal(billableBytes({ ...dml, state: "CANCELLED", bytes_scanned: 20 * MB }), 20 * MB);
    assert.equal(billableBytes({ ...dml, state: "FAILED", bytes_scanned: 20 * MB }), 0);
    assert.equal(billableBytes({ ...dml, result_reused: 1, bytes_scanned: 20 * MB }), 0);
    assert.equal(billableBytes({ statement_type: "DDL", state: "SUCCEEDED", bytes_scanned: 0 }), 0);
    // CTAS reports as DDL but scans data
    assert.equal(billableBytes({ statement_type: "DDL", state: "SUCCEEDED", bytes_scanned: 30 * MB }), 30 * MB);
});

test("normalizeQueryExecution flattens a BatchGetQueryExecution item", () => {
    const row = normalizeQueryExecution(
        {
            QueryExecutionId: "q1",
            Query: "SELECT * FROM sales WHERE day = '2026-10-01'",
            StatementType: "DML",
            WorkGroup: "analytics",
            QueryExecutionContext: { Database: "lake", Catalog: "AwsDataCatalog" },
            Status: {
                State: "FAILED",
                SubmissionDateTime: new Date("2026-10-20T10:00:00Z"),
                CompletionDateTime: new Date("2026-10-20T10:00:05Z"),
                StateChangeReason: "TABLE_NOT_FOUND",
                AthenaError: { ErrorCategory: 2, ErrorType: 1301, Retryable: false, ErrorMessage: "Table not found" },
            },
            Statistics: { TotalExecutionTimeInMillis: 5000, DataScannedInBytes: 0, QueryQueueTimeInMillis: 100 },
            EngineVersion: { EffectiveEngineVersion: "Athena engine version 3" },
        },
        { accountId: "111122223333", region: "us-east-1", storeQueryText: false },
    );
    assert.equal(row.workgroup, "analytics");
    assert.equal(row.database, "lake");
    assert.equal(row.error_category, "USER");
    assert.equal(row.error_message, "Table not found");
    assert.equal(row.retryable, 0);
    assert.equal(row.submitted_at, "2026-10-20T10:00:00.000Z");
    assert.equal(row.billable_bytes, 0);
    assert.equal(row.query_text, null, "storeQueryText=false drops the SQL");
    assert.match(row.query_hash, /^[0-9a-f]{16}$/);
});
