import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import path from "path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import vaultExtensionSource from "sidekick:pi-extension";
import type { VaultEditMode, VaultToolRequest, VaultToolResult } from "../../agent/VaultToolHost";

import { piChildEnv } from "./piEnv";
import { getPiToolNames } from "./piFlags";
import type { ThinkingPreference } from "./thinking";

export interface PiReadOnlyPromptOptions {
  vaultEditMode?: VaultEditMode;
  thinkingLevel?: ThinkingPreference;
  executablePath: string;
  modelLabel?: string;
  prompt: string;
  sessionPath?: string;
  timeoutMs?: number;
  toolMode?: "disabled" | "read-only";
  workspaceRoot?: string;
  allowPiUserConfig?: boolean;
}

/** How a run ended, for callers that must not infer it from status text. */
export type PiRunCompletion = "completed" | "stopped";

export interface PiReadOnlyPromptCallbacks {
  onAssistantMessageStart?(): void;
  onVaultTool?(request: VaultToolRequest, signal: AbortSignal): Promise<VaultToolResult>;
  onAssistantDelta(delta: string): void;
  /** Terminal failure. Mutually exclusive with onComplete. */
  onError(message: string): void;
  /** Terminal success or abort. Mutually exclusive with onError. */
  onComplete(reason: PiRunCompletion): void;
  onSessionState?(state: PiSessionState): void;
  onStatus(message: string): void;
  onToolEvent(event: PiToolEvent): void;
}

export interface PiSessionState {
  messageCount?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
}

export interface PiSetModelResult {
  error?: string;
  sessionState?: PiSessionState;
  success: boolean;
}

export interface PiToolEvent {
  callId?: string;
  eventType: string;
  input?: unknown;
  name?: string;
  output?: unknown;
  raw: Record<string, unknown>;
  status: "call" | "error" | "result";
  title: string;
}

interface RpcResponse {
  command?: string;
  data?: unknown;
  error?: string;
  id?: string;
  success?: boolean;
  type?: string;
}

export class PiReadOnlyPromptRun {
  private callbacks: PiReadOnlyPromptCallbacks;
  private child?: ChildProcessWithoutNullStreams;
  private completed = false;
  private emittedAssistantText = false;
  private options: Required<PiReadOnlyPromptOptions>;
  private pendingCompletionMessage?: string;
  private reportedRunError?: string;
  private reportedThinking = false;
  private stderr = "";
  private stdoutBuffer = "";
  private timeout?: number;
  private controller = new AbortController();
  private extensionFolder?: string;
  private rpcToken = randomUUID();
  private extensionReady = false;
  private promptSent = false;
  private startupTimeout?: number;
  private remainingMs = 0;
  private timerStarted = 0;
  private hostRequests = 0;
  private rpcRequestIds = new Set<string>();

  constructor(
    options: PiReadOnlyPromptOptions,
    callbacks: PiReadOnlyPromptCallbacks
  ) {
    this.options = {
      vaultEditMode: options.vaultEditMode ?? "chat",
      thinkingLevel: options.thinkingLevel ?? "default",
      executablePath: options.executablePath.trim() || "pi",
      modelLabel: options.modelLabel ?? "",
      prompt: options.prompt,
      sessionPath: options.sessionPath ?? "",
      timeoutMs: options.timeoutMs ?? 600000,
      toolMode: options.toolMode ?? "disabled",
      workspaceRoot: options.workspaceRoot ?? "",
      allowPiUserConfig: options.allowPiUserConfig === true
    };
    this.callbacks = callbacks;
  }

  start(): void {
    void this.startAsync().catch((error: unknown) => this.fail(error instanceof Error ? error.message : String(error)));
  }

