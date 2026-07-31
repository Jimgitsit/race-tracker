import { useEffect, useState } from "react";

import { BASE } from "./lib/api.ts";
import { useRace } from "./lib/useRace.ts";
import { RacerView } from "./views/Racer.tsx";
import { DirectorView } from "./views/Director.tsx";
import { DisplayView } from "./views/Display.tsx";
import { HistoryView } from "./views/History.tsx";

type Route =
  | { name: "racer" }
  | { name: "director" }
  | { name: "display" }
  | { name: "history"; year: number | null };

function parseRoute(): Route {
  let path = window.location.pathname;

  if (path.startsWith(BASE)) {
    path = path.slice(BASE.length);
  }
  path = path.replace(/^\/+|\/+$/g, "");

  if (path === "director") {
    return { name: "director" };
  }
  if (path === "display") {
    return { name: "display" };
  }
  if (path === "history") {
    return { name: "history", year: null };
  }

  const year = path.match(/^history\/(\d{4})$/);
  if (year) {
    return { name: "history", year: Number(year[1]) };
  }

  return { name: "racer" };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseRoute);

  useEffect(() => {
    const sync = () => setRoute(parseRoute());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  return route;
}

export function App() {
  const route = useRoute();
  const { state, connected } = useRace();

  if (route.name === "history") {
    return <HistoryView year={route.year} />;
  }

  if (!state) {
    return (
      <div className="boot">
        <div className="boot-track" aria-hidden="true" />
        <p className="eyebrow">Connecting to the track</p>
      </div>
    );
  }

  return (
    <>
      {connected ? null : <p className="offline-banner">Reconnecting…</p>}
      {route.name === "director" ? <DirectorView state={state} /> : null}
      {route.name === "display" ? <DisplayView state={state} /> : null}
      {route.name === "racer" ? <RacerView state={state} /> : null}
    </>
  );
}
