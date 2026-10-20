# ADR 0003 — Auth and organizations: Better Auth (org + apiKey + admin plugins)

Date: 2026-10-20 · Status: accepted

## Context

Every tenant boundary in the product depends on identity: workspaces (= Better Auth
"organizations") own documents, assets, runs, credits and engine sessions (§12, §15.1).
We need sessions for the web app, hashed/scoped API keys for the public API (§13),
server-side RBAC on every endpoint (§15.2), and support tooling for the staff — with all
identity data in our own Postgres, self-hosted next to the rest of the stack (§17.1).
License policy (§16.5) rules out anything copyleft or "source-available".

## Decision

**Better Auth (MIT) with three plugins** (§16.3 core pick — the exact reason it was picked
over alternatives):

1. **`organization` plugin** — workspaces, members, invites, and roles map 1:1 onto the
   spec's workspace model (§12 `organization`, §13 `/v1/workspaces`, invite flow). One
   workspace per subscription (§12.1 `subscriptions.organization_id` UNIQUE).
2. **`apiKey` plugin** — public API keys for programmatic access (§13 auth model):
   hashed at rest (SHA-256 + pepper, §15.2), scoped to
   `documents:read` / `documents:write` / `runs:create` / `exports:create`, revocable,
   with last-used metadata and per-key rate limits.
3. **`admin` plugin** — support/staff tooling (impersonation-free admin actions: ban,
   role changes, list memberships) for the on-call flows in `docs/runbooks/`.

**Drizzle adapter** — the same ORM, connection pool, and forward-only migration pipeline
as the rest of the schema (ADR-0002, §12). Identity tables live beside content/runs/
ledger tables; `organization_id` FKs from content/runs/billing tables point at the
plugin's `organization` table (W1-C/W1-D landed them as text FKs).

**Sessions** — httpOnly, `secure`, `sameSite` cookies; CSRF protection on cookie-auth
mutations; rate limits per IP/user/workspace on auth, uploads, runs, exports (§15.2).
Session validation is a gateway middleware; RBAC is enforced server-side on every
endpoint — UI hiding is never enforcement (§15.2).

### RBAC matrix (§15.2)

Better Auth org roles are the single source of truth; the gateway maps them to
permissions. `viewer` ⊂ `editor` ⊂ `admin` ⊂ `owner` (cumulative):

| Capability | viewer | editor | admin | owner |
| --- | :---: | :---: | :---: | :---: |
| Read documents/assets/runs/versions | ✅ | ✅ | ✅ | ✅ |
| Comment (with position) | ✅ | ✅ | ✅ | ✅ |
| Create runs (`POST /runs`, tiers) | ❌ | ✅ | ✅ | ✅ |
| Manual commands / undo / redo / restore | ❌ | ✅ | ✅ | ✅ |
| Exports (`exports:create`) | ❌ | ✅ | ✅ | ✅ |
| Upload assets / register templates | ❌ | ✅ | ✅ | ✅ |
| Manage members + invites | ❌ | ❌ | ✅ | ✅ |
| Billing (checkout/portal, credit packs) | ❌ | ❌ | ✅ | ✅ |
| API key management | ❌ | ❌ | ✅ | ✅ |
| Delete workspace (§15.2 "owner: delete") | ❌ | ❌ | ❌ | ✅ |
| Transfer ownership / dissolve | ❌ | ❌ | ❌ | ✅ |

API keys get a role no greater than the creating member's (an editor's key can hold
`runs:create`; a viewer's key cannot) and are additionally constrained by scope.

### Why not Clerk / NextAuth (§16.3)

- **Clerk** — proprietary SaaS, no self-hostable core: customer identity data leaves our
  box, conflicting with §15.3 retention/GDPR posture and the single-box cost model
  (§17.1). Per-MAU pricing multiplies fixed cost before revenue; ToS/licensing is not
  ours to control. The ixartz starter is Clerk-based and was kept as reference only.
- **NextAuth/Auth.js** — MIT, but not organization-first: workspaces, invites, API keys
  and admin tooling would all be hand-rolled adapter code (the Vercel starter note in
  §16.1 says "swap its auth for Better Auth to get organisations/API keys"). No
  first-class API-key plugin; heavier maintenance surface.
- **Better Auth** — MIT, runs in-process against our Postgres via the Drizzle adapter,
  ships all three plugins, and is already wired in the chosen starter
  (mickasmt/next-saas-stripe-starter, §16.1). One stack, one database, zero identity
  egress.

## Consequences

- Role names (`owner|admin|editor|viewer`) are wire-stable; adding a role or permission
  is a migration + middleware change, never a string sprinkled through handlers.
- Every role change, invite, API-key create/revoke, and destructive action is appended to
  `audit_log` with actor, IP, timestamp (§15.4, §22).
- Cross-tenant lookups return 404, not 403 (W1-J precedent; §15.1 tests assert this).
- If enterprise SSO (SAML) lands in Phase 3+, it comes via Better Auth plugins — not a
  rewrite (BoxyHQ starter is the reference, §16.1).
- Session/CSRF/rate-limit middleware is gateway-owned; the worker and engine-pool never
  see cookies — they authenticate via internal calls only (§15.1).
