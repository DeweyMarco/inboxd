import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser, type ParsedMail } from "mailparser";
import type { Config } from "./config.js";

export const HOP_HEADER = "X-Inboxd-Hop";

export interface Email {
  uid: number;
  messageId: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  date: Date;
  text: string;
  inReplyTo?: string;
  references: string[];
  hop: number;
  dkimPass: boolean;
  seen: boolean;
}

export function imapClient(cfg: Config): ImapFlow {
  return new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth: { user: cfg.imap.user, pass: cfg.imap.pass },
    logger: process.env.INBOXD_DEBUG ? undefined : false,
  });
}

let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
function smtp(cfg: Config) {
  transport ??= nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
  });
  return transport;
}

function asList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : v.split(/\s+/).filter(Boolean);
}

/** True when a provider-added Authentication-Results header shows DKIM passing for the From domain. */
function dkimPasses(parsed: ParsedMail, fromAddr: string): boolean {
  const domain = fromAddr.split("@")[1]?.toLowerCase();
  const raw = parsed.headers.get("authentication-results");
  const headers = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
  return headers.some((h) => {
    const m = h.match(/dkim=pass[^;]*header\.(?:d|i)=@?([^\s;]+)/i);
    return !!m && !!domain && (m[1].toLowerCase() === domain || domain.endsWith("." + m[1].toLowerCase()));
  });
}

export async function parseEmail(uid: number, source: Buffer, seen: boolean): Promise<Email> {
  const p = await simpleParser(source);
  const fromAddr = p.from?.value[0]?.address ?? "";
  const to = Array.isArray(p.to) ? p.to.map((t) => t.text).join(", ") : p.to?.text ?? "";
  const hopHeader = p.headers.get(HOP_HEADER.toLowerCase());
  return {
    uid,
    messageId: p.messageId ?? `<uid-${uid}@inboxd.local>`,
    from: fromAddr.toLowerCase(),
    fromName: p.from?.value[0]?.name ?? "",
    to,
    subject: p.subject ?? "(no subject)",
    date: p.date ?? new Date(),
    text: (p.text ?? "").trim(),
    inReplyTo: p.inReplyTo,
    references: asList(p.references),
    hop: Number(hopHeader ?? 0) || 0,
    dkimPass: dkimPasses(p, fromAddr),
    seen,
  };
}

/** Root message id of the conversation an email belongs to. */
export function threadKey(e: Email): string {
  return e.references[0] ?? e.inReplyTo ?? e.messageId;
}

export interface SendOptions {
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  hop?: number;
}

export async function sendEmail(cfg: Config, o: SendOptions): Promise<string> {
  const info = await smtp(cfg).sendMail({
    from: cfg.name ? { name: cfg.name, address: cfg.address } : cfg.address,
    to: o.to,
    subject: o.subject,
    text: o.text,
    inReplyTo: o.inReplyTo,
    references: o.references,
    headers: { [HOP_HEADER]: String(o.hop ?? 0) },
  });
  return info.messageId;
}

export async function replyTo(cfg: Config, e: Email, text: string): Promise<string> {
  return sendEmail(cfg, {
    to: e.from,
    subject: /^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`,
    text,
    inReplyTo: e.messageId,
    references: [...e.references, e.messageId],
    hop: e.hop + 1,
  });
}

/** List recent messages without marking them read. */
export async function listInbox(cfg: Config, limit = 20, unreadOnly = false): Promise<Email[]> {
  const client = imapClient(cfg);
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = (await client.search(unreadOnly ? { seen: false } : { all: true }, { uid: true })) || [];
    const picked = uids.slice(-limit);
    const out: Email[] = [];
    if (picked.length === 0) return out;
    for await (const msg of client.fetch(picked, { source: true, flags: true, uid: true }, { uid: true })) {
      if (msg.source) out.push(await parseEmail(msg.uid, msg.source, msg.flags?.has("\\Seen") ?? false));
    }
    return out.reverse();
  } finally {
    lock.release();
    await client.logout();
  }
}

export async function readEmail(cfg: Config, uid: number): Promise<Email | undefined> {
  const client = imapClient(cfg);
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const msg = await client.fetchOne(String(uid), { source: true, flags: true, uid: true }, { uid: true });
    if (!msg || !msg.source) return undefined;
    return await parseEmail(msg.uid, msg.source, msg.flags?.has("\\Seen") ?? false);
  } finally {
    lock.release();
    await client.logout();
  }
}
