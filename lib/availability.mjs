// Slot generation. Pure: no database, no clock (pass `now`), so it is fully testable.
//
// A slot at time S for a job of D minutes with buffer B is offered when:
//   - [S, S+D] fits inside one of the vendor's working windows that day (local time)
//   - [S, S+D+B) overlaps no busy interval (other bookings incl. their buffer, time off)
//   - S is at least `minNoticeMin` after now and within `maxDaysAhead` days
// Windows are local wall-clock times, so 9:00–17:00 stays 9:00–17:00 across DST.

import { DateTime } from "luxon";

const MIN = 60_000;

function parseTime(t) {
  const [h, m] = String(t).split(":").map(Number);
  return { hour: h, minute: m || 0 };
}

/**
 * @param {object} o
 * @param {string} o.timezone        IANA zone, e.g. America/Los_Angeles
 * @param {{weekday:number,start_time:string,end_time:string}[]} o.rules  weekday 1=Mon..7=Sun
 * @param {{start:Date,end:Date}[]} o.busy
 * @param {number} o.durationMin
 * @param {number} o.bufferMin
 * @param {number} o.stepMin
 * @param {number} o.minNoticeMin
 * @param {number} o.maxDaysAhead
 * @param {Date}   o.now
 * @param {string} o.fromDate  YYYY-MM-DD (local), inclusive
 * @param {string} o.toDate    YYYY-MM-DD (local), inclusive
 * @returns {Record<string, string[]>} local date -> slot starts (UTC ISO strings), ascending
 */
export function generateSlots(o) {
  const zone = o.timezone;
  const now = DateTime.fromJSDate(o.now, { zone });
  const earliest = now.plus({ minutes: o.minNoticeMin });
  const lastDay = now.startOf("day").plus({ days: o.maxDaysAhead }).endOf("day");
  const busy = o.busy
    .map((b) => [b.start.getTime(), b.end.getTime()])
    .sort((a, b) => a[0] - b[0]);
  const needMs = (o.durationMin + o.bufferMin) * MIN;
  const jobMs = o.durationMin * MIN;
  const stepMs = o.stepMin * MIN;

  const out = {};
  let day = DateTime.fromISO(o.fromDate, { zone }).startOf("day");
  const end = DateTime.fromISO(o.toDate, { zone }).startOf("day");
  if (!day.isValid || !end.isValid) throw new Error("Invalid date range");
  if (end.diff(day, "days").days > 62) throw new Error("Date range too large");

  for (; day <= end; day = day.plus({ days: 1 })) {
    const key = day.toISODate();
    const starts = new Set();
    if (day <= lastDay) {
      for (const r of o.rules) {
        if (r.weekday !== day.weekday) continue;
        const ws = day.set(parseTime(r.start_time)).toMillis();
        const we = day.set(parseTime(r.end_time)).toMillis();
        for (let s = ws; s + jobMs <= we; s += stepMs) {
          if (s < earliest.toMillis()) continue;
          if (DateTime.fromMillis(s, { zone }) > lastDay) break;
          if (overlapsBusy(busy, s, s + needMs)) continue;
          starts.add(s);
        }
      }
    }
    out[key] = [...starts].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
  }
  return out;
}

function overlapsBusy(busy, s, e) {
  for (const [bs, be] of busy) {
    if (bs >= e) break;          // sorted by start: nothing later can overlap
    if (be > s) return true;
  }
  return false;
}

/** Is one specific start time bookable? Same rules as generateSlots. */
export function isSlotAvailable(o, startIso) {
  const zone = o.timezone;
  const date = DateTime.fromISO(startIso, { zone }).toISODate();
  const slots = generateSlots({ ...o, fromDate: date, toDate: date });
  const want = new Date(startIso).toISOString();
  return (slots[date] || []).includes(want);
}
