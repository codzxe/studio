import FaqPage, { metadata } from "@/app/(marketing)/faq/page";
import { Brand, brandViolations } from "@studio/config";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

/**
 * /faq contract (M9-E, AUD-5): honest answers mirroring what the product
 * ACTUALLY does today (browser + COOP/COEP requirements, D-2 render formats,
 * credit display semantics — credits only, never model tokens — the real model
 * tiers, the real privacy policy link), inside an accessible accordion: real
 * buttons, aria-expanded, panels as labelled regions, keyboard operable.
 */

const QUESTIONS = [
  "Which browsers are supported?",
  "What file formats does the project use?",
  "Where does my data live?",
  "Which models does the agent use?",
  "What are credits and how do they work?",
  "Can I cancel? What about refunds?",
  "Can I use the editor without the agent?",
  "Is there a free tier?",
] as const;

describe("faq page", () => {
  it("has FAQ metadata and renders all eight questions as closed triggers", () => {
    expect(metadata.title).toBe("FAQ");
    expect((metadata.description ?? "").length).toBeGreaterThan(0);
    render(<FaqPage />);
    for (const question of QUESTIONS) {
      const trigger = screen.getByRole("button", { name: question });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger.getAttribute("aria-controls")).toBeTruthy();
    }
    // All panels start closed: no labelled region is exposed to the a11y tree.
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });

  it("opens and closes a question by click, exposing the labelled panel", async () => {
    const user = userEvent.setup();
    render(<FaqPage />);
    const trigger = screen.getByRole("button", { name: QUESTIONS[0] });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region"); // exactly one open panel
    expect(panel.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(panel).toHaveTextContent(/COOP\/COEP/);
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });

  it("answers are the honest, product-true versions", async () => {
    const user = userEvent.setup();
    render(<FaqPage />);

    await user.click(screen.getByRole("button", { name: QUESTIONS[0] }));
    expect(
      screen.getByText(/Chrome or Edge 113\+, Firefox 121\+, Safari 18\+/),
    ).toBeInTheDocument();
    expect(screen.getByText(/WebGPU or WebGL2/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: QUESTIONS[1] }));
    expect(screen.getByText(/\.ecproj/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /MP4 \(H\.264\) or PNG sequences; ProRes, GIF and WAV are on the format list but not enabled yet/,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: QUESTIONS[2] }));
    expect(screen.getByRole("link", { name: "privacy policy" })).toHaveAttribute(
      "href",
      "/legal/privacy",
    );

    await user.click(screen.getByRole("button", { name: QUESTIONS[3] }));
    expect(
      screen.getByText(/The trial runs on Fast; every paid plan can pick Fast or Smart/),
    ).toBeInTheDocument();
    expect(screen.getByText(/off by default/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: QUESTIONS[4] }));
    expect(screen.getByText(/never in model tokens/)).toBeInTheDocument();
    expect(
      screen.getByText(/reserves its estimate up front and refunds what it did not use/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: QUESTIONS[5] }));
    expect(screen.getByText(/two clicks, no retention flow/)).toBeInTheDocument();
    expect(screen.getByText(/come back automatically/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "write to support" })).toHaveAttribute(
      "href",
      `mailto:${Brand.contact.support}`,
    );

    await user.click(screen.getByRole("button", { name: QUESTIONS[7] }));
    expect(screen.getByRole("link", { name: "pricing page" })).toHaveAttribute("href", "/pricing");
    expect(screen.getByText(/no permanent free plan/)).toBeInTheDocument();
  });

  it("is brand-safe and free of placeholder filler", () => {
    const { container } = render(<FaqPage />);
    const text = container.textContent ?? "";
    expect(brandViolations(text)).toEqual([]);
    expect(text.toLowerCase()).not.toContain("lorem ipsum");
  });
});
