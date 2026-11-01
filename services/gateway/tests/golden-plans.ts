// M5-M — the GOLDEN PROMPTS corpus (BUILD_PLAN §M5 task 8 + the exit
// criterion "At least 10 representative prompts apply successfully on the
// corpus project"; EDITOR_CHAT_UX §4 prompt taxonomy — questions, edits,
// multi-layer/agent edits, quick actions — and §5 context model).
//
// Each fixture is ONE representative user prompt plus everything needed to
// prove it end-to-end:
//   * `prompt`           — real user phrasing (ECUX §4.1/§4.3/§4.4 vocabulary)
//   * `userContext`      — the editor snapshot the context assembly sends
//                          (§5.1/§5.2: context flags, pinned chips, active
//                          comp, selection, playhead)
//   * `scriptedModelPlan`— the EditPlan JSON a well-behaved model returns for
//                          studio.plan_edit. REALISTIC BY CONSTRUCTION: intent
//                          per §8.6, plausible self-declared risk + credits
//                          (the server recomputes both), affectedLayers BY
//                          NAME (law #5), steps carrying tool + args per the
//                          CURATED write-tool schemas the model was offered
//                          on the provider wire (packages/contracts
//                          write-tools.ts — STRICT Zod, layers BY NAME), and
//                          the model's own ADVISORY per-step `batch` proposal
//                          (§8.6 shape; validated, never executed — the
//                          server-side translation wins, law #5).
//   * `expected`         — the compiled assertions against the REAL pipeline
//                          (services/gateway/src/plan-compiler.ts with
//                          defaultCompileDeps(): the REAL curated command
//                          registry + the REAL write-tool args schemas):
//                          which registry command ids appear, batch step
//                          count range, server-recomputed risk, credits per
//                          estimateCredits, layer-name resolution requests,
//                          warn codes, save_version annotation.
//
// ---------------------------------------------------------------------------
// FINDINGS this corpus surfaces (report-only — law #12: nothing outside the
// two M5-M files was changed; no tool was widened, per the orchestrator's
// tool-growth rule). The golden-prompts.test.ts suite PINS today's actual
// behavior, so the orchestrator's fixes flip these fixtures to full goldens
// without touching fixture data.
//
// G-1 (HIGH, seam) — write-tool ARGS-SHAPE DIVERGENCE between the curated
//   args schemas (M5-A, packages/contracts/src/write-tools.ts) and the
//   compiler's per-tool translation (M5-B, services/gateway/src/plan-compiler.ts
//   translate()):
//     set_properties: schema `{layers:[{name}], properties:[{path,value}]}`  vs
//                     compiler `{updates:[{layer,path,value}]}`
//     set_keyframes:  schema `{layers:[{name}], propertyPath, keys:[{timeSeconds,
//                     value, interpolation?}]}` vs compiler `{layer, propertyPath,
//                     keyframes:[{time, value, easing?}]}`
//     add_effect:     schema `{layers:[{name}], effect:{name}, params?}` vs
//                     compiler `{layer, effect: <string>, params?}`
//     apply_preset:   schema `{preset:{name}|{builtinId}, layers?, args?}` vs
//                     compiler `{preset: <string>, targets:[<string>]}`
//   Consequence (verified against the real pipeline): schema-valid model plans
//   for these four tools translate to ZERO commands ⇒ the compile answers a
//   typed `empty_batch` fatal ⇒ the plan event goes out UN-enriched (no
//   compiledBatch ⇒ Apply is gated) and write-tool proposals answer
//   PROPOSAL_INVALID. The failure is FAIL-CLOSED (never a partial or wrong
//   batch for single-tool plans) but it blocks 6 of the 10 required golden
//   scenarios today. Existing suites never caught this: plan-compiler.test.ts
//   injects fixture args schemas shaped like the compiler, litellm-runner
//   tests inject a stub compiler. Fix (one file, src/plan-compiler.ts):
//   translate() must read the write-tools.ts arg names (layers/properties,
//   layers/keys, layers+effect.name, preset.name|preset.builtinId+layers) —
//   including the set_properties cross-product (N layers × M properties).
//
// G-2 (MEDIUM, silent drop) — create_text typography: CREATE_TEXT_ARGS_SCHEMA
//   accepts font/style/size/fill/stroke/strokeWidth/tracking/leading/box, but
//   translate() reads `fontSize`/`fontFamily`/`color`/`compId` — none of which
//   the STRICT schema allows. Validated typography params are therefore
//   SILENTLY DROPPED from the compiled layer.newText (gp-06 pins the exact
//   reduced params: only text/name/position survive). Also comp targeting
//   (compId) is unexpressible. Fix belongs in translate() (read size/font/fill
//   + box/style/stroke* /tracking/leading passthrough per the engine's
//   layer.newText params).
//
// G-3 (HIGH, partial drop) — MIXED plans compile PARTIALLY: plan steps whose
//   tool args diverge (G-1) translate to zero commands with only WARN
//   severity, so a multi-step plan mixing an aligned tool and a divergent tool
//   returns ok:true with a batch that SILENTLY MISSING the divergent steps
//   (gp-11: "create text + animate + save" compiles to create-text only).
//   The plan card shows all 3 steps; the applied batch performs 1. This
//   violates the spirit of "a failed step never leaves a partial edit" —
//   recommend: zero-command steps in an otherwise-compilable plan should be
//   FATAL (or the plan should be rejected with a typed issue), not warn.
//
// G-4 (LOW, risk floors) — defaultCompileDeps() passes WRITE_TOOL_ARGS_SCHEMAS
//   (bare Zod objects, no risk metadata), so the write-tool catalog's risk
//   badges (medium for create_composition/add_effect/apply_preset/undo_run)
//   never reach the compiled risk — only the command-side rules apply
//   (delete-ish/render-ish/edit.undo|redo ⇒ medium). gp-07 pins it: the model
//   says medium, the wire carries low. Fix: defaultCompileDeps should project
//   WRITE_TOOLS as {args: inputSchema, risk} WriteToolDefs.
//
// G-5 (INFO, by design) — save_version is compile-time ANNOTATION ONLY; a
//   save_version-only plan is a pinned empty_batch fatal (apply needs a
//   batch), and the studio.save_version write-tool proposal likewise answers
//   PROPOSAL_INVALID — so the agent cannot produce a labeled snapshot without
//   also editing something. Every apply creates a version anyway (apply
//   route requires the uploaded version); save_version only labels it.
//   Documented as a product seam: "save a version of what I have now" needs
//   either a client-side action or a ruling.
//
// G-6 (MEDIUM, selection targeting) — APPLY_PRESET_ARGS_SCHEMA documents
//   "Omit layers to use the current selection", but the compiler's
//   selection-capture policy refuses to compile unnamed targets (gp-08: the
//   §4.4 quick action "Make it pop" answers empty_batch). The tool description
//   promises semantics the compiler deliberately refuses — needs an
//   orchestrator ruling (client resolves selection→names before compile, or a
//   typed "needs-selection" request rides the plan event).
//
// G-7 (MEDIUM, inexpressible edit) — RENAME: the engine has layer.rename (in
//   AGENT_COMMAND_IDS), but none of the 8 write tools maps to it; a realistic
//   "rename these layers" prompt (gp-05) can only be approximated by
//   set_properties with path "name" (→ prop.set, a different engine command
//   whose support for path "name" is unverified). Recorded per the mission:
//   do NOT widen the tools; the orchestrator rules on a rename surface.
//
// G-8 (INFO, wart) — resolutionRequests are minted from affectedLayers
//   NAMES too, not just batch layer sites: a plan that only CREATES a layer
//   (create_text) still emits a disambiguation request for the new layer's
//   declared name even though no batch step references it (no matching
//   placeholder — the client resolves an id nothing consumes). Pinned as-is
//   (gp-06/gp-10/gp-11); the M5-F resolver must tolerate orphan requests.
//
// Post-reconciliation goldens are already encoded per fixture in
// `expected.commands` — once G-1/G-2 land, flip `expected.compile` to
// "compiled" for the blocked fixtures and the suite becomes the acceptance
// test for the fix without any other edit.
//
// M5-S FLIP STATUS (wave-2 integrator fix landed — translate() now reads the
// LANDED M5-A shapes; see services/gateway/src/plan-compiler.ts):
//   G-1 FIXED — layers/properties, layers/keys+timeSeconds, layers+effect.name,
//     preset.{name|builtinId}+layers all translate (cross-products pinned).
//   G-2 FIXED — create_text typography reaches layer.newText 1:1 (gp-06).
//   G-3 FIXED — any zero-command step is a fatal empty_step; gp-11 now
//     compiles COMPLETE (create + 2 keyframes + save annotation).
//   G-4 FIXED — risk = max(command/tool floors, the model's DECLARED risk):
//     the wire never carries a lower badge than the model claimed (gp-07,
//     gp-03, gp-12 flip to the declared medium).
//   G-6 FIXED via D-21 — apply_preset with layers omitted targets the plan's
//     affectedLayers NAMES (never the live editor selection) — gp-08 compiles.
//   G-7 FIXED — set_properties path "name" → layer.rename (gp-05 pins it).
//   G-5 REMAINS (by design) — save_version is annotation-only; a
//     save-version-only plan is still the pinned empty_batch fatal.
//   G-8 REMAINS (INFO) — create-only plans still mint an orphan resolution
//     request for the declared new-layer name (gp-06/gp-10/gp-11); the M5-F
//     resolver must tolerate it.
// M5-R FLIP STATUS (F-S1/F-S2, wave-3):
//   F-S2 FIXED — defaultCompileDeps projects the WRITE_TOOLS catalog
//     ({args, risk} per tool), so the per-tool risk badges flow to the
//     recomputed risk on the live wire path. gp-08 flips low→medium (the
//     apply_preset badge floors the model's declared "low"); gp-03/gp-07/
//     gp-12 (declared medium) and gp-09 (edit.undo command floor) are
//     unchanged — a floor never lowers.
//   F-S1 FIXED — create_text fill/stroke compile BOTH COLOR_SCHEMA forms:
//     strings ride 1:1, [r,g,b(,a)] channel arrays convert to the engine's
//     canonical #hex form (never a silent drop, never a raw array — the
//     engine reads arrays RAW into its internal 0..1 space; see engineColor).
// ALL 12 fixtures now carry expected.compile = "compiled".
// ---------------------------------------------------------------------------

