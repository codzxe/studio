// barrel.test.ts — W10-O TS1205 sweep gate for the @studio/engine-pool public
// barrel. src/index.ts is star-exports plus two `export type` lines (the
// AttachPlan collision disambiguation — already TS1205-clean at sweep time);
// this suite pins the fleet barrel contract for it:
//   1. every VALUE export still resolves from "../src/index.js";
//   2. the two type-only disambiguation names (AttachPlan /
//      RecoveryAttachPlan) stay usable in type positions and stay erased at
//      runtime (`import type` + a runtime call through a typed helper).
// Deterministic by construction: importing the barrel evaluates only module
// top-levels (schema constants, default thresholds) — no spawn, no engine.

import { describe, expect, expectTypeOf, it } from "vitest";
import * as pool from "../src/index.js";
import type { AttachPlan } from "../src/index.js";

/** Every key of the barrel namespace must be a defined runtime value. */
function expectNamespaceIsClean(): void {
  const keys = Object.keys(pool);
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) {
    expect(pool[key as keyof typeof pool], `undefined export: ${key}`).toBeDefined();
  }
  // Floor: 69 value exports at W10-O sweep time. A star-export collision
  // (silently dropped ambiguous name) shrinks the namespace and trips this.
  expect(keys.length).toBeGreaterThanOrEqual(69);
}

describe("W10-O barrel: value exports resolve from src/index.js", () => {
  it("imports cleanly with a fully-defined, duplicate-free namespace", () => {
    expectNamespaceIsClean();
  });

  it("supervisor/coordinator classes resolve (typeof function)", () => {
    const classes = [
      "EnginePool", // pool.ts §3.2 supervisor
      "SessionRegistry",
      "CheckpointManager", // checkpoint.ts §3.3
      "LocalCheckpointStorage",
      "RecoveryCoordinator", // recovery.ts §3.4
      "PhotocraftServeSpawner", // spawners (serve-config plan consumers)
      "PhotocraftServeProcess",
    ];
    for (const name of classes) {
      expect(typeof pool[name as keyof typeof pool], name).toBe("function");
    }
  });

  it("key helpers and constants resolve with their actual kinds", () => {
    expect(typeof pool.classifyCrash).toBe("function");
    expect(typeof pool.classifyHealthProbe).toBe("function");
    expect(typeof pool.buildServeSpawnPlan).toBe("function");
    expect(typeof pool.createLivenessRecorder).toBe("function");
    expect(pool.CHECKPOINT_ACTOR).toBe("system:engine-pool");
    expect(pool.ATTACH_PLANS).toEqual(["replay", "checkpoint"]);
    expect(pool.MAX_RESUME_ATTEMPTS_PER_RUN).toBe(1);
    expect(typeof pool.REFUND_HINT).toBe("string");
    expect(typeof pool.DEFAULT_HEALTH_THRESHOLDS).toBe("object");
  });
});

describe("W10-O barrel: type-only re-exports stay types (erased at runtime)", () => {
  it("the AttachPlan collision resolves as documented", () => {
    // attach.js's decision object keeps the canonical name; recovery.js's
    // "replay" | "checkpoint" strategy union rides aliased (barrel header).
    expectTypeOf<AttachPlan>().toEqualTypeOf<import("../src/attach.js").AttachPlan>();
    expectTypeOf<pool.RecoveryAttachPlan>().toEqualTypeOf<
      import("../src/recovery.js").AttachPlan
    >();
    // Prove the alias did not silently collapse onto the canonical shape.
    expectTypeOf<pool.RecoveryAttachPlan>().not.toEqualTypeOf<AttachPlan>();
  });

  it("type-only imports are usable at runtime-safe positions", () => {
    // The parameter is a compile-time-only position: importing AttachPlan as
    // a type must never surface a runtime binding of a type-only name.
    const pin = (_plan: AttachPlan | null): "null" | "plan" => (_plan === null ? "null" : "plan");
    expect(pin(null)).toBe("null");
  });
});
