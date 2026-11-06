// Payments with Stripe Connect.
//
// Money flow (destination charges): the customer pays Neighborhood Perks; Stripe moves the job price
// minus the platform fee (PLATFORM_FEE_PERCENT, default in feeDefault.cjs) to the provider's connected account.
// Stripe's processing fee is paid by the platform out of its share.
//
// Timing: the card is saved at booking (SetupIntent, off-session use) and charged when the provider
// marks the job done and confirms the final amount. Cancelled bookings are never charged.
// If that charge is declined, the customer gets a link to pay with another card.
//
// Everything here is off until STRIPE_SECRET_KEY is set: bookings then work exactly as before.

import { db } from "./db.mjs";
import { bad, conflict, notFound, HttpError } from "./http.mjs";
import { newToken, sha256 } from "./crypto.mjs";
import { sendEmail } from "./notify.mjs";
import { DateTime } from "luxon";
import feeDefault from "./feeDefault.cjs";

const API_VERSION = "2024-06-20"; // pinned: request/webhook shapes don't change under us
const SITE = () => (process.env.SITE_URL || "https://neighborhoodperks.com").replace(/\/$/, "");

let client = null;
export function setStripe(c) { client = c; }
export const paymentsEnabled = () => !!(client || (process.env.STRIPE_SECRET_KEY || "").trim());

export async function stripe() {
  if (client) return client;
  const key = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!key) throw new HttpError(503, "Payments aren't switched on yet.", "payments_off");
  const { default: Stripe } = await import("stripe");
  client = new Stripe(key, { apiVersion: API_VERSION, maxNetworkRetries: 2, appInfo: { name: "Neighborhood Perks" } });
  return client;
}

export const feePercent = () => {
  const fallback = feeDefault.DEFAULT_FEE_PERCENT;
  const p = Number(process.env.PLATFORM_FEE_PERCENT || fallback);
  return Number.isFinite(p) && p >= 0 && p < 100 ? p : fallback;
};
export const platformFee = (cents) => Math.round((cents * feePercent()) / 100);
const money = (c) => `$${(c / 100).toFixed(2)}`;

export function publicConfig() {
  return {
    payments: paymentsEnabled(),
    publishableKey: (process.env.STRIPE_PUBLISHABLE_KEY || "").trim() || null,
    feePercent: feePercent(),
  };
}

// --- customers & saved cards --------------------------------------------------------

/** Start saving a card for a booking. Returns the client secret the browser uses with Stripe.js. */
export async function createSetupIntent({ email, name, phone, user }) {
  const s = await stripe();
  let customerId = user?.stripe_customer_id || null;
  if (!customerId) {
    const c = await s.customers.create({ email, name, phone: phone || undefined, metadata: { app: "neighborhoodperks", user_id: user?.id || "" } });
    customerId = c.id;
    if (user) await db().query(`UPDATE users SET stripe_customer_id = $2 WHERE id = $1 AND stripe_customer_id IS NULL`, [user.id, customerId]);
  }
  const si = await s.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: { app: "neighborhoodperks" },
  });
  return { clientSecret: si.client_secret, setupIntentId: si.id };
}

/** Check a SetupIntent the browser says it completed; returns the saved card to charge later. */
export async function confirmedCard(setupIntentId) {
  if (typeof setupIntentId !== "string" || !/^seti_[A-Za-z0-9]+$/.test(setupIntentId)) throw bad("Please add a card to book.", "card_required");
  const s = await stripe();
  const si = await s.setupIntents.retrieve(setupIntentId);
  if (!si || si.metadata?.app !== "neighborhoodperks") throw bad("Please add a card to book.", "card_required");
  if (si.status !== "succeeded" || !si.payment_method || !si.customer) throw bad("Your card wasn't saved. Please try again.", "card_not_saved");
  return {
    customerId: typeof si.customer === "string" ? si.customer : si.customer.id,
    paymentMethodId: typeof si.payment_method === "string" ? si.payment_method : si.payment_method.id,
  };
}

export async function attachCardToBooking(bookingId, card) {
  await db().query(
    `UPDATE bookings SET stripe_customer_id = $2, stripe_payment_method_id = $3, payment_status = 'card_saved' WHERE id = $1`,
    [bookingId, card.customerId, card.paymentMethodId]);
}

// --- charging when the job is done --------------------------------------------------

