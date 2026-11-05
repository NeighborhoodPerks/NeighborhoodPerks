// Marketplace side: areas, provider listings and public profiles, photos, provider inbox.

import { DateTime } from "luxon";
import { db } from "./db.mjs";
import { generateSlots } from "./availability.mjs";
import { BUSINESS_TZ } from "./bookings.mjs";
import { bad, notFound, str, int } from "./http.mjs";
import { paymentsEnabled } from "./payments.mjs";

// --- areas ----------------------------------------------------------------------

export async function listAreas({ all = false } = {}) {
  return db().query(`SELECT slug, name, zips, active FROM areas WHERE ($1 OR active) ORDER BY sort, name`, [all]);
}

/** Areas matching a neighborhood slug or a 5-digit ZIP. */
export async function findAreas(q) {
  const s = String(q || "").trim().toLowerCase();
  if (/^\d{5}$/.test(s)) return db().query(`SELECT slug, name, zips FROM areas WHERE active AND $1 = ANY(zips) ORDER BY sort, name`, [s]);
  return db().query(`SELECT slug, name, zips FROM areas WHERE active AND slug = $1`, [s]);
}

export async function upsertArea(body) {
  const name = str(body.name, "Name", { max: 80 });
  const slug = (body.slug ? String(body.slug) : name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw bad("Name is required.");
  const zips = (Array.isArray(body.zips) ? body.zips : String(body.zips || "").split(/[\s,]+/)).map((z) => String(z).trim()).filter(Boolean);
  if (zips.some((z) => !/^\d{5}$/.test(z))) throw bad("ZIP codes must be 5 digits, separated by commas.", "invalid_zip");
  await db().query(
    `INSERT INTO areas (slug, name, zips, active, sort) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (slug) DO UPDATE SET name = $2, zips = $3, active = $4, sort = $5`,
    [slug, name, zips, body.active !== false, Number.isInteger(body.sort) ? body.sort : 100]
  );
  return listAreas({ all: true });
}

export async function vendorAreas(vendorId) {
  const rows = await db().query(`SELECT a.slug FROM vendor_areas va JOIN areas a ON a.id = va.area_id WHERE va.vendor_id = $1`, [vendorId]);
  return rows.map((r) => r.slug);
}

export async function setVendorAreas(vendorId, slugs) {
  if (!Array.isArray(slugs) || slugs.length > 100) throw bad("Choose the areas you work in.");
  const areas = await db().query(`SELECT id, slug FROM areas WHERE slug = ANY($1::text[])`, [slugs.map(String)]);
  if (areas.length !== new Set(slugs).size) throw bad("Unknown area.", "invalid_area");
  await db().tx(async (t) => {
    await t.query(`DELETE FROM vendor_areas WHERE vendor_id = $1`, [vendorId]);
    for (const a of areas) await t.query(`INSERT INTO vendor_areas (vendor_id, area_id) VALUES ($1,$2)`, [vendorId, a.id]);
  });
  return vendorAreas(vendorId);
}

// --- provider listings ----------------------------------------------------------

const photoUrl = (v) => (v.photo_version ? `/api/pros/${v.id}/photo?v=${v.photo_version}` : null);

/**
 * Providers who serve an area, with their services and the soonest open time.
 * Sorted: soonest availability first, then name.
 */
export async function listPros({ areaSlug, serviceSlug = null, now = new Date(), lookaheadDays = 21 }) {
  const [area] = await db().query(`SELECT id, slug, name FROM areas WHERE slug = $1 AND active`, [areaSlug]);
  if (!area) throw notFound("We don't serve that area yet.");
  const rows = await db().query(
    `SELECT v.id, v.name, v.business_name, v.bio, v.photo_version, v.timezone, v.min_notice_min, v.max_days_ahead, v.slot_step_min,
            s.slug AS service_slug, s.name AS service_name, s.sort, vs.duration_min, vs.buffer_min, vs.price_cents
       FROM vendors v
       JOIN vendor_areas va ON va.vendor_id = v.id AND va.area_id = $1
       JOIN vendor_services vs ON vs.vendor_id = v.id AND vs.active
       JOIN services s ON s.id = vs.service_id AND s.active
      WHERE v.active AND ($2::text IS NULL OR s.slug = $2) AND (NOT $3::boolean OR v.stripe_charges_enabled)
      ORDER BY v.name, s.sort`,
    [area.id, serviceSlug, paymentsEnabled()]
  );
  const byVendor = new Map();
  for (const r of rows) {
    if (!byVendor.has(r.id)) byVendor.set(r.id, { ...r, services: [] });
    byVendor.get(r.id).services.push({ slug: r.service_slug, name: r.service_name, duration_min: r.duration_min, buffer_min: r.buffer_min, price_cents: r.price_cents });
  }
  if (!byVendor.size) return { area: { slug: area.slug, name: area.name }, pros: [] };

  // One query each for rules, bookings and time off across all listed providers
  const ids = [...byVendor.keys()];
  const from = DateTime.fromJSDate(now, { zone: BUSINESS_TZ }).startOf("day");
  const to = from.plus({ days: lookaheadDays });
  const rules = await db().query(
    `SELECT vendor_id, weekday, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time
       FROM availability_rules WHERE vendor_id = ANY($1::uuid[])`, [ids]);
  const busy = await db().query(
    `SELECT vendor_id, starts_at AS s, blocked_until AS e FROM bookings
      WHERE vendor_id = ANY($1::uuid[]) AND status IN ('confirmed','completed') AND starts_at < $3 AND blocked_until > $2
     UNION ALL
     SELECT vendor_id, starts_at, ends_at FROM time_off WHERE vendor_id = ANY($1::uuid[]) AND starts_at < $3 AND ends_at > $2`,
    [ids, from.minus({ days: 1 }).toJSDate(), to.plus({ days: 1 }).toJSDate()]);

  const pros = [];
  for (const v of byVendor.values()) {
    const vRules = rules.filter((r) => r.vendor_id === v.id).map((r) => ({ ...r, weekday: Number(r.weekday) }));
    const vBusy = busy.filter((b) => b.vendor_id === v.id).map((b) => ({ start: new Date(b.s), end: new Date(b.e) }));
    let next = null;
    for (const svc of v.services) {
      const days = generateSlots({
        timezone: v.timezone, rules: vRules, busy: vBusy, durationMin: svc.duration_min, bufferMin: svc.buffer_min,
        stepMin: v.slot_step_min, minNoticeMin: v.min_notice_min, maxDaysAhead: v.max_days_ahead, now,
        fromDate: from.toISODate(), toDate: to.toISODate(),
      });
      const first = Object.values(days).flat().sort()[0] || null;
      svc.next_open = first;
      if (first && (!next || first < next)) next = first;
    }
    pros.push({
      id: v.id, name: v.name, first_name: v.name.split(" ")[0], business_name: v.business_name, bio: v.bio,
      photo_url: photoUrl(v), next_open: next,
      price_from_cents: Math.min(...v.services.map((s) => s.price_cents ?? Infinity)) === Infinity ? null : Math.min(...v.services.map((s) => s.price_cents ?? Infinity)),
      services: v.services.map(({ slug, name, duration_min, price_cents, next_open }) => ({ slug, name, duration_min, price_cents, next_open })),
    });
  }
  pros.sort((a, b) => (a.next_open || "9999").localeCompare(b.next_open || "9999") || a.name.localeCompare(b.name));
  return { area: { slug: area.slug, name: area.name }, pros };
}

// --- profile ----------------------------------------------------------------------

export async function getProfile(vendorId) {
  const [v] = await db().query(`SELECT id, name, business_name, bio, phone, photo_version FROM vendors WHERE id = $1`, [vendorId]);
  if (!v) throw notFound();
  return { ...v, photo_url: photoUrl(v), areas: await vendorAreas(vendorId) };
}

export async function updateProfile(vendorId, body) {
  const business = str(body.business_name, "Business name", { optional: true, max: 160 });
  const bio = str(body.bio, "About you", { optional: true, max: 600 });
  const phone = str(body.phone, "Phone", { optional: true, max: 40 });
  await db().query(`UPDATE vendors SET business_name = $2, bio = $3, phone = $4 WHERE id = $1`, [vendorId, business, bio, phone]);
  if (Array.isArray(body.areas)) await setVendorAreas(vendorId, body.areas);
  return getProfile(vendorId);
}

const MAX_PHOTO = 600_000; // bytes after the browser has resized it

export async function setPhoto(vendorId, body) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ""));
  if (!m) throw bad("Please choose a JPG, PNG or WebP image.", "invalid_photo");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_PHOTO) throw bad("That photo is too large. Please use one under 600 KB.", "photo_too_large");
  // Check the file really is the image type it claims (magic bytes)
  const sig = buf.subarray(0, 12).toString("hex");
  const ok = (m[1] === "image/jpeg" && sig.startsWith("ffd8ff")) || (m[1] === "image/png" && sig.startsWith("89504e47")) ||
    (m[1] === "image/webp" && sig.startsWith("52494646") && buf.subarray(8, 12).toString() === "WEBP");
  if (!ok) throw bad("That file isn't a valid image.", "invalid_photo");
  await db().query(
    `INSERT INTO vendor_photos (vendor_id, mime, data) VALUES ($1,$2,$3)
     ON CONFLICT (vendor_id) DO UPDATE SET mime = $2, data = $3, updated_at = now()`, [vendorId, m[1], buf]);
  await db().query(`UPDATE vendors SET photo_version = photo_version + 1 WHERE id = $1`, [vendorId]);
  return getProfile(vendorId);
}

