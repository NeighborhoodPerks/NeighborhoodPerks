// Booking emails to the customer and the vendor.
// Sent through Resend when RESEND_API_KEY and MAIL_FROM are set; otherwise logged.
// A failed email never fails the booking itself.

import { DateTime } from "luxon";
import { db } from "./db.mjs";

const SITE = () => (process.env.SITE_URL || "https://neighborhoodperks.com").replace(/\/$/, "");
export const sent = []; // last few messages, for tests and the local dev server

export async function sendEmail({ to, subject, text, replyTo }) {
  const msg = { to, subject, text };
  sent.push(msg);
  if (sent.length > 50) sent.shift();
  const key = (process.env.RESEND_API_KEY || "").trim();
  const from = (process.env.MAIL_FROM || "").trim();
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

export async function notifyBooking(type, bookingId, extra = {}) {
  try {
    const [b] = await db().query(
      `SELECT b.*, s.name AS service_name, v.name AS vendor_name, v.email AS vendor_email, v.timezone
         FROM bookings b JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1`,
      [bookingId]
    );
    if (!b) return;
    const at = when(b.starts_at, b.timezone);
    const phone = process.env.BUSINESS_PHONE || "(619) 736-3618";
    const manage = `${SITE()}/booking/`;
    const custLines = {
      created: [`You're booked for ${b.service_name} on ${at}.`, "", `Address: ${b.address}`,
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
