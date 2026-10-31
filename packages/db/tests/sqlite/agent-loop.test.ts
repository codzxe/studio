import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, getDialect } from "../../src/db.js";
import { DbError } from "../../src/errors-lite.js";
import { createId } from "../../src/ids.js";
import { type Repos, createRepos } from "../../src/repos/index.js";
import { tablesFor } from "../../src/tables.js";

/**
 * Round-12 agent-loop persistence suite (PG-free — the dev-server.test.ts
 * recipe: real repos against a temp sqlite twin file). Pins:
 *  - migration 0008 columns end to end (agent_steps.tool_call_id, agent_runs
 *    last_step_index/heartbeat_at) on the sqlite dialect
 *  - insertToolCallStep → completeToolStep lifecycle (status issued → success,
 *    per-run seq allocation across MULTIPLE tool calls in one turn)
 *  - tool/assistant transcript rows (content_json shapes) + user-run link
 *  - heartbeat + stale sweep + markRunAbandoned (RUN_ABANDONED, idempotent)
 *  - loadThreadHistory: oldest-first order, tool rows included, BOTH caps
 *    (row count AND char budget, stop-before-exceeding boundary)
 */
describe("sqlite agent loop (round 12 persistence)", { timeout: 30_000 }, () => {
  let db: ReturnType<typeof createDb>;
  let repos: Repos;
  let workspaceId: string;
  let userId: string;
  let tmpDir: string;

  /** A fresh project + thread + queued run triple, workspace-scoped. */
  async function makeThreadWithRun(): Promise<{
    threadId: string;
    runId: string;
  }> {
    const project = await repos.projects.create(workspaceId, {
      name: `agent-loop-${randomUUID().slice(0, 8)}`,
      createdBy: userId,
    });
    const thread = await repos.threads.create(workspaceId, {
      projectId: project.id,
      createdBy: userId,
    });
    const run = await repos.runs.create(workspaceId, {
      threadId: thread.id,
      projectId: project.id,
      model: "studio-fast",
    });
    return { threadId: thread.id, runId: run.id };
  }

  /** Direct agent_messages insert with an EXPLICIT createdAt (deterministic order). */
  async function insertRawMessage(input: {
    threadId: string;
    role: string;
    contentJson: unknown;
    runId?: string | null;
    createdAt: Date;
  }): Promise<string> {
    const t = tablesFor(db);
    const id = createId("msg");
    await db.insert(t.agentMessages).values({
      id,
      threadId: input.threadId,
      role: input.role,
      contentJson: input.contentJson,
      runId: input.runId ?? null,
      createdAt: input.createdAt,
    });
    return id;
  }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "studio-agent-loop-"));
    db = createDb(`file:${join(tmpDir, "agent-loop.test.db")}`);
    expect(getDialect(db)).toBe("sqlite");

    const t = tablesFor(db);
    userId = `usr_${randomUUID().slice(0, 8)}`;
    workspaceId = `ws_${randomUUID().slice(0, 8)}`;
    await db
      .insert(t.user)
      .values({
        id: userId,
        name: "Agent Loop",
        email: `${userId}@studio.test`,
        emailVerified: true,
      })
      .onConflictDoNothing();
    await db
      .insert(t.organization)
      .values({ id: workspaceId, name: "Agent Loop WS", slug: workspaceId })
      .onConflictDoNothing();

    repos = createRepos(db);
  });

  afterAll(() => {
    (db.$client as unknown as { close: () => void }).close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── steps: issued → success ─────────────────────────────────────────────────

  it('insertToolCallStep writes status "issued" + tool_call_id; several calls in one turn get distinct seqs', async () => {
    const { threadId, runId } = await makeThreadWithRun();
    const first = await repos.runs.insertToolCallStep({
      runId,
      threadId,
      stepIndex: 0,
      toolCallId: "call_alpha",
      tool: "studio.get_context",
      argsJson: { comp: "comp_main" },
    });
    expect(first.status).toBe("issued");
    expect(first.toolCallId).toBe("call_alpha");
    expect(first.seq).toBe(0);
    expect(first.argsJson).toEqual({ comp: "comp_main" });

    // a second tool call in the SAME turn (stepIndex 0) — seq must not collide
    const second = await repos.runs.insertToolCallStep({
      runId,
      stepIndex: 0,
      toolCallId: "call_beta",
      tool: "studio.web_search",
      argsJson: { query: "cursor" },
    });
    expect(second.seq).toBe(1);
    expect(second.toolCallId).toBe("call_beta");

    const { steps } = await repos.runs.get(workspaceId, runId);
    expect(steps.map((step) => step.seq)).toEqual([0, 1]);
    expect(steps.every((step) => step.status === "issued")).toBe(true);
  });

  it("completeToolStep settles by toolCallId: status success + result_json; unknown id → NOT_FOUND", async () => {
    const { runId } = await makeThreadWithRun();
    await repos.runs.insertToolCallStep({
      runId,
      stepIndex: 0,
      toolCallId: "call_gamma",
      tool: "studio.render_audio",
      argsJson: { seconds: 2 },
    });
    const settled = await repos.runs.completeToolStep({
      toolCallId: "call_gamma",
      resultJson: { assetId: "ast_1", durationMs: 2000 },
    });
    expect(settled.status).toBe("success");
    expect(settled.resultJson).toEqual({ assetId: "ast_1", durationMs: 2000 });
    expect(settled.runId).toBe(runId);

    // idempotent re-settle (client retry) — same row, same result
    const again = await repos.runs.completeToolStep({
      toolCallId: "call_gamma",
      resultJson: { assetId: "ast_1", durationMs: 2000 },
    });
    expect(again.id).toBe(settled.id);

    await expect(
      repos.runs.completeToolStep({ toolCallId: "call_missing", resultJson: null }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("insertToolCallStep guards: thread mismatch → CONFLICT, unknown run → NOT_FOUND, bad stepIndex → VALIDATION_FAILED", async () => {
    const { threadId, runId } = await makeThreadWithRun();
    const other = await makeThreadWithRun();

    await expect(
      repos.runs.insertToolCallStep({
        runId,
        threadId: other.threadId,
        stepIndex: 0,
        toolCallId: "call_x",
        tool: "studio.get_context",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      repos.runs.insertToolCallStep({
        runId: "run_does_not_exist",
        stepIndex: 0,
        toolCallId: "call_x",
        tool: "studio.get_context",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      repos.runs.insertToolCallStep({
        runId,
        threadId,
        stepIndex: -1,
        toolCallId: "call_x",
        tool: "studio.get_context",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  // ── transcript rows ────────────────────────────────────────────────────────

  it('insertToolMessageRow: role "tool", content_json = { kind, toolCallId, tool, payload }', async () => {
    const { threadId, runId } = await makeThreadWithRun();
    const row = await repos.threads.insertToolMessageRow({
      threadId,
      runId,
      toolCallId: "call_delta",
      tool: "studio.get_context",
      payload: { ok: true, layers: 3 },
    });
    expect(row.role).toBe("tool");
    expect(row.runId).toBe(runId);
    expect(row.contentJson).toEqual({
      kind: "tool",
      toolCallId: "call_delta",
      tool: "studio.get_context",
      payload: { ok: true, layers: 3 },
    });

    // a run from ANOTHER thread may not write into this thread's transcript
    const other = await makeThreadWithRun();
    await expect(
      repos.threads.insertToolMessageRow({
        threadId,
        runId: other.runId,
        toolCallId: "call_epsilon",
        tool: "studio.get_context",
        payload: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it('insertAssistantMessageRow: role "assistant", status rides INSIDE content_json ({ message, status })', async () => {
    const { threadId, runId } = await makeThreadWithRun();
    const row = await repos.threads.insertAssistantMessageRow({
      threadId,
      runId,
      text: "halfway through the edit",
      status: "partial",
    });
    expect(row.role).toBe("assistant");
    expect(row.runId).toBe(runId);
    expect(row.contentJson).toEqual({ message: "halfway through the edit", status: "partial" });

    // runtime guard even where TS already forbids it
    await expect(
      repos.threads.insertAssistantMessageRow({
        threadId,
        runId,
        text: "x",
        status: "bogus" as never,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it('insertAssistantMessageRow: whitespace-only text + payload (a tool-call turn) normalizes to "" instead of failing the run', async () => {
    const { threadId, runId } = await makeThreadWithRun();
    // The live failure: GLM behind the LiteLLM seam returned "\n" alongside a
    // studio.create_text tool call — the turn route always sends a payload for
    // tool-call turns, so this must persist, not throw "text is required".
    const row = await repos.threads.insertAssistantMessageRow({
      threadId,
      runId,
      text: "\n",
      status: "completed",
      payload: { toolCalls: [{ toolCallId: "tc_1", tool: "studio.create_text", args: {} }] },
    });
    expect(row.role).toBe("assistant");
    expect(row.contentJson).toMatchObject({
      message: "",
      status: "completed",
      toolCalls: [{ toolCallId: "tc_1", tool: "studio.create_text" }],
    });
    // The text-only turn (no payload) still demands real text.
    await expect(
      repos.threads.insertAssistantMessageRow({
        threadId,
        runId,
        text: "  ",
        status: "completed",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("linkUserMessageToRun: sets run_id on the user row only; anything else reads 404", async () => {
    const { threadId, runId } = await makeThreadWithRun();
    const userRow = await repos.threads.addMessage(workspaceId, {
      threadId,
      role: "user",
      contentJson: { message: "make it blue" },
    });
    expect(userRow.runId).toBeNull();

    const linked = await repos.threads.linkUserMessageToRun({ messageId: userRow.id, runId });
    expect(linked.runId).toBe(runId);
    expect(linked.role).toBe("user");

    // assistant/tool rows are NOT linkable (404, not a silent overwrite)
    const assistantRow = await repos.threads.insertAssistantMessageRow({
      threadId,
      runId,
      text: "done",
      status: "completed",
    });
    await expect(
      repos.threads.linkUserMessageToRun({ messageId: assistantRow.id, runId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // unknown message / unknown run / run on another thread → 404
    await expect(
      repos.threads.linkUserMessageToRun({ messageId: "msg_missing", runId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const other = await makeThreadWithRun();
    await expect(
      repos.threads.linkUserMessageToRun({ messageId: userRow.id, runId: other.runId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      repos.threads.linkUserMessageToRun({ messageId: userRow.id, runId: "run_missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ── heartbeat + stale sweep + abandonment ─────────────────────────────────

  it("touchRunHeartbeat: status running + last_step_index + heartbeat bump (+ credits when given)", async () => {
    const { runId } = await makeThreadWithRun();
    const before = Date.now();
    const touched = await repos.runs.touchRunHeartbeat({
      runId,
      lastStepIndex: 2,
      creditsCommitted: 3,
    });
    expect(touched.status).toBe("running");
    expect(touched.lastStepIndex).toBe(2);
    expect(touched.committedCredits).toBe(3);
    expect(touched.heartbeatAt.getTime()).toBeGreaterThanOrEqual(before);

    // fresh heartbeat → not stale
    const staleIds = (await repos.runs.getStaleRunningRuns()).map((run) => run.id);
    expect(staleIds).not.toContain(runId);

    // re-touch is legal (running → running) and keeps monotonic step index
    const touchedAgain = await repos.runs.touchRunHeartbeat({ runId, lastStepIndex: 3 });
    expect(touchedAgain.lastStepIndex).toBe(3);
    expect(touchedAgain.committedCredits).toBe(3); // untouched when omitted

    // terminal run → heartbeat is a CONFLICT (honest: no zombie revival)
    await repos.runs.update(workspaceId, runId, { status: "completed" });
    await expect(repos.runs.touchRunHeartbeat({ runId, lastStepIndex: 4 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("getStaleRunningRuns + markRunAbandoned: 5-min default, workspace-scoped rows, idempotent cancel", async () => {
    const { runId } = await makeThreadWithRun();
    await repos.runs.touchRunHeartbeat({ runId, lastStepIndex: 1 });

    // backdate the heartbeat past the 5-minute default
    const t = tablesFor(db);
    await db
      .update(t.agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(t.agentRuns.id, runId));

    const stale = await repos.runs.getStaleRunningRuns();
    const mine = stale.find((run) => run.id === runId);
    expect(mine).toBeDefined();
    expect(mine?.workspaceId).toBe(workspaceId);

    // a STRICTER window (10 min) does not consider a 6-min-old heartbeat stale
    expect(
      (await repos.runs.getStaleRunningRuns(10 * 60_000)).some((run) => run.id === runId),
    ).toBe(false);
    // a LOOSER window (1 ms) includes it
    expect((await repos.runs.getStaleRunningRuns(1)).some((run) => run.id === runId)).toBe(true);
    // non-positive window → typed VALIDATION_FAILED
    await expect(repos.runs.getStaleRunningRuns(0)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });

    const abandoned = await repos.runs.markRunAbandoned({ runId });
    expect(abandoned.status).toBe("cancelled");
    expect(abandoned.errorCode).toBe("RUN_ABANDONED");
    expect(abandoned.completedAt).not.toBeNull();

    // idempotent re-sweep + no longer stale
    const again = await repos.runs.markRunAbandoned({ runId });
    expect(again.status).toBe("cancelled");
    expect((await repos.runs.getStaleRunningRuns()).some((run) => run.id === runId)).toBe(false);

    // unknown run → 404
    await expect(repos.runs.markRunAbandoned({ runId: "run_missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("heartbeat columns exist on the twin (0008): fresh runs default heartbeat_at/last_step_index", async () => {
    const { runId } = await makeThreadWithRun();
    const run = await repos.runs.get(workspaceId, runId);
    expect(run.run.lastStepIndex).toBe(0);
    expect(run.run.heartbeatAt).toBeInstanceOf(Date);
    expect(Number.isNaN(run.run.heartbeatAt.getTime())).toBe(false);
  });

  // ── loadThreadHistory ──────────────────────────────────────────────────────

  it("loadThreadHistory: oldest-first, tool rows included, legacy + round-12 shapes map", async () => {
    const { threadId, runId } = await makeThreadWithRun();
    const base = Date.now() - 60_000;
    // Deterministic order (explicit created_at, 10ms apart): legacy user row
    // (chat.ts shape), legacy assistant row ({text}), a round-12 tool row
    // (exactly what insertToolMessageRow writes), a round-12 assistant row
    // ({message, status}), and a system row that must be dropped.
    await insertRawMessage({
      threadId,
      role: "user",
      contentJson: { message: "first question", context: {}, pinned: [] },
      createdAt: new Date(base),
    });
    await insertRawMessage({
      threadId,
      role: "assistant",
      contentJson: { text: "legacy answer" },
      runId,
      createdAt: new Date(base + 10),
    });
    await insertRawMessage({
      threadId,
      role: "tool",
      contentJson: {
        kind: "tool",
        toolCallId: "call_zeta",
        tool: "studio.get_context",
        payload: { ok: true },
      },
      runId,
      createdAt: new Date(base + 20),
    });
    await insertRawMessage({
      threadId,
      role: "assistant",
      contentJson: { message: "round 12 answer", status: "completed" },
      runId,
      createdAt: new Date(base + 30),
    });
    await insertRawMessage({
      threadId,
      role: "system",
      contentJson: { text: "system rows never reach history" },
      createdAt: new Date(base + 40),
    });

    const history = await repos.threads.loadThreadHistory(threadId);
    expect(history.map((entry) => entry.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(history[0]?.text).toBe("first question");
    expect(history[1]?.text).toBe("legacy answer");
    expect(history[2]?.contentJson).toEqual({
      kind: "tool",
      toolCallId: "call_zeta",
      tool: "studio.get_context",
      payload: { ok: true },
    });
    expect(history[2]?.runId).toBe(runId);
    expect(history[3]?.text).toBe("round 12 answer");
    expect(history[3]?.contentJson).toEqual({ message: "round 12 answer", status: "completed" });
  });

  it("loadThreadHistory: unknown thread → NOT_FOUND", async () => {
    await expect(repos.threads.loadThreadHistory("thr_missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("loadThreadHistory: the default row cap is 2000 (round-13 'unlimited context') — 41 messages all kept; explicit caps still honored", async () => {
    const { threadId } = await makeThreadWithRun();
    const base = Date.now() - 120_000;
    for (let i = 0; i < 41; i += 1) {
      await insertRawMessage({
        threadId,
        role: "user",
        contentJson: { message: `m${i}` },
        createdAt: new Date(base + i),
      });
    }
    const history = await repos.threads.loadThreadHistory(threadId);
    // f62251b raised the default from 40 rows to 2000 ("give agents a context
    // limit of unlimited for now") — a 41-message thread keeps EVERYTHING.
    expect(history.length).toBe(41);
    expect(history[0]?.text).toBe("m0");
    expect(history.at(-1)?.text).toBe("m40");

    // a tighter explicit cap is honored too (the window keeps the NEWEST rows)
    const capped = await repos.threads.loadThreadHistory(threadId, { maxMessages: 3 });
    expect(capped.length).toBe(3);
    expect(capped[0]?.text).toBe("m38");
    expect(capped.at(-1)?.text).toBe("m40");
  });

  it("loadThreadHistory: char cap — stop BEFORE exceeding (each row costs JSON.stringify(content_json).length)", async () => {
    const { threadId } = await makeThreadWithRun();
    const base = Date.now() - 120_000;
    // three rows, each costing exactly C = JSON.stringify({message:"x".repeat(10)}).length
    const cost = JSON.stringify({ message: "x".repeat(10) }).length;
    for (let i = 0; i < 3; i += 1) {
      await insertRawMessage({
        threadId,
        role: "user",
        contentJson: { message: "x".repeat(10) },
        createdAt: new Date(base + i),
      });
    }
    // budget 3C-1: the third-oldest row would push the total to 3C → dropped
    const twoKept = await repos.threads.loadThreadHistory(threadId, { maxChars: 3 * cost - 1 });
    expect(twoKept.length).toBe(2);
    // budget 3C: all three fit (boundary inclusive)
    const allKept = await repos.threads.loadThreadHistory(threadId, { maxChars: 3 * cost });
    expect(allKept.length).toBe(3);
    // budget C-1: even the newest row alone exceeds → empty window
    const noneKept = await repos.threads.loadThreadHistory(threadId, { maxChars: cost - 1 });
    expect(noneKept.length).toBe(0);
  });

  it("loadThreadHistory: BOTH caps compose — the row window is char-trimmed, newest-first retention", async () => {
    const { threadId } = await makeThreadWithRun();
    const base = Date.now() - 120_000;
    for (let i = 0; i < 5; i += 1) {
      await insertRawMessage({
        threadId,
        role: "user",
        contentJson: { message: `c${i}`.padEnd(10, `${i}`) },
        createdAt: new Date(base + i),
      });
    }
    // 40-row cap would keep all 5; a 2-row cap keeps the newest 2 → then the
    // char cap can only shrink further from the newest end.
    const history = await repos.threads.loadThreadHistory(threadId, { maxMessages: 2 });
    expect(history.length).toBe(2);
    expect(history[0]?.text?.startsWith("c3")).toBe(true);
    expect(history[1]?.text?.startsWith("c4")).toBe(true);
  });

  it("loadThreadHistory is read-only: it never mutates agent_messages", async () => {
    const { threadId } = await makeThreadWithRun();
    await repos.threads.addMessage(workspaceId, {
      threadId,
      role: "user",
      contentJson: { message: "q" },
    });
    const page = await repos.threads.listMessages(workspaceId, threadId, { limit: 100 });
    await repos.threads.loadThreadHistory(threadId);
    const after = await repos.threads.listMessages(workspaceId, threadId, { limit: 100 });
    expect(after.items.length).toBe(page.items.length);
    expect(after.items[0]?.id).toBe(page.items[0]?.id);
  });

  it("DbError surface stays typed for the new seams (no plain Error leaks)", async () => {
    const { runId } = await makeThreadWithRun();
    try {
      await repos.runs.insertToolCallStep({
        runId,
        stepIndex: 0,
        toolCallId: "",
        tool: "studio.get_context",
      });
      expect.unreachable("empty toolCallId must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
      expect((error as DbError).code).toBe("VALIDATION_FAILED");
    }
  });
});
