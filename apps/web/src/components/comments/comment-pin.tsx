"use client";

// apps/web/src/components/comments — canvas pin overlay for review comments
// (W8-H). Spec anchors: §12.1 comments (x/y canvas px, resolved_at), §19
// Phase 3 "comments with positions", §16.2 web app (editor iframe/canvas).
//
// MOUNT CONTRACT (W8-F — full wiring note in this folder's README): render
// <CommentPinOverlay> INSIDE the canvas viewport wrapper, `absolute inset-0`
// over the displayed canvas — the overlay must be the same box as the
// rendered canvas (any zoom/size), because pins are positioned as
// PERCENTAGES of that box (zoom-stable), while the DB stores canvas px.
//
// POINTER-EVENTS MATH (implemented in comment-utils.ts, documented here per
// the W8-H task; identical derivation in both places):
//
//   rect  = overlay.getBoundingClientRect()            (CSS px, displayed box)
//   f     = (pointer.clientX − rect.left) / rect.width  → clamp to [0, 1]
//   f.y   = (pointer.clientY − rect.top)  / rect.height  → clamp to [0, 1]
//   px    = round(f × canvasSize)                        (canvas px = wire shape)
//   style = left/top = f × 100 %                          (pin render position)
//
//   The clamp to [0,1] is what keeps a pin on-canvas when the pointer leaves
//   the surface mid-drag (pointer capture keeps tracking; the ghost pins to
//   the edge). Canvas px are recomputed from the fraction at commit time, so
//   a click (down+up, no move) and a drag (down → move… → up) share ONE
//   commit path: the final fraction wins.

import { Check, MessageSquare, MessageSquarePlus } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import {
  canvasPointFromFraction,
  fractionFromCanvasPoint,
  fractionFromPointer,
  percentStyle,
  type CanvasComment,
  type CanvasPoint,
  type CanvasSize,
  type PinFraction,
} from "./comment-utils";

// ---------------------------------------------------------------------------
// CommentPin — one positioned pin
// ---------------------------------------------------------------------------

/** Accessible label: author, resolve state, and a body snippet. */
function pinLabel(comment: CanvasComment): string {
  const author = comment.authorName ?? "Member";
  const state = comment.resolvedAt !== null ? ", resolved" : "";
  const snippet =
    comment.body.length > 64 ? `${comment.body.slice(0, 64)}…` : comment.body;
  return `Comment by ${author}${state}: ${snippet}`;
}

