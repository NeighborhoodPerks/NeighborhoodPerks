// Vendor and admin operations: calendars, hours, time off, vendor setup.

import { db, isUniqueError } from "./db.mjs";
import { newToken } from "./crypto.mjs";
import { bad, conflict, notFound, forbidden, str, email as emailV, int, isoInstant } from "./http.mjs";
import { createInvite } from "./auth.mjs";
import { setVendorAreas, vendorAreas } from "./pros.mjs";

// --- calendar ----------------------------------------------------------------

export async function calendarEvents({ vendorId = null, from, to }) {
  const bookings = await db().query(
    `SELECT b.id, b.status, b.starts_at, b.ends_at, b.blocked_until, b.customer_name, b.customer_phone, b.customer_email,
            b.address, b.neighborhood, b.notes, b.price_cents, s.name AS service_name, s.slug AS service_slug,
            v.id AS vendor_id, v.name AS vendor_name
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id
      WHERE ($1::uuid IS NULL OR b.vendor_id = $1::uuid) AND b.starts_at < $3 AND b.ends_at > $2
      ORDER BY b.starts_at`,
    [vendorId, from, to]
  );
  const timeOff = await db().query(
    `SELECT t.id, t.starts_at, t.ends_at, t.note, v.id AS vendor_id, v.name AS vendor_name
       FROM time_off t JOIN vendors v ON v.id = t.vendor_id
      WHERE ($1::uuid IS NULL OR t.vendor_id = $1::uuid) AND t.starts_at < $3 AND t.ends_at > $2
      ORDER BY t.starts_at`,
    [vendorId, from, to]
  );
  return { bookings, timeOff };
}

/** A vendor may only touch their own bookings; admins may touch any. */
export async function assertBookingAccess(user, bookingId) {
  const [b] = await db().query(`SELECT vendor_id FROM bookings WHERE id = $1`, [bookingId]);
  if (!b) throw notFound("Booking not found.");
  if (user.role === "vendor" && b.vendor_id !== user.vendor_id) throw forbidden();
}

// --- weekly hours ------------------------------------------------------------

export async function getHours(vendorId) {
  const rules = await db().query(
    `SELECT weekday, to_char(start_time,'HH24:MI') AS start, to_char(end_time,'HH24:MI') AS end
       FROM availability_rules WHERE vendor_id = $1 ORDER BY weekday, start_time`,
    [vendorId]
  );
  const [v] = await db().query(`SELECT min_notice_min, max_days_ahead, slot_step_min, timezone FROM vendors WHERE id = $1`, [vendorId]);
  return { rules: rules.map((r) => ({ ...r, weekday: Number(r.weekday) })), settings: v };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function setHours(vendorId, body) {
  if (!Array.isArray(body.rules) || body.rules.length > 50) throw bad("Hours are missing.");
  const rules = body.rules.map((r) => {
    const weekday = int(r.weekday, "Day", { min: 1, max: 7 });
    if (!TIME_RE.test(r.start || "") || !TIME_RE.test(r.end || "")) throw bad("Times must look like 09:00.");
    if (r.end <= r.start) throw bad("Each block must end after it starts.", "invalid_hours");
    return { weekday, start: r.start, end: r.end };
  });
  // No overlapping blocks on the same day
  for (let d = 1; d <= 7; d++) {
    const day = rules.filter((r) => r.weekday === d).sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < day.length; i++) if (day[i].start < day[i - 1].end) throw bad("Two blocks on the same day overlap.", "overlapping_hours");
  }
  const s = body.settings || {};
  await db().tx(async (t) => {
    await t.query(`DELETE FROM availability_rules WHERE vendor_id = $1`, [vendorId]);
    for (const r of rules) {
      await t.query(`INSERT INTO availability_rules (vendor_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)`,
        [vendorId, r.weekday, r.start, r.end]);
    }
    if (body.settings) {
      await t.query(`UPDATE vendors SET min_notice_min = $2, max_days_ahead = $3, slot_step_min = $4 WHERE id = $1`, [
        vendorId,
        int(s.min_notice_min, "Notice", { min: 0, max: 20160 }),
        int(s.max_days_ahead, "Booking window", { min: 1, max: 365 }),
        [15, 30, 60].includes(Number(s.slot_step_min)) ? Number(s.slot_step_min) : 30,
      ]);
    }
  });
  return getHours(vendorId);
}

