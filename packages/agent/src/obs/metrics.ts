// packages/agent/src/obs/metrics.ts — W9-D observability kit: metrics (§22).
//
// ZERO-DEP Prometheus text-format (0.0.4) Counter/Gauge/Histogram registry —
// no prom-client, no OTel metrics SDK: /metrics handlers render this string
// (RENDER_CONTENT_TYPE) and the collector/VM scrape it (ADR-0005 #7).
//
// §22 metric set (typed factories below): runs by status/tier, duration
// histogram, steps per run, tool error rate, validator blocker rate, critic
// revise rate, credits reserved/committed (§14.2), AI cost per
// run/workspace/day, tokens in/out/cache, queue depth, engine sessions
// active/idle. Deliberately NOT here (§22 extension points for the wiring
// wave, same three-step recipe as run_duration_seconds): queue age, engine
// pool utilisation, uploads, exports, DB pool saturation.
//
// Rendering is canonical/deterministic: families in registration order,
// children sorted by their label key, label pairs sorted by name (Go client
// parity), histograms as _bucket{le} (cumulative, ≤ semantics) + _sum +
// _count, "+Inf" last. Empty families are omitted (nothing to scrape yet).

export type LabelValue = string | number;

/** Label name → value map (callers usually pass a literal type). */
export interface LabelValues {
  readonly [name: string]: LabelValue;
}

export type MetricKind = "counter" | "gauge" | "histogram";

