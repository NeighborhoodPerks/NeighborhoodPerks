// Database access. One small interface used everywhere:
//   const rows = await db.query(sql, params)
//   await db.tx(async (t) => { await t.query(...) })   // BEGIN … COMMIT, ROLLBACK on throw
// Production: Neon (Netlify DB). Tests / local dev: PGlite, injected with setDb().

let current = null;

export function setDb(adapter) { current = adapter; }

export function db() {
  if (current) return current;
  const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("No database configured (NETLIFY_DATABASE_URL or DATABASE_URL)");
  current = neonAdapter(url);
  return current;
}

export function neonAdapter(url) {
  let httpSql = null;
  let mod = null;
  const load = async () => (mod ||= await import("@neondatabase/serverless"));
  return {
    async query(text, params = []) {
      const { neon } = await load();
      httpSql ||= neon(url, { fullResults: true });
      const res = await httpSql.query(text, params);
      return res.rows;
    },
    async tx(fn) {
      // Interactive transactions need a real connection; open one per transaction
      const { Pool } = await load();
      const pool = new Pool({ connectionString: url });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: async (t, p = []) => (await client.query(t, p)).rows });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch {}
        throw err;
      } finally {
        client.release();
        await pool.end();
      }
    },
  };
}

export function pgliteAdapter(pg) {
  // PGlite runs one statement at a time, so serialise transactions the way a
  // real server's row locks would.
  let chain = Promise.resolve();
  const run = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    query: (text, params = []) => run(async () => (await pg.query(text, params)).rows),
    tx: (fn) => run(() => pg.transaction(async (t) => fn({ query: async (q, p = []) => (await t.query(q, p)).rows }))),
  };
}

// Postgres error helpers
export const isOverlapError = (err) => err && (err.code === "23P01" || /bookings_no_overlap/.test(err.message || ""));
export const isUniqueError = (err) => err && err.code === "23505";
