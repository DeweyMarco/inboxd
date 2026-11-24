import type { ImapFlow } from "imapflow";
import { isAllowed, type Config } from "./config.js";
import { imapClient, parseEmail, replyTo, threadKey, type Email } from "./mail.js";
import { runAgent } from "./runners.js";
import { State } from "./state.js";

const log = (...a: unknown[]) => console.error(new Date().toISOString(), ...a);

export function buildPrompt(cfg: Config, e: Email, continuing: boolean): string {
  return [
    continuing
      ? `A new email arrived in the thread you're already working on (your inbox: ${cfg.address}).`
      : `You have an email inbox at ${cfg.address}. A new email just arrived for you.`,
    "",
    `From: ${e.fromName ? `${e.fromName} <${e.from}>` : e.from}`,
    `Subject: ${e.subject}`,
    `Date: ${e.date.toISOString()}`,
    "",
    "----- email body -----",
    e.text || "(empty body)",
    "----- end of email -----",
    "",
    "The sender is on your allowlist. Do what the email asks, or answer it.",
    "Your final message will be emailed back to the sender as the reply, so write it as a reply: plain text, self-contained, no preamble about being an AI.",
  ].join("\n");
}

export async function handleEmail(cfg: Config, state: State, e: Email): Promise<void> {
  const thread = threadKey(e);
  const existing = state.session(thread);
  log(`→ ${e.from}: "${e.subject}" (thread ${existing ? "resumed" : "new"}, hop ${e.hop})`);
  try {
    const res = await runAgent(cfg.agent, buildPrompt(cfg, e, !!existing), existing, (cfg.timeoutSeconds ?? 1800) * 1000);
    if (res.sessionId) state.setSession(thread, res.sessionId);
    const sent = await replyTo(cfg, e, res.output || "(the agent finished without a final message)");
    state.alias(sent, thread);
    log(`← replied to ${e.from}`);
  } catch (err) {
    log(`agent failed on "${e.subject}":`, err);
    await replyTo(cfg, e, `inboxd: the agent behind ${cfg.address} failed on this message.\n\n${String(err).slice(0, 1500)}`).catch(() => {});
  }
}

/** Pull unread mail, decide what to act on, mark it read. Agent runs happen after the IMAP lock is released. */
async function collect(cfg: Config, state: State, client: ImapFlow): Promise<Email[]> {
  const todo: Email[] = [];
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const e = await parseEmail(uid, msg.source, false);
      if (state.isProcessed(e.messageId)) continue;
      state.markProcessed(e.messageId);

      // Leave ignored mail unread so a human looking at the inbox still sees it.
      if (e.from === cfg.address.toLowerCase()) continue;
      if (!isAllowed(cfg, e.from)) {
        log(`ignoring ${e.from}: not in allowFrom`);
        continue;
      }
      if (cfg.requireDkim && !e.dkimPass) {
        log(`ignoring ${e.from}: DKIM did not pass`);
        continue;
      }
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      if (e.hop >= (cfg.maxHops ?? 6)) {
        log(`not replying to "${e.subject}": hop ${e.hop} reached maxHops`);
        continue;
      }
      todo.push(e);
    }
  } finally {
    lock.release();
  }
  return todo;
}

export async function watch(cfg: Config): Promise<void> {
  const state = new State(cfg.stateDir);
  let client: ImapFlow | undefined;
  let busy = false;
  let again = false;

  const drain = async () => {
    if (!client) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        const todo = await collect(cfg, state, client);
        // One at a time: replies stay in order and agents don't fight over the same working tree.
        for (const e of todo) await handleEmail(cfg, state, e);
      } while (again);
    } catch (err) {
      log("drain error:", err);
    } finally {
      busy = false;
    }
  };

  const connect = async () => {
    client = imapClient(cfg);
    client.on("exists", () => void drain());
    client.on("error", (err) => log("imap error:", err.message));
    client.on("close", () => {
      log("imap connection closed, reconnecting in 10s");
      client = undefined;
      setTimeout(() => connect().catch((err) => log("reconnect failed:", err.message)), 10_000);
    });
    await client.connect();
    await client.mailboxOpen("INBOX");
    log(`watching ${cfg.address} (agent: ${cfg.agent.type}, allow: ${cfg.allowFrom.join(", ")})`);
    await drain();
  };

  await connect();
  setInterval(() => void drain(), (cfg.pollSeconds ?? 60) * 1000);
  await new Promise(() => {});
}
