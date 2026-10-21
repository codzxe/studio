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
| `aws4fetch` (npm dependency of `packages/storage`; optional) | Minimal SigV4 client for AWS-compatible fetch APIs | mhart (Michael Hart) | https://github.com/mhart/aws4fetch | MIT (`LICENSES/LICENSE-MIT`) | `^1.0.20` (npm, pinned in `pnpm-lock.yaml`) |

Runtime dependencies (installed from the package manager) are pinned in `pnpm-lock.yaml`
and must pass the CI license allowlist: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0 (unmodified),
PostgreSQL. **Not allowed:** AGPL-3.0, SSPL, BUSL-1.1, RSALv2, Elastic, Sustainable Use.

## Infrastructure images (Docker)

Containers run unmodified upstream images (spec §16.0: copyleft/unmodified-utility rules;
countersigned in `licenses.overrides.json` rows with `kind: "infra"`). None of them is
linked into or shipped with product code — they are separately-run utilities on the box.

| Image (compose reference) | Project | Upstream | License | License text in repo |
|---|---|---|---|---|
| `postgres:16-alpine` | PostgreSQL server | https://github.com/postgres/postgres (image: docker-library/postgres) | PostgreSQL License | `LICENSES/LICENSE-POSTGRESQL` |
| `valkey/valkey:8-alpine` | Valkey — queue/cache (Redis ≥ 7.4 is forbidden, §16.5) | https://github.com/valkey-io/valkey | BSD-3-Clause | `LICENSES/LICENSE-BSD-3-CLAUSE` |
| `caddy:2-alpine` | TLS termination + reverse proxy | https://github.com/caddyserver/caddy | Apache-2.0 | `LICENSES/LICENSE-APACHE-2.0` |
| `louislam/uptime-kuma:latest` | Uptime + alerting (obs profile) | https://github.com/louislam/uptime-kuma | MIT | `LICENSES/LICENSE-MIT` |
| `glitchtip/glitchtip:latest` | Error tracking (Sentry-compatible; obs profile) | https://github.com/glitchtip/glitchtip | MIT | `LICENSES/LICENSE-MIT` |
| `prom/prometheus:latest` | Metrics hub (obs profile) | https://github.com/prometheus/prometheus | Apache-2.0 | `LICENSES/LICENSE-APACHE-2.0` |
| `prom/alertmanager:latest` | Alert routing stub (obs profile) | https://github.com/prometheus/alertmanager | Apache-2.0 | `LICENSES/LICENSE-APACHE-2.0` |
| `persesdev/perses:latest` | Dashboards — chosen over AGPL-3.0 Grafana (§16.5) | https://github.com/persesdev/perses | Apache-2.0 | `LICENSES/LICENSE-APACHE-2.0` |
| `node:22-alpine` | Base image of the five app Dockerfiles | https://github.com/nodejs/node (image: docker-library/node) | MIT | `LICENSES/LICENSE-MIT` |

Image-build toolchain (never at runtime): `pnpm` (MIT, corepack-pinned via the root
`packageManager` field) and `dumb-init` (Yelp, MIT, apk package used as PID 1). Base-image
userspace components (e.g. busybox, GPL-2.0 via Alpine) are unmodified internal utilities —
§16.0; analysis in `docs/legal/license-audit.md`.

## Fonts — no binaries committed (attestation)

No font binaries (`*.ttf`, `*.otf`, `*.ttc`, `*.woff`, `*.woff2`) are committed to this
repo, and none ever will be (spec §1.5 rule 9, ADR-0001, AGENTS.md "Forbidden"). Fonts are
consumed at build time from the pinned `vendor/craft-fonts` clone through `CRAFT_FONTS_DIR`,
under the terms of that repo's own `ATTRIBUTION.md`.
`scripts/check-licenses.mjs` enforces this on every run and on CI — **0 font binaries, 0
.env files committed** (re-verified 2026-10-21, task W10-I).

## Vendor pins — re-verified (W10-I, 2026-10-21)

All seven clones re-verified against `docs/adr/0001-editor-pin.md` and the live checkouts
(`git rev-parse HEAD` on each): **unchanged**.

| Repo | Pin (verified) |
|---|---|
| storytold/photocraft | `872748fb5b2a53e09dd4e385e31968d985c0515b` |
| storytold/craft-fonts | `bfcbf714e45a3ea8e98f88ab2b7971372a576414` |
| storytold/photocraft-corpus | `98c60c9d10883dda7c4a948109d28e5bcab5fc03` |
| storytold/craft-libs | `e36f1890186558e0a2195750e798d641f5983b0f` |
| mickasmt/next-saas-stripe-starter (reference) | `c6df229ae73c207e87356d5e592779c511a9b56d` |
| onwidget/astrowind (reference) | `14e1a691f80548dcc36370847b1a02c0d0b12821` |
| magicuidesign/magicui (reference) | `efe76fc5755eca1142dd4f74c1d6f0ace2887e3c` |

## Declared dependency licenses

Every external dependency of the root + `apps/*/` + `packages/*/` `package.json` files
is declared in [`licenses.overrides.json`](./licenses.overrides.json) (repo root, owned by
the license policy). `scripts/check-licenses.mjs` (`pnpm check:licenses`, spec §16.0/§16.5,
§1.5 rules 8–9) validates that manifest offline and fails on any forbidden license
(AGPL/SSPL/BUSL/RSALv2/Elastic/FSL/…) or undeclared dependency; it also fails the build if
font binaries or `.env` secret files are committed. As of W10-I (2026-10-21) every manifest
row is `declared` — all former `TODO-verify` entries were resolved against their known
upstream licenses (see `docs/legal/license-audit.md`); the `TODO-verify` mechanism stays
available for future unsure additions, and CI must still confirm declarations against
package metadata (`LICENSE_CHECK_STRICT=1` makes TODO-verify rows fatal). License texts live
in `LICENSES/`.
