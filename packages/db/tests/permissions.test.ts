import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  type Capability,
  ROLES,
  type Role,
  atLeast,
  can,
  canCreateProjects,
  canDeleteWorkspace,
  canInvite,
  canManageBilling,
  canRender,
  canRunAgent,
  canTakeLease,
  canUploadAssets,
  capabilitiesFor,
  isRole,
} from "../src/permissions.js";

/**
 * PRODUCT_ARCHITECTURE §3.3 role matrix — every capability × every role.
 * viewer ⊂ editor ⊂ admin ⊂ owner (cumulative).
 */
const MATRIX: Record<Capability, Record<Role, boolean>> = {
  read: { viewer: true, editor: true, admin: true, owner: true },
  comment: { viewer: true, editor: true, admin: true, owner: true },
  openEditor: { viewer: true, editor: true, admin: true, owner: true },
  createProjects: { viewer: false, editor: true, admin: true, owner: true },
  takeLease: { viewer: false, editor: true, admin: true, owner: true },
  runAgent: { viewer: false, editor: true, admin: true, owner: true },
  uploadAssets: { viewer: false, editor: true, admin: true, owner: true },
  render: { viewer: false, editor: true, admin: true, owner: true },
  invite: { viewer: false, editor: false, admin: true, owner: true },
  removeMembers: { viewer: false, editor: false, admin: true, owner: true },
  manageBilling: { viewer: false, editor: false, admin: true, owner: true },
  manageApiKeys: { viewer: false, editor: false, admin: true, owner: true },
  manageWorkspace: { viewer: false, editor: false, admin: true, owner: true },
  deleteWorkspace: { viewer: false, editor: false, admin: false, owner: true },
  transferOwnership: { viewer: false, editor: false, admin: false, owner: true },
};

describe("permissions matrix (§3.3)", () => {
  for (const capability of CAPABILITIES) {
    describe(`can(role, "${capability}")`, () => {
      for (const role of ROLES) {
        const expected = MATRIX[capability][role];
        it(`${role} → ${expected}`, () => {
          expect(can(role, capability)).toBe(expected);
        });
      }
    });
  }

  it("named helpers agree with the matrix", () => {
    for (const role of ROLES) {
      expect(canCreateProjects(role)).toBe(MATRIX.createProjects[role]);
      expect(canRunAgent(role)).toBe(MATRIX.runAgent[role]);
      expect(canUploadAssets(role)).toBe(MATRIX.uploadAssets[role]);
      expect(canRender(role)).toBe(MATRIX.render[role]);
      expect(canInvite(role)).toBe(MATRIX.invite[role]);
      expect(canManageBilling(role)).toBe(MATRIX.manageBilling[role]);
      expect(canDeleteWorkspace(role)).toBe(MATRIX.deleteWorkspace[role]);
      expect(canTakeLease(role)).toBe(MATRIX.takeLease[role]);
    }
  });

  it("capabilitiesFor is cumulative viewer ⊂ editor ⊂ admin ⊂ owner", () => {
    const viewer = new Set(capabilitiesFor("viewer"));
    const editor = new Set(capabilitiesFor("editor"));
    const admin = new Set(capabilitiesFor("admin"));
    const owner = new Set(capabilitiesFor("owner"));
    for (const c of viewer) expect(editor.has(c)).toBe(true);
    for (const c of editor) expect(admin.has(c)).toBe(true);
    for (const c of admin) expect(owner.has(c)).toBe(true);
  });

  it("atLeast ranks roles cumulatively", () => {
    expect(atLeast("admin", "admin")).toBe(true);
    expect(atLeast("owner", "admin")).toBe(true);
    expect(atLeast("editor", "admin")).toBe(false);
    expect(atLeast("viewer", "editor")).toBe(false);
  });

  it("isRole guards the wire-stable role names", () => {
    expect(isRole("owner")).toBe(true);
    expect(isRole("admin")).toBe(true);
    expect(isRole("editor")).toBe(true);
    expect(isRole("viewer")).toBe(true);
    // better-auth default role that our product never assigns:
    expect(isRole("member")).toBe(false);
    expect(isRole("")).toBe(false);
    expect(isRole(42)).toBe(false);
  });

  it("every role grants read/comment/open (viewers open read-only)", () => {
    for (const role of ROLES) {
      expect(can(role, "read")).toBe(true);
      expect(can(role, "comment")).toBe(true);
      expect(can(role, "openEditor")).toBe(true);
    }
  });
});
