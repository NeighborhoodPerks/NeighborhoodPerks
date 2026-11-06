// Self-service accounts: homeowner and provider sign-up, password reset, email verification,
// a homeowner's own bookings and profile, and admin approval of provider sign-ups.

import { db, isUniqueError } from "./db.mjs";
import { newToken } from "./crypto.mjs";
import { bad, conflict, notFound, forbidden, str, email as emailV, phone as phoneV } from "./http.mjs";
import { rateLimit } from "./ratelimit.mjs";
import { startSession, checkPassword, hashPassword, createInvite } from "./auth.mjs";
import { setVendorAreas } from "./pros.mjs";
import { sendEmail } from "./notify.mjs";

const SITE = () => (process.env.SITE_URL || "https://neighborhoodperks.com").replace(/\/$/, "");
const PHONE = () => process.env.BUSINESS_PHONE || "(619) 736-3618";
const taken = () => conflict("There's already an account with that email. Try signing in, or use “Forgot password?”.", "email_taken");

// --- homeowners -------------------------------------------------------------------

export async function signupCustomer(body, ip) {
  await rateLimit(`signup:${ip}`, 10, 3600);
  const name = str(body.name, "Name", { max: 120 });
  const addr = emailV(body.email);
  checkPassword(body.password);
  const phone = body.phone ? phoneV(body.phone) : null;
  const hash = await hashPassword(body.password);
  let user;
  try {
    [user] = await db().query(
      `INSERT INTO users (email, role, password_hash, name, phone) VALUES ($1, 'customer', $2, $3, $4) RETURNING id`,
      [addr, hash, name, phone]);
  } catch (err) {
    if (isUniqueError(err)) throw taken();
    throw err;
  }
  await sendVerification(user.id, addr, name);
  return { cookies: await startSession(user.id, "customer"), role: "customer" };
}

async function sendVerification(userId, addr, name) {
  const link = await createInvite(userId, { purpose: "verify", days: 7 });
  await sendEmail({
    to: addr,
    subject: "Confirm your email for Neighborhood Perks",
    text: [`Hi ${name || "there"},`, "", "Thanks for creating a Neighborhood Perks account. Please confirm your email:", link, "",
      "Once it's confirmed, any bookings you made with this email before signing up will show up in your account too.", "", "Neighborhood Perks"].join("\n"),
  });
}

export async function resendVerification(user) {
  if (user.email_verified_at) return { ok: true, already: true };
  await rateLimit(`verify:${user.id}`, 5, 3600);
  await sendVerification(user.id, user.email, user.name);
  return { ok: true };
}

export async function forgotPassword(body, ip) {
  await rateLimit(`forgot:${ip}`, 10, 3600);
  const addr = emailV(body.email);
  await rateLimit(`forgot:${addr}`, 3, 3600);
  const [u] = await db().query(`SELECT id, name, role FROM users WHERE lower(email) = lower($1)`, [addr]);
  if (u) {
    const link = await createInvite(u.id, { purpose: "reset", days: 1 });
    await sendEmail({
      to: addr,
      subject: "Reset your Neighborhood Perks password",
      text: [`Hi ${u.name || "there"},`, "", "Use this link to choose a new password. It works once and expires in 24 hours:", link, "",
        "If you didn't ask for this, you can ignore this email.", "", "Neighborhood Perks"].join("\n"),
    });
  }
  // Same answer either way, so this can't be used to find out who has an account
  return { ok: true };
}

export async function customerProfile(user) {
  const [u] = await db().query(
    `SELECT u.email, u.name, u.phone, u.address, u.email_verified_at, a.slug AS area,
            c.name AS community_name, c.join_code AS community_code, ca.slug AS community_area, ca.name AS community_area_name
       FROM users u LEFT JOIN areas a ON a.id = u.area_id
       LEFT JOIN communities c ON c.id = u.community_id AND c.active LEFT JOIN areas ca ON ca.id = c.area_id
      WHERE u.id = $1`, [user.id]);
  return u;
}

export async function updateCustomerProfile(user, body) {
  const name = str(body.name, "Name", { max: 120 });
  const phone = body.phone ? phoneV(body.phone) : null;
  const address = str(body.address, "Address", { optional: true, max: 240 });
  let areaId = null;
  if (body.area) {
    const [a] = await db().query(`SELECT id FROM areas WHERE slug = $1 AND active`, [String(body.area)]);
    if (!a) throw bad("Unknown neighborhood.", "invalid_area");
    areaId = a.id;
  }
  await db().query(`UPDATE users SET name = $2, phone = $3, address = $4, area_id = $5 WHERE id = $1`, [user.id, name, phone, address, areaId]);
  return customerProfile(user);
}

export async function customerBookings(user) {
  return db().query(
    `SELECT b.id, b.status, b.starts_at, b.ends_at, b.address, b.notes, b.price_cents,
            b.payment_status, b.amount_charged_cents, b.amount_refunded_cents, b.paid_at,
            CASE WHEN b.tip_status = 'paid' THEN b.tip_cents END AS tip_cents,
            s.slug AS service_slug, s.name AS service_name,
            v.id AS vendor_id, v.name AS vendor_name, v.business_name AS vendor_business, v.phone AS vendor_phone,
            v.photo_version AS vendor_photo_version
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id
      WHERE b.customer_user_id = $1
      ORDER BY (b.status = 'confirmed' AND b.starts_at > now()) DESC,
               CASE WHEN b.status = 'confirmed' AND b.starts_at > now() THEN b.starts_at END ASC,
               b.starts_at DESC
      LIMIT 200`, [user.id]);
}

