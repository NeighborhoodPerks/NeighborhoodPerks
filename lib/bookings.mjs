// Booking core: availability across vendors, create / cancel / reschedule.
// Every write runs in a transaction that first locks the vendor row, re-checks the
// slot against fresh data, then inserts. The bookings_no_overlap constraint is the
// last line of defence if anything slips past.

import { DateTime } from "luxon";
import { db, isOverlapError } from "./db.mjs";
import { generateSlots, isSlotAvailable } from "./availability.mjs";
import { newToken, sha256 } from "./crypto.mjs";
import { bad, conflict, notFound } from "./http.mjs";
import { notifyBooking, notifyGroupUnlocked } from "./notify.mjs";
import { paymentsEnabled } from "./payments.mjs";

export const BUSINESS_TZ = "America/Los_Angeles";
const DAY_MS = 86_400_000;

/** A discounted price, rounded to the cent. */
export const discounted = (cents, pct) => (cents == null ? null : Math.round((cents * (100 - pct)) / 100));

export async function getService(q, slug) {
  const [s] = await q(`SELECT id, slug, name FROM services WHERE slug = $1 AND active`, [slug]);
  if (!s) throw notFound("That service isn't available.");
  return s;
}

/** Vendors who offer a service, with their per-service settings. */
async function vendorsFor(q, serviceId, vendorId = null) {
  return q(
    `SELECT v.id, v.timezone, v.min_notice_min, v.max_days_ahead, v.slot_step_min, v.hoa_resident_pct,
            vs.duration_min, vs.buffer_min, vs.price_cents
       FROM vendors v JOIN vendor_services vs ON vs.vendor_id = v.id
      WHERE vs.service_id = $1 AND vs.active AND v.active AND ($2::uuid IS NULL OR v.id = $2::uuid)
        AND (NOT $3::boolean OR v.stripe_charges_enabled)
      ORDER BY v.id`,
    [serviceId, vendorId, paymentsEnabled()]
  );
}

