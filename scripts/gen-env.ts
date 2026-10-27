#!/usr/bin/env node
// scripts/gen-env.ts — regenerate the repo-root `.env.example` from the single
// source of truth: @studio/config's ENV_VAR_SPECS (packages/config/src/env.ts,
// 34 vars). Never hand-edit .env.example — run `pnpm dev:env` instead.
//
// The generator renders every declared var with its purpose, requirement rule
// and secret flag (renderEnvExample), then applies the LOCAL dev defaults and
// extra notes from W2-e:
//   * loopback hosts on 127.0.0.1 (dev-postgres.sh / dev-valkey.sh / xtask web)
//   * S3_ENDPOINT blank → the gateway's filesystem driver (no MinIO needed)
//   * AUTH_SECRET documented as instructions (openssl), never a real literal
//
// Run it via scripts/gen-env.sh (resolves tsx via pnpm exec or pnpm dlx).
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderEnvExample } from "../packages/config/src/env.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const target = process.argv[2] ?? resolve(repoRoot, ".env.example");

/** Local dev defaults (override the spec's `example` placeholders). */
const LOCAL_DEFAULTS: Readonly<Record<string, string>> = {
  // Postgres 17 started by `pnpm dev:pg` (scripts/dev-postgres.sh).
  DATABASE_URL: "postgres://studio:studio@127.0.0.1:5432/studio",
  // Valkey 8 started by `scripts/dev-valkey.sh start` — optional (see note below).
  VALKEY_URL: "redis://127.0.0.1:6379",
  // Blank = the gateway's filesystem driver: local dev needs no MinIO.
  S3_ENDPOINT: "",
  // LiteLLM in a Python venv or infra/compose service, on loopback.
  LITELLM_BASE_URL: "http://127.0.0.1:4000",
  // `cargo xtask web --serve 8765` from editor/ (dev only; rejected in production).
  EDITOR_DEV_SERVER_URL: "http://127.0.0.1:8765",
};

/** Extra documentation lines injected right above a var's assignment. */
const EXTRA_NOTES: Readonly<Record<string, readonly string[]>> = {
  DATABASE_URL: [
    "# Local default: `pnpm dev:pg` starts portable PostgreSQL 17 at 127.0.0.1:5432",
    "# (user `studio`, password `studio`, database `studio`).",
    "# PG-free alternative: `pnpm dev:sqlite` maintains a SQLite file instead —",
    "# set DATABASE_URL=file:.local/studio-dev.db (APP_ENV=local only; rejected",
    "# in staging/production, which always require the PostgreSQL URL).",
  ],
  VALKEY_URL: [
    "# Local default: `scripts/dev-valkey.sh start` starts Valkey 8 at 127.0.0.1:6379.",
    "# To disable locally, set it blank (VALKEY_URL=) or comment the line out.",
  ],
  S3_ENDPOINT: [
    "# Local default: BLANK → the gateway's filesystem driver stores objects",
    "# under the repo (`.local/storage/`) — no MinIO needed for local dev.",
    "# Real object storage: set a MinIO/S3/R2 endpoint, e.g. http://127.0.0.1:9000",
    "# (compose: the `minio` service) and fill S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY.",
  ],
  AUTH_SECRET: [
    "# Local default: INSTRUCTIONS, never a literal secret in this template.",
    "#   Generate one and paste it into your .env:   openssl rand -base64 32",
    "#   (the generator prints a fresh suggestion to the terminal each run)",
  ],
  LITELLM_BASE_URL: [
    "# Local default: LiteLLM proxy on loopback — `bash scripts/dev-litellm.sh`",
    "# (repo-root docker-compose.litellm.yml), a venv (`litellm --config deploy/litellm/config.yaml`)",
    "# or the infra/compose `litellm` service. Runbook: docs/deploy/LITELLM.md.",
  ],
  LITELLM_MODEL_MAP: [
    "# Direct OpenAI-compatible provider (no LiteLLM proxy): point LITELLM_BASE_URL",
    "# at the hosted gateway and map the studio aliases to provider model ids.",
    "# Unset (the default) = aliases pass through to the proxy unchanged.",
    "# Token Harbor free-tier example — free variants of paid models need the",
    "# provider's `:free` suffix (bare ids route to the PAID model and 402 on a",
    "# zero balance); tool names are sanitized on the wire automatically:",
    '#   LITELLM_MODEL_MAP={"studio-fast":"deepseek-v4.1-flash:free","studio-smart":"th-rudder","studio-vision":"th-rudder"}',
  ],
  EDITOR_DEV_SERVER_URL: [
    "# Local default: `cargo xtask web --serve 8765` from editor/, proxied under the editor path.",
  ],
};

/** Replaces the generator's own short preamble with a fuller header. */
const HEADER = [
  "# ===========================================================================",
  "# Studio environment template — GENERATED FILE, do not edit by hand.",
  "#",
  "# Source of truth : packages/config/src/env.ts (ENV_VAR_SPECS — 34 vars).",
  "# Regenerate       : pnpm dev:env   (scripts/gen-env.sh → scripts/gen-env.ts)",
  "#",
  "# Copy to .env for local runs:   cp .env.example .env && chmod 600 .env",
  "# Startup fails fast on the FIRST invalid environment (EnvFatalError lists",
  "# every missing/invalid/rejected var with its purpose; secret VALUES are",
  "# never echoed). Blank values count as unset — schema defaults then apply.",
  "#",
  "# Secrets: never commit real values; every row marked “Secret — never commit”",
  "# must come from your shell, .env (chmod 0600) or a secret manager.",
  "#",
  "# Local defaults below assume the native dev services (no Docker, no sudo):",
  "#   pnpm dev:pg                        # PostgreSQL 17 @ 127.0.0.1:5432",
  "#   bash scripts/dev-valkey.sh start  # Valkey 8 @ 127.0.0.1:6379 (optional)",
  "#   bash scripts/dev-litellm.sh start  # LiteLLM proxy @ 127.0.0.1:4000 (Docker boxes; optional)",
  "#   pnpm editor:serve                 # editor dev server @ 127.0.0.1:8765",
  "# ===========================================================================",
  "",
];

/** Fresh, never-committed suggestion for AUTH_SECRET (printed to stdout only). */
const suggestedSecret = randomBytes(32).toString("base64");

function main(): void {
  const body = renderEnvExample();
  // Drop the generator's built-in preamble (first block of comment lines).
  const preambleEnd = body.indexOf("# ── app ──");
  if (preambleEnd < 0) {
    throw new Error("renderEnvExample() output does not contain the expected group header");
  }
  const lines = body.slice(preambleEnd).split("\n");
  const out: string[] = [...HEADER];
  for (const line of lines) {
    const match = /^(?<name>[A-Z][A-Z0-9_]+)=(?<value>.*)$/.exec(line);
    if (match?.groups?.name === undefined) {
      out.push(line);
      continue;
    }
    const { name } = match.groups;
    for (const note of EXTRA_NOTES[name] ?? []) {
      out.push(note);
    }
    const localValue = LOCAL_DEFAULTS[name];
    out.push(localValue === undefined ? line : `${name}=${localValue}`);
  }
  writeFileSync(target, `${out.join("\n")}\n`, { mode: 0o644 });
  // CLI output (stdout, not a log): report what happened + a fresh AUTH_SECRET
  // suggestion for the dev's local .env.
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  say(`wrote ${target} (${Object.keys(LOCAL_DEFAULTS).length} local default override(s) applied)`);
  say("Suggested AUTH_SECRET for your local .env (do NOT commit):");
  say(`  AUTH_SECRET=${suggestedSecret}`);
}

main();
