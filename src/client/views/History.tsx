import { useEffect, useState } from "react";

import { BASE, api, type StatePayload } from "../lib/api.ts";
import { racerById, roundsOf } from "../lib/derive.ts";
import { Avatar } from "../components/Avatar.tsx";
import { MatchCard } from "../components/MatchCard.tsx";

type ArchiveSummary = Awaited<ReturnType<typeof api.archives.list>>[number];

export function HistoryView({ year }: { year: number | null }) {
  return year === null ? <Index /> : <Year year={year} />;
}

function Index() {
  const [rows, setRows] = useState<ArchiveSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.archives
      .list()
      .then(setRows)
      .catch(() => setError("Couldn't load past races."));
  }, []);

  return (
    <main className="hist">
      <header className="hist-head">
        <div className="track-rule" aria-hidden="true" />
        <p className="eyebrow">Every year so far</p>
        <h1 className="hist-title">Past races</h1>
      </header>

      {error ? <p className="error-msg">{error}</p> : null}
      {rows === null && !error ? <p className="empty-note">Loading…</p> : null}
      {rows !== null && rows.length === 0 ? (
        <p className="empty-note">
          No races archived yet. The first one shows up here once the director archives it.
        </p>
      ) : null}

      <ul className="hist-list">
        {(rows ?? []).map((row) => (
          <li key={row.year}>
            <a className="hist-card" href={`${BASE}history/${row.year}`}>
              <span className="hist-year tabular">{row.year}</span>
              <span className="hist-champ">
                <span className="eyebrow">Winner</span>
                <span className="hist-champ-name racer-name">{row.champion ?? "—"}</span>
              </span>
              <span className="hist-meta code">
                {row.racer_count} racers
                {row.consolation_champion ? ` · consolation: ${row.consolation_champion}` : ""}
              </span>
            </a>
          </li>
        ))}
      </ul>

      <a className="btn btn-ghost hist-back" href={BASE}>
        Back to this year
      </a>
    </main>
  );
}

function Year({ year }: { year: number }) {
  const [state, setState] = useState<StatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.archives
      .get(year)
      .then((row) => setState(row.state))
      .catch(() => setError(`No race archived for ${year}.`));
  }, [year]);

  if (error) {
    return (
      <main className="hist">
        <p className="error-msg">{error}</p>
        <a className="btn btn-ghost" href={`${BASE}history`}>
          All years
        </a>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="hist">
        <p className="empty-note">Loading {year}…</p>
      </main>
    );
  }

  const columns = roundsOf(state, ["W", "L", "GF", "GFR", "C"]);
  const podium = [
    { place: "1st", id: state.event.champion },
    { place: "2nd", id: state.event.runnerUp },
    { place: "3rd", id: state.event.third },
  ];

  return (
    <main className="hist">
      <header className="hist-head">
        <div className="track-rule" aria-hidden="true" />
        <p className="eyebrow">{state.event.name}</p>
        <h1 className="hist-title tabular">{year}</h1>
      </header>

      <section className="hist-podium">
        {podium.map((row) => {
          const racer = racerById(state, row.id);
          return (
            <div className="hist-pod" key={row.place}>
              <Avatar racer={racer} size="lg" />
              <span className="hist-pod-place code">{row.place}</span>
              <span className="hist-pod-name racer-name">{racer?.name ?? "—"}</span>
            </div>
          );
        })}
      </section>

      <div className="rc-columns scroll-x">
        {columns.map((column) => (
          <section className="rc-column" key={column.key}>
            <h2 className="rc-column-head">{column.label}</h2>
            <div className="stack rc-column-body">
              {column.matches.map((match) => (
                <MatchCard key={match.id} state={state} match={match} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <a className="btn btn-ghost hist-back" href={`${BASE}history`}>
        All years
      </a>
    </main>
  );
}
