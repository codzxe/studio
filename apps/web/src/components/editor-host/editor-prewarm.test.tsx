/**
 * EditorPrewarm tests (W3-D) — the invisible shell component that starts the
 * editor engine's download + compile the moment the user is anywhere in the
 * authenticated app. The prewarm logic itself is `@/lib/editor-warmup`'s own
 * tested concern; here the contract is just: mounts → triggers it (once per
 * mount, rendered as nothing).
 */

import { prewarmEditor } from "@/lib/editor-warmup";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EditorPrewarm } from "./editor-prewarm";

vi.mock("@/lib/editor-warmup", () => ({
  prewarmEditor: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(prewarmEditor).mockClear();
});

describe("EditorPrewarm", () => {
  it("mount triggers the app-start prewarm exactly once", () => {
    render(<EditorPrewarm />);
    expect(prewarmEditor).toHaveBeenCalledTimes(1);
  });

  it("renders nothing — no DOM footprint in the shell tree", () => {
    const { container } = render(<EditorPrewarm />);
    expect(container.innerHTML).toBe("");
  });
});
