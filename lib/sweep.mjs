// Runs every hour (netlify/functions/sweep.mjs): nudges and closes things people forgot to answer.
//   Prices waiting for a customer's OK: one reminder, then charge the booked price (never the extra).
//   Quote requests: remind the pro once, close it if they never reply.
//   Sent quotes: remind the customer once, close it when the price runs out.
// Every step is a conditional UPDATE, so two overlapping runs can't double-send or double-charge.

import { db } from "./db.mjs";
import { newToken, sha256 } from "./crypto.mjs";
import { sendEmail } from "./notify.mjs";
import { chargeBooking, approvalDeadline, APPROVAL_REMIND_DAYS, APPROVAL_EXPIRE_DAYS } from "./payments.mjs";
import { freshToken, quoteView, quoteDay } from "./quotes.mjs";

const SITE = () => (process.env.SITE_URL || "https://neighborhoodperks.com").replace(/\/$/, "");
const PHONE = () => process.env.BUSINESS_PHONE || "(619) 736-3618";
const money = (c) => `$${(c / 100).toFixed(2)}`;

export const QUOTE_REMIND_PRO_DAYS = 2;
export const QUOTE_REQUEST_EXPIRE_DAYS = 7;
export const QUOTE_REMIND_CUSTOMER_DAYS = 3;

const admins = () => db().query(`SELECT email FROM users WHERE role = 'admin'`);

export async function sweep() {
  const done = { approvalReminders: 0, approvalsExpired: 0, proReminders: 0, requestsExpired: 0, customerReminders: 0, quotesExpired: 0, errors: 0 };
  const each = async (rows, key, fn) => {
    for (const r of rows) {
      try { if ((await fn(r)) !== false) done[key]++; } catch (err) { done.errors++; console.error("sweep", key, r.id, err); }
    }
  };

  // --- prices waiting for the customer's OK ---
  await each(await db().query(
    `UPDATE bookings SET approval_reminded_at = now() WHERE payment_status = 'needs_approval' AND approval_reminded_at IS NULL
        AND approval_requested_at < now() - make_interval(days => $1) AND approval_requested_at > now() - make_interval(days => $2)
      RETURNING id`, [APPROVAL_REMIND_DAYS, APPROVAL_EXPIRE_DAYS]), "approvalReminders", remindApproval);
  await each(await db().query(
    `SELECT id FROM bookings WHERE payment_status = 'needs_approval' AND approval_requested_at < now() - make_interval(days => $1)`,
    [APPROVAL_EXPIRE_DAYS]), "approvalsExpired", expireApproval);

  // --- quote requests the pro hasn't answered ---
  await each(await db().query(
    `UPDATE quotes SET pro_reminded_at = now() WHERE status = 'requested' AND pro_reminded_at IS NULL
        AND created_at < now() - make_interval(days => $1) AND created_at > now() - make_interval(days => $2) RETURNING id`,
    [QUOTE_REMIND_PRO_DAYS, QUOTE_REQUEST_EXPIRE_DAYS]), "proReminders", remindPro);
  await each(await db().query(
    `UPDATE quotes SET status = 'expired', updated_at = now() WHERE status = 'requested' AND created_at < now() - make_interval(days => $1) RETURNING id`,
    [QUOTE_REQUEST_EXPIRE_DAYS]), "requestsExpired", expireRequest);

  // --- quotes the customer hasn't answered ---
  await each(await db().query(
    `UPDATE quotes SET customer_reminded_at = now() WHERE status = 'quoted' AND customer_reminded_at IS NULL
        AND quoted_at < now() - make_interval(days => $1) AND valid_until > now() + interval '1 day' RETURNING id`,
    [QUOTE_REMIND_CUSTOMER_DAYS]), "customerReminders", remindCustomer);
  await each(await db().query(
    `UPDATE quotes SET status = 'expired', updated_at = now() WHERE status = 'quoted' AND valid_until <= now() RETURNING id`), "quotesExpired", expireQuote);

  return done;
}

async function bookingFor(id) {
  const [b] = await db().query(
    `SELECT b.*, s.name AS service_name, v.name AS vendor_name, v.email AS vendor_email
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1`, [id]);
  return b;
}

async function remindApproval({ id }) {
  const b = await bookingFor(id);
  const token = newToken(24);
  await db().query(`UPDATE bookings SET manage_token_hash = $2 WHERE id = $1`, [id, sha256(token)]);
  await sendEmail({ to: b.customer_email, subject: `Reminder: please approve the final price for ${b.service_name}`,
    text: [`Hi ${b.customer_name},`, "", `${b.vendor_name} is waiting for your OK on ${money(b.approval_cents)} for ${b.service_name}` +
      (b.price_cents != null ? ` (you booked at ${money(b.price_cents)}).` : "."),
      ...(b.approval_note ? ["", `What changed: ${b.approval_note}`] : []), "",
      "Approve or decline here:", `${SITE()}/booking/?t=${token}`, "", approvalDeadline(b.price_cents), "", "Neighborhood Perks"].join("\n") });
}

