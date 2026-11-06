import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { freshDb, ALL_WEEK } from "./helpers.mjs";
import { handle } from "../netlify/functions/api.mjs";
import { createVendor, setHours } from "../lib/manage.mjs";
import { setStripe } from "../lib/payments.mjs";
import { sent } from "../lib/notify.mjs";
import { db } from "../lib/db.mjs";
import { createInvite } from "../lib/auth.mjs";

// --- a stand-in for Stripe that behaves like the parts we use -------------------------
let seq = 0;
const id = (p) => `${p}_${++seq}${Math.random().toString(36).slice(2, 8)}`;
const fake = {
  customers: new Map(), setupIntents: new Map(), paymentIntents: new Map(), accounts: new Map(), refunds: [], idem: new Map(),
};
const stripe = {
  customers: { create: async (p) => { const c = { id: id("cus"), ...p }; fake.customers.set(c.id, c); return c; } },
  setupIntents: {
    create: async (p) => { const si = { id: id("seti"), client_secret: "seti_secret_" + seq, status: "requires_payment_method", ...p }; fake.setupIntents.set(si.id, si); return si; },
    retrieve: async (sid) => { const si = fake.setupIntents.get(sid); if (!si) throw Object.assign(new Error("No such setupintent"), { statusCode: 404 }); return si; },
  },
  paymentIntents: {
    create: async (p, opts) => {
      if (opts?.idempotencyKey && fake.idem.has(opts.idempotencyKey)) return fake.idem.get(opts.idempotencyKey);
      const pi = { id: id("pi"), client_secret: "pi_secret_" + seq, ...p, status: "succeeded" };
      if (p.payment_method === "pm_declined") {
        pi.status = "requires_payment_method";
        fake.paymentIntents.set(pi.id, pi);
        const err = Object.assign(new Error("Your card was declined."), { type: "StripeCardError", code: "card_declined", raw: { payment_intent: pi, code: "card_declined" } });
        throw err;
      }
      fake.paymentIntents.set(pi.id, pi);
      if (opts?.idempotencyKey) fake.idem.set(opts.idempotencyKey, pi);
      return pi;
    },
    retrieve: async (pid) => fake.paymentIntents.get(pid),
  },
  refunds: { create: async (p) => { fake.refunds.push(p); return { id: id("re"), ...p }; } },
  accounts: {
    create: async (p) => { const a = { id: id("acct"), charges_enabled: false, payouts_enabled: false, details_submitted: false, ...p }; fake.accounts.set(a.id, a); return a; },
    retrieve: async (aid) => fake.accounts.get(aid),
    createLoginLink: async (aid) => ({ url: `https://connect.stripe.test/express/${aid}` }),
  },
  accountLinks: { create: async (p) => ({ url: `https://connect.stripe.test/setup/${p.account}` }) },
  webhooks: { constructEvent: (raw, sig, secret) => { if (sig !== `sig:${secret}`) throw new Error("bad sig"); return JSON.parse(raw); } },
};
const cardFor = (pm = "pm_card_visa") => {
  const si = { id: id("seti"), status: "succeeded", payment_method: pm, customer: id("cus"), metadata: { app: "neighborhoodperks" } };
  fake.setupIntents.set(si.id, si);
  return si.id;
};

