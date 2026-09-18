// Server-only configuration. Never imported by client code — see src/shared/config.ts
// for the settings the browser bundle is allowed to see.

export const DIRECTOR_PASSWORD = "hotwheels"; // ← change me

/**
 * This gates entering race results at a backyard race. Treating it as a real
 * credential would be theater: anyone who reads the public repo can read it.
 * That is an accepted tradeoff for this event — but don't reuse a real password
 * here, and if the event ever matters more, move it to an env var.
 */

/** An event runs a few hours; being logged out at heat 40 is infuriating. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Overridable so the integration test can run against a scratch database
// instead of the live one.
export const DATA_DIR = process.env.RACE_TRACKER_DATA_DIR ?? "data";
export const DB_PATH = `${DATA_DIR}/race.db`;
export const PHOTOS_DIR = `${DATA_DIR}/photos`;

/** S3: the live snapshot and the yearly archive backup (DESIGN §9). Empty bucket = off. */
export const S3_BUCKET = process.env.RACE_TRACKER_S3_BUCKET ?? "";
export const S3_PREFIX = "race-tracker";
export const S3_REGION = process.env.AWS_REGION ?? "us-west-2";
