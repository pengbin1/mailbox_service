import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

class MemoryDB {
  constructor() {
    this.mailboxes = new Map();
    this.messages = new Map();
    this.sessions = new Map();
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql) {
    const db = this;
    const query = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      values: [],
      bind(...values) { this.values = values; return this; },
      async first() {
        const a = this.values;
        if (query.includes("from mailboxes where external_id =")) return [...db.mailboxes.values()].find((m) => m.external_id === a[0]) || null;
        if (query.includes("from mailboxes where address =")) return [...db.mailboxes.values()].find((m) => m.address === a[0]) || null;
        if (query.includes("from mailboxes where id =")) return db.mailboxes.get(a[0]) || null;
        if (query.includes("count(*) as total from messages")) return { total: [...db.messages.values()].filter((m) => m.mailbox_id === a[0]).length };
        if (query.includes("from messages where mailbox_id = ? and rfc_message_id =")) {
          return [...db.messages.values()].find((m) => m.mailbox_id === a[0] && m.rfc_message_id === a[1]) || null;
        }
        if (query.includes("from messages where id = ? and mailbox_id =")) {
          const row = db.messages.get(a[0]);
          return row?.mailbox_id === a[1] ? row : null;
        }
        if (query.includes("from messages where mailbox_id = ? limit 1")) {
          return [...db.messages.values()].find((m) => m.mailbox_id === a[0]) || null;
        }
        if (query.includes("from sessions s join mailboxes m")) {
          const session = db.sessions.get(a[0]);
          const mailbox = session && db.mailboxes.get(session.mailbox_id);
          return session && session.expires_at > a[1] && mailbox
            ? { ...mailbox, token_hash: session.token_hash } : null;
        }
        throw new Error(`Unhandled SELECT: ${query}`);
      },
      async all() {
        const a = this.values;
        if (query.includes("from messages where mailbox_id = ? and received_at >= ?")) {
          return { results: [...db.messages.values()].filter((m) => m.mailbox_id === a[0] && m.received_at >= a[1])
            .sort((x, y) => y.received_at.localeCompare(x.received_at)).slice(0, 20) };
        }
        if (query.includes("from messages where mailbox_id = ?")) {
          return { results: [...db.messages.values()].filter((m) => m.mailbox_id === a[0])
            .sort((x, y) => y.received_at.localeCompare(x.received_at)).slice(0, query.includes("limit 100") ? 100 : 50) };
        }
        if (query.includes("from mailboxes where purge_at <= ?")) {
          return { results: [...db.mailboxes.values()].filter((m) => m.purge_at <= a[0]).slice(0, 20) };
        }
        throw new Error(`Unhandled ALL: ${query}`);
      },
      async run() {
        const a = this.values;
        if (query.startsWith("insert into mailboxes")) {
          db.mailboxes.set(a[0], { id: a[0], external_id: a[1], address: a[2], status: "active",
            created_at: a[3], expires_at: a[4], purge_at: a[5], password_hash: null,
            failed_logins: 0, locked_until: null });
        } else if (query.startsWith("insert into messages")) {
          db.messages.set(a[0], { id: a[0], mailbox_id: a[1], r2_key: a[2], rfc_message_id: a[3],
            envelope_from: a[4], header_from: a[5], subject: a[6], received_at: a[7], size_bytes: a[8] });
        } else if (query.startsWith("insert into sessions")) {
          db.sessions.set(a[0], { token_hash: a[0], mailbox_id: a[1], created_at: a[2], expires_at: a[3] });
        } else if (query.startsWith("update mailboxes set password_hash")) {
          Object.assign(db.mailboxes.get(a[1]), { password_hash: a[0], failed_logins: 0, locked_until: null });
        } else if (query.startsWith("update mailboxes set failed_logins")) {
          if (a.length === 1) {
            Object.assign(db.mailboxes.get(a[0]), { failed_logins: 0, locked_until: null });
          } else {
            Object.assign(db.mailboxes.get(a[2]), { failed_logins: a[0], locked_until: a[1] });
          }
        } else if (query.startsWith("update mailboxes set status")) {
          Object.assign(db.mailboxes.get(a[1]), { status: "disabled", purge_at: a[0] });
        } else if (query.startsWith("delete from sessions where mailbox_id")) {
          for (const [key, row] of db.sessions) if (row.mailbox_id === a[0]) db.sessions.delete(key);
        } else if (query.startsWith("delete from sessions where token_hash")) {
          db.sessions.delete(a[0]);
        } else if (query.startsWith("delete from sessions where expires_at")) {
          for (const [key, row] of db.sessions) if (row.expires_at <= a[0]) db.sessions.delete(key);
        } else if (query.startsWith("delete from messages where id")) {
          db.messages.delete(a[0]);
        } else if (query.startsWith("delete from mailboxes where id")) {
          db.mailboxes.delete(a[0]);
        } else {
          throw new Error(`Unhandled RUN: ${query}`);
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
}

class MemoryR2 {
  constructor() { this.objects = new Map(); }
  async put(key, bytes) { this.objects.set(key, new Uint8Array(bytes)); }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      body: new Response(bytes).body };
  }
  async delete(key) { this.objects.delete(key); }
}

function env() {
  return { DB: new MemoryDB(), RAW_MAIL: new MemoryR2(), ADMIN_API_KEY: "admin-key-for-tests",
    AUTH_PEPPER: "a-long-random-pepper-for-tests", MAIL_DOMAIN: "example.com",
    MAX_MESSAGE_BYTES: "1048576", MAX_MESSAGES_PER_MAILBOX: "50", PURGE_GRACE_HOURS: "48" };
}

async function call(envObject, path, method = "GET", body = null, extraHeaders = {}) {
  return worker.fetch(new Request(`https://inbox.example.com${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : null,
  }), envObject);
}

const admin = { authorization: "Bearer admin-key-for-tests" };

test("create, receive, read code, hand off, isolate and revoke a customer mailbox", async () => {
  const e = env();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const firstResponse = await call(e, "/api/admin/mailboxes", "POST", { externalId: "order-001", expiresAt }, admin);
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.match(first.address, /^mb-.+@example\.com$/);
  assert.equal(first.credentialsIssued, false);
  const repeat = await call(e, "/api/admin/mailboxes", "POST", { externalId: "order-001", expiresAt }, admin);
  assert.equal((await repeat.json()).id, first.id);
  const secondResponse = await call(e, "/api/admin/mailboxes", "POST", { externalId: "order-002", expiresAt }, admin);
  const second = await secondResponse.json();
  assert.notEqual(first.address, second.address);

  const raw = `From: Pokemon Cafe <info@mail-pokemon-cafe.jp>\r\nTo: ${first.address}\r\nSubject: Verification\r\nMessage-ID: <code-1@example.jp>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n認証コード（Authentication code）\r\n834921\r\n`;
  const rejection = [];
  await worker.email({ to: first.address, from: "info@mail-pokemon-cafe.jp",
    rawSize: new TextEncoder().encode(raw).length, raw: new Response(raw).body,
    setReject: (reason) => rejection.push(reason) }, e);
  assert.deepEqual(rejection, []);
  assert.equal(e.RAW_MAIL.objects.size, 1);

  const since = encodeURIComponent(new Date(Date.now() - 60000).toISOString());
  const codeResponse = await call(e, `/api/admin/mailboxes/${first.id}/code?since=${since}`, "GET", null, admin);
  assert.equal(codeResponse.status, 200);
  assert.equal((await codeResponse.json()).code, "834921");
  const issue = await call(e, `/api/admin/mailboxes/${first.id}/credentials`, "POST", null, admin);
  const credentials = await issue.json();
  assert.equal(issue.status, 200);
  assert.equal(credentials.address, first.address);
  const login = await call(e, "/api/login", "POST", credentials);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const userHeaders = { cookie };
  const listResponse = await call(e, "/api/messages", "GET", null, userHeaders);
  const messages = (await listResponse.json()).messages;
  assert.equal(messages.length, 1);
  const readResponse = await call(e, `/api/messages/${messages[0].id}`, "GET", null, userHeaders);
  assert.match((await readResponse.json()).text, /834921/);
  const rawResponse = await call(e, `/api/messages/${messages[0].id}/raw`, "GET", null, userHeaders);
  assert.equal(rawResponse.status, 200);
  assert.match(await rawResponse.text(), /Message-ID: <code-1@example.jp>/);

  const reset = await call(e, `/api/admin/mailboxes/${first.id}/credentials`, "POST", null, admin);
  const newCredentials = await reset.json();
  assert.notEqual(newCredentials.password, credentials.password);
  assert.equal((await call(e, "/api/me", "GET", null, userHeaders)).status, 401);
  assert.equal((await call(e, "/api/login", "POST", credentials)).status, 401);
  const newLogin = await call(e, "/api/login", "POST", newCredentials);
  assert.equal(newLogin.status, 200);
  const currentCookie = newLogin.headers.get("set-cookie").split(";")[0];

  const secondIssue = await call(e, `/api/admin/mailboxes/${second.id}/credentials`, "POST", null, admin);
  const secondLogin = await call(e, "/api/login", "POST", await secondIssue.json());
  const secondCookie = secondLogin.headers.get("set-cookie").split(";")[0];
  const crossRead = await call(e, `/api/messages/${messages[0].id}`, "GET", null, { cookie: secondCookie });
  assert.equal(crossRead.status, 404);

  const disable = await call(e, `/api/admin/mailboxes/${first.id}/disable`, "POST", null, admin);
  assert.equal(disable.status, 200);
  assert.equal((await call(e, "/api/me", "GET", null, { cookie: currentCookie })).status, 401);
  const afterDisable = [];
  await worker.email({ to: first.address, from: "info@mail-pokemon-cafe.jp",
    rawSize: 1, raw: new Response("x").body, setReject: (reason) => afterDisable.push(reason) }, e);
  assert.equal(afterDisable.length, 1);
  await worker.scheduled({}, e);
  assert.equal(e.DB.mailboxes.has(first.id), false);
  assert.equal(e.RAW_MAIL.objects.size, 0);
});

test("unknown addresses, oversized messages and wrong administrator keys are rejected", async () => {
  const e = env();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await call(e, "/api/admin/mailboxes", "POST", { externalId: "x", expiresAt },
    { authorization: "Bearer wrong" })).status, 401);
  const response = await call(e, "/api/admin/mailboxes", "POST", { externalId: "order-limits", expiresAt }, admin);
  const mailbox = await response.json();
  const rejected = [];
  await worker.email({ to: "unknown@example.com", rawSize: 1, setReject: (reason) => rejected.push(reason) }, e);
  assert.equal(rejected.length, 1);
  await worker.email({ to: mailbox.address, rawSize: 1048577,
    setReject: (reason) => rejected.push(reason) }, e);
  assert.equal(rejected.length, 2);
  assert.equal(e.DB.messages.size, 0);
  const redirect = await worker.fetch(new Request("http://inbox.example.com/"), e);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "https://inbox.example.com/");
});

test("expired mailbox is unavailable even before scheduled cleanup", async () => {
  const e = env();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const response = await call(e, "/api/admin/mailboxes", "POST", { externalId: "order-expiry", expiresAt }, admin);
  const mailbox = await response.json();
  const issue = await call(e, `/api/admin/mailboxes/${mailbox.id}/credentials`, "POST", null, admin);
  const login = await call(e, "/api/login", "POST", await issue.json());
  const cookie = login.headers.get("set-cookie").split(";")[0];
  e.DB.mailboxes.get(mailbox.id).expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call(e, "/api/me", "GET", null, { cookie })).status, 401);
});
