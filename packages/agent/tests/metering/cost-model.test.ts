// W9-C — metering cost model: Appendix C rate table, exact micro-USD cost math,
// cache-read discount derivation, image costs, COGS margin checks, env override.
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_READ_PRICE_DENOMINATOR,
  CACHE_READ_PRICE_NUMERATOR,
  CREDIT_LIST_USD,
  GROSS_MARGIN_TARGET,
  MODEL_RATES,
  MeteringError,
  computeCost,
  hasModelRate,
  imageCost,
  margin,
  microToSafeNumber,
  parseModelRatesEnv,
  resolveModelRates,
  type ImageQuality,
} from "../../src/metering/cost-model.js";

/** Round-half-up reference in Number space (tests only — production path is bigint). */
function refMicro(tokensIn: number, tokensOut: number, cacheHits: number, inPerM: number, outPerM: number): number {
  const exact =
    ((tokensIn - cacheHits) * inPerM + (cacheHits * inPerM) / 10 + tokensOut * outPerM) / 1_000_000;
  return Math.round(exact); // same half-up as the bigint path
}

const FLASH_IN_PER_M = 750_000; // $0.75/M → micro-USD per 1M tokens
const FLASH_OUT_PER_M = 3_750_000; // $3.75/M

describe("W9-C cost model: Appendix C rate table", () => {
  it("pins every Appendix C text rate exactly (micro-USD per 1M tokens)", () => {
    // model → [input $/M, output $/M]
    const table: ReadonlyArray<[model: string, inUsd: number, outUsd: number]> = [
      ["gemini-3.8-flash", 0.75, 3.75],
      ["gemini-3.1-flash-lite", 0.25, 1.5],
      ["gemini-2.5-flash-lite", 0.1, 0.4],
      ["deepseek-v4.1-flash", 0.15, 0.6],
      ["claude-haiku-4.5", 1.0, 5.0],
      ["claude-sonnet-5.5", 2.0, 10.0],
      ["claude-opus-5.5", 4.0, 20.0],
      ["gpt-5.6-terra", 2.0, 12.0],
      ["gpt-5.6-luna", 0.2, 1.2],
      ["gpt-6-astra", 10.0, 50.0],
      ["groq-gpt-oss-120b", 0.15, 0.6],
    ];
    for (const [model, inUsd, outUsd] of table) {
      const rate = MODEL_RATES[model];
      expect(rate, model).toBeDefined();
      expect(rate?.kind).toBe("text");
      if (rate?.kind === "text") {
        expect(rate.inputMicroPerM).toBe(BigInt(Math.round(inUsd * 1_000_000)));
        expect(rate.outputMicroPerM).toBe(BigInt(Math.round(outUsd * 1_000_000)));
      }
    }
  });

  it("pins every Appendix C per-image rate (flux has no HD tier)", () => {
    const images: ReadonlyArray<[model: string, stdUsd: number, hdUsd: number | null]> = [
      ["flux-2-schnell", 0.015, null],
      ["gemini-3-pro-image", 0.035, 0.07],
      ["gpt-image-1.5", 0.04, 0.08],
    ];
    for (const [model, stdUsd, hdUsd] of images) {
      const rate = MODEL_RATES[model];
      expect(rate, model).toBeDefined();
      expect(rate?.kind).toBe("image");
      if (rate?.kind === "image") {
        expect(rate.imageMicroUsd).toBe(BigInt(Math.round(stdUsd * 1_000_000)));
        expect(rate.imageHdMicroUsd).toBe(hdUsd === null ? null : BigInt(Math.round(hdUsd * 1_000_000)));
      }
    }
  });

  it("covers every model id the §5.3 router routes (models.ts ids)", () => {
    const routed = [
      "gemini-2.5-flash-lite",
      "gemini-3.8-flash",
      "claude-sonnet-5.5",
      "claude-opus-5.5",
      "deepseek-v4.1-flash",
      "claude-haiku-4.5",
      "gpt-5.6-terra",
      "flux-2-schnell",
      "gemini-3-pro-image",
      "gpt-image-1.5",
    ];
    for (const model of routed) {
      expect(hasModelRate(model), model).toBe(true);
    }
  });

  it("the static table is frozen (wiring can never mutate Appendix C defaults)", () => {
    expect(Object.isFrozen(MODEL_RATES)).toBe(true);
  });
});