export async function assertCustomerBooking(user, bookingId) {
  const [b] = await db().query(`SELECT customer_user_id FROM bookings WHERE id = $1`, [bookingId]);
  if (!b) throw notFound("Booking not found.");
  if (b.customer_user_id !== user.id) throw forbidden();
}

// --- providers ----------------------------------------------------------------------

export async function signupProvider(body, ip) {
  await rateLimit(`signup:${ip}`, 10, 3600);
  const name = str(body.name, "Your name", { max: 120 });
  const business = str(body.business_name, "Business name", { optional: true, max: 160 });
  const addr = emailV(body.email);
  const phone = phoneV(body.phone);
  checkPassword(body.password);
  const services = Array.isArray(body.services) ? body.services.map(String).slice(0, 30) : [];
  const areas = Array.isArray(body.areas) ? body.areas.map(String).slice(0, 50) : [];
  if (!services.length) throw bad("Choose at least one service you offer.", "no_services");
  if (!areas.length) throw bad("Choose at least one neighborhood you work in.", "no_areas");
  const notes = str(body.notes, "Notes", { optional: true, max: 1000 });
  const hash = await hashPassword(body.password);

  const known = await db().query(`SELECT id, slug FROM services WHERE slug = ANY($1::text[]) AND active`, [services]);
  if (known.length !== new Set(services).size) throw bad("Unknown service.", "invalid_service");

  let ids;
  try {
    ids = await db().tx(async (t) => {
      const [v] = await t.query(
        `INSERT INTO vendors (name, business_name, email, phone, bio, ics_token, active, status)
         VALUES ($1,$2,$3,$4,$5,$6,false,'pending') RETURNING id`,
        [name, business, addr, phone, null, newToken(18)]);
      const [u] = await t.query(`INSERT INTO users (email, role, vendor_id, password_hash, name, phone) VALUES ($1,'vendor',$2,$3,$4,$5) RETURNING id`,
        [addr, v.id, hash, name, phone]);
      for (let d = 1; d <= 5; d++) {
        await t.query(`INSERT INTO availability_rules (vendor_id, weekday, start_time, end_time) VALUES ($1,$2,'09:00','17:00')`, [v.id, d]);
      }
      for (const s of known) {
        // Sensible starting point; the provider adjusts job length in their dashboard, we set prices on approval
        await t.query(`INSERT INTO vendor_services (vendor_id, service_id, duration_min, buffer_min, price_cents) VALUES ($1,$2,60,15,NULL)`, [v.id, s.id]);
      }
      return { vendorId: v.id, userId: u.id };
    });
  } catch (err) {
    if (isUniqueError(err)) throw taken();
    throw err;
  }
  await setVendorAreas(ids.vendorId, areas);

  await sendEmail({
    to: addr,
    subject: "We got your Neighborhood Perks application",
    text: [`Hi ${name.split(" ")[0]},`, "", "Thanks for applying to join Neighborhood Perks. We'll review your application and get back to you soon.",
      "Meanwhile you can sign in to set up your profile, photo, hours and services, so you're ready to take bookings the moment you're approved:",
      `${SITE()}/vendor/`, "", `Questions? Call or text ${PHONE()}.`, "", "Neighborhood Perks"].join("\n"),
  });
  const admins = await db().query(`SELECT email FROM users WHERE role = 'admin'`);
  for (const a of admins) {
    await sendEmail({
      to: a.email,
      subject: `New provider application: ${business || name}`,
      text: [`${name}${business ? ` (${business})` : ""} applied to join.`, `Email: ${addr}`, `Phone: ${phone}`,
        `Services: ${known.map((s) => s.slug).join(", ")}`, `Neighborhoods: ${areas.join(", ")}`, notes ? `Notes: ${notes}` : null, "",
        `Review it: ${SITE()}/vendor/ → Providers`].filter((l) => l !== null).join("\n"),
    });
  }
  return { cookies: await startSession(ids.userId, "vendor"), role: "vendor" };
}

export async function approveVendor(vendorId) {
  const [v] = await db().query(
    `UPDATE vendors SET status = 'approved', active = true WHERE id = $1 RETURNING name, email`, [vendorId]);
  if (!v) throw notFound("Provider not found.");
  await sendEmail({
    to: v.email,
    subject: "You're approved on Neighborhood Perks",
    text: [`Hi ${v.name.split(" ")[0]},`, "", "Good news: you're approved. Homeowners in your neighborhoods can now see your profile and book your open times.",
      "Check your hours and services are right here:", `${SITE()}/vendor/`, "", "Neighborhood Perks"].join("\n"),
  });
  return { ok: true };
}

export async function declineVendor(vendorId) {
  const [v] = await db().query(`UPDATE vendors SET status = 'declined', active = false WHERE id = $1 RETURNING id`, [vendorId]);
  if (!v) throw notFound("Provider not found.");
  await db().query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE vendor_id = $1)`, [vendorId]);
  return { ok: true };
}
