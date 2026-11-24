# inboxd

Give every AI agent you run an email address. When mail arrives from someone on the agent's allowlist, inboxd wakes the agent (Claude Code, Codex, or any command), hands it the email as a prompt, and emails the agent's final answer back as a threaded reply. Replies in the same thread resume the same agent session, so a conversation over email is a conversation with one continuous agent.

Because it's plain email, your agents can talk to each other, you can talk to them from your phone, and you can talk to other people's agents without either side running shared infrastructure.

## How it works

```
someone@x.com ──email──▶ agent inbox (IMAP) ──IDLE──▶ inboxd watch
                                                        │ allowlist + DKIM check
                                                        │ thread → session lookup
                                                        ▼
                                              claude -p --resume <session>
                                                        │
someone@x.com ◀──reply (In-Reply-To, X-Inboxd-Hop)─────┘
```

- `inboxd watch` holds an IMAP IDLE connection, picks up unread mail, and runs the agent on each allowed message one at a time.
- Each thread (keyed by the root Message-ID) maps to one agent session. Claude Code sessions are created with `--session-id` and continued with `--resume`; Codex uses `codex exec resume <thread>`.
- `inboxd mcp` is an MCP server with `send_email`, `list_inbox`, `read_email` and `whoami`, so an interactive session can email another agent and check for answers.

## Quick start

```sh
git clone https://github.com/DeweyMarco/inboxd && cd inboxd
npm install && npm run build && npm link

mkdir ~/agents/builder && cd ~/agents/builder
inboxd init                     # writes inboxd.json
export INBOXD_PASSWORD=...      # app password for the mailbox
inboxd watch
```

Any IMAP/SMTP mailbox works. A dedicated Fastmail or Gmail account with an app password is the fastest way to start; self-hosting with [Stalwart](https://stalw.art) or [Maddy](https://maddy.email) gives you unlimited addresses on your own domain.

To give an interactive Claude Code session the email tools:

```sh
claude mcp add inboxd -- inboxd -c /path/to/inboxd.json mcp
```

## Config

```json
{
  "address": "builder@agents.example.com",
  "name": "Builder agent",
  "imap": { "host": "imap.fastmail.com", "port": 993, "secure": true, "user": "builder@agents.example.com", "pass": "${INBOXD_PASSWORD}" },
  "smtp": { "host": "smtp.fastmail.com", "port": 465, "secure": true, "user": "builder@agents.example.com", "pass": "${INBOXD_PASSWORD}" },
  "allowFrom": ["you@example.com", "*@agents.example.com"],
  "requireDkim": true,
  "maxHops": 6,
  "agent": { "type": "claude", "cwd": "~/code/my-repo", "args": ["--model", "sonnet"] }
}
```

`${VAR}` is read from the environment. `agent.type` is `claude`, `codex`, or `command`. A `command` agent reads the prompt on stdin and prints its reply on stdout; it gets `INBOXD_SESSION` when continuing a thread and can print `INBOXD_SESSION=<id>` as its last line to start one.

## Safety

Email is an open channel, and every email this daemon acts on becomes a prompt for an agent that can run commands on your machine. So:

- `allowFrom` is required and has no wildcard-everyone option. Mail from anyone else is left unread and never reaches the agent.
- The From header is trivial to forge. Turn on `requireDkim` so only mail whose provider-added `Authentication-Results` shows `dkim=pass` for the sender's domain is accepted.
- Two agents replying to each other would loop forever, so every outgoing mail carries an `X-Inboxd-Hop` count and inboxd stops auto-replying at `maxHops`.
- Run the agent in a directory and permission mode you'd be comfortable letting an allowlisted sender drive.

## Development

```sh
npm run dev -- watch      # run from source
npm run test:e2e          # end-to-end test against a throwaway ethereal.email mailbox
npx tsx test/claude-smoke.ts   # checks Claude session create + resume (uses a few Haiku tokens)
```

## Roadmap

- Push new mail into an already-open interactive session instead of only headless runs
- Attachments in and out
- An address book so agents can look each other up by name
- Per-sender permissions (who can ask for what)
- Codex runner end-to-end test

## License

MIT
