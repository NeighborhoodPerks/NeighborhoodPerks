// Request/response helpers shared by every endpoint.

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (msg, code = "bad_request") => new HttpError(400, msg, code);
export const notFound = (msg = "Not found") => new HttpError(404, msg, "not_found");
export const conflict = (msg, code = "conflict") => new HttpError(409, msg, code);
export const unauthorized = () => new HttpError(401, "Please sign in.", "unauthorized");
export const forbidden = () => new HttpError(403, "You don't have access to that.", "forbidden");

export function json(data, status = 200, headers = {}) {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  // An array value (e.g. several set-cookie lines) becomes one header line each
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) v.forEach((x) => h.append(k, x)); else h.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers: h });
}

export async function readJson(req, maxBytes = 20_000) {
  const text = await req.text();
  if (text.length > maxBytes) throw bad("Request too large.");
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw bad("Invalid JSON.");
  }
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req) {
  return req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
}

// --- input validation -------------------------------------------------------

export function str(v, name, { max = 200, min = 1, optional = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (optional) return null;
    throw bad(`${name} is required.`, "invalid_" + name);
  }
  if (typeof v !== "string") throw bad(`${name} must be text.`, "invalid_" + name);
  const s = v.trim();
  if (s.length < min) throw bad(`${name} is required.`, "invalid_" + name);
  if (s.length > max) throw bad(`${name} is too long.`, "invalid_" + name);
  return s;
}

export function email(v, name = "Email") {
  const s = str(v, name, { max: 254 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad("Please enter a valid email address.", "invalid_email");
  return s.toLowerCase();
}

export function phone(v) {
  const s = str(v, "Phone", { max: 40 });
  if (s.replace(/\D/g, "").length < 10) throw bad("Please enter a phone number with area code.", "invalid_phone");
  return s;
}

export function isoInstant(v, name = "Time") {
  const s = str(v, name, { max: 40 });
  const d = new Date(s);
  if (Number.isNaN(d.getTime()) || !/T\d{2}:\d{2}/.test(s)) throw bad(`${name} is not a valid time.`, "invalid_time");
  return d;
}

export function isoDate(v, name = "Date") {
  const s = str(v, name, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${name} must be YYYY-MM-DD.`, "invalid_date");
  return s;
}

export function int(v, name, { min, max }) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}.`, "invalid_" + name);
  return n;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(v, name = "id") {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw notFound();
  return v;
}
