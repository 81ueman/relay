import { describe, expect, test } from "bun:test";
import {
  LAB_ERROR,
  LAB_EXISTS,
  LAB_FOREIGN,
  LAB_NOT_RUNNING,
  LAB_NO_ENDPOINTS,
  deployTaskLab,
  destroyTaskLab,
  foreignLabError,
  inspectTaskLab,
  labNameForTask,
  labNamespaceForTask,
  labctlDeployArgv,
  labctlDestroyArgv,
  labctlInspectArgv,
  ownsLab,
  parseLabInspect,
  redactSecrets,
  type Labctl,
  type LabctlResult,
} from "../src/lab";
import { labOwnerId } from "../src/lab-cleanup";

// ISH-829: the thin `labctl` seam. No real lab, no network — a fake Labctl
// returns canned stdout/exit codes so every fail-closed branch is exercised.

/** A fake labctl with queued results (shifted per call). */
class FakeLabctl implements Labctl {
  calls: string[][] = [];
  queue: LabctlResult[] = [];
  constructor(...results: LabctlResult[]) {
    this.queue = [...results];
  }
  private next(): LabctlResult {
    return this.queue.shift() ?? { ok: true, code: 0, out: "", err: "" };
  }
  async run(args: string[]): Promise<LabctlResult> {
    this.calls.push(args);
    return this.next();
  }
}

const task = { id: "t-abc", created_at: 1_700_000_000_000 };
const OWN = labNameForTask(task);

const inspectJson = (lab: string, nodes: unknown[]): string =>
  JSON.stringify({ api: "https://lab:8090", lab, remote_dir: `ns/${lab}`, nodeCount: nodes.length, nodes });

const runningNode = (node = "srl1") => ({
  node,
  container: `clab-${node}`,
  kind: "nokia_srlinux",
  state: "running",
  mgmt_ipv4: "172.20.20.3/24",
  mgmt_endpoints: [{ protocol: "tcp", container_port: 57400, host_port: 18011, host_ip: "0.0.0.0", reachable_at: "host.docker.internal:18011" }],
});

describe("lab identity + ownership", () => {
  test("labNameForTask uses the ISH-845 owner id (netlab-<id>-<created_at>)", () => {
    expect(labNameForTask(task)).toBe(`netlab-${labOwnerId(task)}`);
    expect(labNameForTask(task)).toBe(`netlab-${task.id}-${task.created_at}`);
    expect(labNamespaceForTask(task)).toBe(labOwnerId(task));
    expect(ownsLab(task, OWN)).toBe(true);
  });

  test("a Task only owns its own lab; a foreign lab is refused", () => {
    expect(ownsLab(task, "netlab-someone-else-9999")).toBe(false);
    expect(foreignLabError(task, OWN)).toBeNull();
    expect(foreignLabError(task, "netlab-someone-else-9999")).toContain(LAB_FOREIGN);
    expect(foreignLabError(task, null)).toContain(LAB_FOREIGN);
  });

  test("a reused id with a DIFFERENT created_at does NOT own the earlier Task's lab (ISH-845)", () => {
    const early = { id: "T7", created_at: 1000 };
    const later = { id: "T7", created_at: 2000 };
    expect(labNameForTask(early)).not.toBe(labNameForTask(later));
    // The later Task must not "own" (or be able to destroy) the earlier lab.
    expect(ownsLab(later, labNameForTask(early))).toBe(false);
    expect(foreignLabError(later, labNameForTask(early))).toContain(LAB_FOREIGN);
  });
});

describe("labctl argv (never a shell string)", () => {
  test("deploy/inspect/destroy carry --json + --api and no shell metacharacters", () => {
    const deploy = labctlDeployArgv({ topology: "labs/x.clab.yml", api: "https://lab:8090", namespace: "ish829", insecure: true });
    expect(deploy[0]).toBe("deploy");
    expect(deploy).toContain("-t");
    expect(deploy).toContain("--namespace");
    expect(deploy).toContain("--json");
    expect(deploy).toContain("--api");
    expect(deploy).toContain("--insecure");

    const inspect = labctlInspectArgv({ lab: OWN, api: "https://lab:8090", reachHost: "host.docker.internal" });
    expect(inspect.slice(0, 2)).toEqual(["inspect", OWN]);
    expect(inspect).toContain("--reach-host");

    const destroy = labctlDestroyArgv({ lab: OWN, api: "https://lab:8090" });
    expect(destroy.slice(0, 3)).toEqual(["destroy", "--name", OWN]);
  });
});

