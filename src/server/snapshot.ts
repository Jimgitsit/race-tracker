/**
 * Live snapshot to S3 (DESIGN §9). The Mac, or the Fly machine, is the only
 * copy of the event while it runs; this keeps a second copy seconds behind it
 * so "the box died" means a restore, not a lost party.
 *
 * Every mutation schedules a snapshot; a burst of heats collapses into one
 * upload a few seconds after the last. A snapshot is a consistent copy of the
 * database (VACUUM INTO, so WAL contents are included) plus any photo file
 * not yet uploaded, and a manifest naming them all so a restore needs no
 * bucket listing. `bun run restore` is the other half.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";

import { DATA_DIR, PHOTOS_DIR, S3_BUCKET, S3_PREFIX } from "../config.ts";
import { db } from "./db.ts";
import { s3 } from "./s3.ts";

/** How long after the last change to wait before uploading. */
const SETTLE_MS = 4000;
/** Take one anyway this often, in case a change ever slipped past the hook. */
const FLOOR_MS = 15 * 60 * 1000;

export const LIVE_PREFIX = `${S3_PREFIX}/live`;

export type Manifest = {
  at: number;
  db: string;
  photos: string[];
};

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let dirty = false;
const uploaded = new Map<string, string>();

export type SnapshotStatus = {
  enabled: boolean;
  lastAt: number | null;
  lastError: string | null;
};

const status: SnapshotStatus = { enabled: false, lastAt: null, lastError: null };

export function snapshotStatus(): SnapshotStatus {
  return { ...status };
}

export function scheduleSnapshot(): void {
  if (!s3()) {
    return;
  }
  if (timer !== null) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    void takeSnapshot();
  }, SETTLE_MS);
}

export function startSnapshots(): void {
  if (!s3()) {
    console.log("snapshots: off (no bucket or credentials)");
    return;
  }
  status.enabled = true;
  console.log(`snapshots: on → s3://${S3_BUCKET}/${LIVE_PREFIX}/`);
  void takeSnapshot();
  setInterval(() => void takeSnapshot(), FLOOR_MS);
}

/** Every photo file under PHOTOS_DIR, as paths relative to it, with a change key. */
function photoFiles(): { rel: string; key: string }[] {
  const out: { rel: string; key: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) {
      return;
    }
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`;
      const rel = prefix ? `${prefix}/${name}` : name;
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full, rel);
      } else if (name.endsWith(".jpg")) {
        out.push({ rel, key: `${info.size}:${info.mtimeMs}` });
      }
    }
  };
  walk(PHOTOS_DIR, "");
  return out;
}

export async function takeSnapshot(): Promise<void> {
  const bucket = s3();
  if (!bucket) {
    return;
  }
  if (running) {
    dirty = true;
    return;
  }
  running = true;

  const tmpDir = `${DATA_DIR}/tmp`;
  const tmp = `${tmpDir}/snapshot.db`;

  try {
    mkdirSync(tmpDir, { recursive: true });
    rmSync(tmp, { force: true });
    db().exec(`VACUUM INTO '${tmp}'`);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dbKey = `${LIVE_PREFIX}/race.db`;
    await bucket.write(dbKey, Bun.file(tmp), { type: "application/octet-stream" });
    await bucket.write(`${LIVE_PREFIX}/history/race-${stamp}.db`, Bun.file(tmp), {
      type: "application/octet-stream",
    });

    const photos = photoFiles();
    let sent = 0;
    for (const { rel, key } of photos) {
      if (uploaded.get(rel) === key) {
        continue;
      }
      await bucket.write(`${LIVE_PREFIX}/photos/${rel}`, Bun.file(`${PHOTOS_DIR}/${rel}`), {
        type: "image/jpeg",
      });
      uploaded.set(rel, key);
      sent += 1;
    }

    const manifest: Manifest = {
      at: Date.now(),
      db: dbKey,
      photos: photos.map((p) => p.rel),
    };
    await bucket.write(`${LIVE_PREFIX}/manifest.json`, JSON.stringify(manifest), {
      type: "application/json",
    });

    status.lastAt = manifest.at;
    status.lastError = null;
    console.log(`snapshot: db + ${sent} new photo${sent === 1 ? "" : "s"} → ${dbKey}`);
  } catch (error) {
    status.lastError = error instanceof Error ? error.message : String(error);
    console.log(`snapshot failed: ${status.lastError}`);
  } finally {
    rmSync(tmp, { force: true });
    running = false;
    if (dirty) {
      dirty = false;
      scheduleSnapshot();
    }
  }
}
