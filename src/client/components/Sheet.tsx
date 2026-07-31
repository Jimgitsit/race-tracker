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
 * Bottom sheet: slides up from the edge, and can be thrown back down.
 *
 * The drag is deliberately split. The header carries `touch-action: none`, so
 * dragging from the grip always dismisses — that path is guaranteed on every
 * browser. The body only engages a dismiss when it's already scrolled to the
 * top, so a pull-down inside a scrollable list (the racer picker) scrolls
 * rather than closing the sheet out from under you.
 */
export function Sheet({ open, title, onClose, children }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const drag = useRef<{
    startY: number;
    startScroll: number;
    pointerId: number;
    active: boolean;
  } | null>(null);

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
      // A drag starting on the grip is always a dismiss; elsewhere it depends on
      // whether the content is already at the top.
      const fromHeader = (event.target as Element | null)?.closest(".sheet-head") !== null;

      drag.current = {
        startY: event.clientY,
        startScroll: fromHeader ? 0 : element.scrollTop,
        pointerId: event.pointerId,
        active: false,
      };
    };

    const move = (event: PointerEvent) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }

      const dy = event.clientY - state.startY;

      if (!state.active) {
        if (dy > 6 && state.startScroll <= 0 && element.scrollTop <= 0) {
          state.active = true;
          setDragging(true);
          element.setPointerCapture(event.pointerId);
        } else if (Math.abs(dy) > 6) {
          // They're scrolling, not dismissing. Stay out of the way.
          drag.current = null;
          return;
        } else {
          return;
        }
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
