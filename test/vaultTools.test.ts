import { describe, expect, it, vi } from "vitest";
import { VaultToolHost, VaultConflictError, validateNotePath, noteVersion, type VaultToolDeps, type VaultEditMode, type VaultToolName } from "../src/agent/VaultToolHost";

function fixture(mode: VaultEditMode = "reviewed") {
  const files = new Map([["note.md", "# Original\n\nKeep this."]]);
  const controller = new AbortController();
  const deps: VaultToolDeps = {
    validatePath: vi.fn(async () => {}),
    read: vi.fn<VaultToolDeps["read"]>(async (path) => files.get(path)),
    review: vi.fn(async () => true),
    commit: vi.fn<VaultToolDeps["commit"]>(async (change, signal) => {
      signal.throwIfAborted();
      if (files.get(change.path) !== change.original) throw new VaultConflictError("Changed during review");
      files.set(change.path, change.replacement);
    }),
    settled: vi.fn(), answers: new Map([["answer-1", "Exact answer with $math$.\n\n```ts\nx\n```"]])
  };
  const host = new VaultToolHost(mode, deps);
  let id = 0;
  const run = (name: string, args: Record<string, unknown>, callId = String(++id)) => host.execute({ name: name as VaultToolName, args, callId }, controller.signal);
  return { files, deps, controller, host, run };
}

describe("vault paths", () => {
  it.each(["../out.md", "a/../out.md", "/tmp/out.md", "a\\out.md", "C:/out.md", ".private/config.md", "a/.hidden/note.md", "a//note.md", "a/./note.md", "bad\0.md", "note.txt", " note.md", "https://host/note.md"])("rejects %j", (path) => {
    expect(() => validateNotePath(path)).toThrow();
  });
  it("accepts normal nested note names", () => expect(validateNotePath("Reading/My Note.md")).toBe("Reading/My Note.md"));
});

