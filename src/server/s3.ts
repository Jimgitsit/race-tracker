/**
 * Everything that talks to S3: the live snapshot (snapshot.ts) and the yearly
 * archive backup below.
 *
 * Credentials come from the environment when set (Fly secrets), else from
 * ~/.aws/credentials — Bun's client does not read that file itself, and on the
 * Mac the AWS CLI is configured machine-wide with nothing in the environment.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";

import { PHOTOS_DIR, S3_BUCKET, S3_PREFIX, S3_REGION } from "../config.ts";

let client: Bun.S3Client | null | undefined;

function credentialsFromFile(): { accessKeyId: string; secretAccessKey: string } | null {
  let ini: string;
  try {
    ini = readFileSync(`${homedir()}/.aws/credentials`, "utf8");
  } catch {
    return null;
  }

  const read = (key: string) => ini.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"))?.[1]?.trim();
  const accessKeyId = read("aws_access_key_id");
  const secretAccessKey = read("aws_secret_access_key");
  if (!accessKeyId || !secretAccessKey) {
    return null;
  }
  return { accessKeyId, secretAccessKey };
}

/** null when no bucket is configured, so callers can no-op quietly. */
export function s3(): Bun.S3Client | null {
  if (client !== undefined) {
    return client;
  }
  if (!S3_BUCKET) {
    client = null;
    return client;
  }

  const fromEnv = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;
  const credentials = fromEnv
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      }
    : credentialsFromFile();

  if (!credentials) {
    console.log("S3: bucket set but no credentials found — backups off.");
    client = null;
    return client;
  }

  client = new Bun.S3Client({ bucket: S3_BUCKET, region: S3_REGION, ...credentials });
  return client;
}

export type BackupResult = {
  ok: boolean;
  uploaded: number;
  detail: string;
};

/**
 * Offsite copy of a finished year (DESIGN §9). Runs after the race is over and
 * never on the critical path — a failure is logged and retryable, and the local
 * archive is unaffected either way.
 */
export async function backupYear(year: number, archiveJson: string): Promise<BackupResult> {
  const bucket = s3();
  if (!bucket) {
    return {
      ok: false,
      uploaded: 0,
      detail: "No bucket configured — set RACE_TRACKER_S3_BUCKET to enable offsite backup.",
    };
  }

  const base = `${S3_PREFIX}/${year}`;
  let uploaded = 0;

  try {
    await bucket.write(`${base}/archive.json`, archiveJson, {
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
      await bucket.write(`${base}/photos/${name}`, file, { type: "image/jpeg" });
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
