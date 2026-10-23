/**
 * Skeleton — §7.13 example gallery (documentation-as-code).
 *
 * Use only for content that is actually loading; preserve final layout
 * dimensions to avoid shift; reduced motion makes the shimmer static
 * (global override in theme.css). Typecheck-only docs — never run by vitest.
 */
import { Skeleton } from "./skeleton";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function SkeletonExample() {
  return (
    <section
      aria-label="Skeleton examples"
      className="flex max-w-2xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Loading card layout — dimensions match the real card</h3>
        <div className="flex max-w-md flex-col gap-3 rounded-md border border-border bg-panel p-4">
          {/* 16/9 thumbnail placeholder (§7.13: no skeleton for the whole app) */}
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Text lines — preserve the final line count</h3>
        <div className="flex max-w-md flex-col gap-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Row pieces — avatar + title + metadata</h3>
        <div className="flex max-w-md items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-pill" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      </div>
    </section>
  );
}
