/**
 * Share route-group layout tests (§M7 task 5): the group is PUBLIC chrome —
 * no auth surfaces, no marketing header/footer — and its metadata keeps
 * review links out of indexes (noindex/nofollow; the title stays generic so
 * the project name never reaches a crawler).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ShareLayout, { metadata } from "./layout";

describe("share layout", () => {
  it("marks the whole group noindex/nofollow (a review link is not a page to index)", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("uses a generic title/description — no project names for crawlers", () => {
    expect(metadata.title).toBe("Shared review");
    expect(metadata.description).toBe("A shared review link.");
  });

  it("renders children inside a main landmark with no auth or workspace chrome", () => {
    render(
      <ShareLayout>
        <div data-testid="share-child">child</div>
      </ShareLayout>,
    );
    expect(screen.getByTestId("share-child")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    // No sign-in/marketing surfaces leak onto the public review page.
    expect(screen.queryByRole("link", { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("site-header")).not.toBeInTheDocument();
    expect(screen.queryByTestId("site-footer")).not.toBeInTheDocument();
  });
});
