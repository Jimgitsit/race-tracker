// Settings shared by the server, the client bundle, and the Vite config.
// Nothing secret belongs here — see src/config.ts for server-only settings.

export const BASE_PATH = "/race-tracker";
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
