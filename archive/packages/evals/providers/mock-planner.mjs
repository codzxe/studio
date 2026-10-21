// packages/evals/providers/mock-planner.mjs
//
// Deterministic mocked planner — the CI provider for the promptfoo suite (spec §11.4,
// §21 "Evals" row). It does NOT call a model: it answers each golden brief with the
// case's own `plan` + `run` fixtures wrapped in the {plan, run} envelope contract the
// suite asserts on. This exercises the whole assertion surface (schema validity, intent,
// tier credits, validator results, tool-call caps) with zero tokens, zero cost and no
// engine process — deterministic by construction (§21 "definition of a good test").
//
// Real-model wiring (Wave 6): swap this provider for the packages/agent AI-SDK planner
// (§5.3). Optional local real-model runs use paid API keys only — customer content must
// NEVER flow through free/training LLM tiers (§1.5 constraint 6) and no OpenRouter in
// production (AGENTS.md). See packages/evals/README.md for the override recipe.
//
// Export shape covers the loader conventions of the pinned promptfoo (^0.103): a named
// `callApi` export plus a default object carrying the same function.

/**
 * @param {string} prompt - the rendered prompt (planner.system.txt with vars applied)
 * @param {{ vars: Record<string, unknown> }} context - promptfoo call context
 * @returns {Promise<{ output: string, error?: string }>} provider response
 */
export async function callApi(prompt, context) {
  const vars = context?.vars ?? {};

  // Loud guard: a case without golden fixtures is a scaffold bug, never a silent pass.
  if (!vars.plan || !vars.run) {
    return {
      error:
        'mock-planner: case is missing golden `plan`/`run` vars — see packages/evals/README.md',
    };
  }

  // Guard that promptfoo actually rendered the brief into the prompt (wiring check for
  // the {{brief}} template variable in prompts/planner.system.txt).
  if (typeof vars.brief === 'string' && !String(prompt).includes(vars.brief)) {
    return {
      error: 'mock-planner: {{brief}} did not render into the prompt — check prompt vars',
    };
  }

  const envelope = { plan: vars.plan, run: vars.run };
  return {
    output: JSON.stringify(envelope),
    cost: 0, // mocked: no model spend (real runs are metered per §1.5 constraint 7)
    latencyMs: 0,
  };
}

export default { callApi };