describe("W9-C cost model: computeCost math table (Flash $0.75 / $3.75)", () => {
  const cases: ReadonlyArray<
    [label: string, tokensIn: number, tokensOut: number, cacheHits: number, expected: bigint]
  > = [
    ["1M in, 0 out → exactly $0.75", 1_000_000, 0, 0, 750_000n],
    ["0 in, 1M out → exactly $3.75", 0, 1_000_000, 0, 3_750_000n],
    ["100k in / 10k out, no cache → $0.1125", 100_000, 10_000, 0, 112_500n],
    ["80k in / 5k out, no cache (§5.2 standard tier) → $0.07875", 80_000, 5_000, 0, 78_750n],
    [
      "80k in (60% cache-hit) / 5k out → $0.04635 pre-buffer",
      80_000,
      5_000,
      48_000,
      46_350n,
    ],
    ["all input cached → 10% of input price (90% discount)", 100_000, 0, 100_000, 7_500n],
    ["zero usage → zero cost", 0, 0, 0, 0n],
  ];
  for (const [label, tokensIn, tokensOut, cacheHits, expected] of cases) {
    it(label, () => {
      expect(
        computeCost({ model: "gemini-3.8-flash", tokensIn, tokensOut, cacheHits }),
      ).toBe(expected);
    });
  }

  it("cost math table agrees with the float reference on every row", () => {
    for (const [, tokensIn, tokensOut, cacheHits] of cases) {
      const micro = Number(computeCost({ model: "gemini-3.8-flash", tokensIn, tokensOut, cacheHits }));
      expect(micro).toBe(refMicro(tokensIn, tokensOut, cacheHits, FLASH_IN_PER_M, FLASH_OUT_PER_M));
    }
  });

  it("rounds half-up to the nearest micro-USD (documented precision choice)", () => {
    // 1 input token @ $0.75/M = 0.75 µ$ exactly → rounds UP to 1.
    expect(computeCost({ model: "gemini-3.8-flash", tokensIn: 1, tokensOut: 0 })).toBe(1n);
    // 2 input tokens = 1.5 µ$ → 2; 1 output token @ $3.75/M = 3.75 µ$ → 4.
    expect(computeCost({ model: "gemini-3.8-flash", tokensIn: 2, tokensOut: 0 })).toBe(2n);
    expect(computeCost({ model: "gemini-3.8-flash", tokensIn: 0, tokensOut: 1 })).toBe(4n);
  });

  it("cache reads are billed at CACHE_READ_PRICE 1/10 of the input rate", () => {
    expect(CACHE_READ_PRICE_NUMERATOR).toBe(1n);
    expect(CACHE_READ_PRICE_DENOMINATOR).toBe(10n);
    const full = computeCost({ model: "gemini-3.8-flash", tokensIn: 50_000, tokensOut: 0 });
    const cached = computeCost({
      model: "gemini-3.8-flash",
      tokensIn: 50_000,
      tokensOut: 0,
      cacheHits: 50_000,
    });
    expect(cached * 10n).toBe(full);
  });

  it("reproduces the Appendix C budget-assumption figures (60% cache + 20% buffer)", () => {
    // standard run 80k in / 5k out, 60% cache-hit; ×1.2 buffer lands on the
    // published $0.056 / $0.148 / $0.297 — the derivation behind the 90% cache
    // discount (see cost-model.ts header note 3).
    const models: ReadonlyArray<[model: string, baseMicro: bigint, publishedUsd: number]> = [
      ["gemini-3.8-flash", 46_350n, 0.056],
      ["claude-sonnet-5.5", 123_600n, 0.148],
      ["claude-opus-5.5", 247_200n, 0.297],
    ];
    for (const [model, baseMicro, publishedUsd] of models) {
      const base = computeCost({ model, tokensIn: 80_000, tokensOut: 5_000, cacheHits: 48_000 });
      expect(base).toBe(baseMicro);
      const withBuffer = Number(base) * 1.2 / 1_000_000; // USD
      expect(Math.abs(withBuffer - publishedUsd)).toBeLessThan(0.0005);
    }
  });

  it("refuses unknown models instead of silently pricing $0", () => {
    expect(() => computeCost({ model: "totally-unknown-model", tokensIn: 1, tokensOut: 1 })).toThrowError(
      MeteringError,
    );
    try {
      computeCost({ model: "totally-unknown-model", tokensIn: 1, tokensOut: 1 });
    } catch (error) {
      expect((error as MeteringError).code).toBe("model_rate_missing");
      expect((error as MeteringError).message).toContain("[metering]");
    }
  });

  it("refuses image models in computeCost and text models in imageCost", () => {
    expect(() => computeCost({ model: "flux-2-schnell", tokensIn: 1, tokensOut: 1 })).toThrowError(
      MeteringError,
    );
    try {
      computeCost({ model: "flux-2-schnell", tokensIn: 1, tokensOut: 1 });
    } catch (error) {
      expect((error as MeteringError).code).toBe("model_kind_mismatch");
    }
    expect(() => imageCost("gemini-3.8-flash", "standard")).toThrowError(MeteringError);
    try {
      imageCost("gemini-3.8-flash", "standard");
    } catch (error) {
      expect((error as MeteringError).code).toBe("model_kind_mismatch");
    }
  });

  it("validates usage counters (money path): negatives, fractions, cache > in", () => {
    const bad: ReadonlyArray<() => unknown> = [
      () => computeCost({ model: "gemini-3.8-flash", tokensIn: -1, tokensOut: 0 }),
      () => computeCost({ model: "gemini-3.8-flash", tokensIn: 1.5, tokensOut: 0 }),
      () => computeCost({ model: "gemini-3.8-flash", tokensIn: 10, tokensOut: 0, cacheHits: 11 }),
      () => computeCost({ model: "gemini-3.8-flash", tokensIn: 1e21, tokensOut: 0 }), // > MAX_SAFE
    ];
    for (const call of bad) {
      try {
        call();
        expect.unreachable("invalid usage must throw");
      } catch (error) {
        expect((error as MeteringError).code).toBe("invalid_usage");
      }
    }
  });
});

