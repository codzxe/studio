import { Brand } from "@studio/config";
import { Button, EmptyState } from "@studio/ui";

/**
 * §8.11 states as reusable components (the app shell pages compose them in
 * Wave 3; the boundary cases exist now so no route has to invent its own).
 * Status is never colour-only and copy follows §14: what happened, why,
 * what to do.
 */

/** Offline: honest about what is and isn't at risk, with a retry. */
export function OfflineState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div data-testid="offline-state">
      <EmptyState
        title="You're offline. Your last saved version is safe."
        action={
          onRetry ? (
            <Button variant="primary" size="md" onClick={onRetry}>
              Retry
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

/** Viewer/insufficient role in a workspace. */
export function PermissionState({ workspaceName }: { workspaceName?: string }) {
  return (
    <div data-testid="permission-state">
      <EmptyState
        title="You're a viewer in this workspace."
        secondaryLink={{
          label: "Request access",
          href: `mailto:${Brand.contact.support}?subject=${encodeURIComponent(
            `Access request — ${workspaceName ?? "workspace"}`,
          )}`,
        }}
      />
    </div>
  );
}

/** No WebGPU/WebGL2 (§8.11): explain, link to browsers, offer the preview. */
export function UnsupportedGpuState() {
  return (
    <div data-testid="unsupported-gpu-state">
      <EmptyState
        title="This browser can't run the editor."
        secondaryLink={{
          label: "Supported browsers",
          href: "https://caniuse.com/webgpu",
        }}
      />
      <p className="mx-auto mt-4 max-w-[68ch] text-center text-caption text-muted">
        The editor needs WebGPU or WebGL2. You can still open project pages and watch rendered
        previews — the compositor is the only thing that needs the GPU.
      </p>
    </div>
  );
}
