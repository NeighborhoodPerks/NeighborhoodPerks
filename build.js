#!/usr/bin/env node
// Builds the static site into dist/. No dependencies.
//   node build.js
// Each page in src/pages/*.html starts with a JSON front-matter comment:
//   <!--{"title": "...", "description": "...", "path": "/services/"}-->
// and may use {{icon:name}}, {{phone}}, {{phone_href}}, {{email}} tokens.

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "dist");
const SITE = "https://neighborhoodperks.com";

const BIZ = {
  name: "Neighborhood Perks",
  phone: "(619) 736-3618",
  phone_href: "tel:+16197363618",
  email: "NeighborhoodPerks@gmail.com",
  facebook: "https://www.facebook.com/181299341742974",
  instagram: "https://www.instagram.com/neighborhoodperks/",
};

const icons = require("./src/icons.js");

const NAV = [
  ["/services/", "Services"],
  ["/#how-it-works", "How it works"],
  ["/providers/", "For pros"],
  ["/about/", "About"],
  ["/contact/", "Contact"],
];

function header(current) {
  const links = NAV.map(([href, label]) => {
    const cur = href === current ? ' aria-current="page"' : "";
    return `<a href="${href}"${cur}>${label}</a>`;
  }).join("\n        ");
  return `<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/" aria-label="${BIZ.name} home">
      ${icons.mark}
      <span class="brand-name"><span>Neighborhood</span><span>Perks</span></span>
    </a>
    <nav class="nav" id="site-nav" aria-label="Main">
        ${links}
        <a class="nav-phone" href="/signin/" data-account-link>Sign in</a>
        <a class="nav-phone" href="${BIZ.phone_href}">Call ${BIZ.phone}</a>
    </nav>
    <div class="header-cta">
      <a class="header-phone" href="${BIZ.phone_href}">${BIZ.phone}</a>
      <a class="header-signin" href="/signin/" data-account-link>Sign in</a>
      <a class="btn btn-primary" href="/book/">Book a service</a>
      <button class="menu-toggle" type="button" aria-controls="site-nav" aria-expanded="false"><span class="bars"></span><span class="sr-only">Menu</span></button>
    </div>
  </div>
</header>`;
}

function footer() {
  return `<footer class="site-footer">
  <div class="wrap">
    <div class="footer-grid">
      <div>
        <a class="brand brand-stacked" href="/" aria-label="${BIZ.name} home">${icons.mark}<span class="brand-name"><span>Neighborhood</span><span>Perks</span></span></a>
        <p>Vetted local pros for Carmel Valley, Torrey Highlands and the neighborhoods around them, booked together so everyone gets a better rate.</p>
        <div class="socials">
          <a href="${BIZ.facebook}" aria-label="Neighborhood Perks on Facebook" rel="noopener" target="_blank">${icons.facebook}</a>
          <a href="${BIZ.instagram}" aria-label="Neighborhood Perks on Instagram" rel="noopener" target="_blank">${icons.instagram}</a>
        </div>
      </div>
      <div>
        <h4>Services</h4>
        <ul>
          <li><a href="/services/window-rescreening/">Window re-screening</a></li>
          <li><a href="/services/dog-walking/">Dog walking</a></li>
          <li><a href="/services/pet-sitting/">Pet sitting</a></li>
          <li><a href="/services/#coming-soon">Coming soon</a></li>
        </ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul>
          <li><a href="/areas/">Neighborhoods we serve</a></li>
          <li><a href="/about/">About</a></li>
          <li><a href="/providers/">Become a provider</a></li>
          <li><a href="/book/">Book a service</a></li>
          <li><a href="/contact/">Contact</a></li>
        </ul>
      </div>
      <div>
        <h4>Get in touch</h4>
        <ul>
          <li><a href="${BIZ.phone_href}">${BIZ.phone}</a></li>
          <li><a href="mailto:${BIZ.email}">${BIZ.email}</a></li>
          <li>Torrey Highlands, San Diego, CA</li>
          <li>Mon–Sat 8am–7pm · Sun 8am–5pm</li>
        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© <span id="year">2026</span> Neighborhood Perks. All rights reserved.</span>
      <span>Proudly local to San Diego</span>
    </div>
  </div>
</footer>
<div class="mobile-bar">
  <a class="btn btn-ghost" href="${BIZ.phone_href}">${icons.phone} Call</a>
  <a class="btn btn-primary" href="/book/">Book a service</a>
</div>`;
}

// The service pages, used for the business's offer catalog and each page's Service data
const SERVICES = [
  { name: "Window re-screening", path: "/services/window-rescreening/" },
  { name: "Dog walking", path: "/services/dog-walking/" },
  { name: "Pet sitting", path: "/services/pet-sitting/" },
];
const AREAS = ["Carmel Valley", "Torrey Highlands", "Pacific Highlands Ranch", "Del Mar Mesa", "Torrey Hills", "Rancho Peñasquitos"];
const areaServed = AREAS.map((n) => ({ "@type": "Place", name: n + ", San Diego, CA" }));

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "HomeAndConstructionBusiness",
  "@id": SITE + "/#business",
  name: BIZ.name,
  logo: SITE + "/assets/logo.png",
  url: SITE + "/",
  telephone: "+1-619-736-3618",
  email: BIZ.email,
  image: SITE + "/assets/og.png",
  address: { "@type": "PostalAddress", addressLocality: "San Diego", addressRegion: "CA", addressCountry: "US" },
  areaServed,
  hasOfferCatalog: {
    "@type": "OfferCatalog",
    name: "Home services",
    itemListElement: SERVICES.map((sv) => ({ "@type": "Offer", itemOffered: { "@type": "Service", name: sv.name, url: SITE + sv.path } })),
  },
  openingHoursSpecification: [
    { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], opens: "08:00", closes: "19:00" },
    { "@type": "OpeningHoursSpecification", dayOfWeek: "Sunday", opens: "08:00", closes: "17:00" },
  ],
  sameAs: [BIZ.facebook, BIZ.instagram],
};

