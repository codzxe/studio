# RB-04 — Model provider outage

- **Alert (§22):** provider error rate > 10 % (metric: tool error rate / provider call
  failures per provider, §22 tokens & cost metrics lose that provider's traffic).
- **Owner:** on-call engineer · **Severity:** high · **Spec:** §22 alerts, §5.3 routing, §17.4 provider outage, §16.5 (paid tiers only)

## Symptom

A model provider (Vertex/Gemini, Anthropic, OpenAI, DeepSeek, Flux host — §5.3) errors
on > 10 % of calls for its class, or its status page/dashboard confirms degradation.
The circuit breaker flips; if every provider of a class is down, runs stay **queued**
and the UI shows "model provider degraded" (§17.4 — never fail the user's prompt
forever).

## Impact

Tier quality silently degrades when failover moves runs to the alternate of the same
class (§5.3); if all class providers fail, run latency grows unbounded (backlog, see
RB-02) while prompts wait. Cost per run may rise (failover to a pricier model is
acceptable transiently; guardrails in RB-08 still apply).

## Diagnosis

1. Confirm scope: one provider or one *class* (§5.3 planner/executor/critic/image
   roles)? Check §22 tokens in/out/cache and AI-cost-per-run metrics — missing traffic
   for a provider plus rising error rate = provider-side; rising with our error rate on
   a healthy provider = our request shape (prompt too long, image payload rejected).
2. Check the provider's status page (Uptime Kuma can ping it, §22) and our quota/billing
   dashboards — exhausted quota looks exactly like an outage (rate-limited 429s), and
   §18.4 hard spend caps can cause it deliberately.
3. Follow a failed `run_id` in Langfuse: the failing span shows HTTP status and latency;
   correlate with `workspace_id → run_id → step_seq` logs (§22).
4. Circuit-breaker state: verify failover fired (§5.3 — breakers are per-provider,
   failover to second provider of same class) and that quick-tier critic skips
   (economy has no vision critic, §5.3) did not mask the outage.

## Fix

1. If one provider of a class is down: **nothing to do manually** — breaker + failover
   (§5.3) keep runs moving; confirm the alternate is paid-tier and data-DPA-compliant
   (§1.5 constraint 6, §15.3 — never fail over to a free tier).
2. If all providers of a class are down: **disable that tier** (feature-flag the tier
   in the UI, keep `run.queued`) so jobs wait rather than fail; existing reservations
   stay held only if the tier wall clock allows — otherwise release/refund (§14.2) and
   tell the user to retry (§24.4 retry grace).
3. Quota/spend-cap exhaustion: raise the cap deliberately (owner decision, §18.4) or
   wait for reset; never swap to free endpoints or OpenRouter (§16.5 — data guarantees).
4. Provider-side outage: monitor status, set a Uptime Kuma check on the recovery
   endpoint, re-enable the tier on green; breaker half-open state self-tests recovery.

## Verification

- Provider error rate < 10 % for 30 min; runs in every enabled tier complete within
  §5.2 wall clocks; backlog (if any) drained per RB-02 verification.
- Failover logs show same-class routing only (no cross-class quality surprises);
  per-run cost anomaly scan: no run > 3× its tier average (§14.4 guardrail).
- Customers who queued during the outage either got results or clean refunds — no
  orphaned reservations (§14.2 r3/r6).

## Postmortem

Record provider, class, window, breaker behaviour, and whether the tier-disable
runbook step worked. If failover crossed classes or tiers sat broken, file the fix.
Note cost impact (§18.2 COGS ≤ 25 % revenue). Update `docs/devlog.md`.
