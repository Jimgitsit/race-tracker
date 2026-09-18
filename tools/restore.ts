/**
 * Emergency restore: pull the latest live snapshot from S3 into DATA_DIR.
 *
 *   bun run restore            # refuses if data/race.db already exists
 *   bun run restore --force    # moves the existing data aside first
 *
 * Stop the server before running this; SQLite will not like the swap under it.
 * Needs RACE_TRACKER_S3_BUCKET (and AWS credentials in the environment or
 * ~/.aws/credentials), exactly as the server does.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";

import { DATA_DIR, DB_PATH, PHOTOS_DIR, S3_BUCKET } from "../src/config.ts";
import { s3 } from "../src/server/s3.ts";
import { LIVE_PREFIX, type Manifest } from "../src/server/snapshot.ts";

const force = process.argv.includes("--force");

const bucket = s3();
if (!bucket) {
  console.error("No bucket or credentials. Set RACE_TRACKER_S3_BUCKET and AWS credentials.");
  process.exit(1);
}

if (existsSync(DB_PATH)) {
  if (!force) {
    console.error(`${DB_PATH} already exists. Re-run with --force to move it aside.`);
    process.exit(1);
  }
  const aside = `${DATA_DIR}/restore-aside-${Date.now()}`;
  mkdirSync(aside, { recursive: true });
  for (const name of ["race.db", "race.db-wal", "race.db-shm", "photos"]) {
    if (existsSync(`${DATA_DIR}/${name}`)) {
      renameSync(`${DATA_DIR}/${name}`, `${aside}/${name}`);
    }
  }
  console.log(`moved existing data to ${aside}/`);
}

const manifest = (await bucket.file(`${LIVE_PREFIX}/manifest.json`).json()) as Manifest;
console.log(
  `snapshot from ${new Date(manifest.at).toLocaleString()} in s3://${S3_BUCKET}/${LIVE_PREFIX}/`,
);

mkdirSync(DATA_DIR, { recursive: true });
await Bun.write(DB_PATH, bucket.file(manifest.db));
console.log(`wrote ${DB_PATH}`);

let count = 0;
for (const rel of manifest.photos) {
  const target = `${PHOTOS_DIR}/${rel}`;
  mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await Bun.write(target, bucket.file(`${LIVE_PREFIX}/photos/${rel}`));
  count += 1;
}
console.log(`wrote ${count} photo file${count === 1 ? "" : "s"} under ${PHOTOS_DIR}/`);
console.log("done — start the server.");
