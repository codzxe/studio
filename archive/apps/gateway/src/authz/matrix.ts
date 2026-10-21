// The ADR-0003 RBAC matrix as auditable data + the matrix self-test.
//
// ADR_RBAC_TABLE is a VERBATIM transcription of docs/adr/0003-auth-and-orgs.md
// "RBAC matrix (§15.2)" — do not edit without an ADR change. auditMatrix()
// cross-checks the live permission table (roles.ts) against it cell-by-cell;
// assertMatrixMatchesAdr() is the self-test export CI asserts via
// tests/authz.test.ts (§20 #11 is the cross-tenant acceptance gate; §15.2
// "UI hiding is not enforcement").
//
// Every permission must trace to either an ADR row or a documented task/spec
// source (PERMISSION_SOURCES) — no grant without provenance. Extra
// permissions beyond the ADR rows are allowed only with a citation.

import {
  ALL_PERMISSIONS,
  can,
  MIN_ROLE_FOR_PERMISSION,
  PERMISSIONS,
  ROLE_RANK,
  ROLES
} from "./roles.js";
import type { Permission, Role } from "./roles.js";

/** One row of the ADR-0003 RBAC matrix (a capability × the four role columns). */
export interface AdrRbacRow {
  readonly capability: string;
  readonly grants: Readonly<Record<Role, boolean>>;
}

/** How many rows the ADR-0003 matrix has (pins the transcription). */
export const ADR_ROW_COUNT = 11;

/** ADR-0003 §RBAC matrix — transcribed verbatim (ADR_ROW_COUNT rows). */
export const ADR_RBAC_TABLE: readonly AdrRbacRow[] = [
  {
    capability: "Read documents/assets/runs/versions",
    grants: { viewer: true, editor: true, admin: true, owner: true }
  },
  {
    capability: "Comment (with position)",
    grants: { viewer: true, editor: true, admin: true, owner: true }
  },
  {
    capability: "Create runs (`POST /runs`, tiers)",
    grants: { viewer: false, editor: true, admin: true, owner: true }
  },
  {
    capability: "Manual commands / undo / redo / restore",
    grants: { viewer: false, editor: true, admin: true, owner: true }
  },
  {
    capability: "Exports (`exports:create`)",
    grants: { viewer: false, editor: true, admin: true, owner: true }
  },
  {
    capability: "Upload assets / register templates",
    grants: { viewer: false, editor: true, admin: true, owner: true }
  },
  {
    capability: "Manage members + invites",
    grants: { viewer: false, editor: false, admin: true, owner: true }
  },
  {
    capability: "Billing (checkout/portal, credit packs)",
    grants: { viewer: false, editor: false, admin: true, owner: true }
  },
  {
    capability: "API key management",
    grants: { viewer: false, editor: false, admin: true, owner: true }
  },
  {
    capability: 'Delete workspace (§15.2 "owner: delete")',
    grants: { viewer: false, editor: false, admin: false, owner: true }
  },
  {
    capability: "Transfer ownership / dissolve",
    grants: { viewer: false, editor: false, admin: false, owner: true }
  }
];

/** Provenance for one permission: its ADR row (or a documented non-ADR source). */
export interface RbacPermissionSource {
  /**
   * Exact ADR-0003 capability text this permission enforces, or null for a
   * task/spec-sourced extra (which must still carry a citation).
   */
  readonly adrRow: string | null;
  /** Where the grant comes from — asserted non-empty by the audit. */
  readonly citation: string;
}

