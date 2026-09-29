import net from "node:net";
import type { AddressInfo } from "node:net";

/**
 * Faz NOTIF.1A — a minimal SMTP server for tests, bound to the loopback
 * interface ONLY (127.0.0.1). It accepts every message, forwards nothing
 * anywhere, and records each one (envelope + decoded MIME) so a test can
 * assert on exactly what a real nodemailer would have put on the wire.
 *
 * It is the reason no test ever needs a real mailbox: the customer-email
 * transport refuses any non-loopback host outside a Vercel production
 * deployment, and this is the loopback host tests point it at.
 *
 * Scripted misbehavior — one option per SMTP stage — lets a test drive the
 * REAL nodemailer through every failure class the retry policy is built
 * on (see lib/email/smtp-transport.ts's classifySmtpFailure) instead of
 * asserting against a hand-built fake error object.
 *
 * Deliberately dependency-free (node:net only): no new package.
 */

export type SmtpCatcherBehavior = {
  /** Accept the TCP connection and never send a greeting. */
  noGreeting?: boolean;
  /** Close the socket immediately after accepting. */
  dropAfterConnect?: boolean;
  /** Close the socket when EHLO arrives. */
  dropAtEhlo?: boolean;
  /** Refuse AUTH with 535. */
  authFail?: boolean;
  /** Full reply line for MAIL FROM (default "250 ok"). */
  mailFrom?: string;
  /** Full reply line for RCPT TO; may depend on the address. */
  rcpt?: string | ((address: string) => string | undefined);
  /** Full reply line for the DATA command (default "354 go ahead"). */
  dataCommand?: string;
  /** Full reply line after the payload (default "250 2.0.0 OK queued"). */
  dataFinal?: string;
  /** Close the socket once the whole payload has arrived, before any reply. */
  dropAfterData?: boolean;
  /** Never reply after the payload (the client will time out). */
  hangAfterData?: boolean;
};

export type CapturedMessage = {
  envelopeFrom: string;
  envelopeTo: string[];
  raw: string;
  headers: Record<string, string>;
  subject: string;
  messageId: string;
  text: string;
  html: string;
};

export type SmtpCatcher = {
  host: "127.0.0.1";
  port: number;
  messages: CapturedMessage[];
  /** Number of TCP connections accepted so far. */
  connections: () => number;
  /** How many DATA payloads were fully received (accepted or not). */
  payloads: () => number;
  setBehavior: (behavior: SmtpCatcherBehavior) => void;
  close: () => Promise<void>;
};

// ---------------------------------------------------------------- MIME

function decodeQuotedPrintable(input: string): string {
  const joined = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]!;
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(ch, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeMimeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, _charset: string, enc: string, data: string) => {
      if (enc.toLowerCase() === "b") return Buffer.from(data, "base64").toString("utf8");
      return decodeQuotedPrintable(data.replace(/_/g, " "));
    });
}

function splitHeadersAndBody(raw: string): { headerBlock: string; body: string } {
  const idx = raw.indexOf("\r\n\r\n");
  if (idx === -1) return { headerBlock: raw, body: "" };
  return { headerBlock: raw.slice(0, idx), body: raw.slice(idx + 4) };
}

