# athena-query-insights — plan

A local, zero-infrastructure tool that pulls your Amazon Athena query history,
stores it in SQLite, and shows query-level cost / performance / failure analysis
in a web page. Open source, `npx`-runnable, in the same style as
`s3-multipartdownload`.

```bash
npx athena-query-insights --profile prod --region ca-central-1 --days 30
# → fetches history into ./athena-insights.db, opens http://localhost:4567
```

---

## 1. What the existing zip does today

```
EventBridge (hourly) → Lambda index.js
  → for each account in config/athena-accounts.json: assume an observability role
  → ListQueryExecutions + BatchGetQueryExecution (last 65 min)
  → normalize (utils.js) → JSONL → S3 raw/athena/queries/YYYY-MM-DD/HH-mm.jsonl
  → Athena MERGE raw table → Iceberg table aws_events_athena_iceberg (dedupe by id)
  → Grafana (Athena datasource) → 4 dashboards: Cost, Health, On-Call, Database-specific
```

Moving parts to run it: Lambda, EventBridge, IAM roles in each account, S3 bucket,
Glue raw table DDL, Iceberg table, Athena (paying to query your Athena metrics),
Grafana + Athena plugin. That's the complexity to remove.

### Issues found while reading it

| # | Issue | Where |
|---|---|---|
| 1 | **Only the `primary` workgroup is collected.** `ListQueryExecutions` without `WorkGroup` returns primary only; all other workgroups are silently missed. Need `ListWorkGroups` → loop. | `athena/athena.js` |
| 2 | `@aws-sdk/client-athena` not in `package.json` (works only if the Lambda runtime bundles it). | `package.json` |
| 3 | `glue.js` imports `startMergeIcebergTableQuery` from `athena.js`, which doesn't export it → crash. `config/glue-accounts.json` missing. | `athena/glue.js` |
| 4 | MERGE re-reads the **entire** raw table every hour → its own Athena cost grows forever. | `athena-iceberg-merge.js` |
| 5 | Cost = bytes × $5/TB. Ignores the **10 MB minimum per query** and charges FAILED/DDL rows. | Grafana cost panels |
| 6 | Hard-coded account IDs, bucket, region, role name, result location. | several |
| 7 | Unused deps (cloudtrail, cloudwatch, cost-explorer, eventbridge, sqs, zod) and imports. | `package.json`, `athena.js` |

