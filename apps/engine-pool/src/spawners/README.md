# engine-pool/spawners — the real `photocraft-cli serve` spawner (W2-G)

Wave 1 shipped the pool with an injectable `Spawner` seam; this directory is the real
implementation that Wave 2 wires in. **No file here is imported by the pool core** —
construct it and hand it to `EnginePool`:

```ts
import { parseEnv } from "@studio/config";                    // engine-pool env
import { EnginePool } from "@studio/engine-pool";
import { PhotocraftServeSpawner } from "@studio/engine-pool/src/spawners/photocraft-serve.js";

const env = parseEnv(); // ENGINE_BINARY_PATH + ENGINE_CAPABILITY_ROOT_BASE required
const spawner = new PhotocraftServeSpawner({
  binaryPath: env.ENGINE_BINARY_PATH,           // required, never defaulted (§4)
  capabilityRootBase: env.ENGINE_CAPABILITY_ROOT_BASE,
  env: process.env,                              // sanitized before the spawn
});
const pool = new EnginePool({
  spawner,
  limits,                                        // PlanLimitsProvider (billing, §14)
  allocatePort: () => 0,                         // ephemeral loopback TCP (preferred)
});
```

> Naming note (W2-G brief): the brief said `ENGINE_BINARY`; the shipped config
> variable is **`ENGINE_BINARY_PATH`** (`packages/config/src/env/engine-pool.ts:31`),
> with **`ENGINE_CAPABILITY_ROOT_BASE`** for the session-dir base. Use those names.

## Files

| Path | Role |
|---|---|
| `serve-config.ts` | Pure builder: argv + env + session dirs from a `SpawnRequest`. No fs, no `process.env`, no clocks — fully unit-tested. |
| `photocraft-serve.ts` | The `Spawner`: writes the token file, spawns the binary, waits for readiness, captures output, SIGTERM→SIGKILL, crash events. |
| `../../../tests/serve-config.test.ts` | Table-driven contract tests (argv vs lib.rs, dir layout, token-file safety, env scrubbing). |

## Pointing at a real engine build

