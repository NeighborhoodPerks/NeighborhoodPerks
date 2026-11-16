import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { freshDb, ALL_WEEK } from "./helpers.mjs";
import { handle } from "../netlify/functions/api.mjs";
import { createVendor, setHours } from "../lib/manage.mjs";
import { sent } from "../lib/notify.mjs";
import { db } from "../lib/db.mjs";
import { sweep } from "../lib/sweep.mjs";

// --- helpers ----------------------------------------------------------------------------
const BASE = "http://localhost:8888";
const call = async (method, path, { body, cookie } = {}) => {
  const res = await handle(new Request(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, type: ct, cookie: (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") };
};
const tokenIn = (s) => /[?&]t=([A-Za-z0-9_-]+)/.exec(s)[1];
const lastTo = (to, re) => sent.filter((m) => m.to === to && (!re || re.test(m.subject))).at(-1);
// smallest valid JPEG header is enough for the magic-byte check
const JPEG = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]).toString("base64");
const day = DateTime.now().setZone("America/Los_Angeles").plus({ days: 5 }).startOf("day");
let pro, proCookie, otherCookie;

before(async () => {
  await freshDb();
  const v = await createVendor({ name: "Pat Pipes", email: "pat@example.com", areas: ["carmel-valley"],
    services: [{ service: "plumbing", duration_min: 60, buffer_min: 0, price_cents: 12900 }] });
  pro = v.id;
  await setHours(pro, { rules: ALL_WEEK("08:00", "18:00"), settings: { min_notice_min: 0, max_days_ahead: 60, slot_step_min: 30 } });
  proCookie = (await call("POST", "/api/auth/invite", { body: { t: tokenIn(v.inviteUrl), password: "pat-password-1" } })).cookie;
  const o = await createVendor({ name: "Ollie Other", email: "ollie@example.com", areas: ["carmel-valley"],
    services: [{ service: "plumbing", duration_min: 60, buffer_min: 0, price_cents: 9900 }] });
  otherCookie = (await call("POST", "/api/auth/invite", { body: { t: tokenIn(o.inviteUrl), password: "ollie-password-1" } })).cookie;
});

const ask = (extra = {}) => call("POST", "/api/quotes", { body: {
  vendor: pro, area: "carmel-valley", service: "plumbing", details: "Water heater is leaking from the bottom, about 12 years old.",
  name: "Quinn Customer", phone: "6195550142", email: "quinn@example.com", address: "12 Elm St", ...extra } });

test("quotes are off until the pro turns them on for a service", async () => {
  assert.equal((await ask()).data.code, "no_quotes");
  const on = await call("PUT", "/api/my/services", { cookie: proCookie, body: { service: "plumbing", duration_min: 60, buffer_min: 0, quotes: true } });
  assert.equal(on.data.services[0].quotes, true);
  // a later save that doesn't mention quotes keeps them on
  const kept = await call("PUT", "/api/my/services", { cookie: proCookie, body: { service: "plumbing", duration_min: 90, buffer_min: 0 } });
  assert.equal(kept.data.services[0].quotes, true);
  const pros = await call("GET", "/api/pros?area=carmel-valley");
  assert.equal(pros.data.pros.find((p) => p.id === pro).services[0].quotes, true);
  assert.equal(pros.data.pros.find((p) => p.id !== pro).services[0].quotes, false);
});

test("a customer asks for a quote with photos; the pro is emailed", async () => {
  sent.length = 0;
  assert.equal((await ask({ photos: [JPEG, JPEG, JPEG, JPEG] })).data.code, "too_many_photos");
  assert.equal((await ask({ photos: ["data:image/png;base64,AAAA"] })).data.code, "invalid_photo");
  assert.equal((await ask({ details: "fix" })).status, 400, "needs a real description");
  assert.equal((await ask({ area: "rancho-penasquitos" })).data.code, "no_quotes", "only where the pro works");
  const bot = await ask({ website: "http://spam" });
  assert.equal(bot.status, 201);
  assert.equal(bot.data.token, undefined, "bots get a success with nothing behind it");
  const r = await ask({ photos: [JPEG, JPEG] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const mine = await call("GET", `/api/quote?t=${r.data.token}`);
  assert.deepEqual([mine.data.quote.status, mine.data.quote.photos, mine.data.quote.vendor_first_name], ["requested", 2, "Pat"]);
  assert.ok(lastTo("quinn@example.com", /Quote requested/), "customer gets their link");
  const proMail = lastTo("pat@example.com", /Quote request/);
  assert.match(proMail.text, /Water heater is leaking/);
  assert.match(proMail.text, /2 photos/);
  assert.equal(sent.filter((m) => m.to === "pat@example.com").length, 1, "the bot's request sent nothing");
});

test("the pro sees their requests and photos; other pros can't", async () => {
  const list = await call("GET", "/api/my/quotes", { cookie: proCookie });
  assert.equal(list.data.quotes.length, 1);
  const q = list.data.quotes[0];
  assert.deepEqual([q.status, q.photos, q.customer_phone], ["requested", 2, "6195550142"]);
  const photo = await call("GET", `/api/quotes/${q.id}/photos/1`, { cookie: proCookie });
  assert.equal(photo.type, "image/jpeg");
  assert.equal(photo.data[0], 0xff);
  assert.equal((await call("GET", `/api/quotes/${q.id}/photos/1`, { cookie: otherCookie })).status, 403);
  assert.equal((await call("GET", `/api/quotes/${q.id}/photos/1`)).status, 401);
  assert.equal((await call("GET", "/api/my/quotes", { cookie: otherCookie })).data.quotes.length, 0);
  assert.equal((await call("POST", `/api/quotes/${q.id}/send`, { cookie: otherCookie, body: { price: 900, duration_min: 240 } })).status, 403);
});

test("the pro sends a price; the customer accepts and books it on that pro's calendar", async () => {
  sent.length = 0;
  const [q] = (await call("GET", "/api/my/quotes", { cookie: proCookie })).data.quotes;
  assert.equal((await call("POST", `/api/quotes/${q.id}/send`, { cookie: proCookie, body: { price: 2, duration_min: 240 } })).data.code, "invalid_price");
  const s = await call("POST", `/api/quotes/${q.id}/send`, { cookie: proCookie, body: { price: "1450", duration_min: 240, message: "Replace the 40-gal tank, haul away the old one.", valid_days: 10 } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.quote.status, "quoted");
  const mail = lastTo("quinn@example.com", /Your quote/);
  assert.match(mail.text, /\$1450\.00, about 4 hours of work/);
  assert.match(mail.text, /haul away the old one/);
  const t = tokenIn(mail.text);
  const view = (await call("GET", `/api/quote?t=${t}`)).data.quote;
  assert.deepEqual([view.status, view.price_cents, view.duration_min], ["quoted", 145000, 240]);

  // Open times are 4-hour jobs: the last start is 2pm in an 8–6 day
  const date = day.toISODate();
  const slots = await call("GET", `/api/availability?service=plumbing&from=${date}&to=${date}&quote=${t}`);
  const times = slots.data.days[date].map((iso) => DateTime.fromISO(iso).setZone("America/Los_Angeles").toFormat("HH:mm"));
  assert.equal(times.at(-1), "14:00");

  const start = day.set({ hour: 9 }).toUTC().toISO();
  const ok = await call("POST", "/api/quote/accept", { body: { t, start } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const [b] = await db().query(`SELECT * FROM bookings WHERE id = $1`, [ok.data.bookingId]);
  assert.equal(b.vendor_id, pro);
  assert.equal(b.price_cents, 145000, "booked at the quoted price");
  assert.equal(b.quote_id, q.id);
  assert.equal((new Date(b.ends_at) - new Date(b.starts_at)) / 60000, 240, "for as long as the pro said");
  assert.match(b.notes, /Water heater/);
  assert.ok(ok.data.manageToken);
  assert.match(lastTo("quinn@example.com", /^Booked/).text, /Quoted price: \$1450\.00/);
  assert.equal((await call("GET", `/api/quote?t=${t}`)).data.quote.status, "accepted");
  assert.equal((await call("POST", "/api/quote/accept", { body: { t, start: day.set({ hour: 14 }).toUTC().toISO() } })).data.code, "quote_accepted");
  assert.equal((await call("POST", `/api/quotes/${q.id}/send`, { cookie: proCookie, body: { price: 900, duration_min: 60 } })).data.code, "quote_closed");
});

test("a taken time gives the quote back so the customer can pick another", async () => {
  const r = await ask({ email: "taken@example.com" });
  const [q] = (await call("GET", "/api/my/quotes", { cookie: proCookie })).data.quotes.filter((x) => x.status === "requested");
  await call("POST", `/api/quotes/${q.id}/send`, { cookie: proCookie, body: { price: 300, duration_min: 60 } });
  const t = tokenIn(lastTo("taken@example.com", /Your quote/).text);
  const clash = await call("POST", "/api/quote/accept", { body: { t, start: day.set({ hour: 10 }).toUTC().toISO() } });
  assert.equal(clash.data.code, "slot_taken", "9am–1pm is already booked");
  assert.equal((await call("GET", `/api/quote?t=${t}`)).data.quote.status, "quoted");
  assert.equal((await call("POST", "/api/quote/accept", { body: { t, start: day.set({ hour: 15 }).toUTC().toISO() } })).status, 200);
  assert.ok(r.data.token);
});

test("customer declines a price; pro passes on a request", async () => {
  sent.length = 0;
  await ask({ email: "no@example.com" });
  let [q] = (await call("GET", "/api/my/quotes", { cookie: proCookie })).data.quotes.filter((x) => x.status === "requested");
  await call("POST", `/api/quotes/${q.id}/send`, { cookie: proCookie, body: { price: 800, duration_min: 120 } });
  const t = tokenIn(lastTo("no@example.com", /Your quote/).text);
  assert.equal((await call("POST", "/api/quote/decline", { body: { t, reason: "Got a better price" } })).data.status, "declined");
  assert.match(lastTo("pat@example.com", /passed on your/).text, /Got a better price/);
  assert.equal((await call("POST", "/api/quote/accept", { body: { t, start: day.set({ hour: 9 }).plus({ days: 1 }).toUTC().toISO() } })).data.code, "quote_closed");

  await ask({ email: "pass@example.com" });
  [q] = (await call("GET", "/api/my/quotes", { cookie: proCookie })).data.quotes.filter((x) => x.status === "requested");
  assert.equal((await call("POST", `/api/quotes/${q.id}/pass`, { cookie: proCookie, body: { note: "Outside what we do, try a roofer." } })).data.status, "passed");
  assert.match(lastTo("pass@example.com", /can't take/).text, /try a roofer/);
});

test("hourly sweep: reminds the pro, then closes requests nobody answered", async () => {
  sent.length = 0;
  await ask({ email: "slow@example.com" });
  const [{ id }] = await db().query(`SELECT id FROM quotes WHERE customer_email = 'slow@example.com'`);
  await db().query(`UPDATE quotes SET created_at = now() - interval '3 days' WHERE id = $1`, [id]);
  const a = await sweep();
  assert.equal(a.proReminders, 1);
  assert.ok(lastTo("pat@example.com", /Reminder: Quinn Customer is waiting/));
  assert.equal((await sweep()).proReminders, 0, "only once");
  await db().query(`UPDATE quotes SET created_at = now() - interval '8 days' WHERE id = $1`, [id]);
  assert.equal((await sweep()).requestsExpired, 1);
  assert.equal((await db().query(`SELECT status FROM quotes WHERE id = $1`, [id]))[0].status, "expired");
  assert.ok(lastTo("slow@example.com", /didn't hear back/));
});

test("hourly sweep: reminds the customer about a price once, then lets it run out", async () => {
  sent.length = 0;
  await ask({ email: "later@example.com" });
  const [{ id }] = await db().query(`SELECT id FROM quotes WHERE customer_email = 'later@example.com'`);
  await call("POST", `/api/quotes/${id}/send`, { cookie: proCookie, body: { price: 500, duration_min: 60, valid_days: 14 } });
  await db().query(`UPDATE quotes SET quoted_at = now() - interval '4 days' WHERE id = $1`, [id]);
  assert.equal((await sweep()).customerReminders, 1);
  const t = tokenIn(lastTo("later@example.com", /holds until/).text);
  assert.equal((await call("GET", `/api/quote?t=${t}`)).data.quote.status, "quoted", "the reminder's link works");
  assert.equal((await sweep()).customerReminders, 0);
  await db().query(`UPDATE quotes SET valid_until = now() - interval '1 minute' WHERE id = $1`, [id]);
  assert.equal((await call("POST", "/api/quote/accept", { body: { t, start: day.plus({ days: 2 }).set({ hour: 9 }).toUTC().toISO() } })).data.code, "quote_expired");
  assert.equal((await sweep()).quotesExpired, 1);
  assert.ok(lastTo("pat@example.com", /ran out/));
});