  private async startAsync(): Promise<void> {
    const validationError = validateExecutablePath(this.options.executablePath);
    if (validationError) {
      this.fail(validationError);
      return;
    }

    let extensionPath: string | undefined;
    if (this.callbacks.onVaultTool && this.options.toolMode !== "disabled") {
      const folder = await mkdtemp(path.join(tmpdir(), "local-sidekick-pi-"));
      if (this.completed) { await rm(folder, { recursive: true, force: true }); return; }
      this.extensionFolder = folder;
      extensionPath = path.join(folder, "vault-tools.mjs");
      await writeFile(extensionPath, vaultExtensionSource, { mode: 0o600 });
      if (this.completed) return;
    }
    const args = buildReadOnlyArgs(this.options, extensionPath);
    this.child = spawn(this.options.executablePath, args, {
      cwd: this.options.workspaceRoot || undefined,
      env: { ...piChildEnv(), SIDEKICK_RPC_TOKEN: this.rpcToken, SIDEKICK_VAULT_MODE: this.options.vaultEditMode },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.remainingMs = this.options.timeoutMs;
    this.resumeTimer();
    if (extensionPath) {
      this.startupTimeout = window.setTimeout(() => this.fail("Pi did not load the bundled vault tools. Update Pi and retry."), 15000);
    }

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.handleStdout(chunk);
    });
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on("error", (error) => {
      this.fail(error.message);
    });
    this.child.on("exit", (code, signal) => {
      if (this.completed) {
        return;
      }

      this.fail(
        `Pi exited before completion (code ${code ?? "none"}, signal ${signal ?? "none"}). ${this.stderr}`.trim()
      );
    });

    this.writeJson({
      id: "local-sidekick-get-state",
      type: "get_state"
    });
    if (!extensionPath) this.sendPrompt();
  }

  private sendPrompt(): void {
    if (this.promptSent || this.completed) return;
    this.promptSent = true;
    this.writeJson({ id: "local-sidekick-prompt", message: this.options.prompt, type: "prompt" });
  }

  private pauseTimer(): void {
    if (this.timeout === undefined) return;
    window.clearTimeout(this.timeout);
    this.timeout = undefined;
    this.remainingMs -= Date.now() - this.timerStarted;
  }

  private resumeTimer(): void {
    if (this.completed || this.hostRequests > 0) return;
    this.timerStarted = Date.now();
    this.timeout = window.setTimeout(() => this.fail(`Pi prompt timed out after ${formatTimeout(this.options.timeoutMs)} of active execution.`), Math.max(1, this.remainingMs));
  }

  private async handleExtensionRequest(record: Record<string, unknown>): Promise<void> {
    if (record.method === "notify" && typeof record.message === "string" && record.message.startsWith(`local-sidekick-error:${this.rpcToken}:`)) {
      this.fail(record.message.slice(`local-sidekick-error:${this.rpcToken}:`.length));
      return;
    }
    if (record.method === "notify" && record.message === `local-sidekick-ready:${this.rpcToken}`) {
      this.extensionReady = true;
      window.clearTimeout(this.startupTimeout);
      this.sendPrompt();
      return;
    }
    const id = record.id;
    if (typeof id !== "string" || this.completed) return;
    if (record.method !== "editor" || record.title !== `local-sidekick-tool:${this.rpcToken}` ||
        !this.extensionReady || !this.callbacks.onVaultTool) {
      if (["editor", "input", "select", "confirm"].includes(String(record.method))) {
        this.writeJson({ type: "extension_ui_response", id, cancelled: true });
      }
      return;
    }
    if (this.rpcRequestIds.has(id)) return;
    this.rpcRequestIds.add(id);
    this.pauseTimer();
    this.hostRequests += 1;
    let result: VaultToolResult;
    try {
      if (typeof record.prefill !== "string" || record.prefill.length > 2_100_000) throw new Error("Invalid vault request payload.");
      result = await this.callbacks.onVaultTool(JSON.parse(record.prefill) as VaultToolRequest, this.controller.signal);
    } catch (error) {
      result = { status: "failed", message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.hostRequests -= 1;
      if (this.hostRequests === 0) this.resumeTimer();
    }
    if (!this.completed) this.writeJson({ type: "extension_ui_response", id, value: JSON.stringify(result) });
  }

  abort(): void {
    if (this.completed) {
      return;
    }

    this.writeJson({
      id: "local-sidekick-abort",
      type: "abort"
    });
    this.complete("Pi run stopped.", "stopped");
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const parts = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = parts.pop() ?? "";

    for (const part of parts) {
      this.handleJsonLine(stripTrailingCarriageReturn(part));
    }
  }

  private handleJsonLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const record = asRecord(parsed);
    if (!record) {
      return;
    }

    if (record.type === "extension_ui_request") {
      void this.handleExtensionRequest(record);
      return;
    }

    if (record.type === "response") {
      this.handleResponse(record);
      return;
    }

    this.handleEvent(record);
  }

  private handleResponse(record: Record<string, unknown>): void {
    const response = record as RpcResponse;
    if (response.success === false) {
      this.fail(response.error || `Pi RPC ${response.command ?? "command"} failed.`);
      return;
    }

    if (response.command === "get_state") {
      this.callbacks.onSessionState?.(extractSessionState(response.data));
      if (this.pendingCompletionMessage) {
        this.complete(this.pendingCompletionMessage, "completed");
      }
      return;
    }

    if (response.command === "prompt") {
      this.callbacks.onStatus("Pi accepted the prompt.");
    }
  }

