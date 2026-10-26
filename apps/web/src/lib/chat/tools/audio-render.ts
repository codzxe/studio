/**
 * studio.render_audio — audio-from-code, client-executed
 * (round-12 "Tool catalog v3"; research/round12-design.md +
 * research/ecosystem-2026.md §1).
 *
 * The model writes JavaScript synthesis code; this module renders it OFFLINE
 * with Tone.js (`Tone.Offline` — faster than real time, via an
 * OfflineAudioContext), encodes the AudioBuffer to a 16-bit PCM WAV
 * (audiobuffer-to-wav) and uploads it through the EXISTING asset seam
 * (the api-client's two-phase assets flow: descriptor → signed-URL PUT →
 * verify). The result is `{ assetId, url, durationSeconds }` — the model then
 * places the asset on a layer via later proposal steps. NOTHING in the
 * composition changes here (kind "read": generative, not a write tool).
 *
 * THE HARNESS CONTRACT (pinned — the exact environment the model's code runs
 * under; the system prompt describes it, tests fake it):
 *
 *   const userProgram = new Function(
 *     "Tone",
 *     "\"use strict\";\nreturn (async () => {\n" + code + "\n})();",
 *   );
 *   const buffer = await Tone.Offline(async () => {
 *     await userProgram(Tone);   // the imported Tone 15 namespace
 *   }, duration, 2, 44_100);
 *
 *  - `Tone` is the real Tone.js 15 module namespace, dynamically imported
 *    (lazy, inside execute — Tone never rides the main bundle chunk);
 *  - the user code is the BODY of a function whose ONLY binding is `Tone`,
 *    wrapped in `"use strict"` + an async IIFE so both `const synth = new
 *    Tone.PolySynth(...).toDestination(); synth.triggerAttackRelease(...)`
 *    and `await`-ing code run; the code sees NO other globals of ours (it
 *    still lives in the page's realm — this is a synthesis sandbox with
 *    bounds + timeout, not a security sandbox; it renders audio, never the
 *    canvas);
 *  - it executes INSIDE `Tone.Offline(callback, duration, channels,
 *    sampleRate)` — Tone swaps the global context to the OfflineContext for
 *    the callback, so everything the code schedules renders into the offline
 *    buffer; `duration` = the tool's `duration` arg (default 10 s), channels
 *    2, sample rate 44 100 (design pins);
 *  - the whole render races a 20 s timeout (`AbortSignal.timeout`); a render
 *    that exceeds it abandons the result and fails
 *    RENDER_AUDIO_FAILED honestly. A synchronous infinite loop in the code
 *    blocks the main thread and outlives the race — the documented
 *    Worker-free trade-off (bounds: code ≤ 20 000 chars, duration 0.1–60 s).
 *
 * Upload seam: `client.assets.createDescriptor` (sha256 dedupe, §9.2 content
 * addressing) → `PUT` the WAV bytes to the signed URL →
 * `client.assets.complete` (the gateway's magic-byte verify) →
 * `client.assets.getUrl` for the short-lived download URL the result carries.
 *
 * Testability: the Tone path is browser-only, so the harness is INJECTABLE
 * (`AudioRenderHarness`); the executor's deps accept an override and the
 * tests drive a fake that answers with synthetic WAV bytes. The real harness
 * (`toneAudioHarness`) is the default and only runs in the browser.
 */

import { sha256Hex } from "@/lib/editor-session";
import type { ApiClient } from "@studio/api-client";
import { isApiError } from "@studio/api-client";

import { ClientToolError, isClientToolError } from "./client-tool-error";

// ---------------------------------------------------------------------------
// Bounds (mirrored from @studio/contracts tools.ts — the tool args schema is
// validated by the executor via the api-client chat-tools seam before this
// module runs; these are the harness's own hard stops)
// ---------------------------------------------------------------------------

/** Default render length when the call names no `duration` (seconds). */
export const DEFAULT_AUDIO_DURATION_SECONDS = 10;
/** Design pin: 44.1 kHz stereo (research/round12-design.md). */
export const AUDIO_SAMPLE_RATE = 44_100;
export const AUDIO_CHANNELS = 2;
/** Design pin: the whole offline render races a 20 s timeout. */
export const AUDIO_RENDER_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// The injectable harness
// ---------------------------------------------------------------------------

