import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

/** Skeleton is decorative chrome — query by container, never by role. */
function renderSkeleton(className?: string) {
  const { container } = render(
    <div>
      <Skeleton className={className} data-testid="skeleton-under-test" />
    </div>,
  );
  const skeleton = container.querySelector('[data-testid="skeleton-under-test"]');
  if (!skeleton) throw new Error("skeleton not rendered");
  return { skeleton, container };
}

describe("Skeleton (§7.13)", () => {
  it("is hidden from the accessibility tree — it never announces “loading” itself", () => {
    const { skeleton } = renderSkeleton();
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    // role="none" is implicit with aria-hidden; there must be no accessible text.
    expect(skeleton.textContent).toBe("");
  });

  it("shimmers via a transform-safe overlay at 6% opacity (§7.13: 1.4s, reduced-motion aware)", () => {
    const { skeleton } = renderSkeleton();
    const shimmer = skeleton.querySelector("span");
    expect(shimmer).not.toBeNull();
    expect(shimmer?.className).toContain("animate-shimmer");
    expect(shimmer?.className).toContain("opacity-[0.06]");
  });

  it("uses the 1px radius + elevated surface so it reads as “unfinished content”", () => {
    const { skeleton } = renderSkeleton();
    expect(skeleton.className).toContain("rounded-[1px]");
    expect(skeleton.className).toContain("bg-elevated");
  });

  it("preserves final layout dimensions via className (no shift when content lands)", () => {
    const { skeleton } = renderSkeleton("h-4 w-full");
    expect(skeleton.className).toContain("h-4");
    expect(skeleton.className).toContain("w-full");
  });
});
