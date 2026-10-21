# evals/scripts — fixture entrypoints

Thin, dependency-free entrypoints for the eval fixture program. Both are
pass-through wrappers (exit codes and flags are the underlying scripts').

| script | runs | does |
| --- | --- | --- |
| `generate-fixtures.sh` | `evals/fixtures/generator/src/generate-assets.mjs` | materializes the synthetic gradient PNGs from `evals/templates/*/assets-note.md` into `evals/fixtures/generated/<id>@<version>/` (deterministic, byte-identical across runs; ≤ 50 KB per file, enforced) |
| `render-goldens.sh` | `evals/fixtures/generator/src/render-golden.mjs` | STUB for the §11.4/§21 render-similarity goldens — skips gracefully (exit 0) until a render-faithful engine ships |

The eval gate itself (`eval-gate.mjs`) lives with the promptfoo suite in
`packages/evals/scripts/`, not here — this directory owns only fixture
generation. Provenance, spec convention and size caps:
`evals/fixtures/generator/README.md`.
