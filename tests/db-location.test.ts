import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDbMove,
  configPath,
  controlPlaneRoot,
  isLegacyLocation,
  planDbMove,
  projectId,
  readConfig,
  resolveDb,
} from "../src/db-location";
import { outsideRepoDefault } from "../src/db";

// T332: control-plane DB location. The resolution order is
//   RELAY_DB > config.json > legacy <repo>/.relay/state.db > XDG default
// and the XDG default lives OUTSIDE any repo. These tests use isolated temp
// roots + a fake HOME, so they never touch a real control plane.

let root = "";
let home = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-dbloc-"));
  home = mkdtempSync(join(tmpdir(), "relay-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A fake checkout with a legacy `.relay/state.db`. */
function legacyRepo(): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".relay"), { recursive: true });
  writeFileSync(join(repo, ".relay", "state.db"), "");
  return repo;
}

describe("DB resolution order (T332)", () => {
  test("RELAY_DB wins over everything", () => {
    const repo = legacyRepo();
    const r = resolveDb({ dir: repo, env: { RELAY_DB: "/explicit/state.db" }, home });
    expect(r).toEqual({ path: "/explicit/state.db", source: "env" });
  });

  test("config.json wins over the legacy in-repo DB", () => {
    const repo = legacyRepo();
    const r = resolveDb({ dir: repo, env: {}, home, config: { db: "/cfg/state.db" } });
    expect(r).toEqual({ path: "/cfg/state.db", source: "config" });
  });

  test("a legacy in-repo DB wins over the XDG default (backward compatible)", () => {
    const repo = legacyRepo();
    const r = resolveDb({ dir: repo, env: {}, home });
    expect(r.source).toBe("legacy");
    expect(r.path).toBe(join(repo, ".relay", "state.db"));
  });

  test("a legacy DB is found from a SUBDIRECTORY too (no split ledger)", () => {
    const repo = legacyRepo();
    const deep = join(repo, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(resolveDb({ dir: deep, env: {}, home }).source).toBe("legacy");
  });

  test("with no legacy/config/env the default is OUTSIDE the repo", () => {
    const bare = join(root, "fresh");
    mkdirSync(bare, { recursive: true });
    const r = resolveDb({ dir: bare, env: {}, home });
    expect(r.source).toBe("xdg");
    expect(r.path.startsWith(join(home, ".local", "state"))).toBe(true);
    expect(r.path.includes(`${join(bare)}`)).toBe(false); // not inside the project dir
  });

  test("a project ANCHOR makes subdirectories stable (no split ledger)", () => {
    // With a `.git` or `.relay` anchor, the id follows the ANCHOR, not the cwd.
    const proj = join(root, "anchored");
    mkdirSync(join(proj, ".relay"), { recursive: true });
    // No state.db, so the legacy branch does not apply — but the anchor still
    // fixes the project root for the XDG default.
    rmSync(join(proj, ".relay"), { recursive: true, force: true });
    mkdirSync(join(proj, ".git"), { recursive: true });
    const deep = join(proj, "x", "y");
    mkdirSync(deep, { recursive: true });
    const rootPath = resolveDb({ dir: proj, env: {}, home }).path;
    expect(resolveDb({ dir: deep, env: {}, home }).path).toBe(rootPath);
    expect(projectId(controlPlaneRoot(proj))).toBe(projectId(controlPlaneRoot(deep)));
  });

  test("RELATIVE_REPO: XDG_STATE_HOME / XDG_CONFIG_HOME are honored", () => {
    const bare = join(root, "fresh2");
    mkdirSync(bare, { recursive: true });
    const xdgState = join(root, "xdg-state");
    const r = resolveDb({ dir: bare, env: { XDG_STATE_HOME: xdgState }, home });
    expect(r.path.startsWith(xdgState)).toBe(true);
    expect(configPath({ XDG_CONFIG_HOME: join(root, "xdg-cfg") }, home))
      .toBe(join(root, "xdg-cfg", "relay", "config.json"));
  });

  test("configPath honors RELAY_CONFIG", () => {
    expect(configPath({ RELAY_CONFIG: "/custom/c.json" }, home)).toBe("/custom/c.json");
  });

  test("readConfig throws a clear error on malformed JSON", () => {
    const p = join(root, "bad.json");
    writeFileSync(p, "{ not json");
    expect(() => readConfig(p)).toThrow(/not valid JSON/);
  });

  test("projectId is a slug + hash of the ROOT, stable and unique", () => {
    const a = join(root, "proj-a", "repo");
    const b = join(root, "proj-b", "repo");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    expect(projectId(a)).toBe(projectId(a));      // deterministic
    expect(projectId(a)).not.toBe(projectId(b));  // same name, different path
    expect(projectId(a)).toMatch(/^repo-[0-9a-f]{12}$/);
  });

  test("outsideRepoDefault returns the XDG path for a directory", () => {
    const bare = join(root, "fresh3");
    mkdirSync(bare, { recursive: true });
    expect(outsideRepoDefault(bare)).toEndWith("/state.db");
  });

  test("isLegacyLocation detects the in-repo `.relay` layout", () => {
    expect(isLegacyLocation("/some/repo/.relay/state.db")).toBe(true);
    expect(isLegacyLocation("/home/u/.local/state/relay/x/state.db")).toBe(false);
  });
});

describe("relay db move (T332)", () => {
  test("planDbMove is pure and lists the sidecar files that exist", () => {
    const repo = legacyRepo();
    const from = join(repo, ".relay", "state.db");
    writeFileSync(`${from}-wal`, "");
    const to = join(root, "dest", "state.db");
    const plan = planDbMove(from, to);
    expect(plan.sourceExists).toBe(true);
    expect(plan.destinationExists).toBe(false);
    expect(plan.files).toContain(from);
    expect(plan.files).toContain(`${from}-wal`);
    // Pure: nothing moved.
    expect(existsSync(from)).toBe(true);
    expect(existsSync(to)).toBe(false);
  });

  test("applyDbMove refuses to overwrite an existing destination", () => {
    const repo = legacyRepo();
    const from = join(repo, ".relay", "state.db");
    const to = join(root, "dest", "state.db");
    mkdirSync(join(root, "dest"), { recursive: true });
    writeFileSync(to, "existing ledger");
    expect(() => applyDbMove(planDbMove(from, to))).toThrow(/refusing to overwrite/);
    // The source is untouched by the refusal.
    expect(existsSync(from)).toBe(true);
  });

  test("applyDbMove refuses while a live socket is present", () => {
    const repo = legacyRepo();
    // A plain file standing in for the socket: presence alone must refuse.
    writeFileSync(join(repo, ".relay", "relay.sock"), "");
    const from = join(repo, ".relay", "state.db");
    const to = join(root, "dest", "state.db");
    expect(() => applyDbMove(planDbMove(from, to))).toThrow(/daemon may be live/);
    expect(existsSync(from)).toBe(true);
  });

  test("applyDbMove moves the DB (and sidecars) out of the repo", () => {
    const repo = legacyRepo();
    const from = join(repo, ".relay", "state.db");
    writeFileSync(`${from}-wal`, "wal");
    const to = join(root, "dest", "state.db");
    const moved = applyDbMove(planDbMove(from, to));
    expect(moved.length).toBe(2);
    expect(existsSync(to)).toBe(true);
    expect(existsSync(from)).toBe(false);
    // The destination is now resolvable as an explicit config DB.
    expect(resolveDb({ dir: repo, env: {}, home, config: { db: to } }).path).toBe(to);
  });

  test("applyDbMove errors on a missing source", () => {
    expect(() => applyDbMove(planDbMove(join(root, "nope", "state.db"), join(root, "d", "state.db"))))
      .toThrow(/no control-plane DB/);
  });
});
