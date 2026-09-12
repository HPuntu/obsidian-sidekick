import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Vault } from "obsidian";
import { validateLocalNotePath, createVaultStorage } from "../src/agent/obsidianVaultTools";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(path.join(tmpdir(), "sidekick-test-")); roots.push(dir); return dir; }

it("refuses symlink files and folders", async () => {
  const dir = await root();
  await mkdir(path.join(dir, "real")); await writeFile(path.join(dir, "real/a.md"), "x");
  await symlink(path.join(dir, "real"), path.join(dir, "alias"));
  await symlink(path.join(dir, "real/a.md"), path.join(dir, "alias.md"));
  await expect(validateLocalNotePath(dir, "alias/a.md")).rejects.toThrow("symlinks");
  await expect(validateLocalNotePath(dir, "alias.md")).rejects.toThrow("symlinks");
});
it("allows existing or new notes in existing parents only", async () => {
  const dir = await root(); await mkdir(path.join(dir, "notes"));
  await expect(validateLocalNotePath(dir, "notes/a.md")).resolves.toBeUndefined();
  await expect(validateLocalNotePath(dir, "missing/a.md")).rejects.toThrow("Parent folder");
  await mkdir(path.join(dir, "folder.md"));
  await expect(validateLocalNotePath(dir, "folder.md")).rejects.toThrow("not a file");
});
it("uses vault.process to compare and write in one operation", async () => {
  let current = "user changed";
  const vault = {
    getFileByPath: () => ({}),
    process: vi.fn(async (_file: unknown, fn: (text: string) => string) => { current = fn(current); })
  } as unknown as Vault;
  const storage = createVaultStorage(vault, "/unused");
  const change = { id: "1", path: "note.md", original: "old", replacement: "new" };
  await expect(storage.commit(change, new AbortController().signal)).rejects.toThrow("changed after review");
  expect(current).toBe("user changed");
  current = "old";
  await storage.commit(change, new AbortController().signal);
  expect(current).toBe("new");
});

it("protects a custom Obsidian configuration folder", async () => {
  const storage = createVaultStorage({ configDir: "Settings" } as Vault, "/unused");
  await expect(storage.validatePath("Settings/private.md")).rejects.toThrow("configuration");
});

it("does not overwrite a physical file missing from the vault index", async () => {
  const dir = await root(); await writeFile(path.join(dir, "unindexed.md"), "Keep me");
  const vault = { getFileByPath: () => null, getAbstractFileByPath: () => null, create: vi.fn() } as unknown as Vault;
  const storage = createVaultStorage(vault, dir);
  await expect(storage.read("unindexed.md")).rejects.toThrow("exists on disk");
  await expect(storage.commit({ id: "1", path: "unindexed.md", original: undefined, replacement: "wrong" }, new AbortController().signal)).rejects.toThrow("created after review");
});
