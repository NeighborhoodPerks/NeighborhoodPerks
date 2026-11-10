import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.mjs";
import { handle } from "../netlify/functions/api.mjs";
import { looksRandom, suspiciousEmail } from "../lib/botcheck.mjs";
import { sent } from "../lib/notify.mjs";
import { db } from "../lib/db.mjs";

const call = async (method, path, body) => {
  const res = await handle(new Request("http://localhost:8888" + path, {
    method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, data: await res.json(), cookies: res.headers.getSetCookie() };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const accounts = async (email) => (await db().query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)`, [email]))[0].n;
const pro = (extra = {}) => ({
  as: "provider", name: "Rosa Reyes", business_name: "Reyes Plumbing", email: "rosa@example.com", phone: "(858) 555-0142",
  password: "rosa-password-1", services: ["plumbing"], areas: ["carmel-valley"], ...extra,
});

before(async () => {
  await freshDb();
  process.env.REQUIRE_FORM_TOKEN = "1";
  process.env.BOT_MIN_FORM_SECONDS = "1";
});
after(() => { process.env.REQUIRE_FORM_TOKEN = "0"; delete process.env.BOT_MIN_FORM_SECONDS; });

test("the names the sign-up bots used are caught; real names are not", () => {
  for (const n of ["QCyTVXzNIlvAljMpYRdOAQkn", "NFWrhLHDaEnSVJCIalt", "GLzYaPMdQIBLUQNdnCr", "wqzzqjvMWmPGZYFshD", "luhxFdkjHExCjDJm"]) {
    assert.ok(looksRandom(n), n);
  }
  for (const n of ["Shae", "Rosa Reyes", "DeShawn McDonald", "Mary-Kate O'Neil", "MacKenzie", "LaToya", "JWRP Inc",
    "ABC Plumbing", "Neighborhood Perks Dog Walking", "VanDerBerg", "McCALLISTER", ""]) {
    assert.ok(!looksRandom(n), n);
  }
});

test("padded Gmail addresses and email-to-text gateways are caught; normal addresses are not", () => {
  for (const e of ["ic.e.nu.kom.3.0@gmail.com", "ryan...syk.e.s.7.77.4@gmail.com", "p.oe..he.il.b.r.on.n.e.r@gmail.com", "9076879333@txt.att.net"]) {
    assert.ok(suspiciousEmail(e), e);
  }
  for (const e of ["rosa@example.com", "john.smith@gmail.com", "neighborhoodperks+dogwalking@gmail.com", "a.b.c.d@company.com"]) {
    assert.ok(!suspiciousEmail(e), e);
  }
});

test("sign-up needs a form token", async () => {
  const r = await call("POST", "/api/auth/signup", pro());
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "form_token");
  assert.equal(await accounts("rosa@example.com"), 0);
});

test("bots get a normal-looking answer but no account, no cookie and no email", async () => {
  sent.length = 0;
  const fresh = (await call("GET", "/api/auth/form-token")).data.token;
  const tooFast = await call("POST", "/api/auth/signup", pro({ form_token: fresh, email: "fast@example.com" }));
  assert.equal(tooFast.status, 201);
  assert.equal(tooFast.cookies.length, 0);
  assert.equal(await accounts("fast@example.com"), 0, "submitted the instant the form opened");

  await sleep(1100);
  for (const [why, extra] of [
    ["honeypot", { website: "http://spam.example", email: "hp@example.com" }],
    ["random name", { name: "QCyTVXzNIlvAljMpYRdOAQkn", business_name: "Ansadwc LLC", email: "victim@example.com" }],
    ["padded gmail", { email: "ic.e.nu.kom.3.0@gmail.com" }],
  ]) {
    const r = await call("POST", "/api/auth/signup", pro({ form_token: fresh, ...extra }));
    assert.equal(r.status, 201, why);
    assert.equal(r.cookies.length, 0, why);
    assert.equal(await accounts(extra.email), 0, why);
  }
  assert.equal(sent.length, 0, "nobody was emailed");
});

test("a real pro signs up for a newly opened trade, and the token can't be reused", async () => {
  sent.length = 0;
  const token = (await call("GET", "/api/auth/form-token")).data.token;
  await sleep(1100);
  const r = await call("POST", "/api/auth/signup", pro({ form_token: token }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.cookies.length > 0, "signed in");
  assert.equal(await accounts("rosa@example.com"), 1);
  assert.ok(sent.some((m) => m.to === "rosa@example.com"), "applicant gets the confirmation");

  const again = await call("POST", "/api/auth/signup", pro({ form_token: token, email: "rosa2@example.com" }));
  assert.equal(again.status, 400);
  assert.equal(again.data.code, "form_token");
});

test("every home-service trade is open to pros, and homeowners only see trades a pro offers", async () => {
  const slugs = (await call("GET", "/api/services")).data.services.map((s) => s.slug);
  for (const s of ["house-cleaning", "landscaping", "pool-service", "plumbing", "electrical", "hvac", "handyman", "pest-control",
    "roofing", "painting", "pet-grooming", "window-rescreening", "pet-walking", "pet-sitting"]) {
    assert.ok(slugs.includes(s), s);
  }
  const pros = (await call("GET", "/api/pros?area=carmel-valley")).data.pros;
  assert.equal(pros.length, 0, "Rosa is still pending, so no plumbing shows up for homeowners");
});
