import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
// @ts-ignore plain ESM helper
import { readJobs, reconcileJobs, readLogLines } from "../../lib/status.mjs";

const ICON: Record<string, string> = { running: "●", done: "✔", failed: "✖", cancelled: "⊘", interrupted: "⚠" };

/**
 * Read-only live viewer for worker sessions. Workers are separate `pi --mode json -p` processes, so
 * there is no interactive attach; this tails the JSON event log the harness records for each worker.
 * Keys: tab / shift+tab (or left/right) switch worker, up/down/pgup/pgdn scroll, f follow tail, esc/q/alt+w back.
 */
export class WatchView {
  private idx = 0;
  private scroll = 0; // lines above the tail; 0 = follow
  private timer: ReturnType<typeof setInterval>;
  private tui: any;
  private theme: any;
  private runtimeDir: string;
  private done: (v: undefined) => void;
  constructor(tui: any, theme: any, runtimeDir: string, done: (v: undefined) => void, focus?: string) {
    this.tui = tui;
    this.theme = theme;
    this.runtimeDir = runtimeDir;
    this.done = done;
    if (focus) { const i = this.jobs().findIndex((j: any) => j.id === focus || j.label === focus); if (i >= 0) this.idx = i; }
    else { const i = this.jobs().findIndex((j: any) => j.status === "running"); if (i >= 0) this.idx = i; }
    this.timer = setInterval(() => this.tui.requestRender(), 500);
    (this.timer as any).unref?.();
  }
  private jobs(): any[] { return reconcileJobs(readJobs(this.runtimeDir)); }
  dispose() { clearInterval(this.timer); }
  invalidate() {}

  handleInput(data: string): void {
    const n = this.jobs().length;
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "alt+w")) { this.done(undefined); return; }
    if (matchesKey(data, "tab") || matchesKey(data, "right")) { this.idx = n ? (this.idx + 1) % n : 0; this.scroll = 0; }
    else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) { this.idx = n ? (this.idx - 1 + n) % n : 0; this.scroll = 0; }
    else if (matchesKey(data, "up")) this.scroll += 1;
    else if (matchesKey(data, "down")) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, "pageUp")) this.scroll += 15;
    else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - 15);
    else if (data === "f" || matchesKey(data, "end")) this.scroll = 0;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const th = this.theme;
    const rows = Math.max(10, (process.stdout.rows || 30) - 6);
    const jobs = this.jobs();
    if (this.idx >= jobs.length) this.idx = Math.max(0, jobs.length - 1);
    const out: string[] = [];
    out.push(th.fg("accent", th.bold("Relay worker view (read-only)")) + th.fg("dim", "  tab/←→ switch · ↑↓ PgUp/PgDn scroll · f follow · esc/q back to orchestrator"));
    if (!jobs.length) { out.push("", th.fg("dim", "No worker sessions recorded for this feature yet.")); return out.map((l) => truncateToWidth(l, width)); }
    const tabs = jobs.map((j, i) => { const t = `${ICON[j.status] || "○"} ${j.label}`; return i === this.idx ? th.fg("accent", `[${t}]`) : th.fg("dim", ` ${t} `); }).join("");
    out.push(tabs);
    const j = jobs[this.idx];
    const secs = Math.round(((j.endedAt || Date.now()) - (j.startedAt || Date.now())) / 1000);
    out.push(th.fg("dim", `${j.agent}  status=${j.status}  ${secs}s  ${j.tools || 0} tools  ${j.tokens || 0} tokens${j.attempt > 1 ? `  attempt ${j.attempt}` : ""}`));
    out.push(th.fg("dim", "─".repeat(Math.max(0, Math.min(width, 80)))));
    const lines = readLogLines(j.log) as string[];
    const end = Math.max(0, lines.length - this.scroll);
    const start = Math.max(0, end - rows);
    const body = lines.slice(start, end);
    out.push(...(body.length ? body : [th.fg("dim", "(no output yet)")]));
    if (this.scroll > 0) out.push(th.fg("dim", `… ${this.scroll} newer line(s) below — press f to follow`));
    return out.map((l) => truncateToWidth(l, width));
  }
}
