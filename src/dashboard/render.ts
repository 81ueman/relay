import type {
  DashboardTaskNode,
  DashboardView,
  DashboardWorker,
} from "./model";

/**
 * Dashboard rendering: DashboardView -> text (ANSI/plain) or JSON.
 * Knows nothing about SQLite: the model already resolved everything.
 */

const A = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", underline: "\x1b[4m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const TASK_COLOR: Record<string, keyof typeof A> = {
  running: "green", queued: "cyan", review: "yellow",
  blocked_human: "red", blocked_internal: "magenta", failed: "red", done: "gray",
};
const WORKER_COLOR: Record<string, keyof typeof A> = {
  working: "green", idle: "gray", waiting_input: "yellow", stalled: "red", dead: "red", starting: "cyan",
};

export const PANE_LINK_BASE = "https://relay.local/pane/";

const OSC8_PREFIX = "\x1b]8;;";
const OSC8_SUFFIX = "\x1b\\";

export function paneLink(paneId: string, links: boolean): string {
  if (!links) return paneId;
  const vis = `${A.underline}${paneId}${A.reset}`;
  return `${OSC8_PREFIX}${PANE_LINK_BASE}${paneId}${OSC8_SUFFIX}${vis}${OSC8_PREFIX}${OSC8_SUFFIX}`;
}

/** Display width: East Asian Wide / Fullwidth count as 2. */
export function dwidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x300 && cp <= 0x36f) continue; // combining marks
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

export function trim(s: string, w: number): string {
  s = s ?? "";
  if (w <= 1) return "";
  if (dwidth(s) <= w) return s;
  const ell = dwidth("…");
  let out = "";
  let used = 0;
  for (const ch of s) {
    const cw = dwidth(ch);
    if (used + cw > w - ell) break;
    out += ch;
    used += cw;
  }
  return out + "…";
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms == null) return "-";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

type ColorFn = (text: string, name?: keyof typeof A) => string;

export interface RenderOptions {
  color?: boolean;
  links?: boolean;
  width?: number;
  runtimeHistory?: boolean;
}

export function renderDashboard(view: DashboardView, opts: RenderOptions = {}): string {
  const color = !!opts.color;
  const links = !!opts.links;
  const width = opts.width && opts.width > 0 ? opts.width : 120;
  const c: ColorFn = (t, name) => (color && name ? `${A[name]}${t}${A.reset}` : t);
  const lines: string[] = [];

  const dirty = view.git.dirty ? ` dirty:${view.git.dirty}` : "";
  const left = `relay / ${basename(view.root)}`;
  const right = `${view.git.branch} ${view.git.headSha}${dirty}`;
  const pad = width - dwidth(left) - dwidth(right);
  if (pad >= 2) lines.push(c(trim(left, width), "bold") + " ".repeat(pad) + c(right, "gray"));
  else {
    lines.push(c(trim(left, width), "bold"));
    lines.push(c(trim(right, width), "gray"));
  }

  const s = view.summary;
  const parts = [`${s.total} tasks`, `${s.done} done`];
  for (const st of ["running", "queued", "review", "blocked_human", "blocked_internal", "failed"]) {
    if (s.counts[st]) parts.push(`${s.counts[st]} ${st}`);
  }
  lines.push(trim(parts.join("   "), width));

  lines.push("");
  lines.push(c("WORK", "bold"));
  renderWork(lines, view.taskForest, width, c);

  lines.push("");
  lines.push(c("WORKERS", "bold"));
  if (!view.workers.length) lines.push(c("  (none)", "gray"));
  else renderWorkers(lines, view, width, c, links);
  if (links && view.workers.length) lines.push(c("  Ctrl+click a pane id → focus that pane", "dim"));

  lines.push("");
  lines.push(c("ATTENTION", "bold"));
  if (!view.attention.length) lines.push(c("  none", "gray"));
  for (const a of view.attention) {
    const age = a.ageMs != null ? `  ${fmtAge(a.ageMs)}` : "";
    lines.push(c(trim(`  ! ${a.id.padEnd(16)} ${a.text}${age}`, width), "red"));
  }

  if (opts.runtimeHistory) {
    lines.push("");
    lines.push(c("RUNTIME HISTORY", "bold"));
    for (const w of view.workers) {
      lines.push("  " + c(w.id, "blue"));
      for (const r of [w.runtime, ...w.oldRuntimes]) {
        if (r.generation == null && r.state == null) continue;
        lines.push(`    g${String(r.generation ?? "-").padEnd(3)} ${String(r.state ?? "-").padEnd(8)} ${r.paneId ?? "-"}`);
      }
    }
  }

  if (!view.summary.herdr) lines.push(c("  (herdr: off — execution states unavailable)", "gray"));
  return lines.join("\n");
}

