// Booking emails to the customer and the vendor.
// Sent through Resend when RESEND_API_KEY and MAIL_FROM are set; otherwise logged.
// A failed email never fails the booking itself.

import { DateTime } from "luxon";
import { db } from "./db.mjs";

const SITE = () => (process.env.SITE_URL || "https://neighborhoodperks.com").replace(/\/$/, "");
export const sent = []; // last few messages, for tests and the local dev server

/**
 * Accepts the sender in the forms people actually type into a settings box:
 *   bookings@x.com · Neighborhood Perks <bookings@x.com> · "Neighborhood Perks <bookings@x.com>"
 * Strips wrapping/curly quotes and fixes spacing; returns null if there's no usable address.
 */
export function normalizeFrom(raw) {
  let v = String(raw || "").trim().replace(/[“”„]/g, '"').replace(/[‘’]/g, "'").replace(/[‹〈＜]/g, "<").replace(/[›〉＞]/g, ">");
  while (/^(["'`]).*\1$/.test(v)) v = v.slice(1, -1).trim();
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const m = v.match(EMAIL);
  if (!m) return null;
  const name = v.slice(0, m.index).replace(/[<>"']/g, "").trim();
  return name ? `${name} <${m[0]}>` : m[0];
}

export async function sendEmail({ to, subject, text, replyTo }) {
  const msg = { to, subject, text };
  sent.push(msg);
  if (sent.length > 50) sent.shift();
  const key = (process.env.RESEND_API_KEY || "").trim();
  const rawFrom = (process.env.MAIL_FROM || "").trim();
  const from = normalizeFrom(rawFrom);
  if (rawFrom && !from) {
    console.error("email not sent: MAIL_FROM has no valid address:", JSON.stringify(rawFrom));
    return { ok: false, error: `MAIL_FROM doesn't contain an email address. It's set to: ${JSON.stringify(rawFrom).slice(0, 120)}` };
  }
  if (!key || !from) {
    const missing = [!key && "RESEND_API_KEY", !from && "MAIL_FROM"].filter(Boolean);
    if (process.env.NODE_ENV !== "test") console.log(`[email skipped: missing ${missing.join(", ")}] to=${to} subject=${subject}`);
    return { ok: false, skipped: true, missing };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text, reply_to: (replyTo || process.env.MAIL_REPLY_TO || "").trim() || undefined }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error("email failed", res.status, body);
      let error = body;
      try { error = JSON.parse(body).message || body; } catch {}
      return { ok: false, status: res.status, error: String(error).slice(0, 300) };
    }
    let id = null;
    try { id = JSON.parse(body).id; } catch {}
    return { ok: true, id };
  } catch (err) {
    console.error("email failed", err);
    return { ok: false, error: String(err.message || err).slice(0, 300) };
  }
}

const when = (iso, tz) => DateTime.fromJSDate(new Date(iso), { zone: tz }).toFormat("cccc, LLLL d 'at' h:mm a");
const money = (c) => `$${(c / 100).toFixed(2)}`;

/** The price line for a resident or group-day booking, or null. */
function priceLine(b) {
  if (!b.price_kind || b.price_cents == null) return null;
  const was = b.list_price_cents != null && b.list_price_cents > b.price_cents ? ` (usually ${money(b.list_price_cents)})` : "";
  return b.price_kind === "group"
    ? `Group-day price: from ${money(b.price_cents)}${was}.`
    : `Resident price for ${b.community_name}: from ${money(b.price_cents)}${was}.`;
}

export async function notifyBooking(type, bookingId, extra = {}) {
  try {
    const [b] = await db().query(
      `SELECT b.*, s.name AS service_name, v.name AS vendor_name, v.email AS vendor_email, v.timezone, c.name AS community_name
         FROM bookings b JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id
         LEFT JOIN communities c ON c.id = b.community_id WHERE b.id = $1`,
      [bookingId]
    );
    if (!b) return;
    const at = when(b.starts_at, b.timezone);
    const phone = process.env.BUSINESS_PHONE || "(619) 736-3618";
    const manage = `${SITE()}/booking/`;
    const custLines = {
      created: [`You're booked for ${b.service_name} on ${at}.`, "", `Address: ${b.address}`,
        ...(priceLine(b) ? [priceLine(b)] : []),
        ...(b.group_day_id ? ["This is a group-day booking: when enough neighbors book, everyone's price drops, and we'll email you if it does."] : []),
        "", `See, move or cancel your booking: ${manage}?t=${extra.manageToken}`, `Or call/text us at ${phone}.`],
      cancelled: [`Your ${b.service_name} appointment on ${at} has been cancelled.`, "", `Questions? Call or text ${phone}.`],
      rescheduled: [`Your ${b.service_name} appointment is now on ${at}.`, "", "Your link from the first confirmation email still works for any other changes.", `Questions? Call or text ${phone}.`],
    }[type];
    const subjects = {
      created: `Booked: ${b.service_name}, ${at}`,
      cancelled: `Cancelled: ${b.service_name}, ${at}`,
      rescheduled: `New time: ${b.service_name}, ${at}`,
    };
    await sendEmail({ to: b.customer_email, subject: subjects[type], text: [`Hi ${b.customer_name},`, "", ...custLines, "", "Neighborhood Perks"].join("\n") });

    const vendorText = [
      `${type === "created" ? "New booking" : type === "cancelled" ? "Booking cancelled" : "Booking moved"}: ${b.service_name}`,
      `When: ${at}`,
      `Customer: ${b.customer_name}, ${b.customer_phone}`,
      `Address: ${b.address}${b.neighborhood ? ` (${b.neighborhood})` : ""}`,
      b.community_name ? `HOA resident: ${b.community_name}${b.group_day_id ? " (group day)" : ""}` : null,
      priceLine(b),
      b.notes ? `Notes: ${b.notes}` : null,
      "",
      `Your calendar: ${SITE()}/vendor/`,
    ].filter((l) => l !== null).join("\n");
    await sendEmail({ to: b.vendor_email, subject: `${subjects[type]} (${b.customer_name})`, text: vendorText });

    if (type === "rescheduled" && extra.previousVendorId && extra.previousVendorId !== b.vendor_id) {
      const [pv] = await db().query(`SELECT email, timezone FROM vendors WHERE id = $1`, [extra.previousVendorId]);
      if (pv) await sendEmail({ to: pv.email, subject: `Booking moved off your calendar: ${b.service_name}`,
        text: `The ${b.service_name} booking for ${b.customer_name} on ${when(extra.previousStart, pv.timezone)} was moved to another provider. It's no longer on your calendar.` });
    }
  } catch (err) {
    console.error("notifyBooking failed", err);
  }
}

/** A group day just reached its minimum: tell everyone booked on it (and the pro) about the lower price. */
export async function notifyGroupUnlocked(groupDayId, { except = null } = {}) {
  try {
    const [gd] = await db().query(
      `SELECT g.*, s.name AS service_name, c.name AS community_name, v.email AS vendor_email, v.timezone
         FROM group_days g JOIN services s ON s.id = g.service_id JOIN communities c ON c.id = g.community_id
         JOIN vendors v ON v.id = g.vendor_id WHERE g.id = $1`, [groupDayId]);
    if (!gd) return;
    const day = DateTime.fromJSDate(new Date(gd.starts_at), { zone: gd.timezone }).toFormat("cccc, LLLL d");
    const rows = await db().query(
      `SELECT id, customer_name, customer_email FROM bookings WHERE group_day_id = $1 AND status = 'confirmed'`, [groupDayId]);
    for (const r of rows) {
      if (r.id === except) continue;
      await sendEmail({ to: r.customer_email, subject: `Group price unlocked: ${gd.service_name}, ${day}`,
        text: [`Hi ${r.customer_name},`, "", `Enough of your ${gd.community_name} neighbors booked ${gd.service_name} on ${day}, so the group price is on:`,
          `from ${money(gd.group_price_cents)} (usually ${money(gd.list_price_cents)}).`, "", "Nothing for you to do. Your booking stays the same, at the lower price.", "", "Neighborhood Perks"].join("\n") });
    }
    await sendEmail({ to: gd.vendor_email, subject: `Your ${gd.community_name} group day is on: ${day}`,
      text: [`${gd.service_name} on ${day} reached ${gd.min_homes} homes, so it now runs at the group price (from ${money(gd.group_price_cents)}).`,
        gd.common_area_job ? `Don't forget the common-area job you offered: ${gd.common_area_job}` : null,
        "", `Your calendar: ${SITE()}/vendor/`].filter((l) => l !== null).join("\n") });
  } catch (err) {
    console.error("notifyGroupUnlocked failed", err);
  }
}

/** A pro opened a group day: let the HOA contact know so they can share it. */
export async function notifyGroupDayCreated(groupDayId) {
  try {
    const [gd] = await db().query(
      `SELECT g.*, s.name AS service_name, c.name AS community_name, c.contact_name, c.contact_email, c.join_code,
              v.name AS vendor_name, v.business_name, v.timezone
         FROM group_days g JOIN services s ON s.id = g.service_id JOIN communities c ON c.id = g.community_id
         JOIN vendors v ON v.id = g.vendor_id WHERE g.id = $1`, [groupDayId]);
    if (!gd || !gd.contact_email) return;
    const day = DateTime.fromJSDate(new Date(gd.starts_at), { zone: gd.timezone }).toFormat("cccc, LLLL d");
    const link = `${SITE()}/community/?code=${encodeURIComponent(gd.join_code)}`;
    await sendEmail({ to: gd.contact_email, subject: `New group day for ${gd.community_name}: ${gd.service_name}, ${day}`,
      text: [`Hi${gd.contact_name ? " " + gd.contact_name : ""},`, "",
        `${gd.business_name || gd.vendor_name} has opened a ${gd.service_name} group day for ${gd.community_name} residents on ${day}.`,
        `Resident price: from ${money(gd.resident_price_cents)}. Once ${gd.min_homes} homes book, everyone pays from ${money(gd.group_price_cents)} (usually ${money(gd.list_price_cents)}).`,
        gd.common_area_job ? `Free for the community when it fills: ${gd.common_area_job}` : null,
        "", "If you'd like to share it with residents, here's the link:", link, "", "Neighborhood Perks"].filter((l) => l !== null).join("\n") });
  } catch (err) {
    console.error("notifyGroupDayCreated failed", err);
  }
}