/**
 * Charge a completed job. Locks the booking so two clicks can't charge twice, then asks Stripe
 * (with an idempotency key, so retries can't double-charge either).
 */
export async function chargeBooking(bookingId, amountCents, { actor }) {
  if (!Number.isInteger(amountCents) || amountCents < 50 || amountCents > 5_000_000) {
    throw bad("Enter the final price, at least $0.50.", "invalid_amount");
  }
  const b = await db().tx(async (t) => {
    const [row] = await t.query(
      `SELECT b.*, v.stripe_account_id, v.stripe_charges_enabled, v.name AS vendor_name, v.email AS vendor_email, s.name AS service_name
         FROM bookings b JOIN vendors v ON v.id = b.vendor_id JOIN services s ON s.id = b.service_id
        WHERE b.id = $1 FOR UPDATE OF b`, [bookingId]);
    if (!row) throw notFound("Booking not found.");
    if (row.status === "cancelled") throw conflict("Cancelled bookings can't be charged.", "cancelled");
    if (["paid", "processing", "refunded", "partially_refunded"].includes(row.payment_status)) throw conflict("This booking has already been charged.", "already_charged");
    if (row.payment_status === "failed") throw conflict("The card was declined. We've asked the customer to pay with another card.", "already_failed");
    if (row.payment_status !== "card_saved") throw conflict("There's no card saved for this booking.", "no_card");
    if (!row.stripe_account_id || !row.stripe_charges_enabled) throw conflict("Set up payouts first so we can pay you.", "payouts_not_ready");
    if (new Date(row.starts_at) > new Date()) throw conflict("You can mark this done once the appointment has started.", "too_early");
    await t.query(`UPDATE bookings SET payment_status = 'processing', amount_charged_cents = $2, platform_fee_cents = $3, updated_at = now() WHERE id = $1`,
      [bookingId, amountCents, platformFee(amountCents)]);
    return row;
  });

  const s = await stripe();
  const fee = platformFee(amountCents);
  let pi;
  try {
    pi = await s.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      customer: b.stripe_customer_id,
      payment_method: b.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      application_fee_amount: fee,
      transfer_data: { destination: b.stripe_account_id },
      description: `${b.service_name} with ${b.vendor_name}`,
      receipt_email: b.customer_email,
      metadata: { app: "neighborhoodperks", booking_id: b.id },
    }, { idempotencyKey: `np-booking-${b.id}-charge` });
  } catch (err) {
    const failedPi = err?.raw?.payment_intent || err?.payment_intent || null;
    await db().query(`UPDATE bookings SET payment_status = 'failed', stripe_payment_intent_id = coalesce($2, stripe_payment_intent_id), updated_at = now() WHERE id = $1`,
      [b.id, failedPi?.id || null]);
    await logEvent(b.id, "payment_failed", actor, { amount: amountCents, code: err?.code || err?.raw?.code || null });
    await notifyPaymentFailed(b, amountCents);
    return { status: "failed", message: "The card was declined. We've emailed the customer a link to pay with another card." };
  }
  await recordIntent(b.id, pi, actor);
  return { status: pi.status === "succeeded" ? "paid" : pi.status, amount: amountCents, fee };
}

async function recordIntent(bookingId, pi, actor) {
  const status = pi.status === "succeeded" ? "paid" : pi.status === "processing" ? "processing" : "failed";
  const [b] = await db().query(
    `UPDATE bookings SET stripe_payment_intent_id = $2, payment_status = $3, amount_charged_cents = $4,
            platform_fee_cents = coalesce($5, platform_fee_cents), paid_at = CASE WHEN $3 = 'paid' THEN coalesce(paid_at, now()) ELSE paid_at END,
            updated_at = now()
      WHERE id = $1 AND payment_status <> 'paid' RETURNING *`,
    [bookingId, pi.id, status, pi.amount, pi.application_fee_amount ?? null]);
  if (b && status === "paid") {
    await logEvent(bookingId, "paid", actor, { amount: pi.amount, fee: pi.application_fee_amount });
    await notifyPaid(bookingId);
  }
  return b;
}

async function logEvent(bookingId, type, actor, data) {
  await db().query(`INSERT INTO booking_events (booking_id, type, actor, data) VALUES ($1,$2,$3,$4)`, [bookingId, type, actor, JSON.stringify(data || {})]);
}

