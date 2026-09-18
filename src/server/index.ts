/**
 * Bun.serve entry point (DESIGN §6).
 *
 * The base prefix is tolerated but not required: nginx may or may not strip
 * `/race-tracker` depending on how the route is written, and hitting :58013
 * directly has no prefix at all. Stripping it here means the same relative URLs
 * work in every one of those cases.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";

import { DIRECTOR_PASSWORD, PHOTOS_DIR, SESSION_TTL_MS } from "../config.ts";
import { BASE_PATH, BYE_ID, MAX_UPLOAD_BYTES, PORT } from "../shared/config.ts";
import { db } from "./db.ts";
import {
  RaceError,
  consolationCandidates,
  currentYear,
  getArchive,
  listArchives,
  lockRoster,
  messagesFor,
  racerByToken,
  recordResult,
  registerRacer,
  removeRacer,
  renameRacer,
  resetEvent,
  sendMessage,
  setCurrentMatch,
  setRacerChecks,
  setRacerPhoto,
  snapshot,
  startConsolation,
  undoLast,
  type RacerChecks,
} from "./race.ts";
import { backupYear } from "./s3.ts";

const DIST = "dist";
const SESSION_COOKIE = "rt_director";

db();

// ---------------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------------

const listeners = new Set<(payload: string) => void>();

function broadcast(): void {
  const payload = JSON.stringify(snapshot());
  for (const send of listeners) {
    send(payload);
  }
}

function streamResponse(): Response {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let push: ((payload: string) => void) | null = null;

  function cleanup(): void {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (push !== null) {
      listeners.delete(push);
      push = null;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (payload: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          cleanup();
        }
      };

      push = send;
      listeners.add(send);
      send(JSON.stringify(snapshot()));

      // Proxies reap idle connections; a comment every 20s keeps this one alive.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 20_000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// ---------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------

function passwordMatches(input: string): boolean {
  const given = Buffer.from(input);
  const expected = Buffer.from(DIRECTOR_PASSWORD);
  if (given.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(given, expected);
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return rest.join("=");
    }
  }
  return null;
}

function isDirector(req: Request): boolean {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) {
    return false;
  }

  db().query("DELETE FROM sessions WHERE created_at < ?").run(Date.now() - SESSION_TTL_MS);

  return (
    db()
      .query<{ token: string }, [string]>("SELECT token FROM sessions WHERE token = ?")
      .get(token) !== null
  );
}

function requireDirector(req: Request): void {
  if (!isDirector(req)) {
    throw new RaceError("Sign in as the race director first.", 401);
  }
}

function requireRacer(req: Request) {
  const racer = racerByToken(req.headers.get("x-racer-token"));
  if (!racer) {
    throw new RaceError("We don't recognise this device. Register again.", 401);
  }
  return racer;
}

// ---------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * The full snapshot, with an ETag so an idle client (useRace's 24h fallback) can ask
 * "anything new?" every few minutes and get a 304 instead of 24 KB. The payload has
 * no volatile fields — it changes only when something is mutated — so a content hash
 * is a faithful version.
 */
function stateResponse(req: Request): Response {
  const payload = JSON.stringify(snapshot());
  const etag = `"${Bun.hash(payload).toString(16)}"`;

  // nginx gzips JSON and downgrades the tag to `W/"…"` on the way out, so the browser
  // hands back the weak form. Same content, so match it.
  const offered = (req.headers.get("if-none-match") ?? "")
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""));

  if (offered.includes(etag)) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  return new Response(payload, {
    headers: { "content-type": "application/json; charset=utf-8", etag },
  });
}

/** Mutate, push the new state to every connected client, and answer. */
function mutate(work: () => unknown): Response {
  const result = work();
  broadcast();
  return json(result ?? { ok: true });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    throw new RaceError("Expected a JSON body.");
  }
}

async function serveStatic(path: string): Promise<Response | null> {
  const file = Bun.file(`${DIST}${path}`);
  if (await file.exists()) {
    return new Response(file, {
      headers: path.startsWith("/assets/")
        ? { "cache-control": "public, max-age=31536000, immutable" }
        : {},
    });
  }
  return null;
}

async function servePhoto(path: string): Promise<Response> {
  // `..` in a photo path would climb out of the data directory.
  if (path.includes("..")) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(`${PHOTOS_DIR}${path}`);
  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(file, {
    headers: { "cache-control": "public, max-age=31536000, immutable" },
  });
}