async function expireApproval({ id }) {
  const b = await bookingFor(id);
  if (b.payment_status !== "needs_approval") return false;
  const asked = b.approval_cents;
  if (b.price_cents != null) {
    // They agreed to the booked price when they booked; the extra was never approved
    const r = await chargeBooking(id, b.price_cents, { actor: "system:approval_expired" });
    await sendEmail({ to: b.customer_email, subject: `We charged the booked price for ${b.service_name}`,
      text: [`Hi ${b.customer_name},`, "", `We didn't hear back about the ${money(asked)} final price, so we charged the ${money(b.price_cents)} you booked at instead. The extra wasn't charged.`, "",
        `Questions? Reply to this email or call ${PHONE()}.`, "", "Neighborhood Perks"].join("\n") });
    await sendEmail({ to: b.vendor_email, subject: `${b.customer_name} didn't answer: charged the booked ${money(b.price_cents)}`,
      text: [`${b.customer_name} didn't approve or decline ${money(asked)} for ${b.service_name} within ${APPROVAL_EXPIRE_DAYS} days, so we charged the ${money(b.price_cents)} they booked at` +
        (r.status === "failed" ? ", but their card was declined. We've asked them to pay with another card." : "."), "",
        `For the rest, please talk to them directly: ${b.customer_phone}.`].join("\n") });
    return;
  }
  // No booked price: nothing was agreed, so nothing is charged; the pro takes it from here
  const [reverted] = await db().query(
    `UPDATE bookings SET payment_status = 'card_saved', approval_cents = NULL, approval_note = NULL, approval_requested_at = NULL, approval_reminded_at = NULL, updated_at = now()
      WHERE id = $1 AND payment_status = 'needs_approval' RETURNING id`, [id]);
  if (!reverted) return false;
  const text = [`${b.customer_name} didn't answer about ${money(asked)} for ${b.service_name} within ${APPROVAL_EXPIRE_DAYS} days. Nothing was charged.`, "",
    `Please call them at ${b.customer_phone} to agree on a price, then charge it from your dashboard.`, `${SITE()}/vendor/`].join("\n");
  await sendEmail({ to: b.vendor_email, subject: `No answer from ${b.customer_name} on the final price`, text });
  for (const a of await admins()) await sendEmail({ to: a.email, subject: `Price never approved: ${b.customer_name}, ${money(asked)}`, text: `${b.vendor_name}.\n\n${text}` });
}

async function remindPro({ id }) {
  const q = await quoteView(id);
  await sendEmail({ to: q.vendor_email, subject: `Reminder: ${q.customer_name} is waiting for a quote`,
    text: [`${q.customer_name} in ${q.area_name} asked for a ${q.service_name.toLowerCase()} quote ${QUOTE_REMIND_PRO_DAYS} days ago:`, "", q.details, "",
      `Send a price, or let them know you can't take it: ${SITE()}/vendor/?tab=quotes`,
      `We'll close the request after ${QUOTE_REQUEST_EXPIRE_DAYS} days so they can find someone else.`].join("\n") });
}

async function expireRequest({ id }) {
  const q = await quoteView(id);
  await sendEmail({ to: q.customer_email, subject: `We didn't hear back about your ${q.service_name.toLowerCase()} quote`,
    text: [`Hi ${q.customer_name},`, "", `Sorry, ${q.vendor_name} didn't reply to your request, so we've closed it.`, "",
      `Ask another pro: ${SITE()}/book/?service=${q.service_slug}`, `Or call or text us at ${PHONE()} and we'll find someone for you.`, "", "Neighborhood Perks"].join("\n") });
  for (const a of await admins()) await sendEmail({ to: a.email, subject: `Quote request went unanswered: ${q.vendor_name}`,
    text: `${q.customer_name} (${q.customer_phone}) asked ${q.vendor_name} for ${q.service_name} in ${q.area_name} and got no reply in ${QUOTE_REQUEST_EXPIRE_DAYS} days.\n\n${q.details}` });
}

async function remindCustomer({ id }) {
  const q = await quoteView(id);
  const token = await freshToken(id);
  await sendEmail({ to: q.customer_email, subject: `Your ${money(q.price_cents)} quote for ${q.service_name.toLowerCase()} holds until ${quoteDay(q.valid_until)}`,
    text: [`Hi ${q.customer_name},`, "", `Just a reminder: ${q.vendor_name}'s price of ${money(q.price_cents)} for your ${q.service_name.toLowerCase()} job holds until ${quoteDay(q.valid_until)}.`, "",
      `Accept it and pick a time, or let them know you're passing: ${SITE()}/quote/?t=${token}`, "", "Neighborhood Perks"].join("\n") });
}

async function expireQuote({ id }) {
  const q = await quoteView(id);
  await sendEmail({ to: q.vendor_email, subject: `Your quote for ${q.customer_name} ran out`,
    text: [`Your ${money(q.price_cents)} ${q.service_name.toLowerCase()} quote for ${q.customer_name} passed its date without an answer.`, "",
      `You can reach them at ${q.customer_phone}. ${SITE()}/vendor/?tab=quotes`].join("\n") });
}
