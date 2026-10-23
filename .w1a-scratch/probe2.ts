// W1-a scratch probe 2: role changes, transfer, removals (NOT committed).
import { createAuth } from "/home/z/my-project/packages/db/src/index.js";

const DB = "postgres://studio:studio@127.0.0.1:5432/studio";
const APP = "http://localhost:3000";
const auth = createAuth({
  databaseUrl: DB,
  appUrl: `${APP}/v1/auth`,
  secret: "test-secret-test-secret-test-secret-32",
});

function makeJar() {
  const jar = new Map<string, string>();
  return {
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb(res: Response) {
      for (const raw of res.headers.getSetCookie()) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
}

async function call(jar: ReturnType<typeof makeJar>, path: string, body?: unknown) {
  const res = await auth.handler(
    new Request(`${APP}/v1/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: APP,
        "content-type": "application/json",
        ...(jar.header() ? { cookie: jar.header() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  jar.absorb(res);
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
  return { status: res.status, json, headers: res.headers };
}

const stamp = Date.now();
const ownerJar = makeJar();
console.log("owner signup:", (await call(ownerJar, "/sign-up/email", { email: `own-${stamp}@w3gw.test`, password: "Passw0rd!longenough", name: "Owner" })).status);
const org = (await call(ownerJar, "/organization/create", { name: "P2 Org", slug: `p2-${stamp}` })).json as any;
const orgId = org.id;

// invite + accept as user2
const invite = (await call(ownerJar, "/organization/invite-member", { organizationId: orgId, email: `mem-${stamp}@w3gw.test`, role: "viewer" })).json as any;
const memJar = makeJar();
console.log("member signup:", (await call(memJar, "/sign-up/email", { email: `mem-${stamp}@w3gw.test`, password: "Passw0rd!longenough", name: "Member" })).status);
console.log("accept:", (await call(memJar, "/organization/accept-invitation", { invitationId: invite.id })).status);

const full = (await call(ownerJar, `/organization/get-full-organization?organizationId=${orgId}`)).json as any;
const ownerMember = full.members.find((m: any) => m.role === "owner");
const otherMember = full.members.find((m: any) => m.role !== "owner");
console.log("members:", full.members.length, "ownerRow:", ownerMember?.id, "otherRow:", otherMember?.id);

// owner promotes other to admin
const promoted = await call(ownerJar, "/organization/update-member-role", { organizationId: orgId, memberId: otherMember.id, role: "admin" });
console.log("promote->admin:", promoted.status, JSON.stringify(promoted.json));

// other (admin) tries to change owner's role
const adminTriesOwner = await call(memJar, "/organization/update-member-role", { organizationId: orgId, memberId: ownerMember.id, role: "admin" });
console.log("admin changes owner:", adminTriesOwner.status, JSON.stringify(adminTriesOwner.json));

// owner demotes self while ONLY owner
const selfDemote = await call(ownerJar, "/organization/update-member-role", { organizationId: orgId, memberId: ownerMember.id, role: "admin" });
console.log("last-owner self demote:", selfDemote.status, JSON.stringify(selfDemote.json));

// transfer: promote other to owner, then demote self
const up = await call(ownerJar, "/organization/update-member-role", { organizationId: orgId, memberId: otherMember.id, role: "owner" });
console.log("promote->owner:", up.status, JSON.stringify(up.json));
const down = await call(ownerJar, "/organization/update-member-role", { organizationId: orgId, memberId: ownerMember.id, role: "admin" });
console.log("demote old owner:", down.status, JSON.stringify(down.json));

// viewer cannot change roles (invite a viewer3)
const v3email = `v3-${stamp}@w3gw.test`;
const inv3 = (await call(ownerJar, "/organization/invite-member", { organizationId: orgId, email: v3email, role: "viewer" })).json as any;
const v3jar = makeJar();
await call(v3jar, "/sign-up/email", { email: v3email, password: "Passw0rd!longenough", name: "Viewer3" });
await call(v3jar, "/organization/accept-invitation", { invitationId: inv3.id });
const v3tries = await call(v3jar, "/organization/update-member-role", { organizationId: orgId, memberId: otherMember.id, role: "viewer" });
console.log("viewer changes role:", v3tries.status, JSON.stringify(v3tries.json));
const v3self = await call(v3jar, "/organization/remove-member", { organizationId: orgId, memberIdOrEmail: ((await call(v3jar, `/organization/get-full-organization?organizationId=${orgId}`)).json as any).members.find((m: any) => m.user?.email === v3email)?.id });
console.log("viewer self-remove:", v3self.status, JSON.stringify(v3self.json));

// admin removes the demoted old owner? (old owner is admin now, remover is owner)
const rem = await call(memJar, "/organization/remove-member", { organizationId: orgId, memberIdOrEmail: ownerMember.id });
console.log("owner removes admin:", rem.status, JSON.stringify(rem.json));

// set-active for a non-member org -> shape
const stranger = makeJar();
await call(stranger, "/sign-up/email", { email: `s-${stamp}@w3gw.test`, password: "Passw0rd!longenough", name: "Stranger" });
const strangerActive = await call(stranger, "/organization/set-active", { organizationId: orgId });
console.log("stranger set-active:", strangerActive.status, JSON.stringify(strangerActive.json));

// cookie headers on set-active?
const setActiveRes = await call(ownerJar, "/organization/set-active", { organizationId: orgId });
console.log("set-active cookies:", JSON.stringify(setActiveRes.headers.getSetCookie().map((s: string) => s.split(";")[0])));
process.exit(0);