// --- customer pays after a declined card --------------------------------------------------

/** Client secret for the customer to finish paying a declined charge with another card. */
export async function payNowSecret(bookingId) {
  const [b] = await db().query(`SELECT payment_status, stripe_payment_intent_id FROM bookings WHERE id = $1`, [bookingId]);
  if (!b) throw notFound("Booking not found.");
  if (b.payment_status === "paid") throw conflict("This booking is already paid. Thank you!", "already_paid");
  if (b.payment_status !== "failed" || !b.stripe_payment_intent_id) throw conflict("Nothing to pay right now.", "nothing_due");
  const s = await stripe();
  const pi = await s.paymentIntents.retrieve(b.stripe_payment_intent_id);
  if (pi.status === "succeeded") { await recordIntent(bookingId, pi, "stripe"); throw conflict("This booking is already paid. Thank you!", "already_paid"); }
  return { clientSecret: pi.client_secret, amount: pi.amount };
}

/** After the browser confirms a payment, check with Stripe (don't trust the browser) and record it. */
export async function syncPayment(bookingId) {
  const [b] = await db().query(`SELECT stripe_payment_intent_id FROM bookings WHERE id = $1`, [bookingId]);
  if (!b?.stripe_payment_intent_id) return { status: "none" };
  const s = await stripe();
  const pi = await s.paymentIntents.retrieve(b.stripe_payment_intent_id);
  if (pi.status === "succeeded" || pi.status === "processing") await recordIntent(bookingId, pi, "customer");
  const [now] = await db().query(`SELECT payment_status FROM bookings WHERE id = $1`, [bookingId]);
  return { status: now.payment_status };
}

// --- tips --------------------------------------------------------------------------------
// After a paid job the customer can add one tip, charged to the card already on file.
// 100% goes to the pro (no platform fee; we absorb the card fee on it). Kept apart from the
// job payment: its own PaymentIntent, its own columns, metadata.kind = "tip".

const TIP_DAYS = 30;

/** What the customer sees before tipping. */
export async function tipInfo(bookingId) {
  const [b] = await db().query(
    `SELECT b.payment_status, b.amount_charged_cents, b.paid_at, b.tip_cents, b.tip_status, b.customer_name,
            s.name AS service_name, v.name AS vendor_name, v.business_name, v.photo_version, v.id AS vendor_id
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1`, [bookingId]);
  if (!b) throw notFound("Booking not found.");
  const paid = ["paid", "partially_refunded"].includes(b.payment_status);
  const open = paid && b.tip_status !== "paid" && b.tip_status !== "processing" && b.paid_at && Date.now() - new Date(b.paid_at) < TIP_DAYS * 86_400_000;
  const base = b.amount_charged_cents || 0;
  return {
    can_tip: !!open, tip_cents: b.tip_status === "paid" ? b.tip_cents : null, tip_status: b.tip_status,
    service_name: b.service_name, pro: b.vendor_name.split(" ")[0], pro_business: b.business_name, customer_first: b.customer_name.split(" ")[0],
    pro_photo_url: b.photo_version ? `/api/pros/${b.vendor_id}/photo?v=${b.photo_version}` : null,
    amount_charged_cents: base,
    suggestions: [15, 20, 25].map((pct) => ({ pct, cents: Math.max(100, Math.round((base * pct) / 100 / 50) * 50) })),
    max_cents: tipMax(base),
  };
}
const tipMax = (base) => Math.max(10_000, base); // up to $100, or the job's price if more

/**
 * Charge a tip to the saved card. If the bank wants the customer to confirm, returns
 * { status: "needs_card", clientSecret } so the browser can finish it (or use another card).
 */