import type { ContextSelection, EditPlan, PinnedContextItem, PlanRisk } from "@studio/contracts";

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

/** The 10 required §M5-task-8 scenarios (+2 breadth scenarios). */
export type GoldenScenario =
  | "text-animation" // (a)
  | "color-change" // (b)
  | "effect-add" // (c)
  | "keyframes" // (d)
  | "multi-layer-edit" // (e)
  | "create-text-typography" // (f)
  | "create-composition" // (g)
  | "apply-preset" // (h)
  | "undo-run" // (i)
  | "save-version" // (j)
  | "compound-agent-edit" // (k) §4.3 multi-step agent mode
  | "quick-action"; // (l) §4.4 quick action chip

/** §5 context snapshot the client sends with the message (§5.1/§5.2). */
export interface GoldenUserContext {
  /** Active composition name (always in context, §5.1). */
  readonly activeComp: string;
  /** Selected layer NAMES, or null when nothing is selected. */
  readonly selection: readonly string[] | null;
  /** Playhead in seconds (always in context, §5.1). */
  readonly playheadSeconds: number;
  /** ContextSelection flags (the chat request's `context`, parsed shape). */
  readonly context: ContextSelection;
  /** Pinned context chips (§5.2: @mentions, attached selection/comp/…). */
  readonly pinned: readonly PinnedContextItem[];
}

