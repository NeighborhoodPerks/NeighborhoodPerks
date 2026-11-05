import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFrom } from "../lib/notify.mjs";

test("MAIL_FROM: the ways people type it in a settings box all work", () => {
  const want = "Neighborhood Perks <bookings@neighborhoodperks.com>";
  assert.equal(normalizeFrom("Neighborhood Perks <bookings@neighborhoodperks.com>"), want);
  assert.equal(normalizeFrom('"Neighborhood Perks <bookings@neighborhoodperks.com>"'), want);
  assert.equal(normalizeFrom("“Neighborhood Perks <bookings@neighborhoodperks.com>”"), want);
  assert.equal(normalizeFrom("  Neighborhood Perks<bookings@neighborhoodperks.com>  "), want);
  assert.equal(normalizeFrom('"Neighborhood Perks" <bookings@neighborhoodperks.com>'), want);
  assert.equal(normalizeFrom("Neighborhood Perks bookings@neighborhoodperks.com"), want);
  assert.equal(normalizeFrom("Neighborhood Perks <bookings@neighborhoodperks.com"), want);
  assert.equal(normalizeFrom("bookings@neighborhoodperks.com"), "bookings@neighborhoodperks.com");
  assert.equal(normalizeFrom("Neighborhood Perks"), null);
  assert.equal(normalizeFrom(""), null);
});
