import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Vault } from "obsidian";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { PiReadOnlyPromptRun } from "../src/bridge/pi/PiReadOnlyPrompt";
import { VaultToolHost } from "../src/agent/VaultToolHost";
import { createVaultStorage } from "../src/agent/obsidianVaultTools";

// Opt-in: real installed Pi + a deterministic local OpenAI-compatible provider.
// No Ollama models, cloud APIs, user vault, or user Pi configuration are used.
it.skipIf(!process.env.SIDEKICK_PI_INTEGRATION).each(["approve", "deny", "chat", "abort"])("real Pi round-trip: %s", async (scenario) => {
  const approve = scenario === "approve";
  const mode = scenario === "chat" ? "chat" : "reviewed";
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const dir = await mkdtemp(path.join(tmpdir(), "sidekick-integration-"));
  let run: PiReadOnlyPromptRun | undefined;
  let requests = 0;
  let modelSawResult: unknown;
  let advertisedTools: string[] = [];
  const server = createServer((req, res) => { void handle(req, res).catch((error: unknown) => { res.writeHead(500); res.end(String(error)); }); });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
    advertisedTools = body.tools.map((t) => t.function.name);
    requests += 1;
    const toolMessage = [...body.messages].reverse().find((message) => message.role === "tool");
    if (toolMessage) {
      try { modelSawResult = JSON.parse(toolMessage.content); }
      catch { modelSawResult = toolMessage.content; }
    }
    const delta = requests === 1 ? {
      role: "assistant", tool_calls: [{ index: 0, id: "call-create", type: "function", function: { name: "create_note", arguments: JSON.stringify({ path: "created.md", text: "# Verified\n\nExact content." }) } }]
    } : { role: "assistant", content: approve ? "Saved and verified." : "The edit was denied." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [payload, reason] of [[delta, null], [{}, requests === 1 ? "tool_calls" : "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta: payload, finish_reason: reason }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    const agentDir = path.join(dir, "agent"); const vaultDir = path.join(dir, "vault");
    await mkdir(agentDir); await mkdir(vaultDir);
    await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "sidekick-test": {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-test",
      models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    } } }));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const vault = {
      getFileByPath: (name: string) => existsSync(path.join(vaultDir, name)) ? { path: name } : null,
      getAbstractFileByPath: (name: string) => existsSync(path.join(vaultDir, name)) ? { path: name } : null,
      read: (file: { path: string }) => readFile(path.join(vaultDir, file.path), "utf8"),
      create: (name: string, text: string) => writeFile(path.join(vaultDir, name), text, { flag: "wx" })
    } as unknown as Vault;
    const review = vi.fn(async () => {
      expect(existsSync(path.join(vaultDir, "created.md"))).toBe(false);
      if (scenario === "abort") run?.abort();
      return approve;
    });
    const host = new VaultToolHost(mode, { ...createVaultStorage(vault, vaultDir), review, settled: vi.fn(), answers: new Map() });
    let assistant = "";
    await new Promise<void>((resolve, reject) => {
      run = new PiReadOnlyPromptRun({
        executablePath: process.env.SIDEKICK_PI_EXECUTABLE || "pi", prompt: "Create a note.",
        modelLabel: "sidekick-test/scripted", toolMode: "read-only", vaultEditMode: mode, workspaceRoot: vaultDir, timeoutMs: 20000
      }, {
        onVaultTool: (request, signal) => host.execute(request, signal),
        onAssistantDelta: (text) => { assistant += text; }, onError: (error) => reject(new Error(error)),
        onComplete: (reason) => reason === "completed" || (scenario === "abort" && reason === "stopped") ? resolve() : reject(new Error(reason)),
        onStatus: () => {}, onToolEvent: () => {}
      });
      run.start();
    });
    if (scenario === "chat") {
      expect(review).not.toHaveBeenCalled();
      expect(advertisedTools).toContain("read_note");
      for (const tool of ["create_note", "append_note", "edit_note", "write", "edit", "bash"]) expect(advertisedTools).not.toContain(tool);
      expect(existsSync(path.join(vaultDir, "created.md"))).toBe(false);
      return;
    }
    if (scenario === "abort") {
      expect(review).toHaveBeenCalledOnce();
      expect(requests).toBe(1);
      expect(existsSync(path.join(vaultDir, "created.md"))).toBe(false);
      return;
    }
    expect(modelSawResult).toMatchObject({ status: approve ? "applied" : "denied" });
    expect(review).toHaveBeenCalledOnce();
    expect(advertisedTools).toEqual(expect.arrayContaining(["read_note", "create_note", "append_note", "edit_note"]));
    expect(advertisedTools).not.toEqual(expect.arrayContaining(["bash"]));
    expect(modelSawResult).toMatchObject({ status: approve ? "applied" : "denied" });
    expect(assistant).toContain(approve ? "Saved and verified." : "denied");
    if (approve) expect(await readFile(path.join(vaultDir, "created.md"), "utf8")).toBe("# Verified\n\nExact content.");
    else expect(existsSync(path.join(vaultDir, "created.md"))).toBe(false);
  } finally {
    run?.abort();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
