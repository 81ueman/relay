#!/usr/bin/env bun
/**
 * Focus the Herdr pane named in a `relay dashboard` OSC8 link.
 *
 * Herdr routes a Control+click on a terminal URL matching the plugin's
 * `[[link_handlers]]` pattern to this action and passes the URL in
 * `HERDR_PLUGIN_CLICKED_URL` (also inside `HERDR_PLUGIN_CONTEXT_JSON`).
 *
 * The work itself lives in `relay dashboard --focus`: this action is a thin
 * shim so the whole handler stays in the relay codebase (no Python, no duplicate
 * socket code). `relay` must be on PATH (bun link) or set `RELAY_BIN`.
 *
 * Manual test (no click needed):
 *   HERDR_PLUGIN_CLICKED_URL='https://relay.local/pane/w1:p1' bun focus-pane.ts
 * or:
 *   bun focus-pane.ts 'w1:p1'
 */
import { spawnSync } from "node:child_process";

const bin = process.env.RELAY_BIN ?? "relay";
const url = process.env.HERDR_PLUGIN_CLICKED_URL
  ?? process.argv[2]
  ?? (() => {
    try {
      return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}").clicked_url;
    } catch {
      return undefined;
    }
  })();

const args = bin.split(/\s+/).concat(["dashboard", "--focus"]);
if (url) args.push(url);

const r = spawnSync(args[0], args.slice(1), { encoding: "utf-8" });
if (r.status !== 0) {
  process.stderr.write(`relay focus-pane: ${String(r.stderr ?? "").trim() || `exit ${r.status}`}\n`);
}
process.exit(r.status ?? 1);
