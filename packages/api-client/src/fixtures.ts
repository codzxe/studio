// @studio/api-client — deterministic dev/demo fixtures.
//
// Everything a web dev-mode needs to render a REAL-looking Studio workspace
// without a backend: a demo user, two workspaces, six motion-graphics
// projects (each with a 4-version manifest), image/video/audio/font assets,
// chat threads with an applied run and an undone run, a credit ledger that
// balances to 3200, comments, activity and renders. Ids are deterministic and
// clearly demo (`prj_demo_…`); URLs use the RFC 2606 `studio.example.com`
// placeholder domain — this data LOOKS real but can never be mistaken for
// production.
//
// Every row is validated against the contracts schemas: `validateFixtures()`
// runs the whole object through the api-client response schemas (mirroring
// the contracts interfaces) plus EDIT_PLAN_SCHEMA, STUDIO_STREAM_EVENT_SCHEMA
// and CHAT_REQUEST_SCHEMA from @studio/contracts. Call it once in dev mode.

import {
  CHAT_REQUEST_SCHEMA,
  type ChatRequest,
  EDIT_PLAN_SCHEMA,
  type EditPlan,
  type RunClientAction,
  STUDIO_STREAM_EVENT_SCHEMA,
  type ThreadMessage,
} from "@studio/contracts";

import type {
  AcceptedInvite,
  ActivityEntry,
  Asset,
  Comment,
  CreateAssetResponse,
  CreditsSummary,
  Invite,
  LedgerEntry,
  MeResponse,
  Member,
  MemberRemoved,
  OwnershipTransferred,
  Page,
  Project,
  ProjectManifest,
  ProjectVersion,
  RenderJob,
  RunRecord,
  StudioStreamEvent,
  SwitchedWorkspace,
  Thread,
  Workspace,
} from "@studio/contracts";
import type { z } from "zod";
import {
  ACTIVITY_ENTRY_SCHEMA,
  ASSET_SCHEMA,
  CHECKOUT_RESPONSE_SCHEMA,
  COMMENT_SCHEMA,
  CREATE_ASSET_RESPONSE_SCHEMA,
  CREDITS_SUMMARY_SCHEMA,
  INVITE_SCHEMA,
  LEASE_ACQUIRE_RESPONSE_SCHEMA,
  LEDGER_ENTRY_SCHEMA,
  MEMBER_REMOVED_SCHEMA,
  MEMBER_SCHEMA,
  OWNERSHIP_TRANSFERRED_SCHEMA,
  type LeaseAcquireResponse,
  type MANIFEST_ASSET_SCHEMA,
  ME_RESPONSE_SCHEMA,
  PAGE_ACTIVITY_SCHEMA,
  PAGE_MEMBERS_SCHEMA,
  PROJECT_MANIFEST_SCHEMA,
  PROJECT_SCHEMA,
  PROJECT_VERSION_SCHEMA,
  RENDER_JOB_SCHEMA,
  RUN_RECORD_SCHEMA,
  SWITCHED_WORKSPACE_SCHEMA,
  THREAD_MESSAGE_SCHEMA,
  THREAD_SCHEMA,
  WORKSPACE_SCHEMA,
} from "./response-schemas";

/**
 * EffectCraft timeline tick rate (editor/crates/time: TICKS_PER_SECOND) —
 * fixtures express media/comment durations in engine ticks for realism.
 */
export const DEMO_TICKS_PER_SECOND = 254_016_000_000;

/** Banner for any dev surface rendering this data. */
export const FIXTURES_DEMO_NOTICE =
  "Deterministic development fixtures — plausible demo data, never production.";

const seconds = (s: number): number => s * DEMO_TICKS_PER_SECOND;

// Content-addressed digests: real sha256 of `studio-demo:<key>` (deterministic).
const VERSION_SHA: Readonly<Record<string, string>> = {
  "launch-film:v1": "0c01287417e8593e95e060df1a81b08ecb641d54c8ba24fb62f33759a61828dd",
  "launch-film:v2": "f51fffda74cdc5c37ebe0fbc2ad84ed3a872b903ed278684f4c89365f4c5bf7e",
  "launch-film:v3": "f601fdfbdb94af25457a696b7059245d41f82512cd352fa98997f2c757f1c6fc",
  "launch-film:v4": "dd09a471b5261a95ef92cc99366fbb69f2d426eb6fab917771b2798d2144852f",
  "title-seq:v1": "7f50e13145ec8bf03c9aae539b4106c93cdb198742b51a33511c887e4f7b0feb",
  "title-seq:v2": "a21a5251e8887007f5bff749a2b96080d0dbdb4ffd6803c9209d586cdb8c5518",
  "title-seq:v3": "16d72f465099e15ea1ef5ef4b0c385040da068b2108abce0444fffb02659e16a",
  "title-seq:v4": "4deabbfbd0e637efda4dc8a7f07b0dcdb0010da2f6fb5820d6e7d4eab427a956",
  "lower-thirds:v1": "36cc5ad35a6edaf877e3a0f49f09b63d9ed5bab830fa404e6d686dcb5ce70347",
  "lower-thirds:v2": "903355330f658e05e10a7fda09b9247df125d1d68e62593d7007602f7c99ddbb",
  "lower-thirds:v3": "94bec095d67b302262af6b9432c419feacaa62b838a2efbcbabac9e096d2b3f4",
  "lower-thirds:v4": "0c7692e66d44bdf299bbb67ef4a1766797ffe6b67d9e92112017c685499fe26c",
  "logo-reveal:v1": "489de563fc8b764bbb5065c53025f7789e0b0281f9e200551df928a95c918a10",
  "logo-reveal:v2": "7901d6c9b54471d3626dc811ffb7c811678d83423f792ff691a560341ff780b9",
  "logo-reveal:v3": "8b56b7b11c1fd49e9ce5667bb9268e733e2cc4bb49e0fb9ac0cc4409ad8eca3d",
  "logo-reveal:v4": "fd3f8fdcbf27977a5db132d2294b74c56a693a5fabebd72adbb5da1de3f4554d",
  "social-teaser:v1": "1af1fb067c746956b7341167ffbab8c6ea1570e2ffc050b364a3007cfb0920bd",
  "social-teaser:v2": "99b2361fe90aafee06db2c46422c7688e9623880b87571e0be838def884fc477",
  "social-teaser:v3": "cee278631b181b12da6a06eedf0c22dd6781a8f29b7357f13cc417c0f070534e",
  "social-teaser:v4": "62596125942b5276d12df6668a3f1c92e73f143acb1fd3da07d09aa0b16a122e",
  "product-film:v1": "bb8c7acee345f63ba83150a66727568664488556565882d14b94db6026e2aec3",
  "product-film:v2": "3c066e502c07c02b2c80eadea932e69ad88167520eea8abbc4fddff8da123adc",
  "product-film:v3": "b902a6d0fcc1d76a3a22c86a986b6aef9514edb8a6f55477343bc47b76067733",
  "product-film:v4": "b3dd396f60b753c7c728003b65fbfabca4003236fbd7244baa4d9307a4916bbc",
};

const ASSET_SHA: Readonly<Record<string, string>> = {
  "hero-frame-graded.png": "15151e7a0d7b98ad8e46877df190de854af0ab62f45fa436b95ee57c6de9bb96",
  "broll-city-dusk.mp4": "cfb2b2d992ff84698b3796ea752582d0f5b9572ebb755ce91b9605d267ac0c4e",
  "theme-pulse-95bpm.wav": "e029e265fb6fd0726ee5b4eec151d40bfb10d737651211ec162896ea79b12173",
  "KraftMono-Regular.ttf": "a05efedecda94a0ac7304f239cb4ca47a4a4811b0f7190800b42699007072b37",
};

/** Signed-URL-shaped demo links (placeholder domain, obviously fake expiry). */
function demoUrl(...parts: string[]): string {
  return `https://cdn.studio.example.com/${parts.join("/")}?sig=demo&expires=2030-01-01T00%3A00%3A00Z`;
}

// ---------------------------------------------------------------------------
// Users, workspaces, me
// ---------------------------------------------------------------------------

const DEMO_USER_ID = "usr_demo_maya";
const DEMO_USER = {
  id: DEMO_USER_ID,
  name: "Maya Okafor",
  email: "maya@northlight.example",
} as const satisfies MeResponse["user"];

const WORKSPACE_NORTHLIGHT: Workspace = {
  id: "wsp_demo_northlight",
  name: "Northlight Motion",
  slug: "northlight-motion",
  createdAt: "2026-09-02T10:00:00Z",
  updatedAt: "2026-10-14T16:20:00Z",
};

const WORKSPACE_HALO: Workspace = {
  id: "wsp_demo_halo",
  name: "Halo Pictures",
  slug: "halo-pictures",
  createdAt: "2026-09-18T14:30:00Z",
  updatedAt: "2026-10-12T11:05:00Z",
};

