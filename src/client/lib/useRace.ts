import { useEffect, useRef, useState } from "react";

import { apiUrl, type StatePayload } from "./api.ts";

/**
 * Live state over SSE. The server pushes the whole payload on every change, so
 * there is no "got a nudge but raced the refetch" class of bug — and EventSource
 * reconnects on its own when a phone comes back from sleep.
 */
export function useRace(): { state: StatePayload | null; connected: boolean } {
  const [state, setState] = useState<StatePayload | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource(apiUrl("stream"));

    source.onmessage = (event) => {
      setState(JSON.parse(event.data) as StatePayload);
      setConnected(true);
    };

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    return () => source.close();
  }, []);

  return { state, connected };
}

/** How long a result holds the screen before the next heat takes over. */
export const FLASH_MS = 4000;

/**
 * Fires when a match's result lands, so a view can celebrate it.
 *
 * A bye is `state: "bye"`, never `"done"`, so a bye cascading through the losers
 * bracket off the back of this result can't be mistaken for the race just run.
 */
export function useResultFlash(state: StatePayload | null): number | null {
  const [flash, setFlash] = useState<number | null>(null);
  const seen = useRef<Set<number> | null>(null);

  useEffect(() => {
    if (!state) {
      return;
    }

    const done = new Set(
      state.matches.filter((m) => m.state === "done").map((m) => m.id),
    );

    if (seen.current === null) {
      seen.current = done;
      return;
    }

    const fresh = [...done].find((id) => !seen.current!.has(id));
    seen.current = done;

    if (fresh !== undefined) {
      setFlash(fresh);
    }
  }, [state]);

  // The countdown is keyed on the flash, not on `state`. Sharing one effect meant
  // any unrelated push mid-flash — a message, the director picking the next heat —
  // cleared the timer and then returned early without re-arming it, leaving the
  // result on screen for good.
  useEffect(() => {
    if (flash === null) {
      return;
    }

    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  return flash;
}
