import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn<(executable: string, args: string[], options: { env: Record<string, string> }) => unknown>());
vi.mock("child_process", () => ({ spawn }));
import { PiReadOnlyPromptRun } from "../src/bridge/pi/PiReadOnlyPrompt";
import type { VaultToolRequest, VaultToolResult } from "../src/agent/VaultToolHost";

let active: PiReadOnlyPromptRun | undefined;
afterEach(() => { active?.abort(); active = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); spawn.mockReset(); });

async function fixture(tool: (request: VaultToolRequest, signal: AbortSignal) => Promise<VaultToolResult> = vi.fn(async () => ({ status: "applied" as const })), toolMode: "read-only" | "disabled" = "read-only") {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stdin: { write: vi.fn<(line: string) => void>(), end: vi.fn() }, killed: false, kill: vi.fn()
  });
  spawn.mockReturnValue(child);
  const callbacks = { onVaultTool: tool, onAssistantDelta: vi.fn(), onAssistantMessageStart: vi.fn(), onError: vi.fn(), onComplete: vi.fn(), onStatus: vi.fn(), onToolEvent: vi.fn() };
  active = new PiReadOnlyPromptRun({ executablePath: "pi", prompt: "test", toolMode, vaultEditMode: "reviewed", allowPiUserConfig: false, timeoutMs: 5000 }, callbacks);
  active.start();
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  const token = spawn.mock.calls[0][2].env.SIDEKICK_RPC_TOKEN;
  const emit = (record: unknown) => child.stdout.emit("data", JSON.stringify(record) + "\n");
  const messages = () => child.stdin.write.mock.calls.map(([line]) => JSON.parse(line) as Record<string, unknown>);
  const ready = () => emit({ type: "extension_ui_request", id: "ready", method: "notify", message: `local-sidekick-ready:${token}` });
  const request = (id = "request-1", title = `local-sidekick-tool:${token}`) => emit({ type: "extension_ui_request", id, method: "editor", title, prefill: JSON.stringify({ callId: "call-1", name: "create_note", args: { path: "note.md", text: "x" } }) });
  return { child, callbacks, ready, request, emit, messages };
}

it("loads only the explicit bundled extension and waits for its handshake", async () => {
  const f = await fixture();
  const args = spawn.mock.calls[0][1];
  expect(args).toEqual(expect.arrayContaining(["--no-extensions", "--no-skills", "--no-context-files", "--extension"]));
  expect(f.messages().some((message) => message.type === "prompt")).toBe(false);
  f.ready();
  expect(f.messages().filter((message) => message.type === "prompt")).toHaveLength(1);
  f.ready();
  expect(f.messages().filter((message) => message.type === "prompt")).toHaveLength(1);
});
it("returns the host result only after the review finishes", async () => {
  let approve!: (value: VaultToolResult) => void;
  const handler = vi.fn(() => new Promise<VaultToolResult>((resolve) => { approve = resolve; }));
  const f = await fixture(handler); f.ready(); f.request();
  expect(handler).toHaveBeenCalledOnce();
  expect(f.messages().some((m) => m.type === "extension_ui_response")).toBe(false);
  approve({ status: "denied" });
  await vi.waitFor(() => expect(f.messages().find((m) => m.type === "extension_ui_response")).toMatchObject({ id: "request-1", value: '{"status":"denied"}' }));
});
it("ignores duplicate RPC requests and cancels unrelated extension dialogs", async () => {
  const f = await fixture(); f.ready(); f.request(); f.request(); f.request("foreign", "not-the-private-channel");
  await vi.waitFor(() => expect(f.callbacks.onVaultTool).toHaveBeenCalledOnce());
  expect(f.messages()).toContainEqual({ type: "extension_ui_response", id: "foreign", cancelled: true });
});
it("abort cancels the host and does not deliver a late successful response", async () => {
  let finish!: (value: VaultToolResult) => void;
  let signal!: AbortSignal;
  const f = await fixture(vi.fn((_r: VaultToolRequest, s: AbortSignal) => { signal = s; return new Promise<VaultToolResult>((resolve) => { finish = resolve; }); }));
  f.ready(); f.request(); active!.abort();
  expect(signal.aborted).toBe(true);
  finish({ status: "applied" }); await Promise.resolve();
  expect(f.messages().some((m) => m.type === "extension_ui_response")).toBe(false);
  expect(f.callbacks.onComplete).toHaveBeenCalledWith("stopped");
});
it("fails closed if bundled tools do not initialize", async () => {
  const f = await fixture();
  f.child.emit("exit", 1, null);
  expect(f.callbacks.onError).toHaveBeenCalledOnce();
  expect(f.messages().some((m) => m.type === "prompt")).toBe(false);
});
it("disabled tools do not load the extension", async () => {
  const f = await fixture(undefined, "disabled");
  expect(spawn.mock.calls[0][1]).not.toContain("--extension");
  expect(f.messages().some((m) => m.type === "prompt")).toBe(true);
});

it("does not count time spent waiting for a review against the model timeout", async () => {
  vi.useFakeTimers();
  let finish!: (result: VaultToolResult) => void;
  const f = await fixture(vi.fn(() => new Promise<VaultToolResult>((resolve) => { finish = resolve; })));
  f.ready(); f.request();
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.callbacks.onError).not.toHaveBeenCalled();
  finish({ status: "denied" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.callbacks.onError).toHaveBeenCalledOnce();
});
