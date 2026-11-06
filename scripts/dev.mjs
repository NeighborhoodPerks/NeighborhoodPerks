// Local preview of the whole system: static site + API + a real Postgres (PGlite) in-process.
//   npm run dev            → http://localhost:8888 with demo providers, hours and bookings
//   PORT=9000 npm run dev
// Data lives in memory and is re-seeded on every start. Emails are printed, not sent.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { DateTime } from "luxon";
import { setDb, pgliteAdapter, db } from "../lib/db.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.PORT || 8888);
process.env.INSECURE_COOKIES = "1";
process.env.SITE_URL = `http://localhost:${PORT}`;

const pg = new PGlite({ extensions: { btree_gist } });
await pg.exec(readFileSync(join(ROOT, "db/schema.sql"), "utf8"));
setDb(pgliteAdapter(pg));

const { handle } = await import("../netlify/functions/api.mjs");
const { createVendor, setHours } = await import("../lib/manage.mjs");
const { createBooking } = await import("../lib/bookings.mjs");
const { hashPassword } = await import("../lib/crypto.mjs");
const { updateProfile } = await import("../lib/pros.mjs");

// --- demo data -------------------------------------------------------------------
const PASSWORD = "neighborhood-demo";
const hash = await hashPassword(PASSWORD);
await db().query(`INSERT INTO users (email, role, password_hash) VALUES ('admin@demo.test', 'admin', $1)`, [hash]);
const week = (days, start, end) => days.map((weekday) => ({ weekday, start, end }));
const demo = [
  { name: "Maria Lopez", business_name: "Clear View Screens", email: "maria@demo.test", hours: week([1, 2, 3, 4, 5, 6], "08:00", "16:00"),
    areas: ["carmel-valley", "torrey-highlands", "del-mar-mesa"], bio: "Demo profile: I re-screen windows and sliding doors across Carmel Valley. Most homes take about two hours.",
    services: [{ service: "window-rescreening", duration_min: 120, buffer_min: 30, price_cents: 12000 }] },
  { name: "Devon Park", business_name: "Happy Tails", email: "devon@demo.test", hours: week([1, 2, 3, 4, 5, 6, 7], "07:00", "19:00"),
    areas: ["carmel-valley", "pacific-highlands-ranch", "torrey-hills"], bio: "Demo profile: dog walks and pet sitting, seven days a week.",
    services: [{ service: "pet-walking", duration_min: 30, buffer_min: 15, price_cents: 2500 }, { service: "pet-sitting", duration_min: 60, buffer_min: 15, price_cents: 4500 }] },
  { name: "Sam Rivera", business_name: null, email: "sam@demo.test", hours: week([1, 3, 5], "09:00", "17:00"),
    areas: ["carmel-valley", "rancho-penasquitos"], bio: null,
    services: [{ service: "pet-walking", duration_min: 45, buffer_min: 15, price_cents: 2800 }] },
];
for (const v of demo) {
  const { id } = await createVendor(v);
  await db().query(`UPDATE users SET password_hash = $1 WHERE vendor_id = $2`, [hash, id]);
  await setHours(id, { rules: v.hours, settings: { min_notice_min: 120, max_days_ahead: 60, slot_step_min: 30 } });
  await updateProfile(id, { business_name: v.business_name, bio: v.bio, areas: v.areas });
}
const t0 = DateTime.now().setZone("America/Los_Angeles").startOf("day").plus({ days: 1 });
const sample = [
  ["window-rescreening", 1, 9, "Jordan Lee", "4410 Calle Mar, San Diego"],
  ["pet-walking", 1, 12, "Riley Chen", "13020 Torrey Pines Rd, San Diego"],
  ["pet-walking", 2, 8, "Alex Kim", "6040 Rancho Bernardo Ln, San Diego"],
  ["pet-sitting", 3, 17, "Casey Morgan", "11200 Carmel Mountain Rd, San Diego"],
  ["window-rescreening", 4, 10, "Taylor Brooks", "5450 Del Mar Heights Rd, San Diego"],
];
for (const [svc, d, h, name, address] of sample) {
  try {
    await createBooking({ serviceSlug: svc, start: t0.plus({ days: d }).set({ hour: h }).toJSDate(), name, phone: "(619) 555-0100",
      email: name.split(" ")[0].toLowerCase() + "@example.com", address, neighborhood: "Carmel Valley", notes: null });
  } catch (e) { /* demo slot might fall outside hours on some weekdays */ }
}

// HOA program: one community, two pros in the program, and a group day that's filling up
const { upsertCommunity, setVendorHoa, createGroupDay, resolveCommunity, reportLink } = await import("../lib/hoa.mjs");
await upsertCommunity({ name: "Carmel Ridge HOA", area: "carmel-valley", join_code: "CARMEL-DEMO", homes: 240, give_back_pct: 1,
  contact_name: "Pat (board)", contact_email: "board@demo.test", guidelines: "Charcoal screen mesh only. Work hours 8am–5pm. Check in at the front gate." });
const ids = Object.fromEntries((await db().query(`SELECT email, id FROM vendors`)).map((r) => [r.email, r.id]));
await setVendorHoa(ids["maria@demo.test"], { enabled: true, resident_pct: 10, group_pct: 20, group_min: 4 });
await setVendorHoa(ids["devon@demo.test"], { enabled: true, resident_pct: 10, group_pct: 15, group_min: 3 });
const gdDay = t0.plus({ days: 8 });
const gd = await createGroupDay(ids["maria@demo.test"], { community: "carmel-ridge-hoa", service: "window-rescreening",
  date: gdDay.toISODate(), start: "08:00", end: "16:00", common_area_job: "Re-screen the clubhouse windows" });
const community = await resolveCommunity({ code: "CARMEL-DEMO" });
for (const [h, name] of [[8, "Ana Ridge"], [10, "Ben Ridge"]]) {
  await createBooking({ groupDayId: gd.id, community, start: gdDay.set({ hour: h }).toJSDate(), name, phone: "(619) 555-0101",
    email: name.split(" ")[0].toLowerCase() + "@example.com", address: `${h} Ridge Ct, San Diego`, neighborhood: "Carmel Valley", notes: null });
}
const report = await reportLink("carmel-ridge-hoa");

// --- server ------------------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".xml": "application/xml", ".txt": "text/plain", ".ics": "text/calendar" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ics/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await handle(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      const headers = Object.fromEntries(r.headers);
      const cookies = r.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies; // keep each cookie as its own header line
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (req.method === "POST") { res.writeHead(303, { location: "/thanks/" }); res.end(); return; } // Netlify Forms stand-in
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, p);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) && url.pathname === "/admin/") file = join(DIST, "vendor/index.html");
    if (!existsSync(file)) { res.writeHead(404, { "content-type": TYPES[".html"] }); res.end(readFileSync(join(DIST, "404.html"))); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  } catch (err) {
    console.error(err);
    res.writeHead(500); res.end("dev server error");
  }
}).listen(PORT, () => {
  console.log(`\nNeighborhood Perks running at http://localhost:${PORT}`);
  console.log(`  Book:       http://localhost:${PORT}/book/`);
  console.log(`  Dashboard:  http://localhost:${PORT}/vendor/`);
  console.log(`  Admin login:     admin@demo.test / ${PASSWORD}`);
  console.log(`  Provider logins: maria@demo.test, devon@demo.test, sam@demo.test / ${PASSWORD}`);
  console.log(`  HOA resident page: http://localhost:${PORT}/community/?code=CARMEL-DEMO`);
  console.log(`  HOA board report:  ${report.url}\n`);
});
