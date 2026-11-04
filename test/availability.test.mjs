import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSlots, isSlotAvailable } from "../lib/availability.mjs";

const TZ = "America/Los_Angeles";
const base = {
  timezone: TZ,
  rules: [{ weekday: 1, start_time: "09:00", end_time: "17:00" }], // Mondays
  busy: [],
  durationMin: 60,
  bufferMin: 15,
  stepMin: 30,
  minNoticeMin: 0,
  maxDaysAhead: 60,
  now: new Date("2026-11-01T12:00:00Z"),
};
const local = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });

test("a plain Monday gives every half hour where the job fits", () => {
  const s = generateSlots({ ...base, fromDate: "2026-11-02", toDate: "2026-11-02" })["2026-11-02"];
  assert.equal(s.length, 15); // 9:00 … 16:00
  assert.equal(local(s[0]), "9:00 AM");
  assert.equal(local(s.at(-1)), "4:00 PM");
});

test("days without hours are empty, not missing", () => {
  const s = generateSlots({ ...base, fromDate: "2026-11-03", toDate: "2026-11-04" });
  assert.deepEqual(s, { "2026-11-03": [], "2026-11-04": [] });
});

test("a booking blocks itself plus the travel buffer on both sides", () => {
  // Existing job 12:00–13:00 + 15 min buffer → busy until 13:15 (PST, UTC-8)
  const busy = [{ start: new Date("2026-11-02T20:00:00Z"), end: new Date("2026-11-02T21:15:00Z") }];
  const s = generateSlots({ ...base, busy, fromDate: "2026-11-02", toDate: "2026-11-02" })["2026-11-02"].map(local);
  assert.ok(s.includes("10:30 AM"), "10:30 job + buffer ends 11:45, fine");
  assert.ok(!s.includes("11:00 AM"), "11:00 job + buffer runs to 12:15, clashes");
  assert.ok(!s.includes("1:00 PM"), "still inside the other booking's buffer");
  assert.ok(s.includes("1:30 PM"));
});

test("minimum notice hides slots that are too soon", () => {
  const now = new Date("2026-11-02T17:00:00Z"); // 9:00 AM local Monday
  const s = generateSlots({ ...base, now, minNoticeMin: 120, fromDate: "2026-11-02", toDate: "2026-11-02" })["2026-11-02"];
  assert.equal(local(s[0]), "11:00 AM");
});

test("nothing is offered past the booking window", () => {
  const s = generateSlots({ ...base, maxDaysAhead: 7, fromDate: "2026-11-02", toDate: "2026-11-16" });
  assert.ok(s["2026-11-02"].length > 0);
  assert.equal(s["2026-11-09"].length, 0); // now is Nov 1, +7 days = Nov 8
  assert.equal(s["2026-11-16"].length, 0);
});

test("9 AM stays 9 AM across daylight saving (spring forward)", () => {
  const rules = [6, 1].map((weekday) => ({ weekday, start_time: "09:00", end_time: "10:00" }));
  const s = generateSlots({ ...base, rules, now: new Date("2026-03-01T00:00:00Z"), fromDate: "2026-03-07", toDate: "2026-03-09" });
  assert.deepEqual(s["2026-03-07"], ["2026-03-07T17:00:00.000Z"]); // PST, UTC-8
  assert.deepEqual(s["2026-03-09"], ["2026-03-09T16:00:00.000Z"]); // PDT, UTC-7
});

test("9 AM stays 9 AM across daylight saving (fall back)", () => {
  const rules = [6, 1].map((weekday) => ({ weekday, start_time: "09:00", end_time: "10:00" }));
  const s = generateSlots({ ...base, rules, now: new Date("2026-10-20T00:00:00Z"), fromDate: "2026-10-31", toDate: "2026-11-02" });
  assert.deepEqual(s["2026-10-31"], ["2026-10-31T16:00:00.000Z"]); // PDT
  assert.deepEqual(s["2026-11-02"], ["2026-11-02T17:00:00.000Z"]); // PST
});

test("split shifts (morning + afternoon) both offer slots, the lunch gap does not", () => {
  const rules = [
    { weekday: 1, start_time: "09:00", end_time: "12:00" },
    { weekday: 1, start_time: "13:00", end_time: "15:00" },
  ];
  const s = generateSlots({ ...base, rules, fromDate: "2026-11-02", toDate: "2026-11-02" })["2026-11-02"].map(local);
  assert.deepEqual(s, ["9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM", "1:00 PM", "1:30 PM", "2:00 PM"]);
});

test("isSlotAvailable agrees with the slot list", () => {
  const o = { ...base };
  assert.equal(isSlotAvailable(o, "2026-11-02T17:00:00.000Z"), true);  // 9:00
  assert.equal(isSlotAvailable(o, "2026-11-02T17:10:00.000Z"), false); // off the half-hour grid
  assert.equal(isSlotAvailable(o, "2026-11-03T17:00:00.000Z"), false); // Tuesday, no hours
});
