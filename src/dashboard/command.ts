import { existsSync } from "node:fs";
import { dirname } from "node:path";
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
      // Width is re-read, not cached: `process.stdout.columns` is resolved once,
      // so a resized pane would otherwise keep the width from startup forever.
      let width = terminalWidth();
      const stdout = process.stdout as NodeJS.WriteStream;
      const draw = () => {
        width = terminalWidth() ?? width;
        const view = build();
        stdout.write("\x1b[2J\x1b[H");
        stdout.write(
          (json ? renderDashboardJson(view) : renderDashboard(view, { color, links: color, width, runtimeHistory: history })) + "\n"
        );
      };
      // Redraw on resize instead of waiting for the next tick, so the layout
      // follows the pane as it is dragged. `resize` only fires on a TTY.
      stdout.on("resize", draw);
      draw();
      for (;;) {
        await new Promise((r) => setTimeout(r, Math.max(250, interval)));
        draw();
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
