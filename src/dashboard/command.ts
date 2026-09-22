import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { stdin } from "node:process";
import { defaultDbPath, openDb } from "../db";
import { dashboardDoctor } from "./doctor";
import { focusPane, hidePane, showPane, trackedPane } from "./herdr";
import { buildDashboardView } from "./model";
import { PANE_LINK_BASE, renderDashboard, renderDashboardJson } from "./render";

/**
 * `relay dashboard` — a READ-ONLY, human-facing projection of the Relay control
 * plane, with Herdr execution telemetry overlaid. It never mutates tasks,
 * workers, messages or runtimes, and it never manages worker runtimes (its own
 * UI pane is not a worker).
 *
 *   relay dashboard                  one render to the current terminal
 *   relay dashboard --watch          redraw in a loop (Ctrl-C to stop)
 *   relay dashboard --show           open/reuse a Herdr pane next to this one
 *   relay dashboard --show --tab     open it in its own tab
 *   relay dashboard --hide           close the tracked dashboard pane
 *   relay dashboard --doctor         source check (db / socket / herdr / counts)
 *   relay dashboard --json           machine-readable view
 *   relay dashboard --runtime-history  include old runtime generations
 *   relay dashboard --focus          OSC8 link handler (Ctrl+click a pane id)
 */

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/**
 * Current terminal width, re-read every time. `process.stdout.columns` is
 * resolved once by the runtime and then cached, so a resized pane keeps the
 * width it started with; callers that redraw must call this again (the
 * `resize` event is the trigger, this is the value).
 */
export function terminalWidth(fallback = 120): number {
  const cols = (process.stdout as NodeJS.WriteStream).columns;
  if (typeof cols === "number" && cols > 0) return cols;
  const env = Number(process.env.COLUMNS);
  if (Number.isFinite(env) && env > 0) return env;
  return fallback;
}

/**
 * Current terminal height (rows), re-read every redraw for the same reason as
 * `terminalWidth`. Used to CLIP the watch view to the pane: a frame taller than
 * the pane scrolls into scrollback, so every redraw would append another copy
 * (the accumulation this fixes). Falls back to LINES, then 40.
 */
export function terminalHeight(fallback = 40): number {
  const rows = (process.stdout as NodeJS.WriteStream).rows;
  if (typeof rows === "number" && rows > 0) return rows;
  const env = Number(process.env.LINES);
  if (Number.isFinite(env) && env > 0) return env;
  return fallback;
}

/**
 * Window a rendered frame for the pane: return the `rows` lines starting at
 * `offset`, clamped so the window never runs past the end and never returns more
 * than `rows` lines. The watch loop uses this both for the live top (`offset=0`)
 * and for paused scrolling, so a frame can never overflow the pane.
 */
export function windowLines(lines: string[], offset: number, rows: number): string[] {
  if (rows <= 0) return [];
  const maxOffset = Math.max(0, lines.length - rows);
  const start = Math.min(Math.max(0, offset), maxOffset);
  return lines.slice(start, start + rows);
}

