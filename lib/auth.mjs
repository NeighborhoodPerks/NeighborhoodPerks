// Accounts: admins, providers ("vendor") and homeowners ("customer").
// Sessions: random token in an HttpOnly cookie, only its hash in the database.
// A second, non-secret cookie (np_role) only tells the static pages which link to show
// in the header ("My account" / "Dashboard"); it grants nothing.
// One-time links (invites table) by purpose: 'invite' = set first password,
// 'reset' = forgot password, 'verify' = confirm email address.

import { db } from "./db.mjs";
import { newToken, sha256, hashPassword, verifyPassword } from "./crypto.mjs";
import { cookies, unauthorized, forbidden, bad, HttpError } from "./http.mjs";
import { rateLimit } from "./ratelimit.mjs";

const COOKIE = "np_session";
const ROLE_COOKIE = "np_role";
const SESSION_DAYS = 30;
const SITE = () => (process.env.SITE_URL || "https://neighborhoodperks.com").replace(/\/$/, "");
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==";

function cookie(name, value, maxAgeSec, httpOnly) {
  const secure = process.env.INSECURE_COOKIES === "1" ? "" : " Secure;";
  return `${name}=${value}; Path=/;${httpOnly ? " HttpOnly;" : ""}${secure} SameSite=Lax; Max-Age=${maxAgeSec}`;
}

async function startSession(userId, role) {
  const token = newToken();
  await db().query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS]);
  const age = SESSION_DAYS * 86400;
  return [cookie(COOKIE, token, age, true), cookie(ROLE_COOKIE, role, age, false)];
}

export function checkPassword(password) {
  if (typeof password !== "string" || password.length < 10) throw bad("Use at least 10 characters for your password.", "weak_password");
  if (password.length > 200) throw bad("That password is too long.");
}

export async function login(emailAddr, password, ip) {
  await rateLimit(`login:${ip}`, 20, 900);
  await rateLimit(`login:${emailAddr}`, 8, 900);
  const [u] = await db().query(
    `SELECT u.id, u.role, u.password_hash, v.active AS vendor_active, v.status AS vendor_status
       FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id WHERE lower(u.email) = lower($1)`, [emailAddr]);
  // Verify against a dummy hash when the user doesn't exist, so timing doesn't reveal which emails have accounts
  const ok = await verifyPassword(password, u?.password_hash || DUMMY_HASH);
  if (!u || !ok) throw new HttpError(401, "That email and password don't match.", "bad_login");
  if (u.role === "vendor" && !vendorMaySignIn(u)) {
    throw new HttpError(403, "This provider account isn't active. Call or text (619) 736-3618 if you think that's a mistake.", "vendor_inactive");
  }
  return { cookies: await startSession(u.id, u.role), role: u.role };
}

const vendorMaySignIn = (u) => u.vendor_active || u.vendor_status === "pending";

export async function logout(req) {
  const token = cookies(req)[COOKIE];
  if (token) await db().query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
  return [cookie(COOKIE, "", 0, true), cookie(ROLE_COOKIE, "", 0, false)];
}

export async function currentUser(req) {
  const token = cookies(req)[COOKIE];
  if (!token || token.length > 100) return null;
  const [u] = await db().query(
    `SELECT u.id, u.email, u.role, u.vendor_id, u.inbox_seen_at, u.name, u.phone, u.address, u.email_verified_at,
            v.name AS vendor_name, v.active AS vendor_active, v.status AS vendor_status
       FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN vendors v ON v.id = u.vendor_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  if (!u) return null;
  if (u.role === "vendor" && !vendorMaySignIn(u)) return null;
  return u;
}

export async function requireUser(req, roles) {
  const u = await currentUser(req);
  if (!u) throw unauthorized();
  if (roles && !roles.includes(u.role)) throw forbidden();
  return u;
}

const LINK_PATHS = { invite: "/vendor/invite/", reset: "/vendor/invite/", verify: "/account/verify/" };

/** One-time link. Creating one cancels any unused link of the same purpose for that user. */
export async function createInvite(userId, { purpose = "invite", days = 7 } = {}) {
  const token = newToken();
  await db().query(`UPDATE invites SET used_at = now() WHERE user_id = $1 AND used_at IS NULL AND purpose = $2`, [userId, purpose]);
  await db().query(
    `INSERT INTO invites (token_hash, user_id, expires_at, purpose) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [sha256(token), userId, days, purpose]);
  return `${SITE()}${LINK_PATHS[purpose]}?t=${token}`;
}

const EXPIRED = () => new HttpError(410, "This link has expired or was already used. You can ask for a new one from the sign-in page.", "invite_invalid");

export async function inviteInfo(token) {
  const [i] = await db().query(
    `SELECT u.email, u.role, i.purpose FROM invites i JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND i.purpose IN ('invite','reset')`,
    [sha256(String(token || ""))]
  );
  if (!i) throw EXPIRED();
  return i;
}

/** Set a password from an invite or reset link. Clicking the emailed link also proves the email address. */
export async function acceptInvite(token, password) {
  checkPassword(password);
  const hash = await hashPassword(password);
  const user = await db().tx(async (t) => {
    const [i] = await t.query(
      `SELECT i.user_id, u.role FROM invites i JOIN users u ON u.id = i.user_id
        WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND i.purpose IN ('invite','reset') FOR UPDATE OF i`,
      [sha256(String(token || ""))]
    );
    if (!i) throw EXPIRED();
    await t.query(`UPDATE invites SET used_at = now() WHERE token_hash = $1`, [sha256(token)]);
    await t.query(`UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [i.user_id, hash]);
    await t.query(`DELETE FROM sessions WHERE user_id = $1`, [i.user_id]); // a reset signs out other devices
    return i;
  });
  if (user.role === "customer") await claimGuestBookings(user.user_id);
  return { cookies: await startSession(user.user_id, user.role), role: user.role };
}

/** Confirm an email address from the link we sent. */
export async function verifyEmail(token) {
  const userId = await db().tx(async (t) => {
    const [i] = await t.query(
      `SELECT user_id FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND purpose = 'verify' FOR UPDATE`,
      [sha256(String(token || ""))]);
    if (!i) throw EXPIRED();
    await t.query(`UPDATE invites SET used_at = now() WHERE token_hash = $1`, [sha256(token)]);
    await t.query(`UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [i.user_id]);
    return i.user_id;
  });
  const linked = await claimGuestBookings(userId);
  return { ok: true, linked };
}

/**
 * Attach bookings made as a guest with this email to the account. Only ever called once the
 * person has proven they control the address, so nobody can read someone else's bookings.
 */
export async function claimGuestBookings(userId) {
  const rows = await db().query(
    `UPDATE bookings b SET customer_user_id = u.id FROM users u
      WHERE u.id = $1 AND u.role = 'customer' AND u.email_verified_at IS NOT NULL
        AND b.customer_user_id IS NULL AND lower(b.customer_email) = lower(u.email)
      RETURNING b.id`, [userId]);
  return rows.length;
}

export { startSession, hashPassword, verifyPassword, DUMMY_HASH };
