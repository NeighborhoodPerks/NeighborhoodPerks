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
  return { status: res.status, data, cookie: (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") };
};
const tokenIn = (s) => /[?&]t=([A-Za-z0-9_-]+)/.exec(s)[1];
const TZ = "America/Los_Angeles";
const day = (n) => DateTime.now().setZone(TZ).plus({ days: n }).startOf("day");
const at = (n, hour, minute = 0) => day(n).set({ hour, minute }).toUTC().toISO();

let screens, walker, screensCookie, walkerCookie, adminCookie, code, groupDayId;

before(async () => {
  await freshDb();
  const a = await createVendor({ name: "Sky Screens", email: "sky@example.com", areas: ["carmel-valley", "torrey-hills"],
    services: [{ service: "window-rescreening", duration_min: 120, buffer_min: 30, price_cents: 12000 }] });
  const b = await createVendor({ name: "Wally Walker", email: "wally@example.com", areas: ["carmel-valley"],
    services: [{ service: "pet-walking", duration_min: 30, buffer_min: 0, price_cents: 4000 }] });
  screens = a.id; walker = b.id;
  for (const id of [screens, walker]) await setHours(id, { rules: ALL_WEEK("08:00", "18:00"), settings: { min_notice_min: 0, max_days_ahead: 60, slot_step_min: 30 } });
  screensCookie = (await call("POST", "/api/auth/invite", { body: { t: tokenIn(a.inviteUrl), password: "sky-password-1" } })).cookie;
  walkerCookie = (await call("POST", "/api/auth/invite", { body: { t: tokenIn(b.inviteUrl), password: "wally-password-1" } })).cookie;
  const [u] = await db().query(`INSERT INTO users (email, role) VALUES ('owner@example.com','admin') RETURNING id`);
  adminCookie = (await call("POST", "/api/auth/invite", { body: { t: tokenIn(await createInvite(u.id)), password: "owner-password-1" } })).cookie;
});

const book = (body) => call("POST", "/api/bookings", { body: {
  name: "Rae Resident", phone: "6195550123", email: "rae@example.com", address: "1 Ridge Ct", ...body } });

test("admin sets up a community with a join code", async () => {
  const bad = await call("POST", "/api/admin/communities", { cookie: adminCookie, body: { name: "Carmel Ridge HOA", area: "nowhere" } });
  assert.equal(bad.data.code, "invalid_area");
  const r = await call("POST", "/api/admin/communities", { cookie: adminCookie, body: {
    name: "Carmel Ridge HOA", area: "carmel-valley", homes: 250, contact_name: "Pat", contact_email: "board@ridge.example" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = r.data.communities.find((x) => x.slug === "carmel-ridge-hoa");
  assert.match(c.join_code, /^CARMEL-[A-Z2-9]{4}$/);
  assert.equal(c.give_back_bps, 100, "1% give-back by default");
  code = c.join_code;
  // Saving again keeps the code; another community can't take it
  const again = await call("POST", "/api/admin/communities", { cookie: adminCookie, body: { name: "Carmel Ridge HOA", area: "carmel-valley", homes: 260 } });
  assert.equal(again.data.communities.find((x) => x.slug === "carmel-ridge-hoa").join_code, code);
  const dup = await call("POST", "/api/admin/communities", { cookie: adminCookie, body: { name: "Other HOA", area: "carmel-valley", join_code: code } });
  assert.equal(dup.data.code, "code_taken");
  assert.equal((await call("GET", "/api/admin/communities", { cookie: screensCookie })).status, 403, "admins only");
});

test("residents look up their community by code", async () => {
  assert.equal((await call("GET", "/api/community?code=NOPE-1234")).data.code, "invalid_community_code");
  const r = await call("GET", "/api/community?code=" + encodeURIComponent(" " + code.toLowerCase() + " "));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.community.name, "Carmel Ridge HOA");
  assert.equal(r.data.community.area.slug, "carmel-valley");
  assert.deepEqual(r.data.pros, [], "nobody has joined the program yet");
});

test("a pro joins the program with real discounts", async () => {
  const lo = await call("PUT", "/api/my/hoa", { cookie: screensCookie, body: { enabled: true, resident_pct: 5, group_pct: 15, group_min: 3 } });
  assert.equal(lo.status, 400, "resident discount is at least 10%");
  const inverted = await call("PUT", "/api/my/hoa", { cookie: screensCookie, body: { enabled: true, resident_pct: 12, group_pct: 10, group_min: 3 } });
  assert.equal(inverted.status, 400, "group discount is at least the resident discount");
  const ok = await call("PUT", "/api/my/hoa", { cookie: screensCookie, body: { enabled: true, resident_pct: 10, group_pct: 15, group_min: 3 } });
  assert.deepEqual(ok.data.settings, { enabled: true, resident_pct: 10, group_pct: 15, group_min: 3 });
  assert.deepEqual(ok.data.communities.map((c) => c.slug), ["carmel-ridge-hoa"]);
  const pub = await call("GET", "/api/community?code=" + code);
  assert.equal(pub.data.pros.length, 1);
  assert.equal(pub.data.pros[0].services[0].resident_price_cents, 10800);
  const pros = await call("GET", "/api/pros?area=carmel-valley");
  assert.deepEqual(pros.data.pros.find((p) => p.id === screens).hoa, { resident_pct: 10, group_pct: 15, group_min: 3 });
  assert.equal(pros.data.pros.find((p) => p.id === walker).hoa, null);
});

test("resident pricing on regular bookings, only where it applies", async () => {
  const r = await book({ vendor: screens, area: "carmel-valley", service: "window-rescreening", start: at(3, 8), community_code: code });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.booking.price_cents, 10800);
  assert.equal(r.data.booking.list_price_cents, 12000);
  assert.equal(r.data.booking.price_kind, "resident");
  assert.equal(r.data.booking.community_name, "Carmel Ridge HOA");
  assert.ok(sent.some((m) => m.to === "rae@example.com" && /Resident price for Carmel Ridge HOA: from \$108\.00 \(usually \$120\.00\)/.test(m.text)));
  assert.ok(sent.some((m) => m.to === "sky@example.com" && /HOA resident: Carmel Ridge HOA/.test(m.text)));

  // A pro outside the program: full price, but it still counts for the community (and its give-back)
  const w = await book({ vendor: walker, area: "carmel-valley", service: "pet-walking", start: at(3, 9), community_code: code });
  assert.equal(w.data.booking.price_cents, 4000);
  assert.equal(w.data.booking.price_kind, null);
  assert.equal(w.data.booking.community_name, "Carmel Ridge HOA");

  // The code is for Carmel Valley; booking in Torrey Hills is a regular booking
  const elsewhere = await book({ vendor: screens, area: "torrey-hills", service: "window-rescreening", start: at(3, 12), community_code: code });
  assert.equal(elsewhere.data.booking.price_cents, 12000);
  assert.equal(elsewhere.data.booking.community_name, null);

  assert.equal((await book({ vendor: screens, area: "carmel-valley", service: "window-rescreening", start: at(3, 15), community_code: "WRONG-0000" })).data.code, "invalid_community_code");
});

test("group days: validation, and the window is held for residents", async () => {
  const base = { community: "carmel-ridge-hoa", service: "window-rescreening", start: "08:00", end: "18:00" };
  assert.equal((await call("POST", "/api/my/group-days", { cookie: screensCookie, body: { ...base, date: day(1).toISODate() } })).data.code, "too_soon");
  assert.equal((await call("POST", "/api/my/group-days", { cookie: walkerCookie, body: { ...base, service: "pet-walking", date: day(6).toISODate() } })).data.code, "not_in_program");
  assert.equal((await call("POST", "/api/my/group-days", { cookie: screensCookie, body: { ...base, date: day(3).toISODate() } })).data.code, "has_bookings");
  sent.length = 0;
  const r = await call("POST", "/api/my/group-days", { cookie: screensCookie, body: { ...base, date: day(6).toISODate(), common_area_job: "Re-screen the clubhouse windows" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const gd = r.data.groupDay;
  groupDayId = gd.id;
  assert.deepEqual([gd.min_homes, gd.list_price_cents, gd.resident_price_cents, gd.group_price_cents, gd.booked], [3, 12000, 10800, 10200, 0]);
  assert.ok(sent.some((m) => m.to === "board@ridge.example" && m.text.includes(`/community/?code=${code}`)), "the HOA contact hears about it");

  // Regular customers can't book inside the window any more
  const reg = await call("GET", `/api/availability?service=window-rescreening&vendor=${screens}&from=${day(6).toISODate()}&to=${day(6).toISODate()}`);
  assert.deepEqual(reg.data.days[day(6).toISODate()], []);
  // Residents see it, with no travel buffer between homes: 8:00, 10:00 … 16:00
  assert.equal((await call("GET", `/api/group-days/${gd.id}`)).data.code, "invalid_community_code");
  const pub = await call("GET", `/api/group-days/${gd.id}?code=${code}`);
  const hours = pub.data.slots.map((s) => DateTime.fromISO(s, { zone: TZ }).toFormat("HH:mm"));
  assert.ok(hours.includes("08:00") && hours.includes("10:00") && hours.includes("16:00") && !hours.includes("16:30"), hours.join(","));
  // The hold can't be deleted from the calendar by accident
  const [hold] = await db().query(`SELECT id FROM time_off WHERE group_day_id = $1`, [gd.id]);
  assert.equal((await call("DELETE", `/api/time-off/${hold.id}`, { cookie: screensCookie, body: {} })).data.code, "group_day_hold");
});

test("group day: price drops for everyone when the minimum books", async () => {
  assert.equal((await book({ group_day: groupDayId, start: at(6, 8) })).data.code, "community_required");
  const one = await book({ group_day: groupDayId, start: at(6, 8), community_code: code, name: "Ann One", email: "ann@example.com", address: "1 Ridge Ct" });
  assert.equal(one.status, 201, JSON.stringify(one.data));
  assert.deepEqual([one.data.booking.price_cents, one.data.booking.price_kind, one.data.groupUnlocked], [10800, "resident", false]);
  const two = await book({ group_day: groupDayId, start: at(6, 10), community_code: code, name: "Bo Two", email: "bo@example.com", address: "2 Ridge Ct" });
  assert.equal(two.data.booking.price_cents, 10800);
  sent.length = 0;
  const three = await book({ group_day: groupDayId, start: at(6, 12), community_code: code, name: "Cy Three", email: "cy@example.com", address: "3 Ridge Ct" });
  assert.deepEqual([three.data.booking.price_cents, three.data.booking.price_kind, three.data.groupUnlocked], [10200, "group", true]);
  const rows = await db().query(`SELECT price_cents, price_kind FROM bookings WHERE group_day_id = $1 ORDER BY starts_at`, [groupDayId]);
  assert.deepEqual(rows.map((r) => [r.price_cents, r.price_kind]), [[10200, "group"], [10200, "group"], [10200, "group"]]);
  for (const who of ["ann@example.com", "bo@example.com"]) assert.ok(sent.some((m) => m.to === who && /Group price unlocked/.test(m.subject)), who);
  assert.ok(!sent.some((m) => m.to === "cy@example.com" && /Group price unlocked/.test(m.subject)), "the third booker's confirmation already shows it");
  assert.ok(sent.some((m) => m.to === "sky@example.com" && /clubhouse windows/.test(m.text)), "the pro is reminded of the common-area job");
  const four = await book({ group_day: groupDayId, start: at(6, 14), community_code: code, name: "Di Four", email: "di@example.com", address: "4 Ridge Ct" });
  assert.equal(four.data.booking.price_cents, 10200, "late bookers get the group price straight away");
  // A slot outside the window isn't bookable through the group day
  assert.equal((await book({ group_day: groupDayId, start: at(6, 17), community_code: code })).data.code, "slot_taken");
  // Group-day bookings stay on the group day
  const [b] = await db().query(`SELECT id FROM bookings WHERE customer_email = 'ann@example.com'`);
  assert.equal((await call("POST", `/api/bookings/${b.id}/reschedule`, { cookie: screensCookie, body: { start: at(7, 9) } })).data.code, "group_day_fixed");
});

test("homeowners can save their community and skip the code", async () => {
  const su = await call("POST", "/api/auth/signup", { body: { as: "customer", name: "Sam Saved", email: "sam@example.com", password: "sam-password-12" } });
  const cookie = su.cookie;
  assert.equal((await call("PUT", "/api/account/community", { cookie, body: { code: "NOPE-0000" } })).data.code, "invalid_community_code");
  const r = await call("PUT", "/api/account/community", { cookie, body: { code } });
  assert.equal(r.data.community.name, "Carmel Ridge HOA");
  assert.equal((await call("GET", "/api/account", { cookie })).data.profile.community_name, "Carmel Ridge HOA");
  const res = await call("POST", "/api/bookings", { cookie, body: { vendor: screens, area: "carmel-valley", service: "window-rescreening",
    start: at(8, 8), name: "Sam Saved", phone: "6195550199", email: "sam@example.com", address: "9 Ridge Ct" } });
  assert.equal(res.data.booking.price_kind, "resident");
  assert.equal(res.data.booking.price_cents, 10800);
});

test("the board's report: totals and give-back, with no personal details", async () => {
  // Two resident jobs done and paid
  await db().query(`UPDATE bookings SET status = 'completed', payment_status = 'paid', amount_charged_cents = price_cents, platform_fee_cents = price_cents / 10
                     WHERE customer_email IN ('ann@example.com','bo@example.com')`);
  const link = await call("POST", "/api/admin/communities/carmel-ridge-hoa/report-link", { cookie: adminCookie, body: {} });
  const t = tokenIn(link.data.url);
  assert.match(link.data.url, /\/hoa\/report\/\?t=/);
  const r = await call("GET", "/api/hoa/report?t=" + t);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.totals.paid_cents, 20400);
  assert.equal(r.data.totals.give_back_cents, 204, "1% of $204");
  assert.equal(r.data.totals.owed_cents, 204);
  assert.ok(r.data.totals.bookings >= 7);
  assert.equal(r.data.quarters[0].savings_cents, 3600, "two completed jobs at $18 under list");
  assert.ok(r.data.groupDays.some((g) => g.id === groupDayId && g.unlocked && g.booked === 4));
  const raw = JSON.stringify(r.data);
  for (const pii of ["ann@example.com", "Ann One", "1 Ridge Ct", "6195550123", "Rae Resident"]) assert.ok(!raw.includes(pii), `report leaks ${pii}`);

  const paid = await call("POST", "/api/admin/communities/carmel-ridge-hoa/payouts", { cookie: adminCookie, body: { amount: 1.5, note: "Q check" } });
  const c = paid.data.communities.find((x) => x.slug === "carmel-ridge-hoa");
  assert.deepEqual([c.paid_out_cents, c.owed_cents], [150, 54]);
  // A new link turns the old one off
  await call("POST", "/api/admin/communities/carmel-ridge-hoa/report-link", { cookie: adminCookie, body: {} });
  assert.equal((await call("GET", "/api/hoa/report?t=" + t)).status, 404);
});

test("cancelling a group day frees the window and tells residents; then the pro can leave", async () => {
  assert.equal((await call("PUT", "/api/my/hoa", { cookie: screensCookie, body: { enabled: false } })).data.code, "has_group_days");
  assert.equal((await call("POST", `/api/my/group-days/${groupDayId}/cancel`, { cookie: walkerCookie, body: {} })).status, 403, "only the pro or an admin");
  sent.length = 0;
  const r = await call("POST", `/api/my/group-days/${groupDayId}/cancel`, { cookie: screensCookie, body: {} });
  assert.deepEqual(r.data, { ok: true, cancelledBookings: 2 }, "the two completed jobs stay; the two upcoming are cancelled");
  assert.ok(sent.some((m) => m.to === "cy@example.com" && /Cancelled/.test(m.subject)));
  assert.equal((await db().query(`SELECT count(*)::int AS n FROM time_off WHERE group_day_id = $1`, [groupDayId]))[0].n, 0);
  const reg = await call("GET", `/api/availability?service=window-rescreening&vendor=${screens}&from=${day(6).toISODate()}&to=${day(6).toISODate()}`);
  assert.ok(reg.data.days[day(6).toISODate()].length > 0, "regular customers can book that day again");
  const off = await call("PUT", "/api/my/hoa", { cookie: screensCookie, body: { enabled: false } });
  assert.equal(off.data.settings.enabled, false);
});
