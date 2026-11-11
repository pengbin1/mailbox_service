import test from "node:test";
import assert from "node:assert/strict";
import { extractPokemonCode, parseMail, parseMailHeaders } from "../src/mime.js";

const encoder = new TextEncoder();

test("parses a multipart Japanese confirmation email", () => {
  const plain = "ご予約ありがとうございます。\n予約番号: ABC123\n認証コード（Authentication code）\n834921\n";
  const raw = [
    "From: Pokemon Cafe <info@mail-pokemon-cafe.jp>",
    "To: mb-test@example.com",
    "Subject: =?UTF-8?B?5LqI57SE56K66KqN?=",
    "Date: Wed, 11 Nov 2026 12:00:00 +0900",
    "Message-ID: <reservation-1@example.jp>",
    'Content-Type: multipart/alternative; boundary="part-1"',
    "", "--part-1", "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64", "", Buffer.from(plain).toString("base64"),
    "--part-1", "Content-Type: text/html; charset=UTF-8", "", "<p>確認</p>",
    "--part-1--", "",
  ].join("\r\n");
  const headers = parseMailHeaders(encoder.encode(raw));
  const parsed = parseMail(encoder.encode(raw));
  assert.equal(headers.messageId, "<reservation-1@example.jp>");
  assert.equal(parsed.from, "Pokemon Cafe <info@mail-pokemon-cafe.jp>");
  assert.match(parsed.text, /予約番号: ABC123/);
  assert.equal(extractPokemonCode(parsed.text), "834921");
});

test("quoted printable and HTML-only email remain readable as text", () => {
  const qp = "From: info@mail-pokemon-cafe.jp\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=E8=AA=8D=E8=A8=BC=E3=82=B3=E3=83=BC=E3=83=89=EF=BC=88Authentication code=EF=BC=89=\r\n\r\n123456";
  assert.equal(extractPokemonCode(parseMail(encoder.encode(qp)).text), "123456");
  const html = "From: info@mail-pokemon-cafe.jp\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<script>alert(1)</script><p>予約番号 &amp; 詳細</p>";
  const parsed = parseMail(encoder.encode(html));
  assert.match(parsed.text, /予約番号 & 詳細/);
  assert.doesNotMatch(parsed.text, /alert/);
});

test("a message without a code does not produce a false positive", () => {
  assert.equal(extractPokemonCode("予約番号: ABC123\nありがとうございました"), null);
  assert.equal(extractPokemonCode("Authentication code\n123456"), "123456");
});
