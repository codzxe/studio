# @studio/db

Drizzle schema + migrations + Postgres client factory + demo seed. One package,
every table the SaaS persists (spec §12).

## Usage — build a client, query tables, close it

There is **no singleton export** on purpose: each app (`gateway`, `worker`, …)
constructs exactly one client at boot with its own pool size and passes it down
(dependency injection, not module globals). Pools connect lazily — creating a
client never touches the network.

```ts
import { closeDb, createDb, readDatabaseUrl } from "@studio/db";
import { agentRuns, organization } from "@studio/db"; // tables via src/index.ts

// DATABASE_URL comes from the app's config layer (@studio/config) or the
// built-in env read (fail fast — a missing/invalid URL throws DbConfigError).
const db = createDb(readDatabaseUrl(), {
  max: 10,            // pooled connections (.env.example: DATABASE_POOL_MAX)
  idle_timeout: 30,   // seconds
  connect_timeout: 10, // seconds
});

const runs = await db.select().from(agentRuns).limit(10);
const orgs = await db.select({ id: organization.id }).from(organization);

await closeDb(db); // graceful: waits up to 5s for in-flight queries, idempotent
```

`db` is a **schema-less** Drizzle instance (`drizzle(postgres())`): build typed
queries from the table objects exported by the barrel. The relational
`db.query.*` API is deliberately not wired, so this client never imports the
schema files other build agents own (`docs/AGENTS.md`).

API surface of `src/client.ts`:

| Export | Purpose |
| --- | --- |
| `createDb(url, options?)` | Drizzle + postgres-js pool; `max`, `idle_timeout`, `connect_timeout` |
| `Db` | the client type (`ReturnType<typeof createDb>`) |
| `readDatabaseUrl(env?)` | zod-checked `DATABASE_URL` read; throws `DbConfigError` (§4 fail fast) |
| `validateConnectionString(raw)` | pure check → `{ ok, url } \| { ok, code, message, hint }` |
| `closeDb(db, timeoutSeconds?)` | graceful, idempotent pool shutdown |
| `DbConfigError` | `{ code, message, hint }` boot error; never embeds the rejected value |

## Environment

`DATABASE_URL` is required everywhere this package connects
(`postgres://studio:changeme@localhost:5432/studio` locally, see `.env.example`).
Missing or malformed → `DbConfigError`, no defaults, no silent fallbacks (§4).
The env read is local to the package on purpose: db tooling (drizzle-kit, seed,
tests) must resolve the URL without a cross-package import; app code still parses
its full environment in `@studio/config`.

## Seed (local/staging demo data)

```sh
# from packages/db — Node >= 22.6, no extra tooling needed
node --env-file=../../.env --experimental-strip-types scripts/seed.ts
```

Idempotent and forward-only: creates the demo user (`demo@studio.test`), the
"Demo Studio" organization + owner membership, the 30-credit trial grant ledger
entry (§14.1), a demo project, two synthetic assets and a demo document with its
first version — skipping anything already present. Never run against
production. Table names follow §12.1 with the org-is-workspace mapping of
`src/schema/auth.ts`; the script header documents every assumption.

## Migrations

Forward-only Drizzle SQL, reviewed in PRs, applied with `pnpm db:migrate`,
never hand-edited in prod (§4):

```sh
pnpm db:generate   # src/schema/*.ts → migrations/000X_<name>.sql (review it!)
pnpm db:migrate    # apply pending files (needs DATABASE_URL)
```

See `migrations/README.md` for the full workflow and rules.

## Tests

```sh
pnpm test   # vitest — pure validation units, no Postgres required
```
