// All dynamic endpoints: /api/* and the vendor calendar feed /ics/<token>.ics
import {
  HttpError, json, readJson, bad, notFound, clientIp,
  str, email, phone, isoInstant, isoDate, uuid,
} from "../../lib/http.mjs";
import {
  availability, createBooking, bookingView, bookingIdByToken, cancelBooking, rescheduleBooking,
  setBookingStatus, bookingEvents, BUSINESS_TZ,
} from "../../lib/bookings.mjs";
import { login, logout, currentUser, requireUser, inviteInfo, acceptInvite, verifyEmail } from "../../lib/auth.mjs";
import {
  signupCustomer, signupProvider, forgotPassword, resendVerification, customerProfile, updateCustomerProfile,
  customerBookings, assertCustomerBooking, approveVendor, declineVendor,
} from "../../lib/accounts.mjs";
import {
  calendarEvents, assertBookingAccess, getHours, setHours, addTimeOff, deleteTimeOff,
  vendorServices, setVendorService, listVendors, createVendor, updateVendor, vendorInvite,
  vendorIcsUrl, listServices, upsertService,
} from "../../lib/manage.mjs";
import { icsFeed } from "../../lib/ics.mjs";
import { rateLimit } from "../../lib/ratelimit.mjs";
import { issueFormToken } from "../../lib/botcheck.mjs";
import {
  listAreas, listPublicAreas, findAreas, upsertArea, listPros, getProfile, updateProfile, setPhoto, removePhoto, getPhoto, inbox, markInboxSeen,
} from "../../lib/pros.mjs";
import { db } from "../../lib/db.mjs";
import { sendEmail, normalizeFrom } from "../../lib/notify.mjs";
import {
  paymentsEnabled, publicConfig, createSetupIntent, confirmedCard, attachCardToBooking, chargeBooking, payNowSecret, syncPayment,
  refundBooking, payoutStatus, onboardingLink, refreshAccount, stripeDashboardLink, handleWebhook, paymentsSummary,
  tipInfo, tipBooking, syncTip, bookingIdByTipToken,
} from "../../lib/payments.mjs";
import {
  resolveCommunity, publicCommunity, setCustomerCommunity, upsertCommunity, listCommunities, reportLink, addPayout, boardReport,
  vendorHoa, setVendorHoa, createGroupDay, cancelGroupDay, publicGroupDay,
} from "../../lib/hoa.mjs";

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "/?$");
  routes.push({ method, re, keys, handler });
};

// Which vendor's data: vendors always their own; admins choose with ?vendor=
function scopeVendor(user, url, { required = true } = {}) {
  if (user.role === "vendor") return user.vendor_id;
  const v = url.searchParams.get("vendor");
  if (!v) { if (required) throw bad("Choose a vendor."); return null; }
  return uuid(v);
}

function range(url) {
  const from = isoInstant(url.searchParams.get("from"), "from");
  const to = isoInstant(url.searchParams.get("to"), "to");
  if (to <= from || to - from > 100 * 86400_000) throw bad("Invalid range.");
  return { from, to };
}

// --- public ------------------------------------------------------------------

route("GET", "/api/services", async () => {
  const rows = await db().query(
    `SELECT s.slug, s.name, count(v.id)::int AS vendors, min(vs.price_cents) AS price_from_cents
       FROM services s
       LEFT JOIN vendor_services vs ON vs.service_id = s.id AND vs.active
       LEFT JOIN vendors v ON v.id = vs.vendor_id AND v.active
      WHERE s.active GROUP BY s.id ORDER BY s.sort, s.name`
  );
  return json({ services: rows, timezone: BUSINESS_TZ });
});

