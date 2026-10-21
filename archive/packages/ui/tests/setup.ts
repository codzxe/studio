import "@testing-library/jest-dom/vitest";
// Vitest runs without global test hooks here, so RTL's auto-cleanup never fires —
// register it manually to keep `screen` queries isolated between tests.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
