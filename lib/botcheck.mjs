// Bot defenses for the public sign-up forms.
// Bots were creating pending provider accounts (random-letter names, "Xxxx LLC", strangers' email
// addresses) so that our site would email those strangers. Each check below is cheap and invisible to
// people: a hidden field only bots fill in, a form token that must be at least a few seconds old, and
// the tell-tale names and addresses those bots use. A caught bot is answered like a success, with no
// account and no email, so it learns nothing.

import { db } from "./db.mjs";
import { newToken, sha256 } from "./crypto.mjs";
import { bad } from "./http.mjs";
import { rateLimit } from "./ratelimit.mjs";

const MIN_SECONDS = () => Number(process.env.BOT_MIN_FORM_SECONDS ?? 3);
const MAX_AGE_SECONDS = 24 * 3600;
// Email-to-text gateways: no one signs up for an account with one of these
const SMS_GATEWAYS = /@(txt\.att\.net|mms\.att\.net|vtext\.com|vzwpix\.com|tmomail\.net|messaging\.sprintpcs\.com|pm\.sprint\.com|msg\.fi\.google\.com)$/i;

/** A one-time token the sign-up page fetches when it loads. */
export async function issueFormToken(ip) {
  await rateLimit(`formtoken:${ip}`, 60, 3600);
  const token = newToken(18);
  await db().query(`INSERT INTO form_tokens (token_hash) VALUES ($1)`, [sha256(token)]);
  await db().query(`DELETE FROM form_tokens WHERE created_at < now() - make_interval(secs => $1)`, [MAX_AGE_SECONDS]);
  return { token };
}

/** Spend the token once the account exists, so it can't be replayed. */
export async function spendFormToken(token) {
  if (typeof token === "string" && token) await db().query(`DELETE FROM form_tokens WHERE token_hash = $1`, [sha256(token)]);
}

/** A word like "QCyTVXzNIlvAljMpYRdOAQkn": long, letters only, capitals scattered through it (not a name typed in caps). */
export function looksRandom(s) {
  return String(s || "").trim().split(/\s+/).some((w) => {
    if (!/^[A-Za-z]{12,}$/.test(w)) return false;
    const caps = (w.match(/[A-Z]/g) || []).length;
    return (w.slice(1).match(/[A-Z]/g) || []).length >= 3 && caps / w.length <= 0.8;
  });
}

/** "p.oe..he.il.b.r.on.n.e.r@gmail.com": Gmail ignores dots, so bots pad real addresses with them. */
export function suspiciousEmail(addr) {
  const a = String(addr || "").toLowerCase();
  const [local = "", domain = ""] = a.split("@");
  if (local.includes("..") || local.startsWith(".") || local.endsWith(".")) return true;
  if (/^(gmail|googlemail)\.com$/.test(domain) && (local.match(/\./g) || []).length >= 3) return true;
  return SMS_GATEWAYS.test(a);
}

/**
 * Null when the sign-up looks human; otherwise the reason (for the logs only).
 * Throws a visible error only when a real person could hit it: a missing or expired form token.
 */
export async function botReason(body) {
  if (body.website) return "honeypot";
  if (process.env.REQUIRE_FORM_TOKEN !== "0") {
    if (typeof body.form_token !== "string" || !body.form_token || body.form_token.length > 100) {
      throw bad("Please refresh the page and try again.", "form_token");
    }
    const [t] = await db().query(
      `SELECT extract(epoch FROM now() - created_at)::float AS age FROM form_tokens WHERE token_hash = $1`, [sha256(body.form_token)]);
    if (!t || t.age > MAX_AGE_SECONDS) throw bad("This page has been open a while. Please refresh it and try again.", "form_token");
    if (t.age < MIN_SECONDS()) return "too_fast";
  }
  if (looksRandom(body.name) || looksRandom(body.business_name)) return "random_name";
  if (suspiciousEmail(body.email)) return "suspicious_email";
  return null;
}