/** Provenance per permission — exhaustive over the Permission union (compile-checked). */
export const PERMISSION_SOURCES: Readonly<Record<Permission, RbacPermissionSource>> = {
  "documents:read": {
    adrRow: "Read documents/assets/runs/versions",
    citation: "ADR-0003 RBAC matrix, row 1"
  },
  "comments:create": {
    adrRow: "Comment (with position)",
    citation: "ADR-0003 RBAC matrix, row 2"
  },
  "runs:create": {
    adrRow: "Create runs (`POST /runs`, tiers)",
    citation: "ADR-0003 RBAC matrix, row 3"
  },
  "documents:write": {
    adrRow: "Manual commands / undo / redo / restore",
    citation: "ADR-0003 RBAC matrix, row 4"
  },
  "exports:create": {
    adrRow: "Exports (`exports:create`)",
    citation: "ADR-0003 RBAC matrix, row 5"
  },
  "assets:upload": {
    adrRow: "Upload assets / register templates",
    citation: "ADR-0003 RBAC matrix, row 6"
  },
  "members:manage": {
    adrRow: "Manage members + invites",
    citation: "ADR-0003 RBAC matrix, row 7"
  },
  "billing:manage": {
    adrRow: "Billing (checkout/portal, credit packs)",
    citation: "ADR-0003 RBAC matrix, row 8"
  },
  "apikeys:manage": {
    adrRow: "API key management",
    citation: "ADR-0003 RBAC matrix, row 9"
  },
  "workspace:delete": {
    adrRow: 'Delete workspace (§15.2 "owner: delete")',
    citation: "ADR-0003 RBAC matrix, row 10"
  },
  "workspace:transfer": {
    adrRow: "Transfer ownership / dissolve",
    citation: "ADR-0003 RBAC matrix, row 11"
  },
  "brand:manage": {
    adrRow: null,
    citation: "W4-C task (admin: brand tokens); spec §5.4 style guide, §19 brand tokens per workspace"
  }
};

/** One permission × the four role columns (derived from roles.ts, audited vs the ADR). */
export interface RbacMatrixRow {
  readonly permission: Permission;
  readonly minRole: Role;
  readonly grants: Readonly<Record<Role, boolean>>;
  readonly source: RbacPermissionSource;
}

function matrixRowFor(permission: Permission): RbacMatrixRow {
  return {
    permission,
    minRole: MIN_ROLE_FOR_PERMISSION[permission],
    grants: {
      viewer: can("viewer", permission),
      editor: can("editor", permission),
      admin: can("admin", permission),
      owner: can("owner", permission)
    },
    source: PERMISSION_SOURCES[permission]
  };
}

/** The full permission→role matrix as data (deterministic ALL_PERMISSIONS order). */
export const PERMISSION_MATRIX: readonly RbacMatrixRow[] = ALL_PERMISSIONS.map(matrixRowFor);

/** Result of the self-audit: ok=false ⇒ problems lists every drift found. */
export interface RbacMatrixAudit {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly adrRows: number;
  readonly permissions: number;
  readonly roleChecks: number;
}

/**
 * Audit the live matrix against the transcribed ADR table — the CI
 * completeness self-test. Pure; reports every problem it finds in one pass.
 */
