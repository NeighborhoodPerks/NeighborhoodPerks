// Accounts for vendors and admins. Customers never need one.
// Sessions: random token in an HttpOnly cookie, only its hash in the database.
// Accounts are created by invitation (admin sends a one-time link; the person sets a password).

import { db } from "./db.mjs";
import { newToken, sha256, hashPassword, verifyPassword } from "./crypto.mjs";
import { cookies, unauthorized, forbidden, bad, HttpError } from "./http.mjs";
import { rateLimit } from "./ratelimit.mjs";

const COOKIE = "np_session";
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const SITE = () => (process.env.SITE_URL || "https://www.neighborhoodperks.com").replace(/\/$/, "");

function sessionCookie(token, maxAgeSec) {
  const secure = process.env.INSECURE_COOKIES === "1" ? "" : " Secure;";
  return `${COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAgeSec}`;
}

async function startSession(userId) {
  const token = newToken();
  await db().query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS]);
  return sessionCookie(token, SESSION_DAYS * 86400);
}

export async function login(emailAddr, password, ip) {
  await rateLimit(`login:${ip}`, 20, 900);
  await rateLimit(`login:${emailAddr}`, 8, 900);
  const [u] = await db().query(`SELECT id, password_hash FROM users WHERE lower(email) = lower($1)`, [emailAddr]);
  // Verify against a dummy hash when the user doesn't exist, so timing doesn't reveal which emails have accounts
  const ok = await verifyPassword(password, u?.password_hash || "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
  if (!u || !ok) throw new HttpError(401, "That email and password don't match.", "bad_login");
  return startSession(u.id);
}

export async function logout(req) {
  const token = cookies(req)[COOKIE];
  if (token) await db().query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
  return sessionCookie("", 0);
}

export async function currentUser(req) {
  const token = cookies(req)[COOKIE];
  if (!token || token.length > 100) return null;
  const [u] = await db().query(
    `SELECT u.id, u.email, u.role, u.vendor_id, v.name AS vendor_name, v.active AS vendor_active
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN vendors v ON v.id = u.vendor_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  if (!u) return null;
  if (u.role === "vendor" && !u.vendor_active) return null;
  return u;
}

export async function requireUser(req, roles) {
  const u = await currentUser(req);
  if (!u) throw unauthorized();
  if (roles && !roles.includes(u.role)) throw forbidden();
  return u;
}

/** One-time link for a user to set (or reset) their password. */
export async function createInvite(userId) {
  const token = newToken();
  await db().query(`UPDATE invites SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await db().query(`INSERT INTO invites (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, INVITE_DAYS]);
  return `${SITE()}/vendor/invite/?t=${token}`;
}

export async function inviteInfo(token) {
  const [i] = await db().query(
    `SELECT u.email, u.role FROM invites i JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()`,
    [sha256(String(token || ""))]
  );
  if (!i) throw new HttpError(410, "This link has expired or was already used. Ask us for a new one.", "invite_invalid");
  return i;
}

export async function acceptInvite(token, password) {
  if (typeof password !== "string" || password.length < 10) throw bad("Use at least 10 characters for your password.", "weak_password");
  if (password.length > 200) throw bad("That password is too long.");
  const hash = await hashPassword(password);
  const userId = await db().tx(async (t) => {
    const [i] = await t.query(
      `SELECT user_id FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
      [sha256(String(token || ""))]
    );
    if (!i) throw new HttpError(410, "This link has expired or was already used. Ask us for a new one.", "invite_invalid");
    await t.query(`UPDATE invites SET used_at = now() WHERE token_hash = $1`, [sha256(token)]);
    await t.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [i.user_id, hash]);
    await t.query(`DELETE FROM sessions WHERE user_id = $1`, [i.user_id]); // a reset signs out other devices
    return i.user_id;
  });
  return startSession(userId);
}
