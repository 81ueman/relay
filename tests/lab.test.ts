import { describe, expect, test } from "bun:test";
import {
  LAB_ERROR,
  LAB_FOREIGN,
  LAB_NOT_RUNNING,
  LAB_NO_ENDPOINTS,
  deployTaskLab,
  destroyTaskLab,
  foreignLabError,
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

const task = { id: "t-abc", issue_id: "ISH-829" };
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
  test("labNameForTask is stable and Task-id-derived", () => {
    expect(labNameForTask(task)).toBe(labNameForTask({ ...task }));
    expect(labNameForTask(task)).toContain("relay-");
    expect(labNameForTask(task)).not.toBe(labNameForTask({ id: "t-other", issue_id: "ISH-829" }));
  });

  test("a Task only owns its own lab; a foreign lab is refused", () => {
    expect(ownsLab(task, OWN)).toBe(true);
    expect(ownsLab(task, "relay-someone-else-deadbeef")).toBe(false);
    expect(foreignLabError(task, OWN)).toBeNull();
    expect(foreignLabError(task, "relay-someone-else-deadbeef")).toContain(LAB_FOREIGN);
    expect(foreignLabError(task, null)).toContain(LAB_FOREIGN);
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

  test("a partial create (a node not running) fails closed", async () => {
    const lc = new FakeLabctl({
      ok: true,
      code: 8,
      out: JSON.stringify({ lab: OWN, nodes: [{ nodeName: "srl1", state: "running" }, { nodeName: "srl2", state: "exited" }] }),
      err: "",
    });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_NOT_RUNNING);
  });

  test("an API/transport error or a bad exit fails closed", async () => {
    const lc = new FakeLabctl({ ok: false, code: 5, out: "", err: "lab 'x' already exists" });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(5);
  });

  test("a timeout fails closed", async () => {
    const lc = new FakeLabctl({ ok: false, code: null, out: "", err: "", timedOut: true });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out");
  });

  test("non-JSON deploy output fails closed (no invented lab)", async () => {
    const lc = new FakeLabctl({ ok: true, code: 0, out: "lab is up :)", err: "" });
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_ERROR);
  });

  test("a deploy that lands under a FOREIGN lab is refused AND torn down", async () => {
    const lc = new FakeLabctl(
      { ok: true, code: 0, out: JSON.stringify(okDeploy("relay-someone-else-deadbeef")), err: "" },
      { ok: true, code: 0, out: "", err: "" } // the teardown destroy
    );
    const r = await deployTaskLab(lc, task, { topology: "t.clab.yml", api: "https://lab:8090" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(LAB_FOREIGN);
    // The foreign lab was destroyed (never left running).
    expect(lc.calls.some((a) => a[0] === "destroy" && a.includes("relay-someone-else-deadbeef"))).toBe(true);
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
    const lc = new FakeLabctl({ ok: true, code: 0, out: inspectJson("relay-other-task-ffffffff", [runningNode()]), err: "" });
    const r = await inspectTaskLab(lc, task, { lab: "relay-other-task-ffffffff", api: "https://lab:8090" });
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
    const r = await destroyTaskLab(lc, task, { lab: "relay-other-task-ffffffff", api: "https://lab:8090" });
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