export async function removePhoto(vendorId) {
  await db().query(`DELETE FROM vendor_photos WHERE vendor_id = $1`, [vendorId]);
  await db().query(`UPDATE vendors SET photo_version = 0 WHERE id = $1`, [vendorId]);
  return getProfile(vendorId);
}

export async function getPhoto(vendorId) {
  const [p] = await db().query(
    `SELECT p.mime, p.data FROM vendor_photos p JOIN vendors v ON v.id = p.vendor_id WHERE p.vendor_id = $1 AND v.active`, [vendorId]);
  if (!p) throw notFound();
  return { mime: p.mime, data: Buffer.from(p.data) };
}

// --- provider inbox ("What's new") ------------------------------------------------

/** Bookings created, moved or cancelled since the user last looked. */
export async function inbox(user, { limit = 30 } = {}) {
  const lim = int(limit, "limit", { min: 1, max: 100 });
  const rows = await db().query(
    `SELECT e.type, e.actor, e.at, b.id AS booking_id, b.starts_at, b.status, b.customer_name, s.name AS service_name, v.name AS vendor_name
       FROM booking_events e JOIN bookings b ON b.id = e.booking_id JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id
      WHERE e.type IN ('created','rescheduled','cancelled')
        AND ($1::uuid IS NULL OR b.vendor_id = $1::uuid)
        AND e.at > $2
        AND e.actor NOT LIKE $3
      ORDER BY e.at DESC LIMIT $4`,
    [user.role === "vendor" ? user.vendor_id : null, user.inbox_seen_at, `%:${user.email}`, lim]
  );
  return { items: rows, since: user.inbox_seen_at };
}

export async function markInboxSeen(user) {
  await db().query(`UPDATE users SET inbox_seen_at = now() WHERE id = $1`, [user.id]);
  return { ok: true };
}