const stripTags = (h) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").replace(/&amp;/g, "&").trim();

/** Search-engine data for a page: business (home), service, breadcrumbs, and FAQs read from the page itself. */
function structuredData(meta, body) {
  const out = [];
  if (meta.noindex) return out;
  if (meta.path === "/") out.push(jsonLd);
  if (meta.service) {
    out.push({
      "@context": "https://schema.org", "@type": "Service", name: meta.service.name, serviceType: meta.service.type || meta.service.name,
      description: meta.description, url: SITE + meta.path, areaServed, provider: { "@id": SITE + "/#business" },
    });
  }
  if (meta.path !== "/") {
    const crumbs = meta.crumbs || [["Home", "/"], [meta.crumb || meta.title, meta.path]];
    out.push({
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: crumbs.map(([name, p], i) => ({ "@type": "ListItem", position: i + 1, name, item: SITE + p })),
    });
  }
  // FAQs come straight from the <details><summary> blocks on the page, so the two can never disagree
  const faqs = [...body.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g)];
  if (faqs.length) {
    out.push({
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: faqs.map(([, q, a]) => ({ "@type": "Question", name: stripTags(q), acceptedAnswer: { "@type": "Answer", text: stripTags(a) } })),
    });
  }
  return out;
}

function page(meta, body) {
  const url = SITE + meta.path;
  const title = meta.path === "/" ? meta.title : `${meta.title} | Neighborhood Perks`;
  const robots = meta.noindex ? '\n<meta name="robots" content="noindex">' : "";
  const ld = structuredData(meta, body).map((o) => `\n<script type="application/ld+json">${JSON.stringify(o)}</script>`).join("");
  return `<!doctype html>
<html lang="en" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${meta.description}">${robots}
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#1f4d36">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Neighborhood Perks">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${meta.description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}${meta.og || "/assets/og.png"}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Figtree:wght@400..800&family=Fraunces:ital,opsz,SOFT,wght@0,9..144,0..100,400..700;1,9..144,0..100,400..700&display=swap">
<link rel="stylesheet" href="/assets/styles.css?v=${VERSION}">${(meta.css || []).map((c) => `\n<link rel="stylesheet" href="${c}?v=${VERSION}">`).join("")}${ld}
</head>
<body class="${meta.app ? "app-page" : "has-mobile-bar"}">
<a class="sr-only" href="#main">Skip to content</a>
${header(meta.nav || meta.path)}
<main id="main">
${body}
</main>
${meta.app ? "" : footer()}
<script src="/assets/site.js?v=${VERSION}" defer></script>${(meta.js || []).map((j) => `\n<script src="${j}${j.startsWith("/assets/vendor/") ? "" : `?v=${VERSION}`}" defer></script>`).join("")}
</body>
</html>
`;
}

function fill(html) {
  return html
    .replace(/\{\{icon:([a-z0-9-]+)\}\}/g, (_, n) => {
      if (!icons[n]) throw new Error("Unknown icon: " + n);
      return icons[n];
    })
    .replace(/\{\{phone\}\}/g, BIZ.phone)
    .replace(/\{\{phone_href\}\}/g, BIZ.phone_href)
    .replace(/\{\{email\}\}/g, BIZ.email);
}

// Short content hash so browsers pick up CSS/JS changes after each deploy
const crypto = require("crypto");
const VERSION = crypto.createHash("sha1")
  .update(fs.readFileSync(path.join(ROOT, "assets/styles.css")))
  .update(fs.readFileSync(path.join(ROOT, "assets/site.js")))
  .update(fs.readdirSync(path.join(ROOT, "assets/app")).sort().map((f) => fs.readFileSync(path.join(ROOT, "assets/app", f), "utf8")).join(""))
  .digest("hex").slice(0, 8);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(ROOT, "assets"), path.join(OUT, "assets"), { recursive: true });
// Third-party browser code we serve ourselves (no CDN dependency for the dashboard)
fs.mkdirSync(path.join(OUT, "assets/vendor"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "node_modules/fullcalendar/index.global.min.js"), path.join(OUT, "assets/vendor/fullcalendar-6.1.22.min.js"));

const urls = [];
for (const file of fs.readdirSync(path.join(SRC, "pages")).sort()) {
  if (!file.endsWith(".html")) continue;
  const raw = fs.readFileSync(path.join(SRC, "pages", file), "utf8");
  const m = raw.match(/^<!--(\{[\s\S]*?\})-->\s*/);
  if (!m) throw new Error(file + ": missing front matter");
  const meta = JSON.parse(m[1]);
  const html = page(meta, fill(raw.slice(m[0].length)));
  const dest = meta.file
    ? path.join(OUT, meta.file)
    : path.join(OUT, meta.path, "index.html");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, html);
  if (!meta.noindex) urls.push(meta.path);
  console.log("built", path.relative(ROOT, dest));
}

const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join("\n") + `\n</urlset>\n`);
// Private and app pages are noindex too; this also keeps crawlers out of the API
fs.writeFileSync(path.join(OUT, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /vendor/\nDisallow: /account/\nDisallow: /booking/\nDisallow: /signin/\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log("built sitemap.xml, robots.txt");