describe("vault operation lifecycle", () => {
  it("never writes before approval resolves", async () => {
    const f = fixture();
    let approve!: (v: boolean) => void;
    f.deps.review = vi.fn(() => new Promise((resolve) => { approve = resolve; }));
    const pending = f.run("create_note", { path: "new.md", text: "New note" });
    await vi.waitFor(() => expect(f.deps.review).toHaveBeenCalledOnce());
    expect(f.files.has("new.md")).toBe(false);
    approve(true);
    expect((await pending).status).toBe("applied");
    expect(f.files.get("new.md")).toBe("New note");
  });
  it("returns denial without writing", async () => {
    const f = fixture(); f.deps.review = vi.fn(async () => false);
    expect((await f.run("append_note", { path: "note.md", text: "extra" })).status).toBe("denied");
    expect(f.deps.commit).not.toHaveBeenCalled();
  });
  it("returns cancellation when stopped during approval", async () => {
    const f = fixture();
    f.deps.review = vi.fn(async () => { f.controller.abort(); return true; });
    expect((await f.run("create_note", { path: "new.md", text: "x" })).status).toBe("cancelled");
    expect(f.deps.commit).not.toHaveBeenCalled();
  });
  it("cancels before any filesystem access", async () => {
    const f = fixture(); f.controller.abort();
    expect((await f.run("read_note", { path: "note.md" })).status).toBe("cancelled");
    expect(f.deps.read).not.toHaveBeenCalled();
  });
  it("requires a current read and version before exact replacement", async () => {
    const f = fixture();
    const args = { path: "note.md", version: noteVersion(f.files.get("note.md")!), oldText: "Keep this.", newText: "Changed." };
    expect((await f.run("edit_note", args)).status).toBe("conflict");
    const read = await f.run("read_note", { path: "note.md" });
    expect(read.version).toBe(args.version);
    expect((await f.run("edit_note", args)).status).toBe("applied");
    expect(f.files.get("note.md")).toBe("# Original\n\nChanged.");
  });
  it("rejects ambiguous replacement matches", async () => {
    const f = fixture(); f.files.set("note.md", "same same");
    const read = await f.run("read_note", { path: "note.md" });
    expect((await f.run("edit_note", { path: "note.md", version: read.version, oldText: "same", newText: "new" })).status).toBe("failed");
    expect(f.deps.review).not.toHaveBeenCalled();
  });
  it("does not interpret replacement dollar syntax", async () => {
    const f = fixture(); const read = await f.run("read_note", { path: "note.md" });
    await f.run("edit_note", { path: "note.md", version: read.version, oldText: "Keep this.", newText: "$& $$" });
    expect(f.files.get("note.md")).toBe("# Original\n\n$& $$");
  });
  it("catches changes while waiting for approval", async () => {
    const f = fixture(); f.deps.review = vi.fn(async () => { f.files.set("note.md", "User edit"); return true; });
    expect((await f.run("append_note", { path: "note.md", text: "extra" })).status).toBe("conflict");
    expect(f.files.get("note.md")).toBe("User edit");
  });
  it("never overwrites an existing note with create", async () => {
    const f = fixture();
    expect((await f.run("create_note", { path: "note.md", text: "Overwrite" })).status).toBe("conflict");
    expect(f.deps.review).not.toHaveBeenCalled();
  });
  it("appends exact stored answer contents", async () => {
    const f = fixture(); const original = f.files.get("note.md");
    expect((await f.run("append_note", { path: "note.md", answerId: "answer-1" })).status).toBe("applied");
    expect(f.files.get("note.md")).toBe(original + "\n\n" + f.deps.answers.get("answer-1"));
  });
  it("rejects unknown answer IDs and ambiguous content", async () => {
    const f = fixture();
    expect((await f.run("create_note", { path: "new.md", answerId: "missing" })).status).toBe("failed");
    expect((await f.run("create_note", { path: "new.md", text: "x", answerId: "answer-1" })).status).toBe("failed");
  });
  it("is idempotent for a repeated request ID", async () => {
    const f = fixture(); const args = { path: "note.md", text: "once" };
    const results = await Promise.all([f.run("append_note", args, "same"), f.run("append_note", args, "same")]);
    expect(results[0]).toEqual(results[1]);
    expect(f.deps.commit).toHaveBeenCalledOnce();
    expect((await f.run("append_note", { ...args, text: "twice" }, "same")).status).toBe("failed");
  });
  it("serializes parallel edits of the same note", async () => {
    const f = fixture();
    await Promise.all([f.run("append_note", { path: "note.md", text: "one" }), f.run("append_note", { path: "note.md", text: "two" })]);
    expect(f.files.get("note.md")).toBe("# Original\n\nKeep this.\n\none\n\ntwo");
  });
  it.each(["create_note", "append_note", "edit_note"])("chat blocks %s even if explicitly requested", async (name) => {
    const f = fixture("chat");
    expect((await f.run(name, { path: "note.md", text: "x" })).status).toBe("denied");
    expect(f.deps.commit).not.toHaveBeenCalled();
  });
  it("chat still reads notes", async () => expect((await fixture("chat").run("read_note", { path: "note.md" })).status).toBe("read"));
  it("reports write failure instead of success", async () => {
    const f = fixture(); f.deps.commit = vi.fn(async () => { throw new Error("Disk full"); });
    expect(await f.run("create_note", { path: "new.md", text: "x" })).toMatchObject({ status: "failed", message: "Disk full" });
  });
  it("verifies the actual written contents", async () => {
    const f = fixture(); f.deps.commit = vi.fn(async () => {});
    expect((await f.run("create_note", { path: "new.md", text: "x" })).status).toBe("conflict");
  });
  it("returns no-op without requesting approval", async () => {
    const f = fixture(); const read = await f.run("read_note", { path: "note.md" });
    expect((await f.run("edit_note", { path: "note.md", version: read.version, oldText: "Keep", newText: "Keep" })).status).toBe("unchanged");
    expect(f.deps.review).not.toHaveBeenCalled();
  });
  it("rejects unsupported tools and oversized content", async () => {
    const f = fixture();
    expect((await f.run("bash", { path: "note.md" })).status).toBe("failed");
    expect((await f.run("create_note", { path: "new.md", text: "x".repeat(1_000_001) })).status).toBe("failed");
  });
});
