# Neighborhood Perks — www.neighborhoodperks.com

Marketing site + online booking for a neighborhood home-services network.

## What's here

| Part | Where |
|---|---|
| Marketing pages | `src/pages/*.html` (JSON front matter sets title, URL, extra CSS/JS), built by `build.js` into `dist/` |
| Customer booking (`/book/`) | `assets/app/booking.js` — ZIP or neighborhood → pros who work there (photo, bio, prices, next opening) → that pro's calendar → details → confirmed, pro notified |
| Customer's private booking page (`/booking/?t=…`) | `assets/app/manage.js` — see, move, cancel |
| Provider + admin dashboard (`/vendor/`) | `assets/app/dashboard.js` — "What's new", calendar (FullCalendar 6), profile (photo, bio, neighborhoods), hours, services, phone-calendar link; admin also gets providers and neighborhoods |
| API (`/api/*`, `/ics/*`) | `netlify/functions/api.mjs` → `lib/*.mjs` |
| Database schema | `db/schema.sql` (Postgres; applied on every build by `scripts/migrate.mjs`) |

## How bookings stay correct

- Open times come from each provider's weekly hours (San Diego wall-clock time, DST-safe), minus their
  bookings (plus travel buffer) and time off, minus anything inside their minimum notice.
- Every booking is written in a transaction that locks the provider, re-checks the slot, then inserts.
- Postgres itself refuses overlapping bookings for one provider (`bookings_no_overlap` exclusion
  constraint), so two people clicking the same time can never both get it.
- Customers book a specific provider; a booking is never handed to someone else, and the provider must serve the
  customer's neighborhood (`areas` + `vendor_areas`, matched by name or ZIP).
- Every change is logged in `booking_events` (who, what, when).

## Run it locally

```
npm install
npm test          # 38 tests: slot math (incl. DST), races, areas, photos, permissions, API
npm run dev       # http://localhost:8888 with demo providers and bookings (in-memory database)
```

Demo logins (local only): `admin@demo.test`, `maria@demo.test`, `devon@demo.test`, `sam@demo.test`,
password `neighborhood-demo`.

## Going live on Netlify

1. **Database:** in the Netlify site, Extensions → Neon → add a database (this sets `NETLIFY_DATABASE_URL`).
   Or set `DATABASE_URL` to any Postgres 14+ that allows the `btree_gist` extension.
2. **Environment variables:** `SITE_URL=https://neighborhoodperks.com`.
   For emails: `RESEND_API_KEY` and `MAIL_FROM` (e.g. `Neighborhood Perks <bookings@neighborhoodperks.com>`).
   Without them bookings still work; emails are skipped and logged.
3. **Deploy.** The build creates the tables.
4. **First admin:** `DATABASE_URL=… SITE_URL=https://neighborhoodperks.com node scripts/admin.mjs you@example.com`
   prints a one-time link to set your password. Then add providers from the dashboard's Providers tab.

Forms that aren't bookings (contact, provider applications, service votes, "something else" requests)
still use Netlify Forms: Netlify → Forms, and turn on email notifications.
