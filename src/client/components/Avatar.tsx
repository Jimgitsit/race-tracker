import { assetUrl, type PublicRacer } from "../lib/api.ts";

/**
 * Muted swatches drawn from the warm/cool ends of the palette, so a bracket full
 * of placeholders still reads as one designed system rather than random colour.
 * A ragged hole where a photo isn't is the thing to avoid (DESIGN §8).
 */
const SWATCHES = [
  "#9c4a2a",
  "#6f5f33",
  "#356254",
  "#37536f",
  "#5f4262",
  "#7c4436",
  "#436141",
  "#6d5027",
];

type Props = {
  racer: PublicRacer | null;
  size?: "sm" | "md" | "lg" | "xl";
  full?: boolean;
  placeholderLabel?: string;
};

export function Avatar({ racer, size = "md", full = false, placeholderLabel }: Props) {
  const src = assetUrl(full ? (racer?.photo ?? racer?.thumb ?? null) : (racer?.thumb ?? racer?.photo ?? null));
  const className = `avatar avatar-${size}`;

  if (!racer) {
    return (
      <div className={`${className} avatar-empty`} aria-hidden="true">
        {placeholderLabel ? <span className="avatar-tbd">{placeholderLabel}</span> : null}
      </div>
    );
  }

  if (src) {
    return <img className={className} src={src} alt={`${racer.name}'s car`} loading="lazy" />;
  }

  return (
    <div
      className={`${className} avatar-initial`}
      style={{ background: SWATCHES[racer.id % SWATCHES.length] }}
      aria-hidden="true"
    >
      {racer.name.trim().charAt(0).toUpperCase()}
    </div>
  );
}
