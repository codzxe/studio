// @studio/engine-client — public barrel. Owner: W2-D (src/{commands,index}.ts).
//
// Re-exports the whole package surface per the module map:
//   transport/ (W2-A: connection, socket, frame), auth/capabilities/budgets (W2-B),
//   methods/ (W2-C: protocol, document, render-save, engine-commands, export-data),
//   errors/retry/client (W2-D facade), commands (W2-D §2.2 registry).
//
// Star-export collisions (two modules declaring the same name) are resolved by
// explicit re-exports below — in ES module semantics an explicit export always
// shadows an ambiguous star export, so the listed names stay unambiguous and the
// losing side keeps its name available under a renamed alias:
//   - AUTH_METHOD / CONTROL_TOKEN_HEX_LENGTH: auth.ts and transport/frame.ts both
//     declare them (auth.ts is the semantic home of credential shape; frame.ts's
//     copies are the wire-side mirrors — same values: "auth" and 64).
//   - MAX_REQUEST_BYTES / MAX_BATCH_STEPS / RequestId: transport/frame.ts and
//     methods/protocol.ts mirror the same security.rs constants/types; the
//     transport's (enforcement site) is the default, the methods-side RequestId is
//     aliased.
//   - WireReply: transport/connection.ts's (the correlated reply of one exchange:
//     {ok:true,result} | {ok:false,wireError}) is the default; methods/protocol.ts's
//     full wire envelope type is aliased as ProtocolWireReply ({id,ok,result|error}).
//
// package.json main/exports point here; contract.test.ts drives EngineClient through
// this barrel, so the seam must stay: `new EngineClient({ connect })` + `call()`.

export * from "./transport/connection.js";
export * from "./transport/socket.js";
export * from "./transport/frame.js";
export * from "./auth.js";
export * from "./capabilities.js";
export * from "./budgets.js";
export * from "./errors.js";
export * from "./retry.js";
export * from "./client.js";
export * from "./commands.js";
export * from "./methods/protocol.js";
export * from "./methods/document.js";
export * from "./methods/render-save.js";
export * from "./methods/engine-commands.js";
export * from "./methods/export-data.js";

// --- explicit resolutions for star-export collisions (see header) -----------

// auth.ts wins over transport/frame.ts (same values: "auth", 64 hex chars).
export { AUTH_METHOD, CONTROL_TOKEN_HEX_LENGTH } from "./auth.js";

// transport/frame.ts wins over methods/protocol.ts (same security.rs constants).
export { MAX_REQUEST_BYTES, MAX_BATCH_STEPS, type RequestId } from "./transport/frame.js";

// connection.ts's WireReply (one exchange's correlated outcome) wins; the methods
// module's full-envelope type stays importable under its alias.
export { type WireReply } from "./transport/connection.js";
export { type WireReply as ProtocolWireReply } from "./methods/protocol.js";
