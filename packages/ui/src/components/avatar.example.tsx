/**
 * Avatar — §8.1 example gallery (documentation-as-code).
 *
 * Initials only, never photos (§8.1); sizes sm/md/lg; the name doubles as the
 * accessible label. Typecheck-only docs — never run by vitest.
 */
import { Avatar } from "./avatar";

const labelClass = "text-label uppercase tracking-[0.06em] text-muted";

export default function AvatarExample() {
  return (
    <section
      aria-label="Avatar examples"
      className="flex flex-col gap-8 rounded-md border border-border bg-panel p-6"
    >
      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Sizes — sm 24 / md 32 / lg 40</h3>
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name="Ada Lovelace" size="sm" />
          <Avatar name="Grace Hopper" size="md" />
          <Avatar name="Alan Turing" size="lg" />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Initial derivation</h3>
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name="Ada Lovelace" size="md" />
          <Avatar name="Cher" size="md" />
          <Avatar name="Grace Brewster Hopper" size="md" />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className={labelClass}>Row — workspace members</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Avatar name="Ada Lovelace" size="sm" />
          <Avatar name="Grace Hopper" size="sm" />
          <Avatar name="Alan Turing" size="sm" />
        </div>
      </div>
    </section>
  );
}
