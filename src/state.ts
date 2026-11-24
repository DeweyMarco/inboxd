import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

interface StateData {
  /** thread root message-id -> agent session id */
  sessions: Record<string, string>;
  /** message-ids already handled, so restarts don't re-run old mail */
  processed: string[];
}

export class State {
  private file: string;
  private data: StateData;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "state.json");
    this.data = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : { sessions: {}, processed: [] };
  }

  private save() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  session(thread: string): string | undefined {
    return this.data.sessions[thread];
  }

  setSession(thread: string, id: string) {
    this.data.sessions[thread] = id;
    this.save();
  }

  /** Our own outgoing message ids join the same thread, so a reply to them resumes the session. */
  alias(messageId: string, thread: string) {
    const id = this.data.sessions[thread];
    if (id) this.setSession(messageId, id);
  }

  isProcessed(messageId: string) {
    return this.data.processed.includes(messageId);
  }

  markProcessed(messageId: string) {
    this.data.processed.push(messageId);
    if (this.data.processed.length > 5000) this.data.processed.splice(0, 1000);
    this.save();
  }
}
