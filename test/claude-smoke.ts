import { runAgent } from "../src/runners.js";
const agent = { type: "claude" as const, args: ["--model", "haiku"] };
const a = await runAgent(agent, "Remember the word PELICAN. Reply with just: ok", undefined, 120000);
console.log("first:", a);
const b = await runAgent(agent, "What word did I ask you to remember? One word.", a.sessionId, 120000);
console.log("resumed:", b);
