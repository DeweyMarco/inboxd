// End-to-end check against an Ethereal test mailbox (https://ethereal.email).
// Ethereal stores every message an account sends in that account's own INBOX,
// so we inject mail with a spoofed "From" to simulate another sender.
import nodemailer from "nodemailer";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleEmail } from "../src/watch.js";
import { listInbox, threadKey } from "../src/mail.js";
import { State } from "../src/state.js";
import type { Config } from "../src/config.js";

const acct = await nodemailer.createTestAccount();
const cfg: Config = {
  address: acct.user,
  imap: { ...acct.imap, user: acct.user, pass: acct.pass },
  smtp: { ...acct.smtp, user: acct.user, pass: acct.pass },
  allowFrom: ["boss@example.com"],
  stateDir: mkdtempSync(join(tmpdir(), "inboxd-test-")),
  agent: { type: "command", command: resolve("test/fake-agent.sh") },
  maxHops: 6,
};
const raw = nodemailer.createTransport({ ...acct.smtp, auth: { user: acct.user, pass: acct.pass } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assert = (ok: unknown, msg: string) => { if (!ok) { console.error("FAIL:", msg); process.exit(1); } console.log("ok:", msg); };

const first = await raw.sendMail({ from: "boss@example.com", to: acct.user, subject: "Summarize the repo", text: "please" });
await wait(1500);
const state = new State(cfg.stateDir);
let inbox = await listInbox(cfg, 10);
const e1 = inbox.find((m) => m.messageId === first.messageId)!;
assert(e1 && e1.from === "boss@example.com", "incoming email parsed with sender");
await handleEmail(cfg, state, e1);
assert(state.session(threadKey(e1))?.startsWith("sess-"), "thread mapped to a session");

await wait(1500);
inbox = await listInbox(cfg, 10);
const reply = inbox.find((m) => m.inReplyTo === first.messageId);
assert(reply && /fake agent handled -> Subject: Summarize the repo/.test(reply.text), "agent output emailed back as a reply");
assert(reply!.subject === "Re: Summarize the repo" && reply!.hop === 1, "reply threaded with hop count 1");

// Boss answers the agent's reply: the same session must be resumed.
const second = await raw.sendMail({ from: "boss@example.com", to: acct.user, subject: reply!.subject, text: "now do more", inReplyTo: reply!.messageId, references: [first.messageId, reply!.messageId] });
await wait(1500);
inbox = await listInbox(cfg, 10);
const e2 = inbox.find((m) => m.messageId === second.messageId)!;
await handleEmail(cfg, state, e2);
await wait(1500);
inbox = await listInbox(cfg, 10);
const reply2 = inbox.find((m) => m.inReplyTo === second.messageId);
assert(reply2 && reply2.text.includes(`session in: ${state.session(threadKey(e1))}`), "follow-up email resumed the same session");
console.log("all e2e checks passed");
process.exit(0);
