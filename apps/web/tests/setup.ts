// apps/web — Vitest setup (W8-T), runs once per test file before it imports.
//
// Conventions mirror packages/ui/tests/setup.ts: jest-dom matchers plus manual
// RTL cleanup (this suite runs without test.globals, so the auto-cleanup
// never fires on its own). Two web-app specifics are added:
//   - next/navigation mocked at the module boundary ("basics" only) so any
//     component importing router hooks resolves outside a Next runtime;
//   - a crypto.randomUUID guard: jsdom's crypto may lack randomUUID, and the
//     §13 Idempotency-Key mint needs it — Node's webcrypto is a drop-in.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

vi.mock("next/navigation", () => ({
  back: vi.fn(),
  forward: vi.fn(),
  notFound: vi.fn(),
  prefetch: () => Promise.resolve(),
  push: vi.fn(),
  redirect: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  useParams: () => ({}),
  usePathname: () => "/",
  useRouter: () => ({
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

if (typeof globalThis.crypto?.randomUUID !== "function") {
  vi.stubGlobal("crypto", webcrypto);
}
