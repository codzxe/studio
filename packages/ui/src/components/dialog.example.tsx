/**
 * Dialog / ConfirmDialog — §7.5 example gallery (documentation-as-code).
 *
 * Radix Dialog with focus trap + mobile bottom sheet, the destructive
 * type-to-confirm gate, and the busy state. Typecheck-only docs — never run
 * by vitest.
 */
import { useState } from "react";
import { Button } from "./button";
import {
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
import { Input } from "./input";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function DialogExample() {
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <section
      aria-label="Dialog examples"
      className="flex max-w-xl flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Dialog — trigger + controlled, actions right-aligned</h3>
        <Dialog open={shareOpen} onOpenChange={setShareOpen}>
          <DialogTrigger asChild>
            <Button variant="secondary">Share project</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>Share project</DialogTitle>
            <DialogDescription>
              Anyone with the link can view this version. Revoke any time.
            </DialogDescription>
            <div className="mt-4">
              <Input id="ex-share-link" label="Share link" helperText="Expires with the version." />
            </div>
            <DialogActions>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button>Copy link</Button>
            </DialogActions>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Large dialog — 720px max width (§7.5)</h3>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary">Import .ecproj</Button>
          </DialogTrigger>
          <DialogContent size="large">
            <DialogTitle>Import a project</DialogTitle>
            <DialogDescription>
              Drop an .ecproj file or pick one from your machine.
            </DialogDescription>
            <DialogActions>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button>Choose file</Button>
            </DialogActions>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>ConfirmDialog — type the action name (§7.5)</h3>
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete project"
          description="This deletes 3 compositions. There is no undo."
          confirmLabel="Delete project"
          confirmText="Delete project"
          busy={busy}
          onConfirm={() => setBusy(true)}
        />
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          Delete project
        </Button>
      </div>
    </section>
  );
}
