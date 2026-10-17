---
name: network-lab
description: Deploy, inspect, exec into and destroy an arbitrary containerlab topology on the shared Network Lab with `labctl`. Use for any network E2E (routing/switching/VPN, NOS config, gNMI/SSH observations) — you may bring your own topology or reuse an existing one.
---

# network-lab

Run a **real, arbitrary** containerlab topology from this Coding Sandbox using the
`labctl` CLI. You own the topology: create a new one, or copy and adapt an
existing one from the repo. `labctl` is a thin client for the shared Lab's
`clab-api-server`; it starts NOS containers on the shared Lab VM. The NOS image
cache already lives on the Lab — never copy an image yourself.

## Owner identifier (required)

Every lab you deploy belongs to **this task**. Relay exports a stable owner id:

```sh
: "${RELAY_LAB_OWNER:?RELAY_LAB_OWNER is not set — you are not running as a Relay task}"
```

`labctl` reads the containerlab `name:` **verbatim** — it does not expand shell
variables when it resolves the lab name — so **write the owner id into the
topology before deploying**. Do not leave a literal `$RELAY_LAB_OWNER` in the
file (the API rejects it: `400 Invalid characters in lab name`):

```yaml
# mylab/mylab.clab.yml — the name is the resolved owner id, e.g. netlab-T17
name: netlab-agent845
topology:
  nodes:
    srl1:
      kind: nokia_srlinux
      image: ghcr.io/nokia/srlinux:latest
      type: ixrd3
```

Resolve it in a scripted step, e.g.:

```sh
sed -i "s/@OWNER@/$RELAY_LAB_OWNER/g" mylab/mylab.clab.yml   # or: envsubst < tmpl > mylab/mylab.clab.yml
```

Use the **same** owner value as `--namespace`, so the lab directory
(`<owner>/netlab-<owner>`) and the lab identity are both task-scoped:

```sh
labctl deploy -t mylab/mylab.clab.yml --namespace "$RELAY_LAB_OWNER"
```

Never reuse another task's namespace, and never use a fixed lab name: two tasks
with the same `name:` collide at the containerlab level (fail-closed `exit 6`,
never an overwrite).

## Run it

Credentials come from the environment (the operator injects them at runtime —
never hard-code a secret):

```sh
: "${LABCTL_USER:?}"                # or reuse a JWT via LABCTL_TOKEN
: "${LABCTL_PASSWORD:?}"            # or a --password-file
API="${LABCTL_API:?}"               # e.g. https://host.docker.internal:49170

labctl deploy  -t mylab/mylab.clab.yml --namespace "$RELAY_LAB_OWNER" \
               --api "$API" --insecure --json
labctl inspect "netlab-$RELAY_LAB_OWNER" --json --reach-host host.docker.internal \
               --api "$API" --insecure
labctl exec    --api "$API" --insecure "netlab-$RELAY_LAB_OWNER/srl1" -- sr_cli show version
labctl destroy --name "netlab-$RELAY_LAB_OWNER" --api "$API" --insecure --json
```

`--api`, `--user`, `--password-file`, `--insecure`, `--ca-cert`, `--timeout`
and `--json` are **per-subcommand** options, not global: `labctl --insecure
deploy …` fails with `unrecognized arguments`. Put them **after** the
subcommand. For `exec`, put them **before** `<lab>/<node>` — everything after
`--` is the remote command. `destroy` takes `--name <lab>` (there is no
`--namespace`); use `--insecure` (PoC) or `--ca-cert <file>` for the Lab's
self-signed certificate.

## Topology and assets

- Put the `.clab.yml` and every file it references (`binds`, `startup-config`,
  `certificate`, `license`, `banner`) in **one directory**; `deploy -t DIR/x.clab.yml`
  transfers that whole directory. Assets referenced with an absolute path, a
  `..` escape, or a missing file are refused (`exit 3`) — never half-deployed.
- Relative paths inside the topology resolve against the topology file's
  directory on the Lab, so keep the directory self-contained.
- You may use **any** topology. There is no required lab: build the smallest one
  that exercises the behaviour under test.

## Endpoints

`inspect --json` emits each node's management endpoints with a
`reachable_at` string (already resolved for this sandbox), e.g.:

```json
{ "nodes": [ { "node": "srl1", "state": "running",
   "mgmt_endpoints": [
     { "protocol": "tcp", "container_port": 22,    "host_port": 18021, "reachable_at": "host.docker.internal:18021" },
     { "protocol": "tcp", "container_port": 57400, "host_port": 18011, "reachable_at": "host.docker.internal:18011" } ] } ],
  "remote_dir": "<owner>/netlab-<owner>" }
```

Connect to the **exact** `reachable_at` string — never assume a port. A node
with no `ports:` mapping has no management endpoint; add one to the node in your
topology and re-deploy a fresh lab, or reach the node with `labctl exec`.

## Record the result

Write the network E2E result as evidence: the topology used, the `deploy` and
`inspect --json` output, the exact commands you ran (`labctl exec`, `gnmic`,
`ssh`), their output, and the destroy result. Commit it with the change so the
verification step can see what was actually observed.

## Destroy and failure reporting

- **Always destroy your lab when done** (unless a later step keeps using it):
  `labctl destroy --name "netlab-$RELAY_LAB_OWNER" …`.
- `destroy` never removes NOS images — the shared image cache is reused across
  tasks. Do **not** manage images: no `docker pull`, no manual image copy into
  the Lab, no host Docker access.
- On failure, report the exact `labctl` exit code and stderr:
  `3` bad bundle, `4` auth failed, `5` API/transfer error, `6` lab/namespace
  already exists, `7` client timeout, `8` partial create. Never treat a
  non-zero exit as success.
- If a deploy timed out and left a workspace directory with no lab, remove it
  with `labctl purge "netlab-$RELAY_LAB_OWNER" --namespace "$RELAY_LAB_OWNER" …`.
- If you cannot reach the Lab at all, say so and stop — do not fabricate
  endpoints or observations.

Relay cleans up labs owned by this task when the task ends; keeping the owner id
above is what makes that cleanup precise (only this task's lab is destroyed).