route("GET", "/api/availability", async ({ req, url }) => {
  const serviceSlug = str(url.searchParams.get("service"), "Service", { max: 80 });
  const fromDate = isoDate(url.searchParams.get("from"), "from");
  const toDate = isoDate(url.searchParams.get("to"), "to");
  let excludeBookingId = null;
  let vendorId = url.searchParams.get("vendor") ? uuid(url.searchParams.get("vendor")) : null;
  const t = url.searchParams.get("t");
  if (url.searchParams.get("booking")) {
    const user = await requireUser(req, ["customer"]);
    excludeBookingId = uuid(url.searchParams.get("booking"));
    await assertCustomerBooking(user, excludeBookingId);
    vendorId = (await bookingView(excludeBookingId)).vendor_id;
  } else if (t) {
    excludeBookingId = await bookingIdByToken(t);
    vendorId = (await bookingView(excludeBookingId)).vendor_id;
  }
  return json(await availability({ serviceSlug, vendorId, fromDate, toDate, excludeBookingId }));
});

route("POST", "/api/bookings", async ({ req, body }) => {
  if (body.website) return json({ ok: true }, 202); // honeypot: bots fill every field
  const ip = clientIp(req);
  await rateLimit(`book:${ip}`, 12, 3600);
  const start = isoInstant(body.start, "Time");
  if (start < new Date()) throw bad("That time has already passed.");
  // A group day fixes the pro, service and neighborhood; otherwise the customer chose them
  const groupDayId = body.group_day ? uuid(body.group_day) : null;
  const me = await currentUser(req);
  const input = {
    groupDayId,
    community: await resolveCommunity({ code: body.community_code, user: me }),
    vendorId: groupDayId ? null : uuid(body.vendor),
    areaSlug: groupDayId ? null : str(body.area, "Neighborhood", { max: 80 }),
    serviceSlug: groupDayId ? null : str(body.service, "Service", { max: 80 }),
    start,
    name: str(body.name, "Name", { max: 120 }),
    phone: phone(body.phone),
    email: email(body.email),
    address: str(body.address, "Address", { max: 240 }),
    neighborhood: str(body.neighborhood, "Neighborhood", { optional: true, max: 80 }),
    notes: str(body.notes, "Notes", { optional: true, max: 2000 }),
  };
  const card = paymentsEnabled() ? await confirmedCard(body.setup_intent) : null;
  const created = await createBooking(input);
  const manageToken = created.manageToken;
  let booking = created.booking;
  if (card) { await attachCardToBooking(booking.id, card); booking = await bookingView(booking.id); }
  // Signed in as a homeowner → it's theirs. Otherwise, if a *verified* account owns this email, it's theirs too.
  const [owner] = me && me.role === "customer" ? [{ id: me.id }]
    : await db().query(`SELECT id FROM users WHERE role = 'customer' AND email_verified_at IS NOT NULL AND lower(email) = lower($1)`, [input.email]);
  if (owner) await db().query(`UPDATE bookings SET customer_user_id = $2 WHERE id = $1`, [booking.id, owner.id]);
  return json({ booking: publicBooking(booking), manageToken, inAccount: !!owner, groupUnlocked: !!created.groupUnlocked }, 201);
});

const publicBooking = (b) => ({
  status: b.status, starts_at: b.starts_at, ends_at: b.ends_at, service_name: b.service_name, service_slug: b.service_slug,
  customer_name: b.customer_name, address: b.address, neighborhood: b.neighborhood, notes: b.notes,
  price_cents: b.price_cents, vendor_first_name: (b.vendor_name || "").split(" ")[0], timezone: b.timezone,
  vendor_id: b.vendor_id, vendor_business: b.vendor_business,
  payment_status: b.payment_status, amount_charged_cents: b.amount_charged_cents, amount_refunded_cents: b.amount_refunded_cents,
  vendor_photo_url: b.vendor_photo_version ? `/api/pros/${b.vendor_id}/photo?v=${b.vendor_photo_version}` : null,
  price_kind: b.price_kind, list_price_cents: b.list_price_cents, community_name: b.community_name, group_day: !!b.group_day_id,
});

