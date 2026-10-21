# Restore drill log (spec §17.4)

Machine-appended record of restore drills: `infra/scripts/drill-restore.sh` adds
one row per run (verify-backup + scratch compose restore + smoke, with measured
RTO/RPO). The quarterly human sign-off table lives in
`docs/runbooks/RB-06-restore-drill.md` (§ Drill sign-off).

Budgets (spec §17.4): **RTO ≤ 4 h**, **RPO ≤ 24 h** (§22 alert at 26 h).
Cadence: nightly automated verify (`verify-backup.sh`, §17.3) + quarterly full
drill — never skip two consecutive drills (RB-06).

Durations are wall-clock: *Fetch* = download from the backup bucket; *Verify* =
automated throwaway-container restore + row-count sanity; *Restore* = scratch
compose project up + restore; *Smoke* = table groups + count diff + preview URL;
*RTO* = full drill elapsed (§17.4 target ≤ 4 h); *RPO* = newest backup age at
drill start (§17.4 target ≤ 24 h).

| Date (UTC) | Operator | Backup | Size | RPO | Fetch | Verify | Restore | Smoke | RTO | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| *(template row — drill-restore.sh appends below this line; delete this row after the first real drill)* | | | | | | | | | | | |
