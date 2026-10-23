/**
 * SiteFooter tests (W5-LINK) — the M9 "no dead links" gate for the marketing
 * footer: every href the footer renders must resolve to a REAL route (or a
 * mailto: contact token), and the dead external "Documentation" link —
 * `https://docs.studio.example.com`, a Brand placeholder domain that resolves
 * nowhere — must stay gone (removed in this change; it returns when a real
 * docs site ships). The expected-href set below is the pin: any footer link
 * edit must update it deliberately.
 */

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteFooter } from "./site-footer";

/**
 * The pinned footer inventory. Internal paths are cross-checked against the
 * app route tree (src/app): `/pricing`, `/faq`, `/changelog`, `/status`,
 * `/legal/{terms,privacy,licences}` and the landing anchors `#agent`/`#product`
 * all exist; `mailto:` is the Brand contact token (launch-time seam).
 */
const EXPECTED_LINKS: ReadonlyMap<string, string> = new Map([
  ["Pricing", "/pricing"],
  ["FAQ", "/faq"],
  ["The agent", "/#agent"],
  ["The editor", "/#product"],
  ["Changelog", "/changelog"],
  ["Support", "mailto:support@studio.example.com"],
  ["Status", "/status"],
  ["Terms", "/legal/terms"],
  ["Privacy", "/legal/privacy"],
  ["Licences", "/legal/licences"],
]);

describe("SiteFooter (W5-LINK dead-link gate)", () => {
  it("renders exactly the pinned link set — every href is a real route or mailto token", () => {
    render(<SiteFooter />);

    const footer = screen.getByTestId("landing-footer");
    const anchors = Array.from(within(footer).getAllByRole("link"));
    const hrefs = anchors.map((anchor) => anchor.getAttribute("href") ?? "");

    expect(hrefs).toEqual([...EXPECTED_LINKS.values()]);
  });

  it("has no external http(s) links (the dead docs placeholder is gone)", () => {
    render(<SiteFooter />);

    const footer = screen.getByTestId("landing-footer");
    const external = Array.from(within(footer).getAllByRole("link"))
      .map((anchor) => anchor.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("http"));

    expect(external).toEqual([]);
    expect(screen.queryByRole("link", { name: "Documentation" })).not.toBeInTheDocument();
  });
});