/** Content type for the /metrics handler (Prometheus text format 0.0.4). */
export const RENDER_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Typed internal error (AGENTS.md: never throw strings). */
export class ObsMetricError extends Error {
  constructor(
    readonly code:
      | "invalid_name"
      | "invalid_label_name"
      | "duplicate_name"
      | "invalid_label_set"
      | "invalid_value"
      | "invalid_buckets",
    message: string,
  ) {
    super(`[obs/metrics] ${message}`);
    this.name = "ObsMetricError";
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The minimal surface a family must expose to be renderable by a registry. */
export interface RenderableMetricFamily {
  readonly name: string;
  readonly help: string;
  readonly kind: MetricKind;
  isEmpty(): boolean;
  renderLines(): readonly string[];
  reset(): void;
}

export interface ObsMetricRegistry {
  /** Families in registration order (live view; do not mutate). */
  readonly families: readonly RenderableMetricFamily[];
  register(family: RenderableMetricFamily): void;
  /** Deterministic Prometheus text format body for /metrics. */
  render(): string;
  /** Clear every family's children (tests; never in shipped paths). */
  reset(): void;
}

export function createObsMetricRegistry(): ObsMetricRegistry {
  const families: RenderableMetricFamily[] = [];
  const registered = new Set<string>();
  return {
    get families(): readonly RenderableMetricFamily[] {
      return families;
    },
    register: (family) => {
      if (registered.has(family.name)) {
        throw new ObsMetricError("duplicate_name", `metric family "${family.name}" already registered`);
      }
      registered.add(family.name);
      families.push(family);
    },
    render: () => {
      const lines: string[] = [];
      for (const family of families) {
        if (!family.isEmpty()) {
          lines.push(...family.renderLines());
        }
      }
      return lines.join("");
    },
    reset: () => {
      for (const family of families) {
        family.reset();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared machinery (validation, keys, sample lines)
// ---------------------------------------------------------------------------

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type LabelPairs = ReadonlyArray<readonly [string, string]>;

function validateName(name: string): void {
  if (!METRIC_NAME_RE.test(name)) {
    throw new ObsMetricError("invalid_name", `"${name}" is not a valid metric name`);
  }
}

function validateLabelNames(name: string, labelNames: readonly string[]): void {
  const seen = new Set<string>();
  for (const label of labelNames) {
    if (!LABEL_NAME_RE.test(label)) {
      throw new ObsMetricError("invalid_label_name", `"${label}" is not a valid label name`);
    }
    if (seen.has(label)) {
      throw new ObsMetricError("invalid_label_name", `duplicate label "${label}" on "${name}"`);
    }
    seen.add(label);
  }
}

/** Convert arbitrary label objects (generic L) to the internal record shape. */
function toLabelRecord(labels: object): Record<string, LabelValue | undefined> {
  return labels as unknown as Record<string, LabelValue | undefined>;
}

function validateLabels(
  name: string,
  labelNames: readonly string[],
  labels: object | undefined,
): LabelPairs {
  const given = labels === undefined ? {} : toLabelRecord(labels);
  const givenKeys = new Set(Object.keys(given));
  for (const key of givenKeys) {
    if (!labelNames.includes(key)) {
      throw new ObsMetricError("invalid_label_set", `metric "${name}": unknown label "${key}"`);
    }
  }
  return labelNames.map((label) => {
    const value = given[label];
    if (value === undefined) {
      throw new ObsMetricError("invalid_label_set", `metric "${name}": missing label "${label}"`);
    }
    return [label, String(value)] as const;
  });
}

function assertFiniteValue(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new ObsMetricError("invalid_value", `metric "${name}": value must be finite`);
  }
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(help: string): string {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** One sample line: `name{label="v",…} value` (pairs sorted by label name). */
function sampleLine(name: string, pairs: LabelPairs, value: number): string {
  if (pairs.length === 0) {
    return `${name} ${value}\n`;
  }
  const sorted = [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const labels = sorted.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",");
  return `${name}{${labels}} ${value}\n`;
}

function sortedChildren<C extends { readonly pairs: LabelPairs }>(
  children: Map<string, C>,
): ReadonlyArray<[string, C]> {
  return [...children.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headerLines(family: RenderableMetricFamily): string[] {
  return [
    `# HELP ${family.name} ${escapeHelp(family.help)}\n`,
    `# TYPE ${family.name} ${family.kind}\n`,
  ];
}

function validateBuckets(name: string, buckets: readonly number[]): number[] {
  if (buckets.length === 0) {
    throw new ObsMetricError("invalid_buckets", `metric "${name}": buckets must not be empty`);
  }
  const bounds = [...buckets];
  let previous: number | undefined;
  for (const bound of bounds) {
    if (!Number.isFinite(bound) || bound < 0) {
      throw new ObsMetricError("invalid_buckets", `metric "${name}": bucket bounds must be finite and >= 0`);
    }
    if (previous !== undefined && bound <= previous) {
      throw new ObsMetricError("invalid_buckets", `metric "${name}": bucket bounds must be strictly ascending`);
    }
    previous = bound;
  }
  return bounds;
}

// ---------------------------------------------------------------------------
// Families (internal classes; public facades below carry the typed API)
// ---------------------------------------------------------------------------

abstract class FamilyBase implements RenderableMetricFamily {
  protected readonly labelNames: readonly string[];

  constructor(
    readonly name: string,
    readonly help: string,
    readonly kind: MetricKind,
    labelNames: readonly string[],
    registry?: ObsMetricRegistry,
  ) {
    validateName(name);
    validateLabelNames(name, labelNames);
    this.labelNames = labelNames;
    registry?.register(this);
  }

  abstract isEmpty(): boolean;
  abstract renderLines(): readonly string[];

  reset(): void {
    // Concrete families own their child maps (override).
  }

  protected keyFor(labels: object | undefined): { key: string; pairs: LabelPairs } {
    const pairs = validateLabels(this.name, this.labelNames, labels);
    return { key: JSON.stringify(pairs), pairs };
  }
}

class CounterFamily extends FamilyBase {
  private readonly counts = new Map<string, { pairs: LabelPairs; value: number }>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    registry?: ObsMetricRegistry,
  ) {
    super(name, help, "counter", labelNames, registry);
  }

  override isEmpty(): boolean {
    return this.counts.size === 0;
  }

  override reset(): void {
    this.counts.clear();
  }

  inc(labels: object | undefined, value: number): void {
    assertFiniteValue(this.name, value);
    if (value < 0) {
      throw new ObsMetricError("invalid_value", `metric "${this.name}": counter decrement ${value}`);
    }
    const { key, pairs } = this.keyFor(labels);
    const child = this.counts.get(key) ?? { pairs, value: 0 };
    child.value += value;
    this.counts.set(key, child);
  }

  renderLines(): readonly string[] {
    if (this.counts.size === 0) {
      return [];
    }
    const lines = headerLines(this);
    for (const [, child] of sortedChildren(this.counts)) {
      lines.push(sampleLine(this.name, child.pairs, child.value));
    }
    return lines;
  }
}

class GaugeFamily extends FamilyBase {
  private readonly values = new Map<string, { pairs: LabelPairs; value: number }>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    registry?: ObsMetricRegistry,
  ) {
    super(name, help, "gauge", labelNames, registry);
  }

  override isEmpty(): boolean {
    return this.values.size === 0;
  }

  override reset(): void {
    this.values.clear();
  }

  mutate(labels: object | undefined, delta: number): void {
    assertFiniteValue(this.name, delta);
    const { key, pairs } = this.keyFor(labels);
    const child = this.values.get(key) ?? { pairs, value: 0 };
    child.value += delta;
    this.values.set(key, child);
  }

  set(labels: object | undefined, value: number): void {
    assertFiniteValue(this.name, value);
    const { key, pairs } = this.keyFor(labels);
    this.values.set(key, { pairs, value });
  }

  renderLines(): readonly string[] {
    if (this.values.size === 0) {
      return [];
    }
    const lines = headerLines(this);
    for (const [, child] of sortedChildren(this.values)) {
      lines.push(sampleLine(this.name, child.pairs, child.value));
    }
    return lines;
  }
}

class HistogramFamily extends FamilyBase {
  private readonly observations = new Map<
    string,
    { pairs: LabelPairs; counts: number[]; sum: number; count: number }
  >();
  private readonly bounds: number[];

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[],
    registry?: ObsMetricRegistry,
  ) {
    super(name, help, "histogram", labelNames, registry);
    this.bounds = validateBuckets(name, buckets);
  }

  override isEmpty(): boolean {
    return this.observations.size === 0;
  }

  override reset(): void {
    this.observations.clear();
  }

  observe(labels: object | undefined, value: number): void {
    assertFiniteValue(this.name, value);
    if (value < 0) {
      throw new ObsMetricError("invalid_value", `metric "${this.name}": negative observation ${value}`);
    }
    const { key, pairs } = this.keyFor(labels);
    const child =
      this.observations.get(key) ?? { pairs, counts: this.bounds.map(() => 0), sum: 0, count: 0 };
    child.sum += value;
    child.count += 1;
    // bucket {le="x"} counts observations <= x (Prometheus semantics).
    for (let i = 0; i < this.bounds.length; i += 1) {
      const bound = this.bounds[i];
      if (bound !== undefined && value <= bound) {
        const slot = child.counts[i];
        child.counts[i] = (slot ?? 0) + 1;
        break;
      }
    }
    this.observations.set(key, child);
  }

  renderLines(): readonly string[] {
    if (this.observations.size === 0) {
      return [];
    }
    const lines = headerLines(this);
    for (const [, child] of sortedChildren(this.observations)) {
      let cumulative = 0;
      for (let i = 0; i < this.bounds.length; i += 1) {
        const bound = this.bounds[i];
        if (bound === undefined) {
          continue;
        }
        cumulative += child.counts[i] ?? 0;
        lines.push(
          sampleLine(`${this.name}_bucket`, [...child.pairs, ["le", String(bound)]], cumulative),
        );
      }
      lines.push(sampleLine(`${this.name}_bucket`, [...child.pairs, ["le", "+Inf"]], child.count));
      lines.push(sampleLine(`${this.name}_sum`, child.pairs, child.sum));
      lines.push(sampleLine(`${this.name}_count`, child.pairs, child.count));
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Typed public constructors
// ---------------------------------------------------------------------------

export interface UnlabeledFamilyConfig {
  readonly name: string;
  readonly help: string;
  /** Register into this registry when provided (renders via registry.render). */
  readonly registry?: ObsMetricRegistry;
}

export interface LabeledFamilyConfig<L> {
  readonly name: string;
  readonly help: string;
  /** Exactly the keys of L (compile-time-checked for literal label types). */
  readonly labelNames: ReadonlyArray<keyof L & string>;
  readonly registry?: ObsMetricRegistry;
}

export interface UnlabeledHistogramConfig extends UnlabeledFamilyConfig {
  readonly buckets: readonly number[];
}

export interface LabeledHistogramConfig<L> extends LabeledFamilyConfig<L> {
  readonly buckets: readonly number[];
}

export interface UnlabeledCounter {
  readonly name: string;
  inc(value?: number): void;
}

export interface LabeledCounter<L> {
  readonly name: string;
  inc(labels: L, value?: number): void;
}

export interface UnlabeledGauge {
  readonly name: string;
  set(value: number): void;
  inc(delta?: number): void;
  dec(delta?: number): void;
}

export interface LabeledGauge<L> {
  readonly name: string;
  set(labels: L, value: number): void;
  inc(labels: L, delta?: number): void;
  dec(labels: L, delta?: number): void;
}

export interface UnlabeledHistogram {
  readonly name: string;
  observe(value: number): void;
}

export interface LabeledHistogram<L> {
  readonly name: string;
  observe(labels: L, value: number): void;
}

export function createUnlabeledCounter(config: UnlabeledFamilyConfig): UnlabeledCounter {
  const family = new CounterFamily(config.name, config.help, [], config.registry);
  return { name: config.name, inc: (value = 1) => family.inc(undefined, value) };
}

export function createLabeledCounter<L extends object>(
  config: LabeledFamilyConfig<L>,
): LabeledCounter<L> {
  const family = new CounterFamily(config.name, config.help, [...config.labelNames], config.registry);
  return {
    name: config.name,
    inc: (labels: L, value = 1) => family.inc(labels, value),
  };
}

export function createUnlabeledGauge(config: UnlabeledFamilyConfig): UnlabeledGauge {
  const family = new GaugeFamily(config.name, config.help, [], config.registry);
  return {
    name: config.name,
    set: (value: number) => family.set(undefined, value),
    inc: (delta = 1) => family.mutate(undefined, delta),
    dec: (delta = 1) => family.mutate(undefined, -delta),
  };
}

export function createLabeledGauge<L extends object>(
  config: LabeledFamilyConfig<L>,
): LabeledGauge<L> {
  const family = new GaugeFamily(config.name, config.help, [...config.labelNames], config.registry);
  return {
    name: config.name,
    set: (labels: L, value: number) => family.set(labels, value),
    inc: (labels: L, delta = 1) => family.mutate(labels, delta),
    dec: (labels: L, delta = 1) => family.mutate(labels, -delta),
  };
}

export function createUnlabeledHistogram(
  config: UnlabeledHistogramConfig,
): UnlabeledHistogram {
  const family = new HistogramFamily(config.name, config.help, [], config.buckets, config.registry);
  return { name: config.name, observe: (value: number) => family.observe(undefined, value) };
}

export function createLabeledHistogram<L extends object>(
  config: LabeledHistogramConfig<L>,
): LabeledHistogram<L> {
  const family = new HistogramFamily(
    config.name,
    config.help,
    [...config.labelNames],
    config.buckets,
    config.registry,
  );
  return { name: config.name, observe: (labels: L, value: number) => family.observe(labels, value) };
}

// ---------------------------------------------------------------------------
// §22 metric set
// ---------------------------------------------------------------------------

/** §5.2 run tiers (model routing tiers, planner §23.2 model_tier). */
export type MetricTier = "quick" | "standard" | "complex";

/** Terminal run outcomes (§5.1; runs_total{status}). */
export type RunMetricStatus = "succeeded" | "failed" | "cancelled";

/** ADR-0005 #7: engine sessions active/idle. */
export type EngineSessionState = "active" | "idle";

/** Duration buckets (seconds): covers queue-age alerting (2 min) and §5.2
 *  wall-clock budgets up to 10 minutes. */
export const RUN_DURATION_SECONDS_BUCKETS: readonly number[] = [
  0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];

/** Step-count buckets: §5.2 tool-call caps live in the low tens. */
export const STEPS_PER_RUN_BUCKETS: readonly number[] = [1, 2, 4, 8, 16, 24, 32, 48, 64];

/** The §22 metric set, pre-built and typed (see header for the names). */
export interface ObsMetrics {
  readonly registry: ObsMetricRegistry;
  readonly runsTotal: LabeledCounter<{ readonly status: RunMetricStatus; readonly tier: MetricTier }>;
  readonly runDurationSeconds: LabeledHistogram<{ readonly tier: MetricTier }>;
  readonly stepsPerRun: UnlabeledHistogram;
  readonly toolErrorsTotal: LabeledCounter<{ readonly tool: string }>;
  readonly validatorBlockersTotal: UnlabeledCounter;
  readonly criticReviseTotal: UnlabeledCounter;
  readonly creditsReservedTotal: UnlabeledCounter;
  readonly creditsCommittedTotal: UnlabeledCounter;
  readonly aiCostUsdPerDay: LabeledCounter<{ readonly workspace: string }>;
  readonly tokensInTotal: UnlabeledCounter;
  readonly tokensOutTotal: UnlabeledCounter;
  readonly tokensCacheTotal: UnlabeledCounter;
  readonly queueDepth: UnlabeledGauge;
  readonly engineSessions: LabeledGauge<{ readonly state: EngineSessionState }>;
}

export function createObsMetrics(): ObsMetrics {
  const registry = createObsMetricRegistry();
  return {
    registry,
    runsTotal: createLabeledCounter<{
      readonly status: RunMetricStatus;
      readonly tier: MetricTier;
    }>({
      name: "runs_total",
      help: "Runs by terminal status and tier (§22).",
      labelNames: ["status", "tier"],
      registry,
    }),
    runDurationSeconds: createLabeledHistogram<{ readonly tier: MetricTier }>({
      name: "run_duration_seconds",
      help: "End-to-end run duration by tier; p50/p95 read off the buckets (§22).",
      labelNames: ["tier"],
      buckets: RUN_DURATION_SECONDS_BUCKETS,
      registry,
    }),
    stepsPerRun: createUnlabeledHistogram({
      name: "steps_per_run",
      help: "Tool steps per run distribution (§22).",
      buckets: STEPS_PER_RUN_BUCKETS,
      registry,
    }),
    toolErrorsTotal: createLabeledCounter<{ readonly tool: string }>({
      name: "tool_errors_total",
      help: "Tool execution errors by tool; drives the tool error rate (§22).",
      labelNames: ["tool"],
      registry,
    }),
    validatorBlockersTotal: createUnlabeledCounter({
      name: "validator_blockers_total",
      help: "Deterministic validator blockers (§11.1; validator blocker rate §22).",
      registry,
    }),
    criticReviseTotal: createUnlabeledCounter({
      name: "critic_revise_total",
      help: "Vision-critic revise verdicts (§11.2; critic revise rate §22).",
      registry,
    }),
    creditsReservedTotal: createUnlabeledCounter({
      name: "credits_reserved_total",
      help: "Credits reserved for runs (§14.2 holds).",
      registry,
    }),
    creditsCommittedTotal: createUnlabeledCounter({
      name: "credits_committed_total",
      help: "Credits settled into runs (§14.2 commits).",
      registry,
    }),
    aiCostUsdPerDay: createLabeledCounter<{ readonly workspace: string }>({
      name: "ai_cost_usd_per_day",
      help: "AI provider spend in USD per workspace (§22 cost dashboards).",
      labelNames: ["workspace"],
      registry,
    }),
    tokensInTotal: createUnlabeledCounter({
      name: "tokens_in_total",
      help: "Model input tokens (§22 tokens in/out/cache).",
      registry,
    }),
    tokensOutTotal: createUnlabeledCounter({
      name: "tokens_out_total",
      help: "Model output tokens (§22 tokens in/out/cache).",
      registry,
    }),
    tokensCacheTotal: createUnlabeledCounter({
      name: "tokens_cache_total",
      help: "Cache-read tokens (§5.3 cache-hit tracking; §22).",
      registry,
    }),
    queueDepth: createUnlabeledGauge({
      name: "queue_depth",
      help: "Pending run jobs (RB-02 queue-age alerting context, §22).",
      registry,
    }),
    engineSessions: createLabeledGauge<{ readonly state: EngineSessionState }>({
      name: "engine_sessions",
      help: "Engine pool sessions by state (active/idle, ADR-0005 #7).",
      labelNames: ["state"],
      registry,
    }),
  };
}