function renderWork(lines: string[], forest: DashboardTaskNode[], width: number, c: ColorFn): void {
  if (!forest.length) {
    lines.push(c("  (none)", "gray"));
    return;
  }
  const stW = width >= 64 ? 15 : 8;
  const cols = 8 + 1 + stW + 1;

  const emitNode = (n: DashboardTaskNode, prefix: string, branch: string, childPrefix: string): void => {
    const tag = c(trim(n.state, stW).padEnd(stW), TASK_COLOR[n.state]);
    const tree = prefix + branch;
    const avail = width - cols - dwidth(tree);
    if (n.children.length && n.allDone) {
      const suffix = `  (${n.subtreeSize}/${n.subtreeSize} done)`;
      const title = "✓ " + trim(n.title, Math.max(1, avail - dwidth(suffix) - 2));
      lines.push(c(`${n.id.padEnd(8)} ${tag} ${tree}${title}${suffix}`, "gray"));
      return;
    }
    const owner = n.assignee ?? n.role ?? "-";
    let role = n.role && n.assignee ? `  role=${n.role}` : "";
    if (avail - 8 < dwidth(role)) role = "";
    let tail = owner ? `  [${owner}]` : "";
    if (avail - dwidth(role) - 8 < dwidth(tail)) tail = "";
    const title = trim(n.title, Math.max(1, avail - dwidth(role) - dwidth(tail)));
    const line = `${n.id.padEnd(8)} ${tag} ${tree}${title}${role}${tail}`;
    lines.push(n.state === "done" ? c(line, "dim") : line);
    if (n.children.length) emitGroup(n.children, childPrefix, false);
  };

  const emitGroup = (nodes: DashboardTaskNode[], prefix: string, top: boolean): void => {
    const active = nodes.filter((n) => n.state !== "done");
    const dones = nodes.filter((n) => n.state === "done").sort((a, b) => (a.id < b.id ? -1 : 1));
    const items: (DashboardTaskNode | null)[] = [...active];
    let fold = 0;
    if (dones.length <= 3) items.push(...dones);
    else {
      fold = dones.reduce((acc, n) => acc + n.subtreeSize, 0);
      items.push(null);
    }
    items.forEach((n, i) => {
      const isLast = i === items.length - 1;
      const branch = top ? "" : isLast ? "└─ " : "├─ ";
      const childPrefix = top ? "" : prefix + (isLast ? "   " : "│  ");
      if (n === null) {
        const tag = c("✓", "gray").padEnd(stW);
        lines.push(c(`${"".padEnd(8)} ${tag} ${prefix}${branch}${fold} done`, "gray"));
        return;
      }
      emitNode(n, prefix, branch, childPrefix);
    });
  };

  emitGroup(forest, "", true);
}

/**
 * WORKERS are flat peers; the task tree is authoritative. Rows are projected onto
 * the WORK topology: a cluster header names the task subtree, and the workers
 * under it are SIBLINGS ("relates to this cluster"), never a hierarchy.
 *
 * Grouping is kept at every width — only the per-row tail degrades.
 */
function renderWorkers(
  lines: string[],
  view: DashboardView,
  width: number,
  c: ColorFn,
  links: boolean
): void {
  const byId = new Map(view.workers.map((w) => [w.id, w]));
  const clusters = view.workerClusters;

  clusters.forEach((cluster, ci) => {
    if (cluster.header) {
      if (ci > 0) lines.push("");
      lines.push(clusterHeader(cluster.header, width, c));
    } else {
      // Ungrouped bucket: no task affinity was derivable.
      if (ci > 0) lines.push("");
      lines.push(c("AVAILABLE / OTHER", "gray"));
    }
    for (const id of cluster.workerIds) {
      const w = byId.get(id);
      if (w) renderWorker(lines, w, width, c, links, cluster.header !== null);
    }
  });
}

