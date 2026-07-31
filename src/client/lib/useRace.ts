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

/** Fires when a match's result lands, so a view can celebrate it. */
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

    if (fresh === undefined) {
      return;
    }

    setFlash(fresh);
    const timer = setTimeout(() => setFlash(null), 3200);
    return () => clearTimeout(timer);
  }, [state]);

  return flash;
}
