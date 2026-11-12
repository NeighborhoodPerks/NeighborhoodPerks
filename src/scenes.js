// Illustrated scenes for the inner pages, drawn from the same parts as the homepage street.
// Used in pages as {{scene:name}}. Each is a wide 1200x300 band (the map is 1200x560).

const icons = require("./icons.js");

const C = {
  ink: "#17261d", green: "#1f4d36", green2: "#2c6a4b", leaf: "#5f9f77", hill1: "#b8d5c1", hill2: "#8fbf9f",
  coral: "#e0603a", coralDark: "#c24c28", sun: "#f4b942", gold: "#c98a12", sky: "#cfe5ec",
  wall: "#fffaf2", cream: "#fdf1d4", road: "#efe6d4", curb: "#e2d6be", dash: "#d6c8ac", trunk: "#8a6a4a",
};
const W = 1200, H = 300, BASE = 244; // BASE: where houses stand

function frame(id, label, inner, h = H) {
  return `<svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="xMidYMax slice" role="img" aria-label="${label}">
<defs><linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.sky}"/><stop offset="1" stop-color="#f6efe2"/></linearGradient></defs>
<rect width="${W}" height="${h}" fill="url(#${id}-sky)"/>${inner}</svg>`;
}

const sun = (cx, cy, r = 38) => `<circle cx="${cx}" cy="${cy}" r="${r * 1.5}" fill="${C.sun}" opacity=".18"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${C.sun}"/>`;
const cloud = (x, y, s = 1) => `<path transform="translate(${x} ${y}) scale(${s})" d="M18 10a20 20 0 0 1 38-6 16 16 0 0 1 22 15H0a14 14 0 0 1 18-9Z" fill="#fff" opacity=".9"/>`;
const hills = () => `<path d="M0 170c120-60 260-70 400-36s240 20 360-28 260-30 440 6v188H0Z" fill="${C.hill1}"/><path d="M0 200c160-40 300-30 440-8s300 18 430-16 220-14 330-2v126H0Z" fill="${C.hill2}"/>`;
const street = () => `<rect y="${BASE}" width="${W}" height="${H - BASE}" fill="${C.road}"/><rect y="${BASE + 12}" width="${W}" height="10" fill="${C.curb}"/><path d="M0 ${BASE + 40}h${W}" stroke="${C.dash}" stroke-width="3" stroke-dasharray="22 18"/>`;
const shrub = (x, r = 14) => `<circle cx="${x}" cy="${BASE - r + 6}" r="${r}" fill="${C.leaf}"/>`;

function windowPane(x, y, w, h, trim, kind) {
  let fill = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${C.sky}" stroke="${trim}" stroke-width="3"/>`;
  if (kind === "mesh") {
    let lines = "";
    for (let i = 5; i < w; i += 5) lines += `M${x + i} ${y}v${h}`;
    for (let i = 5; i < h; i += 5) lines += `M${x} ${y + i}h${w}`;
    fill += `<path d="${lines}" stroke="${trim}" stroke-opacity=".3" stroke-width="1"/>`;
  } else if (kind === "cat") {
    const cx = x + w / 2, cy = y + h - 9;
    fill += `<g fill="${C.ink}"><circle cx="${cx}" cy="${cy}" r="9"/><path d="M${cx - 9} ${cy - 3}l2-11 6 7ZM${cx + 9} ${cy - 3}l-2-11-6 7Z"/></g><g fill="${C.sun}"><circle cx="${cx - 3.5}" cy="${cy - 1}" r="1.6"/><circle cx="${cx + 3.5}" cy="${cy - 1}" r="1.6"/></g>`;
  } else {
    fill += `<path d="M${x + w / 2} ${y}v${h}M${x} ${y + h / 2}h${w}" stroke="${trim}" stroke-width="2"/>`;
  }
  return fill;
}

