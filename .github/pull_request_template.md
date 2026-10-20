<!--
W1-M — PR template (docs/AGENTS.md; spec §21, §16, §27).
Small PRs, one concern, and cite the BUILD_PROMPT.md section wherever the "why" matters.
CI (§17.3) runs lint, typecheck, unit tests and the license gate on every PR.
-->

## Summary

<!-- What changes and why. One paragraph max. -->

## Spec references

<!-- Required: every BUILD_PROMPT.md section this change implements or is constrained by,
     e.g. "§5.2 tier budgets", "§13.3 error envelopes", "§16.5 license denylist". -->

## Checklist

- [ ] **Tests** — added/updated; deterministic, no network, table-driven for pure logic (§21)
- [ ] **ADR** — decision recorded in `docs/adr/` if this picks a library, architecture or protocol (link the ADR)
- [ ] **Attribution** — `ATTRIBUTION.md` row (+ `LICENSES/` text) for every new dependency; license gate green (§16)
- [ ] **No secrets, no fonts** — no tokens/keys in code or docs; no font files committed (`CRAFT_FONTS_DIR`)
- [ ] **Vendor untouched** — no edits under `vendor/*`; engine changes are upstreamable new modules in `engine-patches/` (§16.1)

## Notes for reviewers

<!-- Anything non-obvious: risk, rollout, follow-ups. Delete if empty. -->