What's worth keeping: the normalized record shape (`utils.js`) and the dashboard
panel *ideas* (they're a good spec for what people want to see).

---

## 2. Does something like this already exist?

| Option | Query-level? | Gap |
|---|---|---|
| Athena console → Recent queries | Yes, per query | 45-day limit, no aggregation, per workgroup, no cost roll-up |
| CloudWatch Athena metrics | No — per workgroup only | No database / query text / top-N; must be enabled per workgroup |
| Cost Explorer / CUR | No — account/workgroup/tag | No per-query or per-database cost |
| AWS blog "Auditing, inspecting and visualizing Athena usage and cost" | Yes | Reference architecture: CloudTrail + Lambda + Glue + QuickSight to deploy. Not a tool |
| Grafana Athena plugin | Depends on your data | You still build the pipeline (what this zip is) |
| `mcp-aws-cost` (MCP server) | Partly | Needs PostgreSQL, no UI, cost-spike focused, tiny adoption |

**Conclusion:** no simple, run-locally tool gives you "top expensive / slow / failing
queries by database & workgroup, across all workgroups and accounts" without
deploying infrastructure. The gap is real → worth building and open-sourcing.

---

## 3. Simplified design

```
CLI (Node 22+)                          Browser (Vue 3 + Chart.js from CDN, no build)
 ├─ fetch:  ListWorkGroups                ├─ Filters: account, workgroup, database, date range, state
 │          → ListQueryExecutions (per WG) ├─ KPI tiles: queries, cost, scanned, fail %, p95 duration
 │          → BatchGetQueryExecution (50)  ├─ Charts: cost/day, queries/hour, queue vs engine time,
 │          → upsert into SQLite           │          cost by workgroup / database, scan-size buckets
 ├─ serve:  tiny HTTP server               ├─ Tables: top cost, top slow, most repeated, failures + reason
 │          /api/* JSON (SQL over SQLite)  └─ Live "loading" bar during fetch (SSE progress)
 │          /api/progress (SSE)
 └─ SQLite file: athena-insights.db (single table + indexes + fetch_state)
```

### Key choices
- **Node.js**: existing code is Node; same SDK; `npx` like your npm package.
- **SQLite via built-in `node:sqlite`** (Node 22.13+) → zero native deps. Upsert on
  `query_execution_id` replaces the whole S3 + raw table + Iceberg MERGE chain.
- **Frontend**: one `index.html` + Vue 3 + Chart.js from CDN. No bundler.
- **Only dependency**: `@aws-sdk/client-athena` (+ `client-sts` for multi-account).
- **Incremental**: `fetch_state` stores newest timestamp per account/region/workgroup;
  re-runs only fetch new queries. History beyond 45 days accumulates locally.

### User-driven fetch ("pull history based on user requirements")
CLI flags and the same form in the web UI:
- `--profile`, `--region` (multiple), `--role-arn` (multiple accounts, optional)
- `--workgroups` (default: all), `--days` (1–45), `--states`
- `--no-query-text` (privacy: store only a hash of the SQL)
- `--price-per-tb` (default 5, for regional pricing)

### Data captured per query
id, account, region, workgroup, database, catalog, statement type, state,
**state change reason / error category / error message** (missing today — key
for on-call), submitted/completed time, total / engine / queue / planning /
processing ms, bytes scanned, result reuse flag, engine version, query text,
query hash (normalized SQL, literals stripped → groups "same query, different params").

### Cost formula (fixed)
`billable = state in (SUCCEEDED, CANCELLED) and statement_type = 'DML' ? max(bytes, 10 MB) : 0`
`cost = billable / 1 TB × price_per_tb`
(capacity-reservation workgroups flagged, not priced by scan.)

### Pages (from the 4 Grafana dashboards, merged)
1. **Overview** — KPIs, cost/day, queries/hour, cost by workgroup & database
2. **Expensive** — top N by cost, repeated queries (by hash) × cost, scan-size buckets
3. **Slow** — top N by duration, queue vs engine trend, p50/p95 per database
4. **Failures** — failures over time, fail % by database, grouped error messages
5. **Query detail** — click any row: full SQL, timeline breakdown, all runs of that hash

---

## 4. Repo layout (open source)

```
athena-query-insights/
  bin/cli.js              # arg parsing, fetch / serve / export subcommands
  src/fetch.js            # workgroups → list → batch get, retries, progress events
  src/normalize.js        # from utils.js + error fields + query hash
  src/db.js               # schema, upsert, fetch_state
  src/analysis.js         # all analysis SQL (one place)
  src/server.js           # node:http, /api/*, SSE, static files
  web/index.html, app.js, style.css
  test/                   # normalize + cost + SQL tests on fixture JSON (no AWS needed)
  examples/iam-policy.json  # read-only: athena:ListWorkGroups/ListQueryExecutions/BatchGetQueryExecution
  README.md, LICENSE (MIT), .github/workflows/ci.yml + release.yml (npm publish)
```

`--demo` flag loads synthetic data so people can try the UI without AWS.

---

## 5. Milestones

1. **Fetcher + SQLite** — CLI pulls N days from all workgroups into SQLite; tests on fixtures. *Validate against your real account.*
2. **Server + API** — analysis SQL endpoints, SSE progress.
3. **Web UI** — 5 pages, filters, loading bar, dark/light.
4. **Polish for OSS** — README with screenshots, demo mode, IAM policy, CI, npm publish.
5. *(Later)* multi-account via role list, CSV export, optional scheduled run (cron/launchd), `GetQueryRuntimeStatistics` for per-stage detail on a selected query.

---

## Open questions
1. Name: `athena-query-insights`? (alternatives: `athena-lens`, `athena-query-stats`)
2. Node + npx (recommended), or Rust single binary like `s3-multipartdownload-rs`?
3. Multi-account (AssumeRole) in v1, or single profile first?
4. Keep the old Lambda code in the repo, or start the new repo clean?
