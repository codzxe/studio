// packages/evals/providers/mock-chat-edit.mjs
//
// Deterministic mocked chat-edit classifier — the CI provider for the §23.5
// curated set in cases/chat-edits/ (promptfoo.chat-edit.config.yaml, §19 Phase 2
// "chat edits correct >= 90% on the curated set"). It does NOT call a model: it
// answers each case with the case's own golden `classification` fixture, so the
// whole assertion surface (strict 5-key classification contract, action atom
// sets, never-invented target layers, resolved-tier credits §14.1, reapply flag)
// runs with zero tokens, zero cost and no engine process — deterministic by
// construction (§21 "definition of a good test"; §1.5-6: no free-tier surface).
// Same pattern as providers/mock-planner.mjs (W10-P final-review pass).
//
// Real-model wiring (Wave 6/7): swap this provider for a wrapper around
// ChatEditClassifier from @studio/agent that emits the classification JSON with
// cost_tier = the RESOLVED tier (post resolveCostTier — the cheapest-action
// guard §23.5), which is what the run charges (§14.1). That is what gives the
// downgrade traps their production-faithful teeth: a raw-proposal provider that
// never downgrades fails cases 18–20 either way. See cases/chat-edits/README.md.
//
// Export shape covers the loader conventions of the pinned promptfoo (^0.103): a
// named `callApi` export plus a default object carrying the same function.

/**
 * @param {string} prompt - the rendered prompt (chat-edit-classifier.system.txt
 *                         with vars applied)
 * @param {{ vars: Record<string, unknown> }} context - promptfoo call context
 * @returns {Promise<{ output: string, error?: string }>} provider response
 */
export async function callApi(prompt, context) {
  const vars = context?.vars ?? {};

  // Loud guard: a case without a golden classification is a scaffold bug, never a
  // silent pass.
  if (!vars.classification) {
    return {
      error:
        'mock-chat-edit: case is missing the golden `classification` var — see cases/chat-edits/README.md',
    };
  }

  // Guard that promptfoo actually rendered the user request into the prompt
  // (wiring check for the {{userRequest}} template variable).
  if (typeof vars.userRequest === 'string' && !String(prompt).includes(vars.userRequest)) {
    return {
      error: 'mock-chat-edit: {{userRequest}} did not render into the prompt — check prompt vars',
    };
  }

  return {
    output: JSON.stringify(vars.classification),
    cost: 0, // mocked: no model spend
    latencyMs: 0,
  };
}

export default { callApi };
