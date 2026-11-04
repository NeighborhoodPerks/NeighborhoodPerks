import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { setDb, pgliteAdapter } from "../lib/db.mjs";

process.env.NODE_ENV = "test";
process.env.DISABLE_RATE_LIMIT = "1";
process.env.INSECURE_COOKIES = "1";
process.env.SITE_URL = "http://localhost:8888";

export async function freshDb() {
  const pg = new PGlite({ extensions: { btree_gist } });
  const schema = readFileSync(fileURLToPath(new URL("../db/schema.sql", import.meta.url)), "utf8");
  await pg.exec(schema);
  await pg.exec(schema); // must be safe to run twice (every deploy runs it)
  const adapter = pgliteAdapter(pg);
  setDb(adapter);
  return { pg, adapter };
}

export const ALL_WEEK = (start = "08:00", end = "18:00") =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start, end }));