export async function tipBooking(bookingId, cents, { actor }) {
  if (!Number.isInteger(cents) || cents < 100) throw bad("Tips start at $1.", "invalid_tip");
  const b = await db().tx(async (t) => {
    const [row] = await t.query(
      `SELECT b.*, v.stripe_account_id, v.stripe_charges_enabled, v.name AS vendor_name, s.name AS service_name
         FROM bookings b JOIN vendors v ON v.id = b.vendor_id JOIN services s ON s.id = b.service_id
        WHERE b.id = $1 FOR UPDATE OF b`, [bookingId]);
    if (!row) throw notFound("Booking not found.");
    if (!["paid", "partially_refunded"].includes(row.payment_status)) throw conflict("You can add a tip once the job is paid.", "not_paid");
    if (row.tip_status === "paid" || row.tip_status === "processing") throw conflict("You've already tipped for this job. Thank you!", "already_tipped");
    if (!row.paid_at || Date.now() - new Date(row.paid_at) > TIP_DAYS * 86_400_000) throw conflict("Tips can be added up to 30 days after the job.", "tip_closed");
    if (cents > tipMax(row.amount_charged_cents || 0)) throw bad(`The most you can tip here is ${money(tipMax(row.amount_charged_cents || 0))}.`, "invalid_tip");
    if (!row.stripe_account_id || !row.stripe_charges_enabled) throw conflict("This pro can't receive tips right now.", "payouts_not_ready");
    if (!row.stripe_customer_id || !row.stripe_payment_method_id) throw conflict("There's no card on file for this booking.", "no_card");
    await t.query(`UPDATE bookings SET tip_status = 'processing', tip_cents = $2, updated_at = now() WHERE id = $1`, [bookingId, cents]);
    return row;
  });
  const s = await stripe();
  let pi;
  try {
    pi = await s.paymentIntents.create({
      amount: cents,
      currency: "usd",
      customer: b.stripe_customer_id,
      payment_method: b.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      transfer_data: { destination: b.stripe_account_id }, // no application fee: all of it goes to the pro
      description: `Tip for ${b.vendor_name} (${b.service_name})`,
      receipt_email: b.customer_email,
      metadata: { app: "neighborhoodperks", booking_id: b.id, kind: "tip" },
    }, { idempotencyKey: `np-booking-${b.id}-tip-${cents}` });
  } catch (err) {
    const failedPi = err?.raw?.payment_intent || err?.payment_intent || null;
    await db().query(`UPDATE bookings SET tip_status = 'failed', tip_payment_intent_id = $2, updated_at = now() WHERE id = $1`, [b.id, failedPi?.id || null]);
    await logEvent(b.id, "tip_failed", actor, { amount: cents, code: err?.code || err?.raw?.code || null });
    // Let the customer confirm with their bank or use another card, on the same PaymentIntent
    if (failedPi?.client_secret) return { status: "needs_card", clientSecret: failedPi.client_secret, amount: cents };
    return { status: "failed", message: "Your card didn't go through for the tip. Please try another card." };
  }
  await recordTip(b.id, pi, actor);
  return { status: pi.status === "succeeded" ? "paid" : pi.status, amount: cents };
}

async function recordTip(bookingId, pi, actor) {
  if (pi.status !== "succeeded") {
    if (pi.status === "processing") await db().query(`UPDATE bookings SET tip_status = 'processing', tip_payment_intent_id = $2 WHERE id = $1 AND tip_status IS DISTINCT FROM 'paid'`, [bookingId, pi.id]);
    return;
  }
  const [b] = await db().query(
    `UPDATE bookings SET tip_status = 'paid', tip_cents = $3, tip_payment_intent_id = $2, tipped_at = now(), tip_token_hash = NULL, updated_at = now()
      WHERE id = $1 AND tip_status IS DISTINCT FROM 'paid' RETURNING id`, [bookingId, pi.id, pi.amount]);
  if (!b) return; // already recorded (the webhook and the browser can both report it)
  await logEvent(bookingId, "tipped", actor, { amount: pi.amount });
  await notifyTip(bookingId);
}

/** After the browser finishes a tip that needed the customer, check with Stripe and record it. */
export async function syncTip(bookingId) {
  const [b] = await db().query(`SELECT tip_payment_intent_id, tip_status FROM bookings WHERE id = $1`, [bookingId]);
  if (!b?.tip_payment_intent_id) return { status: b?.tip_status || "none" };
  const s = await stripe();
  await recordTip(bookingId, await s.paymentIntents.retrieve(b.tip_payment_intent_id), "customer");
  const [now] = await db().query(`SELECT tip_status FROM bookings WHERE id = $1`, [bookingId]);
  return { status: now.tip_status };
}

/** The one-time tip link in the "paid" email. */
export async function bookingIdByTipToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw notFound("This tip link isn't valid.");
  const [b] = await db().query(`SELECT id FROM bookings WHERE tip_token_hash = $1`, [sha256(token)]);
  if (!b) throw notFound("This tip link has already been used or isn't valid.");
  return b.id;
}

