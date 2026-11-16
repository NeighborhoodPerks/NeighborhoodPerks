// Quotes: for work nobody can price before seeing it (plumbing, landscaping, roofing…).
//
//   requested → the customer described the job (and maybe added photos) to one pro
//   quoted    → the pro sent a price, how long the job takes, and how long the price holds
//   accepted  → the customer picked a time on that pro's calendar; a normal booking exists at the
//               quoted price, so anything above it at the end still needs the customer's OK (payments.mjs)
//   declined  → the customer said no to the price      passed  → the pro chose not to quote
//   expired   → the pro never answered, or the price ran out (sweep.mjs)
//
// The customer's private link (/quote/?t=) is their only key, like /booking/?t=.

import { DateTime } from "luxon";
import { db } from "./db.mjs";
import { bad, conflict, notFound, forbidden, str, int } from "./http.mjs";
import { newToken, sha256 } from "./crypto.mjs";
import { sendEmail } from "./notify.mjs";
import { imageFromDataUrl } from "./images.mjs";
import { createBooking, BUSINESS_TZ } from "./bookings.mjs";
import { attachCardToBooking, paymentsEnabled } from "./payments.mjs";

const SITE = () => (process.env.SITE_URL || "https://neighborhoodperks.com").replace(/\/$/, "");
const PHONE = () => process.env.BUSINESS_PHONE || "(619) 736-3618";
const money = (c) => `$${(c / 100).toFixed(2)}`;
const day = (iso) => DateTime.fromJSDate(new Date(iso), { zone: BUSINESS_TZ }).toFormat("cccc, LLLL d");
const hours = (min) => (min < 60 ? `${min} minutes` : min % 60 ? `${(min / 60).toFixed(1)} hours` : `${min / 60} hour${min > 60 ? "s" : ""}`);

export const MAX_QUOTE_PHOTOS = 3;
const MAX_PHOTO = 600_000;

// --- the customer asks -------------------------------------------------------------------

/**
 * input: vendorId, serviceSlug, areaSlug, details, name, phone, email, address, userId, photos (data URLs).
 * Only a pro who takes quotes for that service, in that neighborhood, can be asked.
 */
