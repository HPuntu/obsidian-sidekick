import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => vi.fn<(url: URL, options: unknown, callback: (response: EventEmitter) => void) => unknown>());
const bodies: string[] = [];
vi.mock("http", () => ({ request }));
import { unloadOllamaModel } from "../src/bridge/ollama/OllamaClient";

function respond(data: unknown) {
  request.mockImplementationOnce((_url, _options, callback) => {
    const req = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(), write: (body: string) => { bodies.push(body); }, destroy: vi.fn(),
      end: () => {
        const response = Object.assign(new EventEmitter(), { statusCode: 200, setEncoding: vi.fn() });
        callback(response);
        response.emit("data", JSON.stringify(data));
        response.emit("end");
      }
    });
    return req;
  });
}

describe("verified model unload", () => {
  beforeEach(() => { request.mockReset(); bodies.length = 0; });
  it("checks resident models after requesting eviction", async () => {
    respond({ done: true });
    respond({ models: [] });
    expect((await unloadOllamaModel("http://localhost:11434", "qwen3.6:35b")).success).toBe(true);
    expect(request.mock.calls.map(([url]) => url.pathname)).toEqual(["/api/generate", "/api/ps"]);
    expect(JSON.parse(bodies[0])).toMatchObject({ keep_alive: 0, stream: false });
  });
  it("does not claim success when the model remains loaded", async () => {
    respond({ done: true });
    respond({ models: [{ name: "qwen3.6:35b" }] });
    expect((await unloadOllamaModel("http://localhost:11434", "qwen3.6:35b")).success).toBe(false);
  });
  it("recognizes implicit latest tags", async () => {
    respond({ done: true });
    respond({ models: [{ name: "qwen3.6:latest" }] });
    expect((await unloadOllamaModel("http://localhost:11434", "qwen3.6")).success).toBe(false);
  });
});