// --- refunds (admin) --------------------------------------------------------------------

/** Refund all or part of a payment. Takes it back from the provider and returns our fee proportionally. */
export async function refundBooking(bookingId, amountCents, { actor }) {
  const [b] = await db().query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
  if (!b) throw notFound("Booking not found.");
  if (!["paid", "partially_refunded"].includes(b.payment_status)) throw conflict("Only paid bookings can be refunded.", "not_paid");
  const left = b.amount_charged_cents - b.amount_refunded_cents;
  const amount = amountCents == null ? left : amountCents;
  if (!Number.isInteger(amount) || amount < 1 || amount > left) throw bad(`Refund between $0.01 and ${money(left)}.`, "invalid_amount");
  const s = await stripe();
  await s.refunds.create({
    payment_intent: b.stripe_payment_intent_id, amount, reverse_transfer: true, refund_application_fee: true,
    metadata: { app: "neighborhoodperks", booking_id: b.id },
  }, { idempotencyKey: `np-booking-${b.id}-refund-${b.amount_refunded_cents}-${amount}` });
  const total = b.amount_refunded_cents + amount;
  await db().query(`UPDATE bookings SET amount_refunded_cents = $2, payment_status = $3, updated_at = now() WHERE id = $1`,
    [b.id, total, total >= b.amount_charged_cents ? "refunded" : "partially_refunded"]);
  await logEvent(b.id, "refunded", actor, { amount });
  await sendEmail({ to: b.customer_email, subject: `Refund on its way: ${money(amount)}`,
    text: [`Hi ${b.customer_name},`, "", `We've refunded ${money(amount)} to your card. It usually shows up within 5–10 business days.`, "", "Neighborhood Perks"].join("\n") });
  return { refunded: amount, status: total >= b.amount_charged_cents ? "refunded" : "partially_refunded" };
}

// --- provider payouts (Connect Express) ------------------------------------------------------

export async function payoutStatus(vendorId) {
  const [v] = await db().query(
    `SELECT stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted FROM vendors WHERE id = $1`, [vendorId]);
  if (!v) throw notFound();
  return {
    enabled: paymentsEnabled(),
    connected: !!v.stripe_account_id,
    ready: !!v.stripe_charges_enabled,
    payouts: !!v.stripe_payouts_enabled,
    submitted: !!v.stripe_details_submitted,
    feePercent: feePercent(),
  };
}

/** Link to Stripe's onboarding (creates the provider's Express account the first time). */
export async function onboardingLink(vendorId) {
  const s = await stripe();
  const [v] = await db().query(`SELECT id, name, email, business_name, stripe_account_id FROM vendors WHERE id = $1`, [vendorId]);
  if (!v) throw notFound();
  let acct = v.stripe_account_id;
  if (!acct) {
    let a;
    try {
      a = await s.accounts.create({
        type: "express",
        country: "US",
        email: v.email,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: { name: v.business_name || v.name, product_description: "Home services booked through Neighborhood Perks", url: SITE() },
        metadata: { app: "neighborhoodperks", vendor_id: v.id },
        // The key stops a double click making two accounts. It rolls over every 10 minutes because Stripe
        // replays a stored error for the same key for 24 hours, which would block a retry after the cause is fixed.
      }, { idempotencyKey: `np-vendor-${v.id}-account-${Math.floor(Date.now() / 600_000)}` });
    } catch (err) {
      if (/platform profile/i.test(err?.message || "")) {
        throw conflict("Payouts aren't open yet: Neighborhood Perks is finishing its Stripe setup. Please try again soon.", "stripe_platform_incomplete");
      }
      throw err;
    }
    acct = a.id;
    await db().query(`UPDATE vendors SET stripe_account_id = $2 WHERE id = $1 AND stripe_account_id IS NULL`, [v.id, acct]);
  }
  const link = await s.accountLinks.create({
    account: acct,
    refresh_url: `${SITE()}/vendor/?tab=payouts&stripe=refresh`,
    return_url: `${SITE()}/vendor/?tab=payouts&stripe=return`,
    type: "account_onboarding",
  });
  return { url: link.url };
}

