import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { defaultDbPath, now } from "./db";
import { buildDashboardView } from "./dashboard/model";
import { sendMessage, unreadCounts } from "./messages";
import { listTasks, taskDependencies } from "./tasks";
import { getWorker } from "./workers";

/**
 * `relay web` — a small, dependency-light read/write view of the control plane
 * (Bun.serve + one self-contained HTML page). It is an OPS view, not a product:
 * no accounts, no websockets, no external assets (a tailnet may have no
 * internet), no new npm dependencies.
 *
 *   relay web [--host <h>] [--port <n>] [--token <t>]
 *
 * Defaults bind 127.0.0.1 only. `--host 0.0.0.0` (or a tailnet address) is the
 * explicit opt-in for reaching it from another machine. When a token is set it
 * is required on EVERY request (Authorization: Bearer <t> or ?token=<t>); a
 * non-loopback bind with no token warns loudly but still starts.
 *
 * GETs read the shared SQLite WAL through a READ-ONLY connection, so the web
 * view can never mutate state or trip the single-supervisor guard while the
 * daemon is live. The one writer is POST /api/send, which enqueues through the
 * SAME `sendMessage` path `relay send` uses (durable-first; the daemon's mail
 * policy wakes/defers the recipient at the turn boundary).
 */

/** Task-state groups the UI renders, in display order. */
export const TASK_GROUPS = [
  "queued", "running", "review", "blocked_human", "blocked_internal", "done", "failed", "cancelled",
] as const;

export interface WebTask {
  id: string;
  title: string;
  state: string;
  role: string | null;
  assignee: string | null;
  priority: number;
  parent: string | null;
  dependsOn: string[];
  updatedAt: number;
}

export interface WebWorker {
  id: string;
  role: string;
  state: string;
  taskId: string | null;
  taskTitle: string | null;
  progressAgeMs: number | null;
  unread: number;
  generation: number;
  exec: string;
  paneId: string | null;
  quietRemainingMs: number | null;
  quietReason: string | null;
}

export interface WebMailbox {
  recipient: string;
  queued: number;
  delivered: number;
  unread: number;
}

export interface StatusPayload {
  generatedAt: number;
  summary: {
    total: number;
    done: number;
    groups: number;
    counts: Record<string, number>;
    workers: number;
    working: number;
  };
  workers: WebWorker[];
  tasks: { byState: Record<string, WebTask[]> };
  mailboxes: WebMailbox[];
}

/**
 * The status view for the page and `GET /api/status`. Built from the SAME
 * dashboard model the terminal dashboard uses (`buildDashboardView`), with
 * `panes: null` so no live Herdr call is made per poll — the page is a durable
 * state view, not an execution-telemetry view. Tasks are read through the
 * domain `listTasks`/`taskDependencies` helpers and grouped by state.
 */
export function buildStatusPayload(db: Database, root: string, at = now()): StatusPayload {
  const view = buildDashboardView(db, { root, panes: null, at });
  const tasks = listTasks(db);
  const byState: Record<string, WebTask[]> = {};
  for (const s of TASK_GROUPS) byState[s] = [];
  for (const t of tasks) {
    const list = byState[t.state] ?? (byState[t.state] = []);
    list.push({
      id: t.id,
      title: t.title,
      state: t.state,
      role: t.role,
      assignee: t.assignee,
      priority: t.priority,
      parent: t.parent_task_id,
      dependsOn: taskDependencies(db, t.id),
      updatedAt: t.updated_at,
    });
  }
  const mailboxes: WebMailbox[] = unreadCounts(db).map((u) => ({
    recipient: u.recipient,
    queued: u.queued,
    delivered: u.delivered,
    unread: u.queued + u.delivered,
  }));
  const unreadBy = new Map(mailboxes.map((m) => [m.recipient, m.unread]));
  return {
    generatedAt: at,
    summary: {
      total: view.summary.total,
      done: view.summary.done,
      groups: view.summary.groups,
      counts: view.summary.counts,
      workers: view.summary.workers,
      working: view.summary.working,
    },
    workers: view.workers.map((w) => ({
      id: w.id,
      role: w.role,
      state: w.state,
      taskId: w.taskId,
      taskTitle: w.taskId ? view.tasksById[w.taskId]?.title ?? null : null,
      progressAgeMs: w.progressAgeMs,
      unread: unreadBy.get(w.id) ?? 0,
      generation: w.generation,
      exec: w.exec,
      paneId: w.paneId,
      quietRemainingMs: w.quietRemainingMs,
      quietReason: w.quietReason,
    })),
    tasks: { byState },
    mailboxes,
  };
}