function parseHeaders(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const unfolded = headerBlock.replace(/\r\n[ \t]+/g, " ");
  for (const line of unfolded.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

function decodeBody(body: string, encoding: string | undefined): string {
  const enc = (encoding ?? "7bit").toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

function collectParts(raw: string, out: { text: string; html: string }): void {
  const { headerBlock, body } = splitHeadersAndBody(raw);
  const headers = parseHeaders(headerBlock);
  const contentType = headers["content-type"] ?? "text/plain";

  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  if (/^multipart\//i.test(contentType) && boundary) {
    const pieces = body.split(`--${boundary}`);
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith("--")) break;
      collectParts(piece.replace(/^\r\n/, ""), out);
    }
    return;
  }

  const decoded = decodeBody(body.replace(/\r\n$/, ""), headers["content-transfer-encoding"]);
  if (/^text\/html/i.test(contentType)) out.html = decoded;
  else if (/^text\/plain/i.test(contentType)) out.text = decoded;
}

function parseCaptured(raw: string, envelopeFrom: string, envelopeTo: string[]): CapturedMessage {
  const { headerBlock } = splitHeadersAndBody(raw);
  const headers = parseHeaders(headerBlock);
  const parts = { text: "", html: "" };
  collectParts(raw, parts);
  return {
    envelopeFrom,
    envelopeTo,
    raw,
    headers,
    subject: decodeMimeWords(headers["subject"] ?? ""),
    messageId: headers["message-id"] ?? "",
    text: parts.text,
    html: parts.html,
  };
}

// -------------------------------------------------------------- server

function addressOf(command: string): string {
  const match = command.match(/<([^>]*)>/);
  return (match?.[1] ?? "").trim();
}

export async function startSmtpCatcher(initial: SmtpCatcherBehavior = {}): Promise<SmtpCatcher> {
  let behavior = initial;
  const messages: CapturedMessage[] = [];
  const sockets = new Set<net.Socket>();
  let connectionCount = 0;
  let payloadCount = 0;

  const server = net.createServer((socket) => {
    connectionCount++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});

    const write = (line: string) => {
      if (!socket.destroyed) socket.write(`${line}\r\n`);
    };

    if (behavior.noGreeting) return;
    if (behavior.dropAfterConnect) {
      socket.destroy();
      return;
    }
    write("220 catcher.test ESMTP ready");

    let buffer = "";
    let inData = false;
    let dataBuffer = "";
    let envelopeFrom = "";
    let envelopeTo: string[] = [];
    let authLoginStep: "user" | "pass" | null = null;
    let authPlainPending = false;

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      for (;;) {
        if (inData) {
          dataBuffer += buffer;
          buffer = "";
          const end = dataBuffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          const rawStuffed = dataBuffer.slice(0, end);
          buffer = dataBuffer.slice(end + 5);
          dataBuffer = "";
          inData = false;
          payloadCount++;

          const raw = rawStuffed.replace(/\r\n\.\./g, "\r\n.");
          if (behavior.dropAfterData) {
            socket.destroy();
            return;
          }
          if (behavior.hangAfterData) return;

          const reply = behavior.dataFinal ?? "250 2.0.0 OK queued";
          if (reply.startsWith("2")) {
            messages.push(parseCaptured(raw, envelopeFrom, envelopeTo));
          }
          write(reply);
          continue;
        }

        const newline = buffer.indexOf("\r\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const upper = line.toUpperCase();

        if (authLoginStep === "user") {
          authLoginStep = "pass";
          write("334 UGFzc3dvcmQ6");
          continue;
        }
        if (authLoginStep === "pass") {
          authLoginStep = null;
          write(behavior.authFail ? "535 5.7.8 credentials refused" : "235 2.7.0 accepted");
          continue;
        }
        if (authPlainPending) {
          authPlainPending = false;
          write(behavior.authFail ? "535 5.7.8 credentials refused" : "235 2.7.0 accepted");
          continue;
        }

        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          if (behavior.dropAtEhlo) {
            socket.destroy();
            return;
          }
          write("250-catcher.test");
          write("250-AUTH PLAIN LOGIN");
          write("250 8BITMIME");
        } else if (upper.startsWith("AUTH PLAIN")) {
          if (upper.trim() === "AUTH PLAIN") {
            authPlainPending = true;
            write("334 ");
          } else {
            write(behavior.authFail ? "535 5.7.8 credentials refused" : "235 2.7.0 accepted");
          }
        } else if (upper.startsWith("AUTH LOGIN")) {
          authLoginStep = "user";
          write("334 VXNlcm5hbWU6");
        } else if (upper.startsWith("MAIL FROM")) {
          envelopeFrom = addressOf(line);
          envelopeTo = [];
          write(behavior.mailFrom ?? "250 2.1.0 ok");
        } else if (upper.startsWith("RCPT TO")) {
          const address = addressOf(line);
          const scripted = typeof behavior.rcpt === "function" ? behavior.rcpt(address) : behavior.rcpt;
          const reply = scripted ?? "250 2.1.5 ok";
          if (reply.startsWith("2")) envelopeTo.push(address);
          write(reply);
        } else if (upper === "DATA") {
          const reply = behavior.dataCommand ?? "354 go ahead";
          write(reply);
          if (reply.startsWith("3")) {
            inData = true;
            dataBuffer = "";
          }
        } else if (upper === "RSET" || upper === "NOOP") {
          write("250 2.0.0 ok");
        } else if (upper === "QUIT") {
          write("221 2.0.0 bye");
          socket.end();
        } else {
          write("250 ok");
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    messages,
    connections: () => connectionCount,
    payloads: () => payloadCount,
    setBehavior: (next) => {
      behavior = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