const DEMO_ME: MeResponse = {
  user: DEMO_USER,
  memberships: [
    {
      workspaceId: WORKSPACE_NORTHLIGHT.id,
      role: "owner",
      workspace: {
        id: WORKSPACE_NORTHLIGHT.id,
        name: WORKSPACE_NORTHLIGHT.name,
        slug: WORKSPACE_NORTHLIGHT.slug,
      },
    },
    {
      workspaceId: WORKSPACE_HALO.id,
      role: "editor",
      workspace: {
        id: WORKSPACE_HALO.id,
        name: WORKSPACE_HALO.name,
        slug: WORKSPACE_HALO.slug,
      },
    },
  ],
  plan: {
    plan: "pro",
    creditsBalance: 3200,
    includedCredits: 2500,
    renewsAt: "2026-11-01T00:00:00Z",
  },
};

/** A pending demo invite (Halo Pictures → designer). */
const DEMO_INVITE: Invite = {
  id: "inv_demo_halo_design",
  workspaceId: WORKSPACE_HALO.id,
  email: "rive@halopictures.example",
  role: "editor",
  status: "pending",
  expiresAt: "2026-10-31T23:59:59Z",
  createdAt: "2026-10-10T09:15:00Z",
};

const DEMO_ACCEPTED_INVITE: AcceptedInvite = {
  inviteId: "inv_demo_halo_design",
  workspaceId: WORKSPACE_HALO.id,
  role: "editor",
};

// ---------------------------------------------------------------------------
// Projects (§7.2) — six motion-graphics jobs in the Northlight workspace
// ---------------------------------------------------------------------------

interface ProjectSeed {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly thumbnail: string | null;
  readonly sizeBytes: number;
  readonly versionLabels: readonly [string, string, string, string];
  readonly versionDates: readonly [string, string, string, string];
}

const PROJECT_SEEDS: readonly ProjectSeed[] = [
  {
    key: "launch-film",
    id: "prj_demo_launch_film",
    name: "Launch film",
    slug: "launch-film",
    createdAt: "2026-09-22T09:30:00Z",
    updatedAt: "2026-10-09T18:05:00Z",
    thumbnail: demoUrl("wsp_demo_northlight", "projects", "prj_demo_launch_film", "thumb.jpg"),
    sizeBytes: 812_544,
    versionLabels: [
      "Initial cut",
      "Client notes round 1",
      "Agent: subhead overshoot (undone)",
      "Agent: headline spring pop-in",
    ],
    versionDates: [
      "2026-09-22T10:05:00Z",
      "2026-10-02T15:40:00Z",
      "2026-10-06T11:26:00Z",
      "2026-10-09T18:05:00Z",
    ],
  },
  {
    key: "title-seq",
    id: "prj_demo_title_seq",
    name: "Title sequence — Brand reel",
    slug: "title-sequence-brand-reel",
    createdAt: "2026-09-24T13:00:00Z",
    updatedAt: "2026-10-11T10:12:00Z",
    thumbnail: demoUrl("wsp_demo_northlight", "projects", "prj_demo_title_seq", "thumb.jpg"),
    sizeBytes: 1_204_352,
    versionLabels: ["First pass", "Type timing pass", "Grade + grain", "Deliverable v1"],
    versionDates: [
      "2026-09-24T14:18:00Z",
      "2026-09-29T09:02:00Z",
      "2026-10-05T16:44:00Z",
      "2026-10-11T10:12:00Z",
    ],
  },
  {
    key: "lower-thirds",
    id: "prj_demo_lower_thirds",
    name: "Lower thirds — Podcast",
    slug: "lower-thirds-podcast",
    createdAt: "2026-09-26T08:45:00Z",
    updatedAt: "2026-10-07T12:30:00Z",
    thumbnail: demoUrl("wsp_demo_northlight", "projects", "prj_demo_lower_thirds", "thumb.jpg"),
    sizeBytes: 386_048,
    versionLabels: ["Layout draft", "Two variants", "Agent: align to safe margins", "Final"],
    versionDates: [
      "2026-09-26T09:20:00Z",
      "2026-09-30T11:55:00Z",
      "2026-10-07T12:30:00Z",
      "2026-10-08T08:03:00Z",
    ],
  },
  {
    key: "logo-reveal",
    id: "prj_demo_logo_reveal",
    name: "Logo reveal",
    slug: "logo-reveal",
    createdAt: "2026-09-29T15:10:00Z",
    updatedAt: "2026-10-13T17:22:00Z",
    thumbnail: demoUrl("wsp_demo_northlight", "projects", "prj_demo_logo_reveal", "thumb.jpg"),
    sizeBytes: 524_288,
    versionLabels: ["Board animatic", "Sting shape pass", "Materials", "Master"],
    versionDates: [
      "2026-09-29T16:00:00Z",
      "2026-10-03T10:41:00Z",
      "2026-10-09T13:15:00Z",
      "2026-10-13T17:22:00Z",
    ],
  },
  {
    key: "social-teaser",
    id: "prj_demo_social_teaser",
    name: "Social teaser 9:16",
    slug: "social-teaser-9-16",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-14T09:48:00Z",
    thumbnail: demoUrl("wsp_demo_northlight", "projects", "prj_demo_social_teaser", "thumb.jpg"),
    sizeBytes: 298_496,
    versionLabels: ["Vertical retime", "Captions on", "Sound pass", "Ready for review"],
    versionDates: [
      "2026-10-01T11:26:00Z",
      "2026-10-05T09:18:00Z",
      "2026-10-10T14:52:00Z",
      "2026-10-14T09:48:00Z",
    ],
  },
  {
    key: "product-film",
    id: "prj_demo_product_film",
    name: "Product film",
    slug: "product-film",
    createdAt: "2026-10-03T09:12:00Z",
    updatedAt: "2026-10-15T08:40:00Z",
    thumbnail: null,
    sizeBytes: 962_560,
    versionLabels: ["Edit start", "Voiceover scratch", "Hero shots in", "WIP"],
    versionDates: [
      "2026-10-03T10:02:00Z",
      "2026-10-06T15:30:00Z",
      "2026-10-11T12:07:00Z",
      "2026-10-15T08:40:00Z",
    ],
  },
] as const;

function versionIdFor(seed: ProjectSeed, n: 1 | 2 | 3 | 4): string {
  return `ver_demo_${seed.key.replace(/-/g, "_")}_${n}`;
}

/** Agent-run annotations on versions (§9.1 `agent_runs` history). */
const AGENT_VERSION_RUNS: Readonly<Record<string, string>> = {
  ver_demo_launch_film_3: "run_demo_launch_undone",
  ver_demo_launch_film_4: "run_demo_launch_applied",
  ver_demo_lower_thirds_3: "run_demo_lower_align",
};

/** Fixed-length fixture tuples: call sites pass literal 0-3 indices. */
function tupleAt<T>(values: readonly T[], index: number): T {
  return values[index] as T;
}

function buildVersions(seed: ProjectSeed): ProjectVersion[] {
  return ([1, 2, 3, 4] as const).map((index) => {
    const id = versionIdFor(seed, index);
    const agentRunId = AGENT_VERSION_RUNS[id] ?? null;
    return {
      id,
      projectId: seed.id,
      version: index,
      parentVersionId: index === 1 ? null : versionIdFor(seed, (index - 1) as 1 | 2 | 3),
      sha256: VERSION_SHA[`${seed.key}:v${index}`] ?? "",
      sizeBytes: Math.round(seed.sizeBytes * (1 + index * 0.06)),
      label: tupleAt(seed.versionLabels, index - 1),
      agentRunId,
      createdBy: DEMO_USER_ID,
      createdAt: tupleAt(seed.versionDates, index - 1),
    } satisfies ProjectVersion;
  });
}

const DEMO_PROJECTS: readonly Project[] = PROJECT_SEEDS.map((seed) => ({
  id: seed.id,
  workspaceId: WORKSPACE_NORTHLIGHT.id,
  name: seed.name,
  slug: seed.slug,
  thumbnailUrl: seed.thumbnail,
  currentVersionId: versionIdFor(seed, 4),
  createdBy: DEMO_USER_ID,
  createdAt: seed.createdAt,
  updatedAt: seed.updatedAt,
  deletedAt: null,
})) satisfies readonly Project[];

// ---------------------------------------------------------------------------
// Assets (image / video / audio / font — §12.3 upload allowlist)
// ---------------------------------------------------------------------------

interface AssetSeed {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationTicks: number | null;
  readonly projectId: string | null;
  readonly createdAt: string;
}

const ASSET_SEEDS: readonly AssetSeed[] = [
  {
    id: "ast_demo_hero_frame",
    name: "hero-frame-graded.png",
    mime: "image/png",
    sizeBytes: 2_511_616,
    width: 1920,
    height: 1080,
    durationTicks: null,
    projectId: "prj_demo_launch_film",
    createdAt: "2026-10-02T14:08:00Z",
  },
  {
    id: "ast_demo_broll_city",
    name: "broll-city-dusk.mp4",
    mime: "video/mp4",
    sizeBytes: 41_943_040,
    width: 1920,
    height: 1080,
    durationTicks: seconds(4),
    projectId: null,
    createdAt: "2026-09-28T16:34:00Z",
  },
  {
    id: "ast_demo_theme_music",
    name: "theme-pulse-95bpm.wav",
    mime: "audio/wav",
    sizeBytes: 3_176_448,
    width: null,
    height: null,
    durationTicks: seconds(18),
    projectId: null,
    createdAt: "2026-10-05T10:22:00Z",
  },
  {
    id: "ast_demo_kraft_mono",
    name: "KraftMono-Regular.ttf",
    mime: "font/ttf",
    sizeBytes: 188_416,
    width: null,
    height: null,
    durationTicks: null,
    projectId: null,
    createdAt: "2026-09-30T08:47:00Z",
  },
] as const;