// --- time off ----------------------------------------------------------------

export async function addTimeOff(vendorId, body) {
  const start = isoInstant(body.start, "Start");
  const end = isoInstant(body.end, "End");
  if (end <= start) throw bad("Time off must end after it starts.");
  if (end - start > 366 * 86400_000) throw bad("Time off can be at most a year at a time.");
  const note = str(body.note, "Note", { optional: true, max: 200 });
  const clashes = await db().query(
    `SELECT count(*)::int AS n FROM bookings WHERE vendor_id = $1 AND status = 'confirmed' AND starts_at < $3 AND blocked_until > $2`,
    [vendorId, start, end]
  );
  if (clashes[0].n && !body.force) {
    throw conflict(`You have ${clashes[0].n} booking${clashes[0].n > 1 ? "s" : ""} in that time. Move or cancel ${clashes[0].n > 1 ? "them" : "it"} first, or block the time anyway.`, "has_bookings");
  }
  const [row] = await db().query(
    `INSERT INTO time_off (vendor_id, starts_at, ends_at, note) VALUES ($1,$2,$3,$4) RETURNING id, starts_at, ends_at, note`,
    [vendorId, start, end, note]
  );
  return row;
}

export async function deleteTimeOff(user, id) {
  const [row] = await db().query(
    `DELETE FROM time_off WHERE id = $1 AND ($2::uuid IS NULL OR vendor_id = $2::uuid) RETURNING id`,
    [id, user.role === "vendor" ? user.vendor_id : null]
  );
  if (!row) throw notFound("Time off not found.");
  return { ok: true };
}

// --- services a vendor offers --------------------------------------------------

export async function vendorServices(vendorId) {
  return db().query(
    `SELECT s.slug, s.name, vs.duration_min, vs.buffer_min, vs.price_cents, vs.active
       FROM vendor_services vs JOIN services s ON s.id = vs.service_id WHERE vs.vendor_id = $1 ORDER BY s.sort`,
    [vendorId]
  );
}

export async function setVendorService(vendorId, body, { canPrice }) {
  const [s] = await db().query(`SELECT id FROM services WHERE slug = $1`, [str(body.service, "Service", { max: 80 })]);
  if (!s) throw notFound("Unknown service.");
  const duration = int(body.duration_min, "Duration", { min: 15, max: 720 });
  const buffer = int(body.buffer_min ?? 15, "Buffer", { min: 0, max: 240 });
  const active = body.active !== false;
  if (canPrice) {
    const price = body.price_cents === null || body.price_cents === "" || body.price_cents === undefined
      ? null : int(body.price_cents, "Price", { min: 0, max: 10_000_000 });
    await db().query(
      `INSERT INTO vendor_services (vendor_id, service_id, duration_min, buffer_min, price_cents, active) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (vendor_id, service_id) DO UPDATE SET duration_min = $3, buffer_min = $4, price_cents = $5, active = $6`,
      [vendorId, s.id, duration, buffer, price, active]
    );
  } else {
    const rows = await db().query(
      `UPDATE vendor_services SET duration_min = $3, buffer_min = $4, active = $5 WHERE vendor_id = $1 AND service_id = $2 RETURNING 1`,
      [vendorId, s.id, duration, buffer, active]
    );
    if (!rows.length) throw forbidden();
  }
  return vendorServices(vendorId);
}

// --- admin: vendors -----------------------------------------------------------

export async function listVendors() {
  const vendors = await db().query(
    `SELECT v.id, v.name, v.business_name, v.email, v.phone, v.active, v.status, v.created_at,
            (u.password_hash IS NOT NULL) AS has_password
       FROM vendors v LEFT JOIN users u ON u.vendor_id = v.id
      ORDER BY (v.status = 'pending') DESC, v.active DESC, v.name`
  );
  for (const v of vendors) { v.services = await vendorServices(v.id); v.areas = await vendorAreas(v.id); }
  return vendors;
}

