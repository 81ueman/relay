import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ISH-845: the `network-lab` skill has exactly one source of truth:
// `skills/network-lab/SKILL.md`.

const repo = join(import.meta.dir, "..");
const source = join(repo, "skills", "network-lab", "SKILL.md");

describe("network-lab skill", () => {
  test("frontmatter has the name/description dsh requires", () => {
    const body = readFileSync(source, "utf8");
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toMatch(/^name: network-lab$/m);
    expect(body).toMatch(/^description: .+/m);
  });

  test("the skill presses the Task owner contract and forbids image/host-Docker work", () => {
    const body = readFileSync(source, "utf8");
    expect(body).toContain("RELAY_LAB_OWNER");
    expect(body).toContain("--namespace");
    expect(body).toContain("labctl deploy");
    expect(body).toContain("labctl inspect");
    expect(body).toContain("labctl destroy");
    expect(body).toContain("reachable_at");
    // It must NOT instruct manual image copies or host Docker access: no line
    // (inside or outside a code block) may *start* with a bare `docker …` verb.
    for (const line of body.split("\n")) {
      expect(line.trimStart()).not.toMatch(/^docker /);
    }
    expect(body).toContain("host Docker access");
  });
});