route("GET", "/api/config", async () => json(publicConfig()));
route("POST", "/api/payments/setup", async ({ req, body }) => {
  await rateLimit(`setup:${clientIp(req)}`, 30, 3600);
  const me = await currentUser(req);
  const user = me && me.role === "customer" ? await db().query(`SELECT id, stripe_customer_id FROM users WHERE id = $1`, [me.id]).then((r) => r[0]) : null;
  return json(await createSetupIntent({ email: email(body.email), name: str(body.name, "Name", { max: 120 }), phone: body.phone ? phone(body.phone) : null, user }));
});
route("POST", "/api/booking/pay", async ({ body }) => json(await payNowSecret(await bookingIdByToken(body.t))));
route("POST", "/api/booking/pay/done", async ({ body }) => json(await syncPayment(await bookingIdByToken(body.t))));
// Tips: from the one-time link in the "paid" email
route("GET", "/api/tip", async ({ url }) => json(await tipInfo(await bookingIdByTipToken(url.searchParams.get("t")))));
route("POST", "/api/tip", async ({ req, body }) => {
  await rateLimit(`tip:${clientIp(req)}`, 20, 3600);
  return json(await tipBooking(await bookingIdByTipToken(body.t), Math.round(Number(body.amount) * 100), { actor: "customer" }));
});
route("POST", "/api/tip/done", async ({ body }) => json(await syncTip(await bookingIdByTipToken(body.t))));
route("GET", "/api/areas", async () => json({ areas: await listPublicAreas() }));
route("GET", "/api/areas/find", async ({ url }) => json({ areas: await findAreas(url.searchParams.get("q")) }));
route("GET", "/api/pros", async ({ url }) => {
  const area = str(url.searchParams.get("area"), "Neighborhood", { max: 80 });
  const service = url.searchParams.get("service") ? str(url.searchParams.get("service"), "Service", { max: 80 }) : null;
  return json(await listPros({ areaSlug: area, serviceSlug: service }));
});
route("GET", "/api/pros/:id/photo", async ({ params }) => {
  const p = await getPhoto(uuid(params.id));
  return new Response(p.data, { headers: { "content-type": p.mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
});

// --- HOA program: residents --------------------------------------------------------
route("GET", "/api/community", async ({ req, url }) => {
  await rateLimit(`community:${clientIp(req)}`, 40, 3600); // codes shouldn't be guessable by brute force
  return json(await publicCommunity(url.searchParams.get("code")));
});
route("GET", "/api/group-days/:id", async ({ req, url, params }) => {
  await rateLimit(`community:${clientIp(req)}`, 40, 3600);
  return json(await publicGroupDay(uuid(params.id), url.searchParams.get("code")));
});
route("GET", "/api/hoa/report", async ({ req, url }) => {
  await rateLimit(`hoareport:${clientIp(req)}`, 60, 3600);
  return json(await boardReport(url.searchParams.get("t")));
});

route("GET", "/api/booking", async ({ url }) => {
  const id = await bookingIdByToken(url.searchParams.get("t"));
  return json({ booking: publicBooking(await bookingView(id)) });
});
route("POST", "/api/booking/cancel", async ({ body }) => {
  const id = await bookingIdByToken(body.t);
  return json({ booking: publicBooking(await cancelBooking(id, { actor: "customer", reason: str(body.reason, "Reason", { optional: true, max: 500 }) })) });
});
route("POST", "/api/booking/reschedule", async ({ req, body }) => {
  await rateLimit(`resched:${clientIp(req)}`, 20, 3600);
  const id = await bookingIdByToken(body.t);
  const start = isoInstant(body.start, "Time");
  if (start < new Date()) throw bad("That time has already passed.");
  return json({ booking: publicBooking(await rescheduleBooking(id, start, { actor: "customer", keepVendor: true })) });
});

// --- auth --------------------------------------------------------------------

route("POST", "/api/auth/login", async ({ req, body }) => {
  const r = await login(email(body.email), str(body.password, "Password", { max: 200 }), clientIp(req));
  return json({ ok: true, role: r.role }, 200, { "set-cookie": r.cookies });
});
route("POST", "/api/auth/logout", async ({ req }) => json({ ok: true }, 200, { "set-cookie": await logout(req) }));
route("GET", "/api/auth/me", async ({ req }) => {
  const u = await currentUser(req);
  return json({ user: u && {
    email: u.email, role: u.role, name: u.name, vendor_id: u.vendor_id, vendor_name: u.vendor_name,
    vendor_status: u.vendor_status, email_verified: !!u.email_verified_at,
  } });
});
route("GET", "/api/auth/form-token", async ({ req }) => json(await issueFormToken(clientIp(req))));
route("POST", "/api/auth/signup", async ({ req, body }) => {
  const r = body.as === "provider" ? await signupProvider(body, clientIp(req)) : await signupCustomer(body, clientIp(req));
  return json({ ok: true, role: r.role }, 201, { "set-cookie": r.cookies });
});
route("POST", "/api/auth/forgot", async ({ req, body }) => json(await forgotPassword(body, clientIp(req))));
route("POST", "/api/auth/verify", async ({ req, body }) => {
  await rateLimit(`verifylink:${clientIp(req)}`, 30, 3600);
  return json(await verifyEmail(body.t));
});
route("POST", "/api/auth/verify/resend", async ({ req }) => json(await resendVerification(await requireUser(req, ["customer"]))));

// --- homeowner account -------------------------------------------------------------

route("GET", "/api/account", async ({ req }) => {
  const user = await requireUser(req, ["customer"]);
  return json({ profile: await customerProfile(user), bookings: (await customerBookings(user)).map((b) => ({
    ...b, vendor_photo_url: b.vendor_photo_version ? `/api/pros/${b.vendor_id}/photo?v=${b.vendor_photo_version}` : null,
  })) });
});
route("PUT", "/api/account", async ({ req, body }) => {
  const user = await requireUser(req, ["customer"]);
  return json({ profile: await updateCustomerProfile(user, body) });
});
route("PUT", "/api/account/community", async ({ req, body }) => {
  const user = await requireUser(req, ["customer"]);
  await rateLimit(`community:${clientIp(req)}`, 40, 3600);
  return json(await setCustomerCommunity(user, body.code));
});
route("POST", "/api/account/bookings/:id/cancel", async ({ req, params, body }) => {
  const user = await requireUser(req, ["customer"]);
  const id = uuid(params.id);
  await assertCustomerBooking(user, id);
  return json({ booking: publicBooking(await cancelBooking(id, { actor: "customer", reason: str(body.reason, "Reason", { optional: true, max: 500 }) })) });
});
route("POST", "/api/account/bookings/:id/pay", async ({ req, params }) => {
  const user = await requireUser(req, ["customer"]);
  const id = uuid(params.id);
  await assertCustomerBooking(user, id);
  return json(await payNowSecret(id));
});
route("POST", "/api/account/bookings/:id/pay/done", async ({ req, params }) => {
  const user = await requireUser(req, ["customer"]);
  const id = uuid(params.id);
  await assertCustomerBooking(user, id);
  return json(await syncPayment(id));
});
route("GET", "/api/account/bookings/:id/tip", async ({ req, params }) => {
  const user = await requireUser(req, ["customer"]);
  const id = uuid(params.id);
  await assertCustomerBooking(user, id);
  return json(await tipInfo(id));
});
route("POST", "/api/account/bookings/:id/tip", async ({ req, params, body }) => {
  const user = await requireUser(req, ["customer"]);
  const id = uuid(params.id);
  await assertCustomerBooking(user, id);
  return json(await tipBooking(id, Math.round(Number(body.amount) * 100), { actor: "customer" }));
});
route("POST", "/api/account/bookings/:id/tip/done", async ({ req, params }) => {
  const user = await requireUser(req, ["customer"]);
  const id = uuid(params.id);
  await assertCustomerBooking(user, id);
  return json(await syncTip(id));
});
route("POST", "/api/account/bookings/:id/reschedule", async ({ req, params, body }) => {
  const user = await requireUser(req, ["customer"]);
  const id = uuid(params.id);
  await assertCustomerBooking(user, id);
  const start = isoInstant(body.start, "Time");
  if (start < new Date()) throw bad("That time has already passed.");
  return json({ booking: publicBooking(await rescheduleBooking(id, start, { actor: "customer", keepVendor: true })) });
});
route("GET", "/api/auth/invite", async ({ url }) => json(await inviteInfo(url.searchParams.get("t"))));
route("POST", "/api/auth/invite", async ({ req, body }) => {
  await rateLimit(`invite:${clientIp(req)}`, 20, 3600);
  const r = await acceptInvite(body.t, body.password);
  return json({ ok: true, role: r.role }, 200, { "set-cookie": r.cookies });
});

// --- vendor + admin ------------------------------------------------------------

route("GET", "/api/calendar", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await calendarEvents({ vendorId: scopeVendor(user, url, { required: false }), ...range(url) }));
});

route("GET", "/api/bookings/:id", async ({ req, params }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  const id = uuid(params.id);
  await assertBookingAccess(user, id);
  return json({ booking: await bookingView(id), events: await bookingEvents(id) });
});
route("POST", "/api/bookings/:id/cancel", async ({ req, params, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  const id = uuid(params.id);
  await assertBookingAccess(user, id);
  return json({ booking: await cancelBooking(id, { actor: `${user.role}:${user.email}`, reason: str(body.reason, "Reason", { optional: true, max: 500 }) }) });
});
route("POST", "/api/bookings/:id/reschedule", async ({ req, params, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  const id = uuid(params.id);
  await assertBookingAccess(user, id);
  const start = isoInstant(body.start, "Time");
  if (start < new Date()) throw bad("That time has already passed.");
  // A vendor moving their own booking keeps it; an admin may let it move to another vendor
  const keepVendor = user.role === "vendor" || body.keepVendor !== false;
  return json({ booking: await rescheduleBooking(id, start, { actor: `${user.role}:${user.email}`, keepVendor }) });
});
route("POST", "/api/bookings/:id/status", async ({ req, params, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  const id = uuid(params.id);
  await assertBookingAccess(user, id);
  const actor = `${user.role}:${user.email}`;
  let charge = null;
  if (body.status === "completed" && paymentsEnabled()) {
    const current = await bookingView(id);
    if (current.payment_status === "card_saved") {
      const cents = Math.round(Number(body.amount) * 100);
      charge = await chargeBooking(id, cents, { actor });
    }
  }
  return json({ booking: await setBookingStatus(id, body.status, { actor }), charge });
});
route("POST", "/api/admin/bookings/:id/refund", async ({ req, params, body }) => {
  const user = await requireUser(req, ["admin"]);
  const cents = body.amount === undefined || body.amount === null || body.amount === "" ? null : Math.round(Number(body.amount) * 100);
  return json(await refundBooking(uuid(params.id), cents, { actor: `admin:${user.email}` }));
});
route("GET", "/api/admin/payments", async ({ req }) => {
  await requireUser(req, ["admin"]);
  return json({ enabled: paymentsEnabled(), ...(paymentsEnabled() ? await paymentsSummary() : {}) });
});

// --- provider payouts ------------------------------------------------------------------
route("GET", "/api/my/payouts", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  const vendorId = scopeVendor(user, url);
  const st = await payoutStatus(vendorId);
  // Refresh from Stripe when returning from onboarding or when not ready yet
  if (st.enabled && st.connected && (!st.ready || url.searchParams.get("refresh"))) return json(await refreshAccount(vendorId));
  return json(st);
});
route("POST", "/api/my/payouts/onboard", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await onboardingLink(scopeVendor(user, url)));
});
route("POST", "/api/my/payouts/dashboard", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await stripeDashboardLink(scopeVendor(user, url)));
});
route("POST", "/api/stripe/webhook", async ({ req, raw }) => json(await handleWebhook(raw, req.headers.get("stripe-signature") || "")));

