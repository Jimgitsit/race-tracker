import { PHOTO_FULL_PX, PHOTO_QUALITY, PHOTO_THUMB_PX } from "../../shared/config.ts";

/**
 * Resize on the phone before uploading (DESIGN §8). A raw camera photo is 3–5 MB;
 * this makes it ~80 KB and ~10 KB, which is what keeps 30 people on one wifi from
 * fighting each other, and keeps the big screen from stalling on 30 downloads.
 */
async function scaleTo(bitmap: ImageBitmap, maxPx: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("This browser can't resize images.");
  }

  ctx.drawImage(bitmap, 0, 0, width, height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't process that photo."))),
      "image/jpeg",
      quality,
    );
  });
}

export async function preparePhoto(file: File): Promise<{ full: Blob; thumb: Blob }> {
  // `from-image` applies the EXIF rotation, so portrait phone shots aren't sideways.
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });

  try {
    const full = await scaleTo(bitmap, PHOTO_FULL_PX, PHOTO_QUALITY);
    const thumb = await scaleTo(bitmap, PHOTO_THUMB_PX, PHOTO_QUALITY);
    return { full, thumb };
  } finally {
    bitmap.close();
  }
}