/** A house standing on the street. o: wall, roof, trim, door, win ("cat" | "mesh" for the first window) */
function house(x, w, h, o = {}) {
  const wall = o.wall || C.wall, roof = o.roof || C.coral, trim = o.trim || C.green2, door = o.door || C.green;
  const top = BASE - h, rh = Math.min(Math.round(w * 0.42), top - 26); // big houses: keep the roof inside the frame
  const ww = Math.round(w * 0.24), wh = Math.round(ww * 0.88);
  const two = w >= 130;
  const dw = Math.round(w * 0.24), dh = Math.min(h - 30, Math.round(dw * 1.7));
  const doorX = two ? x + (w - dw) / 2 : x + w - dw - 14;
  let s = `<rect x="${x}" y="${top}" width="${w}" height="${h}" fill="${wall}"/>`;
  s += `<path d="M${x - 12} ${top + 6} ${x + w / 2} ${top - rh + 6}l${w / 2 + 12} ${rh}Z" fill="${roof}"/>`;
  s += windowPane(x + 14, top + 20, ww, wh, trim, o.win);
  if (two) s += windowPane(x + w - 14 - ww, top + 20, ww, wh, trim, o.win2);
  s += `<rect x="${doorX}" y="${BASE - dh}" width="${dw}" height="${dh}" rx="3" fill="${door}"/><circle cx="${doorX + dw - 7}" cy="${BASE - dh / 2}" r="2.4" fill="${C.sun}"/>`;
  return `<g>${s}</g>`;
}

function palm(x, s = 1) {
  return `<g transform="translate(${x} ${BASE}) scale(${s}) translate(-412 -404)"><path d="M412 404c4-60 2-110-12-156" fill="none" stroke="${C.trunk}" stroke-width="10" stroke-linecap="round"/><g fill="${C.green2}"><path d="M400 250c-28-20-62-18-82 4 30-6 56-4 82-4Z"/><path d="M400 250c-10-34-38-50-66-46 26 12 46 26 66 46Z"/><path d="M400 250c12-32 44-44 70-36-28 8-50 18-70 36Z"/><path d="M400 250c32-10 62 2 76 26-28-14-52-20-76-26Z"/><path d="M400 250c-2-30 12-54 30-62-12 22-22 40-30 62Z"/></g></g>`;
}

// The homepage van, bottom of the wheels at (x, y)
function van(x, y = 292, s = 0.62) {
  return `<g transform="translate(${x} ${y}) scale(${s}) translate(-96 -496)"><rect x="96" y="414" width="196" height="64" rx="16" fill="#fff"/><path d="M292 430h34c10 0 18 6 22 14l10 18v8a8 8 0 0 1-8 8h-58Z" fill="#fff"/><path d="M300 438h24c6 0 10 3 13 8l7 12h-44Z" fill="${C.sky}"/><rect x="96" y="452" width="262" height="8" fill="${C.coral}"/><circle cx="148" cy="480" r="16" fill="${C.ink}"/><circle cx="148" cy="480" r="6" fill="${C.road}"/><circle cx="310" cy="480" r="16" fill="${C.ink}"/><circle cx="310" cy="480" r="6" fill="${C.road}"/><g transform="translate(112 426) scale(.04)" fill="#1b2a21"><path d="M1 499H185V250L500 2 814 250V499H998V569H744V284L500 92 256 284V569H1Z"/><path d="M692 82H763V230H692Z"/><path d="M405 266h73v73h-73ZM521 266h73v73h-73ZM405 382h73v73h-73ZM521 382h73v73h-73Z"/></g><text x="158" y="445" font-family="'Bebas Neue', Oswald, sans-serif" font-size="22" letter-spacing=".6" fill="#1b2a21">NEIGHBORHOOD PERKS</text></g>`;
}

