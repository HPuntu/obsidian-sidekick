import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawn }));
import { discoverPiRpc, PI_DISCOVERY_TIMEOUT_MS } from "../src/bridge/pi/PiRpcDiscovery";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); spawn.mockReset(); });

function fakeProcess() {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child = Object.assign(new EventEmitter(), {
    stdout, stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stdin: { write: vi.fn(), end: vi.fn() }, killed: false, kill: vi.fn()
  });
  spawn.mockReturnValue(child);
  return child;
}

it("allows a cold discovery taking longer than four seconds", async () => {
  const child = fakeProcess();
  const discovery = discoverPiRpc("pi");
  await vi.advanceTimersByTimeAsync(6000);
  expect(child.kill).not.toHaveBeenCalled();
  for (const [id, command, data] of [
    ["local-sidekick-get-state", "get_state", {}],
    ["local-sidekick-get-models", "get_available_models", { models: [{ provider: "ollama", id: "qwen3.6:35b" }] }]
  ]) child.stdout.emit("data", JSON.stringify({ id, command, data, type: "response", success: true }) + "\n");
  expect((await discovery).status).toBe("ready");
  expect(child.kill).toHaveBeenCalledOnce();
});

it("still cleans up a hung discovery at the deadline", async () => {
  const child = fakeProcess();
  const discovery = discoverPiRpc("pi");
  await vi.advanceTimersByTimeAsync(PI_DISCOVERY_TIMEOUT_MS);
  expect((await discovery).error).toContain("timed out");
  expect(child.kill).toHaveBeenCalledOnce();
});
