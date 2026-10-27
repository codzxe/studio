import { z } from 'zod';

/**
 * The engine.command / engine.batch wire contract — PRODUCT_ARCHITECTURE §8.5.
 * Command ids and params in examples are illustrative; the live registry is
 * authoritative and every id is allowlisted before execution.
 */

export const CommandParam = z.record(z.string(), z.unknown());

export const CommandStep = z.object({
  command: z.string().min(1),
  params: CommandParam,
});
export type CommandStep = z.infer<typeof CommandStep>;

/**
 * A batch the agent proposes. `$N.key` references in later steps resolve to results
 * of step N (e.g. `{ "command": "layer.rename", "params": { "layer": "$2.layer" } }`).
 */
export const AgentBatch = z.object({
  label: z.string().min(1).max(120),
  atomic: z.literal(true),
  steps: z.array(CommandStep).min(1).max(100),
}).strict();
export type AgentBatch = z.infer<typeof AgentBatch>;

export const BatchStepResult = z.object({
  seq: z.number().int(),
  command: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export const BatchResult = z.object({
  ok: z.boolean(),
  label: z.string(),
  results: z.array(BatchStepResult),
  rolledBack: z.boolean(),
  undoToken: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
});
export type BatchResult = z.infer<typeof BatchResult>;

/** `command.describe` payload — JSON-Schema-ish param description. */
export interface CommandParamDesc {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum' | 'color' | 'time' | 'path';
  required: boolean;
  enum?: string[];
  description?: string;
}

export interface CommandInfo {
  id: string;
  scope: 'engine' | 'project' | 'comp' | 'layer' | 'prop' | 'effect' | 'keyframe' | 'edit' | 'ui' | 'render' | 'file';
  writes: boolean;
  summary: string;
  params?: CommandParamDesc[];
}

/**
 * The allowlist of commands the plan compiler may emit. The mock editor implements
 * exactly this registry; the real engine's registry is fetched via `commands()` at
 * pin time and any missing command fails loudly (BUILD_PLAN M5).
 */
export const COMMAND_ALLOWLIST: Record<string, Pick<CommandInfo, 'scope' | 'writes' | 'summary' | 'params'>> = {
  'comp.new': { scope: 'comp', writes: true, summary: 'Create a composition', params: [
    { name: 'name', type: 'string', required: true }, { name: 'width', type: 'number', required: true }, { name: 'height', type: 'number', required: true },
    { name: 'frameRate', type: 'number', required: false }, { name: 'duration', type: 'time', required: false } ] },
  'comp.set': { scope: 'comp', writes: true, summary: 'Update a composition', params: [
    { name: 'comp', type: 'string', required: true }, { name: 'name', type: 'string', required: false },
    { name: 'duration', type: 'time', required: false }, { name: 'bgColor', type: 'color', required: false } ] },
  'layer.newSolid': { scope: 'layer', writes: true, summary: 'Create a solid layer', params: [
    { name: 'comp', type: 'string', required: true }, { name: 'name', type: 'string', required: true }, { name: 'color', type: 'color', required: true } ] },
  'layer.newText': { scope: 'layer', writes: true, summary: 'Create an editable text layer', params: [
    { name: 'comp', type: 'string', required: true }, { name: 'name', type: 'string', required: true }, { name: 'text', type: 'string', required: true },
    { name: 'fontSize', type: 'number', required: false }, { name: 'fontFamily', type: 'string', required: false },
    { name: 'color', type: 'color', required: false }, { name: 'position', type: 'array', required: false } ] },
  'layer.newShape': { scope: 'layer', writes: true, summary: 'Create a shape layer', params: [
    { name: 'comp', type: 'string', required: true }, { name: 'name', type: 'string', required: true }, { name: 'shape', type: 'enum', required: true, enum: ['rect', 'ellipse', 'polygon', 'star'] } ] },
  'layer.rename': { scope: 'layer', writes: true, summary: 'Rename a layer', params: [
    { name: 'layer', type: 'string', required: true }, { name: 'name', type: 'string', required: true } ] },
  'layer.reorder': { scope: 'layer', writes: true, summary: 'Move a layer in the stack', params: [
    { name: 'layer', type: 'string', required: true }, { name: 'index', type: 'number', required: true } ] },
  'layer.delete': { scope: 'layer', writes: true, summary: 'Delete a layer', params: [
    { name: 'layer', type: 'string', required: true } ] },
  'layer.duplicate': { scope: 'layer', writes: true, summary: 'Duplicate a layer', params: [
    { name: 'layer', type: 'string', required: true }, { name: 'name', type: 'string', required: false } ] },
  'prop.set': { scope: 'prop', writes: true, summary: 'Set a property value', params: [
    { name: 'layer', type: 'string', required: true }, { name: 'path', type: 'string', required: true }, { name: 'value', type: 'object', required: true } ] },
  'prop.keyframes': { scope: 'keyframe', writes: true, summary: 'Set keyframes on a property', params: [
    { name: 'layer', type: 'string', required: true }, { name: 'path', type: 'string', required: true },
    { name: 'keys', type: 'array', required: true } ] },
  'effect.add': { scope: 'effect', writes: true, summary: 'Add an effect to a layer', params: [
    { name: 'layer', type: 'string', required: true }, { name: 'effect', type: 'string', required: true }, { name: 'params', type: 'object', required: false } ] },
  'effect.set': { scope: 'effect', writes: true, summary: 'Update effect parameters', params: [
    { name: 'layer', type: 'string', required: true }, { name: 'effect', type: 'string', required: true }, { name: 'params', type: 'object', required: true } ] },
  'effect.remove': { scope: 'effect', writes: true, summary: 'Remove an effect', params: [
    { name: 'layer', type: 'string', required: true }, { name: 'effect', type: 'string', required: true } ] },
  'edit.undo': { scope: 'edit', writes: true, summary: 'Undo the last edit step', params: [] },
  'file.save': { scope: 'file', writes: true, summary: 'Save the project to a virtual path', params: [
    { name: 'path', type: 'path', required: true } ] },
};

/** Read-only query commands the context assembly uses. */
export const QUERY_COMMANDS = {
  'project.summary': 'Project summary: name, comps, counts',
  'comp.info': 'Active composition info',
  'layer.tree': 'Layer tree at a depth',
  'prop.get': 'Property values for a layer',
  'ui.inspect': 'Editor UI state: active comp, selection, playhead, panels',
  'render.frame': 'Render a frame to PNG at a comp/time',
  'edit.history.list': 'Recent edit history',
  'effect.list': 'Effects in the registry',
} as const;

/** The effect registry available in the mock engine (subset of upstream's 306). */
export const EFFECT_REGISTRY = ['glow', 'blur', 'drop-shadow', 'sharpen', 'chromatic-aberration', 'vignette', 'grain', 'hue-shift', 'opacity-ramp', 'spring-scale', 'overshoot', 'fade-in', 'typewriter', 'wiggle', 'loop'] as const;
export type EffectId = (typeof EFFECT_REGISTRY)[number];

/** Property paths the compiler knows how to set on layers. */
export const PROPERTY_PATHS = ['transform/position', 'transform/scale', 'transform/rotation', 'transform/opacity', 'transform/anchor', 'text/content', 'text/fontSize', 'text/fontFamily', 'text/color', 'text/tracking', 'fill/color', 'stroke/color', 'stroke/width'] as const;
export type PropertyPath = (typeof PROPERTY_PATHS)[number];