/** The model-issued synthesis program (already args-validated upstream). */
export interface AudioRenderInput {
  readonly code: string;
  readonly durationSeconds: number;
}

/** What a successful render yields (WAV bytes + the honest render facts). */
export interface AudioRenderOutput {
  /** 16-bit PCM WAV bytes (audiobuffer-to-wav encoding). */
  readonly wav: Uint8Array;
  /** The rendered AudioBuffer's duration — what the tool result reports. */
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channels: number;
}

/**
 * The render seam. `toneAudioHarness` (below) is the production
 * implementation; tests inject a fake (the real Tone path only runs in the
 * browser — jsdom has no OfflineAudioContext).
 */
export interface AudioRenderHarness {
  render(input: AudioRenderInput, signal: AbortSignal): Promise<AudioRenderOutput>;
}

/**
 * The production Tone.js 15 harness (the pinned contract, see the module
 * header). `import("tone")` and `import("audiobuffer-to-wav")` are DYNAMIC
 * and happen per render — Tone stays out of every bundle chunk that does not
 * render audio.
 */
export const toneAudioHarness: AudioRenderHarness = {
  async render(input, signal): Promise<AudioRenderOutput> {
    const Tone = await import("tone");
    const audioBufferToWav = (await import("audiobuffer-to-wav")).default;

    // The model's code = the body of a Function whose only binding is `Tone`.
    // The async IIFE wrapper accepts both sync scheduling and `await` code.
    const userProgram = new Function(
      "Tone",
      `"use strict";\nreturn (async () => {\n${input.code}\n})();`,
    ) as (tone: unknown) => Promise<unknown>;

    // Tone.Offline swaps the global context to the OfflineContext for the
    // callback, so the Tone namespace the code receives schedules into the
    // offline buffer. The callback's own context argument is not needed.
    const buffer = await Tone.Offline(
      async () => {
        await userProgram(Tone);
      },
      input.durationSeconds,
      AUDIO_CHANNELS,
      AUDIO_SAMPLE_RATE,
    );
    if (signal.aborted) {
      throw new ClientToolError(
        "RENDER_AUDIO_FAILED",
        "The audio render was abandoned before it finished.",
      );
    }
    const audio: AudioBuffer | undefined = buffer.get();
    if (
      audio === undefined ||
      audio === null ||
      typeof audio.duration !== "number" ||
      audio.duration <= 0
    ) {
      throw new ClientToolError(
        "RENDER_AUDIO_FAILED",
        "The synthesis code produced no audio. Schedule at least one source (e.g. a synth triggered with triggerAttackRelease) inside the render.",
      );
    }
    const wav = audioBufferToWav(audio);
    return {
      wav: new Uint8Array(wav),
      durationSeconds: audio.duration,
      sampleRate: audio.sampleRate,
      channels: audio.numberOfChannels,
    };
  },
};

// ---------------------------------------------------------------------------
// The 20 s render race
// ---------------------------------------------------------------------------

