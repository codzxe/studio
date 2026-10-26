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
  body: "Closing per the repo's dependency-bot policy: major bumps (esbuild 0.28, TypeScript 7, @types/node 26) are ecosystem-breaking — the repo pins TypeScript <7, esbuild is load-bearing for the gateway build (declared in licenses.overrides.json), and @types/node must track the Node runtime, not jump 4 majors. Dependabot stays root-only for security/minor patches; coordinated updates (ALL manifests + the shared lockfile together, majors separate) are handled by `renovate.json` once the Renovate app is installed — then dependabot.yml goes away. Reopen freely if you want a specific one.",
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
