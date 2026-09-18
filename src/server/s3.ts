/**
 * Offsite backup of a finished year (DESIGN §9).
 *
 * `data/` is gitignored and lives on one Mac's disk. Under a single-event design
 * losing it cost an afternoon; now it costs every year ever run, and the SQLite
 * data matters more than the photos do.
 *
 * This runs *after* the race is over and never on the critical path — a failure
 * is logged and retryable, and the local archive is unaffected either way.
 */
import { readdir } from "node:fs/promises";

import { PHOTOS_DIR, S3_BUCKET, S3_PREFIX, S3_REGION } from "../config.ts";

export type BackupResult = {
  ok: boolean;
  uploaded: number;
  detail: string;
};

export async function backupYear(year: number, archiveJson: string): Promise<BackupResult> {
  if (!S3_BUCKET) {
    return {
      ok: false,
      uploaded: 0,
      detail: "No bucket configured — set RACE_TRACKER_S3_BUCKET to enable offsite backup.",
    };
  }

  const client = new Bun.S3Client({ bucket: S3_BUCKET, region: S3_REGION });
  const base = `${S3_PREFIX}/${year}`;
  let uploaded = 0;

  try {
    await client.write(`${base}/archive.json`, archiveJson, {
      type: "application/json",
    });
    uploaded += 1;

    // The archive's own frozen copies, not the live year directory: the live one
    // is overwritten by the next race's uploads and may hold strays from wipes.
    const dir = `${PHOTOS_DIR}/archive/${year}`;
    let photos: string[] = [];
    try {
      photos = await readdir(dir);
    } catch {
      // A year with no uploaded photos is perfectly normal.
    }

    for (const name of photos) {
      if (!name.endsWith(".jpg")) {
        continue;
      }
      const file = Bun.file(`${dir}/${name}`);
      await client.write(`${base}/photos/${name}`, file, { type: "image/jpeg" });
      uploaded += 1;
    }

    return {
      ok: true,
      uploaded,
      detail: `s3://${S3_BUCKET}/${base}/ — ${uploaded} object${uploaded === 1 ? "" : "s"}`,
    };
  } catch (error) {
    return {
      ok: false,
      uploaded,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
