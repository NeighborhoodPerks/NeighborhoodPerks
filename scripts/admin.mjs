// Create an admin account (or a fresh sign-in link for an existing one).
//   DATABASE_URL=... SITE_URL=https://neighborhoodperks.com node scripts/admin.mjs you@example.com
// Prints a one-time link where the admin sets their password.
import { db } from "../lib/db.mjs";
import { createInvite } from "../lib/auth.mjs";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: node scripts/admin.mjs you@example.com");
  process.exit(1);
}
let [u] = await db().query(`SELECT id, role FROM users WHERE lower(email) = $1`, [email]);
if (u && u.role !== "admin") {
  console.error(`${email} is a vendor account, not an admin. Use a different email.`);
  process.exit(1);
}
if (!u) [u] = await db().query(`INSERT INTO users (email, role) VALUES ($1, 'admin') RETURNING id`, [email]);
console.log(`Admin sign-in link for ${email} (valid 7 days, works once):\n${await createInvite(u.id)}`);
