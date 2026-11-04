import { randomBytes, createHash, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);

/** URL-safe random token (default 32 bytes ≈ 256 bits). Only its hash is stored. */
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, n, r, p, saltB64, keyB64] = stored.split("$");
  const expected = Buffer.from(keyB64, "base64");
  const key = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, { N: +n, r: +r, p: +p });
  return key.length === expected.length && timingSafeEqual(key, expected);
}
