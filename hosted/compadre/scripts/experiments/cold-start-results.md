# Cold-start reduction experiments

Goal: cut the ~28 minutes of environment setup observed in the 2026-09-01
production verification run (44 min total; the agent's real work was ~15 min).

Production baseline (run e6d5742f, 2026-09-01, from the durable event log):

| Phase | Time |
|---|---|
| Sandbox create + image resolve | ~1 s |
| `git clone --depth 1` of comp (3.2 GiB pack) | 6.2 min |
| dev-up + dev-data production-latest (download, gunzip, hen restore/anonymize/migrate) | ~17 min |
| First-page Vite compiles + dev-server waits | ~5 min |

## Hypotheses

- **H-golden**: a pre-warmed filesystem snapshot (repo + node_modules + restored
  anonymized DB + Vite cache) restored via the existing `restoreSnapshot`
  machinery brings a usable environment up in low single-digit minutes.
  Supporting signal: production terminal checkpoints of fully-warmed workers
  captured in 4–7 s, suggesting Modal snapshots are cheap at this size.
- **H-refresh**: a restored template only needs `git fetch --depth 1 + reset`
  (seconds, not minutes) plus a periodic template rebuild to stay current.
- Fallbacks if H-golden fails: bake the clone into an image layer (H-image),
  cache the DB dump in object storage closer to Modal (H-dumpcache).

## Method

`scripts/experiments/cold-start-probe.ts` reproduces the production
provisioning faithfully (same `modalSandboxProvider`, image commands, resources
2 CPU / 16 GiB, same clone command, same comp scripts, real hourly backup via a
minted scoped token). Phases are individually timed. All sandboxes are
terminated unless `--keep`. One variable changes per experiment.

## Runs

### E0 baseline (cold build) — 2026-09-01
Command: `baseline --snapshot` (full production fidelity: artifact URLs
SEED/PREBUILT/PGDATA/VITE_CACHE projected, real hourly backup, preview tunnel)

| Phase | Time |
|---|---|
| sandbox.create + image.resolve | 0.5 s |
| repository.clone --depth 1 | **highly variable: 8.0 s, 8.5 s, 8.7 s, 178 s (probe); 372 s (prod)** — GitHub pack-cache dependent |
| dev-up (deps from PREBUILT, pgdata, vite cache, SSR warm) | 137 s |
| first page | 0.5 s (200) |
| dev-data production-latest (download + gunzip + hen restore/anonymize/migrate, 13 GB pgdata) | **587 s** |
| live golden snapshot capture (15.5 GB fs) | 95 s |
| **Total cold to prod-data-ready** | **~12–13 min (plus clone tail risk up to +6 min)** |

### E1 restore from golden snapshot (n=2) — 2026-09-01
Command: `restore --snapshot-id im-01M1FM4H9VAEN1P8B428E54B3V`

| Phase | Run 1 | Run 2 |
|---|---|---|
| restore sandbox from snapshot | 0.3 s | 0.5 s |
| dev-up (restart PG/redis/vite + SSR warm) | 172 s | 123 s |
| first page | 0.7 s (200) | 0.5 s (200) |
| production-derived DB intact | yes (1139 companies, marker preserved) | yes |
| git fetch+reset refresh | ~2 s (fetch needs creds injected — gap noted) | ~2 s |
| **Total to prod-data-ready** | **3.1 min** | **2.2 min** |

## Conclusions

- **H-golden CONFIRMED**: restoring a pre-warmed template snapshot brings a
  fully usable, production-data dev environment up in **2–3 min**, vs 12–13 min
  faithful cold build, vs 28+ min observed end-to-end in production (which also
  ate a 6-min clone tail and agent think-time between steps).
- **H-refresh CONFIRMED in principle**: incremental `git fetch --depth 1 +
  reset` takes ~2 s (restore path must inject GIT_ASKPASS_* for the fetch).
- The remaining floor in the restored path is dev-up's service restart +
  Nitro/SSR warm-up (~2 min). Optimize later if it matters.
- Clone time is bimodal (9 s vs 3–6 min) — eliminating the per-thread clone
  also eliminates the tail risk, not just the median.
- Live checkpoint of the 15.5 GB warmed fs takes ~95 s (fine for a scheduled
  template build; irrelevant to thread latency).

## Integration plan (next)

1. Template builder: a scheduled job (Temporal cron or ops endpoint) that
   builds a fresh sandbox exactly like E0 (clone, dev-up, dev-data
   production-latest), captures a snapshot, and records the image ID +
   metadata (repo SHA, backup key, built-at) in Postgres metadata.
2. Provision-from-template: `provision()` restores the newest template image
   when present (and not stale), then `git fetch + reset` to origin/main and
   reprojects credentials — identical to the existing worker-restore path.
   Cold-build fallback when no template exists.
3. dev-data stays agent-driven: with the template DB already
   production-derived, "download a real db" becomes a status check/no-op
   unless the agent explicitly wants a fresher backup.
