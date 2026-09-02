---
name: integration-debugging
description: Guide for debugging integration sync issues. Covers finding the integration, retrieving sync history and API logs, reading S3 request/response payloads, and cross-referencing provider code.
---

# Integration Debugging Guide

Use this skill when investigating integration sync issues, data import failures, or questions about integration data. Always invoke /compadre:query-database alongside this skill for general database querying conventions.

## 1. Identify the integration

Given a company (name or ID) and an integration provider, find the integration record:

```sql
SELECT i.id, i.provider, i.display_name, i.data_type, i.integration_type,
       i.last_sync_time, i.needs_reauth
FROM integrations i
JOIN companies c ON i.company_id = c.id
WHERE c.name ILIKE '%<company>%'
  AND i.provider = '<PROVIDER>'
ORDER BY i.last_sync_time DESC;
```

If multiple integrations match (same company + provider), use `display_name` to disambiguate — **ask the user** if ambiguous.

Key columns:

- `provider` — enum value like `RIPPLING`, `BAMBOO_HR`, `GUSTO`, `WORKDAY`, etc.
- `display_name` — optional human-readable name set by the customer
- `data_type` — `PAYROLL`, `PERFORMANCE`, `EQUITY`, or `BENCHMARK`
- `integration_type` — `FINCH` (aggregator) or `DIRECT` (provider-specific)
- `needs_reauth` — whether the integration's credentials are stale

## 2. Find the latest data sync

Every integration sync creates a record in `data_imports`:

```sql
SELECT di.id, di.status, di.type, di.created_at, di.metrics, di.error
FROM data_imports di
WHERE di.integration_id = '<integration-id>'
  AND di.type = 'SYNC'
ORDER BY di.created_at DESC
LIMIT 5;
```

- `status`: `PENDING`, `PROCESSING`, `COMPLETED`, `CANCELLED`, `FAILED`
- `metrics` (JSON) — sync statistics (row counts, timings)
- `error` (JSON, nullable) — error details if the sync failed

## 3. Retrieve API logs for that sync

Each data import has associated API call logs in `data_import_api_logs`:

```sql
SELECT id, url, s3_file_url, created_at
FROM data_import_api_logs
WHERE data_import_id = '<data-import-id>'
ORDER BY created_at;
```

Each row represents one HTTP request made to the integration provider during the sync. The `s3_file_url` column stores the path to a JSON file containing the full request and response payload.

## 4. Read the S3 JSON files

The `s3_file_url` value is a relative path (not a full S3 URI). The file lives in one of two buckets depending on the customer's region:

- **US:** `comprehensive-prod-media`
- **EU:** `comprehensive-eu-prod-media`

Use the `s3.get_object` tool to fetch the file. The `key` is the `s3_file_url` value. Try the US bucket first, then fall back to the EU bucket if the file is not found.

The JSON file contains the raw request and response for that API call. Inspect:

- What data the provider returned
- Whether the response was an error
- What request parameters were sent

## 5. Cross-reference with provider code

Read the relevant client, data fetcher, and sync code in the comp repo to understand how the data flows. All paths are relative to `REPO_PATH`.

### API clients (`app/lib/api/cm/client/`)

Each provider has its own client that handles authentication and HTTP calls:

| File               | Provider                                          |
| ------------------ | ------------------------------------------------- |
| `rippling.ts`      | Rippling                                          |
| `adp.ts`           | ADP Workforce Now                                 |
| `finch.ts`         | Finch aggregator (BambooHR, Gusto, Workday, etc.) |
| `carta.ts`         | Carta                                             |
| `fifteenfive.ts`   | 15Five                                            |
| `cultureamp.ts`    | Culture Amp                                       |
| `salarycom.ts`     | Salary.com                                        |
| `extendedAxios.ts` | Shared Axios wrapper used by all clients          |

### Data fetchers (`app/lib/api/cm/services/data-import/sync/data-fetchers/`)

Fetchers orchestrate which API calls to make and in what order:

- **Factory:** `index.ts` — `buildDataFetcher()` dispatches by `IntegrationProvider` and `IntegrationType`
- **Direct providers:** `rippling/`, `adp.ts`, `fifteenFive.ts`, `cultureAmp.ts`, `carta.ts`
- **Finch-based providers** (BambooHR, Gusto, Workday, etc.): `finch/`

### Sync orchestration (`app/lib/api/cm/services/data-import/sync/`)

- **Entry point:** `index.ts` — `runDataSync()` creates the `DataImport` record and calls the appropriate ingest function
- **Payroll:** `payroll/index.ts`
- **Performance:** `performance-sync.ts`
- **Equity:** `equity-sync.ts`

### How to read the code

The three layers form a pipeline:

1. **Client** — makes the raw HTTP calls to the provider API
2. **Fetcher** — decides which client methods to call and transforms responses
3. **Sync** — processes fetched data into Comprehensive's data model

Read all three for the specific provider and data type to understand the full pipeline.

## Debugging workflow

1. Get **company + provider** (+ display name if ambiguous) from the user
2. Query `integrations` to find the integration record
3. Query `data_imports` for the latest sync(s) on that integration
4. Query `data_import_api_logs` for the API call log entries
5. Fetch S3 JSON files to inspect raw request/response payloads
6. Read the provider's **client**, **data fetcher**, and **sync code** for the relevant data type
7. Correlate the API responses, code logic, and import status/errors to answer the question
