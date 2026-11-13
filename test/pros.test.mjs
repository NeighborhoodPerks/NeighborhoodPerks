import { test, before } from "node:test";
import assert from "node:assert/strict";
import { freshDb, ALL_WEEK } from "./helpers.mjs";
import { createVendor, setHours } from "../lib/manage.mjs";
import { createBooking, cancelBooking } from "../lib/bookings.mjs";
import { listPros, findAreas, setPhoto, getPhoto, inbox, markInboxSeen, updateProfile, upsertArea } from "../lib/pros.mjs";
import { db } from "../lib/db.mjs";

const NOW = new Date("2026-11-01T12:00:00Z");
const at = (hhmm, date) => new Date(`${date}T${hhmm}:00-08:00`);
let near, far, busyPro;

const book = (vendorId, start, extra = {}) => createBooking({
  vendorId, areaSlug: "carmel-valley", serviceSlug: "pet-walking", start, name: "Lee", phone: "6195550100",
  email: "lee@example.com", address: "9 Pine St", neighborhood: "Carmel Valley", notes: null, ...extra,
}, { now: NOW });

before(async () => {
  await freshDb();
  const walk = (price) => [{ service: "pet-walking", duration_min: 30, buffer_min: 0, price_cents: price }];
  near = (await createVendor({ name: "Nora Near", email: "nora@example.com", services: walk(2500), areas: ["carmel-valley"] })).id;
  busyPro = (await createVendor({ name: "Bo Busy", email: "bo@example.com", services: walk(2000), areas: ["carmel-valley", "torrey-hills"] })).id;
  far = (await createVendor({ name: "Fay Far", email: "fay@example.com", services: walk(1800), areas: ["rancho-penasquitos"] })).id;
  await setHours(near, { rules: ALL_WEEK("09:00", "17:00"), settings: { min_notice_min: 0, max_days_ahead: 60, slot_step_min: 30 } });
  await setHours(far, { rules: ALL_WEEK("09:00", "17:00"), settings: { min_notice_min: 0, max_days_ahead: 60, slot_step_min: 30 } });
  // Bo only works one hour on Mondays
  await setHours(busyPro, { rules: [{ weekday: 1, start: "09:00", end: "10:00" }], settings: { min_notice_min: 0, max_days_ahead: 60, slot_step_min: 30 } });
});

test("only providers who serve the area show up, soonest opening first", async () => {
  const r = await listPros({ areaSlug: "carmel-valley", now: NOW });
  assert.deepEqual(r.pros.map((p) => p.name).sort(), ["Bo Busy", "Nora Near"]);
  assert.equal(r.pros[0].name, "Nora Near", "Nora is open Sunday; Bo not until Monday");
  assert.ok(r.pros[0].next_open);
  assert.equal(r.pros[0].services[0].price_cents, 2500);
  assert.ok(!r.pros.some((p) => p.name === "Fay Far"));
  await assert.rejects(listPros({ areaSlug: "nowhere", now: NOW }), (e) => e.status === 404);
});

test("a ZIP shared by several neighborhoods finds all of them", async () => {
  const a = await findAreas("92130");
  assert.ok(a.length >= 3);
  assert.ok(a.some((x) => x.slug === "carmel-valley"));
  assert.deepEqual((await findAreas("90210")).length, 0);
  await upsertArea({ name: "Rancho Peñasquitos", zips: "92129, 92128" });
  assert.ok((await findAreas("92128")).some((x) => x.slug === "rancho-penasquitos"), "accents are slugged away");
});

test("booking a chosen provider never hands it to someone else", async () => {
  const day = "2026-11-02"; // Monday: Bo and Nora both work 9–10
  const first = await book(busyPro, at("09:00", day));
  assert.equal(first.booking.vendor_id, busyPro);
  // Same time, same provider → refused, even though Nora is free then
  await assert.rejects(book(busyPro, at("09:00", day), { email: "x@example.com" }), (e) => e.code === "slot_taken");
  const nora = await book(near, at("09:00", day), { email: "y@example.com" });
  assert.equal(nora.booking.vendor_id, near);
});