describe("W9-C cost model: imageCost (Appendix C $ per image + §5.2 credits)", () => {
  const cases: ReadonlyArray<
    [model: string, quality: ImageQuality, micro: bigint, credits: 1 | 2]
  > = [
    ["flux-2-schnell", "standard", 15_000n, 1],
    ["gemini-3-pro-image", "standard", 35_000n, 1],
    ["gemini-3-pro-image", "hd", 70_000n, 2],
    ["gpt-image-1.5", "standard", 40_000n, 1],
    ["gpt-image-1.5", "hd", 80_000n, 2],
  ];
  for (const [model, quality, micro, credits] of cases) {
    it(`${model} ${quality} → ${micro} µ$ / ${credits} §5.2 credit(s)`, () => {
      const result = imageCost(model, quality);
      expect(result.microUsd).toBe(micro);
      expect(result.credits).toBe(credits);
    });
  }

  it("refuses HD from draft-only models (§5.2: HD is Gemini/GPT Image class)", () => {
    try {
      imageCost("flux-2-schnell", "hd");
      expect.unreachable("flux HD must be refused");
    } catch (error) {
      expect((error as MeteringError).code).toBe("image_hd_unsupported");
    }
  });

  it("refuses unknown image models and bad quality", () => {
    expect(() => imageCost("no-such-image-model", "standard")).toThrowError(MeteringError);
    expect(() => imageCost("flux-2-schnell", "ultra" as ImageQuality)).toThrowError(MeteringError);
  });
});

