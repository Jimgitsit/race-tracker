import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Two QR types with very different exposure rules (DESIGN §3.4):
 *
 *  - a JOIN code is the bare app URL and is safe anywhere, including the big screen;
 *  - a RE-LINK code carries a racer's token, which *is* their identity, and belongs
 *    only on the director's phone shown to one person.
 *
 * They are deliberately separate components rather than one that takes a URL, so
 * the distinction can't quietly collapse later.
 */
type CodeProps = {
  value: string;
  size?: number;
  className?: string;
};

function Code({ value, size = 220, className }: CodeProps) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    QRCode.toString(value, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#17120e", light: "#f7f1ea" },
    })
      .then((markup) => {
        if (live) {
          setSvg(markup);
        }
      })
      .catch(() => setSvg(null));

    return () => {
      live = false;
    };
  }, [value]);

  if (!svg) {
    return <div className={`qr-shell ${className ?? ""}`} style={{ width: size, height: size }} />;
  }

  return (
    <div
      className={`qr-shell ${className ?? ""}`}
      style={{ width: size, height: size }}
      // Markup comes from the QR encoder over a URL we constructed.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function JoinQR({ url, size, label }: { url: string; size?: number; label?: string }) {
  return (
    <div className="qr-block">
      <Code value={url} size={size} />
      {label === undefined ? null : <p className="qr-label">{label}</p>}
      <p className="qr-url code">{url.replace(/^https?:\/\//, "")}</p>
    </div>
  );
}

export function RelinkQR({ url, name }: { url: string; name: string }) {
  return (
    <div className="qr-block">
      <Code value={url} size={200} />
      <p className="qr-label">Scan to sign back in as {name}</p>
      <p className="qr-warn">
        This code is {name}'s identity. Show it to them, don't put it on the screen.
      </p>
    </div>
  );
}
