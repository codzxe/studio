import { z } from 'zod';

/** SSE events for chat runs — PRODUCT_ARCHITECTURE §7.4. Ordered per run with `seq`. */
export const StudioStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), runId: z.string(), model: z.string(), seq: z.number().int() }),
  z.object({ type: z.literal('message.delta'), delta: z.string(), seq: z.number().int() }),
  z.object({ type: z.literal('tool.started'), toolCallId: z.string(), name: z.string(), args: z.unknown().optional(), seq: z.number().int() }),
  z.object({ type: z.literal('tool.delta'), toolCallId: z.string(), delta: z.string(), seq: z.number().int() }),
  z.object({ type: z.literal('tool.result'), toolCallId: z.string(), result: z.unknown(), seq: z.number().int() }),
  z.object({ type: z.literal('plan'), plan: z.unknown(), seq: z.number().int() }), // EditPlan; validated separately
  z.object({ type: z.literal('preview'), runId: z.string(), pngBase64: z.string(), width: z.number().int(), height: z.number().int(), seq: z.number().int() }),
  z.object({ type: z.literal('approval.required'), runId: z.string(), plan: z.unknown(), seq: z.number().int() }),
  z.object({ type: z.literal('credits'), reserved: z.number().int(), committed: z.number().int(), balance: z.number().int(), seq: z.number().int() }),
  z.object({ type: z.literal('run.completed'), runId: z.string(), versionId: z.string().optional(), seq: z.number().int() }),
  z.object({ type: z.literal('run.failed'), runId: z.string(), code: z.string(), message: z.string(), retryable: z.boolean(), seq: z.number().int() }),
  z.object({ type: z.literal('run.cancelled'), runId: z.string(), seq: z.number().int() }),
  z.object({ type: z.literal('heartbeat'), seq: z.number().int() }),
]);
export type StudioStreamEvent = z.infer<typeof StudioStreamEvent>;

export interface SseEvent {
  event: string;
  data: StudioStreamEvent;
}