export async function createVendor(body) {
  const name = str(body.name, "Name", { max: 120 });
  const business = str(body.business_name, "Business name", { optional: true, max: 160 });
  const addr = emailV(body.email);
  const phoneNum = str(body.phone, "Phone", { optional: true, max: 40 });
  try {
    const { vendorId, userId } = await db().tx(async (t) => {
      const [v] = await t.query(
        `INSERT INTO vendors (name, business_name, email, phone, ics_token) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [name, business, addr, phoneNum, newToken(18)]
      );
      const [u] = await t.query(`INSERT INTO users (email, role, vendor_id) VALUES ($1,'vendor',$2) RETURNING id`, [addr, v.id]);
      // Sensible starting hours the vendor can change: Mon–Fri 9–5
      for (let d = 1; d <= 5; d++) {
        await t.query(`INSERT INTO availability_rules (vendor_id, weekday, start_time, end_time) VALUES ($1,$2,'09:00','17:00')`, [v.id, d]);
      }
      return { vendorId: v.id, userId: u.id };
    });
    for (const svc of Array.isArray(body.services) ? body.services : []) {
      await setVendorService(vendorId, svc, { canPrice: true });
    }
    if (Array.isArray(body.areas) && body.areas.length) await setVendorAreas(vendorId, body.areas);
    return { id: vendorId, inviteUrl: await createInvite(userId) };
  } catch (err) {
    if (isUniqueError(err)) throw conflict("Someone with that email is already set up.", "email_taken");
    throw err;
  }
}

export async function updateVendor(id, body) {
  const fields = [];
  const vals = [id];
  const set = (col, v) => { vals.push(v); fields.push(`${col} = $${vals.length}`); };
  if ("name" in body) set("name", str(body.name, "Name", { max: 120 }));
  if ("business_name" in body) set("business_name", str(body.business_name, "Business name", { optional: true, max: 160 }));
  if ("phone" in body) set("phone", str(body.phone, "Phone", { optional: true, max: 40 }));
  if ("active" in body) {
    const [cur] = await db().query(`SELECT status FROM vendors WHERE id = $1`, [id]);
    if (cur && cur.status !== "approved" && body.active === true) throw conflict("Approve this provider first.", "not_approved");
    set("active", body.active === true);
  }
  if (!fields.length) throw bad("Nothing to change.");
  const rows = await db().query(`UPDATE vendors SET ${fields.join(", ")} WHERE id = $1 RETURNING id`, vals);
  if (!rows.length) throw notFound("Vendor not found.");
  return { ok: true };
}

export async function vendorInvite(vendorId) {
  const [u] = await db().query(`SELECT id FROM users WHERE vendor_id = $1`, [vendorId]);
  if (!u) throw notFound("Vendor not found.");
  return { inviteUrl: await createInvite(u.id) };
}

export async function vendorIcsUrl(vendorId, { rotate = false } = {}) {
  if (rotate) await db().query(`UPDATE vendors SET ics_token = $2 WHERE id = $1`, [vendorId, newToken(18)]);
  const [v] = await db().query(`SELECT ics_token FROM vendors WHERE id = $1`, [vendorId]);
  const site = (process.env.SITE_URL || "https://neighborhoodperks.com").replace(/\/$/, "");
  return { url: `${site}/ics/${v.ics_token}.ics` };
}

// --- admin: services ----------------------------------------------------------

export async function listServices() {
  return db().query(`SELECT slug, name, active, sort FROM services ORDER BY sort, name`);
}

export async function upsertService(body) {
  const name = str(body.name, "Name", { max: 80 });
  const slug = (body.slug ? str(body.slug, "Slug", { max: 80 }) : name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw bad("Name is required.");
  await db().query(
    `INSERT INTO services (slug, name, active, sort) VALUES ($1,$2,$3,$4)
     ON CONFLICT (slug) DO UPDATE SET name = $2, active = $3, sort = $4`,
    [slug, name, body.active !== false, Number.isInteger(body.sort) ? body.sort : 100]
  );
  return listServices();
}
