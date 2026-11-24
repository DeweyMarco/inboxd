import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { listInbox, readEmail, sendEmail, type Email } from "./mail.js";

const summary = (e: Email) =>
  `[uid ${e.uid}]${e.seen ? "" : " (unread)"} ${e.date.toISOString()} from ${e.from}: ${e.subject}`;

const full = (e: Email) =>
  [`uid: ${e.uid}`, `message-id: ${e.messageId}`, `from: ${e.from}`, `to: ${e.to}`, `subject: ${e.subject}`, `date: ${e.date.toISOString()}`, "", e.text].join("\n");

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/**
 * Lets an interactive agent session use its inbox directly: email another
 * agent or a person, check for replies, read a message.
 */
export async function serveMcp(cfg: Config): Promise<void> {
  const server = new McpServer({ name: "inboxd", version: "0.1.0" });

  server.registerTool(
    "send_email",
    {
      description: `Send an email from this agent's address (${cfg.address}). Use it to hand a task to another agent, ask a person something, or report results. To continue a thread, pass in_reply_to with the message-id you're answering.`,
      inputSchema: {
        to: z.string().describe("Recipient address"),
        subject: z.string(),
        body: z.string().describe("Plain-text body"),
        in_reply_to: z.string().optional().describe("message-id of the email being answered"),
      },
    },
    async ({ to, subject, body, in_reply_to }) => {
      const id = await sendEmail(cfg, { to, subject, text: body, inReplyTo: in_reply_to, references: in_reply_to ? [in_reply_to] : undefined });
      return text(`sent, message-id ${id}`);
    },
  );

  server.registerTool(
    "list_inbox",
    {
      description: `List recent emails in ${cfg.address}, newest first. Does not mark anything read.`,
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        unread_only: z.boolean().default(false),
      },
    },
    async ({ limit, unread_only }) => {
      const mails = await listInbox(cfg, limit, unread_only);
      return text(mails.length ? mails.map(summary).join("\n") : "inbox is empty");
    },
  );

  server.registerTool(
    "read_email",
    {
      description: "Read one email by the uid shown in list_inbox.",
      inputSchema: { uid: z.number().int() },
    },
    async ({ uid }) => {
      const e = await readEmail(cfg, uid);
      return text(e ? full(e) : `no email with uid ${uid}`);
    },
  );

  server.registerTool(
    "whoami",
    { description: "This agent's email address and who is allowed to wake it.", inputSchema: {} },
    async () => text(`address: ${cfg.address}\nallowFrom: ${cfg.allowFrom.join(", ")}`),
  );

  await server.connect(new StdioServerTransport());
}