/** Pull the provider's account state from Stripe (after onboarding, or when the dashboard opens). */
export async function refreshAccount(vendorId) {
  const [v] = await db().query(`SELECT stripe_account_id FROM vendors WHERE id = $1`, [vendorId]);
  if (!v?.stripe_account_id) return payoutStatus(vendorId);
  const s = await stripe();
  const a = await s.accounts.retrieve(v.stripe_account_id);
  await saveAccount(a);
  return payoutStatus(vendorId);
}

async function saveAccount(a) {
  await db().query(
    `UPDATE vendors SET stripe_charges_enabled = $2, stripe_payouts_enabled = $3, stripe_details_submitted = $4 WHERE stripe_account_id = $1`,
    [a.id, !!a.charges_enabled, !!a.payouts_enabled, !!a.details_submitted]);
}

export async function stripeDashboardLink(vendorId) {
  const [v] = await db().query(`SELECT stripe_account_id, stripe_details_submitted FROM vendors WHERE id = $1`, [vendorId]);
  if (!v?.stripe_account_id || !v.stripe_details_submitted) throw conflict("Finish setting up payouts first.", "not_onboarded");
  const s = await stripe();
  const l = await s.accounts.createLoginLink(v.stripe_account_id);
  return { url: l.url };
}

// --- webhooks ------------------------------------------------------------------------------

export async function handleWebhook(rawBody, signature) {
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].map((x) => (x || "").trim()).filter(Boolean);
  if (!secrets.length) throw new HttpError(503, "Webhook not configured.", "webhook_off");
  const s = await stripe();
  let event = null;
  for (const secret of secrets) {
    try { event = s.webhooks.constructEvent(rawBody, signature, secret); break; } catch {}
  }
  if (!event) throw new HttpError(400, "Bad signature.", "bad_signature");

  // Each event once
  const fresh = await db().query(`INSERT INTO stripe_events (id, type) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING RETURNING id`, [event.id, event.type]);
  if (!fresh.length) return { received: true, duplicate: true };

  const o = event.data.object;
  if (event.type === "account.updated") await saveAccount(o);
  const isTip = o?.metadata?.kind === "tip";
  if ((event.type === "payment_intent.succeeded" || event.type === "payment_intent.processing") && isTip) {
    if (o.metadata?.booking_id) await recordTip(o.metadata.booking_id, o, "stripe");
  } else if (event.type === "payment_intent.succeeded" || event.type === "payment_intent.processing") {
    const bookingId = o.metadata?.booking_id;
    if (bookingId) await recordIntent(bookingId, o, "stripe");
  }
  if (event.type === "payment_intent.payment_failed" && isTip) {
    if (o.metadata?.booking_id) await db().query(`UPDATE bookings SET tip_status = 'failed' WHERE id = $1 AND tip_status = 'processing'`, [o.metadata.booking_id]);
  } else if (event.type === "payment_intent.payment_failed") {
    const bookingId = o.metadata?.booking_id;
    if (bookingId) await db().query(`UPDATE bookings SET payment_status = 'failed', stripe_payment_intent_id = $2 WHERE id = $1 AND payment_status IN ('processing','card_saved')`, [bookingId, o.id]);
  }
  if (event.type === "charge.refunded") {
    const piId = typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent?.id;
    if (piId) {
      await db().query(
        `UPDATE bookings SET amount_refunded_cents = GREATEST(amount_refunded_cents, $2),
                payment_status = CASE WHEN $2 >= amount_charged_cents THEN 'refunded' ELSE 'partially_refunded' END
          WHERE stripe_payment_intent_id = $1`, [piId, o.amount_refunded]);
    }
  }
  return { received: true };
}

// --- admin summary ---------------------------------------------------------------------------

export async function paymentsSummary() {
  const tz = "America/Los_Angeles";
  const start = DateTime.now().setZone(tz).startOf("month").toJSDate();
  const [m] = await db().query(
    `SELECT count(*) FILTER (WHERE payment_status IN ('paid','partially_refunded','refunded'))::int AS paid_jobs,
            coalesce(sum(amount_charged_cents) FILTER (WHERE payment_status IN ('paid','partially_refunded','refunded')), 0)::int AS gross,
            coalesce(sum(platform_fee_cents) FILTER (WHERE payment_status IN ('paid','partially_refunded')), 0)::int AS fees,
            coalesce(sum(amount_refunded_cents), 0)::int AS refunded,
            count(*) FILTER (WHERE payment_status = 'failed')::int AS failed
       FROM bookings WHERE paid_at >= $1 OR (payment_status = 'failed' AND updated_at >= $1)`, [start]);
  const [tips] = await db().query(
    `SELECT count(*)::int AS tips, coalesce(sum(tip_cents), 0)::int AS tip_cents FROM bookings WHERE tip_status = 'paid' AND tipped_at >= $1`, [start]);
  return { month: DateTime.now().setZone(tz).toFormat("LLLL yyyy"), feePercent: feePercent(), ...m, ...tips };
}

