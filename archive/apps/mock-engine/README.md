# @studio/mock-engine

Protocol-faithful fake of the pinned engine's headless control server
(`photocraft-cli serve`, TCP mode) for integration tests and compose dev.
Zero npm dependencies — plain `.mjs` JavaScript with JSDoc, runs with bare
`node`. Shapes and strings are pinned to
`vendor/photocraft/docs/control-protocol.md` and
`vendor/photocraft/crates/automation/src/{security,rpc}.rs`.

## Environment contract

| Variable | Default | Meaning |
| --- | --- | --- |
| `MOCK_ENGINE_PORT` | `7800` | Loopback TCP port. `0` picks an ephemeral port; the real port is on stderr (`listening on 127.0.0.1:<port>`). |
| `MOCK_ENGINE_TOKEN` | generated | 64-hex auth token (like `PHOTOCRAFT_CONTROL_TOKEN`). When unset (or not 64 chars) one is generated and printed to stderr as `token <hex>`. |
| `MOCK_ENGINE_WRITE_ROOT` | cwd | Capability root for `doc.save {path}` / `doc.render {path}`: absolute paths and `..` are refused, like the automation write root. |
| `MOCK_FAULT` | — | Chaos hooks, fired on every `engine.execute` dispatch: `crash-on-command` (hard `process.exit(86)` before the reply), `hang` (no reply at all), `oversized-reply` (a well-formed reply far past the 8 MiB ceiling). |

## What is faithful

- Loopback-only, newline-delimited JSON; replies carry the request's `id`
  (`{"id","ok","result"}` / `{"id","ok":false,"error":"…"}` — engine errors are
  plain strings).
- First-frame `auth` with the real strings: success →
  `{"authenticated":true}`; wrong token or non-auth first frame →
  `authentication required` and the connection is closed; repeat `auth` →
  `already authenticated` and the connection keeps serving (case-insensitive
  64-hex token match).
- Transport limits (protocol › Transport limits): 16-connection cap (excess
  connections destroyed before dispatch), 1 MiB request line (connection
  closed after an oversized line), 8 MiB reply ceiling, 30 s socket timeout.
- Method surface of `rpc.rs` (subset): `methods`, `session.list`, `doc.new`
  (`{document: index}`), `doc.open`, `doc.place` (`{layer, scale, bounds}`),
  `doc.inspect`, `doc.render` (`{mime, base64}` or `{path, bytes}`),
  `doc.select`, `doc.close`, `doc.save`, `engine.execute`, `engine.commands`
  (bare array with `enabled`/`disabledReason`/`needsDocument`), `jobs.list`,
  `batch` (`{completed, failed, results}`, `stopOnError` default true,
  256-step cap, `nested batch` refused). One shared session across
  authenticated connections.
- Commands (ids verified against `crates/engine/src/commands.rs`):
  `layer.new.layer`, `layer.new.group`, `layer.delete`, `layer.setProps`,
  `layer.select`, `type.create`, `type.edit`, `edit.fill`,
  `layer.arrange.bringToFront`, `layer.arrange.sendToBack`, `edit.transform`,
  `layer.layerMask.revealAll`; anything else → `unknown command \`x\``.

## What is faked (on purpose)

- No pixels: `doc.render` always emits the same valid 8×8 gray PNG built in
  code (a client must not assume preview dimensions match the document).
- `doc.open` synthesizes a document from any relative path; it never reads files.
- `doc.save` writes a JSON state snapshot (`studio-mock-engine-snapshot`),
  not a real `.pcraft`; it still sets the document's path and clears `dirty`.
- Layers are the task model `{id, name, kind, text?, bounds, visible, opacity,
  fill}`; `fill` holds the last `edit.fill` color; `edit.transform` applies
  offset/scale only; history is a label list; `wait:false` runs synchronously
  and records an instantly-done job.
- `agent.begin`/`agent.commit`/`agent.rollback` are checkpoint markers for
  agent-transaction tests (not upstream engine commands).

## Spawning for integration tests

```js
const child = spawn(process.execPath, ["src/index.mjs"], {
  cwd: "apps/mock-engine",
  env: { ...process.env, MOCK_ENGINE_PORT: "0", MOCK_ENGINE_TOKEN: token,
         MOCK_ENGINE_WRITE_ROOT: tmpDir },
  stdio: ["ignore", "ignore", "pipe"],
});
// wait for stderr: "mock-engine: listening on 127.0.0.1:<port>"
// then send the first frame: {"id":"auth","method":"auth","params":{"token":token}}
// SIGTERM shuts down cleanly; MOCK_FAULT=crash-on-command exits with code 86.
```

Ad-hoc poking (token from stderr):

```sh
node src/index.mjs &   # prints "listening on 127.0.0.1:7800" + token
printf '%s\n' '{"id":"auth","method":"auth","params":{"token":"<hex>"}}' \
  '{"id":1,"method":"doc.new","params":{"width":64,"height":48}}' \
  '{"id":2,"method":"engine.execute","params":{"command":"layer.new.layer","params":{"name":"Ink"}}}' \
  '{"id":3,"method":"doc.render","params":{}}' | nc 127.0.0.1 7800
```

## Tests

`npm test` — i.e. `node --test tests/*.mjs` (directory positionals are not
reliable across Node versions; the glob is). The suite spawns the server on
an ephemeral port and asserts the auth reject, the required
`doc.new → engine.execute → doc.render` roundtrip, repeat-auth, unknown
method/command correlation, the `engine.commands` set, `batch` stop-on-error,
the 16-connection cap, and the crash fault. No npm test dependencies.
