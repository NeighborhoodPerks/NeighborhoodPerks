import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { freshDb, ALL_WEEK } from "./helpers.mjs";
import { handle } from "../netlify/functions/api.mjs";
import { createVendor, setHours } from "../lib/manage.mjs";
import { sent } from "../lib/notify.mjs";
import { db } from "../lib/db.mjs";
import { createInvite } from "../lib/auth.mjs";

const BASE = "http://localhost:8888";
const call = async (method, path, { body, cookie } = {}) => {
  const res = await handle(new Request(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, data, cookie: setCookies.map((c) => c.split(";")[0]).join("; "), setCookies };
};
const linkToken = (text) => /[?&]t=([A-Za-z0-9_-]+)/.exec(text)[1];
const day = DateTime.now().setZone("America/Los_Angeles").plus({ days: 5 }).startOf("day");
let walker, adminCookie;

before(async () => {
  await freshDb();
  walker = (await createVendor({ name: "Wren Walker", email: "wren@example.com", areas: ["carmel-valley"],
    services: [{ service: "pet-walking", duration_min: 30, buffer_min: 0, price_cents: 2500 }] })).id;
  await setHours(walker, { rules: ALL_WEEK("08:00", "18:00"), settings: { min_notice_min: 0, max_days_ahead: 60, slot_step_min: 30 } });
  const [u] = await db().query(`INSERT INTO users (email, role) VALUES ('boss@example.com', 'admin') RETURNING id`);
  adminCookie = (await call("POST", "/api/auth/invite", { body: { t: linkToken(await createInvite(u.id)), password: "admin-password-123" } })).cookie;
});

const bookingBody = (hour, extra = {}) => ({
  vendor: walker, area: "carmel-valley", service: "pet-walking", start: day.set({ hour }).toUTC().toISO(),
  name: "Hana Home", phone: "6195550111", email: "hana@example.com", address: "3 Oak St", ...extra,
});

test("a guest booking stays a guest booking until the email is verified", async () => {
  const guest = await call("POST", "/api/bookings", { body: bookingBody(8) });
  assert.equal(guest.status, 201);
  assert.equal(guest.data.inAccount, false);

  // Someone signs up with that email: they must NOT see the guest booking yet
  sent.length = 0;
  const su = await call("POST", "/api/auth/signup", { body: { as: "customer", name: "Hana Home", email: "HANA@example.com", password: "hana-password-1" } });
  assert.equal(su.status, 201, JSON.stringify(su.data));
  assert.equal(su.data.role, "customer");
  assert.ok(su.setCookies.some((c) => c.startsWith("np_session=") && /HttpOnly/i.test(c)));
  assert.ok(su.setCookies.some((c) => c.startsWith("np_role=customer") && !/HttpOnly/i.test(c)));
  const before = await call("GET", "/api/account", { cookie: su.cookie });
  assert.equal(before.data.bookings.length, 0, "unverified accounts don't get guest bookings");
  assert.equal(before.data.profile.email_verified_at, null);

  // Clicking the emailed link verifies and claims the earlier booking
  const mail = sent.find((m) => m.to === "hana@example.com" && /Confirm your email/.test(m.subject));
  assert.ok(mail, "verification email sent");
  const v = await call("POST", "/api/auth/verify", { body: { t: linkToken(mail.text) } });
  assert.equal(v.data.linked, 1);
  const after = await call("GET", "/api/account", { cookie: su.cookie });
  assert.equal(after.data.bookings.length, 1);
  assert.equal((await call("POST", "/api/auth/verify", { body: { t: linkToken(mail.text) } })).status, 410, "links work once");

  // From now on, even a signed-out booking with this email lands in the account
  const later = await call("POST", "/api/bookings", { body: bookingBody(10, { email: "Hana@Example.com" }) });
  assert.equal(later.data.inAccount, true);
  assert.equal((await call("GET", "/api/account", { cookie: su.cookie })).data.bookings.length, 2);
});

test("homeowners see and manage only their own bookings", async () => {
  const other = await call("POST", "/api/auth/signup", { body: { as: "customer", name: "Ola Other", email: "ola@example.com", password: "ola-password-12" } });
  const mine = await call("POST", "/api/bookings", { cookie: other.cookie, body: bookingBody(12, { name: "Ola", email: "ola@example.com" }) });
  assert.equal(mine.data.inAccount, true, "signed-in bookings belong to the account right away");
  const acct = await call("GET", "/api/account", { cookie: other.cookie });
  assert.equal(acct.data.bookings.length, 1);
  const olaBooking = acct.data.bookings[0].id;

  const hana = await call("POST", "/api/auth/login", { body: { email: "hana@example.com", password: "hana-password-1" } });
  assert.equal(hana.data.role, "customer");
  assert.equal((await call("POST", `/api/account/bookings/${olaBooking}/cancel`, { cookie: hana.cookie, body: {} })).status, 403);
  assert.equal((await call("GET", `/api/availability?service=pet-walking&from=${day.toISODate()}&to=${day.toISODate()}&booking=${olaBooking}`, { cookie: hana.cookie })).status, 403);

  // Ola moves then cancels her own booking
  const avail = await call("GET", `/api/availability?service=pet-walking&from=${day.toISODate()}&to=${day.toISODate()}&booking=${olaBooking}`, { cookie: other.cookie });
  assert.equal(avail.status, 200);
  const to = avail.data.days[day.toISODate()].find((s) => s.startsWith(day.set({ hour: 15 }).toUTC().toISO().slice(0, 13)));
  const moved = await call("POST", `/api/account/bookings/${olaBooking}/reschedule`, { cookie: other.cookie, body: { start: to } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const cancelled = await call("POST", `/api/account/bookings/${olaBooking}/cancel`, { cookie: other.cookie, body: {} });
  assert.equal(cancelled.data.booking.status, "cancelled");

  // Customers can't reach the provider dashboard
  assert.equal((await call("GET", "/api/my/inbox", { cookie: other.cookie })).status, 403);
});

test("profile saves and duplicate emails are refused", async () => {
  const s = await call("POST", "/api/auth/login", { body: { email: "ola@example.com", password: "ola-password-12" } });
  const put = await call("PUT", "/api/account", { cookie: s.cookie, body: { name: "Ola O.", phone: "(619) 555-0177", address: "8 Bay Rd", area: "torrey-hills" } });
  assert.equal(put.status, 200);
  assert.equal(put.data.profile.area, "torrey-hills");
  const dup = await call("POST", "/api/auth/signup", { body: { as: "customer", name: "X", email: "OLA@example.com", password: "another-pass-1" } });
  assert.equal(dup.status, 409);
  assert.equal((await call("POST", "/api/auth/signup", { body: { as: "customer", name: "X", email: "x@example.com", password: "short" } })).status, 400);
});

test("forgot password: same answer for real and unknown emails; the link resets and signs in", async () => {
  sent.length = 0;
  const real = await call("POST", "/api/auth/forgot", { body: { email: "ola@example.com" } });
  const fake = await call("POST", "/api/auth/forgot", { body: { email: "nobody@example.com" } });
  assert.deepEqual(real.data, fake.data);
  assert.equal(sent.filter((m) => m.to === "nobody@example.com").length, 0);
  const mail = sent.find((m) => m.to === "ola@example.com");
  const t = linkToken(mail.text);
  assert.equal((await call("GET", `/api/auth/invite?t=${t}`)).data.email, "ola@example.com");
  const r = await call("POST", "/api/auth/invite", { body: { t, password: "brand-new-password" } });
  assert.equal(r.data.role, "customer");
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "ola@example.com", password: "ola-password-12" } })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "ola@example.com", password: "brand-new-password" } })).status, 200);
});

