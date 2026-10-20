# RB-06 — Backup restore drill

- **Alert trigger (§22):** backup older than 26 h (daily cadence slipped).
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
run in `docs/devlog.md`.

## Diagnosis (drill steps)

1. List the latest backup objects in the S3 backups prefix (versioned bucket): is the
   newest `pg_dump` < 24 h old and non-zero size? (> 26 h → also fix the nightly job
   before continuing.)
2. Restore into a scratch DB (never a shared/staging customer DB):
   `pg_restore -d postgres://…scratch… dump.pg` — time it; this is the RTO measurement.
3. Diff-check row counts on the money path: `credit_ledger`, `credit_reservations`,
   `subscriptions`, `agent_runs` — append-only tables must match the source snapshot.
4. Restore-path check for objects: pick one workspace, verify its document versions +
   assets in the bucket versioning prefix and that a preview URL resolves.

## Fix (on drill failure or alert)

- **No recent backup:** run `pg_dump -Fc` manually, upload, then root-cause the
  nightly job (cron on the box? CI runner credentials? disk full → RB-05).
- **Restore errors:** check version skew — restored dump vs current migration chain
  (forward-only migrations, §12/AGENTS.md); if the backup predates a migration, apply
  migrations forward on the scratch DB and re-time RTO (that's the real procedure).
- **Bucket versioning off / prefix wrong:** fix bucket config first — an unversioned
  backups bucket silently defeats deletion protection (§17.4).
- **Slow restore (RTO > 4 h):** split parallel `pg_restore -j`, or move the restore
  rehearsal to a bigger scratch instance; document the delta.

## Verification

- Scratch DB restored in ≤ 4 h, ledger row counts match, sample workspace usable
  (document + version + asset + preview round-trip).
- Newest backup < 24 h old in a versioned bucket; nightly job green two nights
  running.
- Drill record appended to `docs/devlog.md` with: date, RTO measured, RPO evidenced,
  failures hit, fixes filed.

## Postmortem

A missed drill or failed restore is treated like an incident: root-cause the gap
(schedule, credentials, disk, migration skew), file the fix, and re-run the drill
within a week. Quarterly compliance (at minimum) is reported at the phase gate
(§19 Phase 4 exit: restore drill passed).