const DEMO_ASSETS: readonly Asset[] = ASSET_SEEDS.map((seed) => ({
  id: seed.id,
  workspaceId: WORKSPACE_NORTHLIGHT.id,
  projectId: seed.projectId,
  name: seed.name,
  mime: seed.mime,
  sizeBytes: seed.sizeBytes,
  sha256: ASSET_SHA[seed.name] ?? "",
  width: seed.width,
  height: seed.height,
  durationTicks: seed.durationTicks,
  createdBy: DEMO_USER_ID,
  createdAt: seed.createdAt,
})) satisfies readonly Asset[];

/** Create-asset responses (descriptor + signed upload target), one per asset. */
const DEMO_CREATE_ASSET_RESPONSES: readonly CreateAssetResponse[] = ASSET_SEEDS.map((seed) => {
  const asset = DEMO_ASSETS.find((row) => row.id === seed.id) ?? null;
  if (asset === null) throw new Error("fixture mismatch: create-asset seed");
  return {
    asset,
    upload: {
      url: demoUrl("wsp_demo_northlight", "assets", seed.id, "upload"),
      method: "PUT",
      expiresAt: "2026-10-15T09:15:00Z",
      headers: { "x-demo-upload": "fixture" },
    },
  } satisfies CreateAssetResponse;
});

// ---------------------------------------------------------------------------
// Manifests (GET /v1/projects/:id/manifest)
// ---------------------------------------------------------------------------

const MANIFEST_ASSETS: readonly z.infer<typeof MANIFEST_ASSET_SCHEMA>[] = ASSET_SEEDS.map(
  (seed) => ({
    id: seed.id,
    name: seed.name,
    mime: seed.mime,
    sizeBytes: seed.sizeBytes,
    width: seed.width,
    height: seed.height,
    durationTicks: seed.durationTicks,
    url: demoUrl("wsp_demo_northlight", "assets", seed.id),
  }),
);

const DEMO_MANIFESTS: Readonly<Record<string, ProjectManifest>> = Object.fromEntries(
  PROJECT_SEEDS.map((seed) => {
    const versions = buildVersions(seed);
    const current = versions[3];
    if (current === undefined) throw new Error("fixture mismatch: current version");
    return [
      seed.id,
      {
        projectId: seed.id,
        currentVersion: {
          id: current.id,
          version: current.version,
          sha256: current.sha256,
          label: current.label,
          sizeBytes: current.sizeBytes,
          createdAt: current.createdAt,
          url: demoUrl("wsp_demo_northlight", "projects", seed.id, "versions", current.id),
        },
        assets: MANIFEST_ASSETS,
        updatedAt: current.createdAt,
      } satisfies ProjectManifest,
    ];
  }),
);

// ---------------------------------------------------------------------------
// Threads, messages, plans, runs
// ---------------------------------------------------------------------------

const THREAD_LAUNCH: Thread = {
  id: "thr_demo_launch",
  projectId: "prj_demo_launch_film",
  title: "Headline spring pop-in",
  createdBy: DEMO_USER_ID,
  createdAt: "2026-10-09T17:44:00Z",
  updatedAt: "2026-10-09T18:06:00Z",
} satisfies Thread;

const THREAD_SUBHEAD: Thread = {
  id: "thr_demo_subhead",
  projectId: "prj_demo_launch_film",
  title: "Subhead easing, softer",
  createdBy: DEMO_USER_ID,
  createdAt: "2026-10-06T11:12:00Z",
  updatedAt: "2026-10-06T11:27:00Z",
} satisfies Thread;

const THREAD_LOGO: Thread = {
  id: "thr_demo_logo",
  projectId: "prj_demo_logo_reveal",
  title: "Logo sting options",
  createdBy: DEMO_USER_ID,
  createdAt: "2026-10-13T16:40:00Z",
  updatedAt: "2026-10-13T17:20:00Z",
} satisfies Thread;

const DEMO_THREADS: readonly Thread[] = [THREAD_LAUNCH, THREAD_SUBHEAD, THREAD_LOGO];

function message(
  id: string,
  threadId: string,
  role: ThreadMessage["role"],
  content: string,
  runId: string | null,
  createdAt: string,
): ThreadMessage {
  return { id, threadId, role, content, runId, createdAt } satisfies ThreadMessage;
}

const DEMO_MESSAGES: Readonly<Record<string, readonly ThreadMessage[]>> = {
  thr_demo_launch: [
    message(
      "msg_demo_l1",
      "thr_demo_launch",
      "user",
      "Make the headline pop in with a springy scale — keep it tight against the music.",
      null,
      "2026-10-09T17:44:20Z",
    ),
    message(
      "msg_demo_l2",
      "thr_demo_launch",
      "assistant",
      "I'll animate Scale from 20% to 100% with an overshoot at 0.45s, settling at 0.7s. The text layer stays fully editable — one undo step if you want it back.",
      "run_demo_launch_applied",
      "2026-10-09T18:05:40Z",
    ),
  ],
  thr_demo_subhead: [
    message(
      "msg_demo_s1",
      "thr_demo_subhead",
      "user",
      "Try the same overshoot on the subhead, but softer — it shouldn't fight the headline.",
      null,
      "2026-10-06T11:12:30Z",
    ),
    message(
      "msg_demo_s2",
      "thr_demo_subhead",
      "assistant",
      "Applied a softer overshoot to Subhead (108% peak, 0.6s settle). You later undid this run from the Applied card.",
      "run_demo_launch_undone",
      "2026-10-06T11:26:50Z",
    ),
  ],
  thr_demo_logo: [
    message(
      "msg_demo_g1",
      "thr_demo_logo",
      "user",
      "Give me a brassier logo sting for the reveal — heavier impact, more shine on the mark.",
      null,
      "2026-10-13T16:40:10Z",
    ),
    message(
      "msg_demo_g2",
      "thr_demo_logo",
      "assistant",
      "Here's a plan: heavier impact via a 2-frame overshoot, a specular sweep across the mark, and a deeper brass grade. This touches 6 layers — review before I apply.",
      "run_demo_logo_sting_planned",
      "2026-10-13T17:19:58Z",
    ),
  ],
};

// --- Edit plans (§8.6; estimatedCredits follows contracts.estimateCredits) ---

const PLAN_HEADLINE_SPRING: EditPlan = {
  intent: "animate",
  summary: "Springy scale pop-in on Headline: 20% → 110% → 100%, settle at 0.7s.",
  risk: "low",
  requiresApproval: false,
  affectedLayers: [{ id: 3, name: "Headline", change: "Scale keyframes 20% → 110% → 100%" }],
  estimatedCredits: 2,
  steps: [
    {
      title: "Keyframe Scale on Headline",
      tool: "studio.set_keyframes",
      args: {
        layer: "Headline",
        property: "transform.scale",
        keyframes: [
          { time: 0, value: 0.2, ease: "spring" },
          { time: 0.45, value: 1.1, ease: "spring" },
          { time: 0.7, value: 1, ease: "cubic-out" },
        ],
      },
      batch: {
        label: "Agent: headline spring pop-in",
        steps: [
          {
            command: "property.set_keyframes",
            params: {
              layerId: "lyr_demo_headline",
              property: "transform.scale",
              keyframes: [
                { time: 0, value: 0.2 },
                { time: 0.45, value: 1.1 },
                { time: 0.7, value: 1 },
              ],
            },
          },
        ],
      },
    },
    {
      title: "Keep the text layer editable",
      tool: "studio.save_version",
      args: { label: "Agent: headline spring pop-in" },
      batch: {
        label: "Agent: save version",
        steps: [
          { command: "project.save_version", params: { label: "Agent: headline spring pop-in" } },
        ],
      },
    },
  ],
} satisfies EditPlan;

const PLAN_SUBHEAD_SOFTER: EditPlan = {
  intent: "animate",
  summary: "Softer overshoot on Subhead: 108% peak, 0.6s settle, gentler curve.",
  risk: "low",
  requiresApproval: false,
  affectedLayers: [{ id: 4, name: "Subhead", change: "Scale keyframes → 108% peak" }],
  estimatedCredits: 2,
  steps: [
    {
      title: "Keyframe Scale on Subhead",
      tool: "studio.set_keyframes",
      args: {
        layer: "Subhead",
        property: "transform.scale",
        keyframes: [
          { time: 0, value: 0.24, ease: "spring" },
          { time: 0.3, value: 1.08, ease: "spring" },
          { time: 0.6, value: 1, ease: "cubic-out" },
        ],
      },
      batch: {
        label: "Agent: subhead softer overshoot",
        steps: [
          {
            command: "property.set_keyframes",
            params: {
              layerId: "lyr_demo_subhead",
              property: "transform.scale",
              keyframes: [
                { time: 0, value: 0.24 },
                { time: 0.3, value: 1.08 },
                { time: 0.6, value: 1 },
              ],
            },
          },
        ],
      },
    },
  ],
} satisfies EditPlan;

