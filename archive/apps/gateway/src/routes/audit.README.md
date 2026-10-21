# routes/audit.ts — §22 audit export + admin summary (W9-H)

Two thin, admin-only routes over the W4-Q `AuditService`
(`src/services/audit.ts`). No storage or query logic lives here — RBAC
(admin+), the tenant guard, and wire encoding only.

| Route | Who | What |
|---|---|---|
| `GET /v1/workspaces/:id/audit` | admin+ of `:id` | Cursor-paged §22 export for ONE workspace. `?from`/`?to` (inclusive UTC ISO-8601 `Z`), `?cursor`, `?limit` 1..500. `?format=csv` returns the **same rows** as an RFC 4180 `text/csv` download (header row `id,organization_id,actor_id,action,target,metadata,created_at`; CRLF; metadata is one JSON cell, already redacted at append time per §15.3). CSV pages carry the continuation cursor in the `X-Next-Cursor` response header (the JSON body carries `next_cursor`). |
| `GET /v1/audit/summary/:id` | admin+ of `:id` | Counts by `action` over the last 30 days — the support-tooling landing card: `{ window_days, since, total_events, by_action }`. |

Both routes: 401 unauthenticated, 403 `forbidden` below admin,
403 `cross_tenant_denied` for foreign workspaces (distinct code per the
`src/authz/guard.ts` seam contract — never 404-masked).

## RBAC note (one place to change)

ADR-0003 has no audit permission row yet, so the admin+ gate uses the guard's
`assertCan(role, "members:manage")` — the admin-tier workspace-security
capability the matrix does grant (audit rows *are* the member/role/api-key
security history). This also keeps API-key scope narrowing in force: an
admin's narrowly-scoped key cannot bulk-export the security log. When the
matrix grows `audit:read`, swap `AUDIT_GATE_PERMISSION` in `audit.ts`.

## How admin support tooling consumes it (§16.3)

The better-auth **`admin` plugin** is the support surface (spec §16.3:
"the `admin` plugin for support tooling"). Support flows:

1. **Landing card** — open the workspace in the support console →
   `GET /v1/audit/summary/:id` shows what happened in the last 30 days
   (logins, role changes, API-key creates/revokes, exports, deletes, credit
   adjustments).
2. **Trail walk** — `GET /v1/workspaces/:id/audit?limit=100` then follow
   `next_cursor` to page the full trail (newest first).
3. **Compliance export** — `?format=csv` downloads the same rows; repeat with
   `?cursor=<X-Next-Cursor>` for multi-page downloads.

### Wiring expectation: impersonation events land in `audit_log`

**Expectation (owned by the auth wiring wave, not this file):** better-auth
admin-plugin **impersonation** events MUST be appended to the §22 audit trail
via `AuditService.append`, using the stable lowercase-dotted taxonomy:

- `auth.impersonation.start` / `auth.impersonation.stop`
- `actorId` = the **support operator** (never the impersonated user),
- `target` = `user:<id>` of the impersonated member,
- `organizationId` = the workspace in context when known, `null` for
  platform-level sessions,
- `metadata` = request context only (§15.3 redaction applies automatically).

Until that hook lands, the summary card simply will not show impersonation
counts — the export/summary routes work over whatever `audit_log` contains
(and the §22 taxonomy already covers `auth.login`, `role.changed`,
`api_key.created/revoked`, `export.created`, deletes, credit adjustments).

## Wiring + production adapters

```ts
// buildApp / the /v1 registry (W5 wiring wave) — mount BEFORE the /v1 catch-all:
mountAuditRoutes(app, {
  auth,                       // W4-B auth-context (requireAuth adapter) —
                              // { userId, organizationId, role, permissions }
  audit: auditService,        // the SAME `new AuditService({ store: new DrizzleAuditStore(db) })`
                              // the rest of the gateway appends through
  summary: {                  // ~10-line Drizzle adapter over @studio/db:
    async countsByAction({ organizationId, since }) {
      const rows = await db
        .select({ action: auditLog.action, n: count() })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, organizationId),
                   gte(auditLog.createdAt, since)))
        .groupBy(auditLog.action);
      return Object.fromEntries(rows.map((r) => [r.action, Number(r.n)]));
    },
  },
});
```

Mount options: `mountAuditRoutes(v1, deps, { workspacesPath: "/workspaces",
auditPath: "/audit" })` when mounting inside the `/v1` sub-app.

**Rate limiting:** intentionally none in this module (kept scope; admin-only
surface, not a per-member abuse surface). If the platform wants export
throttling, wire the shared `RateLimiter` at the mount site — the credits.ts
`enforceReadLimit` pattern drops in unchanged.
