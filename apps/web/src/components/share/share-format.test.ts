/**
 * Share-page pure helpers (§M7 task 5): tick math, review timecodes, the
 * manifest preview picker and the D-10 guest-identity storage seam.
 */

import { describe, expect, it } from "vitest";

import {
  GUEST_IDENTITY_STORAGE_KEY,
  type GuestIdentity,
  TICKS_PER_SECOND,
  formatSeconds,
  loadGuestIdentity,
  looksLikeEmail,
  saveGuestIdentity,
  secondsFromTicks,
  ticksFromSeconds,
} from "./share-format";

/** Minimal storage double (the seam only needs getItem/setItem). */
function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("share time units", () => {
  it("matches the engine's ticks-per-second constant", () => {
    // editor/crates/time/src/lib.rs n_PER_SECOND — mirrored, never invented.
    expect(TICKS_PER_SECOND).toBe(254_016_000_000);
  });

  it("round-trips seconds ↔ ticks", () => {
    const ticks = ticksFromSeconds(12.5);
    expect(ticks).toBe(Math.round(12.5 * TICKS_PER_SECOND));
    expect(secondsFromTicks(ticks)).toBeCloseTo(12.5, 6);
  });
});

describe("formatSeconds", () => {
  it("formats one-decimal review timecodes", () => {
    expect(formatSeconds(0)).toBe("0.0s");
    expect(formatSeconds(12.34)).toBe("12.3s");
  });

  it("clamps hostile input (NaN/negative) to a safe readout", () => {
    expect(formatSeconds(Number.NaN)).toBe("0.0s");
    expect(formatSeconds(-3)).toBe("0.0s");
  });
});

describe("guest identity storage (D-10)", () => {
  it("saves and reloads a reviewer's name/email under the literal key", () => {
    const storage = fakeStorage();
    const identity: GuestIdentity = { name: "Alex Jordan", email: "alex@example.com" };
    saveGuestIdentity(storage, identity);

    const raw = storage.getItem(GUEST_IDENTITY_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "{}")).toEqual(identity);
    expect(loadGuestIdentity(storage)).toEqual(identity);
  });

  it("reads missing, corrupt and non-object values as empty (never throws)", () => {
    expect(loadGuestIdentity(fakeStorage())).toEqual({ name: "", email: "" });
    expect(loadGuestIdentity(fakeStorage({ [GUEST_IDENTITY_STORAGE_KEY]: "not json" }))).toEqual({
      name: "",
      email: "",
    });
    expect(loadGuestIdentity(fakeStorage({ [GUEST_IDENTITY_STORAGE_KEY]: "[1,2,3]" }))).toEqual({
      name: "",
      email: "",
    });
  });

  it("swallows write failures (private-mode quota) — convenience only", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveGuestIdentity(throwing, { name: "n", email: "e" })).not.toThrow();
  });
});

describe("looksLikeEmail", () => {
  it("accepts plain shapes and rejects hostile or empty ones", () => {
    expect(looksLikeEmail("reviewer@example.com")).toBe(true);
    expect(looksLikeEmail("")).toBe(false);
    expect(looksLikeEmail("nope")).toBe(false);
    expect(looksLikeEmail("a b@example.com")).toBe(false);
  });
});