test("can't book a provider outside their area", async () => {
  await assert.rejects(book(far, at("11:00", "2026-11-03")), (e) => e.code === "wrong_area");
  await assert.rejects(book(near, at("11:00", "2026-11-03"), { areaSlug: "atlantis" }), (e) => e.code === "invalid_area");
});

test("photos: real images only, size-limited, served back", async () => {
  // 1×1 transparent PNG
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const p = await setPhoto(near, { dataUrl: png });
  assert.match(p.photo_url, /\/api\/pros\/.+\/photo\?v=1/);
  const got = await getPhoto(near);
  assert.equal(got.mime, "image/png");
  await assert.rejects(setPhoto(near, { dataUrl: "data:image/png;base64," + Buffer.from("<script>alert(1)</script>").toString("base64") }), (e) => e.code === "invalid_photo");
  await assert.rejects(setPhoto(near, { dataUrl: "data:image/jpeg;base64," + Buffer.alloc(700_000, 0xff).toString("base64") }), (e) => e.code === "photo_too_large");
  await assert.rejects(setPhoto(near, { dataUrl: "javascript:alert(1)" }), (e) => e.code === "invalid_photo");
  const l = await listPros({ areaSlug: "carmel-valley", now: NOW });
  assert.ok(l.pros.find((x) => x.id === near).photo_url);
});

test("profile: bio and areas update what customers see", async () => {
  await updateProfile(far, { bio: "Ten years walking dogs in PQ.", areas: ["rancho-penasquitos", "carmel-valley"] });
  const l = await listPros({ areaSlug: "carmel-valley", now: NOW });
  const fay = l.pros.find((x) => x.id === far);
  assert.equal(fay.bio, "Ten years walking dogs in PQ.");
});

test("What's new: a provider sees customer bookings and cancellations, not their own actions", async () => {
  const [u] = await db().query(`SELECT * FROM users WHERE vendor_id = $1`, [near]);
  const user = { ...u, inbox_seen_at: new Date("2026-01-01T00:00:00Z") };
  await markInboxSeen(user); // sets now(); emulate an older last-seen for the test
  const fresh = await book(near, at("14:00", "2026-11-04"), { email: "new@example.com" });
  await cancelBooking(fresh.booking.id, { actor: `vendor:${u.email}`, now: NOW });
  const items = (await inbox({ ...user, inbox_seen_at: new Date(Date.now() - 60_000) })).items;
  assert.ok(items.some((i) => i.type === "created" && i.booking_id === fresh.booking.id));
  assert.ok(!items.some((i) => i.type === "cancelled" && i.booking_id === fresh.booking.id), "own cancel is not news");
  const later = (await inbox({ ...user, inbox_seen_at: new Date(Date.now() + 60_000) })).items;
  assert.equal(later.length, 0);
});

test("booking page lists home neighborhoods always, wider areas only once a pro serves them", async () => {
  const { listPublicAreas } = await import("../lib/pros.mjs");
  let slugs = (await listPublicAreas()).map((a) => a.slug);
  assert.ok(slugs.includes("torrey-highlands"), "home neighborhood with no pros is still offered");
  assert.ok(!slugs.includes("escondido"), "nobody serves Escondido yet");
  const cleaner = (await createVendor({ name: "Cleo Clean", email: "cleo@example.com", services: [{ service: "pet-walking", duration_min: 30, buffer_min: 0, price_cents: 3000 }], areas: ["escondido"] })).id;
  const areas = await listPublicAreas();
  assert.equal(areas.find((a) => a.slug === "escondido")?.home, false);
  assert.equal(areas.find((a) => a.slug === "carmel-valley")?.home, true);
  await db().query(`UPDATE vendors SET active = false WHERE id = $1`, [cleaner]);
  slugs = (await listPublicAreas()).map((a) => a.slug);
  assert.ok(!slugs.includes("escondido"), "an inactive pro doesn't make an area appear");
});
