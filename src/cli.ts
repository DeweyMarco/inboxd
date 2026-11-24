#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { listInbox, sendEmail } from "./mail.js";
import { serveMcp } from "./mcp.js";
import { watch } from "./watch.js";

const program = new Command()
  .name("inboxd")
  .description("Give an AI agent an email inbox")
  .option("-c, --config <path>", "config file", process.env.INBOXD_CONFIG ?? "inboxd.json");

const cfg = () => loadConfig(program.opts().config);

program
  .command("init")
  .description("write an example inboxd.json")
  .action(() => {
    const path = program.opts().config;
    if (existsSync(path)) {
      console.error(`${path} already exists`);
      process.exit(1);
    }
    writeFileSync(
      path,
      JSON.stringify(
        {
          address: "my-agent@example.com",
          name: "My agent",
          imap: { host: "imap.example.com", port: 993, secure: true, user: "my-agent@example.com", pass: "${INBOXD_PASSWORD}" },
          smtp: { host: "smtp.example.com", port: 465, secure: true, user: "my-agent@example.com", pass: "${INBOXD_PASSWORD}" },
          allowFrom: ["you@example.com"],
          requireDkim: false,
          maxHops: 6,
          agent: { type: "claude", cwd: ".", args: [] },
        },
        null,
        2,
      ) + "\n",
    );
    console.error(`wrote ${path}; fill in your mail server and allowFrom, then run \`inboxd watch\``);
  });

program
  .command("watch")
  .description("watch the inbox and run the agent on each allowed email")
  .action(() => watch(cfg()));

program
  .command("mcp")
  .description("run an MCP server (stdio) exposing send_email, list_inbox, read_email")
  .action(() => serveMcp(cfg()));

program
  .command("send")
  .description("send an email from the agent's address")
  .requiredOption("--to <address>")
  .requiredOption("--subject <subject>")
  .option("--body <text>", "body; reads stdin when omitted")
  .action(async (o) => {
    let body = o.body;
    if (body === undefined) {
      body = "";
      for await (const chunk of process.stdin) body += chunk;
    }
    console.log(await sendEmail(cfg(), { to: o.to, subject: o.subject, text: body }));
  });

program
  .command("inbox")
  .description("list recent emails")
  .option("-n, --limit <n>", "how many", "20")
  .option("--unread", "only unread")
  .action(async (o) => {
    for (const e of await listInbox(cfg(), Number(o.limit), !!o.unread)) {
      console.log(`${e.seen ? " " : "*"} ${String(e.uid).padStart(5)}  ${e.date.toISOString().slice(0, 16)}  ${e.from.padEnd(30)}  ${e.subject}`);
    }
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