describe("W9-C cost model: COGS margin vs the §0 60–75% target", () => {
  it("targets and credit price are the §0/Appendix D constants", () => {
    expect(GROSS_MARGIN_TARGET).toEqual({ min: 0.6, max: 0.75 });
    expect(CREDIT_LIST_USD).toBe(0.1);
  });

  it("standard Flash run (≈$0.056 COGS, 2 credits = $0.20) sits inside the target", () => {
    const check = margin(0.0556, 2);
    expect(check.zone).toBe("in_target");
    expect(check.revenueUsd).toBeCloseTo(0.2, 10);
    expect(check.cogsRatio).toBeCloseTo(0.278, 3);
    expect(check.grossMargin).toBeCloseTo(0.722, 3);
  });

  it("classifies cheap and expensive runs against the band", () => {
    expect(margin(0.03, 2).zone).toBe("above_target");
    expect(margin(0.09, 2).zone).toBe("below_target");
    // boundary semantics: 60% margin exactly is in-band; 75% exactly is in-band
    expect(margin(0.08, 2).zone).toBe("in_target");
  });

  it("§5.2 image tiers: gemini HD is in-band, flux drafts are above-band", () => {
    const hd = imageCost("gemini-3-pro-image", "hd");
    expect(margin(Number(hd.microUsd) / 1e6, hd.credits).zone).toBe("in_target");
    const draft = imageCost("flux-2-schnell", "standard");
    expect(margin(Number(draft.microUsd) / 1e6, draft.credits).zone).toBe("above_target");
  });

  it("degenerate conventions: 0-credit runs (pinned, documented)", () => {
    const free = margin(0, 0);
    expect(free.grossMargin).toBe(1);
    expect(free.zone).toBe("in_target");
    const underwater = margin(0.01, 0);
    expect(underwater.grossMargin).toBe(Number.NEGATIVE_INFINITY);
    expect(underwater.cogsRatio).toBe(Number.POSITIVE_INFINITY);
    expect(underwater.zone).toBe("below_target");
  });

  it("validates margin inputs", () => {
    expect(() => margin(-0.01, 2)).toThrowError(MeteringError);
    expect(() => margin(Number.NaN, 2)).toThrowError(MeteringError);
    expect(() => margin(0.01, 1.5)).toThrowError(MeteringError);
    expect(() => margin(0.01, -1)).toThrowError(MeteringError);
  });
});

