# corpus-samples

Fixture policy for engine-client tests (W2-E). Task scope: copy 2–3 **small text**
fixtures from `vendor/photocraft-corpus` *if useful*, "skip if the files are huge;
prefer synthetic".

## Decision: nothing copied (all corpus files are binary PSDs)

`vendor/photocraft-corpus` holds real-file test oracles: binary `.psd` files made
in Adobe Photoshop (smallest sampled ≈ 53 KB, e.g. `photoshop/text/antialias-none.psd`;
directories total ≈ 28 MB). There are **no text fixtures** to copy, and committing
binary PSDs into this package would bloat the repo for no test value here — the
engine-client tests are protocol-shape tests (§21), not render-oracle tests.

Synthetic-only fixtures live in `../replies/` instead (recorded-style RPC replies,
hand-crafted against `vendor/photocraft/crates/automation/src/rpc.rs`,
`crates/engine/src/inspect.rs`, `crates/engine/src/commands.rs` and
`docs/control-protocol.md`). They contain no PII or customer content (§21 test-data
rule) and no font files (§1.5).

## Licensing notes (if oracle samples are ever added)

- The corpus is dual-licensed **MIT / Apache-2.0** (`vendor/photocraft-corpus/LICENSE-MIT`,
  `LICENSE-APACHE`, `NOTICE`). Copying a file in is license-compatible, but each copied
  file must get an `ATTRIBUTION.md` row in the same change (§1.5-9: path, title, author,
  source, license) and its SHA256 recorded from the corpus `SHA256SUMS`.
- **Not licensed:** the ArtCraft/PhotoCraft name, wordmark and logos in
  `vendor/photocraft-corpus/docs/brand/` are trademarks with their own terms
  (`docs/brand/LICENSE-brand.txt`). Never copy brand assets, and never use the
  PhotoCraft/ArtCraft/Photoshop names in product code (§1.5-1).

## Where oracle-style samples will come from later

- Golden renders per template@version for eval SSIM/DISTS comparisons are owned by the
  evals/fixtures policy (packages/evals, §11.4, W1-S README; W7 fills the assets).
- Render-oracle comparisons against the corpus belong in the engine repo's own test
  suite, which already consumes it; this SaaS repo only needs the control-protocol wire
  shapes, which `../replies/` pins.
