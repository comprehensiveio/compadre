---
name: query-database
description: Guide for querying the Comprehensive production database via the Postgres MCP. Covers snapshot filtering, naming conventions, and common queries.
---

# Database Exploration Guide

Use this skill when querying the Comprehensive database via the Postgres MCP. The connection is **read-only**.

## Database Naming Conventions

### Tables
- Plural snake_case: `users`, `companies`, `email_addresses`, `equity_grants`
- Prisma models use PascalCase (`User`, `EquityGrant`) but the database uses snake_case

### Columns
- snake_case: `company_id`, `snapshot_cycle_id`, `is_terminated`, `churn_date`

## Snapshot Records (CRITICAL)

Many tables contain **snapshot records** — historical copies frozen at the end of compensation cycles.

- `snapshot_cycle_id = 'NOT_SNAPSHOT'` → live/current record
- `snapshot_cycle_id = <some-uuid>` → historical snapshot

**Always filter to live records unless you specifically need historical data:**

```sql
-- ✅ Live users only
SELECT * FROM users WHERE snapshot_cycle_id = 'NOT_SNAPSHOT' AND is_terminated = false;

-- ❌ Will include thousands of historical snapshots
SELECT * FROM users WHERE is_terminated = false;
```

### Tables with snapshots
`users`, `email_addresses`, `ranges`, `zones`, `levels`, `tracks`, `jobs`, `families`, `performance_cycles`, `performance_ratings`, `objectives`, `key_results`, `performance_questions`, `performance_answers`

## Common Tables

### Core
- `users` — employee records (filter `snapshot_cycle_id` and `is_terminated`)
- `companies` — customer companies (`churn_date IS NULL` = active)
- `email_addresses` — user emails (also has snapshots)

### Compensation
- `reviews` — compensation review cycles (users call these "cycles")
- `proposals` — compensation change proposals within a review
- `compensation_events` — historical pay changes
- `compensation_approvals` / `compensation_approval_levels` — approval workflows
- `equity_grants` — stock/equity grants
- `benefits` / `benefit_assignments` — benefit definitions and per-user assignments

### Structure
- `ranges` — compensation bands
- `zones` — geographic zones
- `levels` — job levels
- `tracks` — career tracks
- `jobs` — job definitions
- `families` — job families

### Performance
- `performance_cycles` — performance review cycles
- `performance_ratings` — ratings within a perf cycle

## Query Best Practices

1. **Count before fetching**: `SELECT COUNT(*) FROM users WHERE snapshot_cycle_id = 'NOT_SNAPSHOT'` before pulling rows
2. **Always LIMIT**: Use `LIMIT 10` or `LIMIT 100` to avoid huge result sets
3. **Filter snapshots**: Default to `snapshot_cycle_id = 'NOT_SNAPSHOT'` on every snapshot-enabled table
4. **Filter churned companies**: `JOIN companies c ON u.company_id = c.id WHERE c.churn_date IS NULL`
5. **Use the schema**: Read `app/prisma/cm/schema.prisma` in the codebase for full model definitions and relationships

## Example Queries

### Active companies
```sql
SELECT id, name, created_at FROM companies
WHERE churn_date IS NULL AND is_test_company = false
ORDER BY created_at DESC LIMIT 20;
```

### Live users at a company
```sql
SELECT u.id, u.first_name, u.last_name, u.title
FROM users u
WHERE u.company_id = '<company-id>'
  AND u.snapshot_cycle_id = 'NOT_SNAPSHOT'
  AND u.is_terminated = false
ORDER BY u.last_name LIMIT 50;
```

### Recent comp cycles for a company
```sql
SELECT r.id, r.name, r.status, r.created_at
FROM reviews r
WHERE r.company_id = '<company-id>'
ORDER BY r.created_at DESC LIMIT 10;
```

### Snapshot vs live record counts
```sql
SELECT
  COUNT(*) FILTER (WHERE snapshot_cycle_id = 'NOT_SNAPSHOT') AS live,
  COUNT(*) FILTER (WHERE snapshot_cycle_id != 'NOT_SNAPSHOT') AS snapshots
FROM users;
```