export async function requestQuote(input) {
  const photos = (input.photos || []).slice(0, MAX_QUOTE_PHOTOS + 1);
  if (photos.length > MAX_QUOTE_PHOTOS) throw bad(`Add up to ${MAX_QUOTE_PHOTOS} photos.`, "too_many_photos");
  const images = photos.map((p) => imageFromDataUrl(p, { maxBytes: MAX_PHOTO, tooLarge: "One of those photos is too large. Please use smaller ones." }));
  const [pro] = await db().query(
    `SELECT v.id, v.name, v.email, s.id AS service_id, s.name AS service_name, a.id AS area_id, a.name AS area_name
       FROM vendors v
       JOIN vendor_services vs ON vs.vendor_id = v.id AND vs.active AND vs.quotes
       JOIN services s ON s.id = vs.service_id AND s.slug = $2 AND s.active
       JOIN areas a ON a.slug = $3 AND a.active
       JOIN vendor_areas va ON va.vendor_id = v.id AND va.area_id = a.id
      WHERE v.id = $1 AND v.active AND (NOT $4::boolean OR v.stripe_charges_enabled)`,
    [input.vendorId, input.serviceSlug, input.areaSlug, paymentsEnabled()]);
  if (!pro) throw conflict("That pro isn't taking quote requests for this in your neighborhood.", "no_quotes");
  const token = newToken(24);
  const q = await db().tx(async (t) => {
    const [row] = await t.query(
      `INSERT INTO quotes (vendor_id, service_id, area_id, customer_name, customer_phone, customer_email, address, details, customer_user_id, token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [pro.id, pro.service_id, pro.area_id, input.name, input.phone, input.email, input.address, input.details, input.userId || null, sha256(token)]);
    for (const [i, img] of images.entries()) {
      await t.query(`INSERT INTO quote_photos (quote_id, n, mime, data) VALUES ($1,$2,$3,$4)`, [row.id, i + 1, img.mime, img.data]);
    }
    return row;
  });
  const first = pro.name.split(" ")[0];
  await sendEmail({ to: q.customer_email, subject: `Quote requested: ${pro.service_name} with ${pro.name}`,
    text: [`Hi ${q.customer_name},`, "", `We sent your ${pro.service_name.toLowerCase()} request to ${pro.name}. ${first} will reply with a price, usually within 2 days. Nothing is booked or charged until you accept it.`, "",
      `See your request: ${SITE()}/quote/?t=${token}`, "", `Questions? Call or text ${PHONE()}.`, "", "Neighborhood Perks"].join("\n") });
  await sendEmail({ to: pro.email, subject: `Quote request: ${pro.service_name} (${q.customer_name}, ${pro.area_name})`,
    text: [`${q.customer_name} in ${pro.area_name} would like a quote for ${pro.service_name.toLowerCase()}:`, "", q.details, "",
      ...(images.length ? [`They added ${images.length} photo${images.length > 1 ? "s" : ""}.`, ""] : []),
      `Address: ${q.address}`, `Phone: ${q.customer_phone}`, "",
      `Send your price from your dashboard: ${SITE()}/vendor/?tab=quotes`, "Customers book much more often when they hear back the same day."].join("\n") });
  return { quote: publicQuote(await quoteView(q.id)), token };
}

// --- reading ---------------------------------------------------------------------------------

async function quoteView(id) {
  const [q] = await db().query(
    `SELECT q.*, s.name AS service_name, s.slug AS service_slug, a.name AS area_name, a.slug AS area_slug,
            v.name AS vendor_name, v.business_name AS vendor_business, v.email AS vendor_email, v.photo_version AS vendor_photo_version,
            (SELECT count(*)::int FROM quote_photos p WHERE p.quote_id = q.id) AS photos,
            b.starts_at AS booked_at
       FROM quotes q JOIN services s ON s.id = q.service_id JOIN areas a ON a.id = q.area_id JOIN vendors v ON v.id = q.vendor_id
       LEFT JOIN bookings b ON b.id = q.booking_id
      WHERE q.id = $1`, [id]);
  if (!q) throw notFound("Quote not found.");
  return q;
}

/** What the customer sees on /quote/?t= */
export function publicQuote(q) {
  return {
    status: q.status, service_name: q.service_name, service_slug: q.service_slug, area_name: q.area_name,
    vendor_id: q.vendor_id, vendor_first_name: q.vendor_name.split(" ")[0], vendor_business: q.vendor_business,
    vendor_photo_url: q.vendor_photo_version ? `/api/pros/${q.vendor_id}/photo?v=${q.vendor_photo_version}` : null,
    customer_name: q.customer_name, customer_email: q.customer_email, customer_phone: q.customer_phone,
    details: q.details, address: q.address, photos: q.photos, created_at: q.created_at,
    price_cents: q.price_cents, duration_min: q.duration_min, message: q.message, valid_until: q.valid_until, quoted_at: q.quoted_at,
    response_note: q.status === "passed" ? q.response_note : null, booked_at: q.booked_at,
  };
}

export async function quoteIdByToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw notFound("Quote not found.");
  const [q] = await db().query(`SELECT id FROM quotes WHERE token_hash = $1`, [sha256(token)]);
  if (!q) throw notFound("Quote not found.");
  return q.id;
}

export async function customerQuote(token) {
  return publicQuote(await quoteView(await quoteIdByToken(token)));
}

/** The pro's (or, for admins, everyone's) quotes: open requests first. */
export async function listQuotes(vendorId) {
  return db().query(
    `SELECT q.id, q.status, q.customer_name, q.customer_phone, q.customer_email, q.address, q.details, q.created_at,
            q.price_cents, q.duration_min, q.message, q.valid_until, q.quoted_at, q.responded_at, q.response_note, q.booking_id,
            s.name AS service_name, a.name AS area_name, v.name AS vendor_name,
            (SELECT count(*)::int FROM quote_photos p WHERE p.quote_id = q.id) AS photos
       FROM quotes q JOIN services s ON s.id = q.service_id JOIN areas a ON a.id = q.area_id JOIN vendors v ON v.id = q.vendor_id
      WHERE ($1::uuid IS NULL OR q.vendor_id = $1::uuid)
      ORDER BY (q.status = 'requested') DESC, (q.status = 'quoted') DESC, q.created_at DESC
      LIMIT 200`, [vendorId]);
}

export async function assertQuoteAccess(user, quoteId) {
  const [q] = await db().query(`SELECT vendor_id FROM quotes WHERE id = $1`, [quoteId]);
  if (!q) throw notFound("Quote not found.");
  if (user.role === "vendor" && q.vendor_id !== user.vendor_id) throw forbidden();
}

export async function quotePhoto(quoteId, n) {
  const [p] = await db().query(`SELECT mime, data FROM quote_photos WHERE quote_id = $1 AND n = $2`, [quoteId, n]);
  if (!p) throw notFound("Photo not found.");
  return p;
}

// --- the pro answers ---------------------------------------------------------------------------

/** Send (or revise, before the customer answers) a price. */
export async function sendQuote(quoteId, body, { actor }) {
  const price = Math.round(Number(body.price) * 100);
  if (!Number.isInteger(price) || price < 500 || price > 5_000_000) throw bad("Enter a price from $5 to $50,000.", "invalid_price");
  const duration = int(body.duration_min, "Job length", { min: 15, max: 720 });
  const validDays = int(body.valid_days ?? 14, "Valid for", { min: 1, max: 60 });
  const message = str(body.message, "Message", { optional: true, max: 1500 });
  const q = await db().tx(async (t) => {
    const [row] = await t.query(`SELECT status FROM quotes WHERE id = $1 FOR UPDATE`, [quoteId]);
    if (!row) throw notFound("Quote not found.");
    if (!["requested", "quoted"].includes(row.status)) throw conflict("This request is closed.", "quote_closed");
    await t.query(
      `UPDATE quotes SET status = 'quoted', price_cents = $2, duration_min = $3, message = $4, valid_until = now() + make_interval(days => $5),
              quoted_at = now(), customer_reminded_at = NULL, updated_at = now() WHERE id = $1`,
      [quoteId, price, duration, message, validDays]);
    return { revised: row.status === "quoted" };
  });
  const v = await quoteView(quoteId);
  const token = await freshToken(quoteId);
  await sendEmail({ to: v.customer_email, subject: `${q.revised ? "Updated quote" : "Your quote"}: ${v.service_name}, ${money(price)}`,
    text: [`Hi ${v.customer_name},`, "", `${v.vendor_name} ${q.revised ? "updated" : "sent"} a price for your ${v.service_name.toLowerCase()} job: ${money(price)}, about ${hours(duration)} of work.`,
      ...(message ? ["", message] : []), "",
      `The price holds until ${day(v.valid_until)}. Accept it and pick a time here:`, `${SITE()}/quote/?t=${token}`, "",
      "Your card is saved when you book and charged only after the job is done. If the job comes to more than the quote, we ask you first.", "",
      `Questions? Call or text ${PHONE()}.`, "", "Neighborhood Perks"].join("\n") });
  return listQuotes(v.vendor_id).then((rows) => rows.find((r) => r.id === quoteId));
}

/** The pro won't quote this one. The customer is told, with the pro's note if they left one. */
export async function passQuote(quoteId, body, { actor }) {
  const note = str(body.note, "Note", { optional: true, max: 500 });
  await db().tx(async (t) => {
    const [row] = await t.query(`SELECT status FROM quotes WHERE id = $1 FOR UPDATE`, [quoteId]);
    if (!row) throw notFound("Quote not found.");
    if (!["requested", "quoted"].includes(row.status)) throw conflict("This request is closed.", "quote_closed");
    await t.query(`UPDATE quotes SET status = 'passed', response_note = $2, responded_at = now(), updated_at = now() WHERE id = $1`, [quoteId, note]);
  });
  const v = await quoteView(quoteId);
  await sendEmail({ to: v.customer_email, subject: `${v.vendor_name} can't take your ${v.service_name.toLowerCase()} job`,
    text: [`Hi ${v.customer_name},`, "", `${v.vendor_name} isn't able to quote this job.` + (note ? ` Their note: "${note}"` : ""), "",
      `Other pros near you: ${SITE()}/book/?service=${v.service_slug}`, `Or call or text us at ${PHONE()} and we'll find someone.`, "", "Neighborhood Perks"].join("\n") });
  return { status: "passed" };
}

// --- the customer answers ----------------------------------------------------------------------

/** Accept the price and book a time on the pro's calendar. card: a confirmed card (payments.confirmedCard) or null. */
export async function acceptQuote(token, { start, card, userId = null }) {
  const id = await quoteIdByToken(token);
  // Claim the quote first, so two tabs can't book it twice; give it back if the time was taken
  const [claimed] = await db().query(
    `UPDATE quotes SET status = 'accepted', responded_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'quoted' AND valid_until > now() RETURNING *`, [id]);
  if (!claimed) {
    const v = await quoteView(id);
    if (v.status === "quoted") throw conflict(`This price ran out on ${day(v.valid_until)}. Ask ${v.vendor_name.split(" ")[0]} for a new one.`, "quote_expired");
    if (v.status === "accepted") throw conflict("You've already booked this job.", "quote_accepted");
    throw conflict("This quote isn't open any more.", "quote_closed");
  }
  const v = await quoteView(id);
  let created;
  try {
    created = await createBooking({
      vendorId: v.vendor_id, serviceSlug: v.service_slug, areaSlug: v.area_slug, start,
      name: v.customer_name, phone: v.customer_phone, email: v.customer_email, address: v.address, neighborhood: v.area_name,
      notes: `Quoted job: ${v.details}`.slice(0, 2000),
      quote: { id, priceCents: v.price_cents, durationMin: v.duration_min },
    });
  } catch (err) {
    await db().query(`UPDATE quotes SET status = 'quoted', responded_at = NULL WHERE id = $1 AND status = 'accepted' AND booking_id IS NULL`, [id]);
    throw err;
  }
  const booking = created.booking;
  await db().query(`UPDATE quotes SET booking_id = $2 WHERE id = $1`, [id, booking.id]);
  if (card) await attachCardToBooking(booking.id, card);
  const owner = userId || v.customer_user_id;
  if (owner) await db().query(`UPDATE bookings SET customer_user_id = $2 WHERE id = $1`, [booking.id, owner]);
  return { bookingId: booking.id, manageToken: created.manageToken };
}

export async function declineQuote(token, { reason = null } = {}) {
  const id = await quoteIdByToken(token);
  const [row] = await db().query(
    `UPDATE quotes SET status = 'declined', response_note = $2, responded_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'quoted' RETURNING id`, [id, reason]);
  if (!row) throw conflict("This quote isn't open any more.", "quote_closed");
  const v = await quoteView(id);
  await sendEmail({ to: v.vendor_email, subject: `${v.customer_name} passed on your ${money(v.price_cents)} quote`,
    text: [`${v.customer_name} decided not to go ahead with your ${v.service_name.toLowerCase()} quote (${money(v.price_cents)}).` + (reason ? ` Their reason: "${reason}"` : ""), "",
      `You can reach them at ${v.customer_phone}.`, `${SITE()}/vendor/?tab=quotes`].join("\n") });
  return { status: "declined" };
}

// --- helpers ---------------------------------------------------------------------------------------

/** A new private link for the customer (the old one stops working), for an email we're about to send. */
export async function freshToken(quoteId) {
  const token = newToken(24);
  await db().query(`UPDATE quotes SET token_hash = $2 WHERE id = $1`, [quoteId, sha256(token)]);
  return token;
}

export { quoteView, hours, day as quoteDay };
