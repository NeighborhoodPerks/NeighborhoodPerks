// iCalendar feed so a vendor can subscribe from Google Calendar, Apple Calendar or Outlook.
// The URL holds a random secret token; it can be rotated from the dashboard.

import { db } from "./db.mjs";
import { notFound } from "./http.mjs";

const esc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// RFC 5545: lines over 75 octets are folded with CRLF + space
function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < bytes.length) {
    let end = Math.min(i + (parts.length ? 74 : 75), bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 character
    parts.push(bytes.subarray(i, end).toString("utf8"));
    i = end;
  }
  return parts.join("\r\n ");
}

export async function icsFeed(token) {
  if (!/^[A-Za-z0-9_-]{16,60}$/.test(token || "")) throw notFound();
  const [v] = await db().query(`SELECT id, name FROM vendors WHERE ics_token = $1 AND active`, [token]);
  if (!v) throw notFound();
  const bookings = await db().query(
    `SELECT b.id, b.starts_at, b.ends_at, b.status, b.updated_at, b.customer_name, b.customer_phone, b.address, b.notes, s.name AS service
       FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.vendor_id = $1 AND b.starts_at > now() - interval '60 days' AND b.starts_at < now() + interval '400 days'
      ORDER BY b.starts_at`,
    [v.id]
  );
  const off = await db().query(
    `SELECT id, starts_at, ends_at, note FROM time_off WHERE vendor_id = $1 AND ends_at > now() - interval '60 days'`,
    [v.id]
  );
  const now = stamp(new Date());
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Neighborhood Perks//Bookings//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc("Neighborhood Perks – " + v.name)}`, "X-PUBLISHED-TTL:PT15M", "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
  ];
  for (const b of bookings) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:booking-${b.id}@neighborhoodperks.com`,
      `DTSTAMP:${now}`,
      `LAST-MODIFIED:${stamp(b.updated_at)}`,
      `DTSTART:${stamp(b.starts_at)}`,
      `DTEND:${stamp(b.ends_at)}`,
      `SUMMARY:${esc(`${b.status === "cancelled" ? "CANCELLED: " : ""}${b.service} – ${b.customer_name}`)}`,
      `LOCATION:${esc(b.address)}`,
      `DESCRIPTION:${esc([`Phone: ${b.customer_phone}`, b.notes ? `Notes: ${b.notes}` : ""].filter(Boolean).join("\n"))}`,
      `STATUS:${b.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT"
    );
  }
  for (const t of off) {
    lines.push("BEGIN:VEVENT", `UID:timeoff-${t.id}@neighborhoodperks.com`, `DTSTAMP:${now}`,
      `DTSTART:${stamp(t.starts_at)}`, `DTEND:${stamp(t.ends_at)}`, `SUMMARY:${esc("Blocked" + (t.note ? `: ${t.note}` : ""))}`,
      "TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