// One of the homepage service illustrations (120x120), placed at x,y with size
const art = (name, x, y, size) => icons[name].replace("<svg ", `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);

const pin = (x, y, fill = C.coral) => `<g transform="translate(${x} ${y})"><path d="M0 0c-9-12-15-19-15-27a15 15 0 0 1 30 0c0 8-6 15-15 27Z" fill="${fill}"/><circle cy="-27" r="5.5" fill="#fff"/></g>`;

function ladder(x, top) {
  // leans against a wall: top at x, foot further out
  const d = (BASE - top) * 0.2, at = (y) => x + ((y - top) / (BASE - top)) * d;
  let rungs = "";
  for (let y = top + 16; y < BASE - 4; y += 18) rungs += `M${at(y)} ${y}h26`;
  return `<g stroke="${C.trunk}" stroke-linecap="round"><path d="M${x} ${top}L${x + d} ${BASE}M${x + 26} ${top}L${x + 26 + d} ${BASE}" stroke-width="4"/><path d="${rungs}" stroke-width="3"/></g>`;
}

function mailbox(x) {
  return `<g><rect x="${x + 16}" y="${BASE - 58}" width="8" height="58" fill="${C.trunk}"/><path d="M${x} ${BASE - 56}v-22a18 18 0 0 1 18-18h4a18 18 0 0 1 18 18v22Z" fill="${C.green}"/><rect x="${x + 33}" y="${BASE - 100}" width="5" height="26" fill="${C.coral}"/><rect x="${x + 33}" y="${BASE - 100}" width="16" height="10" fill="${C.coral}"/><rect x="${x - 2}" y="${BASE - 60}" width="44" height="5" rx="2" fill="${C.ink}" opacity=".25"/></g>`;
}

const SCENES = {
  services: () => frame("sv", "A sunny street of homes with a dog walker and the Neighborhood Perks van", [
    sun(1010, 70), cloud(150, 50), cloud(560, 34, .8), hills(),
    house(70, 150, 112, { roof: C.coral }), shrub(240), house(300, 120, 96, { roof: C.green, wall: C.cream, door: C.coral, trim: C.green }),
    palm(470, .9), house(540, 160, 120, { roof: C.gold, trim: "#8a5a00", door: C.green2 }), shrub(720, 16),
    house(770, 130, 100, { roof: C.coral, wall: C.cream, door: C.green }), shrub(920, 12), palm(980, .8), house(1030, 140, 106, { roof: C.green }),
    street(), van(300, 292), art("art-walk", 830, 176, 110),
  ].join("")),

  "window-rescreening": () => frame("wr", "A house with new window screens, a ladder and the Neighborhood Perks van", [
    sun(180, 76), cloud(820, 40), cloud(1040, 70, .7), hills(),
    house(80, 120, 90, { roof: C.green, wall: C.cream, door: C.coral, trim: C.green }), shrub(230, 12),
    house(330, 300, 150, { roof: C.coral, trim: "#2a6576", win: "mesh", win2: "mesh" }), ladder(586, 104), shrub(310, 16),
    palm(760, .95), house(860, 150, 108, { roof: C.gold, trim: "#8a5a00", win: "mesh" }), shrub(1040),
    street(), van(880, 292, .6),
  ].join("")),

  "dog-walking": () => frame("dw", "A neighbor walking a dog down a sunny street", [
    sun(980, 74), cloud(120, 46), cloud(420, 30, .8), hills(),
    house(60, 140, 104, { roof: C.gold, trim: "#8a5a00" }), shrub(226), palm(300, .85),
    house(380, 130, 96, { roof: C.coral, wall: C.cream, door: C.green }), shrub(536, 16),
    house(860, 160, 116, { roof: C.green }), shrub(1046), house(1080, 120, 92, { roof: C.coral }),
    street(), art("art-walk", 560, 140, 150),
  ].join("")),

  "pet-sitting": () => frame("ps", "A house with a cat waiting in the window", [
    sun(190, 74), cloud(700, 40), hills(),
    house(60, 120, 90, { roof: C.green, wall: C.cream, door: C.coral, trim: C.green }), palm(260, .85),
    house(400, 280, 150, { roof: C.coral, win: "cat" }), shrub(380, 16), shrub(700, 14),
    house(780, 140, 104, { roof: C.gold, trim: "#8a5a00" }), shrub(950), house(1010, 150, 110, { roof: C.green, wall: C.cream, door: C.coral, trim: C.green }),
    street(), art("art-sit", 720, 192, 74),
  ].join("")),

  about: () => frame("ab", "The Neighborhood Perks van parked on a street in Torrey Highlands", [
    sun(1000, 72), cloud(230, 56), cloud(640, 30, .8), hills(),
    house(120, 150, 110, { roof: C.green, wall: C.cream, door: C.coral, trim: C.green }), shrub(296), palm(370, .9),
    house(440, 170, 128, { roof: C.coral }), shrub(630, 16), house(690, 130, 98, { roof: C.gold, trim: "#8a5a00" }),
    palm(880, .8), house(950, 150, 108, { roof: C.coral, wall: C.cream, door: C.green }),
    street(), van(470, 292, .7),
  ].join("")),

  providers: () => frame("pr", "The Neighborhood Perks van driving a short route between neighbors' homes", [
    sun(1080, 62, 30), cloud(560, 28, .7), hills(),
    `<path d="M120 54C260 20 330 98 470 66s250-40 390 4 200-10 240-26" fill="none" stroke="${C.coral}" stroke-width="3" stroke-dasharray="2 10" stroke-linecap="round"/>`,
    house(60, 130, 100, { roof: C.green }), house(380, 140, 104, { roof: C.coral, wall: C.cream, door: C.green }),
    house(700, 130, 98, { roof: C.gold, trim: "#8a5a00" }), house(1000, 140, 106, { roof: C.coral }),
    shrub(220), shrub(540, 16), palm(610, .8), shrub(860), palm(940, .75),
    pin(125, 104), pin(450, 98), pin(765, 108), pin(1070, 98),
    street(), van(160, 292, .62),
  ].join("")),

  hoa: () => frame("ho", "A row of homes around a community clubhouse and pool", [
    sun(150, 70), cloud(420, 40), cloud(960, 52, .8), hills(),
    house(30, 110, 86, { roof: C.coral }), house(160, 110, 86, { roof: C.green, wall: C.cream, door: C.coral, trim: C.green }),
    house(290, 110, 86, { roof: C.gold, trim: "#8a5a00" }),
    // clubhouse
    `<rect x="470" y="${BASE - 104}" width="260" height="104" fill="${C.cream}"/><path d="M450 ${BASE - 98}h300l-28-44H478Z" fill="${C.green}"/><rect x="560" y="${BASE - 60}" width="80" height="60" rx="3" fill="${C.coral}"/><rect x="490" y="${BASE - 82}" width="48" height="36" rx="3" fill="${C.sky}" stroke="${C.green}" stroke-width="3"/><rect x="662" y="${BASE - 82}" width="48" height="36" rx="3" fill="${C.sky}" stroke="${C.green}" stroke-width="3"/>`,
    palm(445, .8), palm(760, .85),
    house(820, 110, 86, { roof: C.coral, wall: C.cream, door: C.green }), house(950, 110, 86, { roof: C.green }), house(1080, 110, 86, { roof: C.gold, trim: "#8a5a00" }),
    street(), `<rect x="500" y="${BASE + 26}" width="200" height="24" rx="12" fill="${C.sky}"/><path d="M520 ${BASE + 38}q10-6 20 0t20 0 20 0 20 0 20 0 20 0 20 0 20 0" fill="none" stroke="#fff" stroke-width="2.5"/>`,
  ].join("")),

  contact: () => frame("ct", "A porch with a mailbox, its flag up", [
    sun(1010, 70), cloud(260, 44), hills(),
    house(80, 130, 98, { roof: C.gold, trim: "#8a5a00" }), shrub(240), palm(330, .85),
    house(420, 300, 150, { roof: C.green, wall: C.cream, door: C.coral, trim: C.green }), shrub(400, 16), shrub(740, 14),
    mailbox(790), house(920, 150, 108, { roof: C.coral }),
    street(),
  ].join("")),

  plain: () => frame("pl", "A quiet street of homes", [
    sun(1000, 72), cloud(200, 50), hills(),
    house(120, 140, 104, { roof: C.coral }), shrub(290), house(360, 130, 96, { roof: C.green, wall: C.cream, door: C.coral, trim: C.green }),
    palm(560, .85), house(640, 150, 110, { roof: C.gold, trim: "#8a5a00" }), shrub(820), house(880, 130, 98, { roof: C.coral, wall: C.cream, door: C.green }),
    street(),
  ].join("")),
};

// Neighborhood map for /areas/. Positions follow real geography loosely: it's an illustration.
const AREAS = [
  { slug: "pacific-highlands-ranch", name: "Pacific Highlands Ranch", x: 520, y: 150, fill: "#d9ead9" },
  { slug: "torrey-highlands", name: "Torrey Highlands", x: 840, y: 175, fill: "#fbe6dc", home: true },
  { slug: "carmel-valley", name: "Carmel Valley", x: 320, y: 300, fill: "#fdf1d4" },
  { slug: "del-mar-mesa", name: "Del Mar Mesa", x: 600, y: 380, fill: "#e2f0f4" },
  { slug: "torrey-hills", name: "Torrey Hills", x: 230, y: 455, fill: "#e3efe6" },
  { slug: "rancho-penasquitos", name: "Rancho Peñasquitos", x: 980, y: 380, fill: "#fdf1d4" },
];

function map() {
  const blobs = AREAS.map((a, i) => {
    const rx = 150 + (i % 3) * 14, ry = 78 + (i % 2) * 10;
    return `<ellipse cx="${a.x}" cy="${a.y}" rx="${rx}" ry="${ry}" fill="${a.fill}" stroke="#fff" stroke-width="4"/>`;
  }).join("");
  const labels = AREAS.map((a) => `<a href="/book/?area=${a.slug}" aria-label="See pros in ${a.name}">${pin(a.x, a.y - 8, a.home ? C.coral : C.green)}<text x="${a.x}" y="${a.y + 26}" text-anchor="middle" font-family="Figtree, system-ui, sans-serif" font-weight="700" font-size="21" fill="${C.ink}">${a.name}</text>${a.home ? `<text x="${a.x}" y="${a.y + 50}" text-anchor="middle" font-family="Figtree, system-ui, sans-serif" font-weight="600" font-size="16" fill="${C.coralDark}">Our home base</text>` : ""}</a>`).join("");
  return `<svg viewBox="0 0 ${W} 560" role="img" aria-label="Illustrated map of the six San Diego neighborhoods we serve">
<rect width="${W}" height="560" fill="#eef4ea"/>
<path d="M0 0h120c-20 80 10 160-10 260s30 200 0 300H0Z" fill="${C.sky}"/>
<path d="M60 40c30 120-20 220 10 330s-10 150 0 190" fill="none" stroke="#fff" stroke-width="3" opacity=".7"/>
${blobs}
<path d="M90 300C300 260 420 250 560 268s320 18 560 4" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round"/>
<path d="M90 300C300 260 420 250 560 268s320 18 560 4" fill="none" stroke="${C.dash}" stroke-width="2" stroke-dasharray="14 12"/>
<g transform="translate(700 252)"><path d="M-17-16h34v18c0 10-8 16-17 20-9-4-17-10-17-20Z" fill="${C.green}" stroke="#fff" stroke-width="2.5"/><text y="4" text-anchor="middle" font-family="Figtree, system-ui, sans-serif" font-weight="800" font-size="15" fill="#fff">56</text></g>
${labels}
<text x="${W - 24}" y="540" text-anchor="end" font-family="Figtree, system-ui, sans-serif" font-size="15" fill="#6b7a70">Illustration, not to scale</text>
</svg>`;
}

module.exports = { ...Object.fromEntries(Object.entries(SCENES).map(([k, f]) => [k, f()])), map: map() };