const PLAN_LOGO_STING: EditPlan = {
  intent: "style",
  summary: "Brassier logo sting: 2-frame impact overshoot, specular sweep, deeper brass grade.",
  risk: "medium",
  requiresApproval: true,
  affectedLayers: [
    { id: 2, name: "Logo mark", change: "Scale overshoot + specular sweep" },
    { id: 3, name: "Logo wordmark", change: "Reveal offset 2 frames later" },
    { id: 5, name: "Glow underlay", change: "Intensity 60% → 85%" },
    { id: 7, name: "Grade adjust", change: "Warm highlights +6, saturation +4" },
    { id: 9, name: "Impact flash", change: "Opacity ramp 2 frames" },
    { id: 11, name: "Shadow contact", change: "Blur 18px, offset 6px down" },
  ],
  estimatedCredits: 3.13,
  steps: [
    {
      title: "Impact overshoot on the mark",
      tool: "studio.set_keyframes",
      args: { layer: "Logo mark", property: "transform.scale" },
      batch: {
        label: "Agent: mark impact overshoot",
        steps: [
          {
            command: "property.set_keyframes",
            params: { layerId: "lyr_demo_logo_mark", property: "transform.scale" },
          },
        ],
      },
    },
    {
      title: "Specular sweep",
      tool: "studio.add_effect",
      args: { layer: "Logo mark", effect: "linear_wipe_shine", direction: 32 },
      batch: {
        label: "Agent: specular sweep",
        steps: [
          { command: "fx.add", params: { layerId: "lyr_demo_logo_mark", effect: "shine_sweep" } },
        ],
      },
    },
    {
      title: "Brassier grade",
      tool: "studio.set_properties",
      args: { layer: "Grade adjust", warmHighlights: 6, saturation: 4 },
      batch: {
        label: "Agent: brass grade",
        steps: [
          {
            command: "property.set_many",
            params: { layerId: "lyr_demo_grade", warmHighlights: 6, saturation: 4 },
          },
        ],
      },
    },
  ],
} satisfies EditPlan;

// --- Run event sequences (§7.4; replayable through contracts.reduceEvents) ---

const PREVIEW_PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const RUN_APPLIED_EVENTS: readonly StudioStreamEvent[] = [
  { type: "run.started", runId: "run_demo_launch_applied", seq: 0, model: "studio-smart" },
  {
    type: "tool.started",
    runId: "run_demo_launch_applied",
    seq: 1,
    toolCallId: "call_demo_ctx_1",
    name: "studio.get_context",
    args: { blocks: ["projectSummary", "activeComp", "selection", "playhead"] },
  },
  {
    type: "tool.result",
    runId: "run_demo_launch_applied",
    seq: 2,
    toolCallId: "call_demo_ctx_1",
    result: { comps: 1, layers: 42, effects: 7, assets: 6 },
  },
  {
    type: "message.delta",
    runId: "run_demo_launch_applied",
    seq: 3,
    delta: "I'll animate Scale from 20% to 100% with an overshoot at 0.45s, settling at 0.7s. ",
  },
  { type: "plan", runId: "run_demo_launch_applied", seq: 4, plan: PLAN_HEADLINE_SPRING },
  {
    type: "message.delta",
    runId: "run_demo_launch_applied",
    seq: 5,
    delta: "Keyframing now — the text layer stays editable.",
  },
  {
    type: "preview",
    runId: "run_demo_launch_applied",
    seq: 6,
    pngBase64: PREVIEW_PNG_1PX,
    width: 1280,
    height: 720,
  },
  {
    type: "credits",
    runId: "run_demo_launch_applied",
    seq: 7,
    reserved: 36,
    committed: 0,
    balance: 2413,
  },
  {
    type: "credits",
    runId: "run_demo_launch_applied",
    seq: 8,
    reserved: 0,
    committed: 29.75,
    balance: 2389.5,
  },
  {
    type: "run.completed",
    runId: "run_demo_launch_applied",
    seq: 9,
    versionId: "ver_demo_launch_film_4",
  },
] satisfies readonly StudioStreamEvent[];

const RUN_UNDONE_EVENTS: readonly StudioStreamEvent[] = [
  { type: "run.started", runId: "run_demo_launch_undone", seq: 0, model: "studio-fast" },
  {
    type: "message.delta",
    runId: "run_demo_launch_undone",
    seq: 1,
    delta: "Softening the overshoot on Subhead — 108% peak, 0.6s settle.",
  },
  { type: "plan", runId: "run_demo_launch_undone", seq: 2, plan: PLAN_SUBHEAD_SOFTER },
  {
    type: "credits",
    runId: "run_demo_launch_undone",
    seq: 3,
    reserved: 36,
    committed: 0,
    balance: 2464,
  },
  {
    type: "credits",
    runId: "run_demo_launch_undone",
    seq: 4,
    reserved: 0,
    committed: 19.5,
    balance: 2449,
  },
  {
    type: "run.completed",
    runId: "run_demo_launch_undone",
    seq: 5,
    versionId: "ver_demo_launch_film_3",
  },
] satisfies readonly StudioStreamEvent[];

/** §8.1 client actions after the stream: the user undid this run (§7.2). */
const RUN_UNDONE_CLIENT_ACTIONS: readonly RunClientAction[] = [
  { type: "run.undo" },
  { type: "run.undone" },
];

const RUN_APPLIED_RECORD: RunRecord = {
  id: "run_demo_launch_applied",
  threadId: "thr_demo_launch",
  projectId: "prj_demo_launch_film",
  model: "studio-smart",
  status: "completed",
  plan: PLAN_HEADLINE_SPRING,
  steps: [
    { seq: 0, tool: "studio.get_context", status: "succeeded", durationMs: 412 },
    { seq: 1, tool: "studio.set_keyframes", status: "succeeded", durationMs: 388 },
    { seq: 2, tool: "studio.save_version", status: "succeeded", durationMs: 274 },
  ],
  reservedCredits: 36,
  committedCredits: 29.75,
  baseVersionId: "ver_demo_launch_film_3",
  resultVersionId: "ver_demo_launch_film_4",
  errorCode: null,
  createdAt: "2026-10-09T17:44:22Z",
  completedAt: "2026-10-09T18:05:38Z",
} satisfies RunRecord;

const RUN_UNDONE_RECORD: RunRecord = {
  id: "run_demo_launch_undone",
  threadId: "thr_demo_subhead",
  projectId: "prj_demo_launch_film",
  model: "studio-fast",
  status: "completed",
  plan: PLAN_SUBHEAD_SOFTER,
  steps: [
    { seq: 0, tool: "studio.set_keyframes", status: "succeeded", durationMs: 401 },
    { seq: 1, tool: "studio.save_version", status: "succeeded", durationMs: 259 },
  ],
  reservedCredits: 36,
  committedCredits: 19.5,
  baseVersionId: "ver_demo_launch_film_2",
  resultVersionId: "ver_demo_launch_film_3",
  errorCode: null,
  createdAt: "2026-10-06T11:12:32Z",
  completedAt: "2026-10-06T11:26:48Z",
} satisfies RunRecord;

// ---------------------------------------------------------------------------
// Credits (§8.8/§9.1): balance 3200 with a consistent append-only ledger
// ---------------------------------------------------------------------------

const CREDITS_SUMMARY: CreditsSummary = {
  balance: 3200,
  includedCredits: 2500,
  purchasedCredits: 800,
  reserved: 0,
  plan: "pro",
  renewsAt: "2026-11-01T00:00:00Z",
} satisfies CreditsSummary;

interface LedgerSeed {
  readonly id: string;
  readonly kind: LedgerEntry["kind"];
  readonly amount: number;
  readonly balanceAfter: number;
  readonly runId: string | null;
  readonly idempotencyKey: string;
  readonly note: string;
  readonly createdAt: string;
}