1. Build the engine off-box: `cargo build -p photocraft-cli --release` against the
   vendor pin `872748fb…` plus any overlay from this repo's `engine-patches/`
   (the CI `engine-patches` job does exactly this — see the parked workflow in
   `/home/z/my-project/ci-staging/`, W1-M's worklog entry). Do **not** build or run it
   on an agent box (AGENTS.md).
2. Set `ENGINE_BINARY_PATH=/abs/path/to/photocraft-cli` and
   `ENGINE_CAPABILITY_ROOT_BASE=/abs/dir` (writable) on the engine-pool host.
3. The pool then spawns, per session:
   `<binaryPath> serve --port 0 --control-token-file <tmp>/control-token
   --automation-read-root <readRoot> --automation-write-root <writeRoot>`.

## `serve` flag reference (vendor `apps/photocraft-cli/src/lib.rs`)

`serve` subcommand declaration: **lib.rs:101-106**; usage text **lib.rs:48-53**;
implementation **lib.rs:568-592**. It accepts **value flags only** (`bare: &[]`,
lib.rs:104) and parses `--flag value` or `--flag=value` (lib.rs:110-140); an unknown
flag is a usage error → **exit 2** (lib.rs:187-209: `0` ok, `1` failure, `2` usage).

| Flag | Value | Used by spawner | Vendor notes |
|---|---|---|---|
| `--port` | `u16`, `0` = ephemeral | **yes** (TCP transport) | Parsed as u16 (lib.rs:573); binds `127.0.0.1:<port>`; rpc.rs `serve_tcp` refuses non-loopback (rpc.rs:311-316). Omitted → stdio JSON lines, no token (lib.rs:587-590). |
| `--control-token` | 64 hex chars | **never** | Validated by security.rs:92-97. Putting the token on argv exposes it in `ps` (control-protocol.md:340-342). |
| `--control-token-file` | path | **yes** | Existing file is read + validated (regular file, mode `0600`, 64 hex, security.rs:141-166); a **missing** file is created `0600` with a freshly **generated** token (security.rs:168-181, 185-211) that would NOT match the pool's — so the spawner pre-writes the pool's token into the file before spawning. |
| `--automation-read-root` | dir | **yes** (from `SpawnRequest.readRoot`) | Flags only — the env equivalents are NOT read by `serve` (control-protocol.md:344-348). The root must exist at spawn: workspace.rs `open_root` (155-165) opens it; failure exits 1. |
| `--automation-write-root` | dir | **yes** (from `SpawnRequest.writeRoot`) | Same as above. |

Env fallbacks (security.rs:312-316 `token_inputs`): `PHOTOCRAFT_CONTROL_TOKEN` /
`PHOTOCRAFT_CONTROL_TOKEN_FILE` are consulted when the flags are absent. The spawner
passes the flag **and** sets `PHOTOCRAFT_CONTROL_TOKEN_FILE` to the same path, and
**scrubs both (plus the root vars) from the inherited env** so nothing ambient can
override the credential or the capability scope.

## What `serve` prints (readiness protocol)

On **stderr**, TCP mode, in order (lib.rs:568-592):

1. `photocraft-cli control token file: <path>` — informational (lib.rs:577-578).
   (If neither token nor file were supplied, serve would print the *generated token*
   here — lib.rs:579-580 — a path this spawner never triggers.)
2. `photocraft-cli serving on 127.0.0.1:<port>` — **the readiness signal**
   (lib.rs:582-584). rpc.rs calls it after the bind succeeds and before the accept
   loop (rpc.rs:311-317), so `start()` resolves when this line appears and parses the
   port from it (`--port 0` reports the kernel-assigned ephemeral port). Failures
   print `error: <message>` and exit 1/2.

Stdio mode (no `--port`): **no banner, no token** (lib.rs:587-590); readiness is
"spawned and still alive", the first-frame `methods` handshake belongs to
`@studio/engine-client`. serve exits **0 on stdin EOF** (rpc.rs:247-264), which
`stop()` uses as the graceful stdio shutdown.

Engine-side limits (second line of defense, §15.1; security.rs:15-27): 16 concurrent
connections per listener, 1 MiB request lines, 30 s socket timeout, 10 s auth
deadline, 256 batch steps.

## Session dir layout

`resolveSessionDirs` (serve-config.ts) lays out, per session (§3.2):

```
<ENGINE_CAPABILITY_ROOT_BASE>/<organizationId>/<sessionId>/
├── read/            # capability read root (forwarded from SpawnRequest.readRoot)
├── write/           # capability write root
└── tmp/control-token  # 0600, the pool's 64-hex token; removed when the process recycles
```

**`resolveRoot` note:** the W2-G brief expected to import `resolveRoot` from
`@studio/engine-client`'s `capabilities.ts`. That module does not exist yet (Wave 2
sibling territory), and `@studio/engine-client` is not a dependency of this package —
so `serve-config.ts` owns a local mirror for now. When the client's canonical resolver
lands, prefer it; `buildServeSpawnPlan` forwards `SpawnRequest.readRoot/writeRoot`
verbatim, so callers can use either layout without touching the spawner.

## Stop / crash behavior

- `stop()` (default `SIGTERM`): stdio transport ends stdin first (graceful EOF exit);
  then SIGTERM; after `stopGraceMs` (default `DEFAULT_DRAIN_GRACE_MS`, 5 s) it
  escalates to **SIGKILL**. The child runs as its own process-group leader
  (`detached: true`) and the whole group is signalled, so a wedged engine cannot leak
  processes.
- Unexpected exits emit `exit` + `crash` events; the pool's watchdog marks the session
  `crashed` and the worker replays from the last checkpoint (§3.4).
- Cleanup removes the token file (never leaves a stale credential, §15.1) and
  best-effort drops `tmp/`; the read/write roots (document checkpoints) belong to the
  worker's lifecycle, not the spawner.
- stdout/stderr are captured into a bounded (256 lines), token-redacted ring buffer:
  `process.diagnostics()` for ops; `boundPort`/`stdin`/`stdout` expose the
  engine-facing surface for the W2 client wiring.

## TODO: smoke script (needs a real binary — CI `engine-patches` job territory)

Not runnable on this box (the engine is not built here; AGENTS.md forbids cargo).
Sketch for a CI-only script (`ENGINE_BINARY_PATH` set by the engine-patches job):

1. `buildServeSpawnPlan` with `port: 0`, temp `capabilityRootBase`.
2. `start()` must resolve within `readinessTimeoutMs`; `boundPort` must be a real
   loopback port (parsed from the serving line).
3. TCP: first frame `{"id":1,"method":"auth","params":{"token":…}}` must reply
   `{"ok":true}`; then `{"id":2,"method":"methods"}` must list methods.
4. Verify the token file exists with mode `0600` and is deleted after `stop()`.
5. `stop()` must resolve (SIGTERM) and the child exit code must be 0.
6. Negative: spawn with a bogus `binaryPath` → `start()` rejects with
   `spawn_failed`; a killed child must surface `exit` + `crash` events.
