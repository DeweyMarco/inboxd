import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export type AgentConfig =
  | { type: "claude"; cwd?: string; args?: string[] }
  | { type: "codex"; cwd?: string; args?: string[] }
  | { type: "command"; command: string; cwd?: string };

export interface Config {
  /** The address this agent receives mail at. */
  address: string;
  /** Display name used in the From header. */
  name?: string;
  imap: ServerConfig;
  smtp: ServerConfig;
  /**
   * Senders allowed to wake the agent. Exact addresses or "*@domain.com".
   * Mail from anyone else is left unread and ignored. Email is a prompt
   * injection channel, so there is deliberately no "allow everyone" default.
   */
  allowFrom: string[];
  /** Only accept mail whose Authentication-Results header shows dkim=pass for the sender's domain. */
  requireDkim?: boolean;
  /** Stop auto-replying once a thread has bounced between agents this many times. */
  maxHops?: number;
  /** Seconds between fallback polls when IMAP IDLE isn't delivering. */
  pollSeconds?: number;
  /** Where thread→session mappings and processed message ids are stored. */
  stateDir: string;
  /** What to run when mail arrives. */
  agent: AgentConfig;
  /** Kill the agent run after this many seconds. */
  timeoutSeconds?: number;
}

/** Replace "${VAR}" with process.env.VAR so secrets can stay out of the config file. */
function interpolate<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`Config references \${${name}} but it isn't set`);
      return v;
    }) as T;
  }
  if (Array.isArray(value)) return value.map(interpolate) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)])) as T;
  }
  return value;
}

export function loadConfig(path = process.env.INBOXD_CONFIG ?? "inboxd.json"): Config {
  const full = resolve(path);
  if (!existsSync(full)) {
    throw new Error(`No config at ${full}. Run \`inboxd init\` to create one.`);
  }
  const raw = interpolate(JSON.parse(readFileSync(full, "utf8")));
  const base = dirname(full);
  const cfg: Config = {
    maxHops: 6,
    pollSeconds: 60,
    timeoutSeconds: 1800,
    requireDkim: false,
    ...raw,
    stateDir: resolve(base, raw.stateDir ?? ".inboxd"),
  };
  if (!cfg.address || !cfg.imap || !cfg.smtp || !cfg.agent) {
    throw new Error("Config needs address, imap, smtp and agent");
  }
  if (!Array.isArray(cfg.allowFrom) || cfg.allowFrom.length === 0) {
    throw new Error("Config needs a non-empty allowFrom list");
  }
  if (cfg.agent.cwd) cfg.agent.cwd = resolve(base, cfg.agent.cwd);
  return cfg;
}

export function isAllowed(cfg: Config, from: string): boolean {
  const addr = from.toLowerCase();
  return cfg.allowFrom.some((rule) => {
    const r = rule.toLowerCase();
    return r.startsWith("*@") ? addr.endsWith(r.slice(1)) : addr === r;
  });
}