const LEDGER_SEEDS: readonly LedgerSeed[] = [
  {
    id: "led_demo_1",
    kind: "grant",
    amount: 2500,
    balanceAfter: 2500,
    runId: null,
    idempotencyKey: "idem-demo-led-0001",
    note: "Monthly included credits — Pro",
    createdAt: "2026-10-01T00:05:00Z",
  },
  {
    id: "led_demo_2",
    kind: "reserve",
    amount: -36,
    balanceAfter: 2464,
    runId: "run_demo_launch_undone",
    idempotencyKey: "idem-demo-led-0002",
    note: "Reserve — subhead softer overshoot",
    createdAt: "2026-10-06T11:12:35Z",
  },
  {
    id: "led_demo_3",
    kind: "commit",
    amount: -19.5,
    balanceAfter: 2444.5,
    runId: "run_demo_launch_undone",
    idempotencyKey: "idem-demo-led-0003",
    note: "Commit — model + apply (run later undone; spend stands)",
    createdAt: "2026-10-06T11:26:40Z",
  },
  {
    id: "led_demo_4",
    kind: "refund",
    amount: 4.5,
    balanceAfter: 2449,
    runId: "run_demo_launch_undone",
    idempotencyKey: "idem-demo-led-0004",
    note: "Refund of unused reserve remainder",
    createdAt: "2026-10-06T11:26:42Z",
  },
  {
    id: "led_demo_5",
    kind: "reserve",
    amount: -36,
    balanceAfter: 2413,
    runId: "run_demo_launch_applied",
    idempotencyKey: "idem-demo-led-0005",
    note: "Reserve — headline spring pop-in",
    createdAt: "2026-10-09T17:44:25Z",
  },
  {
    id: "led_demo_6",
    kind: "commit",
    amount: -29.75,
    balanceAfter: 2383.25,
    runId: "run_demo_launch_applied",
    idempotencyKey: "idem-demo-led-0006",
    note: "Commit — model + apply + version",
    createdAt: "2026-10-09T18:05:41Z",
  },
  {
    id: "led_demo_7",
    kind: "refund",
    amount: 6.25,
    balanceAfter: 2389.5,
    runId: "run_demo_launch_applied",
    idempotencyKey: "idem-demo-led-0007",
    note: "Refund of unused reserve remainder",
    createdAt: "2026-10-09T18:05:43Z",
  },
  {
    id: "led_demo_8",
    kind: "adjust",
    amount: 10.5,
    balanceAfter: 2400,
    runId: null,
    idempotencyKey: "idem-demo-led-0008",
    note: "Goodwill credit — render timeout (runbook RB-04)",
    createdAt: "2026-10-10T09:20:00Z",
  },
  {
    id: "led_demo_9",
    kind: "grant",
    amount: 800,
    balanceAfter: 3200,
    runId: null,
    idempotencyKey: "idem-demo-led-0009",
    note: "Credit pack purchase — 800",
    createdAt: "2026-10-12T14:02:00Z",
  },
] as const;

const DEMO_LEDGER: readonly LedgerEntry[] = LEDGER_SEEDS.map((seed) => ({
  id: seed.id,
  workspaceId: WORKSPACE_NORTHLIGHT.id,
  kind: seed.kind,
  amount: seed.amount,
  balanceAfter: seed.balanceAfter,
  runId: seed.runId,
  idempotencyKey: seed.idempotencyKey,
  metadata: { note: seed.note },
  createdAt: seed.createdAt,
})) satisfies readonly LedgerEntry[];

// ---------------------------------------------------------------------------
// Comments / activity / renders
// ---------------------------------------------------------------------------

const DEMO_COMMENTS: readonly Comment[] = [
  {
    id: "cmt_demo_launch_beat",
    projectId: "prj_demo_launch_film",
    compId: "cmp_demo_launch_main",
    layerId: "lyr_demo_headline",
    timeTicks: seconds(3.5),
    parentCommentId: null,
    body: "Can the headline land one frame earlier? Feels late against the beat.",
    authorId: DEMO_USER_ID,
    guestName: null,
    guestEmail: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: "2026-10-10T10:31:00Z",
  },
  {
    id: "cmt_demo_launch_punch",
    projectId: "prj_demo_launch_film",
    compId: "cmp_demo_launch_main",
    layerId: null,
    timeTicks: seconds(2),
    parentCommentId: null,
    body: "Punch in slightly on the product shot here — 104% should do it.",
    authorId: "usr_demo_jonas",
    guestName: null,
    guestEmail: null,
    resolvedAt: "2026-10-11T09:02:00Z",
    resolvedBy: DEMO_USER_ID,
    createdAt: "2026-10-08T15:41:00Z",
  },
  {
    id: "cmt_demo_lower_safe",
    projectId: "prj_demo_lower_thirds",
    compId: "cmp_demo_lower_main",
    layerId: "lyr_demo_name_bar",
    timeTicks: seconds(1),
    parentCommentId: null,
    body: "Name bar sits a hair low against the vertical-safe margins.",
    authorId: DEMO_USER_ID,
    guestName: null,
    guestEmail: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: "2026-10-07T13:05:00Z",
  },
] satisfies readonly Comment[];

const DEMO_ACTIVITY: readonly ActivityEntry[] = [
  {
    id: "act_demo_1",
    projectId: "prj_demo_launch_film",
    actorId: DEMO_USER_ID,
    actorName: "Maya Okafor",
    action: "project.created",
    targetType: "project",
    targetId: "prj_demo_launch_film",
    createdAt: "2026-09-22T09:30:00Z",
  },
  {
    id: "act_demo_2",
    projectId: null,
    actorId: DEMO_USER_ID,
    actorName: "Maya Okafor",
    action: "asset.uploaded",
    targetType: "asset",
    targetId: "ast_demo_broll_city",
    createdAt: "2026-09-28T16:34:00Z",
  },
  {
    id: "act_demo_3",
    projectId: "prj_demo_launch_film",
    actorId: DEMO_USER_ID,
    actorName: "Maya Okafor",
    action: "run.applied",
    targetType: "run",
    targetId: "run_demo_launch_undone",
    createdAt: "2026-10-06T11:26:50Z",
  },
  {
    id: "act_demo_4",
    projectId: "prj_demo_launch_film",
    actorId: DEMO_USER_ID,
    actorName: "Maya Okafor",
    action: "run.undone",
    targetType: "run",
    targetId: "run_demo_launch_undone",
    createdAt: "2026-10-06T11:29:12Z",
  },
  {
    id: "act_demo_5",
    projectId: "prj_demo_launch_film",
    actorId: "usr_demo_jonas",
    actorName: "Jonas Beck",
    action: "comment.created",
    targetType: "comment",
    targetId: "cmt_demo_launch_punch",
    createdAt: "2026-10-08T15:41:00Z",
  },
  {
    id: "act_demo_6",
    projectId: "prj_demo_launch_film",
    actorId: DEMO_USER_ID,
    actorName: "Maya Okafor",
    action: "run.applied",
    targetType: "run",
    targetId: "run_demo_launch_applied",
    createdAt: "2026-10-09T18:05:44Z",
  },
  {
    id: "act_demo_7",
    projectId: "prj_demo_launch_film",
    actorId: DEMO_USER_ID,
    actorName: "Maya Okafor",
    action: "render.completed",
    targetType: "render",
    targetId: "rnd_demo_launch_mp4",
    createdAt: "2026-10-10T09:18:00Z",
  },
  {
    id: "act_demo_8",
    projectId: "prj_demo_social_teaser",
    actorId: DEMO_USER_ID,
    actorName: "Maya Okafor",
    action: "render.queued",
    targetType: "render",
    targetId: "rnd_demo_social_pngseq",
    createdAt: "2026-10-14T09:49:00Z",
  },
] satisfies readonly ActivityEntry[];

const DEMO_RENDERS: readonly RenderJob[] = [
  {
    id: "rnd_demo_launch_mp4",
    projectId: "prj_demo_launch_film",
    compId: "cmp_demo_launch_main",
    // The §9.2 snapshot the worker renders (v4 is the current version).
    versionId: "ver_demo_launch_film_4",
    format: "mp4",
    settings: {
      timeFrom: 0,
      timeTo: 30,
      width: 1920,
      height: 1080,
      frameRate: 24,
      quality: "good",
    },
    // D-11: the DB vocabulary — `completed`, never `succeeded`.
    status: "completed",
    cancelRequested: false,
    progress: { framesDone: 720, framesTotal: 720, percent: 100 },
    credits: 14,
    resultUrl: demoUrl("wsp_demo_northlight", "renders", "rnd_demo_launch_mp4.mp4"),
    error: null,
    errorCode: null,
    sizeBytes: 48_231_808,
    createdBy: DEMO_USER_ID,
    createdAt: "2026-10-10T09:12:00Z",
    startedAt: "2026-10-10T09:12:20Z",
    completedAt: "2026-10-10T09:17:41Z",
    // §9.2 retention: signed result URLs expire with the output (30 days).
    expiresAt: "2026-11-09T09:17:41Z",
  },
  {
    id: "rnd_demo_social_pngseq",
    projectId: "prj_demo_social_teaser",
    compId: "cmp_demo_social_vertical",
    versionId: "ver_demo_social_teaser_4",
    format: "png-seq",
    settings: {
      timeFrom: 0,
      timeTo: 9,
      width: 1080,
      height: 1920,
      frameRate: 30,
      quality: "draft",
    },
    status: "queued",
    cancelRequested: false,
    progress: { framesDone: 0, framesTotal: 270, percent: 0 },
    credits: null,
    resultUrl: null,
    error: null,
    errorCode: null,
    sizeBytes: null,
    createdBy: DEMO_USER_ID,
    createdAt: "2026-10-14T09:48:30Z",
    startedAt: null,
    completedAt: null,
    expiresAt: null,
  },
] satisfies readonly RenderJob[];

// ---------------------------------------------------------------------------
// Demo chat request + lease + checkout (a few mutation-response fixtures)
// ---------------------------------------------------------------------------

