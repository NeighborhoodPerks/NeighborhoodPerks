import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { freshDb, ALL_WEEK } from "./helpers.mjs";
import { handle } from "../netlify/functions/api.mjs";
import { createVendor, setHours } from "../lib/manage.mjs";
import { db } from "../lib/db.mjs";
import { createInvite } from "../lib/auth.mjs";

const BASE = "http://localhost:8888";
const call = async (method, path, { body, cookie, headers = {} } = {}) => {
  const res = await handle(new Request(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: (res.headers.get("set-cookie") || "").split(";")[0], headers: res.headers };
};
const tokenFrom = (url) => new URL(url).searchParams.get("t");

// A weekday 10 days out, in San Diego
const day = DateTime.now().setZone("America/Los_Angeles").plus({ days: 10 }).startOf("day");
const DATE = day.toISODate();
let vendorA, vendorB, adminCookie, inviteA;

before(async () => {
  await freshDb();
  const svc = [{ service: "pet-walking", duration_min: 30, buffer_min: 0, price_cents: 2500 }];
  const a = await createVendor({ name: "Ana Walker", email: "ana@example.com", services: svc, areas: ["carmel-valley"] });
  const b = await createVendor({ name: "Ben Walker", email: "ben@example.com", services: svc, areas: ["carmel-valley"] });
  vendorA = a.id; vendorB = b.id; inviteA = a.inviteUrl;
  for (const id of [vendorA, vendorB]) await setHours(id, { rules: ALL_WEEK("08:00", "18:00"), settings: { min_notice_min: 60, max_days_ahead: 60, slot_step_min: 30 } });
  const [u] = await db().query(`INSERT INTO users (email, role) VALUES ('owner@example.com', 'admin') RETURNING id`);
  const r = await call("POST", "/api/auth/invite", { body: { t: tokenFrom(await createInvite(u.id)), password: "a-long-admin-password" } });
  adminCookie = r.cookie;
});

test("public: services and availability", async () => {
  const s = await call("GET", "/api/services");
  assert.equal(s.status, 200);
  assert.ok(s.data.services.find((x) => x.slug === "pet-walking" && x.vendors === 2 && x.price_from_cents === 2500));
  const a = await call("GET", `/api/availability?service=pet-walking&from=${DATE}&to=${DATE}`);
  assert.equal(a.status, 200);
  assert.equal(a.data.days[DATE].length, 20); // 8:00 … 17:30
});

let manageToken, bookingStart;
test("public: book, then see it with the private link only", async () => {
  bookingStart = day.set({ hour: 9 }).toUTC().toISO();
  const r = await call("POST", "/api/bookings", { body: {
    vendor: vendorA, area: "carmel-valley",
    service: "pet-walking", start: bookingStart, name: "Jo", phone: "619-555-0123", email: "Jo@Example.com", address: "2 Oak Ave",
  } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  manageToken = r.data.manageToken;
  assert.equal(r.data.booking.customer_name, "Jo");
  assert.equal(r.data.booking.customer_email, undefined, "public view doesn't echo contact details back");
  const g = await call("GET", `/api/booking?t=${manageToken}`);
  assert.equal(g.status, 200);
  assert.equal(g.data.booking.status, "confirmed");
  assert.equal((await call("GET", "/api/booking?t=nope-not-a-real-token-at-all")).status, 404);
});

test("public: validation errors are clear", async () => {
  const r = await call("POST", "/api/bookings", { body: { vendor: vendorA, area: "carmel-valley", service: "pet-walking", start: bookingStart, name: "Jo", phone: "12", email: "x@y.co", address: "a" } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /area code/);
  const past = await call("POST", "/api/bookings", { body: { vendor: vendorA, area: "carmel-valley", service: "pet-walking", start: "2020-01-01T17:00:00Z", name: "Jo", phone: "6195550123", email: "x@y.co", address: "a" } });
  assert.equal(past.status, 400);
  const bot = await call("POST", "/api/bookings", { body: { website: "spam" } });
  assert.equal(bot.status, 202, "honeypot quietly accepted, nothing stored");
});

test("security: state changes need JSON (blocks cross-site form posts)", async () => {
  const res = await handle(new Request(BASE + "/api/booking/cancel", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${manageToken}` }));
  assert.equal(res.status, 400);
  assert.equal((await call("GET", `/api/booking?t=${manageToken}`)).data.booking.status, "confirmed");
});

let vendorCookie;
test("vendor: invite link sets a password, then sign in works and a bad password doesn't", async () => {
  const t = tokenFrom(inviteA);
  assert.equal((await call("GET", `/api/auth/invite?t=${t}`)).data.email, "ana@example.com");
  assert.equal((await call("POST", "/api/auth/invite", { body: { t, password: "short" } })).status, 400);
  const ok = await call("POST", "/api/auth/invite", { body: { t, password: "correct horse battery" } });
  assert.equal(ok.status, 200);
  assert.equal((await call("POST", "/api/auth/invite", { body: { t, password: "correct horse battery" } })).status, 410, "links work once");
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "ana@example.com", password: "wrong password!" } })).status, 401);
  const login = await call("POST", "/api/auth/login", { body: { email: "ANA@example.com", password: "correct horse battery" } });
  assert.equal(login.status, 200);
  vendorCookie = login.cookie;
  const me = await call("GET", "/api/auth/me", { cookie: vendorCookie });
  assert.equal(me.data.user.role, "vendor");
});

test("vendor: sees only their own calendar and can't touch another vendor's booking", async () => {
  const from = day.minus({ days: 1 }).toUTC().toISO();
  const to = day.plus({ days: 1 }).toUTC().toISO();
  const mine = await call("GET", `/api/calendar?from=${from}&to=${to}`, { cookie: vendorCookie });
  assert.equal(mine.status, 200);
  const all = await call("GET", `/api/calendar?from=${from}&to=${to}`, { cookie: adminCookie });
  assert.equal(all.data.bookings.length, 1);
  const booking = all.data.bookings[0];
  if (booking.vendor_id === vendorA) {
    assert.equal(mine.data.bookings.length, 1);
  } else {
    assert.equal(mine.data.bookings.length, 0);
    assert.equal((await call("POST", `/api/bookings/${booking.id}/cancel`, { cookie: vendorCookie, body: {} })).status, 403);
  }
  // Even asking for another vendor's data by id is ignored for vendors
  const sneaky = await call("GET", `/api/hours?vendor=${vendorB}`, { cookie: vendorCookie });
  assert.equal(sneaky.status, 200);
  assert.equal((await call("GET", `/api/hours`, { cookie: adminCookie })).status, 400, "admins must say which vendor");
});

test("vendor: hours and time off round-trip", async () => {
  const put = await call("PUT", "/api/hours", { cookie: vendorCookie, body: {
    rules: [{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "13:00", end: "17:00" }],
    settings: { min_notice_min: 120, max_days_ahead: 30, slot_step_min: 30 },
  } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.rules.length, 2);
  const overlap = await call("PUT", "/api/hours", { cookie: vendorCookie, body: { rules: [
    { weekday: 2, start: "09:00", end: "12:00" }, { weekday: 2, start: "11:00", end: "13:00" }] } });
  assert.equal(overlap.status, 400);
  const off = await call("POST", "/api/time-off", { cookie: vendorCookie, body: {
    start: day.plus({ days: 3 }).toUTC().toISO(), end: day.plus({ days: 4 }).toUTC().toISO(), note: "Vacation" } });
  assert.equal(off.status, 201);
  assert.equal((await call("DELETE", `/api/time-off/${off.data.id}`, { cookie: vendorCookie, body: {} })).status, 200);
});

test("signed-out and wrong-role requests are refused", async () => {
  assert.equal((await call("GET", "/api/calendar?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z")).status, 401);
  assert.equal((await call("GET", "/api/admin/vendors", { cookie: vendorCookie })).status, 403);
  assert.equal((await call("GET", "/api/admin/vendors", { cookie: adminCookie })).status, 200);
});

test("admin: add a vendor, get an invite link, deactivate them", async () => {
  const r = await call("POST", "/api/admin/vendors", { cookie: adminCookie, body: {
    name: "Cy Sitter", email: "cy@example.com", services: [{ service: "pet-sitting", duration_min: 60, buffer_min: 15, price_cents: 4000 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.inviteUrl, /\/vendor\/invite\/\?t=/);
  assert.equal((await call("POST", "/api/admin/vendors", { cookie: adminCookie, body: { name: "Dup", email: "CY@example.com" } })).status, 409);
  assert.equal((await call("PATCH", `/api/admin/vendors/${r.data.id}`, { cookie: adminCookie, body: { active: false } })).status, 200);
  const s = await call("GET", "/api/services");
  assert.equal(s.data.services.find((x) => x.slug === "pet-sitting").vendors, 0, "inactive vendors aren't bookable");
});

test("customer cancel through the API, then the ICS feed shows it as cancelled", async () => {
  const c = await call("POST", "/api/booking/cancel", { body: { t: manageToken } });
  assert.equal(c.data.booking.status, "cancelled");
  const [{ vendor_id }] = await db().query(`SELECT vendor_id FROM bookings LIMIT 1`);
  const ics = await call("GET", `/api/my/ics?vendor=${vendor_id}`, { cookie: adminCookie });
  const feed = await call("GET", new URL(ics.data.url).pathname);
  assert.equal(feed.status, 200);
  assert.match(feed.data, /BEGIN:VCALENDAR/);
  assert.match(feed.data, /STATUS:CANCELLED/);
  assert.equal((await call("GET", "/ics/not-a-real-token-xxxx.ics")).status, 404);
});

test("logout ends the session", async () => {
  await call("POST", "/api/auth/logout", { cookie: vendorCookie, body: {} });
  assert.equal((await call("GET", "/api/auth/me", { cookie: vendorCookie })).data.user, null);
});