route("GET", "/api/hours", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await getHours(scopeVendor(user, url)));
});
route("PUT", "/api/hours", async ({ req, url, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await setHours(scopeVendor(user, url), body));
});
route("POST", "/api/time-off", async ({ req, url, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await addTimeOff(scopeVendor(user, url), body), 201);
});
route("DELETE", "/api/time-off/:id", async ({ req, params }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await deleteTimeOff(user, uuid(params.id)));
});
route("GET", "/api/my/services", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json({ services: await vendorServices(scopeVendor(user, url)) });
});
route("PUT", "/api/my/services", async ({ req, url, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json({ services: await setVendorService(scopeVendor(user, url), body, { admin: user.role === "admin" }) });
});
route("GET", "/api/my/profile", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json({ profile: await getProfile(scopeVendor(user, url)), areas: await listAreas() });
});
route("PUT", "/api/my/profile", async ({ req, url, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json({ profile: await updateProfile(scopeVendor(user, url), body) });
});
route("POST", "/api/my/photo", async ({ req, url, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json({ profile: await setPhoto(scopeVendor(user, url), body) });
});
route("DELETE", "/api/my/photo", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json({ profile: await removePhoto(scopeVendor(user, url)) });
});
// HOA program: the pro's discounts and group days (admins act for a chosen pro)
route("GET", "/api/my/hoa", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await vendorHoa(scopeVendor(user, url)));
});
route("PUT", "/api/my/hoa", async ({ req, url, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await setVendorHoa(scopeVendor(user, url), body));
});
route("POST", "/api/my/group-days", async ({ req, url, body }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json({ groupDay: await createGroupDay(scopeVendor(user, url), body) }, 201);
});
route("POST", "/api/my/group-days/:id/cancel", async ({ req, params }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await cancelGroupDay(user, uuid(params.id)));
});
route("GET", "/api/my/inbox", async ({ req }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await inbox(user));
});
route("POST", "/api/my/inbox/seen", async ({ req }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await markInboxSeen(user));
});
route("GET", "/api/my/ics", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await vendorIcsUrl(scopeVendor(user, url)));
});
route("POST", "/api/my/ics/rotate", async ({ req, url }) => {
  const user = await requireUser(req, ["vendor", "admin"]);
  return json(await vendorIcsUrl(scopeVendor(user, url), { rotate: true }));
});