export async function runDashboard(args: string[]): Promise<number> {
  // OSC8 link handler: Herdr passes the clicked URL in the environment. No DB.
  if (hasFlag(args, "--focus")) {
    const url = process.env.HERDR_PLUGIN_CLICKED_URL
      ?? args.find((a) => a.startsWith(PANE_LINK_BASE))
      ?? flag(args, "--focus")
      ?? "";
    const pane = url.startsWith(PANE_LINK_BASE) ? url.slice(PANE_LINK_BASE.length) : url;
    if (!pane) {
      console.error("relay dashboard --focus: no pane id in clicked url");
      return 2;
    }
    try {
      await focusPane(pane);
      return 0;
    } catch (e) {
      console.error(`relay dashboard --focus ${pane}: ${String(e).slice(0, 160)}`);
      return 1;
    }
  }

  const dbPath = defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error("relay dashboard: control-plane DB not found");
    console.error(`expected: ${dbPath}`);
    console.error("run: relay init");
    return 2;
  }
  const root = dirname(dirname(dbPath));

  if (hasFlag(args, "--doctor")) {
    const db = openDb(dbPath);
    try {
      console.log(dashboardDoctor(db, dbPath, root));
    } finally {
      db.close();
    }
    return 0;
  }

  if (hasFlag(args, "--hide")) {
    const r = hidePane(root);
    console.log(r.closed ? `relay dashboard: closed ${r.pane}`
      : r.pane ? `relay dashboard: ${r.pane} already gone`
      : "relay dashboard: no tracked pane");
    return 0;
  }

  if (hasFlag(args, "--show")) {
    const target = flag(args, "--pane") ?? process.env.HERDR_PANE_ID ?? null;
    const direction: "right" | "down" = flag(args, "--direction") === "down" ? "down" : "right";
    const tab = hasFlag(args, "--tab");
    try {
      const r = showPane({
        root,
        command: "relay dashboard --watch",
        target,
        direction,
        tab,
        tabLabel: flag(args, "--tab-label"),
        tabWorkspace: flag(args, "--tab-workspace") ?? null,
      });
      console.log(`relay dashboard: live dashboard in ${r.pane}` + (tab ? " (tab)" : ` (direction=${direction})`));
      console.log("  stop with: relay dashboard --hide");
      return 0;
    } catch (e) {
      console.error(`relay dashboard --show: ${String(e).slice(0, 160)}`);
      return 2;
    }
  }

  const db = openDb(dbPath);
  try {
    const excludePane = trackedPane(root);
    const color = process.stdout.isTTY || process.env.FORCE_COLOR === "1";
    const json = hasFlag(args, "--json");
    const history = hasFlag(args, "--runtime-history");
    const build = () => buildDashboardView(db, { root, excludePane });

    if (hasFlag(args, "--watch")) {
      const interval = Number(flag(args, "--interval") ?? process.env.RELAY_DASHBOARD_INTERVAL_MS ?? 2000);
      // Width/height are re-read, not cached: `process.stdout.columns/rows` are
      // resolved once, so a resized pane would otherwise keep the size from
      // startup forever.
      let width = terminalWidth();
      const stdout = process.stdout as NodeJS.WriteStream;
      const interactive = !!stdout.isTTY;
      const altScreen = interactive && !hasFlag(args, "--no-alt-screen");
      // Pause/resume: while paused the view is frozen and a PAUSED banner is
      // shown, so the operator can read the tree at leisure without it being
      // wiped by the next tick. Space or `p` toggles. While paused, ↑/↓ (k/j)
      // SCROLL the view so the clipped tail is readable — the operator asked to
      // read the whole tree without it being wiped.
      let paused = false;
      let scroll = 0;
      let lastFrame: string[] = [];
      const write = (s: string) => stdout.write(s);
      if (interactive && !altScreen) {
        // Be honest: inline mode shares the terminal's scrollback, and a
        // full-screen redraw necessarily pushes rows there. The VISIBLE frame is
        // correct and singular, but scrolling up will show past frames.
        console.error("relay dashboard --watch: --no-alt-screen draws inline; past frames remain in your scrollback (use the default alt-screen for a fixed view).");
      }
      const draw = () => {
        width = terminalWidth() ?? width;
        const height = terminalHeight();
        const frame = json
          ? renderDashboardJson(build())
          : renderDashboard(build(), { color, links: color, width, runtimeHistory: history });
        lastFrame = frame.split("\n");
        // A paused view is FROZEN: keep the frame we already hold so a tick
        // cannot move it under the reader.
        let lines = lastFrame;
        // CLIP to the pane: an overflowing frame scrolls into the scrollback, and
        // clearing the screen cannot clear scrollback, so each redraw would append
        // a stale copy. alt-screen (default) removes scrollback entirely.
        //
        // HOME + ERASE-DOWN (`\x1b[H\x1b[0J`), NOT `\x1b[2J`: ED2 (full-screen
        // erase) makes some emulators push the visible screen into scrollback.
        write("\x1b[H\x1b[0J");
        // Reserve the bottom row (a full-width line sets the wrap-pending flag,
        // and the following LF scrolls one row — verified in a real tmux).
        const usable = Math.max(1, height - 1);
        const banner = paused
          ? `\x1b[7m PAUSED \x1b[0m ${scroll > 0 ? `↑` : " "}${scroll + usable < lines.length ? `↓` : " "} ` +
            `lines ${scroll + 1}-${Math.min(scroll + usable, lines.length)}/${lines.length}  ` +
            `(space resume · ↑/↓ scroll)\n`
          : "";
        const bannerRows = paused ? 1 : 0;
        if (banner) write(banner);
        const rows = Math.max(1, usable - bannerRows);
        const maxScroll = Math.max(0, lines.length - rows);
        if (scroll > maxScroll) scroll = maxScroll;
        const view = windowLines(lines, scroll, rows);
        write(view.join("\n"));
      };
      const enterAlt = () => { if (altScreen) write("\x1b[?1049h"); };
      const leaveAlt = () => { if (altScreen) write("\x1b[?1049l"); };
      const cleanup = () => {
        if (interactive) {
          stdout.removeListener("resize", draw);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.removeListener("data", onKey);
          stdin.pause();
        }
        leaveAlt();
        // Leave the cursor visible and the screen sane for the shell that
        // regains the terminal.
        write("\x1b[?25h");
      };
      const onKey = (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        if (s === "\u0003" || s === "q") { cleanup(); process.exit(0); } // Ctrl-C / q
        if (s === " " || s === "p") {
          paused = !paused;
          if (!paused) scroll = 0; // resuming returns to the live top
          draw();
          return;
        }
        if (!paused) return; // scrolling only makes sense in a frozen view
        const usable = Math.max(1, terminalHeight() - 1 - 1);
        const maxScroll = Math.max(0, lastFrame.length - usable);
        if (s === "\u001b[A" || s === "k") { scroll = Math.max(0, scroll - 1); draw(); }
        else if (s === "\u001b[B" || s === "j") { scroll = Math.min(maxScroll, scroll + 1); draw(); }
        else if (s === "\u001b[5~") { scroll = Math.max(0, scroll - usable); draw(); }       // PageUp
        else if (s === "\u001b[6~") { scroll = Math.min(maxScroll, scroll + usable); draw(); } // PageDown
      };

      if (interactive) {
        enterAlt();
        write("\x1b[?25l"); // hide cursor while the dashboard owns the screen
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onKey);
      }
      stdout.on("resize", draw);
      process.once("SIGINT", () => { cleanup(); process.exit(0); });
      process.once("SIGTERM", () => { cleanup(); process.exit(0); });
      draw();
      for (;;) {
        await new Promise((r) => setTimeout(r, Math.max(250, interval)));
        if (!paused) draw(); // a paused view is frozen: no redraw, no wipe
      }
    }

    const view = build();
    if (json) console.log(renderDashboardJson(view));
    else console.log(renderDashboard(view, { color, links: color, width: terminalWidth() ?? 120, runtimeHistory: history }));
    return 0;
  } finally {
    db.close();
  }
}
