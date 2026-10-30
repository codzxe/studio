// SEC-05 — IPv6 /64 normalization for rate-limit keys (stub suite).
//
// A /64 is the standard ISP delegation; pre-fix, one attacker cycling host
// bits minted an unbounded number of fresh (ip, route-class) limiter buckets
// (and scrypt share-password gates). Every host inside one /64 must now
// share EXACTLY ONE bucket; IPv4, IPv4-mapped and unparseable values pass
// through untouched.

import { describe, expect, it } from "vitest";

import { Hono } from "hono";

import type { AppBindings } from "../src/context.js";
import { clientIp, normalizeRateLimitIp } from "../src/middleware.js";

describe("normalizeRateLimitIp (SEC-05)", () => {
  it("collapses every host inside one /64 to a single canonical key", () => {
    const prefix = normalizeRateLimitIp("2001:db8:abcd:0012::1");
    for (const host of [
      "2001:db8:abcd:12::1",
      "2001:db8:abcd:12::dead:beef",
      "2001:0db8:abcd:0012:0:0:0:ffff",
      "2001:db8:abcd:12:ffff:ffff:ffff:ffff",
    ]) {
      expect(normalizeRateLimitIp(host)).toBe(prefix);
    }
    expect(prefix).toBe("2001:db8:abcd:12::/64");
  });

  it("different /64s keep different buckets", () => {
    expect(normalizeRateLimitIp("2001:db8:abcd:12::1")).not.toBe(
      normalizeRateLimitIp("2001:db8:abcd:13::1"),
    );
  });

  it("IPv4 passes through untouched (per-address buckets, as before)", () => {
    for (const v4 of ["203.0.113.7", "198.51.100.42", "10.0.0.1"]) {
      expect(normalizeRateLimitIp(v4)).toBe(v4);
    }
  });

  it("IPv4-mapped IPv6 passes through per-address (never merges clients)", () => {
    expect(normalizeRateLimitIp("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.7");
    expect(normalizeRateLimitIp("::ffff:203.0.113.8")).toBe("::ffff:203.0.113.8");
  });

  it("loopback and all-zero forms normalize without throwing", () => {
    expect(normalizeRateLimitIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeRateLimitIp("::")).toBe("0:0:0:0::/64");
  });

  it("link-local zones are stripped before normalizing", () => {
    expect(normalizeRateLimitIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(normalizeRateLimitIp("fe80::2%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("unparseable junk passes through untouched (fail to the old posture)", () => {
    for (const junk of ["unknown", "", "not-an-ip", "256.256.256.256"]) {
      expect(normalizeRateLimitIp(junk)).toBe(junk);
    }
  });
});

describe("clientIp (SEC-05 integration)", () => {
  const app = new Hono<AppBindings>();
  app.get("/echo-ip", (c) => c.text(clientIp(c)));

  it("normalizes the trusted last XFF hop (IPv6 → /64)", async () => {
    const response = await app.request("/echo-ip", {
      headers: { "x-forwarded-for": "2001:db8::1, 2001:db8:abcd:12::77" },
    });
    expect(await response.text()).toBe("2001:db8:abcd:12::/64");
  });

  it("still reads the LAST hop only (AUD-A6 spoof stays dead)", async () => {
    const response = await app.request("/echo-ip", {
      headers: { "x-forwarded-for": "2001:db8:dead:beef::1, 203.0.113.9" },
    });
    expect(await response.text()).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip (normalized) and then 'unknown'", async () => {
    const real = await app.request("/echo-ip", { headers: { "x-real-ip": "2001:db8:a::5" } });
    expect(await real.text()).toBe("2001:db8:a:0::/64");
    const none = await app.request("/echo-ip");
    expect(await none.text()).toBe("unknown");
  });
});
