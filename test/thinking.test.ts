import { describe, expect, it } from "vitest";
import { buildReadOnlyArgs, type PiReadOnlyPromptOptions } from "../src/bridge/pi/PiReadOnlyPrompt";
import { normalizeThinking, resolveThinking, supportedThinkingLevels } from "../src/bridge/pi/thinking";

const model = { provider: "ollama", id: "gpt-oss:20b", reasoning: true };

describe("thinking controls", () => {
  it("limits GPT-OSS to its three effort levels", () => {
    expect(supportedThinkingLevels(model)).toEqual(["low", "medium", "high"]);
    expect(resolveThinking("off", model)).toBe("medium");
    expect(resolveThinking("high", model)).toBe("high");
  });

  it("requires an explicit Ollama off mapping and respects unsupported levels", () => {
    expect(supportedThinkingLevels({ ...model, id: "qwen3.5:9b",
      thinkingLevelMap: { off: "none", low: null, medium: null }
    })).toEqual(["off", "high"]);
    expect(supportedThinkingLevels({ ...model, reasoning: false })).toEqual([]);
    expect(resolveThinking("high", undefined)).toBe("default");
  });

  it("migrates missing, legacy default and invalid preferences to medium", () => {
    expect(normalizeThinking(undefined)).toBe("medium");
    expect(normalizeThinking("default")).toBe("medium");
    expect(normalizeThinking("arbitrary flag")).toBe("medium");
    expect(resolveThinking("default", model)).toBe("medium");
  });

  it("offers extra high only with explicit capability metadata", () => {
    expect(supportedThinkingLevels({ ...model, id: "custom", thinkingLevelMap: { xhigh: "max" } })).toContain("xhigh");
    expect(supportedThinkingLevels({ ...model, thinkingLevelMap: { xhigh: null } })).not.toContain("xhigh");
    expect(resolveThinking("xhigh", model)).toBe("medium");
  });

  it("overrides resumed session thinking without changing tool restrictions", () => {
    const options: Required<PiReadOnlyPromptOptions> = {
      executablePath: "pi", modelLabel: "ollama/gpt-oss:20b", prompt: "test",
      sessionPath: "/tmp/test-session.jsonl", workspaceRoot: "/tmp",
      timeoutMs: 1000, toolMode: "read-only", allowPiUserConfig: false, thinkingLevel: "high"
    };
    const args = buildReadOnlyArgs(options);
    expect(args).toContain("--no-extensions");
    expect(args).toContain("read,grep,find,ls");
    expect(args.slice(-2)).toEqual(["--thinking", "high"]);
    expect(buildReadOnlyArgs({ ...options, thinkingLevel: "default" })).not.toContain("--thinking");
  });
});
