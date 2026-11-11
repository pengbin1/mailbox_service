const encoder = new TextEncoder();

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

export function error(message, status = 400) {
  return json({ error: message }, status);
}

export function randomSecret(byteCount = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomAddress(domain) {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const localPart = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `mb-${localPart}@${domain}`;
}

export async function hmacHex(pepper, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

export function parseFutureTimestamp(value, now = Date.now()) {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now || timestamp > now + 90 * 86400000) return null;
  return new Date(timestamp).toISOString();
}

export function isMailboxActive(mailbox, now = Date.now()) {
  return Boolean(mailbox && mailbox.status === "active" && Date.parse(mailbox.expires_at) > now);
}

export function validOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export function sessionCookie(token, expiresAt, secure = true) {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return `pm_session=${token}; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(secure = true) {
  return `pm_session=; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Path=/; Max-Age=0`;
}

export function readCookie(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const prefix = `${name}=`;
  for (const item of cookie.split(";")) {
    const part = item.trim();
    if (part.startsWith(prefix)) return part.slice(prefix.length);
  }
  return null;
}

export function isSecureRequest(request) {
  return new URL(request.url).protocol === "https:";
}

export async function readJson(request) {
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function validDomain(domain) {
  return typeof domain === "string" && domain.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
}

export function senderAddress(value) {
  const bracket = /<([^<>]+)>/.exec(value || "");
  return (bracket ? bracket[1] : value || "").trim().toLowerCase();
}