async function renderWithTimeout(
  harness: AudioRenderHarness,
  input: AudioRenderInput,
  timeoutMs: number,
): Promise<AudioRenderOutput> {
  // AbortSignal.timeout keeps the honest "still rendering" cut-off even if
  // the harness itself never rejects on its own.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await harness.render(input, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ClientToolError(
        "RENDER_AUDIO_FAILED",
        `The audio render did not finish within ${Math.round(timeoutMs / 1000)} seconds. Shorten the code or the duration.`,
      );
    }
    if (isClientToolError(error)) throw error; // already the honest typed failure
    if (isApiError(error)) {
      throw new ClientToolError("RENDER_AUDIO_FAILED", error.message);
    }
    throw new ClientToolError(
      "RENDER_AUDIO_FAILED",
      error instanceof Error && error.message.length > 0
        ? `The audio code failed: ${error.message}`
        : "The audio code failed.",
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Upload (the existing two-phase asset seam, §9.2/§12.3)
// ---------------------------------------------------------------------------

export interface AudioAssetUploadResult {
  readonly assetId: string;
  readonly url: string;
  readonly durationSeconds: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly name: string;
}

/** The assets slice the render needs (the api-client's real surface). */
export interface AudioAssetsClient {
  readonly assets: {
    createDescriptor(
      body: {
        readonly name: string;
        readonly mime: string;
        readonly sizeBytes: number;
        readonly sha256: string;
        readonly width?: number;
        readonly height?: number;
        readonly durationTicks?: number;
      },
      options?: { readonly idempotencyKey?: string },
    ): Promise<{
      readonly asset: { readonly id: string };
      readonly upload: {
        readonly url: string;
        readonly method: "PUT";
        readonly headers: Readonly<Record<string, string>>;
      } | null;
      readonly duplicate?: boolean;
    }>;
    complete(id: string, options?: { readonly idempotencyKey?: string }): Promise<unknown>;
    getUrl(
      id: string,
      options?: { readonly signal?: AbortSignal },
    ): Promise<{ readonly url: string }>;
  };
}

/** Upload failure → the typed RENDER_AUDIO_FAILED (the run continues). */
function uploadError(error: unknown): ClientToolError {
  const message = isApiError(error)
    ? error.message
    : error instanceof Error && error.message.length > 0
      ? error.message
      : "uploading the WAV asset failed";
  return new ClientToolError("RENDER_AUDIO_FAILED", `The clip rendered, but ${message}`);
}

// ---------------------------------------------------------------------------
// The tool body
// ---------------------------------------------------------------------------

export interface RenderAudioArgs {
  readonly name: string;
  readonly code: string;
  readonly duration?: number;
}

/**
 * studio.render_audio end-to-end: render → WAV → two-phase asset upload →
 * `{ assetId, url, durationSeconds, … }`. Every failure (bad code, timeout,
 * upload) is one honest typed ClientToolError; the tool NEVER mutates the
 * composition.
 */
export async function renderAudioAsset(
  args: RenderAudioArgs,
  deps: {
    readonly client: AudioAssetsClient | ApiClient;
    readonly harness?: AudioRenderHarness;
    /** Signed-URL PUT transport (tests); defaults to the global fetch. */
    readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
    /** Render-timeout override (tests); default {@link AUDIO_RENDER_TIMEOUT_MS}. */
    readonly renderTimeoutMs?: number;
  },
): Promise<AudioAssetUploadResult> {
  const harness = deps.harness ?? toneAudioHarness;
  const client = deps.client as AudioAssetsClient;

  const rendered = await renderWithTimeout(
    harness,
    {
      code: args.code,
      durationSeconds: args.duration === undefined ? DEFAULT_AUDIO_DURATION_SECONDS : args.duration,
    },
    deps.renderTimeoutMs ?? AUDIO_RENDER_TIMEOUT_MS,
  );

  const assetName = `${args.name}.wav`;
  const sha256 = await sha256Hex(rendered.wav);

  // 1. Descriptor (sha256 dedupe — a repeated render of the same bytes
  //    returns the existing row with upload: null).
  let descriptor: Awaited<ReturnType<typeof client.assets.createDescriptor>>;
  try {
    descriptor = await client.assets.createDescriptor({
      name: assetName,
      mime: "audio/wav",
      sizeBytes: rendered.wav.byteLength,
      sha256,
      // duration_ticks is nanoseconds (schema.ts bigint-mode number).
      durationTicks: Math.round(rendered.durationSeconds * 1_000_000_000),
    });
  } catch (error) {
    throw uploadError(error);
  }

  // 2. PUT the bytes to the signed URL (no auth headers — the URL carries
  //    its own credentials, §9.2; the session-client download precedent).
  if (descriptor.upload !== null) {
    const fetchImpl = deps.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
    try {
      const put = await fetchImpl(descriptor.upload.url, {
        method: "PUT",
        headers: { ...descriptor.upload.headers },
        body: rendered.wav as unknown as BodyInit,
      });
      if (!put.ok) {
        throw uploadError(new Error(`the asset upload failed (HTTP ${put.status})`));
      }
    } catch (error) {
      if (error instanceof ClientToolError) throw error;
      throw uploadError(error);
    }
    // 3. Verify (the gateway magic-byte-sniffs the object head).
    try {
      await client.assets.complete(descriptor.asset.id);
    } catch (error) {
      throw uploadError(error);
    }
  }

  // 4. The short-lived download URL the tool result carries.
  let url: string;
  try {
    const signed = await client.assets.getUrl(descriptor.asset.id);
    url = signed.url;
  } catch (error) {
    throw uploadError(error);
  }

  return {
    assetId: descriptor.asset.id,
    url,
    durationSeconds: rendered.durationSeconds,
    sampleRate: rendered.sampleRate,
    channels: rendered.channels,
    name: assetName,
  };
}
