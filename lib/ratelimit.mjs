import { db } from "./db.mjs";
import { HttpError } from "./http.mjs";

/** Fixed-window limit: at most `limit` calls per `windowSec` for this key. */
export async function rateLimit(key, limit, windowSec) {
  if (process.env.DISABLE_RATE_LIMIT === "1") return;
  const [r] = await db().query(
    `INSERT INTO rate_limits (key, count, window_end) VALUES ($1, 1, now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_end < now() THEN 1 ELSE rate_limits.count + 1 END,
       window_end = CASE WHEN rate_limits.window_end < now() THEN now() + make_interval(secs => $2) ELSE rate_limits.window_end END
     RETURNING count`,
    [key, windowSec]
  );
  if (r.count > limit) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.", "rate_limited");
}