/** Rules + busy intervals for one vendor between two instants. */
async function schedule(q, vendorId, from, to, { excludeBookingId = null, groupDayId = null } = {}) {
  const rules = await q(
    `SELECT weekday, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM availability_rules WHERE vendor_id = $1`,
    [vendorId]
  );
  const booked = await q(
    `SELECT starts_at, blocked_until FROM bookings
      WHERE vendor_id = $1 AND status IN ('confirmed','completed')
        AND starts_at < $3 AND blocked_until > $2
        AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [vendorId, from, to, excludeBookingId]
  );
  // A group day's own hold doesn't block its residents; every other block does
  const off = await q(
    `SELECT starts_at, ends_at FROM time_off WHERE vendor_id = $1 AND starts_at < $3 AND ends_at > $2
        AND ($4::uuid IS NULL OR group_day_id IS DISTINCT FROM $4::uuid)`,
    [vendorId, from, to, groupDayId]
  );
  const busy = [
    ...booked.map((b) => ({ start: new Date(b.starts_at), end: new Date(b.blocked_until) })),
    ...off.map((t) => ({ start: new Date(t.starts_at), end: new Date(t.ends_at) })),
  ];
  return { rules: rules.map((r) => ({ ...r, weekday: Number(r.weekday) })), busy };
}

function slotOpts(v, sched, now, groupDay = null) {
  return {
    timezone: v.timezone,
    // On a group day the only open time is the group day's window
    rules: groupDay ? groupDayRules(groupDay, v.timezone) : sched.rules,
    busy: sched.busy,
    durationMin: v.duration_min,
    // The buffer is travel time; on a group day the next home is next door
    bufferMin: groupDay ? 0 : v.buffer_min,
    stepMin: v.slot_step_min,
    minNoticeMin: v.min_notice_min,
    maxDaysAhead: groupDay ? 366 : v.max_days_ahead,
    now,
  };
}

function groupDayRules(gd, tz) {
  const s = DateTime.fromJSDate(new Date(gd.starts_at), { zone: tz });
  const e = DateTime.fromJSDate(new Date(gd.ends_at), { zone: tz });
  return [{ weekday: s.weekday, start_time: s.toFormat("HH:mm"), end_time: e.toFormat("HH:mm") }];
}

/** Open start times inside a group day's window. */
export async function groupDaySlots(gd, { now = new Date() } = {}) {
  const q = db().query;
  const [v] = await vendorsFor(q, gd.service_id, gd.vendor_id);
  if (!v) return [];
  const sched = await schedule(q, v.id, new Date(+new Date(gd.starts_at) - DAY_MS), new Date(+new Date(gd.ends_at) + DAY_MS), { groupDayId: gd.id });
  const date = DateTime.fromJSDate(new Date(gd.starts_at), { zone: v.timezone }).toISODate();
  return generateSlots({ ...slotOpts(v, sched, now, gd), fromDate: date, toDate: date })[date] || [];
}

/** Open start times for a service, merged across every vendor who offers it. */
export async function availability({ serviceSlug, vendorId = null, fromDate, toDate, now = new Date(), excludeBookingId = null }) {
  const q = db().query;
  const service = await getService(q, serviceSlug);
  const vendors = await vendorsFor(q, service.id, vendorId);
  const from = DateTime.fromISO(fromDate, { zone: BUSINESS_TZ }).startOf("day");
  const to = DateTime.fromISO(toDate, { zone: BUSINESS_TZ }).endOf("day");
  if (!from.isValid || !to.isValid || to < from) throw bad("Invalid date range.");
  if (to.diff(from, "days").days > 62) throw bad("Pick a shorter date range.");

  const days = {};
  for (let d = from; d <= to; d = d.plus({ days: 1 })) days[d.toISODate()] = new Set();
  const prices = vendors.map((v) => v.price_cents).filter((p) => p != null);

  for (const v of vendors) {
    const sched = await schedule(q, v.id, new Date(from.toMillis() - DAY_MS), new Date(to.toMillis() + DAY_MS), { excludeBookingId });
    const slots = generateSlots({ ...slotOpts(v, sched, now), fromDate, toDate });
    for (const [date, list] of Object.entries(slots)) for (const s of list) days[date]?.add(s);
  }
  const out = {};
  for (const [date, set] of Object.entries(days)) out[date] = [...set].sort();
  return {
    service: { slug: service.slug, name: service.name },
    timezone: BUSINESS_TZ,
    priceFromCents: prices.length ? Math.min(...prices) : null,
    vendorCount: vendors.length,
    days: out,
  };
}

/** Busy-load per vendor on the day of `start`, for fair assignment. */
async function loadOnDay(q, vendorIds, start) {
  const day = DateTime.fromJSDate(start, { zone: BUSINESS_TZ });
  const rows = await q(
    `SELECT vendor_id, count(*)::int AS n FROM bookings
      WHERE vendor_id = ANY($1::uuid[]) AND status = 'confirmed' AND starts_at >= $2 AND starts_at < $3
      GROUP BY vendor_id`,
    [vendorIds, day.startOf("day").toJSDate(), day.endOf("day").toJSDate()]
  );
  return Object.fromEntries(rows.map((r) => [r.vendor_id, r.n]));
}

/** Try to place a booking with one vendor. Returns the booking row or null if the slot isn't free. */
async function tryVendor(v, start, insert, now, excludeBookingId = null, groupDay = null) {
  try {
    return await db().tx(async (t) => {
      const [locked] = await t.query(`SELECT id FROM vendors WHERE id = $1 AND active FOR UPDATE`, [v.id]);
      if (!locked) return null;
      const sched = await schedule(t.query, v.id, new Date(start - DAY_MS), new Date(+start + DAY_MS), { excludeBookingId, groupDayId: groupDay?.id });
      if (!isSlotAvailable(slotOpts(v, sched, now, groupDay), start.toISOString())) return null;
      return insert(t, v);
    });
  } catch (err) {
    if (isOverlapError(err)) return null; // lost a race; caller tries the next vendor
    throw err;
  }
}

/**
 * input.community: a resolved community (see hoa.mjs resolveCommunity) or null.
 * input.groupDayId: book a slot on a group day; the pro, service and area come from the group day.
 */
export async function createBooking(input, { now = new Date(), actor = "customer" } = {}) {
  const q = db().query;
  let community = input.community || null;
  let groupDay = null;
  if (input.groupDayId) {
    if (!community) throw bad("Enter your community's code to book a group day.", "community_required");
    [groupDay] = await q(`SELECT * FROM group_days WHERE id = $1`, [input.groupDayId]);
    if (!groupDay || groupDay.status !== "open") throw conflict("This group day isn't taking bookings.", "group_day_closed");
    if (groupDay.community_id !== community.id) throw bad("That group day is for a different community.", "wrong_community");
  }
  const service = groupDay
    ? (await q(`SELECT id, slug, name FROM services WHERE id = $1`, [groupDay.service_id]))[0]
    : await getService(q, input.serviceSlug);
  // When the customer picked a provider, book that provider and nobody else
  const vendors = await vendorsFor(q, service.id, groupDay ? groupDay.vendor_id : input.vendorId || null);
  if (!vendors.length) {
    throw conflict(input.vendorId || groupDay ? "That provider isn't taking bookings for this service right now." : "Nobody is taking bookings for that service right now. Please call us.", "no_vendors");
  }
  let areaId = groupDay ? community.area_id : null;
  if (input.areaSlug && !groupDay) {
    const [area] = await q(`SELECT id FROM areas WHERE slug = $1 AND active`, [input.areaSlug]);
    if (!area) throw bad("Please choose your neighborhood.", "invalid_area");
    areaId = area.id;
    const serving = await q(`SELECT vendor_id FROM vendor_areas WHERE area_id = $1 AND vendor_id = ANY($2::uuid[])`, [area.id, vendors.map((v) => v.id)]);
    const ok = new Set(serving.map((r) => r.vendor_id));
    for (let i = vendors.length - 1; i >= 0; i--) if (!ok.has(vendors[i].id)) vendors.splice(i, 1);
    if (!vendors.length) throw conflict("That provider doesn't work in your neighborhood.", "wrong_area");
  }
  // A community code only counts in the community's own neighborhood
  if (community && community.area_id !== areaId) community = null;

  const start = input.start;
  const load = await loadOnDay(q, vendors.map((v) => v.id), start);
  const ordered = [...vendors].sort((a, b) => (load[a.id] || 0) - (load[b.id] || 0) || Math.random() - 0.5);

  const token = newToken(24);
  let unlocked = false;
  for (const v of ordered) {
    const row = await tryVendor(v, start, async (t, vendor) => {
      const ends = new Date(+start + vendor.duration_min * 60_000);
      const blocked = new Date(+ends + (groupDay ? 0 : vendor.buffer_min) * 60_000);
      let list = vendor.price_cents;
      let price = list;
      let kind = null;
      if (groupDay) {
        // Serialized by the vendor lock above: count, then decide the price for everyone
        const [gd] = await t.query(`SELECT status, unlocked_at FROM group_days WHERE id = $1 FOR UPDATE`, [groupDay.id]);
        if (gd.status !== "open") throw conflict("This group day isn't taking bookings.", "group_day_closed");
        const [{ n }] = await t.query(`SELECT count(*)::int AS n FROM bookings WHERE group_day_id = $1 AND status IN ('confirmed','completed')`, [groupDay.id]);
        const reached = !!gd.unlocked_at || n + 1 >= groupDay.min_homes;
        list = groupDay.list_price_cents;
        kind = reached ? "group" : "resident";
        price = reached ? groupDay.group_price_cents : groupDay.resident_price_cents;
        if (reached && !gd.unlocked_at) {
          await t.query(`UPDATE group_days SET unlocked_at = now() WHERE id = $1`, [groupDay.id]);
          await t.query(`UPDATE bookings SET price_cents = $2, price_kind = 'group', updated_at = now()
                          WHERE group_day_id = $1 AND status IN ('confirmed','completed')`, [groupDay.id, groupDay.group_price_cents]);
          unlocked = true;
        }
      } else if (community && vendor.hoa_resident_pct != null && list != null) {
        price = discounted(list, vendor.hoa_resident_pct);
        kind = "resident";
      }
      const [b] = await t.query(
        `INSERT INTO bookings (vendor_id, service_id, starts_at, ends_at, blocked_until, customer_name, customer_phone,
                               customer_email, address, neighborhood, notes, price_cents, manage_token_hash, area_id,
                               community_id, group_day_id, list_price_cents, price_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [vendor.id, service.id, start, ends, blocked, input.name, input.phone, input.email, input.address,
         input.neighborhood, input.notes, price, sha256(token), areaId,
         community?.id || null, groupDay?.id || null, community ? list : null, kind]
      );
      await t.query(`INSERT INTO booking_events (booking_id, type, actor, data) VALUES ($1,'created',$2,$3)`,
        [b.id, actor, JSON.stringify({ start: start.toISOString(), ...(kind ? { price: kind } : {}) })]);
      return b;
    }, now, null, groupDay);
    if (row) {
      await notifyBooking("created", row.id, { manageToken: token });
      if (unlocked) await notifyGroupUnlocked(groupDay.id, { except: row.id });
      return { booking: await bookingView(row.id), manageToken: token, groupUnlocked: unlocked };
    }
  }
  throw conflict(input.vendorId ? "Sorry, that time was just taken. Please pick another time." : "Sorry, that time was just taken. Please pick another.", "slot_taken");
}

