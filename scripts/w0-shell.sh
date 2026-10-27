#!/usr/bin/env bash
# w0-shell.sh — create the studio monorepo shell (root configs + package shells)
set -euo pipefail
R=/home/z/my-project/studio
mkdir -p "$R"

cat > "$R/pnpm-workspace.yaml" << 'EOF'
packages:
  - "apps/*"
  - "packages/*"
EOF

cat > "$R/package.json" << 'EOF'
{
  "name": "studio",
  "private": true,
  "version": "0.1.0",
  "description": "Agentic design SaaS (codename studio, internal only)",
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "format": "biome check --write .",
    "check:licenses": "node scripts/check-licenses.mjs"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "turbo": "^2.3.3",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
EOF

cat > "$R/turbo.json" << 'EOF'
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "test": { "dependsOn": ["^build"] }
  }
}
EOF

cat > "$R/tsconfig.base.json" << 'EOF'
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true,
    "isolatedModules": true,
    "paths": {
      "@studio/config": ["./packages/config/src/index.ts"],
      "@studio/db": ["./packages/db/src/index.ts"],
      "@studio/engine-client": ["./packages/engine-client/src/index.ts"],
      "@studio/tools": ["./packages/tools/src/index.ts"],
      "@studio/agent": ["./packages/agent/src/index.ts"],
      "@studio/billing": ["./packages/billing/src/index.ts"],
      "@studio/ui": ["./packages/ui/src/index.ts"]
    }
  }
}
EOF

cat > "$R/biome.json" << 'EOF'
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error", "noConsole": "warn" },
      "style": { "noNonNullAssertion": "error" }
    }
  },
  "files": { "ignore": ["**/dist/**", "**/.next/**", "**/node_modules/**", "**/*.md"] }
}
EOF

echo "22" > "$R/.nvmrc"

cat > "$R/.editorconfig" << 'EOF'
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
EOF

mk_pkg () {
  mkdir -p "$R/$1/src"
  printf '%s\n' "$2" > "$R/$1/package.json"
}

mk_pkg "packages/config" '{
  "name": "@studio/config", "version": "0.1.0", "private": true, "type": "module",
  "main": "./src/index.ts", "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^3.24.1" },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}'

mk_pkg "packages/db" '{
  "name": "@studio/db", "version": "0.1.0", "private": true, "type": "module",
  "main": "./src/index.ts", "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@studio/config": "workspace:*", "drizzle-orm": "^0.38.3", "postgres": "^3.4.5", "zod": "^3.24.1"
  },
  "devDependencies": { "drizzle-kit": "^0.30.1" },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run",
    "db:generate": "drizzle-kit generate", "db:migrate": "drizzle-kit migrate" }
}'

mk_pkg "packages/engine-client" '{
  "name": "@studio/engine-client", "version": "0.1.0", "private": true, "type": "module",
  "main": "./src/index.ts", "exports": { ".": "./src/index.ts" },
  "dependencies": { "@studio/config": "workspace:*", "zod": "^3.24.1" },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}'

mk_pkg "packages/tools" '{
  "name": "@studio/tools", "version": "0.1.0", "private": true, "type": "module",
  "main": "./src/index.ts", "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@studio/config": "workspace:*", "@studio/db": "workspace:*",
    "@studio/engine-client": "workspace:*", "zod": "^3.24.1"
  },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}'

mk_pkg "packages/agent" '{
  "name": "@studio/agent", "version": "0.1.0", "private": true, "type": "module",
  "main": "./src/index.ts", "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "ai": "^4.3.4", "@studio/config": "workspace:*", "@studio/db": "workspace:*",
    "@studio/engine-client": "workspace:*", "@studio/tools": "workspace:*", "zod": "^3.24.1"
  },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}'

mk_pkg "packages/billing" '{
  "name": "@studio/billing", "version": "0.1.0", "private": true, "type": "module",
  "main": "./src/index.ts", "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@studio/config": "workspace:*", "@studio/db": "workspace:*", "zod": "^3.24.1"
  },
  "optionalDependencies": { "stripe": "^17.5.0" },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}'