// --- emails ----------------------------------------------------------------------------------

async function notifyPaid(bookingId) {
  const [b] = await db().query(
    `SELECT b.*, s.name AS service_name, v.name AS vendor_name, v.email AS vendor_email
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1`, [bookingId]);
  if (!b) return;
  const tipToken = newToken(24);
  await db().query(`UPDATE bookings SET tip_token_hash = $2 WHERE id = $1 AND tip_status IS DISTINCT FROM 'paid'`, [b.id, sha256(tipToken)]);
  const first = b.vendor_name.split(" ")[0];
  await sendEmail({ to: b.customer_email, subject: `Paid: ${money(b.amount_charged_cents)} for ${b.service_name}`,
    text: [`Hi ${b.customer_name},`, "", `Thanks! We charged ${money(b.amount_charged_cents)} to your card for ${b.service_name} with ${b.vendor_name}.`, "",
      `Happy with ${first}? You can leave a tip, and 100% of it goes to them:`, `${SITE()}/tip/?t=${tipToken}`, "",
      `Questions about the charge? Reply to this email or call ${process.env.BUSINESS_PHONE || "(619) 736-3618"}.`, "", "Neighborhood Perks"].join("\n") });
  const net = b.amount_charged_cents - (b.platform_fee_cents || 0);
  await sendEmail({ to: b.vendor_email, subject: `You've been paid ${money(net)} for ${b.service_name}`,
    text: [`${b.customer_name} paid ${money(b.amount_charged_cents)}.`, `Neighborhood Perks fee (${feePercent()}%): ${money(b.platform_fee_cents || 0)}`, `Yours: ${money(net)}`, "",
      "It goes to your bank on your normal Stripe payout schedule.", `${SITE()}/vendor/?tab=payouts`].join("\n") });
}

async function notifyTip(bookingId) {
  const [b] = await db().query(
    `SELECT b.*, s.name AS service_name, v.name AS vendor_name, v.email AS vendor_email
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1`, [bookingId]);
  if (!b) return;
  await sendEmail({ to: b.customer_email, subject: `Thanks for the ${money(b.tip_cents)} tip`,
    text: [`Hi ${b.customer_name},`, "", `Your ${money(b.tip_cents)} tip is on its way to ${b.vendor_name.split(" ")[0]}, all of it.`, "", "Neighborhood Perks"].join("\n") });
  await sendEmail({ to: b.vendor_email, subject: `You got a ${money(b.tip_cents)} tip from ${b.customer_name}!`,
    text: [`${b.customer_name} tipped you ${money(b.tip_cents)} for ${b.service_name}. All of it is yours: no fee comes out of tips.`, "",
      "It goes to your bank on your normal Stripe payout schedule.", `${SITE()}/vendor/`].join("\n") });
}

async function notifyPaymentFailed(b, amountCents) {
  // A fresh private link (the old one stops working) so the customer can pay with another card
  const token = newToken(24);
  await db().query(`UPDATE bookings SET manage_token_hash = $2 WHERE id = $1`, [b.id, sha256(token)]);
  await sendEmail({ to: b.customer_email, subject: `Action needed: payment for ${b.service_name}`,
    text: [`Hi ${b.customer_name},`, "", `Your card was declined for ${money(amountCents)} for ${b.service_name} with ${b.vendor_name}.`,
      "Please pay with another card here:", `${SITE()}/booking/?t=${token}`, "", "Neighborhood Perks"].join("\n") });
  const admins = await db().query(`SELECT email FROM users WHERE role = 'admin'`);
  for (const a of admins) {
    await sendEmail({ to: a.email, subject: `Card declined: ${b.customer_name}, ${money(amountCents)}`,
      text: `${b.service_name} with ${b.vendor_name}. We emailed the customer a link to pay with another card.` });
  }
}
