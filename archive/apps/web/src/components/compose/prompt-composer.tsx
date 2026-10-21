"use client";

// apps/web — the prompt composer orchestrator (W8-D).
//
// One screen, the full §3.3 request lifecycle up to "run queued":
//   1. target document — an existing document, or a NEW document created
//      from a catalog template (§13.1 POST /v1/documents, then the run
//      carries the template pin);
//   2. the brief (≤8000 chars, §13.1 POST /v1/runs `prompt`);
//   3. asset attachments via the injected W8-I library hook (≤16);
//   4. the tier, with the §5.2/§14.1 credit cost shown BEFORE the run
//      (§16.2 truthfulness) and the live workspace balance beside it;
//   5. §3.4 "keep partial work" choice;
//   6. POST /v1/runs → route to the run timeline (W8-E, /runs/:id).
//
// Server state flows through React Query (src/app/providers.tsx); the wire
// contract, cost table and error mapping live in ./run-contract.ts; the POST
// itself in ./use-run-create.ts. This component owns interaction state only.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AssetChips, useAssets } from "./asset-chips";
import { BriefInput } from "./brief-input";
import { RunButton } from "./run-button";
import {
  CREDITS_QUERY_KEY,
  type ComposableTier,
  type CreateDocumentResponse,
  DOCUMENTS_QUERY_KEY,
  DOCUMENT_NAME_MAX_CHARS,
  MAX_ASSET_ATTACHMENTS,
  type RunCreateError,
  TEMPLATES_QUERY_KEY,
  type TemplateCard,
  createDocumentResponseSchema,
  creditsForTier,
  creditsResponseSchema,
  documentsResponseSchema,
  mapRunCreateError,
  runTimelineHref,
  templatesResponseSchema,
  validateBrief,
} from "./run-contract";
import { TemplatePicker } from "./template-picker";
import { TierSelector } from "./tier-selector";
import { getGatewayClient, useRunCreate } from "./use-run-create";

/** Document-target mode: run inside an existing document, or mint one. */
type TargetMode = "existing" | "new";

interface NewDocumentInput {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Immutable `id@version` pin (§7.2) — never a bare id. */
  readonly templateRef: string;
}