  private handleEvent(record: Record<string, unknown>): void {
    if (record.type === "agent_start") {
      this.callbacks.onStatus("Pi run started.");
      return;
    }

    if (record.type === "agent_end") {
      this.emitFinalAssistantText(record.messages);

      if (record.willRetry === true) {
        this.callbacks.onStatus("Pi will retry after a transient failure.");
        return;
      }

      const error = getMessageError(record.messages);
      if (error) {
        this.reportRunError(error);
      } else if (!this.emittedAssistantText) {
        this.callbacks.onStatus("Pi completed without assistant text.");
      }

      this.requestFinalStateThenComplete("Pi run complete.");
      return;
    }

    if (record.type === "turn_start") {
      this.callbacks.onStatus("Pi turn started.");
      return;
    }

    if (record.type === "turn_end") {
      const error = getMessageError(record.message);
      if (error) {
        this.reportRunError(error);
      }
      this.emitFinalAssistantText(record.message);
      return;
    }

    if (record.type === "message_start") {
      if (asRecord(record.message)?.role === "assistant") {
        this.emittedAssistantText = false;
        this.callbacks.onAssistantMessageStart?.();
      }
      this.callbacks.onStatus("Model response started.");
      return;
    }

    if (record.type === "message_end") {
      const error = getMessageError(record.message);
      if (error) {
        this.reportRunError(error);
      }
      this.emitFinalAssistantText(record.message);
      return;
    }

    if (record.type === "message_update") {
      const event = getMessageUpdateEvent(record);
      if (event?.type === "text_delta" && typeof event.delta === "string") {
        this.emitAssistantDelta(event.delta);
      } else if (event?.type === "thinking_delta") {
        this.reportThinking();
      }

      return;
    }

    if (record.type === "auto_retry_start") {
      this.callbacks.onStatus(getRetryStatus(record));
      return;
    }

    if (record.type === "auto_retry_end") {
      if (record.success === false) {
        this.fail(getString(record.finalError) || "Pi auto-retry failed.");
        return;
      }

      this.callbacks.onStatus("Pi auto-retry succeeded.");
      return;
    }

    if (record.type === "extension_error") {
      this.callbacks.onStatus(
        `Pi extension error: ${getString(record.error) || "unknown error"}`
      );
      return;
    }

    if (typeof record.type === "string" && record.type.startsWith("tool_")) {
      this.callbacks.onToolEvent(extractPiToolEvent(record));
    }
  }

  private emitAssistantDelta(delta: string): void {
    if (!delta) {
      return;
    }

    this.emittedAssistantText = true;
    this.callbacks.onAssistantDelta(delta);
  }

  private emitFinalAssistantText(value: unknown): void {
    if (this.emittedAssistantText) {
      return;
    }

    const text = extractAssistantText(value);
    if (text) {
      this.emitAssistantDelta(text);
    }
  }

  private reportThinking(): void {
    if (this.reportedThinking) {
      return;
    }

    this.reportedThinking = true;
    this.callbacks.onStatus("Pi is reasoning.");
  }

  private reportRunError(error: string): void {
    const message = normalizePiRunError(error, this.options);
    if (!message || this.reportedRunError === message) {
      return;
    }

    this.reportedRunError = message;
    this.callbacks.onStatus(message);
  }

  private writeJson(payload: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) {
      return;
    }

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private complete(message: string, reason: PiRunCompletion): void {
    if (this.completed) {
      return;
    }

    this.completed = true;
    this.cleanup();
    this.callbacks.onStatus(message);
    this.callbacks.onComplete(reason);
  }

  private requestFinalStateThenComplete(message: string): void {
    if (!this.child || this.child.stdin.destroyed) {
      this.complete(message, "completed");
      return;
    }

    this.pendingCompletionMessage = message;
    this.writeJson({
      id: "local-sidekick-final-state",
      type: "get_state"
    });
  }

  private fail(message: string): void {
    if (this.completed) {
      return;
    }

    this.completed = true;
    this.cleanup();
    this.callbacks.onError(message);
  }

  private cleanup(): void {
    this.controller.abort();
    window.clearTimeout(this.startupTimeout);
    if (this.extensionFolder) {
      void rm(this.extensionFolder, { recursive: true, force: true }).catch(() => undefined);
      this.extensionFolder = undefined;
    }
    if (this.timeout !== undefined) {
      window.clearTimeout(this.timeout);
      this.timeout = undefined;
    }

    if (this.child) {
      if (!this.child.stdin.destroyed) {
        this.child.stdin.end();
      }

      if (!this.child.killed) {
        this.child.kill();
      }
    }
  }
}

