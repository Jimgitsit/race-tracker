import { racerById, sourceLabel } from "../lib/derive.ts";
import type { PublicMatch, StatePayload } from "../lib/api.ts";
import { Avatar } from "./Avatar.tsx";

type Props = {
  state: StatePayload;
  match: PublicMatch;
  dim?: boolean;
  current?: boolean;
  compact?: boolean;
  /** Off inside bracket columns, where the column header already names it. */
  showRound?: boolean;
  onSelect?: (match: PublicMatch) => void;
};

function Side({
  state,
  match,
  side,
  compact,
}: {
  state: StatePayload;
  match: PublicMatch;
  side: "a" | "b";
  compact: boolean;
}) {
  const racerId = side === "a" ? match.a : match.b;
  const racer = racerById(state, racerId);
  const decided = match.winner !== null;
  const won = decided && match.winner === racerId;
  const lost = decided && !won && racer !== null;

  const classes = ["mc-side"];
  if (won) {
    classes.push("mc-won");
  }
  if (lost) {
    classes.push("mc-lost");
  }

  return (
    <div className={classes.join(" ")}>
      {compact ? null : <Avatar racer={racer} size="sm" />}
      <span className="mc-name racer-name">
        {racer ? racer.name : sourceLabel(state, match, side)}
      </span>
      {won ? (
        <span className="mc-check" aria-label="won">
          ✓
        </span>
      ) : null}
    </div>
  );
}

export function MatchCard({
  state,
  match,
  dim,
  current,
  compact = false,
  showRound = true,
  onSelect,
}: Props) {
  const classes = ["mc"];
  if (dim) {
    classes.push("mc-dim");
  }
  if (current) {
    classes.push("mc-current");
  }
  if (match.bracket === "L") {
    classes.push("mc-losers");
  }
  if (match.state === "bye") {
    classes.push("mc-bye");
  }
  if (compact) {
    classes.push("mc-compact");
  }

  const body = (
    <>
      {/* No match code: it only helps someone cross-referencing a chart. */}
      <div className="mc-head">
        <span className="code">{showRound ? match.label : ""}</span>
        {match.state === "bye" ? <span className="mc-tag">bye</span> : null}
        {current ? <span className="mc-tag mc-tag-live">racing</span> : null}
      </div>
      <Side state={state} match={match} side="a" compact={compact} />
      <Side state={state} match={match} side="b" compact={compact} />
    </>
  );

  if (!onSelect) {
    return <div className={classes.join(" ")}>{body}</div>;
  }

  return (
    <button type="button" className={classes.join(" ")} onClick={() => onSelect(match)}>
      {body}
    </button>
  );
}