// --- helpers ----------------------------------------------------------------------------
const BASE = "http://localhost:8888";
const call = async (method, path, { body, cookie, raw, headers = {} } = {}) => {
  const res = await handle(new Request(BASE + path, {
    method,
    headers: { ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ") };
};
const tokenIn = (s) => /[?&]t=([A-Za-z0-9_-]+)/.exec(s)[1];
const day = DateTime.now().setZone("America/Los_Angeles").plus({ days: 4 }).startOf("day");
let pro, proCookie, adminCookie;

before(async () => {
  await freshDb();
  setStripe(stripe);
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const v = await createVendor({ name: "Paz Pay", email: "paz@example.com", areas: ["carmel-valley"],
    services: [{ service: "pet-walking", duration_min: 30, buffer_min: 0, price_cents: 4000 }] });
  pro = v.id;
  await setHours(pro, { rules: ALL_WEEK("08:00", "18:00"), settings: { min_notice_min: 0, max_days_ahead: 60, slot_step_min: 30 } });
  proCookie = (await call("POST", "/api/auth/invite", { body: { t: tokenIn(v.inviteUrl), password: "paz-password-1" } })).cookie;
  const [u] = await db().query(`INSERT INTO users (email, role) VALUES ('owner@example.com','admin') RETURNING id`);
  adminCookie = (await call("POST", "/api/auth/invite", { body: { t: tokenIn(await createInvite(u.id)), password: "owner-password-1" } })).cookie;
});

const book = (hour, extra = {}) => call("POST", "/api/bookings", { body: {
  vendor: pro, area: "carmel-valley", service: "pet-walking", start: day.set({ hour }).toUTC().toISO(),
  name: "Cam Card", phone: "6195550123", email: "cam@example.com", address: "4 Pine St", ...extra } });
// Move a booking into the past (each one to a different day, so they don't overlap for the same provider)
let pastDays = 0;
const pastIt = (bookingId) => { const d = ++pastDays; return db().query(
  `UPDATE bookings SET starts_at = now() - make_interval(days => $2, hours => 2), ends_at = now() - make_interval(days => $2, mins => 90),
          blocked_until = now() - make_interval(days => $2, mins => 90) WHERE id = $1`, [bookingId, d]); };
const bookingRow = async (bid) => (await db().query(`SELECT * FROM bookings WHERE id = $1`, [bid]))[0];
const bookingIdFor = async (email) => (await db().query(`SELECT id FROM bookings WHERE customer_email = $1 ORDER BY created_at DESC LIMIT 1`, [email]))[0].id;

test("config tells the browser payments are on and the fee", async () => {
  const r = await call("GET", "/api/config");
  assert.equal(r.data.payments, true);
  assert.equal(r.data.feePercent, 10);
});

test("providers without payouts set up are hidden and can't be booked", async () => {
  assert.equal((await call("GET", "/api/pros?area=carmel-valley")).data.pros.length, 0);
  const r = await book(9, { setup_intent: cardFor() });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "no_vendors");
});

test("payout onboarding: Stripe link, then ready once Stripe says so", async () => {
  const st = await call("GET", "/api/my/payouts", { cookie: proCookie });
  assert.deepEqual([st.data.enabled, st.data.connected, st.data.ready, st.data.feePercent], [true, false, false, 10]);
  const link = await call("POST", "/api/my/payouts/onboard", { cookie: proCookie, body: {} });
  assert.match(link.data.url, /connect\.stripe\.test\/setup\/acct_/);
  const [{ stripe_account_id: acct }] = await db().query(`SELECT stripe_account_id FROM vendors WHERE id = $1`, [pro]);
  const again = await call("POST", "/api/my/payouts/onboard", { cookie: proCookie, body: {} });
  assert.match(again.data.url, new RegExp(acct), "same account reused");
  Object.assign(fake.accounts.get(acct), { charges_enabled: true, payouts_enabled: true, details_submitted: true });
  const ready = await call("GET", "/api/my/payouts?refresh=1", { cookie: proCookie });
  assert.equal(ready.data.ready, true);
  assert.equal((await call("GET", "/api/pros?area=carmel-valley")).data.pros.length, 1);
  assert.match((await call("POST", "/api/my/payouts/dashboard", { cookie: proCookie, body: {} })).data.url, /express/);
});

test("booking needs a card the customer actually saved", async () => {
  assert.equal((await book(9)).data.code, "card_required");
  const pending = id("seti");
  fake.setupIntents.set(pending, { id: pending, status: "requires_payment_method", metadata: { app: "neighborhoodperks" } });
  assert.equal((await book(9, { setup_intent: pending })).data.code, "card_not_saved");
  const notOurs = id("seti");
  fake.setupIntents.set(notOurs, { id: notOurs, status: "succeeded", payment_method: "pm_x", customer: "cus_x", metadata: {} });
  assert.equal((await book(9, { setup_intent: notOurs })).data.code, "card_required");
  const ok = await book(9, { setup_intent: cardFor() });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.booking.payment_status, "card_saved");
  const s = await call("POST", "/api/payments/setup", { body: { email: "new@example.com", name: "New Person" } });
  assert.match(s.data.clientSecret, /^seti_secret_/);
});

test("marking done charges once: 10% to us, the rest to the provider", async () => {
  const bid = await bookingIdFor("cam@example.com");
  assert.equal((await call("POST", `/api/bookings/${bid}/status`, { cookie: proCookie, body: { status: "completed", amount: 45 } })).data.code, "too_early");
  await pastIt(bid);
  sent.length = 0;
  const r = await call("POST", `/api/bookings/${bid}/status`, { cookie: proCookie, body: { status: "completed", amount: "45.00" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.charge.status, "paid");
  const pi = [...fake.paymentIntents.values()].at(-1);
  assert.equal(pi.amount, 4500);
  assert.equal(pi.application_fee_amount, 450, "10% of $45");
  assert.equal(pi.transfer_data.destination, (await db().query(`SELECT stripe_account_id FROM vendors WHERE id=$1`, [pro]))[0].stripe_account_id);
  assert.equal(pi.off_session, true);
  const row = await bookingRow(bid);
  assert.deepEqual([row.status, row.payment_status, row.amount_charged_cents, row.platform_fee_cents], ["completed", "paid", 4500, 450]);
  assert.ok(sent.some((m) => m.to === "cam@example.com" && /Paid: \$45\.00/.test(m.subject)));
  assert.ok(sent.some((m) => m.to === "paz@example.com" && /\$40\.50/.test(m.subject)), "provider told their 90%");
  // Clicking again never charges twice
  const before = fake.paymentIntents.size;
  await call("POST", `/api/bookings/${bid}/status`, { cookie: proCookie, body: { status: "completed", amount: 45 } });
  assert.equal(fake.paymentIntents.size, before);
});

test("cancelled bookings are never charged", async () => {
  const r = await book(11, { email: "cx@example.com", setup_intent: cardFor() });
  const bid = r.data.booking && (await bookingIdFor("cx@example.com"));
  await call("POST", `/api/bookings/${bid}/cancel`, { cookie: proCookie, body: {} });
  await pastIt(bid);
  const c = await call("POST", `/api/bookings/${bid}/status`, { cookie: proCookie, body: { status: "completed", amount: 40 } });
  assert.equal(c.status, 409);
});

test("declined card: customer gets a new link and pays with another card", async () => {
  sent.length = 0;
  await book(13, { email: "dec@example.com", setup_intent: cardFor("pm_declined") });
  const bid = await bookingIdFor("dec@example.com");
  await pastIt(bid);
  const r = await call("POST", `/api/bookings/${bid}/status`, { cookie: proCookie, body: { status: "completed", amount: 40 } });
  assert.equal(r.data.charge.status, "failed");
  assert.equal((await bookingRow(bid)).payment_status, "failed");
  const mail = sent.find((m) => m.to === "dec@example.com" && /Action needed/.test(m.subject));
  assert.ok(mail, "customer emailed");
  assert.ok(sent.some((m) => m.to === "owner@example.com" && /Card declined/.test(m.subject)), "admin alerted");
  const t = tokenIn(mail.text);
  const pay = await call("POST", "/api/booking/pay", { body: { t } });
  assert.match(pay.data.clientSecret, /^pi_secret_/);
  assert.equal(pay.data.amount, 4000);
  // Customer completes payment in the browser; we confirm with Stripe, not the browser
  const pi = fake.paymentIntents.get((await bookingRow(bid)).stripe_payment_intent_id);
  pi.status = "succeeded";
  const done = await call("POST", "/api/booking/pay/done", { body: { t } });
  assert.equal(done.data.status, "paid");
  assert.equal((await call("POST", "/api/booking/pay", { body: { t } })).data.code, "already_paid");
});

test("refunds: admin only, partial then the rest, money comes back from the provider", async () => {
  const bid = await bookingIdFor("cam@example.com");
  assert.equal((await call("POST", `/api/admin/bookings/${bid}/refund`, { cookie: proCookie, body: { amount: 10 } })).status, 403);
  const part = await call("POST", `/api/admin/bookings/${bid}/refund`, { cookie: adminCookie, body: { amount: 10 } });
  assert.equal(part.data.status, "partially_refunded");
  const last = fake.refunds.at(-1);
  assert.deepEqual([last.amount, last.reverse_transfer, last.refund_application_fee], [1000, true, true]);
  assert.equal((await call("POST", `/api/admin/bookings/${bid}/refund`, { cookie: adminCookie, body: { amount: 100 } })).status, 400, "can't refund more than was paid");
  const rest = await call("POST", `/api/admin/bookings/${bid}/refund`, { cookie: adminCookie, body: {} });
  assert.equal(rest.data.refunded, 3500);
  assert.equal(rest.data.status, "refunded");
  const sum = await call("GET", "/api/admin/payments", { cookie: adminCookie });
  assert.equal(sum.data.enabled, true);
  assert.ok(sum.data.paid_jobs >= 2);
});

test("pros set their own prices, within limits; only admins add services", async () => {
  const put = (body, cookie = proCookie) => call("PUT", "/api/my/services", { cookie, body: { service: "pet-walking", duration_min: 30, buffer_min: 0, ...body } });
  assert.equal((await put({ price_cents: 300 })).data.code, "invalid_price", "under $5");
  assert.equal((await put({ price_cents: 600_000 })).data.code, "invalid_price", "over $5,000");
  assert.equal((await put({ price_cents: null })).data.code, "price_required");
  const ok = await put({ price_cents: 4500 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.services.find((x) => x.slug === "pet-walking").price_cents, 4500);
  const kept = await put({ duration_min: 45 });
  assert.equal(kept.data.services.find((x) => x.slug === "pet-walking").price_cents, 4500, "a save without a price keeps the price");
  assert.equal((await call("PUT", "/api/my/services", { cookie: proCookie, body: { service: "pet-sitting", duration_min: 60, price_cents: 5000 } })).status, 403, "pros can't add a new service");
  const admin = await call("PUT", `/api/my/services?vendor=${pro}`, { cookie: adminCookie, body: { service: "pet-walking", duration_min: 30, buffer_min: 0, price_cents: 4000 } });
  assert.equal(admin.data.services.find((x) => x.slug === "pet-walking").price_cents, 4000, "admins can override");
});

test("tips: link in the paid email, 100% to the pro, once, kept apart from the job payment", async () => {
  await book(14, { email: "tia@example.com", name: "Tia Tipper", setup_intent: cardFor() });
  const bid = await bookingIdFor("tia@example.com");
  await pastIt(bid);
  sent.length = 0;
  await call("POST", `/api/bookings/${bid}/status`, { cookie: proCookie, body: { status: "completed", amount: 50 } });
  const paidMail = sent.find((m) => m.to === "tia@example.com" && /^Paid/.test(m.subject));
  assert.match(paidMail.text, /\/tip\/\?t=/, "the paid email has a tip link");
  const t = tokenIn(paidMail.text.slice(paidMail.text.indexOf("/tip/")));

  const info = await call("GET", "/api/tip?t=" + t);
  assert.equal(info.data.can_tip, true);
  assert.deepEqual(info.data.suggestions.map((x) => x.cents), [750, 1000, 1250]);
  assert.equal((await call("POST", "/api/tip", { body: { t, amount: 0.5 } })).data.code, "invalid_tip");
  assert.equal((await call("POST", "/api/tip", { body: { t, amount: 500 } })).data.code, "invalid_tip", "over the cap");

  const before = await bookingRow(bid);
  sent.length = 0;
  const r = await call("POST", "/api/tip", { body: { t, amount: 10 } });
  assert.deepEqual(r.data, { status: "paid", amount: 1000 });
  const pi = [...fake.paymentIntents.values()].at(-1);
  assert.equal(pi.amount, 1000);
  assert.equal(pi.application_fee_amount, undefined, "no fee on tips");
  assert.equal(pi.metadata.kind, "tip");
  assert.equal(pi.transfer_data.destination, before.stripe_account_id || (await db().query(`SELECT stripe_account_id FROM vendors WHERE id=$1`, [pro]))[0].stripe_account_id);
  const after = await bookingRow(bid);
  assert.deepEqual([after.tip_status, after.tip_cents, after.tip_token_hash], ["paid", 1000, null]);
  assert.deepEqual([after.payment_status, after.amount_charged_cents, after.stripe_payment_intent_id], [before.payment_status, before.amount_charged_cents, before.stripe_payment_intent_id], "the job payment is untouched");
  assert.ok(sent.some((m) => m.to === "paz@example.com" && /tip from Tia Tipper/.test(m.subject)));
  assert.ok(sent.some((m) => m.to === "tia@example.com" && /Thanks for the \$10\.00 tip/.test(m.subject)));
  assert.equal((await call("GET", "/api/tip?t=" + t)).status, 404, "the link works once");
  assert.equal((await call("GET", `/api/bookings/${bid}`, { cookie: proCookie })).data.booking.tip_cents, 1000, "the pro sees the tip");

  // The webhook for the tip's PaymentIntent records nothing new and never touches the job payment
  const evt = { id: "evt_tip_1", type: "payment_intent.succeeded", data: { object: { ...pi, status: "succeeded" } } };
  await call("POST", "/api/stripe/webhook", { raw: JSON.stringify(evt), headers: { "stripe-signature": "sig:whsec_test" } });
  const again = await bookingRow(bid);
  assert.deepEqual([again.amount_charged_cents, again.stripe_payment_intent_id, again.tip_cents], [before.amount_charged_cents, before.stripe_payment_intent_id, 1000]);
});

test("tips: a card that needs the customer is finished in the browser", async () => {
  await book(15, { email: "ned@example.com", name: "Ned Needs", setup_intent: cardFor() });
  const bid = await bookingIdFor("ned@example.com");
  await pastIt(bid);
  sent.length = 0;
  await call("POST", `/api/bookings/${bid}/status`, { cookie: proCookie, body: { status: "completed", amount: 40 } });
  const mail = sent.find((m) => m.to === "ned@example.com" && /^Paid/.test(m.subject));
  const t = tokenIn(mail.text.slice(mail.text.indexOf("/tip/")));
  await db().query(`UPDATE bookings SET stripe_payment_method_id = 'pm_declined' WHERE id = $1`, [bid]);
  const r = await call("POST", "/api/tip", { body: { t, amount: 6 } });
  assert.equal(r.data.status, "needs_card");
  assert.match(r.data.clientSecret, /^pi_secret_/);
  assert.equal((await bookingRow(bid)).tip_status, "failed");
  // The customer confirms in the browser; we check with Stripe rather than trusting the browser
  const pi = [...fake.paymentIntents.values()].find((x) => x.metadata?.kind === "tip" && x.amount === 600);
  pi.status = "succeeded";
  const done = await call("POST", "/api/tip/done", { body: { t } });
  assert.equal(done.data.status, "paid");
  assert.equal((await bookingRow(bid)).tip_cents, 600);
});

test("webhooks: forged signatures refused, duplicates ignored, provider status synced", async () => {
  const [{ stripe_account_id: acct }] = await db().query(`SELECT stripe_account_id FROM vendors WHERE id = $1`, [pro]);
  const evt = { id: "evt_1", type: "account.updated", data: { object: { id: acct, charges_enabled: false, payouts_enabled: false, details_submitted: true } } };
  assert.equal((await call("POST", "/api/stripe/webhook", { raw: JSON.stringify(evt), headers: { "stripe-signature": "sig:wrong" } })).status, 400);
  const ok = await call("POST", "/api/stripe/webhook", { raw: JSON.stringify(evt), headers: { "stripe-signature": "sig:whsec_test" } });
  assert.equal(ok.data.received, true);
  assert.equal((await db().query(`SELECT stripe_charges_enabled FROM vendors WHERE id = $1`, [pro]))[0].stripe_charges_enabled, false);
  assert.equal((await call("GET", "/api/pros?area=carmel-valley")).data.pros.length, 0, "unbookable again until Stripe re-enables");
  const dup = await call("POST", "/api/stripe/webhook", { raw: JSON.stringify(evt), headers: { "stripe-signature": "sig:whsec_test" } });
  assert.equal(dup.data.duplicate, true);
});