export interface CommentPinProps {
  readonly comment: CanvasComment;
  /** Document canvas size (px) — converts the comment's x/y to percentages. */
  readonly canvasSize: CanvasSize;
  /** Highlight when the thread list selects this comment. */
  readonly active?: boolean;
  /** Fired on click (inert while the overlay is in placement mode). */
  readonly onSelect?: (commentId: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * One comment pin. The fraction → percent style is the ONLY positioning
 * input, and `-translate-x/y-1/2` centers the marker on the point itself.
 */
export function CommentPin({
  comment,
  canvasSize,
  active = false,
  onSelect,
  disabled = false,
  className = "",
}: CommentPinProps) {
  const style = percentStyle(
    fractionFromCanvasPoint({ x: comment.x, y: comment.y }, canvasSize),
  );
  const resolved = comment.resolvedAt !== null;
  return (
    <button
      type="button"
      onClick={() => onSelect?.(comment.id)}
      aria-label={pinLabel(comment)}
      aria-current={active ? "true" : undefined}
      disabled={disabled}
      style={style}
      className={`pointer-events-auto disabled:pointer-events-none absolute z-20 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring ${
        resolved
          ? "border-border bg-surface text-muted-foreground"
          : "border-transparent bg-accent text-accent-foreground"
      } ${active ? "ring-2 ring-ring" : "hover:scale-110"} ${className}`}
    >
      {resolved ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CommentPinOverlay — all pins + the drag placeholder + click-to-place
// ---------------------------------------------------------------------------

export interface CommentPinOverlayProps {
  /** The document's comments (same React Query list the panel renders). */
  readonly comments: readonly CanvasComment[];
  /** Document canvas size (documents.width_px/height_px, §12.1). */
  readonly canvasSize: CanvasSize;
  /** Pin the list highlights (panel row ↔ pin, both directions). */
  readonly activeCommentId?: string | null;
  /**
   * Placement mode (W8-F drives this from a toolbar button or the panel's
   * "add comment" action): the surface captures pointer events, pins go
   * inert, a drag placeholder follows the pointer.
   */
  readonly placementMode?: boolean;
  /**
   * Commits a new pin position in CANVAS px (clamped ints — the exact body
   * the POST /comments endpoint expects). Fired on pointerup after a click
   * or drag; Escape cancels without committing.
   */
  readonly onPlace?: (point: CanvasPoint) => void;
  /** Pin selection (click) — forwarded to the editor to highlight the thread. */
  readonly onSelectComment?: (commentId: string) => void;
  /** Escape during placement mode cancels (W8-F clears the mode). */
  readonly onCancelPlacement?: () => void;
  readonly className?: string;
}

/**
 * The canvas overlay: renders every comment pin, and — in placement mode —
 * turns the whole canvas into a click/drag surface for choosing where the
 * next comment goes (§19 Phase 3 "comments with positions").
 *
 * Outside placement mode the surface itself is `pointer-events-none` so it
 * never steals canvas interactions from the editor; pins re-enable pointer
 * events individually. Keyboard: while placing, the surface is a focusable
 * `role="button"` — Escape cancels, Enter/Space places at canvas center
 * (interim affordance, see README); pins themselves are real buttons.
 */
export function CommentPinOverlay({
  comments,
  canvasSize,
  activeCommentId = null,
  placementMode = false,
  onPlace,
  onSelectComment,
  onCancelPlacement,
  className = "",
}: CommentPinOverlayProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  /** The drag placeholder's current fraction; null until pointerdown. */
  const [drag, setDrag] = useState<PinFraction | null>(null);

  const placing = placementMode && onPlace !== undefined;

  /** Pointer position → clamped canvas fraction (null when unmeasurable). */
  function fractionAt(clientX: number, clientY: number): PinFraction | null {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return rect === undefined ? null : fractionFromPointer(clientX, clientY, rect);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!placing || event.button !== 0) {
      return; // primary button only; pins stay interactive otherwise
    }
    const start = fractionAt(event.clientX, event.clientY);
    if (start === null) {
      return;
    }
    setDrag(start);
    // Pointer capture: the drag keeps tracking outside the surface and the
    // pointerup commit fires exactly once, wherever the pointer ends up.
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drag === null) {
      return;
    }
    const next = fractionAt(event.clientX, event.clientY);
    if (next !== null) {
      setDrag(next); // clamped to [0,1] — the ghost sticks to canvas edges
    }
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drag === null) {
      return;
    }
    const end = fractionAt(event.clientX, event.clientY) ?? drag;
    setDrag(null);
    // ONE commit path for click and drag alike: final fraction → canvas px.
    onPlace?.(canvasPointFromFraction(end, canvasSize));
  }

  function handlePointerCancel(): void {
    setDrag(null); // device lost / pointercancel — never commit a stray pin
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!placing) {
      return;
    }
    if (event.key === "Escape") {
      setDrag(null);
      onCancelPlacement?.();
    } else if (event.key === "Enter" || event.key === " ") {
      // Keyboard path: `role="button"` obliges an activation. The center is
      // the only pointer-free, deterministic spot — documented in the README
      // as the interim keyboard affordance (W8-F may offer finer control).
      event.preventDefault();
      onPlace?.(canvasPointFromFraction({ fx: 0.5, fy: 0.5 }, canvasSize));
    }
  }

  const ghostStyle = drag === null ? null : percentStyle(drag);

  return (
    <div
      ref={surfaceRef}
      // Interactive ONLY in placement mode (role + tabIndex move together so
      // lint and AT agree; outside placement the surface is inert and
      // scroll-transparent — pins re-enable pointer events individually).
      role={placing ? "button" : undefined}
      tabIndex={placing ? 0 : undefined}
      aria-label="Comment pins"
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      className={`absolute inset-0 touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        placing ? "cursor-crosshair" : "pointer-events-none"
      } ${className}`}
    >
      {comments.map((comment) => (
        <CommentPin
          key={comment.id}
          comment={comment}
          canvasSize={canvasSize}
          active={comment.id === activeCommentId}
          onSelect={placing ? undefined : onSelectComment}
          disabled={placing}
        />
      ))}

      {/* Drag placeholder (§19 Phase 3): ghost pin at the live pointer
          fraction — visible from pointerdown until commit. */}
      {placing && ghostStyle !== null ? (
        <div
          style={ghostStyle}
          className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2"
        >
          <div className="flex h-7 w-7 animate-pulse items-center justify-center rounded-full border-2 border-dashed border-accent bg-accent/10 text-accent">
            <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
          </div>
        </div>
      ) : null}

      {/* Idle placement hint — replaced by the live ghost once dragging. */}
      {placing && ghostStyle === null ? (
        <p className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted-foreground shadow-sm">
          Click or drag on the canvas to place a comment · Esc to cancel
        </p>
      ) : null}
    </div>
  );
}
