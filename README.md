# Neighborhood Perks — www.neighborhoodperks.com

Static marketing site. No dependencies.

- Edit pages in `src/pages/*.html` (JSON front matter at the top sets title, description, URL).
- Shared header/footer, contact details and SEO tags live in `build.js`; icons in `src/icons.js`.
- Styles: `assets/styles.css`. Script: `assets/site.js`.
- `node build.js` writes the site to `dist/` (the only folder Netlify publishes).
- Preview: `node build.js && npx serve dist` (or `python3 -m http.server -d dist 8080`).

Forms (booking, provider-application, contact, service-vote) use Netlify Forms.
Submissions appear in Netlify → Site → Forms; turn on email notifications there.
