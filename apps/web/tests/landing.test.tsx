import MarketingLayout from "@/app/(marketing)/layout";
import LandingPage from "@/app/(marketing)/page";
import { MICROCREDITS_PER_CREDIT, PLAN_CATALOG, brandViolations } from "@studio/config";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * §8.1 contract: the landing renders ALL ELEVEN sections in order, honest
 * copy only — no fake logos, no invented metrics, and no forbidden upstream
 * names anywhere in the marketing UI (ADR-0006).
 */

const SECTION_MARKERS = [
  "landing-hero",
  "landing-proof",
  "landing-agent",
  "landing-editor",
  "landing-workflow",
  "landing-collaboration",
  "landing-performance",
  "landing-pricing",
  "landing-faq",
  "landing-final-cta",
  "landing-footer",
] as const;

function renderLanding() {
  return render(
    <MarketingLayout>
      <LandingPage />
    </MarketingLayout>,
  );
}

describe("landing page", () => {
  it("renders all 11 section markers in order", () => {
    const { container } = renderLanding();
    for (const marker of SECTION_MARKERS) {
      expect(
        container.querySelector(`[data-testid="${marker}"]`),
        `missing section marker: ${marker}`,
      ).not.toBeNull();
    }
    // Markers must appear in the documented §8.1 order.
    const found = Array.from(container.querySelectorAll("[data-testid]"))
      .map((el) => (el as HTMLElement).dataset.testid)
      .filter((id): id is string => id !== undefined);
    const landingOrder = found.filter((id) => (SECTION_MARKERS as readonly string[]).includes(id));
    expect(landingOrder).toEqual([...SECTION_MARKERS]);
  });

  it("hero: serif headline, honest subline, both CTAs, trial subline", () => {
    renderLanding();
    const hero = screen.getByTestId("landing-hero");
    expect(within(hero).getByText("Motion, directed by you.")).toBeInTheDocument();
    expect(
      within(hero).getByText(
        "A composition editor with an agent that understands layers, keyframes and taste.",
      ),
    ).toBeInTheDocument();
    expect(within(hero).getByRole("link", { name: "Start 14-day trial" })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    expect(within(hero).getByRole("link", { name: "Watch the 90s film" })).toHaveAttribute(
      "href",
      "#film",
    );
    expect(
      within(hero).getByText("Card required · Cancel anytime · No free tier"),
    ).toBeInTheDocument();
  });

  it("proof strip: the five capability tokens, no logos", () => {
    renderLanding();
    for (const token of ["Keyframes", "3D", "306 effects", "Agent edits", "Version history"]) {
      expect(screen.getByText(token)).toBeInTheDocument();
    }
  });

  it("agent story: ask, plan and applied cards with the approval model", () => {
    renderLanding();
    expect(screen.getByTestId("agent-story-ask")).toBeInTheDocument();
    const plan = screen.getByTestId("agent-story-plan");
    expect(within(plan).getByText("Plan · Edit 3 layers")).toBeInTheDocument();
    expect(within(plan).getByText("Low risk")).toBeInTheDocument();
    expect(within(plan).getByText("~12 credits")).toBeInTheDocument();
    expect(within(plan).getByRole("button", { name: "Preview" })).toBeInTheDocument();
    expect(within(plan).getByRole("button", { name: "Apply" })).toBeInTheDocument();
    expect(within(plan).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByText("Applied · 3 layers · 0.8s")).toBeInTheDocument();
  });

  it("editor frame: honest caption and the three callouts", () => {
    renderLanding();
    expect(screen.getByText("A full compositing editor, unmodified.")).toBeInTheDocument();
    expect(
      screen.getByText(/Timeless timeline\. 306 effects\. Runs in the browser\./),
    ).toBeInTheDocument();
    for (const callout of ["Compositions", "Keyframe timeline", "Render queue"]) {
      expect(screen.getAllByText(callout).length).toBeGreaterThan(0);
    }
  });

  it("workflow: five numbered steps", () => {
    renderLanding();
    for (const step of ["Import", "Compose", "Animate", "Review", "Render"]) {
      expect(screen.getByRole("heading", { name: step })).toBeInTheDocument();
    }
  });

  it("performance: honest SLO rows with the p75 footnote", () => {
    renderLanding();
    const section = screen.getByTestId("landing-performance");
    expect(within(section).getByText("Editor ready, warm cache")).toBeInTheDocument();
    expect(within(section).getByText("< 6 s")).toBeInTheDocument();
    expect(within(section).getByText("Editor ready, cold")).toBeInTheDocument();
    expect(within(section).getByText("< 12 s")).toBeInTheDocument();
    expect(within(section).getByText("First chat token")).toBeInTheDocument();
    expect(within(section).getByText("< 1.5 s")).toBeInTheDocument();
    expect(within(section).getByText("Local apply")).toBeInTheDocument();
    expect(within(section).getByText("< 300 ms")).toBeInTheDocument();
    expect(within(section).getByText("60 fps")).toBeInTheDocument();
    expect(within(section).getByText("p75, reference machine.")).toBeInTheDocument();
  });

  it("pricing: the SAME catalog-derived cards as /pricing — never a second price set", () => {
    renderLanding();
    // W4-KILL: the section renders the shared PricingCards component
    // (pricing-card-* testids), so every pin below is DERIVED from
    // PLAN_CATALOG exactly as tests/pricing.test.tsx derives it — a catalog
    // change moves both pages, and a hardcoded price set on either fails here.
    const starter = screen.getByTestId("pricing-card-starter");
    const pro = screen.getByTestId("pricing-card-pro");
    const studio = screen.getByTestId("pricing-card-studio");
    const usd = (cents: number): string => {
      const dollars = cents / 100;
      return `$${Number.isInteger(dollars) ? dollars.toString() : dollars.toFixed(2)}`;
    };
    for (const [card, id] of [
      [starter, "starter"],
      [pro, "pro"],
      [studio, "studio"],
    ] as const) {
      const plan = PLAN_CATALOG[id];
      expect(within(card).getByText(usd(plan.monthlyPriceCents))).toBeInTheDocument();
      expect(
        within(card).getByText(
          `${(plan.monthlyCreditAllowance / MICROCREDITS_PER_CREDIT).toLocaleString("en-US")} credits/mo`,
        ),
      ).toBeInTheDocument();
      expect(
        within(card).getByText(`${plan.seats.toLocaleString("en-US")} seats`),
      ).toBeInTheDocument();
    }
    expect(within(pro).getByText("Most popular")).toBeInTheDocument();
    expect(
      screen.getByText("14 days free with card. No free tier. Cancel anytime."),
    ).toBeInTheDocument();
  });

  it("faq: six real questions", () => {
    renderLanding();
    expect(screen.getAllByRole("group").length + screen.getAllByText(/\?$/).length).toBeGreaterThan(
      0,
    );
    for (const q of [
      "Which browsers are supported?",
      "What file formats can I import and export?",
      "Where does my data live?",
      "Which models does the agent use?",
      "Can I use the editor without the agent?",
      "Can I cancel anytime?",
    ]) {
      expect(screen.getByText(q)).toBeInTheDocument();
    }
  });

  it("final CTA + footer copy", () => {
    renderLanding();
    expect(screen.getByText("Start the 14-day trial.")).toBeInTheDocument();
    const footer = screen.getByTestId("landing-footer");
    expect(within(footer).getByText("Licences")).toBeInTheDocument();
  });

  it("is brand-safe: no forbidden upstream names in the marketing UI (ADR-0006)", () => {
    const { container } = renderLanding();
    const text = container.textContent ?? "";
    const lower = text.toLowerCase();
    // case-insensitive four marks + case-sensitive "Cursor" (brand.ts rules)
    expect(brandViolations(text)).toEqual([]);
    expect(lower).not.toContain("effectcraft");
    expect(lower).not.toContain("artcraft");
    expect(lower).not.toContain("photocraft");
    expect(lower).not.toContain("photoshop");
    expect(text).not.toMatch(/\bCursor\b/);
  });

  it("contains no fake-metric red flags", () => {
    const { container } = renderLanding();
    const text = (container.textContent ?? "").toLowerCase();
    for (const banned of [
      "lorem ipsum",
      "10,000+",
      "trusted by",
      "loved by",
      "free forever",
      "ai-powered",
    ]) {
      expect(text).not.toContain(banned);
    }
  });
});
