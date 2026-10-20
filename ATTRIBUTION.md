# Attribution

Third-party code, fonts and assets used by this project. Every addition ships with a row
here in the same change (spec §1.5 rule 9). License texts live in `LICENSES/`.

| Path | Title | Author / Source | Upstream | License | Pin (shallow clone, 2026-10-20) |
|---|---|---|---|---|---|
| `/home/z/my-project/vendor/photocraft` (external clone; not shipped) | The editor/engine ("PhotoCraft" — project codename used internally only) | storytold | https://github.com/storytold/photocraft | MIT OR Apache-2.0 (`docs/brand/` assets excluded, never shipped) | `872748fb5b2a53e09dd4e385e31968d985c0515b` |
| `/home/z/my-project/vendor/craft-fonts` (external clone) | Fonts for the crafting apps | storytold | https://github.com/storytold/craft-fonts | per upstream `ATTRIBUTION.md` — font files never committed to this repo | `bfcbf714e45a3ea8e98f88ab2b7971372a576414` |
| `/home/z/my-project/vendor/photocraft-corpus` (external clone) | Engine test corpus | storytold | https://github.com/storytold/photocraft-corpus | MIT OR Apache-2.0 | `98c60c9d10883dda7c4a948109d28e5bcab5fc03` |
| `/home/z/my-project/vendor/craft-libs` (external clone) | Shared Rust crafting libs (engine patching reference) | storytold | https://github.com/storytold/craft-libs | per upstream repo license | `e36f1890186558e0a2195750e798d641f5983b0f` |
| `apps/web` reference patterns (Better Auth + Drizzle + Stripe) | Next SaaS Stripe Starter | mickasmt | https://github.com/mickasmt/next-saas-stripe-starter | MIT | `c6df229ae73c207e87356d5e592779c511a9b56d` |
| Marketing/landing reference | AstroWind | onwidget | https://github.com/onwidget/astrowind | MIT | `14e1a691f80548dcc36370847b1a02c0d0b12821` |
| UI animation reference | Magic UI | magicuidesign | https://github.com/magicuidesign/magicui | MIT | `efe76fc5755eca1142dd4f74c1d6f0ace2887e3c` |

Runtime dependencies (installed from the package manager) are pinned in `pnpm-lock.yaml`
and must pass the CI license allowlist: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0 (unmodified),
PostgreSQL. **Not allowed:** AGPL-3.0, SSPL, BUSL-1.1, RSALv2, Elastic, Sustainable Use.
