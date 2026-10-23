import { type Page } from "../cursor.js";
import type { StudioDb } from "../db.js";
import { type AgentMessage, type AgentThread } from "../schema.js";
import { type WorkspaceId } from "./shared.js";
/** Threads repository — chat conversations attached to a project (§3.1). */
export type ChatRole = "user" | "assistant" | "system" | "tool";
export interface ThreadCreateInput {
    readonly projectId: string;
    readonly createdBy: string;
    readonly title?: string;
}
export interface MessageInput {
    readonly threadId: string;
    readonly role: ChatRole;
    readonly contentJson: unknown;
    readonly runId?: string | null;
}
export interface ListOptions {
    readonly limit?: number;
    readonly cursor?: string | null;
}
export interface ThreadsRepo {
    create(workspaceId: WorkspaceId, input: ThreadCreateInput): Promise<AgentThread>;
    listByProject(workspaceId: WorkspaceId, projectId: string, options?: ListOptions): Promise<Page<AgentThread>>;
    get(workspaceId: WorkspaceId, threadId: string): Promise<AgentThread>;
    addMessage(workspaceId: WorkspaceId, input: MessageInput): Promise<AgentMessage>;
    listMessages(workspaceId: WorkspaceId, threadId: string, options?: ListOptions): Promise<Page<AgentMessage>>;
}
export declare function createThreadsRepo(db: StudioDb): ThreadsRepo;
