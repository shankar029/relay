import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore plain ESM helper
import { parseFrontmatter } from "../../lib/frontmatter.mjs";
import { messageTokens } from "../../lib/budget.mjs";

export const RELAY_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HARNESS_ENTRY = path.join(RELAY_HOME, "extensions", "harness", "index.ts");

export interface AgentDef {
  name: string;
  description: string;
  tools: string[];
  tier?: string;
  systemPrompt: string;
  file: string;
}

export function loadAgents(): AgentDef[] {
  const dir = path.join(RELAY_HOME, "agents");
  if (!fs.existsSync(dir)) return [];
  const out: AgentDef[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const file = path.join(dir, f);
    const { data, body } = parseFrontmatter(fs.readFileSync(file, "utf8")) as { data: any; body: string };
    if (!data?.name || !data?.description) continue;
    out.push({
      name: data.name,
      description: data.description,
      tools: (data.tools || "").split(",").map((s: string) => s.trim()).filter(Boolean),
      tier: data.tier,
      systemPrompt: body,
      file,
    });
  }
  return out;
}

// Optional relay.config.json: { "tiers": { "strong": "provider/model", "mid": "...", "cheap": "..." } }
export function modelForTier(cwd: string, tier?: string): string | undefined {
  if (!tier) return undefined;
  for (const base of [cwd, RELAY_HOME]) {
    const f = path.join(base, "relay.config.json");
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, "utf8")).tiers?.[tier]; } catch { return undefined; }
    }
  }
  return undefined;
}

// Same strategy as pi's examples/extensions/subagent/index.ts (getPiInvocation), plus an env override.
function piInvocation(args: string[]): { command: string; args: string[] } {
  if (process.env.RELAY_PI_BIN) return { command: process.env.RELAY_PI_BIN, args };
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const exe = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
  return { command: "pi", args };
}

export interface RunResult {
  exitCode: number;
  output: string;
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
  tokens: number;
  turns: number;
}

export interface RunOptions {
  cwd: string;
  agent: AgentDef;
  task: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  logFile?: string; // raw JSON event stream is appended here (the live viewer tails it)
  onSpawn?: (pid: number) => void;
  onEvent?: (ev: any) => void;
}

// Each worker is an isolated pi process (JSON event stream); workers never get relay_subagent.
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { cwd, agent, task, env, signal, logFile, onSpawn, onEvent } = opts;
  if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const args = ["--mode", "json", "-p", "--no-session", "-ne", "-e", HARNESS_ENTRY, "-ns"];
  const model = modelForTier(cwd, agent.tier);
  if (model) args.push("--model", model);
  if (agent.tools.length) args.push("--tools", agent.tools.join(","));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-"));
  const promptFile = path.join(tmpDir, `${agent.name}.md`);
  fs.writeFileSync(promptFile, agent.systemPrompt, { mode: 0o600 });
  args.push("--append-system-prompt", promptFile, `Task: ${task}`);

  const result: RunResult = { exitCode: 0, output: "", stderr: "", tokens: 0, turns: 0 };
  try {
    result.exitCode = await new Promise<number>((resolve) => {
      const inv = piInvocation(args);
      const proc = spawn(inv.command, inv.args, {
        cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env, RELAY_CHILD: "1" },
      });
      if (proc.pid) onSpawn?.(proc.pid);
      let buf = "";
      const line = (l: string) => {
        if (!l.trim()) return;
        let ev: any;
        try { ev = JSON.parse(l); } catch { return; }
        if (logFile && ev.type !== "message_update") { try { fs.appendFileSync(logFile, l + "\n"); } catch { /* best effort */ } }
        try { onEvent?.(ev); } catch { /* UI must never break a worker */ }
        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          const text = (ev.message.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
          result.turns += 1;
          result.tokens += messageTokens(ev.message.usage);
          if (text) result.output = text;
          if (ev.message.stopReason) result.stopReason = ev.message.stopReason;
          if (ev.message.errorMessage) result.errorMessage = ev.message.errorMessage;
        }
      };
      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const parts = buf.split("\n");
        buf = parts.pop() || "";
        parts.forEach(line);
      });
      proc.stderr.on("data", (d) => { result.stderr += d.toString(); });
      proc.on("close", (c) => { if (buf.trim()) line(buf); resolve(c ?? 0); });
      proc.on("error", () => resolve(1));
      if (signal) {
        const kill = () => { proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); };
        if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
      }
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return result;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

