import { useEffect } from "react";

/**
 * Keeps the screen on while the page is visible. TVs sleep, and a phone that
 * auto-locks is a phone that can't chime: Safari freezes the tab entirely once
 * the screen is off, stream and all. Browsers also drop the lock whenever the
 * tab is backgrounded, so re-request it on visibilitychange rather than
 * assuming the first grant holds.
 */
export function useWakeLock(enabled = true): void {
  useEffect(() => {
    type Sentinel = { release: () => Promise<void> };
    const nav = navigator as Navigator & {
      wakeLock?: { request: (kind: "screen") => Promise<Sentinel> };
    };

    if (!enabled || !nav.wakeLock) {
      return;
    }

    let sentinel: Sentinel | null = null;
    let live = true;

    const acquire = async () => {
      try {
        const next = await nav.wakeLock!.request("screen");
        if (live) {
          sentinel = next;
        } else {
          await next.release();
        }
      } catch {
        // A denied wake lock is not worth surfacing.
      }
    };

    void acquire();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void acquire();
      }
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    };
  }, [enabled]);
}
