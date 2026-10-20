# RB-05 — Disk usage

- **Alert (§22):** disk > 80 % (and memory > 90 % as the companion alert).
- **Owner:** on-call engineer · **Severity:** high (page — Postgres corruption risk) · **Spec:** §22 alerts, §17.4 disk full, §17.2 compose

## Symptom

Uptime Kuma / the box-agent script reports root (or the compose volume) filesystem above
80 %, or memory above 90 %. Log writes slow, `pg_dump` may fail, and the engine pool's
work volume (`engine_work`) is the usual first offender (renders, previews, temp
checkpoints).

## Impact

The §17.4 rule is absolute: the **engine pool is killed before Postgres is starved**.
Left alone: WAL writes fail, `pg_dump` backups stop (RPO breach, RB-06), and the box
OOM-kills arbitrary services (worst case: Postgres mid-write).

## Diagnosis

1. `df -h` per volume + `docker system df`: which is full — `pgdata`, `engine_work`,
   `kuma`, caddy, or container log growth (§17.4: rotate logs, max 500 MB)?
2. `du` the engine work dirs: orphaned tenant temp (crashed sessions that never
   recycled — cross-check RB-03) and un-reaped exports/previews dominate by design.
3. Postgres bloat: `agent_steps`/`run_events` past the retention window (§15.3: prompts
   and renders 90 days, steps purged after the window)? Purge job stalled?
4. Memory pressure companion: check §22 DB pool saturation + engine session count;
   swapping at 90 % RAM precedes the disk case.

## Fix

1. **Free the fast wins:** rotate/compress container logs to the §17.4 cap (max
   500 MB); `docker image prune` (keep the previous two images for rollback, §17.3).
2. **Reap engine work:** delete temp dirs for sessions no longer active in the pool
   registry (idle timeout 15 min already applies, §3.4); if the pool is saturating the
   box, reduce per-process limits (§17.2) or scale per the §17.4 trigger (second
   engine box at > 60 % sustained CPU/RAM or > 30 concurrent runs).
3. **Purge retention:** run the `agent_steps`/prompt retention purge (§15.3 — 90-day
   default) and orphaned-object sweep (exports kept *until deleted by the user* are
   never purged — check the delete queue instead).
4. **If > 90 % or growing:** stop the engine-pool service *first* (§17.4 order), let
   queued jobs wait (RB-02 monitoring), free space, restart, verify.

## Verification

- Disk < 80 % and stable for 24 h; memory < 90 %; no service was OOM-killed.
- A `pg_dump` backup completes and is < 26 h old (§22 backup alert; RB-06 drill next
  scheduled run still valid).
- A canary run completes — engine pool healthy after the restart; queue age < 2 min.
- Root cause quantified: bytes reclaimed per source (logs / temp / retention).

## Postmortem

Record: what filled the disk, how close Postgres came to starvation, whether the
box-agent alerted before manual discovery. Add a recurring cleanup job or tighten log
rotation caps if this was predictable. Update `docs/devlog.md`; if the engine-first
kill order wasn't respected, that's a postmortem action item on the supervisor config.