async function shell(): Promise<Response> {
  const file = Bun.file(`${DIST}/index.html`);
  if (await file.exists()) {
    return new Response(file, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  return new Response(
    "race-tracker: no build found. Run `bun run build`, or `bun run dev` for the Vite server.",
    { status: 503, headers: { "content-type": "text/plain" } },
  );
}

// ---------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname;

  if (path === BASE_PATH) {
    return Response.redirect(`${BASE_PATH}/`, 301);
  }
  if (path.startsWith(`${BASE_PATH}/`)) {
    path = path.slice(BASE_PATH.length);
  }

  // ---- API -----------------------------------------------------------------------
  if (path === "/api/state") {
    return stateResponse(req);
  }

  if (path === "/api/stream") {
    return streamResponse();
  }

  if (path === "/api/register" && req.method === "POST") {
    const body = await readJson(req);
    const { token, racer } = registerRacer(String(body.name ?? ""));
    broadcast();
    return json({ token, racer: { id: racer.id, name: racer.name } });
  }

  // Resolves a token to a racer. A re-link QR hands a phone a token with no id
  // attached, so the client needs somewhere to ask who it now is.
  if (path === "/api/me" && req.method === "GET") {
    const racer = requireRacer(req);
    return json({ id: racer.id, name: racer.name });
  }

  if (path === "/api/me" && req.method === "PATCH") {
    const racer = requireRacer(req);
    const body = await readJson(req);
    return mutate(() => renameRacer(racer.id, String(body.name ?? "")));
  }

  // Broadcasts live in the public state payload; direct messages only ever come
  // back through here, gated on the racer's own token.
  if (path === "/api/me/messages" && req.method === "GET") {
    const racer = requireRacer(req);
    return json(messagesFor(racer.id));
  }

  if (path === "/api/me/photo" && req.method === "POST") {
    const racer = requireRacer(req);
    return await uploadPhoto(req, racer.id);
  }

  if (path === "/api/archives") {
    return json(listArchives());
  }

  const archiveMatch = path.match(/^\/api\/archives\/(\d{4})$/);
  if (archiveMatch) {
    const row = getArchive(Number(archiveMatch[1]));
    if (!row) {
      return json({ error: "No race archived for that year." }, 404);
    }
    return json({ ...row, state: JSON.parse(row.state) });
  }

  // ---- director ------------------------------------------------------------------
  if (path === "/api/director/login" && req.method === "POST") {
    const body = await readJson(req);
    if (!passwordMatches(String(body.password ?? ""))) {
      return json({ error: "That password doesn't match." }, 401);
    }

    const token = randomUUID();
    db()
      .query("INSERT INTO sessions (token, created_at) VALUES (?, ?)")
      .run(token, Date.now());

    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie":
          `${SESSION_COOKIE}=${token}; Path=${BASE_PATH}/; HttpOnly; SameSite=Strict; ` +
          `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      },
    });
  }

  if (path === "/api/director/session") {
    return json({ signedIn: isDirector(req) });
  }

  if (path.startsWith("/api/director/")) {
    requireDirector(req);

    if (path === "/api/director/lock" && req.method === "POST") {
      return mutate(() => lockRoster());
    }

    if (path === "/api/director/result" && req.method === "POST") {
      const body = await readJson(req);
      return mutate(() => recordResult(Number(body.matchId), Number(body.winnerId)));
    }

    if (path === "/api/director/message" && req.method === "POST") {
      const body = await readJson(req);
      const target = body.racerId === null || body.racerId === undefined
        ? null
        : Number(body.racerId);

      return mutate(() => {
        const row = sendMessage(String(body.body ?? ""), target);
        return { id: row.id };
      });
    }

    if (path === "/api/director/undo" && req.method === "POST") {
      return mutate(() => undoLast());
    }

    if (path === "/api/director/current" && req.method === "POST") {
      const body = await readJson(req);
      return mutate(() => setCurrentMatch(Number(body.matchId)));
    }

    if (path === "/api/director/consolation" && req.method === "GET") {
      return json(consolationCandidates());
    }

    if (path === "/api/director/consolation" && req.method === "POST") {
      const body = await readJson(req);
      const ids = Array.isArray(body.racerIds) ? body.racerIds.map(Number) : [];
      return mutate(() => startConsolation(ids));
    }

    if (path === "/api/director/reset" && req.method === "POST") {
      // Tolerates a missing body: a page cached from before the options existed
      // posts nothing, and "Expected a JSON body" is a baffling answer to
      // "start over". No body means the defaults: save, don't keep.
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const row = resetEvent({
        keepRacers: body.keepRacers === true,
        save: body.save !== false,
      });
      broadcast();

      if (row) {
        // Deliberately not awaited: the race is over, the archive is already safe
        // on local disk, and the director should not watch a spinner while photos
        // go to S3. Failures are logged and can be retried by hand.
        void backupYear(row.year, row.state).then((result) => {
          console.log(
            result.ok
              ? `archived ${row.year} → ${result.detail}`
              : `archived ${row.year} locally; offsite backup skipped: ${result.detail}`,
          );
        });
      }

      return json({ archived: row ? { year: row.year, champion: row.champion } : null });
    }

    // Walk-ups without a phone. Same validation as self-registration; the row
    // still gets a token, so Re-link can hand it to a phone if one turns up.
    if (path === "/api/director/racer" && req.method === "POST") {
      const body = await readJson(req);
      return mutate(() => {
        const { racer } = registerRacer(String(body.name ?? ""));
        return { id: racer.id, name: racer.name };
      });
    }

    const racerMatch = path.match(/^\/api\/director\/racer\/(\d+)$/);
    if (racerMatch && req.method === "DELETE") {
      return mutate(() => removeRacer(Number(racerMatch[1])));
    }
    if (racerMatch && req.method === "PATCH") {
      const body = await readJson(req);
      const checks: RacerChecks = {};
      if (typeof body.inspected === "boolean") {
        checks.inspected = body.inspected;
      }
      if (typeof body.paid === "boolean") {
        checks.paid = body.paid;
      }
      return mutate(() => setRacerChecks(Number(racerMatch[1]), checks));
    }

    const tokenMatch = path.match(/^\/api\/director\/racer\/(\d+)\/token$/);
    if (tokenMatch) {
      const row = db()
        .query<{ token: string }, [number]>("SELECT token FROM racers WHERE id = ?")
        .get(Number(tokenMatch[1]));

      if (!row) {
        return json({ error: "No such racer." }, 404);
      }
      return json({ token: row.token });
    }

    // The director's phone stands in for a racer who has none. Same handler as
    // /api/me/photo, so the files, the cache-busting version and the broadcast
    // are identical whichever phone took the picture.
    const photoMatch = path.match(/^\/api\/director\/racer\/(\d+)\/photo$/);
    if (photoMatch && req.method === "POST") {
      const id = Number(photoMatch[1]);
      const row = db()
        .query<{ id: number }, [number, number]>("SELECT id FROM racers WHERE id = ? AND id != ?")
        .get(id, BYE_ID);

      if (!row) {
        return json({ error: "No such racer." }, 404);
      }
      return await uploadPhoto(req, id);
    }
  }

  if (path.startsWith("/api/")) {
    return json({ error: "Unknown endpoint." }, 404);
  }

  // ---- static --------------------------------------------------------------------
  if (path.startsWith("/photos/")) {
    return await servePhoto(path.slice("/photos".length));
  }

  const asset = await serveStatic(path);
  if (asset) {
    return asset;
  }

  // Catch-all so /display and /director stay typeable on a TV remote.
  return await shell();
}

async function uploadPhoto(req: Request, racerId: number): Promise<Response> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD_BYTES) {
    throw new RaceError("That photo is too large.", 413);
  }

  const form = await req.formData();
  const full = form.get("full");
  const thumb = form.get("thumb");

  if (!(full instanceof Blob) || !(thumb instanceof Blob)) {
    throw new RaceError("Expected a full and a thumb image.");
  }
  if (full.size > MAX_UPLOAD_BYTES || thumb.size > MAX_UPLOAD_BYTES) {
    throw new RaceError("That photo is too large.", 413);
  }
  if (!full.type.startsWith("image/") || !thumb.type.startsWith("image/")) {
    throw new RaceError("That file isn't an image.");
  }

  const year = currentYear();
  const dir = `${PHOTOS_DIR}/${year}`;
  mkdirSync(dir, { recursive: true });

  await Bun.write(`${dir}/${racerId}.jpg`, full);
  await Bun.write(`${dir}/${racerId}-t.jpg`, thumb);

  // The version is baked into the stored URL so re-uploads bust the cache without
  // the snapshot having to stat 30 files on every push.
  const version = Date.now();
  const photo = `photos/${year}/${racerId}.jpg?v=${version}`;
  const thumbPath = `photos/${year}/${racerId}-t.jpg?v=${version}`;

  setRacerPhoto(racerId, photo, thumbPath);
  broadcast();

  return json({ photo, thumb: thumbPath });
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    try {
      return await handle(req);
    } catch (error) {
      if (error instanceof RaceError) {
        return json({ error: error.message }, error.status);
      }
      console.error(error);
      return json({ error: "Something went wrong on the server." }, 500);
    }
  },
});

const photoDir = `${PHOTOS_DIR}/${currentYear()}`;
mkdirSync(photoDir, { recursive: true });
await stat(photoDir);

console.log(`race-tracker listening on http://127.0.0.1:${server.port}${BASE_PATH}/`);
