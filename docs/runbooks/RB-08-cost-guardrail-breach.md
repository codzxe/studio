# RB-08 — Cost guardrail breach

- **Alert (§22):** cost per day > budget. Companion guardrails (§14.4): workspace AI
  COGS > 35 % of its revenue; a single run > 3× its tier's average cost; platform-wide
  COGS > 25 % of MRR. Also §14.2 r7: workspace daily cap alert at 80 % (cap = 2×
  monthly plan credits).
- **Owner:** founder/on-call · **Severity:** business-critical (page) · **Spec:** §22 alerts, §14.4 guardrails, §14.2 r7, §18.2/§18.4

## Symptom

A §22 cost dashboard alert fires: daily AI spend exceeded the budget line, a
workspace crossed 35 % COGS/revenue, or one run's token/cost trace (Langfuse) is 3×
its tier average. Uptime Kuma or the billing service raised the 80 %-of-daily-cap
warning for a workspace.

## Impact

Unit economics are the product's survival: standard-run margins are 63–72 % only at
planned routing (§14.4). A breached guardrail means either a runaway loop (customer
bug that costs them credits) or margin erosion (provider prices, prompt bloat,
cache-miss storms). The §18.2 law is COGS ≤ 25 % of revenue platform-wide.

## Diagnosis

1. Which guardrail? Per-workspace (their loop), per-run (anomaly), or platform-wide
   (routing/pricing drift). Query the §22 metrics: AI cost per run/workspace/day,
   tokens in/out/cache, credits reserved vs committed.
2. **Run > 3× tier average:** open its Langfuse trace — cache-hit collapse (prefix
   shifted mid-run, §5.4 token discipline), repair loops inflating revisions (§5.2),
   or an image-heavy run billed per image (§14.1)? Check the critic/revise-rate metric.
3. **Workspace > 35 %:** legit heavy usage (upsell opportunity) vs a loop — repeat
   identical prompts, retries, or a script with no backoff. Check rate-limit buckets
   and the daily-cap trajectory (§14.2 r7).
4. **Platform > 25 %:** provider price change (§Appendix C — re-verify rates), failover
   storms pushing runs to premium models (RB-04), or free-tier cache misses
   (cache-hit rate < 60 % on standard runs, §5.3 target).
5. Confirm hard spend caps at each provider still hold (§18.4) — an exhausted cap
   turns a cost incident into an availability one (RB-04).

## Fix

1. **Runaway workspace:** the daily cap (2× monthly credits) is the backstop — let it
   engage; alert at 80 % already fired. Contact the workspace owner; refund obvious
   platform-bug costs fully and flag the runs for review (§14.2 r5).
2. **Cache-hit collapse:** re-stabilize the context prefix (stable ordering + ids,
   §5.4); a prompt/model change that broke caching gets reverted — prompts are
   versioned and eval-gated (§23).
3. **Routing drift:** fix tier→model routing (§5.3); if failover is the cause, raise
   the breaker threshold or fix the flapping provider (RB-04); never route customer
   data to cheaper/free endpoints (§16.5, §1.5 constraint 6).
4. **Prices up:** recompute §14.4 tables, adjust credit pricing deliberately (owner
   decision — it's customer-visible), and update `packages/config` pricing constants.

## Verification

- Daily cost under budget for 48 h; offending workspace under 35 % or capped cleanly;
  platform COGS ≤ 25 % of MRR (§18.2).
- Standard-run cache-hit rate back ≥ 60 % (§5.3); no run exceeds 3× tier average in
  the last 24 h (§14.4).
- Ledger integrity: every refund/adjustment for the incident has an idempotency key
  and an `audit_log` row (§14.2 r6, §15.4).

## Postmortem

Record guardrail tripped, dollars at risk, root cause (loop/routing/pricing), and the
customer-communication decision. Update the §14.4 economics tables if rates changed —
they are contract-level for pricing. Log the tuning (alert thresholds) if detection
was late. Append to `docs/devlog.md`.
