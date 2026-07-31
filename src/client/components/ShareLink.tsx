import { useState } from "react";

type Props = {
  url: string;
  title: string;
  text: string;
};

/**
 * Hands the join link to the phone's own share sheet, so it can go out by
 * message the way people actually send links. A QR only works for someone
 * standing next to you.
 *
 * Falls back to the clipboard where the Web Share API isn't available (mostly
 * desktop). Cancelling the share sheet throws `AbortError` — that's a person
 * changing their mind, not a failure, so it must not surface as one.
 */
export function ShareLink({ url, title, text }: Props) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const share = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (error) {
        if ((error as Error | undefined)?.name === "AbortError") {
          return;
        }
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      setStatus("copied");
      setTimeout(() => setStatus("idle"), 2200);
    } catch {
      setStatus("failed");
    }
  };

  return (
    <div className="share-block">
      <button type="button" className="btn btn-primary btn-block" onClick={share}>
        {status === "copied" ? "Link copied" : "Send the link"}
      </button>
      {status === "failed" ? (
        <p className="error-msg">Couldn't copy it — the address is under the code above.</p>
      ) : null}
    </div>
  );
}
