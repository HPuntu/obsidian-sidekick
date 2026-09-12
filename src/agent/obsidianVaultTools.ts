import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Vault } from "obsidian";
import { VaultConflictError, validateNotePath, type VaultChange } from "./VaultToolHost";

export async function validateLocalNotePath(root: string, notePath: string): Promise<void> {
  validateNotePath(notePath);
  let current = await realpath(root);
  const segments = notePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Vault tools do not follow symlinks.");
      if (index < segments.length - 1 && !info.isDirectory()) throw new Error("Parent is not a folder.");
      if (index === segments.length - 1 && !info.isFile()) throw new Error("Target is not a file.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (index === segments.length - 1) return;
        throw new Error("Parent folder must already exist. Choose an existing vault folder.", { cause: error });
      }
      throw error;
    }
  }
}

export function createVaultStorage(vault: Vault, root: string) {
  return {
    validatePath: async (notePath: string) => {
      if (vault.configDir && `${notePath.toLowerCase()}/`.startsWith(`${vault.configDir.toLowerCase()}/`)) {
        throw new Error("Vault tools cannot access Obsidian configuration files.");
      }
      await validateLocalNotePath(root, notePath);
    },
    async read(notePath: string): Promise<string | undefined> {
      const file = vault.getFileByPath(notePath);
      if (file) {
        if (file.path !== notePath) throw new VaultConflictError(`Use the exact note path: ${file.path}`);
        return vault.read(file);
      }
      if (await existsOnDisk(root, notePath)) throw new VaultConflictError("Target exists on disk but is not indexed at this vault path. Refresh the vault before creating it.");
      return undefined;
    },
    async commit(change: VaultChange, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      const file = vault.getFileByPath(change.path);
      if (change.original === undefined) {
        if (vault.getAbstractFileByPath(change.path) || await existsOnDisk(root, change.path)) throw new VaultConflictError("Target was created after review.");
        signal.throwIfAborted();
        await vault.create(change.path, change.replacement);
      } else {
        if (!file) throw new VaultConflictError("Target no longer exists.");
        await vault.process(file, (current) => {
          signal.throwIfAborted();
          if (current !== change.original) throw new VaultConflictError("Target changed after review. Read it again.");
          return change.replacement;
        });
      }
    }
  };
}

async function existsOnDisk(root: string, notePath: string): Promise<boolean> {
  try { await lstat(path.join(root, notePath)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
