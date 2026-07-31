import { useEffect, useState } from "react";

/**
 * Relative, not clock time, on anything live. Standing at a track, "just now"
 * versus "20 min ago" is the thing you actually need — whether a message still
 * applies — and it doesn't require knowing what time it is.
 */
export function timeAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));

  if (seconds < 45) {
    return "just now";
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);
  return `${hours} hr ago`;
}

/** Clock time, for the message log where "when was this said" is the question. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** A ticking clock so relative labels don't go stale on a page nobody reloads. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
