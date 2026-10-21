# RB-06 — Backup restore drill

- **Alert trigger (§22):** backup older than 26 h (daily cadence slipped). The alert
  reads the `postgres/_freshness.json` marker object written by `backup-v2.sh`
  (`last_success_epoch` older than 26 h → page).
- **Owner:** on-call engineer · **Severity:** proactive (drill) · **Spec:** §17.4 backup/restore, §22 alerts, §17.3 nightly CI

## Symptom

Drill (this runbook is *executed on a schedule*, not only on an alert): verify that the
nightly `pg_dump -Fc` → S3 versioned bucket succeeded, that assets bucket versioning is
on, and that a restore into a scratch database reproduces a working workspace. The §22
alert fires if the newest backup is > 26 h old.

## Impact

Until the drill passes, the platform's real RPO/RTO are unknown. §17.4 targets
**RTO ≤ 4 h, RPO ≤ 24 h** — if a restore has never been rehearsed, both numbers are
fiction, and a data-loss incident becomes unrecoverable.

## Cadence

§17.4: **monthly**, executed as the nightly restore test in CI where possible
(§17.3: nightly backup restore into a scratch DB); the *documented quarterly minimum*
applies even in crunch periods — never skip two consecutive drills. Log each drill
run in `docs/runbooks/drill-log.md` (machine-appended by `drill-restore.sh`).

- Nightly automated half: `infra/scripts/verify-backup.sh` (§17.3 CI job on the box).
- Quarterly human drill: `infra/scripts/drill-restore.sh` (this runbook, full §17.4
  drill with RTO/RPO measurement and sign-off below).

## Diagnosis (drill steps)

All three steps are wired scripts (W9-K). Expected timings assume a ≤ 1 GB dump
on the box; a bigger DB scales roughly linearly — record actuals either way.

1. **Freshness (§22 marker, < 1 min):** the nightly `pg_dump -Fc` job is
   `infra/scripts/backup-v2.sh` (custom format → sha256 manifest → dated
   `postgres/YYYY/MM/DD/` prefix in the versioned bucket → 26 h marker):

       aws s3 cp "s3://${S3_BACKUP_BUCKET}/postgres/_freshness.json" -

   `last_success_epoch` older than 26 h (or the object missing) → alert;
   run `infra/scripts/backup-v2.sh` manually FIRST, then root-cause the cron
   (RB-05 disk, credentials, §Fix below).
2. **Automated half (nightly, §17.3):**

       infra/scripts/verify-backup.sh            # ~2–6 min @ ≤ 1 GB

   Downloads the newest backup, verifies the sha256, restores into a
   throwaway Postgres container (same image as prod → no version skew) and
   row-count-checks users/orgs|workspaces, `agent_runs`, `credit_ledger`,
   `credit_reservations`, `subscriptions` → prints `RESULT: PASS|FAIL`.
   A FAIL here is the §22-equivalent of a broken backup path — fix before the
   full drill.
3. **Full quarterly drill (§17.4, human):**

       infra/scripts/drill-restore.sh --operator "$USER"   # ~5–15 min @ ≤ 1 GB

   Runs step 2 with a source count-diff, then restores the same dump into a
   scratch **compose project** (isolated name + volume, torn down with `-v`),
   smokes it (table groups, money-path count diff vs source, preview URL),
   and appends measured RTO/RPO to `docs/runbooks/drill-log.md`.
   Pass `--skip-source-diff` only when the live db is unreachable, and
   `--backup <key|path>` to drill a specific backup. Budgets: RTO ≤ 4 h,
   RPO ≤ 24 h (26 h alert).
4. **Eyeball the sample workspace (kept human, §17.4):** newest
   workspace's document + version + asset in the bucket versioning prefix,
   and that its preview URL resolves in a browser. The scripts print the
   count-diff and preview-URL check; the operator confirms the round-trip.

## Fix (on drill failure or alert)

- **No recent backup:** run `infra/scripts/backup-v2.sh` manually (it also logs the
  previous marker's age), upload, then root-cause the nightly job (cron on the box?
  CI runner credentials? disk full → RB-05).
- **Restore errors:** check version skew — restored dump vs current migration chain
  (forward-only migrations, §12/AGENTS.md); if the backup predates a migration, apply
  migrations forward on the scratch DB and re-time RTO (that's the real procedure).
- **Bucket versioning off / prefix wrong:** fix bucket config first — an unversioned
  backups bucket silently defeats deletion protection (§17.4).
- **Slow restore (RTO > 4 h):** split parallel `pg_restore -j`, or move the restore
  rehearsal to a bigger scratch instance; document the delta.

## Automation (W9-K scripts)

| Script | Role | Cadence | Expected duration (≤ 1 GB dump) |
|---|---|---|---|
| `infra/scripts/backup-v2.sh` | `pg_dump -Fc` → sha256 + manifest → dated S3/R2 prefix → 26 h freshness marker; lockfile, idempotent, cron `0 3 * * *` | daily | 1–5 min |
| `infra/scripts/verify-backup.sh` | newest backup → throwaway-container restore → table/row sanity → `RESULT: PASS\|FAIL` | nightly (§17.3) | 2–6 min |
| `infra/scripts/drill-restore.sh` | verify + scratch compose restore + smoke + RTO/RPO → `drill-log.md` | quarterly (human) | 5–15 min |

Env knobs (optional overrides; defaults in the script headers):
`S3_BACKUP_BUCKET`, `S3_BACKUP_PREFIX` (`postgres`), `STORAGE_ENDPOINT_URL` (R2),
`KEEP_LOCAL_DAYS` (1), `VERIFY_TABLES` (groups, `|` = alternatives),
`ASSET_PREVIEW_SQL` (default probes `assets.preview_url`; skipped if the relation
is absent), `COMPARE_SOURCE`/`STRICT_COUNTS` (count-diff semantics),
`S3_OBJECTS_REPLICA_BUCKET` (opt-in bucket→bucket sync for `.pcraft` objects —
off by default; bucket **versioning** is the §17.4 deletion-protection mechanism).
`restore.sh` (W1-L) still handles real production restores from the same dumps.

## Verification

- `verify-backup.sh` prints `RESULT: PASS` (nightly, two nights running) and
  `drill-restore.sh` PASS with scratch restore + smoke green in ≤ 4 h.
- Newest backup < 24 h old in a versioned bucket (marker object present, §22).
- One row appended to `docs/runbooks/drill-log.md` per drill: date, RTO measured,
  RPO evidenced, failures hit, fixes filed — then the sign-off table below.

## Drill sign-off (fill in per quarterly drill)

| Field | Value |
|---|---|
| Date (UTC) | |
| Operator (name + role) | |
| Backup key drilled | |
| RTO measured (≤ 4 h, §17.4) | |
| RPO evidenced (≤ 24 h; §22 alert 26 h) | |
| `verify-backup.sh` | PASS / FAIL |
| `drill-restore.sh` | PASS / FAIL |
| drill-log.md row appended | yes / no |
| Failures hit / fixes filed | |
| Phase-gate note (§19 Phase 4: restore drill passed) | |
| Signature / commit | |

## Postmortem

A missed drill or failed restore is treated like an incident: root-cause the gap
(schedule, credentials, disk, migration skew), file the fix, and re-run the drill
within a week. Quarterly compliance (at minimum) is reported at the phase gate
(§19 Phase 4 exit: restore drill passed).
