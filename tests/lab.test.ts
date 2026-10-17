import { describe, expect, test } from "bun:test";
import {
  LAB_ERROR,
  LAB_FOREIGN,
  LAB_NOT_RUNNING,
  LAB_NO_ENDPOINTS,
  assertOwnLab,
  deployTaskLab,
  destroyTaskLab,
  inspectTaskLab,
  labNameForTask,
  labctlDeployArgv,
  labctlDestroyArgv,
  labctlInspectArgv,
  ownsLab,
  parseLabInspect,
  redactSecrets,
  type Labctl,
  type LabctlResult,
} from "../src/lab";

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

const task = { id: "t-abc", issue_id: "ISH-829" };

describe("lab identity + ownership", () => {
  test("labNameForTask is stable and Task-id-derived", () => {
    const a = labNameForTask(task);
    expect(a).toBe(labNameForTask({ ...task }));
    expect(a).toContain("relay-");
    expect(a).not.toBe(labNameForTask({ id: "t-other", issue_id: "ISH-829" }));
  });

  test("a Task only owns its own lab; a foreign lab is refused", () => {
    const own = labNameForTask(task);
    expect(ownsLab(task, own)).toBe(true);
    expect(ownsLab(task, "relay-someone-else-deadbeef")).toBe(false);
    expect(() => assertOwnLab(task, "relay-someone-else-deadbeef")).toThrow(LAB_FOREIGN);
    expect(() => assertOwnLab(task, null)).toThrow(LAB_FOREIGN);
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

    const inspect = labctlInspectArgv({ lab: "labctl-srl2", api: "https://lab:8090", reachHost: "host.docker.internal" });
    expect(inspect.slice(0, 2)).toEqual(["inspect", "labctl-srl2"]);
    expect(inspect).toContain("--reach-host");

    const destroy = labctlDestroyArgv({ lab: "labctl-srl2", api: "https://lab:8090" });
    expect(destroy.slice(0, 3)).toEqual(["destroy", "--name", "labctl-srl2"]);
  });
});

describe("parseLabInspect (fail closed)", () => {
  test("parses a real inspect blob", () => {
    const p = parseLabInspect(inspectJson("labctl-srl2", [runningNode("srl1"), runningNode("srl2")]));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.inspect.lab).toBe("labctl-srl2");
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
  const okDeploy = { lab: "labctl-srl2", nodes: [{ nodeName: "srl1", state: "running" }], transferred: {} };

  test("a fully-running deploy is ok", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: JSON.stringify(okDeploy), err: "" });
    const r = await deployTaskLab(lc, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(true);
    expect(r.lab).toBe("labctl-srl2");
  });

  test("a partial create (a node not running) fails closed", async () => {
    const lc = new FakeLabctl({
      ok: true,
      code: 8,
      out: JSON.stringify({ lab: "labctl-srl2", nodes: [{ nodeName: "srl1", state: "running" }, { nodeName: "srl2", state: "exited" }] }),
      err: "",
    });
    const r = await deployTaskLab(lc, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_NOT_RUNNING);
  });

  test("an API/transport error or a bad exit fails closed", async () => {
    const lc = new FakeLabctl({ ok: false, code: 5, out: "", err: "lab 'x' already exists" });
    const r = await deployTaskLab(lc, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(5);
  });

  test("a timeout fails closed", async () => {
    const lc = new FakeLabctl({ ok: false, code: null, out: "", err: "", timedOut: true });
    const r = await deployTaskLab(lc, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out");
  });

  test("non-JSON deploy output fails closed (no invented lab)", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: "lab is up :)", err: "" });
    const r = await deployTaskLab(lc, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_ERROR);
  });
});

describe("inspectTaskLab", () => {
  test("a running lab with an endpoint is ok", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson("labctl-srl2", [runningNode()]), err: "" });
    const r = await inspectTaskLab(lc, { lab: "labctl-srl2", api: "https://lab:8090" });
    expect(r.ok).toBe(true);
  });

  test("a node that is not running fails closed", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson("labctl-srl2", [{ node: "srl1", state: "exited" }]), err: "" });
    const r = await inspectTaskLab(lc, { lab: "labctl-srl2", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(LAB_NOT_RUNNING);
  });

  test("no reachable management endpoint fails closed when required", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson("labctl-srl2", [{ node: "srl1", state: "running", mgmt_endpoints: [] }]), err: "" });
    const r = await inspectTaskLab(lc, { lab: "labctl-srl2", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(LAB_NO_ENDPOINTS);
  });

  test("an inspect transport error fails closed", async () => {
    const lc = new FakeLabctl({ ok: false, code: 5, out: "", err: "connection refused" });
    const r = await inspectTaskLab(lc, { lab: "labctl-srl2", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
  });

  test("an inspect naming a DIFFERENT lab is refused", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson("someone-else", [runningNode()]), err: "" });
    const r = await inspectTaskLab(lc, { lab: "labctl-srl2", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(LAB_FOREIGN);
  });
});

describe("destroyTaskLab", () => {
  test("a successful destroy is ok", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: "", err: "" });
    const r = await destroyTaskLab(lc, { lab: "labctl-srl2", api: "https://lab:8090" });
    expect(r.ok).toBe(true);
  });

  test("a failed destroy is reported (never swallowed)", async () => {
    const lc = new FakeLabctl({ ok: false, code: 5, out: "", err: "api down" });
    const r = await destroyTaskLab(lc, { lab: "labctl-srl2", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("api down");
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
