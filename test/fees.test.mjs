import { test } from "node:test";
import assert from "node:assert/strict";
import fees from "../lib/fees.cjs";

const fee = (dollars) => fees.feeFor(Math.round(dollars * 100)) / 100;

test("10% up to $1,000", () => {
  assert.equal(fee(30), 3);
  assert.equal(fee(45), 4.5);
  assert.equal(fee(1000), 100);
});

test("5% on the part above $1,000, like tax brackets", () => {
  assert.equal(fee(1000.01), 100);
  assert.equal(fee(1500), 125);
  assert.equal(fee(5000), 300);
  assert.equal(fee(15000), 800);
});

test("the fee never jumps down as a job gets bigger", () => {
  let last = 0;
  for (let c = 0; c <= 3_000_000; c += 997) {
    const f = fees.feeFor(c);
    assert.ok(f >= last, `fee dropped at ${c}`);
    last = f;
  }
});

test("our share always covers card processing (2.9% + 30c)", () => {
  for (const c of [500, 3000, 4500, 100_000, 1_500_000, 5_000_000]) {
    assert.ok(fees.feeFor(c) > Math.round(c * 0.029) + 30, `loses money at ${c}`);
  }
});

test("the biggest HOA give-back still leaves us more than card processing", () => {
  // from $30 up: on a $5 job Stripe's fixed 30c eats nearly any fee, and resident jobs aren't that small
  for (const c of [3000, 4500, 100_000, 1_500_000, 5_000_000]) {
    const left = fees.feeFor(c) - Math.round((c * fees.MAX_GIVE_BACK_BPS) / 10000);
    assert.ok(left > Math.round(c * 0.029) + 30, `give-back loses money at ${c}`);
  }
});

test("summary reads the way the providers page says it", () => {
  assert.equal(fees.feeSummary(), "10% of the first $1,000, 5% after that");
});