/** Booking as shown to the customer, vendor or admin. */
export async function bookingView(id) {
  const [b] = await db().query(
    `SELECT b.id, b.status, b.starts_at, b.ends_at, b.customer_name, b.customer_phone, b.customer_email,
            b.address, b.neighborhood, b.notes, b.price_cents, b.created_at, b.cancel_reason, b.cancelled_by,
            s.slug AS service_slug, s.name AS service_name,
            v.id AS vendor_id, v.name AS vendor_name, v.business_name AS vendor_business, v.timezone, v.photo_version AS vendor_photo_version,
            b.payment_status, b.amount_charged_cents, b.platform_fee_cents, b.amount_refunded_cents, b.paid_at,
            b.price_kind, b.list_price_cents, b.group_day_id, c.name AS community_name,
            CASE WHEN b.tip_status = 'paid' THEN b.tip_cents END AS tip_cents
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id
       LEFT JOIN communities c ON c.id = b.community_id
      WHERE b.id = $1`,
    [id]
  );
  if (!b) throw notFound("Booking not found.");
  return b;
}

export async function bookingIdByToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw notFound("Booking not found.");
  const [b] = await db().query(`SELECT id FROM bookings WHERE manage_token_hash = $1`, [sha256(token)]);
  if (!b) throw notFound("Booking not found.");
  return b.id;
}