/**
 * Cluster header: `T149  CP-W3 control-exactness wave`. Deliberately carries no
 * state/assignee/role — the WORK section already shows those; repeating them
 * here would just be noise.
 */
function clusterHeader(header: { id: string; title: string }, width: number, c: ColorFn): string {
  const id = header.id;
  const title = trim(header.title, Math.max(0, width - dwidth(id) - 4));
  return c(`${id}${title ? `  ${title}` : ""}`, "cyan");
}

function renderWorker(
  lines: string[],
  w: DashboardWorker,
  width: number,
  c: ColorFn,
  links: boolean,
  indented = true
): void {
  const wide = width >= 56;
  const idW = wide ? 16 : Math.max(8, Math.min(16, width - 27));
  const stW = wide ? 13 : 8;
  const exW = wide ? 12 : 8;
  const tag = c(trim(w.state, stW).padEnd(stW), WORKER_COLOR[w.state]);
  const execColor: keyof typeof A = w.exec === "busy" ? "green"
    : w.exec === "!idle" ? "red" : w.exec === "quiet" ? "cyan" : "gray";
  const exec = c(trim(w.exec, exW).padEnd(exW), execColor);
  const task = trim(w.taskId ?? "-", 5).padEnd(5);
  const lead = `  ${trim(w.id, idW).padEnd(idW)} ${tag} ${exec} ${task}`;
  let used = 2 + idW + 1 + stW + 1 + exW + 1 + 5;
  let tail = "";
  const push = (text: string, w_: number): void => {
    if (used + w_ <= width) {
      tail += text;
      used += w_;
    }
  };
  if (width >= 64) push(`  g${w.generation ?? "-"}`.padEnd(6), 6);
  if (width >= 72) {
    if (w.paneId) {
      const pad = " ".repeat(Math.max(0, 9 - dwidth(w.paneId)));
      push("  " + paneLink(w.paneId, links) + pad, 2 + Math.max(9, dwidth(w.paneId)));
    } else push("  no-pane", 9);
  }
  if (w.quietRemainingMs == null) {
    const age = fmtAge(w.progressAgeMs);
    push(`  ${age}`, 2 + dwidth(age));
  }
  if (w.quietRemainingMs != null && w.quietReason && width >= 90) {
    const reason = `  "${trim(w.quietReason, 30)}"`;
    if (used + dwidth(reason) <= width) tail += reason;
  }
  // Optional affinity hint for an idle peer: which task pulled it into this
  // cluster. The task column stays `-` — affinity is not ownership.
  if (indented && w.taskId == null && w.affinity.anchorTaskId && width >= 100) {
    push(`  →${w.affinity.anchorTaskId}`, 3 + dwidth(w.affinity.anchorTaskId));
  }
  lines.push(lead + tail);
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export function renderDashboardJson(view: DashboardView): string {
  return JSON.stringify({
    summary: view.summary,
    git: view.git,
    tasks: view.taskForest,
    task_tree: view.taskForest,
    workers: view.workers.map((w) => ({
      ...w,
      // Derived affinity, in the snake_case shape the spec asks for. It is a
      // projection of task topology, never a stored worker relationship.
      affinity: {
        anchor_task_id: w.affinity.anchorTaskId,
        cluster_task_id: w.affinity.clusterTaskId,
        source: w.affinity.source,
      },
    })),
    // Same grouping the WORKERS section shows: clusters in WORK preorder, the
    // ungrouped bucket last. `cluster_task_id: null` == AVAILABLE / OTHER.
    worker_clusters: view.workerClusters.map((cl) => ({
      cluster_task_id: cl.clusterTaskId,
      title: cl.header?.title ?? null,
      workers: cl.workerIds,
    })),
    attention: view.attention,
  }, null, 2);
}
