#!/usr/bin/env bun
// T338: build the CLI bundle with the source revision embedded, so the installed
// artifact can report which revision it is (`relay --version`) and warn when it
// is behind repo HEAD. The define values are JSON-encoded strings.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() || "dev";
  } catch {
    return "dev";
  }
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
const commit = gitSha();
const version = pkg.version ?? "dev";

const args = [
  "bun", "build", "src/cli.ts",
  "--outdir", "dist",
  "--target", "bun",
  "--define", `BUILD_COMMIT=${JSON.stringify(commit)}`,
  "--define", `RELAY_VERSION=${JSON.stringify(version)}`,
];

const r = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`built dist/cli.js (version ${version}, commit ${commit})`);