describe("parseLabInspect (fail closed)", () => {
  test("parses a real inspect blob", () => {
    const p = parseLabInspect(inspectJson(OWN, [runningNode("srl1"), runningNode("srl2")]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.inspect.lab).toBe(OWN);
    expect(p.inspect.nodeCount).toBe(2);
    expect(p.inspect.nodes[0].endpoints[0].reachableAt).toBe("host.docker.internal:18011");
  });

  test("malformed JSON / no lab / no nodes are errors, never an empty-ok", () => {
    expect(parseLabInspect("not json").ok).toBe(false);
    expect(parseLabInspect("{}").ok).toBe(false);
    expect(parseLabInspect(JSON.stringify({ lab: "x", nodes: "nope" })).ok).toBe(false);
    const empty = parseLabInspect(JSON.stringify({ lab: "x", nodes: [] }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain(LAB_NOT_RUNNING);
  });
});

describe("deployTaskLab", () => {
  const okDeploy = (lab = OWN) => ({ lab, nodes: [{ nodeName: "srl1", state: "running" }], transferred: {} });

  test("a fully-running deploy of the Task's OWN lab is ok", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: JSON.stringify(okDeploy()), err: "" });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(true);
    expect(r.lab).toBe(OWN);
  });

  test("a REAL partial create (labctl exit 8, no stdout JSON) fails closed WITH the lab name set, so the caller can destroy it", async () => {
    const lc = new FakeLabctl({
      ok: false,
      code: 8,
      out: "",
      err: `labctl: lab '${OWN}' deployed but not every node is running (partial create)`,
    });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_NOT_RUNNING);
    expect(r.lab).toBe(OWN); // never a leak: the deterministic name is reported
  });

  test("a client TIMEOUT reports the deterministic lab name (server may still be deploying)", async () => {
    const lc = new FakeLabctl({ ok: false, code: null, out: "", err: "", timedOut: true });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.lab).toBe(OWN);
  });

  test("labctl EXIT_TIMEOUT (7) reports the deterministic lab name (a lab may appear after the client gave up)", async () => {
    const lc = new FakeLabctl({ ok: false, code: 7, out: "", err: "labctl: request timed out after 30s: …" });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(7);
    expect(r.lab).toBe(OWN); // never a leak: the caller destroys this name
  });

  test("an EXISTING lab (exit 6) reports the name so it can be reclaimed", async () => {
    const lc = new FakeLabctl({ ok: false, code: 6, out: "", err: "lab already exists" });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_EXISTS);
    expect(r.lab).toBe(OWN);
  });

  test("a synthetic JSON partial result (a node not running) also fails closed with the name set", async () => {
    const lc = new FakeLabctl({
      ok: true,
      code: 0,
      out: JSON.stringify({ lab: OWN, nodes: [{ nodeName: "srl1", state: "running" }, { nodeName: "srl2", state: "exited" }] }),
      err: "",
    });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_NOT_RUNNING);
    expect(r.lab).toBe(OWN);
  });

  test("an auth/API error (creates nothing) reports NO lab name", async () => {
    const lc = new FakeLabctl({ ok: false, code: 5, out: "", err: "connection refused" });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(5);
    expect(r.lab).toBeNull();
  });

  test("non-JSON deploy output fails closed (no invented lab)", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: "lab is up :)", err: "" });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_ERROR);
  });

  test("a deploy that lands under a FOREIGN lab is refused AND torn down", async () => {
    const lc = new FakeLabctl(
      { ok: true, code: 0, out: JSON.stringify(okDeploy("netlab-someone-else-9999")), err: "" },
      { ok: true, code: 0, out: "", err: "" } // the teardown destroy
    );
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_FOREIGN);
    // The foreign lab was destroyed (never left running).
    expect(lc.calls.some((a) => a[0] === "destroy" && a.includes("netlab-someone-else-9999"))).toBe(true);
  });
});

describe("inspectTaskLab", () => {
  test("a running lab with an endpoint is ok", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson(OWN, [runningNode()]), err: "" });
    const r = await inspectTaskLab(lc, task, { lab: OWN, api: "https://lab:8090" });
    expect(r.ok).toBe(true);
  });

  test("a node that is not running fails closed", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson(OWN, [{ node: "srl1", state: "exited" }]), err: "" });
    const r = await inspectTaskLab(lc, task, { lab: OWN, api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(LAB_NOT_RUNNING);
  });

  test("no reachable management endpoint fails closed when required", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson(OWN, [{ node: "srl1", state: "running", mgmt_endpoints: [] }]), err: "" });
    const r = await inspectTaskLab(lc, task, { lab: OWN, api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(LAB_NO_ENDPOINTS);
  });

  test("an inspect transport error fails closed", async () => {
    const lc = new FakeLabctl({ ok: false, code: 5, out: "", err: "connection refused" });
    const r = await inspectTaskLab(lc, task, { lab: OWN, api: "https://lab:8090" });
    expect(r.ok).toBe(false);
  });

  test("an inspect naming a DIFFERENT lab is refused", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson("someone-else", [runningNode()]), err: "" });
    const r = await inspectTaskLab(lc, task, { lab: OWN, api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(LAB_FOREIGN);
  });

  test("a FOREIGN lab name is refused and labctl is NEVER invoked", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson("netlab-other-task-9999", [runningNode()]), err: "" });
    const r = await inspectTaskLab(lc, task, { lab: "netlab-other-task-9999", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(LAB_FOREIGN);
    expect(lc.calls).toHaveLength(0);
  });
});

describe("destroyTaskLab", () => {
  test("a successful destroy of the OWN lab is ok", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: "", err: "" });
    const r = await destroyTaskLab(lc, task, { lab: OWN, api: "https://lab:8090" });
    expect(r.ok).toBe(true);
  });

  test("a failed destroy is reported (never swallowed)", async () => {
    const lc = new FakeLabctl({ ok: false, code: 5, out: "", err: "api down" });
    const r = await destroyTaskLab(lc, task, { lab: OWN, api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("api down");
  });

  test("a FOREIGN lab name is refused and labctl is NEVER invoked", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: "", err: "" });
    const r = await destroyTaskLab(lc, task, { lab: "netlab-other-task-9999", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_FOREIGN);
    expect(lc.calls).toHaveLength(0);
  });
});

describe("redactSecrets", () => {
  test("strips bearer tokens, password values and JWTs", () => {
    const s = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def and password="hunter2"');
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(s).toContain("<redacted");
  });
});
