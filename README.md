

**sage - The intelligence layer for data engineering**

---

## Why a specialized harness?

General AI coding agents can edit SQL files. They cannot *understand* your data stack.
altimate gives any LLM a deterministic data engineering intelligence layer —
no hallucinated SQL advice, no guessing at schema, no missed PII.


| Capability                    | General coding agents | altimate                                               |
| ----------------------------- | --------------------- | ------------------------------------------------------ |
| SQL anti-pattern detection    | None                  | 19 rules, confidence-scored                            |
| Column-level lineage          | None                  | Automatic from SQL, any dialect                        |
| Schema-aware autocomplete     | None                  | Live-indexed warehouse metadata                        |
| Cross-dialect SQL translation | None                  | Snowflake ↔ BigQuery ↔ Databricks ↔ Redshift           |
| Cross-dialect data validation | None                  | Row-by-row diff across 12 warehouses, 5 algorithms     |
| FinOps & cost analysis        | None                  | Credits, expensive queries, right-sizing               |
| PII detection                 | None                  | 30+ regex patterns, 15 categories                      |
| dbt integration               | Basic file editing    | Manifest parsing, test gen, model scaffolding, lineage |
| Data visualization            | None                  | Auto-generated charts from SQL results                 |
| Observability                 | None                  | Local-first tracing of AI sessions and tool calls      |

**What the harness provides:**

- **SQL Intelligence Engine** — deterministic SQL parsing and analysis (not LLM pattern matching). 19 rules, 100% F1, 0 false positives. Built for data engineers who've been burned by hallucinated SQL advice.
- **Column-Level Lineage** — automatic extraction from SQL across dialects. 100% edge-match on 500 benchmark queries.
- **Live Warehouse Intelligence** — indexed schemas, query history, and cost data from your actual warehouse. Not guesses.
- **dbt Native** — manifest parsing, test generation, model scaffolding, medallion patterns, impact analysis
- **FinOps** — credit consumption, expensive query detection, warehouse right-sizing, idle resource cleanup
- **PII Detection** — 15 categories, 30+ regex patterns, enforced pre-execution

## Key Features

All features are deterministic — they parse, trace, and measure. Not LLM pattern matching.

### SQL Anti-Pattern Detection

19 rules with confidence scoring — catches SELECT *, cartesian joins, non-sargable predicates, correlated subqueries, and more. **100% accuracy** on 1,077 benchmark queries.

### Column-Level Lineage

Automatic lineage extraction from SQL. Trace any column back through joins, CTEs, and subqueries to its source. Works standalone or with dbt manifests for project-wide lineage. **100% edge match** on 500 benchmark queries.

### FinOps & Cost Analysis

Credit analysis, expensive query detection, warehouse right-sizing, unused resource cleanup, and RBAC auditing.

### Cross-Dialect Translation

Transpile SQL between Snowflake, BigQuery, Databricks, Redshift, PostgreSQL, MySQL, SQL Server, and DuckDB.

### PII Detection & Safety

Automatic column scanning for PII across 15 categories with 30+ regex patterns. Safety checks and policy enforcement before query execution.

### dbt Native

Manifest parsing, test generation, model scaffolding, incremental model detection, and lineage-aware refactoring. 12 purpose-built skills including medallion patterns, yaml config generation, and dbt docs.

### Data Visualization

Interactive charts and dashboards from SQL results. The data-viz skill generates publication-ready visualizations with automatic chart type selection based on your data.

### Local-First Tracing

Built-in observability for AI interactions — trace tool calls, token usage, and session activity locally. No external services required. View session recordings with `altimate trace`. Features include loop detection, post-session summary, and shareable HTML exports.

### AI Teammate Training

Teach your AI teammate project-specific patterns, naming conventions, and best practices. The training system learns from examples and applies rules automatically across sessions.

### Cross-Dialect Data Parity

Compare tables or query results row-by-row across 12 warehouses with the `/data-parity` skill or `data_diff` tool. Five algorithms — `auto`, `joindiff`, `hashdiff` (any-scale, no data egress), `profile` (column-stats only), and `cascade`. Date / numeric / categorical partitioning so 100M+ row tables diff in independent batches. Auto-discovers comparable columns and excludes audit/timestamp columns by name and catalog default.

### Automated dbt Unit Tests

Generate dbt 1.8+ unit tests from your terminal with `/dbt-unit-tests` or the `dbt_unit_test_gen` tool. Detects testable SQL constructs (CASE/WHEN, JOINs, NULLs, window functions, division, incremental models) and assembles complete YAML with type-correct mock data across 7 dialects.

### GitLab MR Review

Review merge requests directly from your terminal with `altimate gitlab review <MR_URL>`. Self-hosted GitLab instances and nested group paths supported. Comment deduplication updates an existing review instead of posting duplicates. Companion to the existing GitHub PR review flow.

## Agent Modes

Each mode has scoped permissions, tool access, and SQL write-access control.


| Mode        | Role                                                                     | Access                                                                                                  |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Builder** | Create dbt models, SQL pipelines, and data transformations               | Full read/write (write SQL prompts for approval; `DROP DATABASE`/`DROP SCHEMA`/`TRUNCATE` hard-blocked) |
| **Analyst** | Explore data, run SELECT queries, FinOps analysis, and generate insights | Read-only enforced (SELECT only, no file writes)                                                        |
| **Plan**    | Outline an approach before acting                                        | Minimal (read files only, no SQL or bash)                                                               |

## Skills

altimate ships with 19 built-in skills — type `/` in the TUI to browse and get autocomplete. No memorization required.

`/sql-review` · `/sql-translate` · `/data-parity` · `/pii-audit` · `/cost-report` · `/lineage-diff` · `/query-optimize` · `/data-viz` · `/dbt-develop` · `/dbt-test` · `/dbt-unit-tests` · `/dbt-docs` · `/dbt-analyze` · `/dbt-troubleshoot` · `/schema-migration` · `/teach` · `/train` · `/training-status` · `/altimate-setup`

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

sage is a fork of [altimate-code](https://github.com/AltimateAI/altimate-code)