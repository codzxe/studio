/**
 * UsageMeters tests (M6-G) — the four quota meters (seats, storage, render
 * minutes, credits), D-12 µc conversion for the credits row, the ≥90% warning
 * and ≥100% exhausted states, §14 byte formatting, aria meter semantics,
 * hostile-input degradation. Deterministic RTL; no network.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UsageMeters, formatStorageBytes } from "./usage-meters";

const USER = userEvent.setup();

/** Starter-flavoured entitlements (D-12: allowance in integer µc). */
const ENTITLEMENTS = {
  seats: 2,
  storageBytes: 20 * 1024 ** 3, // 20 GiB
  renderMinutesPerMonth: 600,
  monthlyCreditAllowance: 500_000_000, // 500 credits in µc
};

// ---------------------------------------------------------------------------
// §14 byte formatting
// ---------------------------------------------------------------------------

describe("formatStorageBytes", () => {
  it("formats binary byte sizes with 1 decimal max (§14 '12.4 MB')", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(1024)).toBe("1 KB");
    expect(formatStorageBytes(13_000_000)).toBe("12.4 MB");
    expect(formatStorageBytes(20 * 1024 ** 3)).toBe("20 GB");
    expect(formatStorageBytes(1024 ** 4)).toBe("1 TB");
  });

  it("degrades hostile bytes to the em dash", () => {
    expect(formatStorageBytes(Number.NaN)).toBe("—");
    expect(formatStorageBytes(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatStorageBytes(-1)).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// The meters
// ---------------------------------------------------------------------------

describe("UsageMeters", () => {
  it("renders seats, storage, render minutes and credits with formatted values", () => {
    render(
      <UsageMeters
        usage={{
          seatsUsed: 1,
          storageUsedBytes: 13_000_000,
          renderMinutesUsed: 120,
          creditsUsedMicrocredits: 123_450_000, // 123.45 credits in µc
        }}
        entitlements={ENTITLEMENTS}
      />,
    );
    expect(screen.getByTestId("usage-meter-seats")).toHaveTextContent("1 / 2 seats");
    expect(screen.getByTestId("usage-meter-storage")).toHaveTextContent("12.4 MB of 20 GB");
    expect(screen.getByTestId("usage-meter-render")).toHaveTextContent("120 / 600 min");
    // D-12: credits render with exactly 2 decimals, comma-grouped.
    expect(screen.getByTestId("usage-meter-credits")).toHaveTextContent("123.45 of 500.00 credits");
    expect(screen.getByTestId("usage-meter-credits")).toHaveAttribute("data-state", "healthy");
  });

  it("marks the ≥90% warning state and the ≥100% exhausted state", () => {
    const seatsTen = { ...ENTITLEMENTS, seats: 10 };
    const { rerender } = render(
      <UsageMeters
        usage={{
          seatsUsed: 8,
          storageUsedBytes: 0,
          renderMinutesUsed: 0,
          creditsUsedMicrocredits: 0,
        }}
        entitlements={seatsTen}
      />,
    );
    expect(screen.getByTestId("usage-meter-seats")).toHaveAttribute("data-state", "healthy");

    rerender(
      <UsageMeters
        usage={{
          seatsUsed: 9,
          storageUsedBytes: 0,
          renderMinutesUsed: 0,
          creditsUsedMicrocredits: 0,
        }}
        entitlements={seatsTen}
      />,
    );
    const warning = screen.getByTestId("usage-meter-seats");
    expect(warning).toHaveAttribute("data-state", "warning");
    expect(warning).toHaveTextContent("Nearing limit");

    rerender(
      <UsageMeters
        usage={{
          seatsUsed: 10,
          storageUsedBytes: 0,
          renderMinutesUsed: 0,
          creditsUsedMicrocredits: 0,
        }}
        entitlements={seatsTen}
      />,
    );
    const exhausted = screen.getByTestId("usage-meter-seats");
    expect(exhausted).toHaveAttribute("data-state", "exhausted");
    expect(exhausted).toHaveTextContent("Seat limit reached");
  });

  it("drives the credits meter from integer µc (D-12) with quota-specific copy", () => {
    const { rerender } = render(
      <UsageMeters
        usage={{
          seatsUsed: 0,
          storageUsedBytes: 0,
          renderMinutesUsed: 0,
          creditsUsedMicrocredits: 1_800_000_000, // 90% of 2000 credits
        }}
        entitlements={{ ...ENTITLEMENTS, monthlyCreditAllowance: 2_000_000_000 }}
      />,
    );
    const credits = screen.getByTestId("usage-meter-credits");
    expect(credits).toHaveTextContent("1,800.00 of 2,000.00 credits");
    expect(credits).toHaveAttribute("data-state", "warning");

    rerender(
      <UsageMeters
        usage={{
          seatsUsed: 0,
          storageUsedBytes: 0,
          renderMinutesUsed: 0,
          creditsUsedMicrocredits: 2_000_000_000,
        }}
        entitlements={{ ...ENTITLEMENTS, monthlyCreditAllowance: 2_000_000_000 }}
      />,
    );
    const drained = screen.getByTestId("usage-meter-credits");
    expect(drained).toHaveAttribute("data-state", "exhausted");
    // Allowance copy, not "out of credits" — top-ups may still exist.
    expect(drained).toHaveTextContent("Allowance used");
  });

  it("wires the Buy-credits CTA on the credits row", async () => {
    const onTopUp = vi.fn();
    render(
      <UsageMeters
        usage={{
          seatsUsed: 0,
          storageUsedBytes: 0,
          renderMinutesUsed: 0,
          creditsUsedMicrocredits: 0,
        }}
        entitlements={ENTITLEMENTS}
        onTopUp={onTopUp}
      />,
    );
    await USER.click(screen.getByTestId("usage-topup"));
    expect(onTopUp).toHaveBeenCalledTimes(1);
    // Only the credits row carries the CTA.
    expect(screen.getAllByTestId("usage-topup").length).toBe(1);
  });

  it("exposes ARIA meter semantics and degrades hostile usage numbers", () => {
    render(
      <UsageMeters
        usage={{
          seatsUsed: Number.NaN,
          storageUsedBytes: Number.NaN,
          renderMinutesUsed: Number.NaN,
          creditsUsedMicrocredits: Number.NaN,
        }}
        entitlements={ENTITLEMENTS}
      />,
    );
    const meters = screen.getAllByRole("meter");
    expect(meters.length).toBe(4);
    const seats = screen.getByRole("meter", { name: "Seats used" });
    expect(seats).toHaveAttribute("aria-valuenow", "0");
    expect(seats).toHaveAttribute("aria-valuemax", "2");
    expect(seats).toHaveAttribute("aria-valuemin", "0");
    // Hostile values degrade to the em dash and never a "NaN" string.
    expect(document.body.textContent).not.toContain("NaN");
    const credits = screen.getByTestId("usage-meter-credits");
    expect(credits).toHaveTextContent("—");
    expect(credits).toHaveAttribute("data-state", "healthy");
  });
});