export function setPiRpcModel(
  executablePath: string,
  sessionPath: string | undefined,
  modelLabel: string,
  timeoutMs = 5000,
  allowPiUserConfig = false,
  /**
   * The provider and id exactly as Pi reported them during discovery. Prefer
   * these: the label is a display string this plugin assembles as
   * `provider/id`, and re-splitting it guesses at a boundary we already knew.
   */
  discovered?: { modelId?: string; provider?: string }
): Promise<PiSetModelResult> {
  const normalizedPath = executablePath.trim() || "pi";
  const validationError = validateExecutablePath(normalizedPath);
  if (validationError) {
    return Promise.resolve({ error: validationError, success: false });
  }

  const model =
    discovered?.provider && discovered.modelId
      ? { modelId: discovered.modelId, provider: discovered.provider }
      : parseModelLabel(modelLabel);
  if (!model) {
    return Promise.resolve({
      error: `Unable to parse Pi model label: ${modelLabel}`,
      success: false
    });
  }

  return new Promise((resolve) => {
    const args = buildReadOnlyArgs({
      vaultEditMode: "chat",
      thinkingLevel: "default",
      allowPiUserConfig,
      executablePath: normalizedPath,
      modelLabel: "",
      prompt: "",
      sessionPath: sessionPath ?? "",
      timeoutMs,
      toolMode: "disabled",
      workspaceRoot: ""
    });
    const child = spawn(normalizedPath, args, {
      env: piChildEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let settled = false;
    let stderr = "";
    let stdoutBuffer = "";
    let setModelSucceeded = false;

    const timeout = window.setTimeout(() => {
      resolveOnce({
        error: `Pi set_model timed out. ${stderr}`.trim(),
        success: false
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const parts = stdoutBuffer.split("\n");
      stdoutBuffer = parts.pop() ?? "";

      for (const part of parts) {
        handleJsonLine(stripTrailingCarriageReturn(part));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolveOnce({ error: error.message, success: false });
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }

      resolveOnce({
        error: `Pi exited before set_model completed (code ${code ?? "none"}, signal ${signal ?? "none"}). ${stderr}`.trim(),
        success: false
      });
    });

    writeJson({
      id: "local-sidekick-set-model",
      modelId: model.modelId,
      provider: model.provider,
      type: "set_model"
    });

    function handleJsonLine(line: string): void {
      if (!line.trim()) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      const record = asRecord(parsed);
      if (!record || record.type !== "response") {
        return;
      }

      const response = record as RpcResponse;
      if (response.command === "set_model") {
        if (response.success === false) {
          resolveOnce({
            error: response.error || "Pi set_model failed.",
            success: false
          });
          return;
        }

        setModelSucceeded = true;
        writeJson({
          id: "local-sidekick-set-model-state",
          type: "get_state"
        });
        return;
      }

      if (response.command === "get_state" && setModelSucceeded) {
        resolveOnce({
          sessionState: extractSessionState(response.data),
          success: true
        });
      }
    }

    function writeJson(payload: Record<string, unknown>): void {
      if (!child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      }
    }

    function resolveOnce(value: PiSetModelResult): void {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeout);
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }

      if (!child.killed) {
        child.kill();
      }
      resolve(value);
    }
  });
}

export function buildReadOnlyArgs(options: Required<PiReadOnlyPromptOptions>, extensionPath?: string): string[] {
  const args = [
    "--mode",
    "rpc"
  ];

  if (options.sessionPath) {
    args.push("--session", options.sessionPath);
  } else {
    args.push("--no-session");
  }

  if (options.toolMode === "read-only") {
    args.push("--tools", getPiToolNames(extensionPath ? options.vaultEditMode : undefined));
  } else {
    args.push("--no-tools");
  }

  if (!options.allowPiUserConfig || extensionPath) {
    args.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files");
  }

  if (extensionPath) args.push("--extension", extensionPath);

  if (options.modelLabel) {
    args.push("--model", options.modelLabel);
  }

  if (options.thinkingLevel !== "default") {
    args.push("--thinking", options.thinkingLevel);
  }

  return args;
}

function normalizePiRunError(
  error: string,
  options: Required<PiReadOnlyPromptOptions>
): string {
  if (options.toolMode === "read-only" && /does not support tools/i.test(error)) {
    const model = options.modelLabel || "The selected model";
    return `${model} does not support Pi/Ollama tool calls. Choose a tool-capable model or set Pi tools to Disabled.`;
  }

  return `Pi run error: ${error}`;
}

function formatTimeout(timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60000);
  if (minutes >= 1) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const seconds = Math.round(timeoutMs / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function parseModelLabel(
  modelLabel: string
): { modelId: string; provider: string } | undefined {
  const separatorIndex = modelLabel.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === modelLabel.length - 1) {
    return undefined;
  }

  return {
    modelId: modelLabel.slice(separatorIndex + 1),
    provider: modelLabel.slice(0, separatorIndex)
  };
}

function validateExecutablePath(executablePath: string): string | undefined {
  if (!executablePath) {
    return "Pi executable path is empty.";
  }

  if (!path.isAbsolute(executablePath) && /\s/.test(executablePath)) {
    return "Command names cannot include arguments or whitespace. Use only the executable path.";
  }

  return undefined;
}

function extractSessionState(value: unknown): PiSessionState {
  const data = asRecord(value);
  if (!data) {
    return {};
  }

  return {
    messageCount: typeof data.messageCount === "number"
      ? data.messageCount
      : undefined,
    sessionFile: getString(data.sessionFile),
    sessionId: getString(data.sessionId),
    sessionName: getString(data.sessionName)
  };
}

function getMessageUpdateEvent(
  record: Record<string, unknown>
): Record<string, unknown> | undefined {
  return (
    asRecord(record.assistantMessageEvent) ??
    asRecord(record.messageEvent) ??
    asRecord(record.event)
  );
}

function getMessageError(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => getMessageError(item)).find(Boolean) ?? "";
  }

  const record = asRecord(value);
  if (!record) {
    return "";
  }

  return getString(record.errorMessage);
}

