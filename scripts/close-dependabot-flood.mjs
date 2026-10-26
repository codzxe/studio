// Round 5 — close the dependabot PR flood (18+ PRs created from the per-directory
// experiment) with an explanatory comment, then delete their head branches.
const PAT = process.env.GH_PAT;
const REPO = "codzxe/studio";

async function gh(path, init) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `token ${PAT}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "studio-ops",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const prs = [];
for (let page = 1; page <= 3; page++) {
  const { body } = await gh(`/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`);
  if (!Array.isArray(body) || body.length === 0) break;
  prs.push(...body);
}
const dependabotPrs = prs.filter((p) => p.user.login === "dependabot[bot]");
console.log(`open dependabot PRs: ${dependabotPrs.length}`);

const comment = {
  body: "Closing: this dependabot experiment (per-directory entries) produced one PR **per manifest** for the same dependency, which desyncs versions across apps/packages instead of syncing them — plus several ecosystem-breaking major bumps (TypeScript 7, vitest 5, jsdom 30). Dependabot is back to root-only direct-deps; `renovate.json` (one branch per dependency, ALL manifests updated together, majors kept separate) supersedes it once the Renovate app is installed. Regenerate freely with `@dependabot recreate` if you prefer this PR.",
};

for (const pr of dependabotPrs) {
  const c = await gh(`/repos/${REPO}/issues/${pr.number}/comments`, {
    method: "POST",
    body: JSON.stringify(comment),
  });
  const close = await gh(`/repos/${REPO}/pulls/${pr.number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
  });
  let branch = "kept";
  if (pr.head.ref.startsWith("dependabot/")) {
    const d = await gh(`/repos/${REPO}/git/refs/heads/${encodeURIComponent(pr.head.ref)}`, {
      method: "DELETE",
    });
    branch = d.status === 200 || d.status === 204 ? "deleted" : `delete:${d.status}`;
  }
  console.log(
    `#${pr.number} ${pr.title.slice(0, 48)} — close:${close.status} branch:${branch} comment:${c.status}`,
  );
}
console.log("done");
