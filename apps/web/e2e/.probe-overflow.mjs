import { chromium } from "@playwright/test";

const PAGES = ["/w", "/w/projects", "/w/billing", "/w/settings/members"];

const probe = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 320, height: 720 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3000/sign-in?next=%2Fw");
  await page.locator("#sign-in-email").fill("demo@studio.test");
  await page.locator("#sign-in-password").fill("demo-password-12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/w", { timeout: 30000 });
  for (const path of PAGES) {
    await page.goto(`http://localhost:3000${path}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const out = await page.evaluate(() => {
      const doc = document.documentElement;
      const wide = [];
      for (const el of document.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width > 321 || r.right > 321) {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed") continue;
          // skip elements safely inside an internal scroll container
          let p = el.parentElement, clipped = false;
          while (p && p !== document.body) {
            const pcs = getComputedStyle(p);
            if (pcs.overflowX !== "visible") { clipped = true; break; }
            p = p.parentElement;
          }
          if (clipped) continue;
          wide.push(
            `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} ` +
              `w=${Math.round(r.width)} right=${Math.round(r.right)} ` +
              `class="${(el.getAttribute("class") ?? "").slice(0, 90)}"`,
          );
        }
      }
      // walk the members-list table ancestors
      const t = document.querySelector('[data-testid="settings-nav"] ul');
      const bodyKids = [];
      for (const k of document.body.querySelectorAll("*")) {
        const r = k.getBoundingClientRect();
        if (r.right > 321) {
          let p2 = k.parentElement, clipped = false;
          while (p2 && p2 !== document.body) {
            if (getComputedStyle(p2).overflowX !== "visible") { clipped = true; break; }
            p2 = p2.parentElement;
          }
          if (!clipped && getComputedStyle(k).position !== "fixed")
            bodyKids.push(`${k.tagName.toLowerCase()}[${k.dataset.testid ?? ""}] right=${Math.round(r.right)} ovx=${getComputedStyle(k).overflowX}`);
        }
      }
      // find the element(s) whose right edge matches the document scrollWidth
      const target = doc.scrollWidth;
      const matches = [];
      for (const k of document.body.querySelectorAll("*")) {
        const r = k.getBoundingClientRect();
        if (Math.abs(r.right - target) < 3 && k.tagName.toLowerCase() === 'span') {
          matches.push(`${k.tagName.toLowerCase()}[${k.dataset.testid ?? ""}][${(k.getAttribute('class')||'').slice(0,70)}] right=${Math.round(r.right)} w=${Math.round(r.width)} pos=${getComputedStyle(k).position} html=${k.outerHTML.slice(0,120)}`);
        }
      }
      window.__off = matches.slice(0, 12);
      const chain = [];
      let p = t;
      while (p && p !== document.body) {
        const r = p.getBoundingClientRect();
        const cs = getComputedStyle(p);
        chain.push(`${p.tagName.toLowerCase()}[${p.dataset.testid ?? ""}] w=${Math.round(r.width)} right=${Math.round(r.right)} ovx=${cs.overflowX} disp=${cs.display}`);
        p = p.parentElement;
      }
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        wide: wide.slice(0, 14),
        chain,
        off: window.__off,
      };
    });
    console.log(`\n=== ${path}: scroll=${out.scrollWidth} client=${out.clientWidth}`);
    for (const w of out.wide) console.log("  " + w);
    if (out.chain) for (const c of out.chain) console.log("  ANC " + c);
    if (out.off) for (const c of out.off) console.log("  UNCLIPPED " + c);
  }
  await browser.close();
};

probe().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
