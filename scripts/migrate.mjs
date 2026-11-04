// Applies db/schema.sql. Runs on every Netlify build; safe to re-run.
// Skips quietly when no database is configured (e.g. a plain static preview).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.log("migrate: no database configured, skipping");
  process.exit(0);
}
const sql = readFileSync(fileURLToPath(new URL("../db/schema.sql", import.meta.url)), "utf8");
const { Pool } = await import("@neondatabase/serverless");
const pool = new Pool({ connectionString: url });
try {
  await pool.query(sql);
  console.log("migrate: schema up to date");
} finally {
  await pool.end();
}
