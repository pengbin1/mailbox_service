import test from "node:test";
import assert from "node:assert/strict";
import {
  constantTimeEqual, hmacHex, isMailboxActive, parseFutureTimestamp,
  randomAddress, randomSecret, senderAddress, validDomain,
} from "../src/lib.js";

test("generated credentials and addresses are unique and syntactically valid", () => {
  const secrets = new Set(Array.from({ length: 100 }, () => randomSecret()));
  const addresses = new Set(Array.from({ length: 100 }, () => randomAddress("example.com")));
  assert.equal(secrets.size, 100);
  assert.equal(addresses.size, 100);
  for (const address of addresses) assert.match(address, /^mb-[a-f0-9]{30}@example\.com$/);
});

test("secret hashing does not expose or confuse passwords", async () => {
  const a = await hmacHex("long-secret-pepper", "correct-password");
  const b = await hmacHex("long-secret-pepper", "wrong-password");
  assert.equal(a.length, 64);
  assert.equal(constantTimeEqual(a, a), true);
  assert.equal(constantTimeEqual(a, b), false);
  assert.equal(constantTimeEqual(a, ""), false);
});

test("expiry requires an explicit timezone and an allowed future window", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  assert.equal(parseFutureTimestamp("2026-11-12T09:00:00+09:00", now), "2026-11-12T00:00:00.000Z");
  assert.equal(parseFutureTimestamp("2026-11-12T09:00:00", now), null);
  assert.equal(parseFutureTimestamp("2026-11-10T00:00:00Z", now), null);
  assert.equal(parseFutureTimestamp("2027-03-01T00:00:00Z", now), null);
  assert.equal(isMailboxActive({ status: "active", expires_at: "2026-11-12T00:00:00Z" }, now), true);
  assert.equal(isMailboxActive({ status: "disabled", expires_at: "2026-11-12T00:00:00Z" }, now), false);
});

test("domain and sender checks use exact addresses", () => {
  assert.equal(validDomain("example.com"), true);
  assert.equal(validDomain("mail.example.com"), true);
  assert.equal(validDomain("example.com.attacker"), true);
  assert.equal(validDomain("bad_domain.com"), false);
  assert.equal(senderAddress("Pokemon Cafe <info@mail-pokemon-cafe.jp>"), "info@mail-pokemon-cafe.jp");
  assert.equal(senderAddress("info@mail-pokemon-cafe.jp.attacker"), "info@mail-pokemon-cafe.jp.attacker");
});