export async function cancelBooking(id, { actor, reason = null, now = new Date() }) {
  const row = await db().tx(async (t) => {
    const [b] = await t.query(`SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id]);
    if (!b) throw notFound("Booking not found.");
    if (b.status === "cancelled") return null;
    if (b.status !== "confirmed") throw conflict("This booking can no longer be cancelled.", "not_cancellable");
    if (actor === "customer" && new Date(b.starts_at) <= now) throw conflict("This appointment has already started. Please call us.", "too_late");
    const [u] = await t.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_by = $2, cancel_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, actor, reason]
    );
    await t.query(`INSERT INTO booking_events (booking_id, type, actor, data) VALUES ($1,'cancelled',$2,$3)`,
      [id, actor, JSON.stringify({ reason })]);
    return u;
  });
  if (row) await notifyBooking("cancelled", id);
  return bookingView(id);
}

/** Move a booking. Keeps the same vendor; if they're not free, another vendor for the service can take it. */
export async function rescheduleBooking(id, newStart, { actor, now = new Date(), keepVendor = false }) {
  const q = db().query;
  const [b] = await q(`SELECT * FROM bookings WHERE id = $1`, [id]);
  if (!b) throw notFound("Booking not found.");
  if (b.status !== "confirmed") throw conflict("Only upcoming bookings can be moved.", "not_movable");
  if (actor === "customer" && new Date(b.starts_at) <= now) throw conflict("This appointment has already started. Please call us.", "too_late");
  if (b.group_day_id) throw conflict("Group-day bookings can't be moved. Cancel this one and pick another slot on the group day.", "group_day_fixed");

  const all = await vendorsFor(q, b.service_id);
  const same = all.filter((v) => v.id === b.vendor_id);
  const others = keepVendor ? [] : all.filter((v) => v.id !== b.vendor_id);
  // A vendor moving their own booking may move it outside their usual rules? No — same rules apply,
  // so a customer never ends up in a slot the vendor didn't open.
  for (const v of [...same, ...others]) {
    const row = await tryVendor(v, newStart, async (t, vendor) => {
      const [cur] = await t.query(`SELECT status FROM bookings WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur || cur.status !== "confirmed") throw conflict("Only upcoming bookings can be moved.", "not_movable");
      const ends = new Date(+newStart + vendor.duration_min * 60_000);
      const blocked = new Date(+ends + vendor.buffer_min * 60_000);
      // A resident keeps resident pricing if the new pro is in the program too
      const resident = !!b.community_id && vendor.hoa_resident_pct != null && vendor.price_cents != null;
      const [u] = await t.query(
        `UPDATE bookings SET vendor_id = $2, starts_at = $3, ends_at = $4, blocked_until = $5, price_cents = $6,
                list_price_cents = $7, price_kind = $8, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, vendor.id, newStart, ends, blocked, resident ? discounted(vendor.price_cents, vendor.hoa_resident_pct) : vendor.price_cents,
         b.community_id ? vendor.price_cents : null, resident ? "resident" : null]
      );
      await t.query(`INSERT INTO booking_events (booking_id, type, actor, data) VALUES ($1,'rescheduled',$2,$3)`,
        [id, actor, JSON.stringify({ from: b.starts_at, to: newStart.toISOString(), fromVendor: b.vendor_id, toVendor: vendor.id })]);
      return u;
    }, now, id);
    if (row) {
      await notifyBooking("rescheduled", id, { previousVendorId: b.vendor_id, previousStart: b.starts_at });
      return bookingView(id);
    }
  }
  throw conflict("That time isn't available. Please pick another.", "slot_taken");
}

export async function setBookingStatus(id, status, { actor }) {
  if (!["completed", "no_show"].includes(status)) throw bad("Unknown status.");
  const rows = await db().tx(async (t) => {
    const [b] = await t.query(`SELECT status, starts_at FROM bookings WHERE id = $1 FOR UPDATE`, [id]);
    if (!b) throw notFound("Booking not found.");
    if (b.status !== "confirmed" && b.status !== "completed" && b.status !== "no_show") throw conflict("Cancelled bookings can't be changed.");
    await t.query(`UPDATE bookings SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
    await t.query(`INSERT INTO booking_events (booking_id, type, actor) VALUES ($1,$2,$3)`, [id, status, actor]);
    return true;
  });
  return rows && bookingView(id);
}

export async function bookingEvents(id) {
  return db().query(`SELECT type, actor, data, at FROM booking_events WHERE booking_id = $1 ORDER BY id`, [id]);
}
