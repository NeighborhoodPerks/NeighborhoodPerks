// HOA program: communities (HOAs) and their join codes, pros' resident/group discounts,
// group days, the board's report, and the give-back owed to each association.
//
// Money: residents get the pro's discount (the pro's savings from grouped, lead-free work
// pay for it). The give-back to the association's fund comes out of our fee:
// give_back_bps of each paid resident booking (100 = 1%). Nothing is ever paid to a person.

import { randomInt } from "node:crypto";
import { DateTime } from "luxon";
import { db } from "./db.mjs";
import { bad, conflict, notFound, forbidden, str, int, isoDate } from "./http.mjs";
import { newToken, sha256 } from "./crypto.mjs";
import { discounted, groupDaySlots, cancelBooking, BUSINESS_TZ } from "./bookings.mjs";
import { notifyGroupDayCreated } from "./notify.mjs";
import { paymentsEnabled } from "./payments.mjs";

const SITE = () => (process.env.SITE_URL || "https://neighborhoodperks.com").replace(/\/$/, "");
const LIVE = `('confirmed','completed')`;
const PAID = `('paid','partially_refunded')`;

// --- communities ------------------------------------------------------------------

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
function makeCode(name) {
  const prefix = name.toUpperCase().normalize("NFD").replace(/[^A-Z]/g, "").slice(0, 6) || "HOA";
  let tail = "";
  for (let i = 0; i < 4; i++) tail += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return `${prefix}-${tail}`;
}
const cleanCode = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "");
const slugify = (v) => String(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The community a booking counts for: from a join code, or else the signed-in homeowner's
 * saved community. A wrong code is an error (so a typo isn't silently full price).
 */
export async function resolveCommunity({ code = null, user = null } = {}) {
  const c = cleanCode(code);
  if (c) {
    const [row] = await db().query(`SELECT * FROM communities WHERE upper(join_code) = $1 AND active`, [c]);
    if (!row) throw bad("That community code isn't right. Check your HOA's newsletter, or book without it.", "invalid_community_code");
    return row;
  }
  if (user && user.role === "customer") {
    const [row] = await db().query(
      `SELECT c.* FROM users u JOIN communities c ON c.id = u.community_id WHERE u.id = $1 AND c.active`, [user.id]);
    return row || null;
  }
  return null;
}

/** What a resident sees after entering the code: pricing, pros in the program, group days. */
export async function publicCommunity(code, { now = new Date() } = {}) {
  const c = await resolveCommunity({ code });
  if (!c) throw bad("Enter your community's code.", "invalid_community_code");
  const [area] = await db().query(`SELECT slug, name FROM areas WHERE id = $1`, [c.area_id]);
  const pros = await db().query(
    `SELECT v.id, v.name, v.business_name, v.photo_version, v.hoa_resident_pct, v.hoa_group_pct, v.hoa_group_min,
            coalesce(json_agg(json_build_object('slug', s.slug, 'name', s.name, 'price_cents', vs.price_cents) ORDER BY s.sort)
              FILTER (WHERE s.id IS NOT NULL), '[]') AS services
       FROM vendors v JOIN vendor_areas va ON va.vendor_id = v.id AND va.area_id = $1
       LEFT JOIN vendor_services vs ON vs.vendor_id = v.id AND vs.active
       LEFT JOIN services s ON s.id = vs.service_id AND s.active
      WHERE v.active AND v.status = 'approved' AND v.hoa_resident_pct IS NOT NULL
        AND (NOT $2::boolean OR v.stripe_charges_enabled)
      GROUP BY v.id ORDER BY v.name`,
    [c.area_id, paymentsEnabled()]);
  return {
    community: { slug: c.slug, name: c.name, guidelines: c.guidelines, area },
    pros: pros.map((p) => ({
      id: p.id, name: p.business_name || p.name, photo_url: p.photo_version ? `/api/pros/${p.id}/photo?v=${p.photo_version}` : null,
      resident_pct: p.hoa_resident_pct, group_pct: p.hoa_group_pct, group_min: p.hoa_group_min,
      services: (typeof p.services === "string" ? JSON.parse(p.services) : p.services).map((s) => ({ ...s, resident_price_cents: discounted(s.price_cents, p.hoa_resident_pct) })),
    })),
    groupDays: await groupDayList({ communityId: c.id, from: now, openOnly: true }),
  };
}

/** A homeowner saves (or clears) their community so they don't need the code each time. */
export async function setCustomerCommunity(user, code) {
  if (!cleanCode(code)) {
    await db().query(`UPDATE users SET community_id = NULL WHERE id = $1`, [user.id]);
    return { community: null };
  }
  const c = await resolveCommunity({ code });
  await db().query(`UPDATE users SET community_id = $2 WHERE id = $1`, [user.id, c.id]);
  return { community: { slug: c.slug, name: c.name } };
}

// --- admin: communities -------------------------------------------------------------

export async function upsertCommunity(body) {
  const name = str(body.name, "Name", { max: 120 });
  const slug = slugify(body.slug || name);
  if (!slug) throw bad("Name is required.");
  const [area] = await db().query(`SELECT id FROM areas WHERE slug = $1`, [String(body.area || "")]);
  if (!area) throw bad("Choose the neighborhood this community is in.", "invalid_area");
  // Updating: a field that isn't sent keeps its current value (so a partial save never wipes the contact)
  const [existing] = await db().query(`SELECT * FROM communities WHERE slug = $1`, [slug]);
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const homes = has("homes") ? (body.homes === "" || body.homes == null ? null : int(body.homes, "Homes", { min: 1, max: 100000 })) : existing?.homes ?? null;
  const pct = has("give_back_pct") && body.give_back_pct !== "" && body.give_back_pct != null ? Number(body.give_back_pct) : existing ? existing.give_back_bps / 100 : 1;
  if (!(pct >= 0 && pct <= 10)) throw bad("Give-back must be between 0% and 10%.", "invalid_give_back");
  const contactEmail = has("contact_email") ? (body.contact_email ? String(body.contact_email).trim().toLowerCase() : null) : existing?.contact_email ?? null;
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw bad("Contact email doesn't look right.", "invalid_email");
  const guidelines = has("guidelines") ? str(body.guidelines, "Guidelines", { optional: true, max: 1500 }) : existing?.guidelines ?? null;
  const contactName = has("contact_name") ? str(body.contact_name, "Contact name", { optional: true, max: 120 }) : existing?.contact_name ?? null;
  const active = has("active") ? body.active !== false : existing ? existing.active : true;
  let code = cleanCode(body.join_code) || existing?.join_code || makeCode(name);
  if (!/^[A-Z0-9-]{4,24}$/.test(code)) throw bad("Join codes are 4–24 letters, numbers or dashes.", "invalid_code");
  const [taken] = await db().query(`SELECT slug FROM communities WHERE upper(join_code) = $1 AND slug <> $2`, [code, slug]);
  if (taken) throw conflict("Another community already uses that code.", "code_taken");
  await db().query(
    `INSERT INTO communities (slug, name, area_id, join_code, homes, give_back_bps, guidelines, contact_name, contact_email, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (slug) DO UPDATE SET name = $2, area_id = $3, join_code = $4, homes = $5, give_back_bps = $6,
       guidelines = $7, contact_name = $8, contact_email = $9, active = $10`,
    [slug, name, area.id, code, homes, Math.round(pct * 100), guidelines, contactName, contactEmail, active]);
  return listCommunities();
}

/** Every community with its running totals, for the admin. */
export async function listCommunities() {
  const rows = await db().query(
    `SELECT c.id, c.slug, c.name, c.join_code, c.homes, c.give_back_bps, c.guidelines, c.contact_name, c.contact_email, c.active,
            (c.report_token_hash IS NOT NULL) AS has_report, a.slug AS area, a.name AS area_name
       FROM communities c JOIN areas a ON a.id = c.area_id ORDER BY c.active DESC, c.name`);
  for (const c of rows) Object.assign(c, await totals(c.id, c.give_back_bps));
  return rows;
}

async function totals(communityId, bps) {
  const [t] = await db().query(
    `SELECT count(*) FILTER (WHERE status IN ${LIVE})::int AS bookings,
            coalesce(sum(amount_charged_cents - amount_refunded_cents) FILTER (WHERE payment_status IN ${PAID}), 0)::int AS paid_cents
       FROM bookings WHERE community_id = $1`, [communityId]);
  const [p] = await db().query(`SELECT coalesce(sum(amount_cents), 0)::int AS paid_out FROM community_payouts WHERE community_id = $1`, [communityId]);
  const accrued = Math.round((t.paid_cents * bps) / 10000);
  return { bookings: t.bookings, paid_cents: t.paid_cents, give_back_cents: accrued, paid_out_cents: p.paid_out, owed_cents: Math.max(0, accrued - p.paid_out) };
}

async function communityBySlug(slug) {
  const [c] = await db().query(`SELECT * FROM communities WHERE slug = $1`, [String(slug)]);
  if (!c) throw notFound("Community not found.");
  return c;
}

/** A private link for the board. Making a new one turns the old one off. */
export async function reportLink(slug) {
  const c = await communityBySlug(slug);
  const token = newToken(24);
  await db().query(`UPDATE communities SET report_token_hash = $2 WHERE id = $1`, [c.id, sha256(token)]);
  return { url: `${SITE()}/hoa/report/?t=${token}` };
}

export async function addPayout(slug, body) {
  const c = await communityBySlug(slug);
  const cents = Math.round(Number(body.amount) * 100);
  if (!(cents > 0)) throw bad("Enter the amount paid.", "invalid_amount");
  const paidOn = body.paid_on ? isoDate(body.paid_on, "Date") : DateTime.now().setZone(BUSINESS_TZ).toISODate();
  await db().query(`INSERT INTO community_payouts (community_id, amount_cents, paid_on, note) VALUES ($1,$2,$3,$4)`,
    [c.id, cents, paidOn, str(body.note, "Note", { optional: true, max: 200 })]);
  return listCommunities();
}

// --- the board's report -------------------------------------------------------------------

/**
 * What the board sees: totals, by quarter, by service, group days, give-back.
 * Never names, addresses or contact details: residents' privacy comes first.
 */
export async function boardReport(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw notFound("This report link isn't valid.");
  const [c] = await db().query(`SELECT * FROM communities WHERE report_token_hash = $1`, [sha256(token)]);
  if (!c) throw notFound("This report link isn't valid. Ask Neighborhood Perks for a new one.");
  const quarters = await db().query(
    `SELECT to_char(date_trunc('quarter', b.starts_at AT TIME ZONE $2::text), 'YYYY-"Q"Q') AS quarter,
            count(*)::int AS bookings,
            count(DISTINCT lower(regexp_replace(b.address, '\\s+', ' ', 'g')))::int AS homes,
            coalesce(sum(b.amount_charged_cents - b.amount_refunded_cents) FILTER (WHERE b.payment_status IN ${PAID}), 0)::int AS paid_cents,
            coalesce(sum(greatest(b.list_price_cents - b.price_cents, 0)) FILTER (WHERE b.status = 'completed' AND b.list_price_cents IS NOT NULL), 0)::int AS savings_cents
       FROM bookings b WHERE b.community_id = $1 AND b.status IN ${LIVE}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 8`, [c.id, BUSINESS_TZ]);
  for (const q of quarters) q.give_back_cents = Math.round((q.paid_cents * c.give_back_bps) / 10000);
  const services = await db().query(
    `SELECT s.name, count(*)::int AS bookings FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.community_id = $1 AND b.status IN ${LIVE} GROUP BY s.name ORDER BY 2 DESC`, [c.id]);
  const payouts = await db().query(
    `SELECT amount_cents, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, note FROM community_payouts WHERE community_id = $1 ORDER BY paid_on DESC`, [c.id]);
  return {
    community: { name: c.name, homes: c.homes, give_back_pct: c.give_back_bps / 100 },
    totals: await totals(c.id, c.give_back_bps),
    quarters, services, payouts,
    groupDays: await groupDayList({ communityId: c.id, from: DateTime.now().minus({ months: 12 }).toJSDate() }),
  };
}

// --- pros: program settings ---------------------------------------------------------------

export async function vendorHoa(vendorId) {
  const [v] = await db().query(`SELECT hoa_resident_pct, hoa_group_pct, hoa_group_min FROM vendors WHERE id = $1`, [vendorId]);
  if (!v) throw notFound();
  const communities = await db().query(
    `SELECT c.slug, c.name, a.name AS area_name, c.guidelines
       FROM communities c JOIN areas a ON a.id = c.area_id JOIN vendor_areas va ON va.area_id = c.area_id AND va.vendor_id = $1
      WHERE c.active ORDER BY c.name`, [vendorId]);
  const services = await db().query(
    `SELECT s.slug, s.name, vs.price_cents FROM vendor_services vs JOIN services s ON s.id = vs.service_id
      WHERE vs.vendor_id = $1 AND vs.active AND s.active ORDER BY s.sort`, [vendorId]);
  return {
    settings: { enabled: v.hoa_resident_pct != null, resident_pct: v.hoa_resident_pct, group_pct: v.hoa_group_pct, group_min: v.hoa_group_min },
    communities, services,
    groupDays: await groupDayList({ vendorId, from: DateTime.now().minus({ days: 30 }).toJSDate(), withPrivate: true }),
  };
}

export async function setVendorHoa(vendorId, body) {
  if (!body.enabled) {
    const [open] = await db().query(`SELECT count(*)::int AS n FROM group_days WHERE vendor_id = $1 AND status = 'open' AND ends_at > now()`, [vendorId]);
    if (open.n) throw conflict("Cancel your upcoming group days before leaving the HOA program.", "has_group_days");
    await db().query(`UPDATE vendors SET hoa_resident_pct = NULL, hoa_group_pct = NULL, hoa_group_min = NULL WHERE id = $1`, [vendorId]);
    return vendorHoa(vendorId);
  }
  const resident = int(body.resident_pct, "Resident discount", { min: 10, max: 50 });
  const group = int(body.group_pct, "Group-day discount", { min: resident, max: 60 });
  const min = int(body.group_min, "Fewest homes for a group day", { min: 3, max: 50 });
  await db().query(`UPDATE vendors SET hoa_resident_pct = $2, hoa_group_pct = $3, hoa_group_min = $4 WHERE id = $1`, [vendorId, resident, group, min]);
  return vendorHoa(vendorId);
}

// --- group days -----------------------------------------------------------------------------

export async function createGroupDay(vendorId, body, { now = new Date() } = {}) {
  const [v] = await db().query(`SELECT id, timezone, hoa_resident_pct, hoa_group_pct, hoa_group_min FROM vendors WHERE id = $1 AND active`, [vendorId]);
  if (!v) throw notFound();
  if (v.hoa_resident_pct == null) throw conflict("Join the HOA program (set your discounts) before opening a group day.", "not_in_program");
  const [c] = await db().query(
    `SELECT c.* FROM communities c JOIN vendor_areas va ON va.area_id = c.area_id AND va.vendor_id = $1
      WHERE c.slug = $2 AND c.active`, [vendorId, String(body.community || "")]);
  if (!c) throw bad("Choose a community in one of your neighborhoods.", "invalid_community");
  const [svc] = await db().query(
    `SELECT s.id, s.name, vs.price_cents FROM services s JOIN vendor_services vs ON vs.service_id = s.id AND vs.vendor_id = $1
      WHERE s.slug = $2 AND s.active AND vs.active`, [vendorId, String(body.service || "")]);
  if (!svc) throw bad("Choose one of your services.", "invalid_service");
  if (svc.price_cents == null) throw bad("That service needs a price before it can have a group day. Ask us to set it.", "no_price");

  const date = isoDate(body.date, "Date");
  const t = (x, name) => { if (!/^\d{2}:\d{2}$/.test(String(x || ""))) throw bad(`${name} must look like 09:00.`, "invalid_time"); return String(x); };
  const start = DateTime.fromISO(`${date}T${t(body.start, "Start")}`, { zone: v.timezone });
  const end = DateTime.fromISO(`${date}T${t(body.end, "End")}`, { zone: v.timezone });
  if (!start.isValid || !end.isValid || end <= start) throw bad("The group day must end after it starts.", "invalid_time");
  if (end.diff(start, "hours").hours > 12) throw bad("A group day can be at most 12 hours.", "invalid_time");
  const today = DateTime.fromJSDate(now, { zone: v.timezone }).startOf("day");
  if (start < today.plus({ days: 2 })) throw bad("Give residents at least 2 days' notice: pick a date from the day after tomorrow.", "too_soon");
  if (start > today.plus({ days: 180 })) throw bad("Group days can be up to 6 months ahead.", "too_far");
  const minHomes = body.min_homes == null || body.min_homes === "" ? v.hoa_group_min : int(body.min_homes, "Fewest homes", { min: 3, max: 50 });

  const s = start.toJSDate(), e = end.toJSDate();
  const [clash] = await db().query(
    `SELECT count(*)::int AS n FROM bookings WHERE vendor_id = $1 AND status = 'confirmed' AND starts_at < $3 AND blocked_until > $2`, [vendorId, s, e]);
  if (clash.n) throw conflict(`You already have ${clash.n} booking${clash.n > 1 ? "s" : ""} in that window. Pick another time.`, "has_bookings");
  const [blocked] = await db().query(
    `SELECT count(*)::int AS n FROM time_off WHERE vendor_id = $1 AND starts_at < $3 AND ends_at > $2`, [vendorId, s, e]);
  if (blocked.n) throw conflict("That window overlaps time you've blocked off or another group day.", "has_time_off");

  const id = await db().tx(async (tx) => {
    const [gd] = await tx.query(
      `INSERT INTO group_days (community_id, vendor_id, service_id, starts_at, ends_at, min_homes, list_price_cents,
                               resident_price_cents, group_price_cents, common_area_job)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [c.id, vendorId, svc.id, s, e, minHomes, svc.price_cents, discounted(svc.price_cents, v.hoa_resident_pct),
       discounted(svc.price_cents, v.hoa_group_pct), str(body.common_area_job, "Common-area job", { optional: true, max: 200 })]);
    // Hold the window so regular bookings can't take it
    await tx.query(`INSERT INTO time_off (vendor_id, starts_at, ends_at, note, group_day_id) VALUES ($1,$2,$3,$4,$5)`,
      [vendorId, s, e, `Group day · ${c.name} · ${svc.name}`, gd.id]);
    return gd.id;
  });
  await notifyGroupDayCreated(id);
  return (await groupDayList({ id, withPrivate: true }))[0];
}

/** Cancel a group day: release the window and cancel (and email) everyone booked on it. */
export async function cancelGroupDay(user, id) {
  const [gd] = await db().query(`SELECT * FROM group_days WHERE id = $1`, [id]);
  if (!gd) throw notFound("Group day not found.");
  if (user.role === "vendor" && gd.vendor_id !== user.vendor_id) throw forbidden();
  if (gd.status === "cancelled") return { ok: true };
  await db().tx(async (t) => {
    await t.query(`UPDATE group_days SET status = 'cancelled' WHERE id = $1`, [id]);
    await t.query(`DELETE FROM time_off WHERE group_day_id = $1`, [id]);
  });
  const booked = await db().query(`SELECT id FROM bookings WHERE group_day_id = $1 AND status = 'confirmed'`, [id]);
  for (const b of booked) await cancelBooking(b.id, { actor: `${user.role}:${user.email}`, reason: "The group day was cancelled." });
  return { ok: true, cancelledBookings: booked.length };
}

/** Group days with how many homes have booked. */
async function groupDayList({ id = null, vendorId = null, communityId = null, from = null, openOnly = false, withPrivate = false }) {
  const rows = await db().query(
    `SELECT g.id, g.starts_at, g.ends_at, g.min_homes, g.list_price_cents, g.resident_price_cents, g.group_price_cents,
            g.common_area_job, g.status, g.unlocked_at, s.slug AS service_slug, s.name AS service_name,
            c.slug AS community_slug, c.name AS community_name, v.name AS vendor_name, v.business_name, v.timezone,
            (SELECT count(*)::int FROM bookings b WHERE b.group_day_id = g.id AND b.status IN ${LIVE}) AS booked
       FROM group_days g JOIN services s ON s.id = g.service_id JOIN communities c ON c.id = g.community_id JOIN vendors v ON v.id = g.vendor_id
      WHERE ($1::uuid IS NULL OR g.id = $1::uuid) AND ($2::uuid IS NULL OR g.vendor_id = $2::uuid)
        AND ($3::uuid IS NULL OR g.community_id = $3::uuid) AND ($4::timestamptz IS NULL OR g.ends_at > $4::timestamptz)
        AND (NOT $5::boolean OR g.status = 'open')
      ORDER BY g.starts_at`,
    [id, vendorId, communityId, from, openOnly]);
  return rows.map((g) => ({
    id: g.id, starts_at: g.starts_at, ends_at: g.ends_at, status: g.status, unlocked: !!g.unlocked_at,
    service: { slug: g.service_slug, name: g.service_name }, community: { slug: g.community_slug, name: g.community_name },
    pro: g.business_name || g.vendor_name, min_homes: g.min_homes, booked: g.booked,
    list_price_cents: g.list_price_cents, resident_price_cents: g.resident_price_cents, group_price_cents: g.group_price_cents,
    common_area_job: g.common_area_job,
  }));
}

/** One group day for a resident (with the code): details and the open times. */
export async function publicGroupDay(id, code, { now = new Date() } = {}) {
  const c = await resolveCommunity({ code });
  if (!c) throw bad("Enter your community's code.", "invalid_community_code");
  const [gd] = await db().query(`SELECT * FROM group_days WHERE id = $1 AND community_id = $2`, [id, c.id]);
  if (!gd) throw notFound("Group day not found.");
  const [info] = await groupDayList({ id });
  return { groupDay: info, community: { slug: c.slug, name: c.name, guidelines: c.guidelines },
    slots: gd.status === "open" ? await groupDaySlots(gd, { now }) : [] };
}