export interface GoldenExpectation {
  /**
   * Today's REAL-pipeline outcome. "compiled" ⇒ the assertions below hold on
   * the compiled result now. "blocked" ⇒ the compile answers a TYPED FATAL
   * (fail-closed: no batch is produced at all) because of FINDING G-1/G-6 —
   * `commands` then carries the pinned POST-FIX golden for the fix.
   */
  readonly compile: "compiled" | "blocked";
  /** The exact fatal issue code asserted when `compile` is "blocked". */
  readonly fatalCode?: "empty_batch";
  /**
   * Registry command ids of the compiled batch, in order (the §M5.2 golden).
   * For blocked fixtures: the post-reconciliation golden per the compiler's
   * own translation table — every id is in AGENT_COMMAND_IDS (self-checked).
   */
  readonly commands: readonly string[];
  /** Inclusive [min, max] range on the compiled batch step count. */
  readonly batchStepRange: readonly [number, number];
  /** Server-RECOMPUTED risk carried on the plan event (never the model's). */
  readonly risk: PlanRisk;
  /** estimateCredits({ risk, steps: plan.steps }) — never the model's number. */
  readonly estimatedCredits: number;
  /** Layer NAMES needing client-side id resolution, in request order (§8.7). */
  readonly resolutionRequests: readonly string[];
  /** Expected WARN issue codes on a compiled result (subset match). */
  readonly warningCodes: readonly string[];
  /** Present when the plan carries a save_version annotation. */
  readonly saveVersionLabel?: string;
  /** Finding references explaining a non-golden expectation. */
  readonly findings: readonly string[];
}

export interface GoldenPromptFixture {
  readonly id: string;
  readonly scenario: GoldenScenario;
  /** Real user phrasing (§4 taxonomy; the goal the model passes to plan_edit). */
  readonly prompt: string;
  readonly userContext: GoldenUserContext;
  /** The EditPlan the scripted model returns (§8.6 shape, args per the
   * curated write-tool schemas, layer refs BY NAME, advisory batches). */
  readonly scriptedModelPlan: EditPlan;
  readonly expected: GoldenExpectation;
}

