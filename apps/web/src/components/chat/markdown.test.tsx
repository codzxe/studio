/**
 * Markdown renderer tests (M4-F) — injection safety first (M4-N posture), then
 * the pinned subset vectors: bold/italic/code, fenced blocks, lists, headings,
 * links-as-text, empty input. Deterministic; no network; jsdom.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

describe("Markdown — injection safety (never trusts model output)", () => {
  it("keeps <script> as literal text and creates no script element", () => {
    const { container } = render(<Markdown text={'<script>alert("x")</script>'} />);
    expect(container.textContent).toContain('<script>alert("x")</script>');
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps raw HTML tags as text — no elements are created from them", () => {
    const { container } = render(
      <Markdown text="<b>bold</b> <img src=x onerror=alert(1)> <a href='https://x'>link</a>" />,
    );
    expect(container.textContent).toContain("<b>bold</b>");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("never builds HTML strings — rendered output carries only React-escaped text nodes", () => {
    // The runtime proof of the no-injection posture: hostile input round-trips
    // as literal text with zero created elements (covered by the vectors
    // above); this vector pins the mixed-content case.
    const { container } = render(
      <Markdown text={"</textarea><script>alert(1)</script><textarea>"} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("renders [label](url) links as text-only labels — no anchors, no URLs", () => {
    const { container } = render(<Markdown text="See [Docs](https://evil.example/x) for more." />);
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("Docs")).toBeInTheDocument();
    expect(container.textContent).not.toContain("evil.example");
  });

  it("leaves bare URLs as plain text (auto-detect does not create anchors)", () => {
    const { container } = render(<Markdown text="See https://example.com/docs for more." />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("https://example.com/docs");
  });

  it("keeps HTML inside fenced code blocks inert", () => {
    const { container } = render(<Markdown text={"```html\n<script>bad()</script>\n```"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("chat-md-code")).toHaveTextContent("<script>bad()</script>");
  });
});

describe("Markdown — pinned subset vectors", () => {
  it("parses bold, italic and code spans", () => {
    const { container } = render(<Markdown text="**bold** and *thin* and `code`" />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("thin");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });

  it("parses fenced code blocks without interpreting their content", () => {
    const { container } = render(
      <Markdown text={"```js\nif (x) { evil(); }\n**not bold**\n```"} />,
    );
    const block = screen.getByTestId("chat-md-code");
    expect(block).toHaveTextContent("if (x) { evil(); }");
    expect(block).toHaveTextContent("**not bold**");
    expect(container.querySelector("strong")).toBeNull();
  });

  it("renders an unterminated fence as inert code to the end of input", () => {
    render(<Markdown text={"```\nunterminated <b>body</b>"} />);
    expect(screen.getByTestId("chat-md-code")).toHaveTextContent("unterminated <b>body</b>");
  });

  it("parses - lists into a ul with li items (inline markup inside works)", () => {
    const { container } = render(<Markdown text={"- one\n- **two**\n- three"} />);
    const items = container.querySelectorAll("ul > li");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toBe("one");
    expect(items[1]?.textContent).toBe("two");
    expect(items[1]?.querySelector("strong")?.textContent).toBe("two");
    expect(items[2]?.textContent).toBe("three");
  });

  it("parses h1–h3 headings and keeps h4+ as paragraph text", () => {
    const { container } = render(<Markdown text={"# One\n## Two\n### Three\n#### Four"} />);
    expect(container.querySelector("h1")?.textContent).toBe("One");
    expect(container.querySelector("h2")?.textContent).toBe("Two");
    expect(container.querySelector("h3")?.textContent).toBe("Three");
    expect(container.querySelector("h4")).toBeNull();
    expect(screen.getByText("#### Four")).toBeInTheDocument();
  });

  it("splits paragraphs on blank lines and soft-wraps single newlines", () => {
    render(<Markdown text={"first line\nwraps on\n\nsecond paragraph"} />);
    expect(screen.getByText("first line wraps on")).toBeInTheDocument();
    expect(screen.getByText("second paragraph")).toBeInTheDocument();
  });

  it("renders nothing for empty and whitespace-only input", () => {
    const empty = render(<Markdown text="" />);
    expect(empty.container.firstElementChild?.children).toHaveLength(0);
    empty.unmount();
    const blank = render(<Markdown text={"  \n\n \n"} />);
    expect(blank.container.firstElementChild?.children).toHaveLength(0);
  });

  it("renders a realistic assistant reply (paragraph + list + fence + bold)", () => {
    const { container } = render(
      <Markdown
        text={
          'I found **three text layers**. Plan:\n\n- Keyframe Scale\n- Add overshoot\n\n```json\n{"risk": "low"}\n```'
        }
      />,
    );
    // getByText only inspects DIRECT text nodes, so assert on textContent for
    // paragraphs that mix text and inline elements.
    expect(container.textContent).toContain("I found three text layers. Plan:");
    expect(container.querySelector("strong")?.textContent).toBe("three text layers");
    expect(screen.getByText("Keyframe Scale")).toBeInTheDocument();
    expect(screen.getByText("Add overshoot")).toBeInTheDocument();
    expect(screen.getByTestId("chat-md-code")).toHaveTextContent('{"risk": "low"}');
  });
});
