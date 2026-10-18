import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ISH-830c: the Coding Kit provisions the sandbox's dsh `headless` profile so a
// headless Run resolves the `ollama-cloud` provider (authenticated by the
// operator's `sbx` credential proxy) instead of the shipped `deepseek-official`
// route. The pinned `@deepseek-ai/dsh@0.2.1-rc.2` npm build ships no
// `ollama-cloud` catalog, so the provider is declared explicitly. The kit must
// never carry a key value or a `DEEPSEEK_API_KEY` fallback: the credential is
// operator-side (`sbx secret`). This test fails if the profile drifts or a
// secret path creeps back in.

const repo = join(import.meta.dir, "..");
const kit = join(repo, "sandbox", "coding-kit");
const profileDir = join(kit, "files", "home", ".dsh", "profiles", "headless");

function read(rel: string): string {
  return readFileSync(join(profileDir, rel), "utf8");
}

/** Every file under the kit (recursively), as [relative path, contents]. */
function kitFiles(dir = kit): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...kitFiles(p));
    else out.push([p.slice(kit.length + 1), readFileSync(p, "utf8")]);
  }
  return out;
}

describe("Coding Kit dsh headless profile (ISH-830c)", () => {
  test("ships the four-file profile next to the bundles", () => {
    // The profile root is an empty entry list (comments only + `[]`).
    expect(read("cordis.yml").trim().endsWith("[]")).toBe(true);
    expect(read("cordis.yml")).not.toMatch(/^- /m);
    expect(read("cordis.patch.yml")).toContain("@deepseek-ai/dsh-llm-pi-ai");
    expect(JSON.parse(read("package.json"))).toEqual({
      name: "dsh-profile-headless",
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
    });
    expect(read("pnpm-workspace.yaml")).toContain("packages:");
  });

  test("routes the default model at ollama-cloud via OLLAMA_CLOUD_V41_API_KEY", () => {
    const patch = read("cordis.patch.yml");
    // The pinned npm build has no `ollama-cloud` catalog, so the provider is
    // declared explicitly: an OpenAI-compatible endpoint + the pinned model id.
    expect(patch).toMatch(
      /- id: llm-pi-ai\n  name: "@deepseek-ai\/dsh-llm-pi-ai"\n  config:\n    providers:\n      ollama-cloud:\n        apiKeyEnv: OLLAMA_CLOUD_V41_API_KEY\n        api: openai-completions\n        baseURL: https:\/\/ollama\.com\/v1\n        models:\n          - id: deepseek-v4\.1-flash:1017\n/
    );
    expect(patch).toMatch(
      /- id: agent-default-model\n  name: "@deepseek-ai\/dsh-agent-default-model"\n  config:\n    provider: ollama-cloud\n    model: deepseek-v4\.1-flash:1017\n/
    );
    expect(patch).not.toContain("deepseek-official");
    expect(patch).not.toContain("DEEPSEEK_API_KEY");
  });

  test("carries no secret value and no DEEPSEEK_API_KEY fallback", () => {
    for (const [rel, body] of kitFiles()) {
      expect(`${rel}: ${body}`).not.toContain("DEEPSEEK_API_KEY");
      expect(`${rel}: ${body}`).not.toMatch(/^secrets:/m);
    }
  });

  test("the kit still pins the ISH-869 dsh build", () => {
    const spec = readFileSync(join(kit, "spec.yaml"), "utf8");
    expect(spec).toContain("@deepseek-ai/dsh@0.2.1-rc.2");
    expect(spec).toContain("files/home/.dsh/profiles/headless");
  });
});