export function auditMatrix(): RbacMatrixAudit {
  const problems: string[] = [];
  let roleChecks = 0;

  // (1) Transcription pin: the ADR-0003 matrix is exactly ADR_ROW_COUNT rows.
  if (ADR_RBAC_TABLE.length !== ADR_ROW_COUNT) {
    problems.push(`ADR_RBAC_TABLE has ${ADR_RBAC_TABLE.length} rows; ADR-0003 has ${ADR_ROW_COUNT}`);
  }

  // (2) Every ADR row is enforced by exactly one permission…
  for (const row of ADR_RBAC_TABLE) {
    const mapped = PERMISSION_MATRIX.filter((entry) => entry.source.adrRow === row.capability);
    if (mapped.length === 0) {
      problems.push(`ADR-0003 row "${row.capability}" is not enforced by any permission`);
      continue;
    }
    if (mapped.length > 1) {
      problems.push(
        `ADR-0003 row "${row.capability}" is enforced by ${mapped.length} permissions` +
          ` (${mapped.map((entry) => entry.permission).join(", ")})`
      );
    }
    // (3) …and its can() grants match the ADR table cell-by-cell.
    for (const entry of mapped) {
      for (const role of ROLES) {
        roleChecks += 1;
        if (entry.grants[role] !== row.grants[role]) {
          problems.push(
            `"${entry.permission}" × ${role}: matrix grants ${String(entry.grants[role])},` +
              ` ADR-0003 says ${String(row.grants[role])} ("${row.capability}")`
          );
        }
      }
    }
  }

  for (const entry of PERMISSION_MATRIX) {
    // (4) Cited ADR rows must exist; extras must carry a citation.
    const citedRow = entry.source.adrRow;
    if (citedRow !== null && !ADR_RBAC_TABLE.some((row) => row.capability === citedRow)) {
      problems.push(`"${entry.permission}" cites an ADR row that does not exist: "${citedRow}"`);
    }
    if (entry.source.citation.trim() === "") {
      problems.push(`"${entry.permission}" has no source citation`);
    }
    // (5) Cumulativity + minimality: viewer ⊆ editor ⊆ admin ⊆ owner, and
    // grants start exactly at minRole.
    let previous: Role | undefined;
    for (const role of ROLES) {
      if (entry.grants[role] && previous !== undefined && !entry.grants[previous]) {
        problems.push(`"${entry.permission}" is non-cumulative: ${role} grants but ${previous} does not`);
      }
      if (entry.grants[role] && ROLE_RANK[role] < ROLE_RANK[entry.minRole]) {
        problems.push(`"${entry.permission}" is granted to ${role}, below its minRole ${entry.minRole}`);
      }
      roleChecks += 1;
      previous = role;
    }
    if (!entry.grants[entry.minRole]) {
      problems.push(`"${entry.permission}" minRole ${entry.minRole} is not granted`);
    }
    // (6) grants must equal can() (guards against hand-edited grant tables).
    for (const role of ROLES) {
      roleChecks += 1;
      if (entry.grants[role] !== can(role, entry.permission)) {
        problems.push(`"${entry.permission}" grants[${role}] disagrees with can()`);
      }
    }
  }

  // (7) ROLE_RANK is ascending in ROLES order (viewer:0 … owner:3).
  for (const [index, role] of ROLES.entries()) {
    if (ROLE_RANK[role] !== index) {
      problems.push(`ROLE_RANK["${role}"] is ${String(ROLE_RANK[role])}; ROLES order implies ${index}`);
    }
  }

  // (8) PERMISSIONS per-role lists match the matrix grants exactly (order + contents).
  for (const role of ROLES) {
    const grantedRows = PERMISSION_MATRIX.filter((entry) => entry.grants[role]);
    const fromMatrix = grantedRows.map((entry) => entry.permission);
    const declared = [...PERMISSIONS[role]];
    if (
      declared.length !== fromMatrix.length ||
      declared.some((p, index) => p !== fromMatrix[index])
    ) {
      problems.push(`PERMISSIONS["${role}"] does not match the matrix grants`);
    }
  }

  return {
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    adrRows: ADR_RBAC_TABLE.length,
    permissions: PERMISSION_MATRIX.length,
    roleChecks
  };
}

/**
 * Self-test export: throws a loud, complete error listing every drift between
 * the live permission table and the ADR-0003 matrix. CI (tests/authz.test.ts)
 * asserts this does not throw; adding a role or permission is a migration +
 * matrix change first (ADR-0003: role names are wire-stable).
 */
export function assertMatrixMatchesAdr(audit: RbacMatrixAudit = auditMatrix()): void {
  if (!audit.ok) {
    throw new Error(
      `RBAC matrix drift vs ADR-0003 (${audit.problems.length} problem(s), ${audit.roleChecks} cells checked):\n` +
        audit.problems.map((problem) => `  - ${problem}`).join("\n")
    );
  }
}
