function byteString(bytes) {
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    output += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return output;
}

function bytesFromString(value) {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 255;
  return bytes;
}

function decodeCharset(bytes, charset = "utf-8") {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeBase64(value) {
  try {
    return bytesFromString(atob(value.replace(/\s/g, "")));
  } catch {
    return bytesFromString(value);
  }
}

function decodeQuotedPrintable(value) {
  const input = value.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "=" && /^[a-f\d]{2}$/i.test(input.slice(i + 1, i + 3))) {
      bytes.push(parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(input.charCodeAt(i) & 255);
    }
  }
  return Uint8Array.from(bytes);
}

function decodeWords(value = "") {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (_, charset, encoding, body) => {
    const bytes = encoding.toLowerCase() === "b"
      ? decodeBase64(body)
      : decodeQuotedPrintable(body.replaceAll("_", " "));
    return decodeCharset(bytes, charset);
  });
}

function splitHeaders(raw) {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return [raw, ""];
  return [raw.slice(0, match.index), raw.slice(match.index + match[0].length)];
}

function parseHeaders(block) {
  const headers = new Map();
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

function parameter(header, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|;)\\s*${escaped}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, "i").exec(header || "");
  return match ? (match[1] || match[2]) : null;
}

function partsForBoundary(body, boundary) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const parts = [];
  let current = null;
  for (const line of lines) {
    if (line === `--${boundary}`) {
      if (current) parts.push(current.join("\n"));
      current = [];
    } else if (line === `--${boundary}--`) {
      if (current) parts.push(current.join("\n"));
      break;
    } else if (current) {
      current.push(line);
    }
  }
  return parts;
}

function decodeLeaf(body, headers) {
  const transfer = (headers.get("content-transfer-encoding") || "").toLowerCase();
  const bytes = transfer === "base64" ? decodeBase64(body)
    : transfer === "quoted-printable" ? decodeQuotedPrintable(body)
      : bytesFromString(body);
  return decodeCharset(bytes, parameter(headers.get("content-type"), "charset") || "utf-8");
}

function readParts(raw, collected, depth = 0) {
  if (depth > 8) return;
  const [headerBlock, body] = splitHeaders(raw);
  const headers = parseHeaders(headerBlock);
  const type = (headers.get("content-type") || "text/plain").toLowerCase();
  const disposition = (headers.get("content-disposition") || "").toLowerCase();
  if (disposition.startsWith("attachment")) return;
  if (type.startsWith("multipart/")) {
    const boundary = parameter(headers.get("content-type"), "boundary");
    if (boundary) for (const part of partsForBoundary(body, boundary)) readParts(part, collected, depth + 1);
    return;
  }
  if (type.startsWith("text/plain")) collected.plain.push(decodeLeaf(body, headers));
  if (type.startsWith("text/html")) collected.html.push(decodeLeaf(body, headers));
}

function htmlToText(html) {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (original, number) => {
      const point = Number(number);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point) : original;
    })
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

export function parseMail(rawBytes) {
  const raw = byteString(rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes));
  const [headerBlock] = splitHeaders(raw);
  const headers = parseHeaders(headerBlock);
  const collected = { plain: [], html: [] };
  readParts(raw, collected);
  const plain = collected.plain.join("\n\n").trim();
  const html = collected.html.join("\n\n").trim();
  return {
    from: decodeWords(headers.get("from") || ""),
    to: decodeWords(headers.get("to") || ""),
    subject: decodeWords(headers.get("subject") || "(无主题)"),
    date: headers.get("date") || "",
    messageId: headers.get("message-id") || null,
    text: plain || htmlToText(html),
    hasHtml: Boolean(html),
  };
}

export function parseMailHeaders(rawBytes) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  const [headerBlock] = splitHeaders(byteString(bytes.subarray(0, 65536)));
  const headers = parseHeaders(headerBlock);
  return {
    from: decodeWords(headers.get("from") || ""),
    to: decodeWords(headers.get("to") || ""),
    subject: decodeWords(headers.get("subject") || "(无主题)"),
    date: headers.get("date") || "",
    messageId: headers.get("message-id") || null,
  };
}

export function extractPokemonCode(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const label = /(?:認証コード\s*[（(]\s*Authentication code\s*[）)]|Authentication code)/i;
  const position = label.exec(normalized);
  if (!position) return null;
  const tail = normalized.slice(position.index + position[0].length);
  const candidate = /^\s*(?:[:：]\s*)?([A-Za-z0-9]{4,12})(?=\s|$)/.exec(tail);
  return candidate ? candidate[1] : null;
}
