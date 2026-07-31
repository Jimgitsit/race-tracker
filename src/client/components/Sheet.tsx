import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/** Past this much drag, let go and it closes. */
const DISMISS_PX = 110;

/**
 * Bottom sheet: slides up from the edge, and can be thrown back down by the grip.
 *
 * Dismissing is handle-only on purpose. Body drags were tried and felt wrong:
 * any pull-down inside the sheet has to decide, mid-gesture, whether it's a
 * scroll or a dismiss, and getting that wrong either closes the sheet out from
 * under a scroll or swallows the scroll entirely. The header is sticky, so the
 * grip is always in reach and the body is free to just scroll.
 */
export function Sheet({ open, title, onClose, children }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const drag = useRef<{ startY: number; pointerId: number; active: boolean } | null>(null);

  const reset = useCallback(() => {
    drag.current = null;
    setDragging(false);
    setOffset(0);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKey);
    panel.current?.focus();

    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    const element = panel.current;
    if (!open || !element) {
      return;
    }

    const down = (event: PointerEvent) => {
      // Only the grip starts a dismiss. Anywhere else is the body's to scroll.
      if ((event.target as Element | null)?.closest(".sheet-head") === null) {
        return;
      }
      drag.current = { startY: event.clientY, pointerId: event.pointerId, active: false };
    };

    const move = (event: PointerEvent) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }

      const dy = event.clientY - state.startY;

      if (!state.active) {
        if (dy <= 6) {
          return;
        }
        state.active = true;
        setDragging(true);
        element.setPointerCapture(event.pointerId);
      }

      if (event.cancelable) {
        event.preventDefault();
      }
      setOffset(Math.max(0, dy));
    };

    const up = (event: PointerEvent) => {
      const state = drag.current;
      drag.current = null;

      if (!state?.active) {
        setDragging(false);
        return;
      }

      const dy = event.clientY - state.startY;
      const threshold = Math.min(DISMISS_PX, element.offsetHeight * 0.3);

      setDragging(false);
      setOffset(0);

      if (dy > threshold) {
        onClose();
      }
    };

    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move, { passive: false });
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);

    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  // The backdrop lightens as the sheet is pulled away, so the gesture feels
  // attached to something rather than sliding over a fixed scrim.
  const progress = Math.min(1, offset / 320);

  return (
    <div
      className="sheet-backdrop"
      style={offset > 0 ? { opacity: 1 - progress * 0.55 } : undefined}
      onClick={onClose}
    >
      <div
        className={`sheet ${dragging ? "sheet-dragging" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        style={offset > 0 ? { transform: `translateY(${offset}px)` } : undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <div className="sheet-grip" aria-hidden="true" />
          <h2 className="sheet-title">{title}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}