function extractPiToolEvent(record: Record<string, unknown>): PiToolEvent {
  const eventType = getString(record.type) || "tool_event";
  const nestedCall =
    asRecord(record.toolCall) ??
    asRecord(record.call) ??
    asRecord(record.tool) ??
    asRecord(record.request);
  const nestedResult =
    asRecord(record.toolResult) ??
    asRecord(record.result) ??
    asRecord(record.response);
  const name =
    getString(record.name) ||
    getString(record.toolName) ||
    getString(nestedCall?.name) ||
    getString(nestedCall?.toolName) ||
    getString(nestedResult?.name);
  const callId =
    getString(record.callId) ||
    getString(record.toolCallId) ||
    getString(record.id) ||
    getString(nestedCall?.id) ||
    getString(nestedResult?.id);
  const error =
    getString(record.error) ||
    getString(record.errorMessage) ||
    getString(nestedResult?.error) ||
    getString(nestedResult?.errorMessage);
  const output =
    record.output ??
    record.result ??
    record.content ??
    nestedResult?.output ??
    nestedResult?.content;
  const input =
    record.input ??
    record.args ??
    record.arguments ??
    nestedCall?.input ??
    nestedCall?.args ??
    nestedCall?.arguments;
  const status = error
    ? "error"
    : eventType.includes("result") || eventType.includes("end")
      ? "result"
      : "call";

  return {
    callId,
    eventType,
    input,
    name,
    output: error || output,
    raw: record,
    status,
    title: getToolEventTitle(eventType, name, status)
  };
}

function getToolEventTitle(
  eventType: string,
  name: string,
  status: PiToolEvent["status"]
): string {
  const toolName = name || eventType.replace(/^tool_/, "").replace(/_/g, " ");
  if (status === "error") {
    return `${toolName} failed`;
  }

  if (status === "result") {
    return `${toolName} result`;
  }

  return `${toolName} call`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function extractAssistantText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => extractAssistantText(item)).filter(Boolean).join("\n\n");
  }

  const record = asRecord(value);
  if (!record) {
    return "";
  }

  if (record.role && record.role !== "assistant") {
    return "";
  }

  const content = record.content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      const contentRecord = asRecord(item);
      if (!contentRecord) {
        return "";
      }

      if (contentRecord.type === "text") {
        return getString(contentRecord.text);
      }

      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function getRetryStatus(record: Record<string, unknown>): string {
  const attempt = typeof record.attempt === "number" ? record.attempt : undefined;
  const maxAttempts = typeof record.maxAttempts === "number"
    ? record.maxAttempts
    : undefined;
  const error = getString(record.errorMessage);
  const attemptText = attempt && maxAttempts
    ? ` ${attempt}/${maxAttempts}`
    : "";

  return `Pi auto-retry${attemptText}: ${error || "transient error"}`;
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}