mk_pkg "packages/evals" '{
  "name": "@studio/evals", "version": "0.1.0", "private": true, "type": "module",
  "devDependencies": { "promptfoo": "^0.103.0" },
  "scripts": { "typecheck": "tsc --noEmit", "eval": "promptfoo eval" }
}'

mk_pkg "packages/ui" '{
  "name": "@studio/ui", "version": "0.1.0", "private": true, "type": "module",
  "main": "./src/index.ts", "exports": { ".": "./src/index.ts" },
  "peerDependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "dependencies": {
    "@radix-ui/react-dialog": "^1.1.4", "@radix-ui/react-tabs": "^1.1.2",
    "class-variance-authority": "^0.7.1", "clsx": "^2.1.1", "lucide-react": "^0.469.0"
  },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}'

mk_pkg "apps/gateway" '{
  "name": "@studio/gateway", "version": "0.1.0", "private": true, "type": "module",
  "dependencies": {
    "@studio/billing": "workspace:*", "@studio/config": "workspace:*", "@studio/db": "workspace:*",
    "better-auth": "^1.1.20", "drizzle-orm": "^0.38.3", "hono": "^4.6.14",
    "@hono/zod-validator": "^0.4.2", "ioredis": "^5.4.2", "pino": "^9.6.0", "zod": "^3.24.1"
  },
  "optionalDependencies": { "stripe": "^17.5.0" },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}'

mk_pkg "apps/worker" '{
  "name": "@studio/worker", "version": "0.1.0", "private": true, "type": "module",
  "dependencies": {
    "@studio/agent": "workspace:*", "@studio/billing": "workspace:*", "@studio/config": "workspace:*",
    "@studio/db": "workspace:*", "@studio/engine-client": "workspace:*", "@studio/tools": "workspace:*",
    "ai": "^4.3.4", "bullmq": "^5.34.0", "ioredis": "^5.4.2", "pino": "^9.6.0", "zod": "^3.24.1"
  },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}'

mk_pkg "apps/engine-pool" '{
  "name": "@studio/engine-pool", "version": "0.1.0", "private": true, "type": "module",
  "dependencies": { "@studio/config": "workspace:*", "@studio/db": "workspace:*", "pino": "^9.6.0", "zod": "^3.24.1" },
  "scripts": { "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}'

mkdir -p "$R/apps/web" "$R/apps/web/src/app"
printf '%s\n' '{
  "name": "@studio/web", "version": "0.1.0", "private": true, "type": "module",
  "dependencies": {
    "@studio/config": "workspace:*", "@studio/ui": "workspace:*",
    "next": "^15.3.8", "react": "^19.0.0", "react-dom": "^19.0.0",
    "@tanstack/react-query": "^5.62.11", "zustand": "^5.0.2",
    "better-auth": "^1.1.20", "tailwindcss": "^4.0.0", "lucide-react": "^0.469.0"
  },
  "devDependencies": { "@types/react": "^19.0.2", "@types/react-dom": "^19.0.2", "typescript": "^5.7.2" },
  "scripts": { "dev": "next dev", "build": "next build", "typecheck": "tsc --noEmit", "lint": "biome check src", "test": "vitest run" }
}' > "$R/apps/web/package.json"

for p in packages/config packages/db packages/engine-client packages/tools packages/agent packages/billing packages/ui apps/gateway apps/worker apps/engine-pool; do
  printf '%s\n' '{
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "rootDir": "src", "outDir": "dist", "jsx": "preserve" },
    "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts"]
  }' > "$R/$p/tsconfig.json"
done

mkdir -p "$R/packages/db/src/schema"
cat > "$R/packages/db/src/index.ts" << 'EOF'
// @studio/db — Drizzle schema + client. Schema files are owned by individual
// build agents (see docs/AGENTS.md); this index assembles them.
export * from "./schema/auth.js";
export * from "./schema/content.js";
export * from "./schema/runs.js";
export * from "./schema/billing.js";
export * from "./schema/audit.js";
export * from "./client.js";
EOF

echo "SHELL DONE"
