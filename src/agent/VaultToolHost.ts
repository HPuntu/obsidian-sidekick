import { createHash } from "node:crypto";

export type VaultEditMode = "chat" | "reviewed";
export const VAULT_TOOL_NAMES = ["read_note", "create_note", "append_note", "edit_note"] as const;
export type VaultToolName = typeof VAULT_TOOL_NAMES[number];
export interface VaultToolRequest {
  callId: string;
  name: VaultToolName;
  args: Record<string, unknown>;
}
export interface VaultToolResult {
  status: "read" | "applied" | "unchanged" | "denied" | "cancelled" | "conflict" | "failed";
  path?: string;
  text?: string;
  version?: string;
  message?: string;
}
export interface VaultChange {
  id: string;
  path: string;
  original: string | undefined;
  replacement: string;
}
export interface VaultToolDeps {
  validatePath(this: void, path: string): Promise<void>;
  read(this: void, path: string): Promise<string | undefined>;
  /** Atomically compare the current text and write, throwing on conflicts. */
  commit(this: void, change: VaultChange, signal: AbortSignal): Promise<void>;
  review(this: void, change: VaultChange, signal: AbortSignal): Promise<boolean>;
  settled(this: void, change: VaultChange, result: VaultToolResult): void;
  answers: ReadonlyMap<string, string>;
}
export class VaultConflictError extends Error {}
const MAX_NOTE_CHARS = 1_000_000;

export function noteVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function validateNotePath(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim() ||
      /[\\:]/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32) || value.startsWith("/") ||
      value.split("/").some((part) => !part || part.startsWith(".")) ||
      !value.toLowerCase().endsWith(".md")) {
    throw new Error("Use a vault-relative .md path without traversal, hidden folders, or absolute paths.");
  }
  return value;
}

/** One host per run: permissions, read versions and deduplication cannot leak across runs. */
export class VaultToolHost {
  private calls = new Map<string, { input: string; result: Promise<VaultToolResult> }>();
  private queues = new Map<string, Promise<unknown>>();
  private reads = new Map<string, string>();

  constructor(private mode: VaultEditMode, private deps: VaultToolDeps) {}

  execute(request: VaultToolRequest, signal: AbortSignal): Promise<VaultToolResult> {
    if (!request || typeof request.callId !== "string" || !request.callId ||
        !VAULT_TOOL_NAMES.includes(request.name) || !request.args || Array.isArray(request.args)) {
      return Promise.resolve({ status: "failed", message: "Invalid vault tool request." });
    }
    const input = JSON.stringify([request.name, request.args]);
    const existing = this.calls.get(request.callId);
    if (existing) return existing.input === input ? existing.result : Promise.resolve({
      status: "failed", message: "Tool call ID was reused with different arguments."
    });
    if (this.calls.size >= 128) return Promise.resolve({ status: "failed", message: "Vault tool limit reached for this run." });
    const pathKey = String(request.args.path);
    const previous = this.queues.get(pathKey) ?? Promise.resolve();
    const result = previous.then(() => this.run(request, signal));
    this.calls.set(request.callId, { input, result });
    this.queues.set(pathKey, result);
    return result;
  }

  private async run(request: VaultToolRequest, signal: AbortSignal): Promise<VaultToolResult> {
    let change: VaultChange | undefined;
    let result: VaultToolResult;
    try {
      signal.throwIfAborted();
      const path = validateNotePath(request.args.path);
      if (request.name !== "read_note" && this.mode !== "reviewed") {
        return { status: "denied", path, message: "Chat mode does not permit edits." };
      }
      await this.deps.validatePath(path);
      const original = await this.deps.read(path);
      signal.throwIfAborted();
      if (original !== undefined && original.length > MAX_NOTE_CHARS) throw new Error("Note is too large for this tool.");
      if (request.name === "read_note") {
        if (original === undefined) throw new Error("Note does not exist.");
        const version = noteVersion(original);
        this.reads.set(path, version);
        return { status: "read", path, text: original, version };
      }
      let replacement: string;
      if (request.name === "edit_note") {
        if (original === undefined) throw new Error("Note does not exist. Use create_note for a new note.");
        const version = noteVersion(original);
        if (this.reads.get(path) !== version || request.args.version !== version) {
          throw new VaultConflictError("Read the current note with read_note before editing; use its version.");
        }
        const oldText = this.string(request.args.oldText, "oldText");
        const newText = this.string(request.args.newText, "newText");
        if (!oldText || original.indexOf(oldText) === -1 ||
            original.indexOf(oldText, original.indexOf(oldText) + 1) !== -1) {
          throw new Error("oldText must match exactly one nonempty passage. Include more surrounding text.");
        }
        replacement = original.replace(oldText, () => newText);
      } else {
        if (request.name === "create_note" && original !== undefined) throw new VaultConflictError("Note already exists. Use edit_note or append_note.");
        if (request.name === "append_note" && original === undefined) throw new Error("Note does not exist. Use create_note.");
        const text = this.content(request.args);
        replacement = request.name === "append_note"
          ? original + (original && !original.endsWith("\n") ? "\n\n" : original ? "\n" : "") + text
          : text;
      }
      if (replacement.length > MAX_NOTE_CHARS) throw new Error("Resulting note is too large.");
      if (replacement === original) return { status: "unchanged", path, version: noteVersion(replacement) };
      change = { id: request.callId, path, original, replacement };
      const approved = await this.deps.review(change, signal);
      signal.throwIfAborted();
      if (!approved) {
        result = { status: "denied", path, message: "The user denied this edit. Do not retry it without a new user request." };
      } else {
        await this.deps.validatePath(path);
        signal.throwIfAborted();
        await this.deps.commit(change, signal);
        const written = await this.deps.read(path);
        if (written !== replacement) throw new VaultConflictError("The note changed during post-write verification. Inspect it before continuing.");
        const version = noteVersion(replacement);
        this.reads.set(path, version);
        result = { status: "applied", path, version, message: "Approved edit applied and verified." };
      }
    } catch (error) {
      result = {
        status: signal.aborted ? "cancelled" : error instanceof VaultConflictError ? "conflict" : "failed",
        message: error instanceof Error ? error.message : String(error)
      };
    }
    if (change) this.deps.settled(change, result);
    return result;
  }

  private string(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length > MAX_NOTE_CHARS) throw new Error(`${name} must be text of at most ${MAX_NOTE_CHARS} characters.`);
    return value;
  }

  private content(args: Record<string, unknown>): string {
    if ((args.text !== undefined) === (args.answerId !== undefined)) throw new Error("Provide exactly one of text or answerId.");
    if (args.answerId !== undefined) {
      const answer = this.deps.answers.get(this.string(args.answerId, "answerId"));
      if (answer === undefined) throw new Error("Unknown answerId in this conversation.");
      return this.string(answer, "answer");
    }
    return this.string(args.text, "text");
  }
}