export interface InboxItem {
  id: number;
  sender: string;
  recipient: string;
  task_id: string | null;
  kind: string;
  payload: string;
  state: string;
  created_at: number;
}

/**
 * Pending inbox for a recipient, READ-ONLY: unlike `inboxFor`, viewing the web
 * inbox does NOT flip queued -> delivered, so watching the page cannot silently
 * acknowledge a worker's mail (the durable nudge keeps firing until the worker
 * itself reads/acks it).
 */
export function listMailbox(db: Database, workerId: string): InboxItem[] {
  return db
    .query(
      `SELECT id, sender, recipient, task_id, kind, payload, state, created_at FROM messages
        WHERE recipient = ? AND state IN ('queued','delivered')
        ORDER BY id ASC`
    )
    .all(workerId) as InboxItem[];
}

/** The request body of `POST /api/send`, validated. */
export interface SendInput {
  worker: string;
  message: string;
  kind: "note" | "urgent";
  taskId?: string;
}

export type ValidationResult =
  | { ok: true; value: SendInput }
  | { ok: false; error: string };

/**
 * Validate a `POST /api/send` body WITHOUT touching the DB. Mirrors the guards
 * `relay send` enforces (a durable row is never written for an empty or
 * flag-like body). Unknown-worker existence is checked by the handler, which
 * has the DB.
 */
export function validateSend(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  const worker = typeof b.worker === "string" ? b.worker.trim() : "";
  const message = typeof b.message === "string" ? b.message : "";
  const kindRaw = typeof b.kind === "string" ? b.kind.trim() : "";
  const kind = kindRaw === "" ? "note" : kindRaw;
  if (!worker) return { ok: false, error: "worker is required" };
  if (!message.trim()) return { ok: false, error: "message is required" };
  if (message.startsWith("-")) {
    return { ok: false, error: `refusing the flag-like message "${message}"` };
  }
  if (kind !== "note" && kind !== "urgent") {
    return { ok: false, error: `unknown kind '${kind}' (expected note|urgent)` };
  }
  const taskId = typeof b.taskId === "string" && b.taskId.trim() ? b.taskId.trim() : undefined;
  return { ok: true, value: { worker, message, kind, ...(taskId ? { taskId } : {}) } };
}

/** The web process's own sender id (never a worker identity by accident). */
export function webSender(env: NodeJS.ProcessEnv = process.env): string {
  return env.RELAY_WORKER && env.RELAY_WORKER.trim() ? env.RELAY_WORKER.trim() : "web";
}

