import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "./config.js";

export interface RunResult {
  output: string;
  sessionId?: string;
}

interface Proc {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(cmd: string, args: string[], opts: { cwd?: string; stdin?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; shell?: boolean }): Promise<Proc> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

function fail(name: string, p: Proc): never {
  throw new Error(`${name} exited with ${p.code}: ${(p.stderr || p.stdout).slice(-2000)}`);
}

/**
 * Claude Code: each email thread maps to one session. The first email
 * creates it with a known --session-id, later emails in the thread --resume it.
 */
async function runClaude(agent: Extract<AgentConfig, { type: "claude" }>, prompt: string, sessionId: string | undefined, timeoutMs: number): Promise<RunResult> {
  const id = sessionId ?? randomUUID();
  const args = ["-p", "--output-format", "json", ...(sessionId ? ["--resume", id] : ["--session-id", id]), ...(agent.args ?? [])];
  const p = await run("claude", args, { cwd: agent.cwd, stdin: prompt, timeoutMs });
  if (p.code !== 0) fail("claude", p);
  const json = JSON.parse(p.stdout);
  return { output: String(json.result ?? "").trim(), sessionId: json.session_id ?? id };
}

/**
 * Codex: `codex exec --json` prints a thread id in its first event, and
 * `codex exec resume <id>` continues it. The final message goes to a file via -o.
 */
async function runCodex(agent: Extract<AgentConfig, { type: "codex" }>, prompt: string, sessionId: string | undefined, timeoutMs: number): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "inboxd-"));
  const outFile = join(dir, "last.txt");
  try {
    const args = ["exec", ...(sessionId ? ["resume", sessionId] : []), "--json", "-o", outFile, ...(agent.args ?? []), "-"];
    const p = await run("codex", args, { cwd: agent.cwd, stdin: prompt, timeoutMs });
    if (p.code !== 0) fail("codex", p);
    let thread = sessionId;
    for (const line of p.stdout.split("\n")) {
      try {
        const ev = JSON.parse(line);
        thread ??= ev.thread_id ?? ev.session_id ?? ev.msg?.session_id;
      } catch {}
    }
    return { output: readFileSync(outFile, "utf8").trim(), sessionId: thread };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Anything else: a shell command that reads the prompt on stdin and prints its
 * answer on stdout. INBOXD_SESSION is set when continuing a thread, and the
 * command can print "INBOXD_SESSION=<id>" on its last line to set one.
 */
async function runCommand(agent: Extract<AgentConfig, { type: "command" }>, prompt: string, sessionId: string | undefined, timeoutMs: number): Promise<RunResult> {
  const p = await run(agent.command, [], { cwd: agent.cwd, stdin: prompt, timeoutMs, shell: true, env: sessionId ? { INBOXD_SESSION: sessionId } : {} });
  if (p.code !== 0) fail(agent.command, p);
  const lines = p.stdout.trimEnd().split("\n");
  const m = lines.at(-1)?.match(/^INBOXD_SESSION=(\S+)$/);
  if (m) lines.pop();
  return { output: lines.join("\n").trim(), sessionId: m?.[1] ?? sessionId };
}

export function runAgent(agent: AgentConfig, prompt: string, sessionId: string | undefined, timeoutMs: number): Promise<RunResult> {
  switch (agent.type) {
    case "claude":
      return runClaude(agent, prompt, sessionId, timeoutMs);
    case "codex":
      return runCodex(agent, prompt, sessionId, timeoutMs);
    case "command":
      return runCommand(agent, prompt, sessionId, timeoutMs);
  }
}