describe("W9-C cost model: MODEL_RATES_JSON env override", () => {
  it("absent / empty env → empty overrides", () => {
    expect(parseModelRatesEnv(undefined)).toEqual({ ok: true, overrides: {} });
    expect(parseModelRatesEnv("  ")).toEqual({ ok: true, overrides: {} });
  });

  it("garbage JSON → typed invalid envelope, never a throw", () => {
    const result = parseModelRatesEnv("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("model_rates_env_invalid");
      expect(result.hint.length).toBeGreaterThan(0);
    }
  });

  it("schema-invalid rows (negative rates, missing fields) are rejected", () => {
    for (const raw of [
      '{"gemini-3.8-flash":{"kind":"text","inputUsdPerM":-1,"outputUsdPerM":7.5}}',
      '{"gemini-3.8-flash":{"kind":"text","inputUsdPerM":1.5}}',
      '{"gemini-3.8-flash":{"inputUsdPerM":1.5,"outputUsdPerM":7.5}}',
      '{"":{"kind":"text","inputUsdPerM":1,"outputUsdPerM":1}}',
    ]) {
      const result = parseModelRatesEnv(raw);
      expect(result.ok).toBe(false);
    }
  });

  it("resolveModelRates merges overrides without mutating the static table", () => {
    const rates = resolveModelRates({
      MODEL_RATES_JSON: '{"gemini-3.8-flash":{"kind":"text","inputUsdPerM":1.5,"outputUsdPerM":7.5}}',
    });
    expect(computeCost({ model: "gemini-3.8-flash", tokensIn: 1_000_000, tokensOut: 0 }, rates)).toBe(
      1_500_000n, // 2027-01-01 doubled rates (Appendix C note)
    );
    // default untouched:
    expect(computeCost({ model: "gemini-3.8-flash", tokensIn: 1_000_000, tokensOut: 0 })).toBe(750_000n);
    expect(rates).not.toBe(MODEL_RATES);
    expect(Object.isFrozen(rates)).toBe(true);
  });

  it("overrides can ADD new model ids (no deploy needed for a new model)", () => {
    const rates = resolveModelRates({
      MODEL_RATES_JSON: '{"new-model-x":{"kind":"text","inputUsdPerM":1,"outputUsdPerM":2}}',
    });
    expect(hasModelRate("new-model-x", rates)).toBe(true);
    expect(computeCost({ model: "new-model-x", tokensIn: 1_000_000, tokensOut: 1_000_000 }, rates)).toBe(
      3_000_000n,
    );
  });

  it("image overrides work, including removing/adding HD", () => {
    const rates = resolveModelRates({
      MODEL_RATES_JSON: '{"flux-2-schnell":{"kind":"image","imageUsd":0.02,"imageHdUsd":0.04}}',
    });
    expect(imageCost("flux-2-schnell", "standard", rates).microUsd).toBe(20_000n);
    expect(imageCost("flux-2-schnell", "hd", rates).microUsd).toBe(40_000n); // override grants HD
  });

  it("resolveModelRates fails fast on garbage env (money must not be mispriced)", () => {
    expect(() => resolveModelRates({ MODEL_RATES_JSON: "{oops" })).toThrowError(MeteringError);
    try {
      resolveModelRates({ MODEL_RATES_JSON: "{oops" });
    } catch (error) {
      expect((error as MeteringError).code).toBe("model_rates_env_invalid");
    }
  });

  it("reads process.env by default (injected for determinism in tests)", () => {
    const hadKey = Object.hasOwn(process.env, "MODEL_RATES_JSON");
    const previousRates = hadKey ? process.env.MODEL_RATES_JSON : undefined;
    process.env.MODEL_RATES_JSON =
      '{"gemini-2.5-flash-lite":{"kind":"text","inputUsdPerM":0.2,"outputUsdPerM":0.8}}';
    try {
      const rates = resolveModelRates();
      expect(
        computeCost({ model: "gemini-2.5-flash-lite", tokensIn: 1_000_000, tokensOut: 0 }, rates),
      ).toBe(200_000n);
    } finally {
      if (hadKey) {
        process.env.MODEL_RATES_JSON = previousRates;
      } else {
        delete process.env.MODEL_RATES_JSON;
      }
    }
  });
});

describe("W9-C cost model: bigint→number conversion guard", () => {
  it("converts safe values", () => {
    expect(microToSafeNumber(0n)).toBe(0);
    expect(microToSafeNumber(750_000n)).toBe(750_000);
    expect(microToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("refuses values above Number.MAX_SAFE_INTEGER (money never wraps)", () => {
    try {
      microToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
      expect.unreachable("overflow must throw");
    } catch (error) {
      expect((error as MeteringError).code).toBe("unsafe_number_conversion");
    }
  });
});

afterEach(() => {
  // Belt-and-braces: no test may leak MODEL_RATES_JSON into other suites.
  if (Object.hasOwn(process.env, "MODEL_RATES_JSON")) {
    delete process.env.MODEL_RATES_JSON;
  }
});