const DEMO_CHAT_REQUEST: ChatRequest = {
  message: "Render the title card one more time at 1080p, 24fps — same grade.",
  context: {
    projectSummary: true,
    activeComp: true,
    selection: false,
    playhead: true,
    focusedPanel: true,
    selectedProperties: false,
    currentFrame: true,
    recentCommands: false,
    comments: false,
  },
  idempotencyKey: "idem-demo-chat-0001",
  pinned: [{ kind: "composition", id: "cmp_demo_launch_main", label: "Comp: Main" }],
} satisfies ChatRequest;

// The §7.2 lease wire response (see response-schemas.ts compat note): the
// demo editor HOLDS the lease on the demo project.
const DEMO_LEASE = {
  acquired: true,
  holderName: "Dana Flow",
  expiresAt: "2026-10-15T09:07:00Z",
  readOnly: false,
} as const satisfies LeaseAcquireResponse;

// ---------------------------------------------------------------------------
// The fixtures object
// ---------------------------------------------------------------------------

/**
 * Deterministic demo dataset. Ids are stable (`prj_demo_…`); timestamps are
 * fixed; the ledger balances to `credits.summary.balance` (3200).
 */
export const fixtures = {
  notice: FIXTURES_DEMO_NOTICE,
  ticksPerSecond: DEMO_TICKS_PER_SECOND,

  /** GET /v1/me */
  me: DEMO_ME,
  workspaces: [WORKSPACE_NORTHLIGHT, WORKSPACE_HALO] as readonly Workspace[],
  invite: DEMO_INVITE,
  acceptedInvite: DEMO_ACCEPTED_INVITE,

  projects: DEMO_PROJECTS,
  /** Per project id: the current version + asset manifest with signed URLs. */
  manifests: DEMO_MANIFESTS,
  /** Per project id: versions 1-4 (immutable, chained, some agent-annotated). */
  versions: Object.fromEntries(
    PROJECT_SEEDS.map((seed) => [seed.id, buildVersions(seed)]),
  ) as Readonly<Record<string, readonly ProjectVersion[]>>,

  assets: DEMO_ASSETS,
  createAssetResponses: DEMO_CREATE_ASSET_RESPONSES,

  threads: DEMO_THREADS,
  /** Per thread id: message history. */
  messages: DEMO_MESSAGES,

  plans: {
    headlineSpring: PLAN_HEADLINE_SPRING,
    subheadSofter: PLAN_SUBHEAD_SOFTER,
    logoSting: PLAN_LOGO_STING,
  } as Readonly<Record<string, EditPlan>>,

  runs: {
    /** The applied run: stream events (ends run.completed), its record, no client actions. */
    applied: {
      events: RUN_APPLIED_EVENTS,
      record: RUN_APPLIED_RECORD,
      clientActions: [] as readonly RunClientAction[],
    },
    /** The undone run: stream events, its record, then the §8.1 undo actions. */
    undone: {
      events: RUN_UNDONE_EVENTS,
      record: RUN_UNDONE_RECORD,
      clientActions: RUN_UNDONE_CLIENT_ACTIONS,
    },
  },

  credits: {
    summary: CREDITS_SUMMARY,
    ledger: DEMO_LEDGER,
  },

  comments: DEMO_COMMENTS,
  activity: DEMO_ACTIVITY,
  renders: DEMO_RENDERS,

  /** Mutation-response odds and ends for dev mode. */
  chatRequest: DEMO_CHAT_REQUEST,
  lease: DEMO_LEASE,
  checkout: {
    sessionId: "cs_test_demo_checkout",
    url: "https://checkout.studio.example.com/c/pay/demo",
  } as const,
} as const;

// ---------------------------------------------------------------------------
// Validation (contracts schemas; call once in dev mode)
// ---------------------------------------------------------------------------

function check<T>(label: string, schema: z.ZodType<T>, value: T, issues: string[]): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push(`${label}: ${issue.path.join(".")} — ${issue.message}`);
    }
  }
}

/**
 * Validates every fixture row against the api-client response schemas
 * (contracts-interface mirrors) and the contracts Zod schemas (EditPlan,
 * StudioStreamEvent, chat request). Returns the list of issues — empty means
 * the whole demo dataset is wire-valid.
 */
