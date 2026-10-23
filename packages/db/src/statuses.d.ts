import type { RenderStatus, RunStatus } from "./schema.js";
export declare function assertRunTransition(from: RunStatus, to: RunStatus): void;
export declare function isTerminalRunStatus(status: RunStatus): boolean;
export declare function assertRenderTransition(from: RenderStatus, to: RenderStatus): void;
export declare function isTerminalRenderStatus(status: RenderStatus): boolean;
