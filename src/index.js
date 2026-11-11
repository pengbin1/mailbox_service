import {
  clearSessionCookie, constantTimeEqual, error, hmacHex, isMailboxActive,
  isSecureRequest, json, parseFutureTimestamp, randomAddress, randomSecret,
  readCookie, readJson, senderAddress, sessionCookie, validDomain, validOrigin,
} from "./lib.js";
import { extractPokemonCode, parseMail, parseMailHeaders } from "./mime.js";
import { CLIENT, PAGE, STYLE } from "./ui.js";

const ADMIN_PREFIX = "/api/admin/mailboxes";
const COOKIE = "pm_session";
const OFFICIAL_SENDER = "info@mail-pokemon-cafe.jp";

function configReady(env) {
  return Boolean(env.DB && env.RAW_MAIL && env.ADMIN_API_KEY && env.AUTH_PEPPER && validDomain(env.MAIL_DOMAIN));
}

function pageResponse(body, type) {
  return new Response(body, {
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

async function adminAuthorized(request, env) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice(7), env.ADMIN_API_KEY);
}

async function sessionMailbox(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token || token.length < 32 || token.length > 128) return null;
  const tokenHash = await hmacHex(env.AUTH_PEPPER, token);
  return env.DB.prepare(
    `SELECT m.id, m.address, m.status, m.expires_at, s.token_hash
     FROM sessions s JOIN mailboxes m ON m.id = s.mailbox_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(tokenHash, new Date().toISOString()).first();
}

async function requireMailbox(request, env) {
  const mailbox = await sessionMailbox(request, env);
  return isMailboxActive(mailbox) ? mailbox : null;
}

async function getMailbox(env, id) {
  return env.DB.prepare(
    "SELECT id, external_id, address, status, created_at, expires_at, purge_at, password_hash FROM mailboxes WHERE id = ?",
  ).bind(id).first();
}

function publicMailbox(mailbox) {
  return {
    id: mailbox.id,
    externalId: mailbox.external_id,
    address: mailbox.address,
    status: isMailboxActive(mailbox) ? "active" : "inactive",
    createdAt: mailbox.created_at,
    expiresAt: mailbox.expires_at,
    purgeAt: mailbox.purge_at,
    credentialsIssued: Boolean(mailbox.password_hash),
  };
}

async function createMailbox(request, env) {
  const body = await readJson(request);
  if (!body || typeof body.externalId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.externalId)) {
    return error("externalId 格式无效");
  }
  const expiresAt = parseFutureTimestamp(body.expiresAt);
  if (!expiresAt) return error("expiresAt 必须是未来 90 天内、带时区的时间");
  const existing = await env.DB.prepare("SELECT * FROM mailboxes WHERE external_id = ?").bind(body.externalId).first();
  if (existing) return json(publicMailbox(existing), 200);
  const id = crypto.randomUUID();
  const address = randomAddress(env.MAIL_DOMAIN.toLowerCase());
  const now = new Date().toISOString();
  const configuredGrace = Number(env.PURGE_GRACE_HOURS);
  const graceHours = Math.min(720, Math.max(0, Number.isFinite(configuredGrace) ? configuredGrace : 48));
  const purgeAt = new Date(Date.parse(expiresAt) + graceHours * 3600000).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO mailboxes (id, external_id, address, status, created_at, expires_at, purge_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(id, body.externalId, address, now, expiresAt, purgeAt).run();
  } catch (cause) {
    console.error("mailbox create failed", cause?.name || "unknown");
    return error("创建失败，请重试；如已创建可用相同 externalId 查询", 503);
  }
  return json({ id, externalId: body.externalId, address, status: "active", createdAt: now, expiresAt, purgeAt, credentialsIssued: false }, 201);
}

async function issueCredentials(env, mailbox) {
  if (!isMailboxActive(mailbox)) return error("邮箱已经停用或过期", 409);
  const password = randomSecret(24);
  const hash = await hmacHex(env.AUTH_PEPPER, password);
  await env.DB.batch([
    env.DB.prepare("UPDATE mailboxes SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?")
      .bind(hash, mailbox.id),
    env.DB.prepare("DELETE FROM sessions WHERE mailbox_id = ?").bind(mailbox.id),
  ]);
  return json({ address: mailbox.address, password, expiresAt: mailbox.expires_at }, 200);
}

async function disableMailbox(env, mailbox) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE mailboxes SET status = 'disabled', purge_at = ? WHERE id = ?")
      .bind(now, mailbox.id),
    env.DB.prepare("DELETE FROM sessions WHERE mailbox_id = ?").bind(mailbox.id),
  ]);
  return json({ id: mailbox.id, status: "disabled", purgeAt: now });
}

async function listAdminMessages(env, id) {
  const result = await env.DB.prepare(
    `SELECT id, header_from, subject, received_at, size_bytes
     FROM messages WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT 50`,
  ).bind(id).all();
  return json({ messages: (result.results || []).map((row) => ({
    id: row.id, from: row.header_from, subject: row.subject,
    receivedAt: row.received_at, sizeBytes: row.size_bytes,
  })) });
}

async function findVerificationCode(request, env, mailbox) {
  const sinceText = new URL(request.url).searchParams.get("since");
  const since = sinceText && Date.parse(sinceText);
  const now = Date.now();
  if (!since || since > now || since < now - 86400000) {
    return error("since 必须是最近 24 小时内的带时区时间");
  }
  const result = await env.DB.prepare(
    `SELECT id, r2_key, header_from, received_at FROM messages
     WHERE mailbox_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 20`,
  ).bind(mailbox.id, new Date(since).toISOString()).all();
  for (const row of result.results || []) {
    if (senderAddress(row.header_from) !== OFFICIAL_SENDER) continue;
    const object = await env.RAW_MAIL.get(row.r2_key);
    if (!object) continue;
    const mail = parseMail(new Uint8Array(await object.arrayBuffer()));
    const code = extractPokemonCode(mail.text);
    if (code) return json({ code, messageId: row.id, receivedAt: row.received_at });
  }
  return error("尚未收到匹配的验证码邮件", 404);
}

async function handleAdmin(request, env, path) {
  if (!(await adminAuthorized(request, env))) return error("未授权", 401);
  if (!validOrigin(request)) return error("来源无效", 403);
  if (path === ADMIN_PREFIX && request.method === "POST") return createMailbox(request, env);
  const match = /^\/api\/admin\/mailboxes\/([a-f0-9-]{36})(?:\/(credentials|disable|messages|code))?$/.exec(path);
  if (!match) return error("接口不存在", 404);
  const mailbox = await getMailbox(env, match[1]);
  if (!mailbox) return error("邮箱不存在", 404);
  const action = match[2];
  if (!action && request.method === "GET") return json(publicMailbox(mailbox));
  if (action === "credentials" && request.method === "POST") return issueCredentials(env, mailbox);
  if (action === "disable" && request.method === "POST") return disableMailbox(env, mailbox);
  if (action === "messages" && request.method === "GET") return listAdminMessages(env, mailbox.id);
  if (action === "code" && request.method === "GET") return findVerificationCode(request, env, mailbox);
  return error("方法不支持", 405);
}

async function login(request, env) {
  if (!validOrigin(request)) return error("来源无效", 403);
  const body = await readJson(request);
  if (!body || typeof body.address !== "string" || typeof body.password !== "string" || body.password.length > 200) {
    return error("邮箱或密码错误", 401);
  }
  const address = body.address.trim().toLowerCase();
  const mailbox = await env.DB.prepare("SELECT * FROM mailboxes WHERE address = ?").bind(address).first();
  if (!isMailboxActive(mailbox) || !mailbox.password_hash) return error("邮箱或密码错误", 401);
  if (mailbox.locked_until && Date.parse(mailbox.locked_until) > Date.now()) return error("登录暂时受限，请稍后再试", 429);
  const candidate = await hmacHex(env.AUTH_PEPPER, body.password);
  if (!constantTimeEqual(candidate, mailbox.password_hash)) {
    const failures = (mailbox.failed_logins || 0) + 1;
    const lockedUntil = failures >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
    await env.DB.prepare("UPDATE mailboxes SET failed_logins = ?, locked_until = ? WHERE id = ?")
      .bind(failures >= 5 ? 0 : failures, lockedUntil, mailbox.id).run();
    return error("邮箱或密码错误", 401);
  }
  const token = randomSecret(32);
  const tokenHash = await hmacHex(env.AUTH_PEPPER, token);
  const expiresAt = new Date(Math.min(Date.now() + 12 * 3600000, Date.parse(mailbox.expires_at))).toISOString();
  await env.DB.prepare("UPDATE mailboxes SET failed_logins = 0, locked_until = NULL WHERE id = ?")
    .bind(mailbox.id).run();
  await env.DB.prepare("INSERT INTO sessions (token_hash, mailbox_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, mailbox.id, new Date().toISOString(), expiresAt).run();
  return json({ address: mailbox.address, expiresAt: mailbox.expires_at }, 200, {
    "set-cookie": sessionCookie(token, expiresAt, isSecureRequest(request)),
  });
}

async function logout(request, env) {
  if (!validOrigin(request)) return error("来源无效", 403);
  const token = readCookie(request, COOKIE);
  if (token) {
    const hash = await hmacHex(env.AUTH_PEPPER, token);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(isSecureRequest(request)) });
}

async function listUserMessages(env, mailbox) {
  const result = await env.DB.prepare(
    `SELECT id, header_from, subject, received_at FROM messages
     WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT 50`,
  ).bind(mailbox.id).all();
  return json({ messages: (result.results || []).map((row) => ({
    id: row.id, from: row.header_from, subject: row.subject, receivedAt: row.received_at,
  })) });
}

async function readUserMessage(env, mailbox, id, rawDownload) {
  const row = await env.DB.prepare(
    "SELECT * FROM messages WHERE id = ? AND mailbox_id = ?",
  ).bind(id, mailbox.id).first();
  if (!row) return error("邮件不存在", 404);
  const object = await env.RAW_MAIL.get(row.r2_key);
  if (!object) return error("邮件原文暂不可用", 503);
  if (rawDownload) {
    return new Response(object.body, {
      headers: {
        "content-type": "message/rfc822",
        "content-disposition": `attachment; filename="${id}.eml"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  const parsed = parseMail(new Uint8Array(await object.arrayBuffer()));
  return json({
    id: row.id, from: parsed.from || row.header_from, to: parsed.to || mailbox.address,
    subject: parsed.subject || row.subject, date: parsed.date,
    receivedAt: row.received_at, text: parsed.text,
  });
}

async function handleUser(request, env, path) {
  if (path === "/api/login" && request.method === "POST") return login(request, env);
  if (path === "/api/logout" && request.method === "POST") return logout(request, env);
  const mailbox = await requireMailbox(request, env);
  if (!mailbox) return error("请登录或邮箱已到期", 401);
  if (path === "/api/me" && request.method === "GET") return json({ address: mailbox.address, expiresAt: mailbox.expires_at });
  if (path === "/api/messages" && request.method === "GET") return listUserMessages(env, mailbox);
  const match = /^\/api\/messages\/([a-f0-9-]{36})(\/raw)?$/.exec(path);
  if (match && request.method === "GET") return readUserMessage(env, mailbox, match[1], Boolean(match[2]));
  return error("接口不存在", 404);
}

async function receiveEmail(message, env) {
  if (!configReady(env)) {
    message.setReject("Mail service unavailable");
    return;
  }
  const address = String(message.to || "").trim().toLowerCase();
  if (!address.endsWith(`@${env.MAIL_DOMAIN.toLowerCase()}`)) {
    message.setReject("Unknown recipient");
    return;
  }
  const mailbox = await env.DB.prepare("SELECT id, status, expires_at FROM mailboxes WHERE address = ?")
    .bind(address).first();
  if (!isMailboxActive(mailbox)) {
    message.setReject("Unknown or expired recipient");
    return;
  }
  const maxBytes = Math.min(25 * 1024 * 1024, Math.max(1024, Number(env.MAX_MESSAGE_BYTES) || 1048576));
  if (message.rawSize && message.rawSize > maxBytes) {
    message.setReject("Message too large");
    return;
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM messages WHERE mailbox_id = ?")
    .bind(mailbox.id).first();
  const maxMessages = Math.min(500, Math.max(1, Number(env.MAX_MESSAGES_PER_MAILBOX) || 50));
  if ((count?.total || 0) >= maxMessages) {
    message.setReject("Mailbox full");
    return;
  }
  const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  if (bytes.length > maxBytes) {
    message.setReject("Message too large");
    return;
  }
  const parsed = parseMailHeaders(bytes);
  if (parsed.messageId) {
    const duplicate = await env.DB.prepare(
      "SELECT id FROM messages WHERE mailbox_id = ? AND rfc_message_id = ?",
    ).bind(mailbox.id, parsed.messageId).first();
    if (duplicate) return;
  }
  const id = crypto.randomUUID();
  const key = `${mailbox.id}/${id}.eml`;
  try {
    await env.RAW_MAIL.put(key, bytes, { httpMetadata: { contentType: "message/rfc822" } });
    await env.DB.prepare(
      `INSERT INTO messages (id, mailbox_id, r2_key, rfc_message_id, envelope_from, header_from, subject, received_at, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, mailbox.id, key, parsed.messageId, String(message.from || ""), parsed.from, parsed.subject,
      new Date().toISOString(), bytes.length).run();
  } catch (cause) {
    await env.RAW_MAIL.delete(key).catch(() => {});
    console.error("email storage failed", cause?.name || "unknown");
    message.setReject("Temporary mailbox failure");
  }
}

async function purgeExpired(env) {
  if (!env.DB || !env.RAW_MAIL) return;
  const now = new Date().toISOString();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  const result = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE purge_at <= ? ORDER BY purge_at LIMIT 20",
  ).bind(now).all();
  for (const mailbox of result.results || []) {
    const messages = await env.DB.prepare(
      "SELECT id, r2_key FROM messages WHERE mailbox_id = ? LIMIT 100",
    ).bind(mailbox.id).all();
    for (const item of messages.results || []) {
      try {
        await env.RAW_MAIL.delete(item.r2_key);
        await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(item.id).run();
      } catch (cause) {
        console.error("mail purge failed", cause?.name || "unknown");
      }
    }
    const remaining = await env.DB.prepare("SELECT id FROM messages WHERE mailbox_id = ? LIMIT 1")
      .bind(mailbox.id).first();
    if (!remaining) {
      await env.DB.prepare("DELETE FROM sessions WHERE mailbox_id = ?").bind(mailbox.id).run();
      await env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(mailbox.id).run();
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === "http:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    const path = url.pathname;
    if (request.method === "GET" && (path === "/" || path === "/login")) {
      return pageResponse(PAGE, "text/html; charset=utf-8");
    }
    if (request.method === "GET" && path === "/assets/style.css") return pageResponse(STYLE, "text/css; charset=utf-8");
    if (request.method === "GET" && path === "/assets/client.js") return pageResponse(CLIENT, "text/javascript; charset=utf-8");
    if (request.method === "GET" && path === "/health") return json({ ok: true });
    if (!configReady(env)) return error("服务尚未配置", 503);
    try {
      if (path.startsWith(ADMIN_PREFIX)) return await handleAdmin(request, env, path);
      if (path.startsWith("/api/")) return await handleUser(request, env, path);
      return error("页面不存在", 404);
    } catch (cause) {
      console.error("request failed", cause?.name || "unknown");
      return error("服务暂时不可用", 503);
    }
  },
  async email(message, env) {
    try {
      await receiveEmail(message, env);
    } catch (cause) {
      console.error("email handler failed", cause?.name || "unknown");
      message.setReject("Temporary mailbox failure");
    }
  },
  async scheduled(_event, env) {
    try {
      await purgeExpired(env);
    } catch (cause) {
      console.error("scheduled purge failed", cause?.name || "unknown");
    }
  },
};
