// All dynamic endpoints: /api/* and the vendor calendar feed /ics/<token>.ics
import {
  HttpError, json, readJson, bad, notFound, clientIp,
  str, email, phone, isoInstant, isoDate, uuid,
} from "../../lib/http.mjs";
import {
  availability, createBooking, bookingView, bookingIdByToken, cancelBooking, rescheduleBooking,
  setBookingStatus, bookingEvents, BUSINESS_TZ,
} from "../../lib/bookings.mjs";
import { login, logout, currentUser, requireUser, inviteInfo, acceptInvite } from "../../lib/auth.mjs";
import {
  calendarEvents, assertBookingAccess, getHours, setHours, addTimeOff, deleteTimeOff,
  vendorServices, setVendorService, listVendors, createVendor, updateVendor, vendorInvite,
  vendorIcsUrl, listServices, upsertService,
} from "../../lib/manage.mjs";
import { icsFeed } from "../../lib/ics.mjs";
import { rateLimit } from "../../lib/ratelimit.mjs";
import { db } from "../../lib/db.mjs";

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

route("GET", "/api/availability", async ({ url }) => {
  const serviceSlug = str(url.searchParams.get("service"), "Service", { max: 80 });
  const fromDate = isoDate(url.searchParams.get("from"), "from");
  const toDate = isoDate(url.searchParams.get("to"), "to");
  let excludeBookingId = null;
  const t = url.searchParams.get("t");
  if (t) excludeBookingId = await bookingIdByToken(t);
  return json(await availability({ serviceSlug, fromDate, toDate, excludeBookingId }));
});

route("POST", "/api/bookings", async ({ req, body }) => {
  if (body.website) return json({ ok: true }, 202); // honeypot: bots fill every field
  const ip = clientIp(req);
  await rateLimit(`book:${ip}`, 12, 3600);
  const start = isoInstant(body.start, "Time");
  if (start < new Date()) throw bad("That time has already passed.");
  const input = {
    serviceSlug: str(body.service, "Service", { max: 80 }),
    start,
    name: str(body.name, "Name", { max: 120 }),
    phone: phone(body.phone),
    email: email(body.email),
    address: str(body.address, "Address", { max: 240 }),
    neighborhood: str(body.neighborhood, "Neighborhood", { optional: true, max: 80 }),
    notes: str(body.notes, "Notes", { optional: true, max: 2000 }),
  };
  const { booking, manageToken } = await createBooking(input);
  return json({ booking: publicBooking(booking), manageToken }, 201);
});

const publicBooking = (b) => ({
  status: b.status, starts_at: b.starts_at, ends_at: b.ends_at, service_name: b.service_name, service_slug: b.service_slug,
  customer_name: b.customer_name, address: b.address, neighborhood: b.neighborhood, notes: b.notes,
  price_cents: b.price_cents, vendor_first_name: (b.vendor_name || "").split(" ")[0], timezone: b.timezone,
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
  return json({ booking: publicBooking(await rescheduleBooking(id, start, { actor: "customer" })) });
});

// --- auth --------------------------------------------------------------------

route("POST", "/api/auth/login", async ({ req, body }) => {
  const cookie = await login(email(body.email), str(body.password, "Password", { max: 200 }), clientIp(req));
  return json({ ok: true }, 200, { "set-cookie": cookie });
});
route("POST", "/api/auth/logout", async ({ req }) => json({ ok: true }, 200, { "set-cookie": await logout(req) }));
route("GET", "/api/auth/me", async ({ req }) => {
  const u = await currentUser(req);
  return json({ user: u && { email: u.email, role: u.role, vendor_id: u.vendor_id, vendor_name: u.vendor_name } });
});
route("GET", "/api/auth/invite", async ({ url }) => json(await inviteInfo(url.searchParams.get("t"))));
route("POST", "/api/auth/invite", async ({ req, body }) => {
  await rateLimit(`invite:${clientIp(req)}`, 20, 3600);
  return json({ ok: true }, 200, { "set-cookie": await acceptInvite(body.t, body.password) });
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
  return json({ booking: await setBookingStatus(id, body.status, { actor: `${user.role}:${user.email}` }) });
});

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
  return json({ services: await setVendorService(scopeVendor(user, url), body, { canPrice: user.role === "admin" }) });
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
route("POST", "/api/admin/vendors/:id/invite", async ({ req, params }) => {
  await requireUser(req, ["admin"]);
  return json(await vendorInvite(uuid(params.id)));
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
    if (req.method !== "GET") {
      // Browsers can't send JSON cross-site without a CORS preflight, which we never allow: CSRF protection
      if (!(req.headers.get("content-type") || "").includes("application/json")) throw bad("Send JSON.", "content_type");
      body = await readJson(req);
    }
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return await r.handler({ req, url, params, body });
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

