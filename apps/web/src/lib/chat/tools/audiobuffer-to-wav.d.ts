declare module "audiobuffer-to-wav" {
  /**
   * audiobuffer-to-wav@1.0.0 (MIT) ships no types; this mirrors index.js:
   * encode an AudioBuffer to a 16-bit PCM WAV ArrayBuffer (32-bit float when
   * `opt.float32` is set — the harness never sets it).
   */
  export default function audioBufferToWav(
    buffer: AudioBuffer,
    opt?: { float32?: boolean },
  ): ArrayBuffer;
}
