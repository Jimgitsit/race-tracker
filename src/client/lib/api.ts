import type { PublicRacer, StatePayload } from "../../server/race.ts";

export type { PublicMatch, PublicRacer, StatePayload } from "../../server/race.ts";

/**
 * Everything resolves against Vite's base, so the same code works under the
 * /race-tracker/ mount, on the dev server, and hitting :58013 directly.
 */
export const BASE = import.meta.env.BASE_URL;

export function apiUrl(path: string): string {
  return `${BASE}api/${path}`;
}

export function assetUrl(path: string | null): string | null {
  return path ? `${BASE}${path}` : null;
}

/** The URL to hand someone so they can join. No identity in it. */
export function joinUrl(): string {
  return new URL(BASE, window.location.origin).href;
}

/** The URL that restores a specific racer's identity. Director's phone only. */
export function relinkUrl(token: string): string {
  return `${new URL(BASE, window.location.origin).href}?t=${encodeURIComponent(token)}`;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("race-tracker.token");
  const headers = new Headers(init.headers);

  if (token) {
    headers.set("x-racer-token", token);
  }
  if (init.body && typeof init.body === "string") {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(apiUrl(path), { ...init, headers, credentials: "same-origin" });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError(body?.error ?? "Something went wrong.", res.status);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  state: () => request<StatePayload>("state"),

  me: () => request<{ id: number; name: string }>("me"),
  messages: () =>
    request<{ id: number; body: string; at: number; direct: boolean }[]>("me/messages"),
  register: (name: string) => post<{ token: string; racer: { id: number; name: string } }>("register", { name }),
  rename: (name: string) => request("me", { method: "PATCH", body: JSON.stringify({ name }) }),

  uploadPhoto: async (full: Blob, thumb: Blob) => {
    const form = new FormData();
    form.append("full", full, "full.jpg");
    form.append("thumb", thumb, "thumb.jpg");
    return request<{ photo: string; thumb: string }>("me/photo", { method: "POST", body: form });
  },

  director: {
    session: () => request<{ signedIn: boolean }>("director/session"),
    login: (password: string) => post("director/login", { password }),
    lock: () => post("director/lock"),
    result: (matchId: number, winnerId: number) => post("director/result", { matchId, winnerId }),
    undo: () => post("director/undo"),
    message: (body: string, racerId: number | null) =>
      post<{ id: number }>("director/message", { body, racerId }),
    setCurrent: (matchId: number) => post("director/current", { matchId }),
    addRacer: (name: string) => post<{ id: number; name: string }>("director/racer", { name }),
    removeRacer: (id: number) => request(`director/racer/${id}`, { method: "DELETE" }),
    setChecks: (id: number, checks: { inspected?: boolean; paid?: boolean }) =>
      request(`director/racer/${id}`, { method: "PATCH", body: JSON.stringify(checks) }),
    racerToken: (id: number) => request<{ token: string }>(`director/racer/${id}/token`),
    consolationCandidates: () => request<PublicRacer[]>("director/consolation"),
    startConsolation: (racerIds: number[]) => post("director/consolation", { racerIds }),
    reset: (options: { keepRacers: boolean; save: boolean }) =>
      post<{ archived: { year: number; champion: string | null } | null }>(
        "director/reset",
        options,
      ),
  },

  archives: {
    list: () =>
      request<
        {
          year: number;
          name: string;
          archived_at: number;
          racer_count: number;
          champion: string | null;
          runner_up: string | null;
          third: string | null;
          consolation_champion: string | null;
        }[]
      >("archives"),
    get: (year: number) => request<{ year: number; state: StatePayload }>(`archives/${year}`),
  },
};
