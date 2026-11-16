// Uploaded images arrive as data URLs, already resized in the browser.
import { bad } from "./http.mjs";

/** Decode a JPG/PNG/WebP data URL and check the bytes really are that kind of image. */
export function imageFromDataUrl(dataUrl, { maxBytes, tooLarge }) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw bad("Please choose a JPG, PNG or WebP image.", "invalid_photo");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > maxBytes) throw bad(tooLarge, "photo_too_large");
  // Check the file really is the image type it claims (magic bytes)
  const sig = buf.subarray(0, 12).toString("hex");
  const ok = (m[1] === "image/jpeg" && sig.startsWith("ffd8ff")) || (m[1] === "image/png" && sig.startsWith("89504e47")) ||
    (m[1] === "image/webp" && sig.startsWith("52494646") && buf.subarray(8, 12).toString() === "WEBP");
  if (!ok) throw bad("That file isn't a valid image.", "invalid_photo");
  return { mime: m[1], data: buf };
}
