import { createHash } from "node:crypto";

const MB = 1024 * 1024;
const MIN_BILLABLE_BYTES = 10 * MB;
export const TB = 1024 ** 4;

const ERROR_CATEGORIES = { 1: "SYSTEM", 2: "USER", 3: "OTHER" };

function isoOrNull(value) {
    if (value == null) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function numOrNull(value) {
    if (value == null) return null;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * SQL with literals, comments and whitespace removed, so runs of the same
 * query with different parameters share one hash.
 */
export function normalizeSql(sql) {
    if (!sql) return "";
    return sql
        .replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, m => (m[0] === "'" ? "?" : " "))
        .replace(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, "?")
        .replace(/\s*(<>|!=|>=|<=|=|<|>)\s*/g, " $1 ")
        .replace(/\s*,\s*/g, ", ")
        .replace(/\s+/g, " ")
        .replace(/\?(?:, \?)+/g, "?")
        .trim()
        .toLowerCase();
}

export function queryHash(sql) {
    const normalized = normalizeSql(sql);
    return normalized ? createHash("sha1").update(normalized).digest("hex").slice(0, 16) : null;
}

/**
 * Bytes Athena bills for one query: rounded up to the MB, 10 MB minimum.
 * Failed queries, reused results and DDL that scans nothing are free.
 * Capacity-reservation workgroups are billed per DPU-hour instead; their rows
 * keep an on-demand equivalent here.
 */
export function billableBytes({ statement_type, state, bytes_scanned, result_reused }) {
    if (state !== "SUCCEEDED" && state !== "CANCELLED") return 0;
    if (result_reused) return 0;
    const bytes = bytes_scanned ?? 0;
    if (statement_type !== "DML" && bytes <= 0) return 0;
    return Math.max(Math.ceil(bytes / MB) * MB, MIN_BILLABLE_BYTES);
}

/** One flat row from a BatchGetQueryExecution item. */
export function normalizeQueryExecution(qe, { accountId, region, storeQueryText = true, now = new Date() }) {
    const status = qe.Status ?? {};
    const error = status.AthenaError ?? {};
    const stats = qe.Statistics ?? {};
    const ctx = qe.QueryExecutionContext ?? {};

    const row = {
        query_execution_id: qe.QueryExecutionId,
        account_id: accountId,
        region,
        workgroup: qe.WorkGroup ?? null,
        catalog: ctx.Catalog ?? null,
        database: ctx.Database ?? null,
        statement_type: qe.StatementType ?? null,
        substatement_type: qe.SubstatementType ?? null,
        state: status.State ?? null,
        state_change_reason: status.StateChangeReason ?? null,
        error_category: ERROR_CATEGORIES[error.ErrorCategory] ?? null,
        error_type: numOrNull(error.ErrorType),
        error_message: error.ErrorMessage ?? null,
        retryable: error.Retryable == null ? null : error.Retryable ? 1 : 0,
        submitted_at: isoOrNull(status.SubmissionDateTime),
        completed_at: isoOrNull(status.CompletionDateTime),
        total_ms: numOrNull(stats.TotalExecutionTimeInMillis),
        engine_ms: numOrNull(stats.EngineExecutionTimeInMillis),
        queue_ms: numOrNull(stats.QueryQueueTimeInMillis),
        planning_ms: numOrNull(stats.QueryPlanningTimeInMillis),
        preprocessing_ms: numOrNull(stats.ServicePreProcessingTimeInMillis),
        processing_ms: numOrNull(stats.ServiceProcessingTimeInMillis),
        bytes_scanned: numOrNull(stats.DataScannedInBytes),
        billable_bytes: 0,
        result_reused: stats.ResultReuseInformation?.ReusedPreviousResult ? 1 : 0,
        dpu_count: numOrNull(stats.DpuCount),
        engine_version: qe.EngineVersion?.EffectiveEngineVersion ?? null,
        output_location: qe.ResultConfiguration?.OutputLocation ?? null,
        query_hash: queryHash(qe.Query),
        query_text: storeQueryText ? qe.Query ?? null : null,
        fetched_at: now.toISOString(),
    };
    row.billable_bytes = billableBytes(row);
    return row;
}

export const COLUMNS = Object.keys(
    normalizeQueryExecution({ QueryExecutionId: "x" }, { accountId: "", region: "" }),
);
