import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { listRuntimes } from "../runtimes";
import { listTasks } from "../tasks";
import { listWorkers } from "../workers";
import { readPanes } from "./herdr";

/**
 * `relay dashboard --doctor`: a Relay-centric source check. Unlike the normal
 * dashboard this is diagnostic, so it may report runtime counts directly.
 */
export function dashboardDoctor(db: Database, dbPath: string, root: string): string {
  const lines: string[] = [];
  lines.push(`repo             ${root}`);
  lines.push(`relay db         OK ${dbPath}`);
  const sock = join(dirname(dbPath), "relay.sock");
  lines.push(`daemon/socket    ${existsSync(sock) ? `OK ${sock}` : "(no socket)"}`);

  const workers = listWorkers(db);
  const tasks = listTasks(db);
  const runtimes = listRuntimes(db);
  const genById = new Map(workers.map((w) => [w.id, w.generation]));
  const current = runtimes.filter((r) => genById.get(r.worker_id) === r.generation);
  const placed = new Set(current.filter((r) => r.pane_id).map((r) => r.worker_id));
  const stale = runtimes.filter((r) => r.state === "stale" || r.state === "dead");

  lines.push(`tasks            ${tasks.length}`);
  lines.push(`workers          ${workers.length}`);
  lines.push(`current runtimes ${current.length}`);
  lines.push(`runtime links    ${workers.filter((w) => placed.has(w.id)).length}/${workers.length}`);
  lines.push(`stale runtimes   ${stale.length}`);

  const panes = readPanes({
    cwdRoot: root,
    // Include panes relay has a runtime row for even outside the repo root
    // (e.g. a Herdr worktree at ~/.herdr/worktrees/...).
    knownPanes: runtimes.map((r) => r.pane_id).filter((p): p is string => !!p),
  });
  lines.push(`herdr            ${panes ? `OK (${panes.size} panes)` : "off"}`);
  return lines.join("\n");
}
