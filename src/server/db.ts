/** SQLite schema and connection (DESIGN §5). */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

import { DATA_DIR, DB_PATH, PHOTOS_DIR } from "../config.ts";
import { BYE_ID } from "../shared/config.ts";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS event (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  name           TEXT    NOT NULL DEFAULT 'Hot Wheels Race',
  year           INTEGER NOT NULL,
  phase          TEXT    NOT NULL DEFAULT 'registration',
  bracket_size   INTEGER,
  current_match  INTEGER,
  consolation    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS racers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  name_key    TEXT    NOT NULL UNIQUE,
  token       TEXT    NOT NULL UNIQUE,
  photo       TEXT,
  thumb       TEXT,
  seed        INTEGER,
  created_at  INTEGER NOT NULL,
  inspected_at INTEGER,
  paid_at      INTEGER
);

CREATE TABLE IF NOT EXISTS matches (
  id           INTEGER PRIMARY KEY,
  bracket      TEXT    NOT NULL,
  round        INTEGER NOT NULL,
  slot         INTEGER NOT NULL,
  a_racer      INTEGER,
  b_racer      INTEGER,
  a_source     TEXT,
  b_source     TEXT,
  winner       INTEGER,
  state        TEXT    NOT NULL,
  order_index  INTEGER NOT NULL,
  UNIQUE (bracket, round, slot)
);

CREATE TABLE IF NOT EXISTS edges (
  from_match  INTEGER NOT NULL REFERENCES matches(id),
  outcome     TEXT    NOT NULL,
  to_match    INTEGER NOT NULL REFERENCES matches(id),
  to_slot     TEXT    NOT NULL,
  PRIMARY KEY (from_match, outcome)
);

CREATE TABLE IF NOT EXISTS results_log (
  id          INTEGER PRIMARY KEY,
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  winner      INTEGER NOT NULL REFERENCES racers(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

-- The consolation roster is hand-picked by the director, so it needs its own
-- seeding independent of racers.seed, which belongs to the main bracket.
CREATE TABLE IF NOT EXISTS consolation_entrants (
  seed   INTEGER PRIMARY KEY,
  racer  INTEGER NOT NULL REFERENCES racers(id)
);

-- Director announcements. racer IS NULL means everyone; a set racer is a direct
-- message and must never reach the public state payload.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  racer       INTEGER REFERENCES racers(id),
  body        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archives (
  year                 INTEGER PRIMARY KEY,
  name                 TEXT    NOT NULL,
  archived_at          INTEGER NOT NULL,
  racer_count          INTEGER NOT NULL,
  champion             TEXT,
  runner_up            TEXT,
  third                TEXT,
  consolation_champion TEXT,
  schema_version       INTEGER NOT NULL,
  state                TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_order ON matches (order_index);
CREATE INDEX IF NOT EXISTS idx_results_log_id ON results_log (id);
CREATE INDEX IF NOT EXISTS idx_messages_racer ON messages (racer, id);
`;

/**
 * The bye sentinel's name_key and token start with a space. Registered names are
 * trimmed before keying, so no real racer can ever produce a key beginning with
 * whitespace — which makes these collision-proof without a magic string a guest
 * could accidentally type.
 */
const BYE_NAME_KEY = " bye";
const BYE_TOKEN = " bye-token";

let database: Database | null = null;

/**
 * CREATE TABLE IF NOT EXISTS leaves an existing table alone, so columns added
 * after the first deploy have to be bolted on here. Each entry is idempotent:
 * it looks at the live table and only adds what is missing.
 */
function migrate(handle: Database): void {
  const racerColumns = new Set(
    handle
      .query<{ name: string }, []>("PRAGMA table_info(racers)")
      .all()
      .map((column) => column.name),
  );

  for (const column of ["inspected_at", "paid_at"]) {
    if (!racerColumns.has(column)) {
      handle.exec(`ALTER TABLE racers ADD COLUMN ${column} INTEGER`);
    }
  }
}

export function db(): Database {
  if (database) {
    return database;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(PHOTOS_DIR, { recursive: true });

  const handle = new Database(DB_PATH, { create: true });

  // WAL survives an ungraceful shutdown far better than the rollback journal, which
  // matters when the event runs for hours on a machine nobody is watching.
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA synchronous = NORMAL");
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec(SCHEMA);
  migrate(handle);

  // A bye is a real row, not NULL. NULL means "not yet determined", and conflating
  // the two is a bug factory (DESIGN §5).
  handle
    .query(
      `INSERT INTO racers (id, name, name_key, token, created_at)
       VALUES (?, 'BYE', ?, ?, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(BYE_ID, BYE_NAME_KEY, BYE_TOKEN);

  handle
    .query(
      `INSERT INTO event (id, name, year, phase)
       VALUES (1, 'Hot Wheels Race', ?, 'registration')
       ON CONFLICT (id) DO NOTHING`,
    )
    .run(new Date().getFullYear());

  database = handle;
  return handle;
}

export function closeDb(): void {
  database?.close();
  database = null;
}

export type EventRow = {
  id: number;
  name: string;
  year: number;
  phase: "registration" | "racing" | "complete";
  bracket_size: number | null;
  current_match: number | null;
  consolation: number;
};

export type RacerRow = {
  id: number;
  name: string;
  name_key: string;
  token: string;
  photo: string | null;
  thumb: string | null;
  seed: number | null;
  created_at: number;
  inspected_at: number | null;
  paid_at: number | null;
};

export type MatchRow = {
  id: number;
  bracket: string;
  round: number;
  slot: number;
  a_racer: number | null;
  b_racer: number | null;
  a_source: string | null;
  b_source: string | null;
  winner: number | null;
  state: string;
  order_index: number;
};

export type EdgeRow = {
  from_match: number;
  outcome: string;
  to_match: number;
  to_slot: string;
};

export type ResultRow = {
  id: number;
  match_id: number;
  winner: number;
  created_at: number;
};

export type MessageRow = {
  id: number;
  racer: number | null;
  body: string;
  created_at: number;
};

export type ArchiveRow = {
  year: number;
  name: string;
  archived_at: number;
  racer_count: number;
  champion: string | null;
  runner_up: string | null;
  third: string | null;
  consolation_champion: string | null;
  schema_version: number;
  state: string;
};
