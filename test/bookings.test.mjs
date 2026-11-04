import { test, before } from "node:test";
import assert from "node:assert/strict";
import { freshDb, ALL_WEEK } from "./helpers.mjs";
import { db } from "../lib/db.mjs";
import {
  availability, createBooking, cancelBooking, rescheduleBooking, bookingIdByToken, setBookingStatus,
} from "../lib/bookings.mjs";
import { createVendor, setHours, addTimeOff, calendarEvents, assertBookingAccess } from "../lib/manage.mjs";
import { sent } from "../lib/notify.mjs";

const NOW = new Date("2026-11-01T12:00:00Z"); // Sun Nov 1, 4 AM in San Diego
const MON = "2026-11-02";
const at = (hhmm, date = MON) => new Date(`${date}T${hhmm}:00-08:00`); // PST
let A, B;

const customer = (start, extra = {}) => ({
  serviceSlug: "window-rescreening", start, name: "Pat Neighbor", phone: "(619) 555-0101",
  email: "pat@example.com", address: "1 Elm St, San Diego", neighborhood: "Carmel Valley", notes: null, ...extra,
});

before(async () => {
  await freshDb();
  const svc = [{ service: "window-rescreening", duration_min: 60, buffer_min: 30, price_cents: 15000 }];
  A = (await createVendor({ name: "Alex Screens", email: "alex@example.com", services: svc })).id;
  B = (await createVendor({ name: "Bea Screens", email: "bea@example.com", services: svc })).id;
  for (const id of [A, B]) await setHours(id, { rules: ALL_WEEK("09:00", "17:00"), settings: { min_notice_min: 0, max_days_ahead: 60, slot_step_min: 30 } });
});

test("availability merges vendors and reports the starting price", async () => {
  const r = await availability({ serviceSlug: "window-rescreening", fromDate: MON, toDate: MON, now: NOW });
  assert.equal(r.vendorCount, 2);
  assert.equal(r.priceFromCents, 15000);
  assert.equal(r.days[MON].length, 15);
});

test("two vendors = two bookings at the same time, the third is refused", async () => {
  const start = at("10:00");
  const one = await createBooking(customer(start), { now: NOW });
  const two = await createBooking(customer(start, { email: "sam@example.com" }), { now: NOW });
  assert.notEqual(one.booking.vendor_id, two.booking.vendor_id);
  await assert.rejects(createBooking(customer(start), { now: NOW }), (e) => e.status === 409 && e.code === "slot_taken");
  const r = await availability({ serviceSlug: "window-rescreening", fromDate: MON, toDate: MON, now: NOW });
  assert.ok(!r.days[MON].includes(start.toISOString()), "full time is no longer offered");
});

test("ten people racing for one slot: exactly as many win as there are vendors", async () => {
  const start = at("14:00");
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => createBooking(customer(start, { email: `racer${i}@example.com` }), { now: NOW }))
  );
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 2);
  assert.ok(lost.every((r) => r.reason.code === "slot_taken"));
  const vendors = new Set(won.map((r) => r.value.booking.vendor_id));
  assert.equal(vendors.size, 2);
});

test("the database itself refuses an overlapping booking, even bypassing the app", async () => {
  const [svc] = await db().query(`SELECT id FROM services WHERE slug = 'window-rescreening'`);
  const insert = (s, e) => db().query(
    `INSERT INTO bookings (vendor_id, service_id, starts_at, ends_at, blocked_until, customer_name, customer_phone, customer_email, address, manage_token_hash)
     VALUES ($1,$2,$3,$4,$4,'x','x','x','x',$5)`, [A, svc.id, s, e, Math.random().toString()]);
  await insert(at("08:00", "2026-11-20"), at("09:00", "2026-11-20"));
  await assert.rejects(insert(at("08:30", "2026-11-20"), at("09:30", "2026-11-20")), (e) => e.code === "23P01");
});

test("buffer: a booking ending at 11:00 with 30 min buffer blocks an 11:00 start for that vendor", async () => {
  const day = "2026-11-03";
  const first = await createBooking(customer(at("10:00", day), { email: "buf1@example.com" }), { now: NOW });
  // Second booking at 11:00 must go to the *other* vendor
  const second = await createBooking(customer(at("11:00", day), { email: "buf2@example.com" }), { now: NOW });
  assert.notEqual(first.booking.vendor_id, second.booking.vendor_id);
  // 11:30 is fine for the first vendor again
  const third = await createBooking(customer(at("11:30", day), { email: "buf3@example.com" }), { now: NOW });
  assert.equal(third.booking.vendor_id, first.booking.vendor_id);
});