test("provider sign-up waits for approval before customers can see them", async () => {
  sent.length = 0;
  const su = await call("POST", "/api/auth/signup", { body: {
    as: "provider", name: "Pia Pool", business_name: "Pia's Pools", email: "pia@example.com", phone: "(619) 555-0188",
    password: "pia-password-12", services: ["pet-sitting"], areas: ["carmel-valley"] } });
  assert.equal(su.status, 201, JSON.stringify(su.data));
  assert.equal(su.data.role, "vendor");
  assert.ok(sent.some((m) => m.to === "boss@example.com" && /New provider application/.test(m.subject)), "admin is told");

  // Pending: can sign in and set up, but is invisible to customers
  const me = await call("GET", "/api/auth/me", { cookie: su.cookie });
  assert.equal(me.data.user.vendor_status, "pending");
  assert.equal((await call("GET", "/api/hours", { cookie: su.cookie })).status, 200);
  let pros = await call("GET", "/api/pros?area=carmel-valley");
  assert.ok(!pros.data.pros.some((p) => p.name === "Pia Pool"));
  const vendors = (await call("GET", "/api/admin/vendors", { cookie: adminCookie })).data.vendors;
  const pia = vendors.find((v) => v.email === "pia@example.com");
  assert.equal(pia.status, "pending");
  assert.equal(vendors[0].email, "pia@example.com", "pending applications are listed first");

  // "Resume" can't skip approval
  assert.equal((await call("PATCH", `/api/admin/vendors/${pia.id}`, { cookie: adminCookie, body: { active: true } })).status, 409);
  assert.equal((await call("POST", `/api/admin/vendors/${pia.id}/approve`, { cookie: su.cookie, body: {} })).status, 403, "can't approve yourself");
  assert.equal((await call("POST", `/api/admin/vendors/${pia.id}/approve`, { cookie: adminCookie, body: {} })).status, 200);
  pros = await call("GET", "/api/pros?area=carmel-valley");
  assert.ok(pros.data.pros.some((p) => p.name === "Pia Pool"), "visible once approved");
});

test("declined providers can't sign in", async () => {
  const su = await call("POST", "/api/auth/signup", { body: {
    as: "provider", name: "Dee Declined", email: "dee@example.com", phone: "6195550199", password: "dee-password-12",
    services: ["pet-walking"], areas: ["torrey-hills"] } });
  const dee = (await call("GET", "/api/admin/vendors", { cookie: adminCookie })).data.vendors.find((v) => v.email === "dee@example.com");
  await call("POST", `/api/admin/vendors/${dee.id}/decline`, { cookie: adminCookie, body: {} });
  assert.equal((await call("GET", "/api/auth/me", { cookie: su.cookie })).data.user, null, "existing session ended");
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "dee@example.com", password: "dee-password-12" } })).status, 403);
  assert.equal((await call("POST", "/api/auth/signup", { body: { as: "provider", name: "N", email: "n@example.com", phone: "6195550100",
    password: "n-password-123", services: [], areas: ["carmel-valley"] } })).status, 400, "must pick a service");
});

test("logout clears both cookies", async () => {
  const s = await call("POST", "/api/auth/login", { body: { email: "hana@example.com", password: "hana-password-1" } });
  const out = await call("POST", "/api/auth/logout", { cookie: s.cookie, body: {} });
  assert.ok(out.setCookies.some((c) => c.startsWith("np_session=;") && /Max-Age=0/.test(c)));
  assert.ok(out.setCookies.some((c) => c.startsWith("np_role=;") && /Max-Age=0/.test(c)));
  assert.equal((await call("GET", "/api/auth/me", { cookie: s.cookie })).data.user, null);
});
