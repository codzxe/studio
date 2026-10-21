# Gateway integration tests (W4-P)

Cross-tenant, money-correctness, RBAC and signup-flow integration suites over
the **real gateway routers and guard logic** — every external dependency
(database, queue, billing store, object storage, auth provider) is an
in-memory fake injected through each route module's documented DI seam.
No network, no DB, no real timers; deterministic clocks; runs in seconds.

## How CI runs these

```bash
pnpm --filter @studio/gateway test        # vitest run (default config)
pnpm --filter @studio/gateway typecheck   # tsc --noEmit — tests are in the program
```

Vitest's default include (`**/*.test.ts`) picks this directory up automatically;
there is no separate config to keep in sync. The suites here follow the
AGENTS.md test law: deterministic, `< 5 s` per test, table-driven where the
logic is pure, no network. The only fake at the money boundary is the
`LedgerStore` (it mirrors the `credit_ledger` `unique(idempotency_key, kind)`
index); **all billing semantics run the real `@studio/billing` functions**
(`billingFromLedger`, `commitReservation`, `releaseReservation`, `trialGrant`).

## Files

| File | Spec anchor | What it pins |
|---|---|---|
| `harness.ts` | — | Shared mount: ONE `buildApp` with every landed router (runs, run-events SSE, documents, workspaces, invites, uploads/assets) over injected fakes; bearer-token session map shared by every auth seam; the W4-C guard composed ahead of `POST /v1/runs` exactly as `routes/index.ts` must wire it. |
| `cross-tenant.test.ts` | **§20 #11** (§21 Security: cross-tenant, IDOR) | The automated cross-tenant suite: an org A user cannot read/list/command/stream org B's document, asset, run or workspace — probed in **both directions** with the attacker's *owner* token. Assertions follow the two documented guard semantics: composite-scoped lookups answer **404 `not_found`** (never confirm existence), membership-based assertions answer **403 `cross_tenant_denied`** — and never a 2xx carrying the other org's data (envelope needles: names, prompts, checksums, ids). Also: the `keys.ts` `assertTenant` **table over all five storage namespaces** (the preview/export object spaces have no HTTP route yet — their tenant guard is pinned here), the typed resource guard's own table (empty ids fail closed, denials logged with `request_id`, envelopes leak no ids), and unauthenticated probes 401 before the tenant gate. |
| `ledger-flow.test.ts` | **§20 #10** | reserve→commit entries match (`${runId}:reserve` / `:commit` keys, deltas `−A` / `A − charge`), balances settle at every phase, a failed run refunds the full hold, cancel refunds (and stays refunded — money terminals are mutually exclusive), and the same idempotency key never charges twice (create replay + commit replay), insufficient credits charge nothing. The worker's settlement step is driven through the public `@studio/billing` functions over the same ledger, exactly as Wave 6 will call them. |
| `rbac-matrix.test.ts` | **§15.2 / ADR-0003** | Route-level ladder through the mounted surface: viewer can GET but cannot POST runs/upload/mutate/manage; editor can run/upload/mutate but cannot invite or list members; admin manages members+invites (danger zone stays owner-only); owner inherits everything. Plus the ADR-0003 matrix cells at the pure `can()` + guard layer, and §15.2 API-key scope narrowing (an editor-role session with narrowed grants is still denied — fail closed on empty grants). |
| `signup-flow.test.ts` | **§20 #1** (partial) | Workspace create → **owner member row** → trial grant in the real ledger → invite with role **editor** → accept → **member row with role editor** → the member lists the **same project list** → the member can start a run on it → the burned invite 409s on replay → §22 audit trail recorded the flow. (Email delivery of the token is the email wave's TODO; the fake auth session stands in for the auth provider.) |

## Documented decisions

- **RBAC on `POST /v1/runs` is composed by the harness**, not the runs router:
  the runs auth seam is role-less today, so the harness mounts the W4-C guard
  (`assertCan(role, "runs:create", session)`) ahead of the handler — the
  exact wiring `routes/index.ts` must ship. When that lands, delete the
  harness middleware and this note together.
- **Billing row (ADR-0003 wins over task text):** the W4-P brief said
  "admin cannot access billing", but the ADR-0003 RBAC table — the
  authoritative source W4-C reconciled in `src/authz/roles.ts` and
  `matrix.ts` audits — grants Billing at **admin** (owner inherits
  cumulatively). The suite pins the ADR cell; viewer/editor are denied
  `billing:manage`. No billing router exists yet, so the cell is asserted at
  the `can()` + guard layers; the billing wave must enforce the same
  permission and add its route probe here.
- **`preview`/`export` HTTP routes do not exist yet** (W4-K). Their object
  spaces (`renders/`, `exports/`) are covered by the storage-key
  `assertTenant` table in `cross-tenant.test.ts`; when the routes land, add
  them to `DENIAL_PROBES` in both directions.

## §21 Security row coverage map

| §21 item | Status |
|---|---|
| Cross-tenant access | ✅ here (`cross-tenant.test.ts`, §20 #11 gate) |
| IDOR | ✅ here — foreign ids are byte-identical envelopes to missing ids |
| Rate-limit bypass | ✅ `tests/rate-limit.test.ts` + `tests/limiter.test.ts` (W4-D) — CAS exactness under 10 parallel requests, bucket key isolation, fail-open posture |
| JWT/session replay, CSRF | ⏳ auth wave — needs the real Better Auth session/cookie surface (fake sessions cannot regress-test it) |
| Upload fuzzing (polyglot, zip bombs, EXIF payloads) | ✅ `tests/uploads.test.ts` (W4-I) + `packages/storage` validate suites; corpus-style **fuzzing is Wave 10** |
| Prompt injection corpus | ⏳ Wave 10 (per the fleet plan; gateway-side guards land with the worker/tool wave) |
| SSRF on webhook-like URLs | ⏳ Stripe webhook route lands with the billing wave |

Fuzzing is **Wave 10**; everything above marked ⏳ has an owner elsewhere or a
later wave and must extend this directory when it lands.