/** Constant-ish comparison; the token is a shared secret, not a password hash. */
function tokenMatches(given: string | null, expected: string | null): boolean {
  if (!expected) return true; // no token configured => open
  if (given === null) return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Gate every request when a token is configured: Bearer header or ?token=. */
export function isAuthorized(req: Request, url: URL, token: string | null): boolean {
  if (!token) return true;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (tokenMatches(bearer, token)) return true;
  return tokenMatches(url.searchParams.get("token"), token);
}

/** How the CLI resolves the token: `--token` wins, else `RELAY_WEB_TOKEN`. */
export function resolveToken(args: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const fromFlag = flag(args, "--token");
  if (fromFlag !== undefined && fromFlag !== "") return fromFlag;
  const fromEnv = env.RELAY_WEB_TOKEN;
  return fromEnv && fromEnv !== "" ? fromEnv : null;
}

/** A bind is "loopback" only for the addresses that cannot leave the host. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1" || h.startsWith("127.");
}

export interface WebHandlerOptions {
  root: string;
  /** Absolute path to the control-plane DB (opened per request unless `db`). */
  dbPath?: string;
  /** Test hook: use this DB for every request, never open/close it here. */
  db?: Database;
  token?: string | null;
  sender?: string;
  at?: () => number;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

/** Read-only SQLite connection; falls back to a plain handle if WAL is unavailable. */
function openReadOnly(path: string): Database {
  try {
    return new Database(path, { readonly: true });
  } catch {
    // A read-only WAL open can fail when no writer has created -shm yet. A
    // read-write handle that only ever runs SELECTs is still non-mutating.
    const db = new Database(path);
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  }
}

/** Read-write handle for the send path; never runs the schema or migrations. */
function openWritable(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * Build the fetch handler. It is exported separately from `runWeb` so tests can
 * drive it with a Request/Response pair and no port, and so the routing,
 * validation and auth gate are covered without a live server.
 */
export function createWebHandler(opts: WebHandlerOptions): (req: Request) => Promise<Response> {
  const token = opts.token ?? null;
  const at = opts.at ?? now;
  const sender = opts.sender ?? webSender();

  /** Run `fn` against a DB: the injected test DB, or a fresh per-request handle. */
  const withDb = <T>(readonly: boolean, fn: (db: Database) => T): T => {
    if (opts.db) return fn(opts.db);
    if (!opts.dbPath) throw new Error("no db configured");
    const db = readonly ? openReadOnly(opts.dbPath) : openWritable(opts.dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!isAuthorized(req, url, token)) {
      return json(401, { error: "unauthorized", hint: "send Authorization: Bearer <token> or ?token=<token>" });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(renderIndexHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      try {
        const payload = withDb(true, (db) => buildStatusPayload(db, opts.root, at()));
        return json(200, payload);
      } catch (e) {
        return json(500, { error: String(e instanceof Error ? e.message : e).slice(0, 300) });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/inbox") {
      const worker = url.searchParams.get("worker")?.trim() ?? "";
      if (!worker) return json(400, { error: "worker query parameter is required" });
      try {
        return withDb(true, (db) => {
          if (!getWorker(db, worker)) return json(404, { error: `unknown worker: ${worker}` });
          return json(200, { worker, messages: listMailbox(db, worker) });
        });
      } catch (e) {
        return json(500, { error: String(e instanceof Error ? e.message : e).slice(0, 300) });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const parsed = validateSend(body);
      if (!parsed.ok) return json(400, { error: parsed.error });
      const { worker, message, kind, taskId } = parsed.value;
      try {
        return withDb(false, (db) => {
          if (!getWorker(db, worker)) return json(404, { error: `unknown worker: ${worker}` });
          // SAME enqueue path `relay send` uses; durable-first, no second
          // delivery mechanism. The daemon's mail policy delivers/nudges.
          const id = sendMessage(db, sender, worker, message, { kind, taskId });
          return json(200, { ok: true, id, recipient: worker, kind, taskId: taskId ?? null });
        });
      } catch (e) {
        return json(500, { error: String(e instanceof Error ? e.message : e).slice(0, 300) });
      }
    }

    return json(404, { error: `not found: ${req.method} ${url.pathname}` });
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

/**
 * `relay web` entrypoint. Parses flags, resolves the DB, binds the server and
 * prints the reachability/token notice. The process is kept alive by the
 * server (and by the never-resolving await below).
 */
export async function runWeb(args: string[]): Promise<number> {
  const host = flag(args, "--host") ?? "127.0.0.1";
  const portRaw = flag(args, "--port");
  const port = portRaw === undefined ? 8787 : Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`relay web: invalid --port '${portRaw}' (expected 1-65535)`);
  }
  const token = resolveToken(args);
  const dbPath = defaultDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`relay web: control-plane DB not found at ${dbPath}\n  run: relay init`);
  }
  const root = dirname(dirname(dbPath));
  const handler = createWebHandler({ root, token, dbPath });
  const server = Bun.serve({ hostname: host, port, fetch: handler });
  console.log(`relay web listening on http://${host}:${server.port}  (db=${dbPath})`);
  if (token) {
    console.log("token required: append ?token=<t> to the URL, or send Authorization: Bearer <t>");
  }
  if (!isLoopbackHost(host) && !token) {
    console.error("");
    console.error("relay web: WARNING — bound to a NON-LOOPBACK address with NO token.");
    console.error("  Anyone who can reach this address can read state and send messages.");
    console.error("  Set a token: --token <t> (or RELAY_WEB_TOKEN) and pass ?token=<t>.");
    console.error("");
  } else if (!isLoopbackHost(host)) {
    console.log("reachable off-host: keep the token secret; it is the only access control.");
  }
  // Bun.serve keeps the event loop alive, but keep the promise pending so the
  // CLI never falls through to the (single DB) command dispatch.
  await new Promise<never>(() => {});
  return 0;
}

/**
 * The single self-contained page: inline CSS + JS, no external assets (a
 * tailnet may have no internet). It polls /api/status every ~3s, renders
 * workers / tasks-by-state / mailbox counts, shows the selected worker's inbox,
 * and POSTs the send form. The token, when configured, travels as a query
 * parameter so a bookmarked URL keeps working.
 */
export function renderIndexHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>relay web</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #11151c; color: #d6deeb; }
  header { position: sticky; top: 0; display: flex; gap: 12px; align-items: baseline;
           padding: 10px 16px; background: #0b0f14; border-bottom: 1px solid #233246; z-index: 2; }
  header h1 { margin: 0; font-size: 15px; letter-spacing: .5px; color: #7fdbff; }
  header .meta { color: #8aa0b8; font-size: 12px; }
  main { padding: 14px 16px 40px; display: grid; gap: 16px; max-width: 1200px; }
  section { background: #151b24; border: 1px solid #233246; border-radius: 8px; padding: 12px 14px; }
  h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #8aa0b8; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #1d2836; vertical-align: top; }
  th { color: #6f849c; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  td.num { text-align: right; }
  a { color: #7fdbff; text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
  .state { font-weight: 600; }
  .state.working, .state.running { color: #2ecc71; }
  .state.review, .state.queued, .state.waiting_input { color: #f1c40f; }
  .state.dead, .state.stalled, .state.blocked_human, .state.blocked_internal, .state.failed { color: #ff6b6b; }
  .state.done { color: #8aa0b8; }
  .state.cancelled { color: #8aa0b8; text-decoration: line-through; }
  form.send { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input, select, button { font: inherit; background: #0b0f14; color: #d6deeb;
                          border: 1px solid #2c405a; border-radius: 6px; padding: 5px 8px; }
  input.grow { flex: 1 1 320px; }
  button { cursor: pointer; background: #1f6feb; border-color: #1f6feb; color: #fff; }
  button:hover { background: #388bfd; }
  .result { margin-top: 8px; font-size: 12px; color: #8aa0b8; min-height: 1em; }
  .result.err { color: #ff6b6b; }
  .result.ok { color: #2ecc71; }
  .group { margin-bottom: 10px; }
  .group h3 { margin: 0 0 4px; font-size: 12px; color: #8aa0b8; }
  .muted { color: #6f849c; }
  .pill { display: inline-block; padding: 0 6px; border-radius: 10px; background: #233246; font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>relay</h1>
  <span class="meta" id="meta">loading…</span>
</header>
<main>
  <section>
    <h2>Send message</h2>
    <form class="send" id="send-form">
      <select id="send-worker" aria-label="worker"></select>
      <select id="send-kind" aria-label="kind">
        <option value="note">note</option>
        <option value="urgent">urgent</option>
      </select>
      <input class="grow" id="send-text" placeholder="message…" autocomplete="off" aria-label="message" />
      <button type="submit">send</button>
    </form>
    <div class="result" id="send-result"></div>
  </section>

  <section>
    <h2>Workers</h2>
    <table id="workers"></table>
  </section>

  <section>
    <h2>Tasks</h2>
    <div id="tasks" class="muted">(none)</div>
  </section>

  <section>
    <h2>Mailboxes</h2>
    <table id="mailboxes"></table>
  </section>

  <section>
    <h2>Inbox <span class="muted" id="inbox-who"></span></h2>
    <div id="inbox" class="muted">select a worker</div>
  </section>
</main>
<script>
(function () {
  var qs = new URLSearchParams(location.search);
  var TOKEN = qs.get("token") || "";
  function api(path) {
    if (!TOKEN) return path;
    return path + (path.indexOf("?") < 0 ? "?" : "&") + "token=" + encodeURIComponent(TOKEN);
  }
  function headers() {
    return TOKEN ? { "Authorization": "Bearer " + TOKEN } : {};
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function age(ms) {
    if (ms == null) return "-";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h";
  }
  var selected = null;
  var lastWorkers = [];

  function render(d) {
    document.getElementById("meta").textContent =
      "workers " + d.summary.workers + " · working " + d.summary.working +
      " · queued " + (d.summary.counts.queued || 0) +
      " · updated " + new Date(d.generatedAt).toLocaleTimeString();

    lastWorkers = d.workers;
    var rows = d.workers.map(function (w) {
      return "<tr><td><a data-worker=\\"" + esc(w.id) + "\\">" + esc(w.id) + "</a></td>" +
        "<td>" + esc(w.role) + "</td>" +
        "<td class=\\"state " + esc(w.state) + "\\">" + esc(w.state) + "</td>" +
        "<td>" + esc(w.taskId || "-") + "</td>" +
        "<td class=\\"muted\\">" + esc(w.taskTitle || "") + "</td>" +
        "<td>" + age(w.progressAgeMs) + "</td>" +
        "<td class=\\"num\\">" + (w.unread || 0) + "</td></tr>";
    }).join("");
    document.getElementById("workers").innerHTML =
      "<tr><th>id</th><th>role</th><th>state</th><th>task</th><th>title</th><th>progress</th><th>unread</th></tr>" + rows;

    var sel = document.getElementById("send-worker");
    var keep = sel.value;
    sel.innerHTML = d.workers.map(function (w) {
      return "<option value=\\"" + esc(w.id) + "\\">" + esc(w.id) + " (" + esc(w.role) + ")</option>";
    }).join("");
    if (keep) sel.value = keep;

    var groups = d.tasks.byState;
    var keys = Object.keys(groups).filter(function (k) { return groups[k].length; });
    if (!keys.length) {
      document.getElementById("tasks").innerHTML = "<span class=\\"muted\\">(none)</span>";
    } else {
      document.getElementById("tasks").innerHTML = keys.map(function (k) {
        var list = groups[k].map(function (t) {
          var deps = t.dependsOn && t.dependsOn.length ? " · depends " + esc(t.dependsOn.join(",")) : "";
          return "<tr><td>" + esc(t.id) + "</td><td class=\\"state " + esc(t.state) + "\\">" + esc(t.state) +
            "</td><td>" + esc(t.role || "-") + "</td><td>" + esc(t.assignee || "-") +
            "</td><td>" + esc(t.title) + "</td><td class=\\"muted\\">" + deps + "</td></tr>";
        }).join("");
        return "<div class=\\"group\\"><h3>" + esc(k) + " <span class=\\"pill\\">" + groups[k].length + "</span></h3>" +
          "<table><tr><th>id</th><th>state</th><th>role</th><th>assignee</th><th>title</th><th></th></tr>" + list + "</table></div>";
      }).join("");
    }

    document.getElementById("mailboxes").innerHTML =
      "<tr><th>recipient</th><th>queued</th><th>delivered</th><th>unread</th></tr>" +
      d.mailboxes.map(function (m) {
        return "<tr><td><a data-worker=\\"" + esc(m.recipient) + "\\">" + esc(m.recipient) + "</a></td>" +
          "<td class=\\"num\\">" + m.queued + "</td><td class=\\"num\\">" + m.delivered +
          "</td><td class=\\"num\\">" + m.unread + "</td></tr>";
      }).join("");

    if (selected) loadInbox(selected);
  }

  function loadInbox(worker) {
    selected = worker;
    document.getElementById("inbox-who").textContent = worker;
    fetch(api("/api/inbox?worker=" + encodeURIComponent(worker)), { headers: headers() })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { document.getElementById("inbox").innerHTML = "<span class=\\"muted\\">" + esc(res.j.error) + "</span>"; return; }
        var msgs = res.j.messages || [];
        if (!msgs.length) { document.getElementById("inbox").innerHTML = "<span class=\\"muted\\">empty</span>"; return; }
        document.getElementById("inbox").innerHTML = "<table><tr><th>#</th><th>from</th><th>kind</th><th>state</th><th>task</th><th>message</th></tr>" +
          msgs.map(function (m) {
            return "<tr><td>" + m.id + "</td><td>" + esc(m.sender) + "</td><td>" + esc(m.kind) +
              "</td><td>" + esc(m.state) + "</td><td>" + esc(m.task_id || "-") + "</td><td>" + esc(m.payload) + "</td></tr>";
          }).join("") + "</table>";
      })
      .catch(function () {});
  }

  document.addEventListener("click", function (ev) {
    var a = ev.target.closest ? ev.target.closest("a[data-worker]") : null;
    if (!a) return;
    ev.preventDefault();
    loadInbox(a.getAttribute("data-worker"));
  });

  document.getElementById("send-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var worker = document.getElementById("send-worker").value;
    var message = document.getElementById("send-text").value;
    var kind = document.getElementById("send-kind").value;
    var out = document.getElementById("send-result");
    if (!worker || !message.trim()) { out.className = "result err"; out.textContent = "pick a worker and type a message"; return; }
    fetch(api("/api/send"), {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers()),
      body: JSON.stringify({ worker: worker, message: message, kind: kind })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.ok) { out.className = "result ok"; out.textContent = "sent #" + j.id + " to " + j.recipient + " (" + j.kind + ")"; document.getElementById("send-text").value = ""; }
      else { out.className = "result err"; out.textContent = "error: " + (j.error || "failed"); }
    }).catch(function (e) { out.className = "result err"; out.textContent = "error: " + e; });
  });

  function tick() {
    fetch(api("/api/status"), { headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error("status " + r.status); return r.json(); })
      .then(render)
      .catch(function () {});
  }
  setInterval(tick, 3000);
  tick();
})();
</script>
</body>
</html>
`;
}
