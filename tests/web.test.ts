import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { sendMessage } from "../src/messages";
import { addTask, claimNext } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { createWebHandler, validateSend, isAuthorized, isLoopbackHost, type WebHandlerOptions } from "../src/web";

// `relay web`: a small read/write view over the shared control plane. The
// handler is exercised directly (Request -> Response) so routing, validation
// and the auth gate are covered without binding a port.

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-web-"));
  db = openDb(join(dir, ".relay", "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function handler(opts: Partial<WebHandlerOptions> = {}) {
  return createWebHandler({ db, root: dir, ...opts });
}

const get = (h: ReturnType<typeof handler>, path: string, headers?: Record<string, string>) =>
  h(new Request(`http://relay.test${path}`, { headers }));

const post = (h: ReturnType<typeof handler>, path: string, body: unknown, headers?: Record<string, string>) =>
  h(
    new Request(`http://relay.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );

describe("relay web: /api/status", () => {
  test("returns the workers, task groups and mailbox counts", async () => {
    registerWorker(db, "w1", { role: "rust" });
    db.query(`UPDATE workers SET state='idle' WHERE id='w1'`).run();
    registerWorker(db, "w2", { role: "reviewer" });
    const t = addTask(db, { title: "do the thing", role: "rust" });
    claimNext(db, "w1");
    addTask(db, { title: "later", role: "rust" });
    sendMessage(db, "human", "w1", "hello", { kind: "note" });

    const res = await get(handler(), "/api/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workers: { id: string; role: string; state: string; taskId: string | null; taskTitle: string | null; unread: number }[];
      summary: { workers: number; working: number; counts: Record<string, number> };
      tasks: { byState: Record<string, { id: string; dependsOn: string[] }[]> };
      mailboxes: { recipient: string; unread: number }[];
    };
    expect(body.summary.workers).toBe(2);
    expect(body.summary.working).toBe(1);
    const w1 = body.workers.find((w) => w.id === "w1")!;
    expect(w1.role).toBe("rust");
    expect(w1.state).toBe("working");
    expect(w1.taskId).toBe(t!.id);
    expect(w1.taskTitle).toBe("do the thing");
    expect(w1.unread).toBe(1);
    expect(body.tasks.byState.running.map((x) => x.id)).toEqual([t!.id]);
    expect(body.tasks.byState.queued).toHaveLength(1);
    expect(body.tasks.byState.running[0].dependsOn).toEqual([]);
    expect(body.mailboxes.find((m) => m.recipient === "w1")!.unread).toBe(1);
  });

  test("serves the self-contained page with no external assets", async () => {
    const res = await get(handler(), "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("/api/status");
    expect(html).toContain("/api/send");
    // No external CDN / asset references: the page must work with no internet.
    expect(html).not.toMatch(/https?:\/\/[^"' ]+\.(js|css)/);
    expect(html).not.toContain("cdn.");
  });
});

describe("relay web: POST /api/send validation", () => {
  test("rejects an empty message", async () => {
    registerWorker(db, "w1", { role: "worker" });
    const res = await post(handler(), "/api/send", { worker: "w1", message: "   " });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/message is required/);
    // Nothing durable was written.
    expect(db.query(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 0 });
  });

  test("rejects an unknown worker", async () => {
    const res = await post(handler(), "/api/send", { worker: "ghost", message: "hi" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown worker/);
    expect(db.query(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 0 });
  });

  test("rejects a flag-like body and an unknown kind", () => {
    expect(validateSend({ worker: "w", message: "--worker" })).toEqual({
      ok: false,
      error: 'refusing the flag-like message "--worker"',
    });
    expect(validateSend({ worker: "w", message: "hi", kind: "wat" }).ok).toBe(false);
    expect(validateSend({ worker: "w", message: "hi" })).toEqual({
      ok: true,
      value: { worker: "w", message: "hi", kind: "note" },
    });
  });

  test("valid send enqueues through the durable message path", async () => {
    registerWorker(db, "w1", { role: "worker" });
    const res = await post(handler(), "/api/send", { worker: "w1", message: "ping", kind: "urgent" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; recipient: string; kind: string };
    expect(body).toMatchObject({ ok: true, recipient: "w1", kind: "urgent" });
    const row = db.query(`SELECT sender, recipient, kind, payload, state FROM messages WHERE id = ?`).get(body.id) as {
      sender: string; recipient: string; kind: string; payload: string; state: string;
    };
    expect(row).toMatchObject({ recipient: "w1", kind: "urgent", payload: "ping", state: "queued" });
  });

  test("inbox lists pending mail read-only (does not flip queued -> delivered)", async () => {
    registerWorker(db, "w1", { role: "worker" });
    sendMessage(db, "human", "w1", "unread note");
    const res = await get(handler(), "/api/inbox?worker=w1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { worker: string; messages: { payload: string; state: string }[] };
    expect(body.messages.map((m) => m.payload)).toEqual(["unread note"]);
    // A read-only view must NOT acknowledge the mail (the nudge keeps firing).
    expect((db.query(`SELECT state FROM messages`).get() as { state: string }).state).toBe("queued");

    const missing = await get(handler(), "/api/inbox?worker=ghost");
    expect(missing.status).toBe(404);
  });
});

describe("relay web: auth gate", () => {
  test("no token configured: requests are open", async () => {
    const res = await get(handler({ token: null }), "/api/status");
    expect(res.status).toBe(200);
  });

  test("token configured: absent token is rejected, header or query accepted", async () => {
    registerWorker(db, "w1", { role: "worker" });
    const h = handler({ token: "s3cret" });
    expect((await get(h, "/api/status")).status).toBe(401);
    expect((await get(h, "/api/status", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await get(h, "/api/status", { authorization: "Bearer s3cret" })).status).toBe(200);
    expect((await get(h, "/api/status?token=s3cret")).status).toBe(200);
    expect((await post(h, "/api/send", { worker: "w1", message: "hi" })).status).toBe(401);
    expect(
      (await post(h, "/api/send", { worker: "w1", message: "hi" }, { authorization: "Bearer s3cret" })).status
    ).toBe(200);
  });

  test("isAuthorized is a pure gate", () => {
    const withToken = new Request("http://x/?token=abc");
    expect(isAuthorized(withToken, new URL(withToken.url), "abc")).toBe(true);
    expect(isAuthorized(withToken, new URL(withToken.url), "zzz")).toBe(false);
    expect(isAuthorized(withToken, new URL(withToken.url), null)).toBe(true);
  });
});

describe("relay web: host classification", () => {
  test("loopback addresses are recognized; tailnet binds are not", () => {
    for (const h of ["127.0.0.1", "127.0.0.5", "localhost", "::1"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "100.64.0.1", "relay.tailnet.ts.net"]) expect(isLoopbackHost(h)).toBe(false);
  });
});