test("time off removes slots and can't silently swallow existing bookings", async () => {
  const day = "2026-11-04";
  await addTimeOff(A, { start: at("09:00", day).toISOString(), end: at("17:00", day).toISOString(), note: "Dentist" });
  const r = await availability({ serviceSlug: "window-rescreening", fromDate: day, toDate: day, now: NOW });
  assert.equal(r.days[day].length, 15, "Bea is still free all day");
  const b = await createBooking(customer(at("09:00", day), { email: "to@example.com" }), { now: NOW });
  assert.equal(b.booking.vendor_id, B, "only Bea can take it");
  await assert.rejects(addTimeOff(B, { start: at("08:00", day).toISOString(), end: at("12:00", day).toISOString() }),
    (e) => e.status === 409 && e.code === "has_bookings");
  await addTimeOff(B, { start: at("08:00", day).toISOString(), end: at("12:00", day).toISOString(), force: true });
});

test("customer link: look up, cancel frees the slot, cancel twice is harmless", async () => {
  const day = "2026-11-05";
  const { manageToken } = await createBooking(customer(at("09:00", day)), { now: NOW });
  const id = await bookingIdByToken(manageToken);
  await assert.rejects(bookingIdByToken(manageToken.slice(0, -2) + "xx"), (e) => e.status === 404);
  const c = await cancelBooking(id, { actor: "customer", now: NOW });
  assert.equal(c.status, "cancelled");
  await cancelBooking(id, { actor: "customer", now: NOW });
  const r = await availability({ serviceSlug: "window-rescreening", fromDate: day, toDate: day, now: NOW });
  assert.ok(r.days[day].includes(at("09:00", day).toISOString()));
});

test("reschedule moves the booking; a full time is refused; customer can't move a past booking", async () => {
  const day = "2026-11-06";
  const { booking } = await createBooking(customer(at("09:00", day)), { now: NOW });
  const moved = await rescheduleBooking(booking.id, at("13:00", day), { actor: "customer", now: NOW });
  assert.equal(new Date(moved.starts_at).toISOString(), at("13:00", day).toISOString());
  // Fill 15:00 on both vendors, then try to move there
  await createBooking(customer(at("15:00", day), { email: "f1@example.com" }), { now: NOW });
  await createBooking(customer(at("15:00", day), { email: "f2@example.com" }), { now: NOW });
  await assert.rejects(rescheduleBooking(booking.id, at("15:00", day), { actor: "customer", now: NOW }), (e) => e.code === "slot_taken");
  const later = new Date("2026-11-07T00:00:00Z");
  await assert.rejects(rescheduleBooking(booking.id, at("16:00", day), { actor: "customer", now: later }), (e) => e.code === "too_late");
});

test("moving a booking to a time that overlaps its own old slot works (it doesn't block itself)", async () => {
  const day = "2026-11-09";
  const { booking } = await createBooking(customer(at("10:00", day), { email: "self@example.com" }), { now: NOW });
  const moved = await rescheduleBooking(booking.id, at("10:30", day), { actor: "vendor", now: NOW, keepVendor: true });
  assert.equal(moved.vendor_id, booking.vendor_id);
});

test("completed bookings still block time; vendors only see their own", async () => {
  const day = "2026-11-10";
  const { booking } = await createBooking(customer(at("09:00", day)), { now: NOW });
  await setBookingStatus(booking.id, "completed", { actor: "vendor" });
  const other = booking.vendor_id === A ? B : A;
  await assert.rejects(assertBookingAccess({ role: "vendor", vendor_id: other }, booking.id), (e) => e.status === 403);
  await assertBookingAccess({ role: "vendor", vendor_id: booking.vendor_id }, booking.id);
  await assertBookingAccess({ role: "admin" }, booking.id);
  const cal = await calendarEvents({ vendorId: other, from: at("00:00", day), to: at("23:59", day) });
  assert.ok(!cal.bookings.some((b) => b.id === booking.id));
});

test("customer and vendor both get an email; the customer's has their private link", async () => {
  sent.length = 0;
  await createBooking(customer(at("16:00", "2026-11-11"), { email: "mail@example.com" }), { now: NOW });
  const cust = sent.find((m) => m.to === "mail@example.com");
  assert.ok(cust && /\/booking\/\?t=[A-Za-z0-9_-]{20,}/.test(cust.text));
  assert.ok(sent.some((m) => m.to === "alex@example.com" || m.to === "bea@example.com"));
});
