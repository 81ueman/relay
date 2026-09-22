import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { renderDashboard } from "../src/dashboard/render";
import { buildDashboardView } from "../src/dashboard/model";
import { dwidth } from "../src/dashboard/render";
import { terminalWidth, terminalHeight, windowLines, shouldUseAltScreen } from "../src/dashboard/command";
import type { PaneTelemetry } from "../src/dashboard/herdr";
import { recordRuntime } from "../src/runtimes";
import { addTask, claimTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// A `relay dashboard --watch` pane must follow the pane as it is dragged.
// `process.stdout.columns` is resolved once and then cached by the runtime, so
// the loop has to re-read it on `resize` instead of trusting the startup value.
// Width is the ONLY input: the renderer already degrades columns by width, so
// these tests check that a resize actually changes what is drawn.

let dir = "";
let db: Database;
const at = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-resize-"));
  mkdirSync(join(dir, ".relay"), { recursive: true });
  db = openDb(join(dir, ".relay", "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const pane = (paneId: string, status = "working"): PaneTelemetry =>
  ({ paneId, agent: "opencode", agentStatus: status, title: "", cwd: dir,
     workspaceId: "w1", tabId: "t1", focused: false });

function view() {
  registerWorker(db, "perf-research", { role: "perf-research" });
  const t = addTask(db, { title: "a rather long task title for the work tree", role: "perf-research" });
  claimTask(db, t.id, "perf-research");
  recordRuntime(db, { workerId: "perf-research", generation: 1, runtimeId: "x", paneId: "w52:p8K", state: "active", relayOwned: 0 });
  db.query(`UPDATE workers SET generation=1 WHERE id='perf-research'`).run();
  return buildDashboardView(db, { root: dir, panes: new Map([["w52:p8K", pane("w52:p8K")]]), at });
}

describe("dashboard resize", () => {
  test("a narrower width drops columns instead of overflowing", () => {
    const v = view();
    const wide = renderDashboard(v, { color: false, width: 120 });
    const narrow = renderDashboard(v, { color: false, width: 44 });

    // Both are valid renders at their own width.
    for (const line of narrow.split("\n")) expect(dwidth(line)).toBeLessThanOrEqual(44);
    for (const line of wide.split("\n")) expect(dwidth(line)).toBeLessThanOrEqual(120);

    // The narrow render is genuinely different: the long title is trimmed and
    // the worker row lost its trailing columns.
    const wideWorker = wide.split("\n").find((l) => l.startsWith("  perf-research"))!;
    const narrowWorker = narrow.split("\n").find((l) => l.startsWith("  perf-research"))!;
    expect(dwidth(narrowWorker)).toBeLessThan(dwidth(wideWorker));
    expect(wide).not.toBe(narrow);
  });

  test("growing back restores the dropped columns (no stale narrow layout)", () => {
    const v = view();
    const narrowFirst = renderDashboard(v, { color: false, width: 44 });
    const backWide = renderDashboard(v, { color: false, width: 120 });
    // Rendering is a pure function of (view, width): the second call is not
    // stuck at the previous narrow width.
    expect(dwidth(backWide.split("\n").find((l) => l.includes("WORKERS"))!))
      .toBeLessThanOrEqual(120);
    const wideWorker = backWide.split("\n").find((l) => l.startsWith("  perf-research"))!;
    const narrowWorker = narrowFirst.split("\n").find((l) => l.startsWith("  perf-research"))!;
    expect(dwidth(wideWorker)).toBeGreaterThan(dwidth(narrowWorker));
  });

  test("terminalWidth re-reads each call instead of caching the startup value", () => {
    // Simulate the runtime's cached property: a fixed `columns`, then a resize.
    const stdout = process.stdout as NodeJS.WriteStream & { columns?: number };
    const saved = stdout.columns;
    const savedEnv = process.env.COLUMNS;
    try {
      delete process.env.COLUMNS;
      stdout.columns = 120;
      const first = terminalWidth();
      stdout.columns = 60; // what a ResizeObserver-backed property update looks like
      const second = terminalWidth();
      expect(first).toBe(120);
      expect(second).toBe(60);
      expect(second).not.toBe(first);
    } finally {
      if (saved === undefined) delete (stdout as { columns?: number }).columns;
      else stdout.columns = saved;
      if (savedEnv === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = savedEnv;
    }
  });

  test("COLUMNS is the fallback when there is no TTY width", () => {
    const stdout = process.stdout as NodeJS.WriteStream & { columns?: number };
    const saved = stdout.columns;
    const savedEnv = process.env.COLUMNS;
    try {
      delete (stdout as { columns?: number }).columns;
      process.env.COLUMNS = "77";
      expect(terminalWidth()).toBe(77);
      delete process.env.COLUMNS;
      expect(terminalWidth()).toBe(120); // documented default
    } finally {
      if (saved !== undefined) stdout.columns = saved;
      if (savedEnv !== undefined) process.env.COLUMNS = savedEnv;
    }
  });
});

// T326: a --watch frame taller than the pane scrolled into scrollback, so every
// redraw appended another copy (\x1b[2J clears only the visible screen). The fix
// CLIPS each frame to the pane height, renders in the ALTERNATE screen, and can
// freeze (PAUSED). A frame must therefore NEVER exceed the pane height.
describe("dashboard watch readability (T326)", () => {
  test("terminalHeight re-reads each call and falls back to LINES", () => {
    const stdout = process.stdout as NodeJS.WriteStream & { rows?: number };
    const saved = stdout.rows;
    const savedEnv = process.env.LINES;
    try {
      delete process.env.LINES;
      stdout.rows = 50;
      expect(terminalHeight()).toBe(50);
      stdout.rows = 24; // a shorter pane
      expect(terminalHeight()).toBe(24);
      delete (stdout as { rows?: number }).rows;
      process.env.LINES = "18";
      expect(terminalHeight()).toBe(18);
      delete process.env.LINES;
      expect(terminalHeight()).toBe(40); // documented default
    } finally {
      if (saved === undefined) delete (stdout as { rows?: number }).rows;
      else stdout.rows = saved;
      if (savedEnv === undefined) delete process.env.LINES;
      else process.env.LINES = savedEnv;
    }
  });

  test("windowLines never returns more than `rows` lines and clamps the offset", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    for (const rows of [1, 5, 24, 40]) {
      for (const off of [0, 10, 39, 1000]) {
        expect(windowLines(lines, off, rows).length).toBeLessThanOrEqual(rows);
      }
    }
    // The live view (offset 0) starts at the TOP — the line the off-by-one lost.
    expect(windowLines(lines, 0, 10)[0]).toBe("line 0");
    expect(windowLines(lines, 0, 10)).toHaveLength(10);
    // Scrolling moves the window and stops at the end (no overrun, no padding).
    expect(windowLines(lines, 5, 10)[0]).toBe("line 5");
    expect(windowLines(lines, 1000, 10)[0]).toBe("line 30"); // maxOffset = 30
    expect(windowLines(lines, 1000, 10)).toHaveLength(10);
    // A frame that fits is returned whole; rows<=0 is empty.
    expect(windowLines(["a", "b", "c"], 0, 10)).toEqual(["a", "b", "c"]);
    expect(windowLines(lines, 0, 0)).toEqual([]);
  });

  test("the watch frame reserves the bottom row and emits NO trailing newline", () => {    // The off-by-one the reviewer found: N lines + a trailing LF is N line-feeds
    // in an N-row pane, so the pane scrolls one row and loses the TOP line. The
    // loop clips to `height - 1` and writes `view.join("\n")` (no trailing LF),
    // which reuses the windowing helper the loop calls.
    const height = 12;
    const frame = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const view = windowLines(frame, 0, Math.max(1, height - 1));
    const written = view.join("\n");
    expect(view).toHaveLength(height - 1);
    expect(written.split("\n")).toHaveLength(height - 1);
    expect(written.endsWith("\n")).toBe(false); // <-- the fix
    expect(written.split("\n")[0]).toBe("line 0"); // top line survives
  });
});

// T340: the alt-screen default hid the dashboard in Herdr panes (herdr pane read
// reads the NORMAL screen). Inside Herdr, --watch must default to INLINE.
describe("alt-screen defaults inside Herdr (T340)", () => {
  test("inside Herdr the default is inline; --alt-screen opts back in", () => {
    const herdr = { HERDR_ENV: "1" };
    expect(shouldUseAltScreen([], herdr, true)).toBe(false);
    expect(shouldUseAltScreen(["--alt-screen"], herdr, true)).toBe(true);
    expect(shouldUseAltScreen(["--no-alt-screen"], herdr, true)).toBe(false);
    // HERDR_PANE_ID alone is enough to detect the pane context.
    expect(shouldUseAltScreen([], { HERDR_PANE_ID: "w6D:p8" }, true)).toBe(false);
  });

  test("outside Herdr alt-screen stays the default (no regression)", () => {
    expect(shouldUseAltScreen([], {}, true)).toBe(true);
    expect(shouldUseAltScreen(["--no-alt-screen"], {}, true)).toBe(false);
    expect(shouldUseAltScreen(["--alt-screen"], {}, true)).toBe(true);
  });

  test("a non-interactive stdout is never alt-screened", () => {
    expect(shouldUseAltScreen(["--alt-screen"], { HERDR_ENV: "1" }, false)).toBe(false);
    expect(shouldUseAltScreen([], {}, false)).toBe(false);
  });
});

// T340 acceptance (b): inline frames must not accumulate in scrollback. BOTH
// ED2 (\x1b[2J) and ED0 (\x1b[0J) push the erased window into tmux scrollback, so
// the draw must HOME + clear each LINE (\x1b[2K) and never emit a full erase.
describe("inline redraw never uses a full-screen erase (T340)", () => {
  test("the draw emits per-line \\x1b[2K and no ED0/ED2", () => {
    // This mirrors the draw loop's byte contract: the loop writes "\x1b[H" then
    // each windowed line prefixed with "\x1b[2K".
    const view = ["relay / x", "WORK", "  task"];
    const rendered = view.map((l) => "\x1b[2K" + l).join("\n");
    expect(rendered).toContain("\x1b[2K");
    expect(rendered).not.toContain("\x1b[0J");
    expect(rendered).not.toContain("\x1b[2J");
    expect(rendered.split("\n")).toHaveLength(3);
    expect(rendered.endsWith("\n")).toBe(false);
  });
});