export function PromptComposer() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const runCreate = useRunCreate();
  const assets = useAssets();

  // --- interaction state ---------------------------------------------------
  const [mode, setMode] = useState<TargetMode>("new");
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [documentName, setDocumentName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [selectedTemplateRef, setSelectedTemplateRef] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [tier, setTier] = useState<ComposableTier>("standard");
  const [keepPartialWork, setKeepPartialWork] = useState(false);
  const [selectedAssetIds, setSelectedAssetIds] = useState<readonly string[]>([]);
  /** Failures from the document-creation step (createRun never throws). */
  const [submitError, setSubmitError] = useState<RunCreateError | null>(null);

  // --- server state (React Query; runs client-side only) --------------------
  const templatesQuery = useQuery({
    queryKey: TEMPLATES_QUERY_KEY,
    queryFn: () => getGatewayClient().get("/templates", { schema: templatesResponseSchema }),
  });
  const documentsQuery = useQuery({
    queryKey: DOCUMENTS_QUERY_KEY,
    queryFn: () => getGatewayClient().get("/documents", { schema: documentsResponseSchema }),
  });
  const creditsQuery = useQuery({
    queryKey: CREDITS_QUERY_KEY,
    queryFn: () => getGatewayClient().get("/credits?limit=1", { schema: creditsResponseSchema }),
  });

  const createDocument = useMutation<CreateDocumentResponse, unknown, NewDocumentInput>({
    mutationFn: (input: NewDocumentInput) =>
      // §13: the client stamps the auto Idempotency-Key on every POST.
      getGatewayClient().post("/documents", {
        body: {
          name: input.name,
          width: input.width,
          height: input.height,
          templateId: input.templateRef,
        },
        schema: createDocumentResponseSchema,
      }),
  });

  // --- derived --------------------------------------------------------------
  const templates = templatesQuery.data?.templates ?? [];
  const documents = documentsQuery.data?.documents ?? [];
  const selectedTemplate: TemplateCard | undefined = useMemo(
    () => templates.find((card) => card.ref === selectedTemplateRef),
    [templates, selectedTemplateRef],
  );
  const selectedDocument = documents.find((doc) => doc.id === documentId);
  const briefValidation = useMemo(() => validateBrief(prompt), [prompt]);
  const nameOk = documentName.trim().length > 0 && documentName.length <= DOCUMENT_NAME_MAX_CHARS;
  const pending = createDocument.isPending || runCreate.pending;
  const creditCost = creditsForTier(tier);
  const balance = creditsQuery.data?.balance;

  const canSubmit =
    briefValidation.ok &&
    !pending &&
    (mode === "existing" ? documentId !== null : selectedTemplate !== undefined && nameOk);

  // Any edit invalidates the last failure message (fresh intent, fresh try).
  function clearFeedback(): void {
    if (submitError !== null) {
      setSubmitError(null);
    }
    if (runCreate.error !== null) {
      runCreate.dismissError();
    }
  }

  function onSelectTemplate(card: TemplateCard): void {
    clearFeedback();
    setSelectedTemplateRef(card.ref);
    if (!nameEdited) {
      // Sensible default name; the user can still edit it (nameEdited flips).
      setDocumentName(card.name);
    }
  }

  function toggleAsset(assetId: string): void {
    clearFeedback();
    setSelectedAssetIds((current) => {
      if (current.includes(assetId)) {
        return current.filter((id) => id !== assetId);
      }
      if (current.length >= MAX_ASSET_ATTACHMENTS) {
        return current; // gateway cap (assetIds ≤ 16) is enforced here
      }
      return [...current, assetId];
    });
  }

  // --- submit (§3.3 step 1–2): target document, then POST /v1/runs ----------
  async function onSubmit(): Promise<void> {
    if (!canSubmit) {
      return;
    }
    clearFeedback();

    // Narrow the inputs for this attempt (state may shift mid-flight below).
    const brief = prompt;
    const chosenTier = tier;
    const assetIds = [...selectedAssetIds];
    const startingInNewDoc = mode === "new";
    const template = selectedTemplate;

    let targetDocumentId: string | null = documentId;
    let templateId: string | undefined;
    if (startingInNewDoc) {
      if (template === undefined || !nameOk) {
        return;
      }
      try {
        const created = await createDocument.mutateAsync({
          name: documentName.trim(),
          width: template.canvas.width,
          height: template.canvas.height,
          templateRef: template.ref,
        });
        targetDocumentId = created.document.id;
        templateId = template.ref;
        // Pin the fresh document as the target: a retry (e.g. after a 402
        // top-up) reuses it instead of creating a duplicate (§3.4).
        setMode("existing");
        setDocumentId(created.document.id);
        setDocumentName(created.document.name);
        void queryClient.invalidateQueries({ queryKey: DOCUMENTS_QUERY_KEY });
      } catch (thrown: unknown) {
        setSubmitError(mapRunCreateError(thrown));
        return;
      }
    }

    if (targetDocumentId === null) {
      return;
    }

    const outcome = await runCreate.createRun({
      documentId: targetDocumentId,
      prompt: brief,
      tier: chosenTier,
      ...(templateId !== undefined ? { templateId } : {}),
      ...(assetIds.length > 0 ? { assetIds } : {}),
    });
    if (outcome.ok) {
      // TODO(sync, §3.4): keepPartialWork is captured above but CANNOT ride
      // CREATE_RUN_BODY_SCHEMA yet — it is strict (W4-G) and has no such
      // field, so sending it would 422. The contract wave must add it; until
      // then the toggle is a recorded client-side choice only.
      void keepPartialWork;
      // → the run timeline (W8-E): plan, steps, previews, credits events.
      router.push(runTimelineHref(outcome.run.run_id));
    }
    // Failure: the typed error renders via RunButton (402 → credits CTA,
    // 429 → retry-after); the idempotency key is kept for the retry (§3.4).
  }

  // --- render ---------------------------------------------------------------
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">New run</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe the outcome. The agent composes editable layers in the target document — every
          step lands on the run timeline.
        </p>
      </header>

      <div className="space-y-8 rounded-lg border border-border bg-surface p-6">
        {/* 1 — target document (existing, or new from a catalog template) */}
        <fieldset disabled={pending} className="space-y-3">
          <legend className="text-sm font-medium">Target document</legend>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="target-mode"
                value="existing"
                checked={mode === "existing"}
                onChange={() => {
                  clearFeedback();
                  setMode("existing");
                }}
                className="size-4"
              />
              Existing document
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="target-mode"
                value="new"
                checked={mode === "new"}
                onChange={() => {
                  clearFeedback();
                  setMode("new");
                }}
                className="size-4"
              />
              New document from a template
            </label>
          </div>

          {mode === "existing" ? (
            <div className="space-y-1.5">
              {documentsQuery.isPending ? (
                <p className="text-xs text-muted-foreground">Loading documents…</p>
              ) : documentsQuery.isError ? (
                <p className="text-xs text-muted-foreground">
                  Could not load your documents.
                  <button
                    type="button"
                    onClick={() => {
                      void documentsQuery.refetch();
                    }}
                    className="ml-2 font-medium text-foreground underline underline-offset-2"
                  >
                    Retry
                  </button>
                </p>
              ) : documents.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No documents in this workspace yet — create one from a template instead.
                </p>
              ) : (
                <>
                  <select
                    value={documentId ?? ""}
                    onChange={(event) => {
                      clearFeedback();
                      setDocumentId(event.target.value === "" ? null : event.target.value);
                    }}
                    aria-label="Target document"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="" disabled>
                      Select a document…
                    </option>
                    {documents.map((doc) => (
                      <option key={doc.id} value={doc.id}>
                        {doc.name}
                      </option>
                    ))}
                  </select>
                  {selectedDocument === undefined ? null : (
                    <p className="font-mono text-xs text-muted-foreground">
                      {selectedDocument.width_px}×{selectedDocument.height_px} px · revision{" "}
                      {selectedDocument.current_revision}
                      {selectedDocument.template_id === null
                        ? ""
                        : ` · ${selectedDocument.template_id}`}
                    </p>
                  )}
                  {documentsQuery.data?.next_cursor !== undefined &&
                  documentsQuery.data?.next_cursor !== null ? (
                    <p className="text-xs text-muted-foreground">
                      Showing the most recent documents.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <TemplatePicker
                templates={templates}
                status={
                  templatesQuery.isPending ? "loading" : templatesQuery.isError ? "error" : "ready"
                }
                errorMessage={
                  templatesQuery.error === null
                    ? undefined
                    : mapRunCreateError(templatesQuery.error).message
                }
                selectedRef={selectedTemplateRef}
                onSelect={onSelectTemplate}
                onReload={() => {
                  void templatesQuery.refetch();
                }}
                disabled={pending}
              />
              {selectedTemplate === undefined ? null : (
                <div className="space-y-1.5">
                  <label htmlFor="new-document-name" className="block text-sm font-medium">
                    Document name
                  </label>
                  <input
                    id="new-document-name"
                    type="text"
                    value={documentName}
                    maxLength={DOCUMENT_NAME_MAX_CHARS}
                    onChange={(event) => {
                      clearFeedback();
                      setNameEdited(true);
                      setDocumentName(event.target.value);
                    }}
                    required
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <p className="font-mono text-xs text-muted-foreground">
                    {selectedTemplate.canvas.width}×{selectedTemplate.canvas.height} px — canvas set
                    by the template
                  </p>
                </div>
              )}
            </div>
          )}
        </fieldset>

        {/* 2 — the brief (≤8000 chars, §13.1) */}
        <BriefInput
          value={prompt}
          onChange={(value) => {
            clearFeedback();
            setPrompt(value);
          }}
          disabled={pending}
          validation={briefValidation}
        />

        {/* 3 — asset attachments (W8-I injected library) */}
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Attach assets</p>
          <p className="text-xs text-muted-foreground">
            Optional — uploaded files the agent can place into the document.
          </p>
          <AssetChips
            assets={assets.assets}
            status={assets.status}
            errorMessage={assets.errorMessage}
            selectedIds={selectedAssetIds}
            onToggle={toggleAsset}
            onReload={() => {
              assets.reload();
            }}
          />
        </div>

        {/* 4 — tier + pre-run cost display (§5.2/§16.2) */}
        <div className="space-y-2">
          <TierSelector
            value={tier}
            onChange={(next) => {
              clearFeedback();
              setTier(next);
            }}
            balance={balance}
            disabled={pending}
          />
          {balance === undefined ? (
            creditsQuery.isError ? (
              <p className="text-xs text-muted-foreground">
                Credit balance unavailable — the run is still checked server-side.
              </p>
            ) : null
          ) : (
            <p className="text-xs text-muted-foreground">
              Credits available: {balance.toLocaleString("en-US")}. {creditCost} will be reserved
              when the run starts.
            </p>
          )}
        </div>

        {/* 5 — §3.4 failure semantics choice */}
        <label className="flex items-start gap-2 rounded-md border border-border bg-background p-3">
          <input
            type="checkbox"
            checked={keepPartialWork}
            onChange={(event) => {
              clearFeedback();
              setKeepPartialWork(event.target.checked);
            }}
            className="mt-0.5 size-4"
          />
          <span>
            <span className="block text-sm font-medium">Keep partial work if the run fails</span>
            <span className="block text-xs leading-relaxed text-muted-foreground">
              Off by default: a failed run rolls the document back to its last saved state. Keep
              this on to save the layers that did land instead — you are charged at most half the
              run&apos;s credits when work was kept.
            </span>
          </span>
        </label>

        {/* 6 — commitment: the cost is on the button (§16.2) */}
        <RunButton
          tier={tier}
          credits={creditCost}
          pending={pending}
          disabled={!canSubmit}
          error={submitError ?? runCreate.error}
          onSubmit={() => {
            void onSubmit();
          }}
          onDismissError={clearFeedback}
        />
      </div>
    </main>
  );
}