// ---------------------------------------------------------------------------
// Shared context builders (§5.1 defaults; per-fixture deltas on top)
// ---------------------------------------------------------------------------

function baseContext(overrides: Partial<ContextSelection> = {}): ContextSelection {
  return {
    projectSummary: true,
    activeComp: true,
    selection: false,
    playhead: true,
    focusedPanel: true,
    selectedProperties: false,
    currentFrame: false,
    recentCommands: false,
    comments: false,
    ...overrides,
  };
}

function selectionContext(): ContextSelection {
  return baseContext({ selection: true, selectedProperties: true });
}

/** A §8.6 plan step: curated write tool id + args + the model's ADVISORY
 * batch proposal (pseudo command ids = the bare tool id, per the M5-C write
 * tool carrier convention — never a real registry id, so the wire proofs can
 * assert the compiled registry ids NEVER enter the model conversation). */
function step(
  title: string,
  tool: string,
  args: unknown,
  proposedParams: Record<string, unknown>,
): EditPlan["steps"][number] {
  return {
    title,
    tool,
    args,
    batch: {
      label: title,
      steps: [{ command: tool.replace(/^studio\./, ""), params: proposedParams }],
    },
  };
}

// ---------------------------------------------------------------------------
// The corpus — 12 fixtures covering the 10 required scenarios + §4.3 agent
// multi-step + §4.4 quick action. Layer references are BY NAME everywhere.
// ---------------------------------------------------------------------------