// --- admin only ------------------------------------------------------------------

route("GET", "/api/admin/vendors", async ({ req }) => {
  await requireUser(req, ["admin"]);
  return json({ vendors: await listVendors() });
});
route("POST", "/api/admin/vendors", async ({ req, body }) => {
  await requireUser(req, ["admin"]);
  return json(await createVendor(body), 201);
});
route("PATCH", "/api/admin/vendors/:id", async ({ req, params, body }) => {
  await requireUser(req, ["admin"]);
  return json(await updateVendor(uuid(params.id), body));
});
route("POST", "/api/admin/vendors/:id/approve", async ({ req, params }) => {
  await requireUser(req, ["admin"]);
  return json(await approveVendor(uuid(params.id)));
});
route("POST", "/api/admin/vendors/:id/decline", async ({ req, params }) => {
  await requireUser(req, ["admin"]);
  return json(await declineVendor(uuid(params.id)));
});
route("POST", "/api/admin/vendors/:id/invite", async ({ req, params }) => {
  await requireUser(req, ["admin"]);
  return json(await vendorInvite(uuid(params.id)));
});
// Admin: send yourself a test email and see exactly what the email service said
route("POST", "/api/admin/email-test", async ({ req }) => {
  const user = await requireUser(req, ["admin"]);
  await rateLimit(`emailtest:${user.id}`, 10, 3600);
  const result = await sendEmail({
    to: user.email,
    subject: "Neighborhood Perks test email",
    text: "If you're reading this, booking emails from Neighborhood Perks are working.\n\nSent from the admin dashboard.",
  });
  return json({
    to: user.email,
    from: normalizeFrom(process.env.MAIL_FROM),
    from_raw: (process.env.MAIL_FROM || "").trim() || null,
    reply_to: (process.env.MAIL_REPLY_TO || "").trim() || null,
    has_key: !!(process.env.RESEND_API_KEY || "").trim(),
    site_url: process.env.SITE_URL || null,
    result,
  });
});
route("GET", "/api/admin/areas", async ({ req }) => {
  await requireUser(req, ["admin"]);
  return json({ areas: await listAreas({ all: true }) });
});
route("POST", "/api/admin/areas", async ({ req, body }) => {
  await requireUser(req, ["admin"]);
  return json({ areas: await upsertArea(body) });
});
route("GET", "/api/admin/communities", async ({ req }) => {
  await requireUser(req, ["admin"]);
  return json({ communities: await listCommunities() });
});
route("POST", "/api/admin/communities", async ({ req, body }) => {
  await requireUser(req, ["admin"]);
  return json({ communities: await upsertCommunity(body) });
});
route("POST", "/api/admin/communities/:slug/report-link", async ({ req, params }) => {
  await requireUser(req, ["admin"]);
  return json(await reportLink(params.slug));
});
route("POST", "/api/admin/communities/:slug/payouts", async ({ req, params, body }) => {
  await requireUser(req, ["admin"]);
  return json({ communities: await addPayout(params.slug, body) });
});
route("GET", "/api/admin/services", async ({ req }) => {
  await requireUser(req, ["admin"]);
  return json({ services: await listServices() });
});
route("POST", "/api/admin/services", async ({ req, body }) => {
  await requireUser(req, ["admin"]);
  return json({ services: await upsertService(body) });
});

