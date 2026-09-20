import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDbPath, defaultSockPath, STATE_DIR } from "../src/db";

// A relay command run from a subdirectory must reuse the checkout's control
// plane instead of silently creating a SECOND `.relay/state.db` there.

let dir = "";
const savedDb = process.env.RELAY_DB;
const savedSock = process.env.RELAY_SOCK;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-dbpath-"));
  delete process.env.RELAY_DB;
  delete process.env.RELAY_SOCK;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedDb === undefined) delete process.env.RELAY_DB;
  else process.env.RELAY_DB = savedDb;
  if (savedSock === undefined) delete process.env.RELAY_SOCK;
  else process.env.RELAY_SOCK = savedSock;
});

describe("control-plane discovery", () => {
  test("a subdirectory reuses the existing .relay above it", () => {
    mkdirSync(join(dir, STATE_DIR), { recursive: true });
    writeFileSync(join(dir, STATE_DIR, "state.db"), "");
    const sub = join(dir, "nvintent", "src");
    mkdirSync(sub, { recursive: true });
    expect(defaultDbPath(sub)).toBe(join(dir, STATE_DIR, "state.db"));
    expect(defaultDbPath(join(dir, "nvintent"))).toBe(join(dir, STATE_DIR, "state.db"));
  });

  test("with no existing control plane it falls back to cwd (init)", () => {
    expect(defaultDbPath(dir)).toBe(join(dir, STATE_DIR, "state.db"));
  });

  test("the socket sits beside the resolved DB, not cwd", () => {
    mkdirSync(join(dir, STATE_DIR), { recursive: true });
    writeFileSync(join(dir, STATE_DIR, "state.db"), "");
    const sub = join(dir, "deep", "er");
    mkdirSync(sub, { recursive: true });
    expect(defaultSockPath(sub)).toBe(join(dir, STATE_DIR, "relay.sock"));
  });

  test("RELAY_DB/RELAY_SOCK still win", () => {
    process.env.RELAY_DB = join(dir, "custom.db");
    expect(defaultDbPath(dir)).toBe(join(dir, "custom.db"));
    expect(defaultSockPath(dir)).toBe(join(dir, "relay.sock"));
    process.env.RELAY_SOCK = join(dir, "custom.sock");
    expect(defaultSockPath(dir)).toBe(join(dir, "custom.sock"));
  });
});
