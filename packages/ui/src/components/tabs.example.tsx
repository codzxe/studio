/**
 * Tabs — §7.4 example gallery (documentation-as-code).
 *
 * Underline tabs for page sections, pill tabs for filters, arrow-key +
 * Home/End navigation from Radix. Typecheck-only docs — never run by vitest.
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function TabsExample() {
  return (
    <section
      aria-label="Tabs examples"
      className="flex max-w-2xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Underline — page sections (§7.4)</h3>
        <Tabs defaultValue="overview">
          <TabsList variant="underline">
            <TabsTrigger value="overview" variant="underline">
              Overview
            </TabsTrigger>
            <TabsTrigger value="versions" variant="underline">
              Versions
            </TabsTrigger>
            <TabsTrigger value="renders" variant="underline">
              Renders
            </TabsTrigger>
            <TabsTrigger value="activity" variant="underline" disabled>
              Activity
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-4 text-body-s text-secondary">
            Preview, description and open/edit actions.
          </TabsContent>
          <TabsContent value="versions" className="pt-4 text-body-s text-secondary">
            Every save is one version, restorable with confirmation.
          </TabsContent>
          <TabsContent value="renders" className="pt-4 text-body-s text-secondary">
            Render history with format, duration and retention.
          </TabsContent>
        </Tabs>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Pill — filters (§7.4)</h3>
        <Tabs defaultValue="all">
          <TabsList variant="pill">
            <TabsTrigger value="all" variant="pill">
              All
            </TabsTrigger>
            <TabsTrigger value="mine" variant="pill">
              Mine
            </TabsTrigger>
            <TabsTrigger value="shared" variant="pill">
              Shared
            </TabsTrigger>
            <TabsTrigger value="archived" variant="pill">
              Archived
            </TabsTrigger>
          </TabsList>
          <TabsContent value="all" className="pt-4 text-body-s text-secondary">
            All projects in this workspace.
          </TabsContent>
          <TabsContent value="mine" className="pt-4 text-body-s text-secondary">
            Projects you created.
          </TabsContent>
          <TabsContent value="shared" className="pt-4 text-body-s text-secondary">
            Projects shared with you.
          </TabsContent>
          <TabsContent value="archived" className="pt-4 text-body-s text-secondary">
            Archived projects stay restorable.
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}
