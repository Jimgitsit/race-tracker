// Settings shared by the server, the client bundle, and the Vite config.
// Nothing secret belongs here — see src/config.ts for server-only settings.

/**
 * The path prefix the app is mounted under: "/race-tracker" behind the Mac mini's
 * nginx, "" on a hostname of its own (Fly). Read from the environment by the
 * Vite config at build time and the server at run time; the browser bundle never
 * sees `process`, takes the default, and doesn't use it — the client's base is
 * Vite's `import.meta.env.BASE_URL`.
 */
const basePathFromEnv =
  typeof process !== "undefined" ? process.env.RACE_TRACKER_BASE_PATH : undefined;

export const BASE_PATH = basePathFromEnv ?? "/race-tracker";
export const PORT = 58013;

/** Bracket sizes we design and test against. */
export const MIN_RACERS = 4;
export const MAX_RACERS = 64;

/** Consolation bracket (DESIGN §4.6). */
export const CONSOLATION_SIZE = 16;
export const CONSOLATION_MIN_ELIMINATED = 8;

/** Photos (DESIGN §8). */
export const PHOTO_FULL_PX = 800;
export const PHOTO_THUMB_PX = 200;
export const PHOTO_QUALITY = 0.82;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Bumped when the shape of the /api/state payload changes (DESIGN §5). */
export const ARCHIVE_SCHEMA_VERSION = 1;

/** The reserved sentinel racer id standing in for a bye. Never NULL. */
export const BYE_ID = 0;
