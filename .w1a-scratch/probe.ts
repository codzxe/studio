// W1-a scratch probe: better-auth handler round-trip shapes (NOT committed).
import { createAuth } from "/home/z/my-project/packages/db/src/index.js";

const DB = "postgres://studio:studio@127.0.0.1:5432/studio";
const APP = "http://localhost:3000";
const auth = createAuth({
  databaseUrl: DB,
  appUrl: `${APP}/v1/auth`,
  secret: "test-secret-test-secret-test-secret-32",
  db: undefined,
});

const jar = new Map<string, string>();
function absorb(res: Response) {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function call(path: string, body?: unknown) {
  const res = await auth.handler(
    new Request(`${APP}/v1/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: APP,
        "content-type": "application/json",
        ...(jar.size ? { cookie: cookieHeader() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  absorb(res);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
  return { status: res.status, json };
}

const email = `probe-${Date.now()}@w3gw.test`;
console.log("sign-up:", JSON.stringify((await call("/sign-up/email", { email, password: "Passw0rd!longenough", name: "Probe" })).status));
const org = await call("/organization/create", { name: "Probe Org", slug: `probe-${Date.now()}`, userId: undefined });
console.log("create-org:", org.status, JSON.stringify(org.json).slice(0, 200));
const orgId = (org.json as any)?.id;
console.log("full-org:", JSON.stringify((await call(`/organization/get-full-organization?organizationId=${orgId}`)).json).slice(0, 700));
// invite a second user
const invite = await call("/organization/invite-member", { organizationId: orgId, email: `probe2-${Date.now()}@w3gw.test`, role: "viewer" });
console.log("invite:", invite.status, JSON.stringify(invite.json).slice(0, 200));
const inviteId = (invite.json as any)?.id;
// error shapes: unknown member role update
const bad = await call("/organization/update-member-role", { organizationId: orgId, memberId: "totally-bogus", role: "admin" });
console.log("bogus role update:", bad.status, JSON.stringify(bad.json));
// error: invalid role
const badRole = await call("/organization/update-member-role", { organizationId: orgId, memberId: "whatever", role: "supreme-leader" });
console.log("invalid role:", badRole.status, JSON.stringify(badRole.json).slice(0, 160));
// remove bogus member
const badRemove = await call("/organization/remove-member", { organizationId: orgId, memberIdOrEmail: "nobody@example.com" });
console.log("bogus remove:", badRemove.status, JSON.stringify(badRemove.json));
// set-active round trip
const setActive = await call("/organization/set-active", { organizationId: orgId });
console.log("set-active:", setActive.status, JSON.stringify(setActive.json).slice(0, 160));
// session shows activeOrganizationId?
const sess = await auth.api.getSession({ headers: new Headers({ cookie: cookieHeader() }) });
console.log("session.activeOrganizationId:", (sess as any)?.session?.activeOrganizationId, "=== orgId", orgId);
// remove-member on SELF (only owner) -> last owner protection
const selfRemove = await call("/organization/remove-member", { organizationId: orgId, memberIdOrEmail: ((await call(`/organization/get-full-organization?organizationId=${orgId}`)).json as any)?.members?.[0]?.id ?? "x" });
console.log("self-remove(last owner):", selfRemove.status, JSON.stringify(selfRemove.json));
process.exit(0);
