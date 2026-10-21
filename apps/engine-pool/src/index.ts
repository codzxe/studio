// @studio/engine-pool — public surface of the engine session supervisor (§3.2).
//
// W7-M barrel completion (W6-M flag: the worker consumed recovery/attach as
// MIRRORED structural contracts because they were not exported here). Every
// landed src/ module is now public: WAL slice/verify (wal.js, §5.6),
// RecoveryCoordinator (recovery.js, §3.4), CheckpointManager (checkpoint.js,
// §3.3), SessionAttach (attach.js, §3.2 attach leg), HealthMonitor (health.ts,
// §3.2 probes) and the spawners (serve-config plan + photocraft-serve).
// storage-adapter.js arrives via checkpoint.js's existing re-export.
//
// ONE cross-module collision, resolved explicitly below (explicit re-exports
// beat star exports in TypeScript and the ESM spec — the @studio/agent barrel
// precedent): recovery.js exports `AttachPlan` (the "replay" | "checkpoint"
// strategy choice passed to RecoverDeps) AND attach.js exports `AttachPlan`
// (the decision OBJECT that decideAttachPlan/executeAttachPlan produce).
// attach.js's object keeps the canonical name; recovery.js's strategy choice
// rides aliased as `RecoveryAttachPlan`.
export * from "./constants.js";
export * from "./errors.js";
export * from "./pool.js";
export * from "./registry.js";
export * from "./types.js";
export * from "./wal.js";
export * from "./recovery.js";
export * from "./checkpoint.js";
export * from "./attach.js";
export * from "./health.js";
export * from "./spawners/serve-config.js";
export * from "./spawners/photocraft-serve.js";

// AttachPlan collision (see header): the attach.js decision object stays
// canonical; recovery.js's strategy union rides under the alias.
export type { AttachPlan } from "./attach.js";
export type { AttachPlan as RecoveryAttachPlan } from "./recovery.js";
