import { useEffect, useRef, useState } from "react";

import { api, type StatePayload } from "./api.ts";
import { alertsEnabled, fire } from "./alerts.ts";

export type Message = { id: number; body: string; at: number; direct: boolean };

/**
 * Refetch this racer's messages whenever the epoch moves. The epoch lives in the
 * public state payload but the message bodies do not — direct messages are only
 * ever handed out against a racer's own token.
 */
export function useMessages(state: StatePayload | null, meId: number | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const epoch = state?.messageEpoch ?? 0;

  useEffect(() => {
    if (meId === null) {
      return;
    }

    let live = true;
    api
      .messages()
      .then((rows) => {
        if (live) {
          setMessages(rows);
        }
      })
      .catch(() => {
        // A failed fetch just means the card doesn't update this tick.
      });

    return () => {
      live = false;
    };
  }, [epoch, meId]);

  return messages;
}

/**
 * Fires the alert when this racer's situation changes: they're up now, they're
 * on deck, or a new message arrived. Nothing fires on first render — otherwise
 * everyone's phone goes off simply because they opened the page.
 */
export function useRaceAlerts(
  state: StatePayload | null,
  meId: number | null,
  messages: Message[],
): void {
  const seen = useRef<{ current: number | null; onDeck: boolean; message: number } | null>(null);

  useEffect(() => {
    if (!state || meId === null) {
      return;
    }

    const currentMatch = state.matches.find((m) => m.id === state.event.currentMatch) ?? null;
    const racingNow = currentMatch !== null && (currentMatch.a === meId || currentMatch.b === meId);

    const nextId = state.queue.find((id) => id !== state.event.currentMatch);
    const nextMatch = state.matches.find((m) => m.id === nextId) ?? null;
    const onDeck = nextMatch !== null && (nextMatch.a === meId || nextMatch.b === meId);

    const topMessage = messages[0]?.id ?? 0;

    const previous = seen.current;
    seen.current = {
      current: racingNow ? (currentMatch?.id ?? null) : null,
      onDeck,
      message: topMessage,
    };

    if (!previous || !alertsEnabled()) {
      return;
    }

    if (racingNow && previous.current !== currentMatch?.id) {
      fire("up-now", "You're up!", "Get to the track.");
      return;
    }

    if (onDeck && !previous.onDeck) {
      fire("on-deck", "You're on deck", "One heat until you race.");
      return;
    }

    if (topMessage > previous.message) {
      const message = messages[0];
      fire("message", "Race director", message?.body ?? "New message.");
    }
  }, [state, meId, messages]);
}
