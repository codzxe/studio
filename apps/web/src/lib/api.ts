// apps/web — typed gateway client shim (W1-K core; reorganized into
// src/lib/api/* modules by W8-O).
//
// The web app talks to the backend ONLY through src/lib/api/*: REST via the
// typed client (./api/client) and run progress via the SSE helper class
// (./api/sse) (spec §13; the gateway is a separate service — §3.1). Every
// non-2xx response is unwrapped from its typed `{ ok:false, code, message,
// hint, … }` envelope into a thrown `ApiError` — callers never inspect raw
// payloads.
//
// This file re-exports the SAME names from the new modules so every existing
// `@/lib/api` / `../../lib/api` import keeps working unchanged. Import
// extension-less (repo convention: tsconfig `moduleResolution: "bundler"` +
// Next/Vite resolution — `.js` specifiers would not rewrite to `.ts` there).
//
// NOT re-exported here: the react-query layer (./api/hooks — it pulls React,
// and this shim must stay importable from node-env unit tests and server
// components). Use `import { useApiQuery } from "@/lib/api/hooks"`.

export * from "./api/client";
export * from "./api/endpoints";
export * from "./api/sse";
export * from "./api/schema-mirror";
