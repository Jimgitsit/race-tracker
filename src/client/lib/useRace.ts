import { useEffect, useRef, useState } from "react";

import { apiUrl, type StatePayload } from "./api.ts";

/**
 * A client that has seen no change for this long stops holding the stream open and
 * drops to polling. A /display tab forgotten for a week shouldn't sit on a
 * connection — or, on a laptop that sleeps and wakes, re-pull the whole snapshot
 * twice an hour for nothing.
 */
export const IDLE_AFTER_MS = 24 * 60 * 60 * 1000;

/** How often an idle client asks whether anything changed. A 304 when nothing has. */
export const IDLE_POLL_MS = 5 * 60 * 1000;

/** How often a live client checks whether it has crossed into idleness. */
const IDLE_CHECK_MS = 60 * 1000;

/**
 * Live state over SSE. The server pushes the whole payload on every change, so
 * there is no "got a nudge but raced the refetch" class of bug — and EventSource
 * reconnects on its own when a phone comes back from sleep.
 *
 * After `IDLE_AFTER_MS` without the payload changing, the stream is closed and the
 * client polls `/api/state` with `If-None-Match` every `IDLE_POLL_MS` instead. The
 * first change — or anyone touching the page — brings the stream straight back, so
 * an idle screen is at most one poll interval behind the race and a hand on the
 * keyboard makes it current at once.
 */
export function useRace(): { state: StatePayload | null; connected: boolean } {
  const [state, setState] = useState<StatePayload | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let idleCheck: ReturnType<typeof setInterval> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let lastPayload: string | null = null;
    let lastChange = Date.now();
    let etag: string | null = null;
    let stopped = false;

    /** Adopt a payload, noting whether it differs from the last one seen. */
    const receive = (payload: string): boolean => {
      setConnected(true);
      if (payload === lastPayload) {
        return false;
      }
      lastPayload = payload;
      lastChange = Date.now();
      setState(JSON.parse(payload) as StatePayload);
      return true;
    };

    function goLive(): void {
      if (poll !== null) {
        clearInterval(poll);
        poll = null;
      }
      if (source !== null) {
        return;
      }

      source = new EventSource(apiUrl("stream"));
      source.onmessage = (event) => receive(event.data as string);
      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);

      idleCheck = setInterval(() => {
        if (Date.now() - lastChange >= IDLE_AFTER_MS) {
          goIdle();
        }
      }, IDLE_CHECK_MS);
    }

    function goIdle(): void {
      if (idleCheck !== null) {
        clearInterval(idleCheck);
        idleCheck = null;
      }
      if (source !== null) {
        source.close();
        source = null;
      }
      poll = setInterval(checkForChange, IDLE_POLL_MS);
    }

    async function checkForChange(): Promise<void> {
      const headers = new Headers();
      if (etag !== null) {
        headers.set("if-none-match", etag);
      }

      let res: Response;
      try {
        res = await fetch(apiUrl("state"), { headers, cache: "no-store" });
      } catch {
        setConnected(false);
        return;
      }

      if (stopped) {
        return;
      }
      if (res.status === 304) {
        setConnected(true);
        return;
      }
      if (!res.ok) {
        setConnected(false);
        return;
      }

      etag = res.headers.get("etag");
      if (receive(await res.text())) {
        goLive();
      }
    }

    // Someone at the screen wants it current now, not at the next poll.
    const wake = (): void => {
      if (poll !== null) {
        goLive();
      }
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        wake();
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);

    goLive();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      if (idleCheck !== null) {
        clearInterval(idleCheck);
      }
      if (poll !== null) {
        clearInterval(poll);
      }
      source?.close();
    };
  }, []);

  return { state, connected };
}

/**
 * How long a result holds the screen before the next heat takes over. The
 * director set it just under the length of the big screen's race clip
 * (`sound.ts`, 11.8 s). It's a plain timer, never the clip's `ended` event — the
 * swap must happen whether or not audio played. Know that a new result restarts
 * the hold, so results entered faster than this keep the banner on the newest one.
 */
export const FLASH_MS = 11000;

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