export function validateFixtures(): string[] {
  const issues: string[] = [];

  check("me", ME_RESPONSE_SCHEMA, fixtures.me, issues);
  for (const [i, row] of fixtures.workspaces.entries()) {
    check(`workspaces[${i}]`, WORKSPACE_SCHEMA, row, issues);
  }
  check("invite", INVITE_SCHEMA, fixtures.invite, issues);
  for (const [i, row] of fixtures.projects.entries()) {
    check(`projects[${i}]`, PROJECT_SCHEMA, row, issues);
  }
  for (const [id, manifest] of Object.entries(fixtures.manifests)) {
    check(`manifests[${id}]`, PROJECT_MANIFEST_SCHEMA, manifest, issues);
  }
  for (const [id, versions] of Object.entries(fixtures.versions)) {
    versions.forEach((row, i) => {
      check(`versions[${id}][${i}]`, PROJECT_VERSION_SCHEMA, row, issues);
    });
  }
  for (const [i, row] of fixtures.assets.entries()) {
    check(`assets[${i}]`, ASSET_SCHEMA, row, issues);
  }
  for (const [i, row] of fixtures.createAssetResponses.entries()) {
    check(`createAssetResponses[${i}]`, CREATE_ASSET_RESPONSE_SCHEMA, row, issues);
  }
  for (const [i, row] of fixtures.threads.entries()) {
    check(`threads[${i}]`, THREAD_SCHEMA, row, issues);
  }
  for (const [id, rows] of Object.entries(fixtures.messages)) {
    rows.forEach((row, i) => {
      check(`messages[${id}][${i}]`, THREAD_MESSAGE_SCHEMA, row, issues);
    });
  }
  for (const [key, plan] of Object.entries(fixtures.plans)) {
    check(`plans.${key}`, EDIT_PLAN_SCHEMA, plan, issues);
  }
  fixtures.runs.applied.events.forEach((event, i) => {
    check(`runs.applied.events[${i}]`, STUDIO_STREAM_EVENT_SCHEMA, event, issues);
  });
  fixtures.runs.undone.events.forEach((event, i) => {
    check(`runs.undone.events[${i}]`, STUDIO_STREAM_EVENT_SCHEMA, event, issues);
  });
  check("runs.applied.record", RUN_RECORD_SCHEMA, fixtures.runs.applied.record, issues);
  check("runs.undone.record", RUN_RECORD_SCHEMA, fixtures.runs.undone.record, issues);
  check("credits.summary", CREDITS_SUMMARY_SCHEMA, fixtures.credits.summary, issues);
  for (const [i, row] of fixtures.credits.ledger.entries()) {
    check(`credits.ledger[${i}]`, LEDGER_ENTRY_SCHEMA, row, issues);
  }
  for (const [i, row] of fixtures.comments.entries()) {
    check(`comments[${i}]`, COMMENT_SCHEMA, row, issues);
  }
  {
    const page = { items: [...fixtures.activity], nextCursor: null } satisfies Page<ActivityEntry>;
    check("activity.page", PAGE_ACTIVITY_SCHEMA, page, issues);
  }
  for (const [i, row] of fixtures.renders.entries()) {
    check(`renders[${i}]`, RENDER_JOB_SCHEMA, row, issues);
  }
  check("lease", LEASE_ACQUIRE_RESPONSE_SCHEMA, fixtures.lease, issues);
  check("checkout", CHECKOUT_RESPONSE_SCHEMA, fixtures.checkout, issues);
  {
    const parsed = CHAT_REQUEST_SCHEMA.safeParse(fixtures.chatRequest);
    if (!parsed.success) {
      issues.push(`chatRequest: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// W3-b additions — settings + billing surfaces (docs/UI_DESIGN_SYSTEM.md
// §8.8/§8.9, docs/PRODUCT_ARCHITECTURE.md §3.3/§10).
//
// APPEND-ONLY by the parallel-wave contract: nothing above this marker
// changes. These rows are plain demo data with no wire schemas yet — the
// member/api-key/usage/workspace-billing routes land with a later gateway
// wave; the shapes mirror §7.2 and the §10.1 plan table so the settings and
// billing pages can be built, tested and demoed today. Reuse note: the
// settings pages read `fixtures.credits.summary` (canon) for the balance
// card; only what it does not cover lives here.
// ---------------------------------------------------------------------------

/** Workspace role — wire-stable names (§3.3). */
export type FixtureRole = "owner" | "admin" | "editor" | "viewer";

/** API-key scope set offered in v1 (§7.1: scoped, hashed, revocable). */
export type FixtureScope = "read:projects" | "read:assets" | "write:projects";

export interface FixtureMember {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: FixtureRole;
  readonly status: "active" | "pending" | "inactive";
  /** ISO timestamp; null for pending invites that never signed in. */
  readonly lastActiveAt: string | null;
  readonly isCurrentUser: boolean;
}

export interface FixtureApiKey {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly FixtureScope[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  /** null = never expires. */
  readonly expiresAt: string | null;
}

export interface FixtureUsageByProject {
  readonly projectId: string;
  readonly name: string;
  /** Credits spent this cycle, by cost source (§10.2). */
  readonly model: number;
  readonly render: number;
  readonly storage: number;
}

export interface FixtureUsageCycle {
  readonly cycleStart: string;
  readonly cycleEnd: string;
  readonly model: number;
  readonly render: number;
  readonly storage: number;
  readonly byProject: readonly FixtureUsageByProject[];
}

export interface FixtureInvoice {
  readonly id: string;
  readonly number: string;
  readonly date: string;
  readonly description: string;
  readonly amountUsd: number;
  readonly status: "paid" | "open" | "void";
}

export interface FixtureSession {
  readonly id: string;
  readonly device: string;
  readonly location: string;
  readonly lastActiveAt: string;
  readonly current: boolean;
}

/** Plan rank used by the Models page to gate tiers (§10.1). */
export type FixturePlanId = "trial" | "starter" | "pro" | "studio";

export interface FixtureModelOption {
  readonly id: "studio-fast" | "studio-smart" | "studio-vision";
  readonly name: string;
  readonly tier: string;
  /** Human credit-rate label (§14: credits, never tokens). */
  readonly creditRate: string;
  readonly description: string;
  /** Lowest plan that unlocks this model (§10.1 model column). */
  readonly minPlan: FixturePlanId;
}

export interface FixturePlanCard {
  readonly id: Exclude<FixturePlanId, "trial">;
  readonly name: string;
  readonly priceUsd: number;
  readonly includedCredits: number;
  readonly seats: number;
  readonly models: string;
}

export interface FixtureCreditPack {
  readonly id: string;
  readonly credits: number;
  readonly priceUsd: number;
}

export interface FixtureAuditEntry {
  readonly id: string;
  readonly actorName: string;
  /** Stable dotted action, e.g. "member.invited" (§7.1: destructive + role/invite/api-key actions audited). */
  readonly action: string;
  readonly targetType: string;
  /** Human label for the target row (a name, not a raw id). */
  readonly target: string;
  readonly createdAt: string;
}

/**
 * Settings + billing demo dataset for the Northlight Motion workspace.
 * Usage rows reconcile with `fixtures.credits.summary`: included 2,500 +
 * purchased 800 − balance 3,200 = 100 credits spent this cycle (§8.8 Usage).
 */
export const SETTINGS_FIXTURES = {
  /** Demo workspace for every settings surface (owner membership in `fixtures.me`). */
  workspaceId: WORKSPACE_NORTHLIGHT.id,
  workspaceName: WORKSPACE_NORTHLIGHT.name,
  workspaceSlug: WORKSPACE_NORTHLIGHT.slug,

  members: [
    {
      id: "usr_demo_maya",
      name: "Maya Okafor",
      email: "maya@northlight.example",
      role: "owner",
      status: "active",
      lastActiveAt: "2026-10-21T09:41:00Z",
      isCurrentUser: true,
    },
    {
      id: "usr_demo_jonas",
      name: "Jonas Beck",
      email: "jonas@northlight.example",
      role: "admin",
      status: "active",
      lastActiveAt: "2026-10-21T07:12:00Z",
      isCurrentUser: false,
    },
    {
      id: "usr_demo_rive",
      name: "Rive Kowalski",
      email: "rive@northlight.example",
      role: "editor",
      status: "active",
      lastActiveAt: "2026-10-14T16:03:00Z",
      isCurrentUser: false,
    },
    {
      id: "usr_demo_priya",
      name: "Priya Raman",
      email: "priya@northlight.example",
      role: "editor",
      status: "pending",
      lastActiveAt: null,
      isCurrentUser: false,
    },
  ] as readonly FixtureMember[],

  apiKeys: [
    {
      id: "key_demo_ci",
      name: "CI render trigger",
      scopes: ["read:projects", "write:projects"],
      createdAt: "2026-09-12T10:02:00Z",
      lastUsedAt: "2026-10-20T22:40:00Z",
      expiresAt: "2026-12-11T10:02:00Z",
    },
    {
      id: "key_demo_metrics",
      name: "Usage metrics",
      scopes: ["read:projects", "read:assets"],
      createdAt: "2026-08-03T14:20:00Z",
      lastUsedAt: null,
      expiresAt: null,
    },
  ] as readonly FixtureApiKey[],

  /** The one-time secret a freshly created key reveals (obviously fake, sk_test_). */
  newApiKeySecret: "sk_test_demo_9f4c1a02e7b8d35c",

  usage: {
    cycleStart: "2026-10-01T00:00:00Z",
    cycleEnd: "2026-11-01T00:00:00Z",
    model: 80.4,
    render: 14,
    storage: 5.6,
    byProject: [
      {
        projectId: "prj_demo_launch_film",
        name: "Launch film",
        model: 55.8,
        render: 14,
        storage: 3.3,
      },
      {
        projectId: "prj_demo_title_seq",
        name: "Title sequence — Brand reel",
        model: 13.9,
        render: 0,
        storage: 1.4,
      },
      {
        projectId: "prj_demo_social_teaser",
        name: "Social teaser 9:16",
        model: 7.1,
        render: 0,
        storage: 0.5,
      },
      {
        projectId: "prj_demo_lower_thirds",
        name: "Lower thirds — Podcast",
        model: 3.6,
        render: 0,
        storage: 0.4,
      },
    ],
  } as FixtureUsageCycle,

  invoices: [
    {
      id: "in_demo_0102",
      number: "STU-0102",
      date: "2026-10-12",
      description: "Credit pack — 800 credits",
      amountUsd: 12,
      status: "paid",
    },
    {
      id: "in_demo_0089",
      number: "STU-0089",
      date: "2026-10-01",
      description: "Pro plan — monthly",
      amountUsd: 79,
      status: "paid",
    },
    {
      id: "in_demo_0041",
      number: "STU-0041",
      date: "2026-09-02",
      description: "Pro plan — first month",
      amountUsd: 79,
      status: "paid",
    },
  ] as readonly FixtureInvoice[],

  paymentMethod: {
    brand: "Visa",
    last4: "4242",
    expiryMonth: 4,
    expiryYear: 2028,
  },

  sessions: [
    {
      id: "sess_demo_current",
      device: "MacBook Pro — Chrome",
      location: "Lisbon, Portugal",
      lastActiveAt: "2026-10-21T09:30:00Z",
      current: true,
    },
    {
      id: "sess_demo_render_rig",
      device: "Windows PC — Edge",
      location: "Lisbon, Portugal",
      lastActiveAt: "2026-10-18T18:12:00Z",
      current: false,
    },
    {
      id: "sess_demo_ipad",
      device: "iPad — Safari",
      location: "Porto, Portugal",
      lastActiveAt: "2026-09-29T08:45:00Z",
      current: false,
    },
  ] as readonly FixtureSession[],

  models: [
    {
      id: "studio-fast",
      name: "Studio Fast",
      tier: "Fast",
      creditRate: "≈ 4 credits per request",
      description: "Drafts, iterations and routine edits at the lowest credit rate.",
      minPlan: "trial",
    },
    {
      id: "studio-smart",
      name: "Studio Smart",
      tier: "Frontier",
      creditRate: "≈ 12 credits per request",
      description: "Complex multi-step edits and hard animation problems.",
      minPlan: "pro",
    },
    {
      id: "studio-vision",
      name: "Studio Vision",
      tier: "Vision",
      creditRate: "≈ 18 credits per request",
      description: "Reads reference frames and footage to match a look.",
      minPlan: "studio",
    },
  ] as readonly FixtureModelOption[],

  /** §10.1 plan table — illustrative pricing, no free plan. */
  planCatalog: [
    {
      id: "starter",
      name: "Starter",
      priceUsd: 29,
      includedCredits: 1000,
      seats: 1,
      models: "Fast model",
    },
    {
      id: "pro",
      name: "Pro",
      priceUsd: 79,
      includedCredits: 3000,
      seats: 3,
      models: "Fast + smart models",
    },
    {
      id: "studio",
      name: "Studio",
      priceUsd: 199,
      includedCredits: 8000,
      seats: 10,
      models: "Fast + smart + vision models",
    },
  ] as readonly FixturePlanCard[],

  trialTerms: {
    days: 14,
    credits: 100,
    cardRequired: true,
    thenPlan: "Starter",
    thenPriceUsd: 29,
  },

  creditPacks: [
    { id: "pack-500", credits: 500, priceUsd: 8 },
    { id: "pack-2000", credits: 2000, priceUsd: 30 },
    { id: "pack-10000", credits: 10000, priceUsd: 120 },
  ] as readonly FixtureCreditPack[],

  audit: [
    {
      id: "aud_demo_01",
      actorName: "Maya Okafor",
      action: "workspace.updated",
      targetType: "workspace",
      target: "Default project visibility",
      createdAt: "2026-10-05T11:12:00Z",
    },
    {
      id: "aud_demo_02",
      actorName: "Maya Okafor",
      action: "member.invited",
      targetType: "member",
      target: "Priya Raman",
      createdAt: "2026-10-19T10:02:00Z",
    },
    {
      id: "aud_demo_03",
      actorName: "Maya Okafor",
      action: "run.applied",
      targetType: "run",
      target: "Headline spring pop-in",
      createdAt: "2026-10-09T18:05:44Z",
    },
    {
      id: "aud_demo_04",
      actorName: "Maya Okafor",
      action: "render.completed",
      targetType: "render",
      target: "Launch film — mp4",
      createdAt: "2026-10-10T09:18:00Z",
    },
    {
      id: "aud_demo_05",
      actorName: "Jonas Beck",
      action: "comment.created",
      targetType: "comment",
      target: "Launch film",
      createdAt: "2026-10-08T15:41:00Z",
    },
    {
      id: "aud_demo_06",
      actorName: "Maya Okafor",
      action: "member.role_changed",
      targetType: "member",
      target: "Rive Kowalski → editor",
      createdAt: "2026-09-10T15:31:00Z",
    },
    {
      id: "aud_demo_07",
      actorName: "Maya Okafor",
      action: "apikey.created",
      targetType: "api-key",
      target: "CI render trigger",
      createdAt: "2026-09-12T10:02:00Z",
    },
    {
      id: "aud_demo_08",
      actorName: "Maya Okafor",
      action: "apikey.used",
      targetType: "api-key",
      target: "CI render trigger",
      createdAt: "2026-10-20T22:40:00Z",
    },
    {
      id: "aud_demo_09",
      actorName: "Maya Okafor",
      action: "asset.uploaded",
      targetType: "asset",
      target: "broll-city-dusk.mp4",
      createdAt: "2026-09-28T16:34:00Z",
    },
    {
      id: "aud_demo_10",
      actorName: "Maya Okafor",
      action: "project.created",
      targetType: "project",
      target: "Launch film",
      createdAt: "2026-09-22T09:30:00Z",
    },
  ] as readonly FixtureAuditEntry[],

  workspacePreferences: {
    /** Default sharing state for new projects (§8.9 General). */
    defaultVisibility: "workspace",
    defaultModel: "studio-fast",
    autoApply: false,
    creditAlertThreshold: 500,
  },

  /** Slugs the demo treats as taken for the live availability check (§8.3). */
  takenSlugs: ["northlight-motion", "halo-pictures", "studio"] as readonly string[],

  billing: {
    plan: "pro",
    seatsUsed: 3,
    seatsIncluded: 3,
    renewalDate: "2026-11-01T00:00:00Z",
    pastDue: false,
    /** §8.8 trial banner data — null when the workspace is on a paid plan. */
    trial: null as null | { readonly daysLeft: number; readonly endsAt: string },
  },
} as const;

// ---------------------------------------------------------------------------
// W1-a additions — member-management surfaces (gateway routes/members.ts).
// APPEND-ONLY per the parallel-wave contract (see the W3-b marker above).
// The rows mirror @studio/contracts routes/members.ts — Page<Member>,
// MemberRemoved, OwnershipTransferred, SwitchedWorkspace — so the M9
// workspace switcher and the settings members table can be built/demoed
// before wiring to the live routes. The roster reuses the Northlight demo
// identities; `isCurrentUser` is relative to the demo user (Maya). Invited
// users are NOT members on this surface (they live on the invites surface).
// ---------------------------------------------------------------------------

/** Northlight's demo roster as GET /v1/workspaces/:id/members returns it. */
const DEMO_MEMBERS: readonly Member[] = [
  {
    id: "usr_demo_maya",
    name: "Maya Okafor",
    email: "maya@northlight.example",
    role: "owner",
    status: "active",
    lastActiveAt: "2026-10-21T09:41:00Z",
    isCurrentUser: true,
  },
  {
    id: "usr_demo_jonas",
    name: "Jonas Beck",
    email: "jonas@northlight.example",
    role: "admin",
    status: "active",
    lastActiveAt: "2026-10-21T07:12:00Z",
    isCurrentUser: false,
  },
  {
    id: "usr_demo_rive",
    name: "Rive Kowalski",
    email: "rive@northlight.example",
    role: "editor",
    status: "active",
    lastActiveAt: "2026-10-14T16:03:00Z",
    isCurrentUser: false,
  },
];

const DEMO_MEMBERS_PAGE: Page<Member> = {
  items: DEMO_MEMBERS,
  nextCursor: null,
};

const DEMO_MEMBER_REMOVED: MemberRemoved = {
  id: "usr_demo_jonas",
  removed: true,
};

/** Maya hands Northlight Motion to Jonas; she stays on as admin. */
const DEMO_OWNERSHIP_TRANSFERRED: OwnershipTransferred = {
  workspaceId: "wsp_demo_northlight",
  ownerId: "usr_demo_jonas",
  previousOwnerId: "usr_demo_maya",
};

/** The demo user switches her active workspace to Halo Pictures. */
const DEMO_SWITCHED_WORKSPACE: SwitchedWorkspace = {
  workspaceId: "wsp_demo_halo",
  name: WORKSPACE_HALO.name,
  slug: WORKSPACE_HALO.slug,
};

/** W1-a demo rows for the member-management client surface. */
export const MEMBERS_FIXTURES = {
  membersPage: DEMO_MEMBERS_PAGE,
  removed: DEMO_MEMBER_REMOVED,
  ownershipTransferred: DEMO_OWNERSHIP_TRANSFERRED,
  switchedWorkspace: DEMO_SWITCHED_WORKSPACE,
} as const;

/**
 * Validates the W1-a member fixtures against the api-client response schemas
 * (the contracts-interface mirrors) — same contract as validateFixtures(),
 * scoped to this block. Returns the issue list; empty means wire-valid.
 */
export function validateMembersFixtures(): string[] {
  const issues: string[] = [];
  check("membersPage", PAGE_MEMBERS_SCHEMA, MEMBERS_FIXTURES.membersPage, issues);
  check("members.removed", MEMBER_REMOVED_SCHEMA, MEMBERS_FIXTURES.removed, issues);
  check(
    "members.ownershipTransferred",
    OWNERSHIP_TRANSFERRED_SCHEMA,
    MEMBERS_FIXTURES.ownershipTransferred,
    issues,
  );
  check(
    "members.switchedWorkspace",
    SWITCHED_WORKSPACE_SCHEMA,
    MEMBERS_FIXTURES.switchedWorkspace,
    issues,
  );
  void MEMBER_SCHEMA; // item-level schema exercised via PAGE_MEMBERS_SCHEMA
  return issues;
}

// ---------------------------------------------------------------------------
// W1-b additions — workspace API keys (§7.1 "scoped, hashed, revocable";
// BUILD_PLAN §M1 tasks 1+2). APPEND-ONLY below the W3-b marker: the wire
// shapes live in @studio/contracts routes/api-keys.ts and the api-client
// response validators (API_KEY_SCHEMA / CREATED_API_KEY_SCHEMA /
// REVOKED_API_KEY_SCHEMA); these rows are plain demo data typed locally (same
// W3-b precedent) so this file gains no new imports. The created row carries
// the SHOW-ONCE demo secret — `sk_test_`-shaped and obviously fake.
// ---------------------------------------------------------------------------

/** §7.1 v1 wire scope vocabulary (mirror of contracts API_KEY_SCOPES). */
export type FixtureApiKeyScope =
  | "projects:read"
  | "projects:write"
  | "renders:queue"
  | "chat:run"
  | "billing:read"
  | "*";

/** A workspace API key as GET /v1/workspaces/:id/api-keys lists it — never key material. */
export interface FixtureApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly FixtureApiKeyScope[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly enabled: boolean;
}

/** The POST /v1/workspaces/:id/api-keys response — plaintext key exactly once. */
export interface FixtureApiKeyCreatedRow extends FixtureApiKeyRow {
  readonly startsAt: string;
  readonly key: string;
}

export const API_KEYS_FIXTURES = {
  /** Workspace-key list rows for the Northlight Motion settings surface. */
  rows: [
    {
      id: "key_demo_ci_v1",
      name: "CI render trigger",
      scopes: ["projects:read", "renders:queue"],
      createdAt: "2026-09-12T10:02:00Z",
      expiresAt: "2026-12-11T10:02:00Z",
      lastUsedAt: "2026-10-20T22:40:00Z",
      enabled: true,
    },
    {
      id: "key_demo_metrics_v1",
      name: "Usage metrics pull",
      scopes: ["billing:read", "projects:read"],
      createdAt: "2026-08-03T14:20:00Z",
      expiresAt: null,
      lastUsedAt: null,
      enabled: true,
    },
    {
      id: "key_demo_old_pipeline",
      name: "Retired pipeline key",
      scopes: ["*"],
      createdAt: "2026-06-01T08:00:00Z",
      expiresAt: "2026-07-01T08:00:00Z",
      lastUsedAt: "2026-06-30T19:12:00Z",
      enabled: false,
    },
  ] as readonly FixtureApiKeyRow[],

  /** A freshly minted key — the ONLY surface where the secret appears. */
  created: {
    id: "key_demo_new_1",
    name: "Deploy script",
    scopes: ["projects:read", "renders:queue"],
    createdAt: "2026-10-22T09:15:00Z",
    startsAt: "2026-10-22T09:15:00Z",
    expiresAt: "2027-01-20T09:15:00Z",
    lastUsedAt: null,
    enabled: true,
    key: "sk_test_demo_4f8e2b6c1d9a7e35f0a2c8d4b6e1f3a5",
  } as FixtureApiKeyCreatedRow,
} as const;