export const GOLDEN_PROMPT_FIXTURES: readonly GoldenPromptFixture[] = [
  {
    id: "gp-01-animate-headline-scale",
    scenario: "text-animation",
    prompt: "Can you animate the headline scaling up from 80% to 110% across the first second?",
    userContext: {
      activeComp: "Main",
      selection: ["Headline"],
      playheadSeconds: 0,
      context: selectionContext(),
      pinned: [],
    },
    // The model returns §M5.1 set_keyframes args — layers BY NAME, time in
    // seconds (§5.4: "time is expressed in seconds for tool args").
    scriptedModelPlan: {
      intent: "animate",
      summary: "Animate Headline scale from 80% to 110% over 0–1 s",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [{ name: "Headline", change: "Scale keyframes 80% → 110% over 0–1 s" }],
      estimatedCredits: 1.5,
      steps: [
        step(
          "Scale keyframes on Headline",
          "studio.set_keyframes",
          {
            layers: [{ name: "Headline" }],
            propertyPath: "transform/scale",
            keys: [
              { timeSeconds: 0, value: 80, interpolation: "bezier" },
              { timeSeconds: 1, value: 110, interpolation: "bezier" },
            ],
          },
          { layerName: "Headline", property: "transform/scale", keyframeCount: 2 },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: compiles post-G-1-fix — one prop.addKey per key (1 layer ×
      // 2 keys, key-major order). The 2026-11-01 interpolation fix: both
      // bezier keys group into ONE exact keys.select (2 refs) + ONE
      // keys.interpolation — the easing now lands IN THE ENGINE instead of
      // warning as editor-side state.
      compile: "compiled",
      commands: ["prop.addKey", "prop.addKey", "keys.select", "keys.interpolation"],
      batchStepRange: [4, 4],
      risk: "low",
      estimatedCredits: 1.5,
      resolutionRequests: ["Headline"],
      warningCodes: ["unknown_command", "batch_mismatch"],
      findings: [],
    },
  },

  {
    id: "gp-02-recolor-backdrop",
    scenario: "color-change",
    prompt: "Change the backdrop rectangle's fill color to brand red, #E02D2D.",
    userContext: {
      activeComp: "Main",
      selection: ["Backdrop"],
      playheadSeconds: 2.4,
      context: selectionContext(),
      pinned: [],
    },
    scriptedModelPlan: {
      intent: "style",
      summary: "Set the Backdrop layer's fill color to #E02D2D",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [{ name: "Backdrop", change: "Fill color → #E02D2D" }],
      estimatedCredits: 1.5,
      steps: [
        step(
          "Set fill color",
          "studio.set_properties",
          {
            layers: [{ name: "Backdrop" }],
            properties: [{ path: "fill/color", value: "#E02D2D" }],
          },
          { layerName: "Backdrop", property: "fill/color", value: "#E02D2D" },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: compiles post-G-1-fix — the cross-product of 1 layer × 1
      // property ⇒ one prop.set; the name stays in the batch (§8.7).
      compile: "compiled",
      commands: ["prop.set"],
      batchStepRange: [1, 1],
      risk: "low",
      estimatedCredits: 1.5,
      resolutionRequests: ["Backdrop"],
      warningCodes: ["unknown_command", "batch_mismatch"],
      findings: [],
    },
  },

  {
    id: "gp-03-blur-logo",
    scenario: "effect-add",
    prompt: "Add a soft Gaussian blur to the Logo layer.",
    userContext: {
      activeComp: "Main",
      selection: ["Logo"],
      playheadSeconds: 0,
      context: selectionContext(),
      pinned: [],
    },
    scriptedModelPlan: {
      intent: "style",
      summary: "Apply a Gaussian Blur effect to Logo (radius 8)",
      risk: "medium",
      requiresApproval: false,
      affectedLayers: [{ name: "Logo", change: "Add Gaussian Blur (radius 8)" }],
      estimatedCredits: 2.5,
      steps: [
        step(
          "Blur the logo",
          "studio.add_effect",
          {
            layers: [{ name: "Logo" }],
            effect: { name: "Gaussian Blur" },
            params: { radius: 8 },
          },
          { layerName: "Logo", effectName: "Gaussian Blur" },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: compiles post-G-1-fix — effect.apply {effect:"Gaussian
      // Blur", layers:["Logo"]}; the effect `params` stay editor-side state
      // (radius → uncompilable_arg warn). G-4: the model declared medium and
      // the declared risk is a floor — the wire carries medium (never lower).
      compile: "compiled",
      commands: ["effect.apply"],
      batchStepRange: [1, 1],
      risk: "medium",
      estimatedCredits: 1.88,
      resolutionRequests: ["Logo"],
      warningCodes: ["uncompilable_arg", "unknown_command", "batch_mismatch"],
      findings: [],
    },
  },

  {
    id: "gp-04-position-keyframe",
    scenario: "keyframes",
    prompt: "Drop a position keyframe on Subtitle at 2 seconds so it sits at frame center.",
    userContext: {
      activeComp: "Main",
      selection: ["Subtitle"],
      playheadSeconds: 2,
      context: selectionContext(),
      pinned: [],
    },
    scriptedModelPlan: {
      intent: "animate",
      summary: "Add a transform/position keyframe to Subtitle at 2 s",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [{ name: "Subtitle", change: "Position keyframe [960, 540, 0] at 2 s" }],
      estimatedCredits: 1.5,
      steps: [
        step(
          "Position keyframe at 2 s",
          "studio.set_keyframes",
          {
            layers: [{ name: "Subtitle" }],
            propertyPath: "transform/position",
            keys: [{ timeSeconds: 2, value: [960, 540, 0] }],
          },
          { layerName: "Subtitle", property: "transform/position", timeSeconds: 2 },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: compiles post-G-1-fix — timeSeconds → time; the key lands
      // as one prop.addKey with the layer NAME in the batch.
      compile: "compiled",
      commands: ["prop.addKey"],
      batchStepRange: [1, 1],
      risk: "low",
      estimatedCredits: 1.5,
      resolutionRequests: ["Subtitle"],
      warningCodes: ["unknown_command", "batch_mismatch"],
      findings: [],
    },
  },

  {
    id: "gp-05-multilayer-rename-restyle",
    scenario: "multi-layer-edit",
    prompt:
      "Rename these three layers to their final names — Headline→Title, Sub→Subtitle, " +
      "Byline→Tagline — and drop their opacity to 40%.",
    userContext: {
      activeComp: "Main",
      selection: ["Headline", "Sub", "Byline"],
      playheadSeconds: 0,
      context: selectionContext(),
      pinned: [{ kind: "selection", label: "Headline, Sub, Byline" }],
    },
    // §M5.1 set_properties semantics: N named layers × M property updates.
    scriptedModelPlan: {
      intent: "organize",
      summary: "Rename Headline/Sub/Byline to Title/Subtitle/Tagline and set opacity to 40",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [
        { name: "Headline", change: "Rename to Title; opacity 40" },
        { name: "Sub", change: "Rename to Subtitle; opacity 40" },
        { name: "Byline", change: "Rename to Tagline; opacity 40" },
      ],
      estimatedCredits: 3,
      steps: [
        step(
          "Rename and restyle the three layers",
          "studio.set_properties",
          {
            layers: [{ name: "Headline" }, { name: "Sub" }, { name: "Byline" }],
            properties: [
              { path: "name", value: "Title" },
              { path: "transform/opacity", value: 40 },
            ],
          },
          { layerNames: ["Headline", "Sub", "Byline"], updates: 6 },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: compiles post-G-1/G-7-fix — the set_properties
      // cross-product: 3 layers × 2 properties ⇒ the path:"name" renames map
      // to layer.rename (G-7) and the opacity updates to prop.set, 6 commands
      // total (property-major order).
      compile: "compiled",
      commands: [
        "layer.rename",
        "layer.rename",
        "layer.rename",
        "prop.set",
        "prop.set",
        "prop.set",
      ],
      batchStepRange: [6, 6],
      risk: "low",
      estimatedCredits: 1.5,
      resolutionRequests: ["Headline", "Sub", "Byline"],
      warningCodes: ["unknown_command", "batch_mismatch"],
      findings: [],
    },
  },

  {
    id: "gp-06-create-text-typography",
    scenario: "create-text-typography",
    prompt:
      'Add a title that says "Studio Launch" — Inter, 96 points, warm white #F5F1E8, ' +
      "centered in the comp.",
    userContext: {
      activeComp: "Main",
      selection: null,
      playheadSeconds: 0,
      context: baseContext(),
      pinned: [],
    },
    scriptedModelPlan: {
      intent: "create",
      summary: 'Add a centered "Studio Launch" title layer (Inter, 96 pt, #F5F1E8)',
      risk: "low",
      requiresApproval: false,
      affectedLayers: [{ name: "Launch Title", change: "New text layer with typography set" }],
      estimatedCredits: 1.5,
      steps: [
        step(
          "Create the launch title",
          "studio.create_text",
          {
            text: "Studio Launch",
            name: "Launch Title",
            position: [960, 540],
            font: "Inter",
            size: 96,
            fill: "#F5F1E8",
          },
          { text: "Studio Launch", name: "Launch Title" },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: G-2 is FIXED — the validated typography (font/size/fill)
      // now reaches the compiled layer.newText 1:1 (pinned in the deep test).
      // G-8 REMAINS: the declared new-layer name still mints a resolution
      // request (lr-1) even though no batch step references it.
      compile: "compiled",
      commands: ["layer.newText"],
      batchStepRange: [1, 1],
      risk: "low",
      estimatedCredits: 1.5,
      resolutionRequests: ["Launch Title"],
      warningCodes: ["unknown_command", "batch_mismatch"],
      findings: ["G-8"],
    },
  },

  {
    id: "gp-07-create-comp",
    scenario: "create-composition",
    prompt: 'Create a 1080p comp called "Outro Stinger", 5 seconds long at 30 fps.',
    userContext: {
      activeComp: "Main",
      selection: null,
      playheadSeconds: 12,
      context: baseContext(),
      pinned: [],
    },
    scriptedModelPlan: {
      intent: "create",
      summary: 'Create composition "Outro Stinger" (1920×1080, 30 fps, 5 s)',
      risk: "medium",
      requiresApproval: false,
      affectedLayers: [],
      estimatedCredits: 2,
      steps: [
        step(
          "Create the outro comp",
          "studio.create_composition",
          { name: "Outro Stinger", width: 1920, height: 1080, frameRate: 30, durationSeconds: 5 },
          { name: "Outro Stinger", width: 1920, height: 1080, fps: 30, durationSeconds: 5 },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: G-4 is FIXED — the model declared medium and the declared
      // risk is a FLOOR: the wire carries medium (the recompute may raise it
      // but NEVER lower it — the plan card must never understate).
      // durationSeconds → duration stays the one mapped param name.
      compile: "compiled",
      commands: ["comp.new"],
      batchStepRange: [1, 1],
      risk: "medium",
      estimatedCredits: 1.88,
      resolutionRequests: [],
      warningCodes: ["unknown_command", "batch_mismatch"],
      findings: [],
    },
  },

  {
    id: "gp-08-quick-action-pop",
    scenario: "apply-preset",
    prompt: "Make it pop.",
    userContext: {
      activeComp: "Main",
      selection: ["Headline"],
      playheadSeconds: 0,
      context: selectionContext(),
      pinned: [],
    },
    // §4.4 quick action chip → the model applies the preset to the CURRENT
    // SELECTION: APPLY_PRESET_ARGS_SCHEMA says "Omit layers to use the current
    // selection", so a well-behaved model omits them.
    scriptedModelPlan: {
      intent: "animate",
      summary: "Apply the pop-in preset to the current selection (Headline)",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [{ name: "Headline", change: "Pop-in preset" }],
      estimatedCredits: 1.5,
      steps: [
        step(
          "Pop the selection",
          "studio.apply_preset",
          { preset: { builtinId: "pop-in" } },
          { presetId: "pop-in", useSelection: true },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: G-6 is RESOLVED via the D-21 ruling — apply_preset with
      // layers omitted targets the plan's affectedLayers NAMES (never the
      // live editor selection, which the compiler refuses to capture): the
      // "Make it pop" quick action now compiles against Headline.
      // M5-R FLIP (F-S2): defaultCompileDeps now projects the WRITE_TOOLS
      // catalog, so apply_preset's MEDIUM risk badge reaches the recomputed
      // risk — the model's declared "low" is floored up to "medium" (the
      // card never understates) and the credits follow the medium multiplier.
      compile: "compiled",
      commands: ["anim.applyBuiltinPreset"],
      batchStepRange: [1, 1],
      risk: "medium",
      estimatedCredits: 1.88,
      resolutionRequests: ["Headline"],
      warningCodes: ["unknown_command", "batch_mismatch"],
      findings: [],
    },
  },

  {
    id: "gp-09-undo-previous-run",
    scenario: "undo-run",
    prompt: "Actually, undo that last change you made.",
    userContext: {
      activeComp: "Main",
      selection: null,
      playheadSeconds: 0,
      context: baseContext({ recentCommands: true }),
      pinned: [],
    },
    // undo_run takes NO args (law #6: the run applied as ONE atomic batch, so
    // it undoes as one). The model honestly guesses low risk / 12 credits;
    // the server recomputes BOTH (edit.undo ⇒ medium risk).
    scriptedModelPlan: {
      intent: "organize",
      summary: "Undo the most recent applied agent run",
      risk: "low",
      requiresApproval: false,
      affectedLayers: [],
      estimatedCredits: 12,
      steps: [step("Undo the last agent run", "studio.undo_run", {}, {})],
    },
    expected: {
      // COMPILES today. The recompute proof: model risk low → wire risk
      // medium (edit.undo is a HISTORY_COMMAND); model credits 12 → wire
      // credits 1.88 ((1 + 1×0.5) × 1.25, rounded to 2 decimals).
      compile: "compiled",
      commands: ["edit.undo"],
      batchStepRange: [1, 1],
      risk: "medium",
      estimatedCredits: 1.88,
      resolutionRequests: [],
      warningCodes: ["unknown_command", "batch_mismatch"],
      findings: [],
    },
  },

  {
    id: "gp-10-save-labeled-version",
    scenario: "save-version",
    prompt:
      'Add a small "DRAFT" watermark tag in the top-right corner and save the result as a ' +
      'version named "Draft stamp".',
    userContext: {
      activeComp: "Main",
      selection: null,
      playheadSeconds: 0,
      context: baseContext(),
      pinned: [],
    },
    // G-5: save_version is an ANNOTATION — the version label rides the apply
    // of the run's batch; a save_version-only plan is a pinned empty_batch
    // fatal, so realistic plans pair the label with a real edit.
    scriptedModelPlan: {
      intent: "create",
      summary: 'Add a DRAFT watermark tag and save a version labeled "Draft stamp"',
      risk: "low",
      requiresApproval: false,
      affectedLayers: [{ name: "DRAFT Watermark", change: "New watermark text layer" }],
      estimatedCredits: 2,
      steps: [
        step(
          "Create the watermark tag",
          "studio.create_text",
          {
            text: "DRAFT",
            name: "DRAFT Watermark",
            position: [1800, 100],
            font: "Inter",
            size: 24,
            fill: "#8A8F98",
          },
          { text: "DRAFT", name: "DRAFT Watermark" },
        ),
        step(
          "Save a labeled version",
          "studio.save_version",
          { label: "Draft stamp" },
          {
            label: "Draft stamp",
          },
        ),
      ],
    },
    expected: {
      // COMPILES today: one layer.newText command + the save_version
      // ANNOTATION (never a batch step — apply needs an executable batch).
      compile: "compiled",
      commands: ["layer.newText"],
      batchStepRange: [1, 1],
      risk: "low",
      // estimateCredits counts PLAN steps (2), not compiled commands (1).
      estimatedCredits: 2,
      resolutionRequests: ["DRAFT Watermark"],
      warningCodes: ["unknown_command", "batch_mismatch"],
      saveVersionLabel: "Draft stamp",
      findings: ["G-5", "G-8"], // G-2 fixed (typography lands); G-5 annotation-only + G-8 orphan request remain
    },
  },

  {
    id: "gp-11-lower-third-compound",
    scenario: "compound-agent-edit",
    prompt:
      "Build a lower third for the speaker — title text sliding in from the left over 0.6 s — " +
      'then save it as version "Lower third v1".',
    userContext: {
      activeComp: "Main",
      selection: null,
      playheadSeconds: 0,
      context: baseContext(),
      pinned: [],
    },
    // §4.3 agent mode: a multi-step plan (create + animate + save) that must
    // land as ONE atomic batch (law #6).
    scriptedModelPlan: {
      intent: "create",
      summary: 'Build the speaker lower third and save version "Lower third v1"',
      risk: "low",
      requiresApproval: false,
      affectedLayers: [
        { name: "Speaker Lower Third", change: "New text layer, slide-in over 0.6 s" },
      ],
      estimatedCredits: 2.5,
      steps: [
        step(
          "Create the lower-third text",
          "studio.create_text",
          {
            text: "Ada Lovelace — Chief Engineer",
            name: "Speaker Lower Third",
            position: [120, 940],
            font: "Inter",
            size: 36,
            fill: "#F5F7FA",
          },
          { text: "Ada Lovelace — Chief Engineer", name: "Speaker Lower Third" },
        ),
        step(
          "Slide in from the left",
          "studio.set_keyframes",
          {
            layers: [{ name: "Speaker Lower Third" }],
            propertyPath: "transform/position",
            keys: [
              // The eased spellings a real model writes for a slide-in
              // (the 2026-11-01 Google-launch vocabulary) — they must ride
              // the wire carrier and compile to the Easy Ease commands.
              { timeSeconds: 0, value: [-400, 940], interpolation: "easeOut" },
              { timeSeconds: 0.6, value: [120, 940], interpolation: "easeIn" },
            ],
          },
          { layerName: "Speaker Lower Third", property: "transform/position", keyframeCount: 2 },
        ),
        step(
          "Save the version",
          "studio.save_version",
          { label: "Lower third v1" },
          {
            label: "Lower third v1",
          },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: G-3 is FIXED — every step of the compound plan compiles:
      // the create_text typography lands 1:1, the slide-in keyframes compile
      // (2 × prop.addKey, key-major) and — since the 2026-11-01 interpolation
      // fix — the eased keys compile their interpolation pass too (keys.select
      // + keys.easyEase per value). save_version stays the ANNOTATION. What
      // the card shows (3 steps) is what the batch performs. G-8 REMAINS: the
      // orphan request for the created layer.
      compile: "compiled",
      commands: [
        "layer.newText",
        "prop.addKey",
        "prop.addKey",
        "keys.select",
        "keys.easyEase",
        "keys.select",
        "keys.easyEase",
      ],
      batchStepRange: [7, 7],
      risk: "low",
      // 3 plan steps ⇒ (1 + 3×0.5) × 1 — the annotation step still counts.
      estimatedCredits: 2.5,
      resolutionRequests: ["Speaker Lower Third"],
      warningCodes: ["unknown_command", "batch_mismatch"],
      saveVersionLabel: "Lower third v1",
      findings: ["G-8"],
    },
  },

  {
    id: "gp-12-preset-named-layers",
    scenario: "apply-preset",
    prompt: "Give the Headline and Sub layers a subtle fade-in.",
    userContext: {
      activeComp: "Main",
      selection: ["Headline", "Sub"],
      playheadSeconds: 0,
      context: selectionContext(),
      pinned: [{ kind: "selection", label: "Headline, Sub" }],
    },
    scriptedModelPlan: {
      intent: "animate",
      summary: "Apply the Fade In preset to Headline and Sub",
      risk: "medium",
      requiresApproval: false,
      affectedLayers: [
        { name: "Headline", change: "Fade In preset" },
        { name: "Sub", change: "Fade In preset" },
      ],
      estimatedCredits: 2,
      steps: [
        step(
          "Fade both layers in",
          "studio.apply_preset",
          {
            preset: { name: "Fade In" },
            layers: [{ name: "Headline" }, { name: "Sub" }],
          },
          { presetName: "Fade In", layerNames: ["Headline", "Sub"] },
        ),
      ],
    },
    expected: {
      // M5-S FLIP: compiles post-G-1-fix — anim.applyBuiltinPreset
      // {preset:"Fade In", layers:["Headline","Sub"]}. G-4: the model declared
      // medium and the declared risk is a floor — the wire carries medium.
      // apply_preset NEVER compiles to anim.applyPreset (filesystem paths are
      // law #5 poison; pinned by M5-B).
      compile: "compiled",
      commands: ["anim.applyBuiltinPreset"],
      batchStepRange: [1, 1],
      risk: "medium",
      estimatedCredits: 1.88,
      resolutionRequests: ["Headline", "Sub"],
      warningCodes: ["unknown_command", "batch_mismatch"],
      findings: [],
    },
  },
];

/** The 10 required §M5-task-8 scenarios, for the self-check coverage test. */
export const REQUIRED_SCENARIOS: readonly GoldenScenario[] = [
  "text-animation",
  "color-change",
  "effect-add",
  "keyframes",
  "multi-layer-edit",
  "create-text-typography",
  "create-composition",
  "apply-preset",
  "undo-run",
  "save-version",
];
