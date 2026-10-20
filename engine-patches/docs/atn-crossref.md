# atn-crossref.md — the new commands vs. the Photoshop-action surface

Cross-reference for the 18 Wave-3 commands against the engine's Photoshop Actions
bridge, `vendor/photocraft/crates/engine/src/atn_cmds.rs` (the `.atn` import/export
module; parsing/writing live in `photocraft-psd`'s `atn` crate). Purpose: know which
of our commands a Photoshop action set can already express, which round-trip through
mapped primitives, and which are native editor features with no `.atn` analogue — the
question upstream will ask first.

## How `atn_cmds.rs` works (verified at the pin)

- The `EVENTS` table maps a Photoshop **event** onto PhotoCraft commands and back —
  bidirectional, so a step that was imported exports to the same event. Each event is
  keyed by both its four-character code (`GsnB`, older files) and its string name
  (`gaussianBlur`, Photoshop 2024+); the two are interchangeable in Photoshop.
- Mapped families relevant to us: `make` (`Mk `) for layer/group/adjustment creation,
  `set` (`setd`) for `layer.setProps` / `layer.fill.pattern.set` / selections,
  `select` (`slct`) for layer selection **and history states** (`edit.undo` /
  `edit.redo` — Photoshop records Undo as a select of the current history state,
  class `HstS`), `move`, `transform` (`Trnf` → `edit.transform`), `align` (`Algn` →
  `layer.align.*`), `fill` (`Fl ` → `edit.fill`), `placeEvent` (`Plc ` →
  `file.placeEmbedded` / `file.placeLinked`), `hide`/`show`, `duplicate`, `play`
  (`Ply ` → `actions.play`), `stop` (`Stop` → `actions.stopMessage`, Photoshop's
  Insert Stop), and the smart-object events (`newPlacedLayer` →
  `layer.smartObjects.convertToSmartObject`, `placedLayerEditContents` →
  `layer.smartObjects.editContents`, `updatePlacedLayer` →
  `layer.smartObjects.updateModifiedContent`).
- **Events outside the table become `actions.photoshopStep` steps** — kept verbatim
  (with the descriptor, base64) so `actions.save` writes them back unchanged; they
  fail at playback with the step's Photoshop name, so an action never silently skips
  work. Tool selections and other no-document-effect steps import switched off.
- **Two absences matter to us** (verified by grep over the pin): the table maps **no
  text/type events at all** — zero `type.*` command ids, no `textLayer`/`Tx` codes —
  and **no variables/data-set events** (`image.variables.*` / `image.applyDataSet` are
  absent). Photoshop text steps and data-set steps therefore import as
  `actions.photoshopStep`, and anything we build on those primitives is native as far
  as `.atn` round-tripping is concerned.

## The cross-reference

| New command | Photoshop-action analogue | Status | Notes |
|---|---|---|---|
| `layout.apply` | none as a unit; its **primitives are mapped** | mixed — native solver over mapped steps | the solver's moves commit as `layer.translate` (`move` event) and `edit.transform` (`Trnf`), plus `layer.align.*` (`Algn`) — an imported action could reproduce the *outcome* of a simple stack/row, but not express the declarative tree; the constraints model is native |
| `layout.fitText` | Photoshop text actions exist in `.atn`, but the engine maps **no text events** | **native** | type-layer steps import as `actions.photoshopStep` and fail at playback; `layout.fitText` is the deterministic fit (§9.3) over the engine's own text metrics, applied through `type.edit`/`type.setStyle` — also unmapped. Closest Photoshop behaviour is the manual shrink-to-fit the fit replaces |
| `layout.measure` | none | **native** | no `.atn` concept of measure-for-planning; same unmapped text-metric stack |
| `agent.begin` | closest: **action record** (`actions.record` in `actions_cmds.rs`) — a named marker from which steps collect; plus History-panel snapshots (`history_cmds`) | analogue, not an event | recording is panel state in both apps — no ATN event exists for it; our checkpoint is a real snapshot with a stable never-reused id, not a journal copy |
| `agent.commit` | closest: `actions.stop` (collects the journal since `actions.record` into one named action) | analogue | both collapse a recorded sequence into one named unit; ours collapses it into ONE undo entry (a history fold), keeping the run replayable by journal marker |
| `agent.rollback` | closest: **history-state select** — the `slct` event (`HstS` class) maps to `edit.undo`/`edit.redo` in `atn_cmds.rs`; engine-natively `history.selectSnapshot` | mapped at the primitive level | a Photoshop action "rolls back" by selecting an earlier history state; `agent.rollback` does the same with the transaction's own checkpoint and removes the run's redo states |
| `document.diff` | none | **native** | no `.atn` concept of a layer diff; feeds the UI diff and the "nothing was silently destroyed" validator (§5.6) over the same history states `agent.*` move |
| `template.list` / `template.inspect` / `template.apply` / `template.fill` / `template.validate` | none — Photoshop has no template system | **native** | closest Photoshop ideas are droplets + `file.automate.batch` (replay an action over files) — playback machinery, not structure; `template.fill` *compiles* to primitives of which several are mapped (`Plc ` place, `setd` props, `Trnf` transform, `Fl ` fill) while the text ones (`type.edit`/`type.setStyle`) are in the unmapped set |
| `component.list` / `.inspect` / `.place` / `.setVars` / `.updateInstance` / `.publish` | none — Photoshop has no component system | **native**, on mapped bones | §8.1's building blocks: smart-object sharing **is** mapped (`newPlacedLayer` / `placedLayerEditContents` / `updatePlacedLayer`), variables + data sets are **not**; layer comps (`layerComp.*`) are not part of any mapped event either — so instances round-trip through pixels, not through actions |

## Reading of the table

- **Native core, mapped extremities.** `template.*` and `component.*` are new
  concepts (no `.atn` analogue) but deliberately avoid inventing parallel machinery:
  they reuse smart objects, variables/data sets, layer comps, place and transform —
  so the parts of their behaviour that overlap Photoshop all sit on commands the
  bridge already knows (or, for text and data sets, on the same unmapped stack
  Photoshop itself records).
- **Text is the gap.** Nothing text-related round-trips today; `layout.fitText` /
  `layout.measure` and `template.fill`'s text slots inherit that gap by choice
  (reusing `type_cmds` metrics rather than adding a second text path). An upstream
  follow-up could map the Photoshop text events (`Tx ` make / `setd` on a text layer)
  into `type.*` — that is an upstream bridge decision, not a Wave-3 deliverable.
- **`agent.*` is the native form of a pattern Photoshop users know**: record → do
  work → stop-and-keep. The transaction commands give that pattern crash-safe
  replay (checkpoint + revision ids), one-undo semantics and an explicit rollback
  primitive; `document.diff` closes the loop for validation.
- **For upstream reviewers**: none of the 18 commands changes `atn_cmds.rs`; none
  needs a new EVENTS row to function. If the bridge later wants to round-trip our
  command ids, each row would follow the existing pattern (bidirectional event entry
  with `from`/`to` converters); nothing in the four modules blocks or predates it.
