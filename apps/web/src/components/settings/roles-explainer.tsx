/**
 * RolesExplainer — the §8.9 "Roles" surface (W2-06): what owner / admin /
 * editor / viewer can each do.
 *
 * SOURCE OF TRUTH: `packages/db/src/permissions.ts` (CAPABILITIES +
 * ROLE_CAPABILITIES — PRODUCT_ARCHITECTURE §3.3 / ADR-0003 §RBAC). apps/web
 * cannot depend on `@studio/db`, so the matrix is RESTATED here verbatim from
 * that file; `roles-explainer.test.tsx` pins all 15 capability rows and the
 * arms against the db source so drift fails a test, not a user. The gateway
 * re-checks every capability on every request (permissions.ts: "UI hiding is
 * never enforcement") — the caption says so.
 *
 * No interactivity: rendered straight from the RSC members page.
 */

import {
  Badge,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@studio/ui";
import { Check } from "lucide-react";

/**
 * The four wire roles (contracts `Role`; ROLES in permissions.ts) —
 * cumulative: viewer ⊂ editor ⊂ admin ⊂ owner.
 */
const ROLE_COLUMNS = ["viewer", "editor", "admin", "owner"] as const;

type ColumnRole = (typeof ROLE_COLUMNS)[number];

/**
 * permissions.ts `ROLE_CAPABILITIES`, flattened to one row per capability
 * (15 rows — the CAPABILITIES const) with a human label per capability.
 * Booleans are transcribed from the source arrays, NOT invented:
 *
 *   VIEWER = read, comment, openEditor
 *   EDITOR = VIEWER + createProjects, takeLease, runAgent, uploadAssets, render
 *   ADMIN  = EDITOR + invite, removeMembers, manageBilling, manageApiKeys,
 *            manageWorkspace
 *   OWNER  = ADMIN + deleteWorkspace, transferOwnership
 */
const CAPABILITY_ROWS: readonly {
  readonly key: string;
  readonly label: string;
  readonly allowed: Readonly<Record<ColumnRole, boolean>>;
}[] = [
  {
    key: "read",
    label: "Read projects, assets and versions",
    allowed: { viewer: true, editor: true, admin: true, owner: true },
  },
  {
    key: "comment",
    label: "Comment on projects",
    allowed: { viewer: true, editor: true, admin: true, owner: true },
  },
  {
    key: "openEditor",
    label: "Open the editor (read-only without a lease)",
    allowed: { viewer: true, editor: true, admin: true, owner: true },
  },
  {
    key: "createProjects",
    label: "Create and edit projects",
    allowed: { viewer: false, editor: true, admin: true, owner: true },
  },
  {
    key: "takeLease",
    label: "Take the edit lease",
    allowed: { viewer: false, editor: true, admin: true, owner: true },
  },
  {
    key: "runAgent",
    label: "Run the agent and manual commands",
    allowed: { viewer: false, editor: true, admin: true, owner: true },
  },
  {
    key: "uploadAssets",
    label: "Upload assets",
    allowed: { viewer: false, editor: true, admin: true, owner: true },
  },
  {
    key: "render",
    label: "Create renders and exports",
    allowed: { viewer: false, editor: true, admin: true, owner: true },
  },
  {
    key: "invite",
    label: "Invite members",
    allowed: { viewer: false, editor: false, admin: true, owner: true },
  },
  {
    key: "removeMembers",
    label: "Remove members",
    allowed: { viewer: false, editor: false, admin: true, owner: true },
  },
  {
    key: "manageBilling",
    label: "Manage billing and plans",
    allowed: { viewer: false, editor: false, admin: true, owner: true },
  },
  {
    key: "manageApiKeys",
    label: "Create and revoke API keys",
    allowed: { viewer: false, editor: false, admin: true, owner: true },
  },
  {
    key: "manageWorkspace",
    label: "Change workspace settings",
    allowed: { viewer: false, editor: false, admin: true, owner: true },
  },
  {
    key: "deleteWorkspace",
    label: "Delete the workspace",
    allowed: { viewer: false, editor: false, admin: false, owner: true },
  },
  {
    key: "transferOwnership",
    label: "Transfer ownership",
    allowed: { viewer: false, editor: false, admin: false, owner: true },
  },
];

/** One-line role summaries (the cumulative viewer ⊂ editor ⊂ admin ⊂ owner). */
const ROLE_SUMMARIES: readonly { readonly role: ColumnRole; readonly line: string }[] = [
  {
    role: "owner",
    line: "Full control — everything an admin does, plus deleting the workspace and transferring ownership.",
  },
  {
    role: "admin",
    line: "Runs the workspace: invites and removes members, manages billing, API keys and settings.",
  },
  {
    role: "editor",
    line: "Makes the work: creates projects, runs the agent, uploads assets and renders.",
  },
  {
    role: "viewer",
    line: "Follows along: reads projects, comments, and opens the editor read-only.",
  },
];

function AllowedCell({ allowed }: { readonly allowed: boolean }): React.ReactNode {
  return (
    <TableCell className="text-center">
      {allowed ? (
        <span className="inline-flex items-center">
          <Check size={16} strokeWidth={1.75} aria-hidden="true" className="text-primary" />
          <span className="sr-only">Allowed</span>
        </span>
      ) : (
        <span className="inline-flex items-center">
          <span aria-hidden="true" className="text-muted">
            —
          </span>
          <span className="sr-only">Not allowed</span>
        </span>
      )}
    </TableCell>
  );
}

export function RolesExplainer() {
  return (
    <Card data-testid="roles-explainer">
      <CardHeader>
        <CardTitle>Roles</CardTitle>
        <CardDescription>
          What each role can do in this workspace. Roles are cumulative — every role includes the
          one below it. The server re-checks every action on every request, so these limits hold
          even where the interface hides a button.
        </CardDescription>
      </CardHeader>

      <ul className="mb-6 flex flex-col gap-2" data-testid="roles-summaries">
        {ROLE_SUMMARIES.map((summary) => (
          <li
            key={summary.role}
            className="flex items-baseline gap-3"
            data-testid={`role-summary-${summary.role}`}
          >
            <Badge variant={summary.role === "owner" ? "signal" : "neutral"}>{summary.role}</Badge>
            <span className="text-body-s text-secondary">{summary.line}</span>
          </li>
        ))}
      </ul>

      <Table data-testid="roles-matrix">
        <TableHeader>
          <TableRow>
            <TableHead>Capability</TableHead>
            {ROLE_COLUMNS.map((role) => (
              <TableHead key={role} className="text-center">
                {role}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {CAPABILITY_ROWS.map((row) => (
            <TableRow key={row.key} data-testid={`capability-${row.key}`}>
              <TableCell className="text-primary">{row.label}</TableCell>
              {ROLE_COLUMNS.map((role) => (
                <AllowedCell key={role} allowed={row.allowed[role]} />
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <p className="mt-4 text-caption text-muted">
        Sourced from the same role matrix the gateway enforces — one source of truth, no invented
        rows.
      </p>
    </Card>
  );
}