// --- calendar feed -------------------------------------------------------------

route("GET", "/ics/:file", async ({ params }) => {
  const token = params.file.replace(/\.ics$/, "");
  return new Response(await icsFeed(token), {
    headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300" },
  });
});

// --- dispatch --------------------------------------------------------------------

export async function handle(req) {
  const url = new URL(req.url);
  try {
    const candidates = routes.filter((r) => r.re.test(url.pathname));
    if (!candidates.length) throw notFound();
    const r = candidates.find((c) => c.method === req.method);
    if (!r) return json({ error: "Method not allowed", code: "method" }, 405, { allow: candidates.map((c) => c.method).join(", ") });
    let body = {};
    let raw = null;
    if (url.pathname === "/api/stripe/webhook") {
      raw = await req.text();
      if (raw.length > 512_000) throw bad("Request too large.");
    } else if (req.method !== "GET") {
      // Browsers can't send JSON cross-site without a CORS preflight, which we never allow: CSRF protection
      if (!(req.headers.get("content-type") || "").includes("application/json")) throw bad("Send JSON.", "content_type");
      body = await readJson(req, url.pathname === "/api/my/photo" ? 900_000 : 20_000);
    }
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return await r.handler({ req, url, params, body, raw });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
    if (/No database configured/.test(err.message || "")) {
      return json({ error: "Online booking isn't switched on yet. Please send a request or call (619) 736-3618.", code: "not_configured" }, 503);
    }
    console.error("API error", req.method, url.pathname, err);
    return json({ error: "Something went wrong on our side. Please try again, or call (619) 736-3618.", code: "server" }, 500);
  }
}

export default handle;
export const config = { path: ["/api/*", "/ics/*"] };

