// Hourly: reminders and expiry for prices waiting on a customer, and for quotes (lib/sweep.mjs)
import { sweep } from "../../lib/sweep.mjs";

export default async () => {
  const done = await sweep();
  console.log("sweep", JSON.stringify(done));
  return new Response(JSON.stringify(done), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "@hourly" };
