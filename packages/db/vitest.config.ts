import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // M8-A: the render job-queue tests use trusted-internal, workspace-free
    // operations (claimNext / requeueStale / listExpiredOutputs are GLOBAL
    // sweeps). Files run one at a time so those asserts stay deterministic —
    // a parallel file's queued render could otherwise be claimed mid-test.
    fileParallelism: false,
  },
});
