import LicencesPage from "@/app/(marketing)/legal/licences/page";
import PrivacyPage from "@/app/(marketing)/legal/privacy/page";
import TermsPage from "@/app/(marketing)/legal/terms/page";
import NotFound from "@/app/not-found";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * Legal pages render real structure (§16: no lorem ipsum, no placeholder
 * filler), the licences page is the ONE place the upstream editor's real
 * name legitimately appears (brand.ts), and 404 copy matches §8.11.
 */

describe("legal pages", () => {
  it("terms: real headings, beta note, no lorem ipsum", () => {
    render(<TermsPage />);
    expect(screen.getByTestId("legal-terms")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /The service/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Trials and billing/ })).toBeInTheDocument();
    expect(screen.getByText(/final terms are being reviewed/)).toBeInTheDocument();
    expect(screen.queryByText(/lorem ipsum/i)).not.toBeInTheDocument();
  });

  it("privacy: sections for collection, use, and the never-do list", () => {
    render(<PrivacyPage />);
    expect(screen.getByTestId("legal-privacy")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /What we collect/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /What we never do/ })).toBeInTheDocument();
    expect(
      screen.getByText(/never use your project content to train machine-learning models/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/lorem ipsum/i)).not.toBeInTheDocument();
  });

  it("licences: attribution table with the upstream editor, fonts and licence names", () => {
    render(<LicencesPage />);
    const page = screen.getByTestId("legal-licences");
    expect(screen.getByRole("heading", { name: "Licences and attribution" })).toBeInTheDocument();
    // The upstream mark is legitimate HERE (packages/config brand.ts).
    expect(within(page).getByText("EffectCraft")).toBeInTheDocument();
    expect(within(page).getByText("MIT OR Apache-2.0")).toBeInTheDocument();
    expect(within(page).getAllByText(/SIL Open Font License 1.1/).length).toBe(2);
    expect(
      within(page).getByText("9db7f3b21700fd821f215782ed1c82afe077880f (v0.13.0)"),
    ).toBeInTheDocument();
    // Full attribution pointer.
    expect(screen.getByText(/full attribution.*ATTRIBUTION\.md/is)).toBeInTheDocument();
    const upstreamLinks = within(page).getAllByRole("link", { name: "Upstream project" });
    expect(upstreamLinks[0]).toHaveAttribute("href", "https://github.com/storytold/effectcraft");
  });
});

describe("not-found", () => {
  it("uses the §8.11 copy and offers a way back", () => {
    render(<NotFound />);
    expect(screen.getByText("This frame doesn't exist.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to projects" })).toHaveAttribute("href", "/w");
    expect(screen.getByRole("link", { name: "Back to the site" })).toHaveAttribute("href", "/");
  });
});
