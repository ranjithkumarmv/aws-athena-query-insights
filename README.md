<div align="center">

# 🔎 athena-query-insights

**See what every Amazon Athena query costs, how long it took, and why it failed, with no infrastructure to deploy.**
It pulls your Athena query history into a local SQLite file and shows it in your browser.

</div>

Athena keeps 45 days of query history and shows it one query at a time. CloudWatch and Cost Explorer stop at the workgroup level. This tool gives you query-level numbers across **all workgroups, regions and accounts**, and keeps history past 45 days by re-running it.

## What you get

- **Overview**: queries, cost, data scanned, failure rate and p50/p95 duration, each compared with the previous period. Cost and query charts over time, plus cost by workgroup and by database.
- **Expensive**: the queries that cost most across all their runs (the same SQL with different literals counts as one query), the most expensive single runs, and a breakdown by data scanned.
- **Slow**: queue vs engine time, where the time goes (queued, planning, engine, writing results), p50/p95 per database, and the queries using the most total time.
- **Failures**: failures over time, errors grouped by pattern (ids, S3 paths and numbers masked), and failure rate by database and by workgroup.
- **Query detail**: full SQL, timing breakdown, the error, every stored run of the same query, and a link to the Athena console.
- Filters for time range, account, region, workgroup, database and state. They're kept in the URL, so views can be bookmarked and shared. Every chart has a table view.

> Status: milestones 1–3 of [the plan](PLAN.md). Next: Docker image, demo mode, CI and npm publish.

## Run it

Needs Node.js 22.13 or newer.

```bash
npx athena-query-insights            # web UI at http://localhost:4567
```

```bash
npx athena-query-insights fetch --profile prod --region ca-central-1 --days 30
```

From a checkout:

```bash
git clone https://github.com/ranjithkumarmv/aws-athena-query-insights.git
cd aws-athena-query-insights
npm install
node bin/cli.js serve
```

AWS credentials come from the standard AWS chain: env vars, `~/.aws` profiles, SSO, or an EC2/ECS/Lambda role. They are never stored or typed into the UI.

## Configure: UI, env, config file or CLI

Every setting can come from any of these places. When the same setting is in more than one, the later place wins:

**defaults → `athena-insights.config.json` → saved in the UI → environment variables → CLI flags**

A setting that comes from an env var or a CLI flag is shown **read-only** in the UI with a badge. That way a Docker or CI deployment can pin values while everything else stays editable in the UI. Settings saved in the UI live in the SQLite file next to the data. `athena-query-insights config` prints each setting's value and where it came from.

| Setting | CLI | Env | Default |
|---|---|---|---|
| AWS profile | `--profile` | `ATHENA_INSIGHTS_PROFILE` (falls back to `AWS_PROFILE`) | default chain |
| Regions | `--region` (repeat or comma-separate) | `ATHENA_INSIGHTS_REGIONS` (falls back to `AWS_REGION`) | profile's region |
| Other accounts (assume role) | `--role-arn` | `ATHENA_INSIGHTS_ROLE_ARNS` | none |
| Workgroups | `--workgroup` | `ATHENA_INSIGHTS_WORKGROUPS` | all |
| Query states | `--state` | `ATHENA_INSIGHTS_STATES` | all |
| Days of history (1–45) | `--days` | `ATHENA_INSIGHTS_DAYS` | 7 |
| Store SQL text | `--no-query-text` | `ATHENA_INSIGHTS_STORE_QUERY_TEXT` | true |
| Price per TB (USD) | `--price-per-tb` | `ATHENA_INSIGHTS_PRICE_PER_TB` | 5 |
| SQLite file | `--db` | `ATHENA_INSIGHTS_DB` | `./athena-insights.db` |
| Bind host / port | `--host` / `--port` | `ATHENA_INSIGHTS_HOST` / `_PORT` | `127.0.0.1` / `4567` |
| Config file | `--config` | `ATHENA_INSIGHTS_CONFIG` | `./athena-insights.config.json` if present |

See [athena-insights.config.example.json](athena-insights.config.example.json) for a config file.

## How the fetch works

1. For each account (the profile's own account, or each `--role-arn`) and region, it lists **every workgroup**.
2. For each workgroup, it pages through `ListQueryExecutions` (newest first, 50 ids per page).
3. It calls `BatchGetQueryExecution` only for ids it hasn't stored yet or that were still running. It stops after a whole page is older than the cutoff.
4. Rows are upserted into SQLite by query id.

Re-running costs little: finished queries are never fetched again. Run it daily (cron, launchd, a scheduled container) and the history builds up beyond Athena's 45 days. The listing and lookup calls are free, so the fetch adds nothing to your Athena bill.

Required IAM permissions (read-only): [examples/iam-policy.json](examples/iam-policy.json). For other accounts, create a role with that policy and pass its ARN.

## Cost model

`cost = billable bytes / 1 TiB × price per TB`, where billable bytes follow Athena's on-demand billing:

- rounded up to the next MB, with a **10 MB minimum per query**
- **failed** queries, **reused results**, and DDL that scans nothing are free
- cancelled queries are charged for what they scanned

Workgroups on capacity reservations are billed per DPU-hour. Their queries are shown at the on-demand equivalent.

## Security

- The server binds to `127.0.0.1` by default and has **no authentication**. Bind to another address only on a trusted network.
- Writes must be same-origin JSON requests, which blocks drive-by CSRF from other sites.
- `--no-query-text` stores a hash of each query instead of its SQL, if query text is sensitive.

## Development

```bash
npm test     # node:test, uses a fake Athena API, no AWS needed
```

## License

MIT
