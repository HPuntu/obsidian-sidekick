import type { AgentToolEvent } from "../../agent/AgentSession";
import type { PiToolMode } from "../../types";
import type { PiToolEvent } from "./PiReadOnlyPrompt";
import type { VaultEditMode } from "../../agent/VaultToolHost";

/**
 * Native read tools. Bundled vault tool events are handled separately because
 * their write permission is enforced by the Obsidian host before execution.
 */
export const READ_ONLY_PI_TOOL_NAMES = new Set(["find", "grep", "ls", "read"]);

/**
 * Renders this setting as it appears on Pi's command line, for the audit log.
 * Enabling it adds no flag — it removes the four disabling ones — so the
 * enabled case must render as empty rather than inventing a flag that is never
 * passed. Kept in step with buildReadOnlyArgs in PiReadOnlyPrompt.
 */
export function formatPiUserConfigFlag(enabled: boolean): string {
  return enabled
    ? ""
    : "--no-extensions --no-skills --no-prompt-templates --no-context-files";
}

export function getPiToolNames(vaultMode?: VaultEditMode): string {
  const tools = "read,grep,find,ls";
  if (!vaultMode) return tools;
  return tools + (vaultMode === "reviewed" ? ",read_note,create_note,append_note,edit_note" : ",read_note");
}

export function formatPiToolFlag(toolMode: PiToolMode, vaultMode?: VaultEditMode): string {
  if (toolMode === "read-only") {
    return `--tools ${getPiToolNames(vaultMode)}`;
  }

  return "--no-tools";
}

export function describePiToolMode(toolMode: PiToolMode): string {
  if (toolMode === "read-only") {
    return "read-only tools: read, grep, find, ls";
  }

  return "tools disabled";
}

export function isPiToolSupportErrorStatus(message: string): boolean {
  return /does not support Pi\/Ollama tool calls/i.test(message);
}

/**
 * Strips the provider from a Pi model label to get the name Ollama knows.
 * Splits on the first "/" to match Pi's own parsing, so a model whose id
 * contains a slash survives intact.
 */
export function getOllamaModelName(modelLabel: string): string {
  const trimmed = modelLabel.trim();
  const separatorIndex = trimmed.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return trimmed;
  }

  return trimmed.slice(separatorIndex + 1);
}

/**
 * Per-phase lifecycle chatter from the RPC stream. It is still used to drive
 * run state, but showing every line buries the reply under a wall of statuses.
 * Anything not listed here (retries, extension errors, failures) is shown.
 */
const PI_RUN_PHASE_NOISE = [
  "Pi accepted the prompt.",
  "Pi run started.",
  "Pi run complete.",
  "Pi turn started.",
  "Model response started.",
  "Pi is reasoning."
];

export function isPiRunPhaseNoise(message: string): boolean {
  return PI_RUN_PHASE_NOISE.includes(message.trim());
}

export function isReadOnlyPiToolEvent(event: PiToolEvent): boolean {
  const toolName = event.name?.trim().toLowerCase();
  return toolName !== undefined && READ_ONLY_PI_TOOL_NAMES.has(toolName);
}

export function createPiToolEvent(event: PiToolEvent): AgentToolEvent {
  return {
    callId: event.callId,
    eventType: event.eventType,
    input: event.input,
    name: event.name,
    output: event.output,
    raw: event.raw,
    status: event.status,
    title: event.title
  };
}

/**
 * A tool event is Pi reporting a call it has already made, so this cannot and
 * does not prevent anything. It flags that Pi used a tool outside the mode the
 * plugin asked for, which is worth surfacing but must not read as "stopped".
 */
export function createUnexpectedToolEvent(event: PiToolEvent): AgentToolEvent {
  return {
    callId: event.callId,
    eventType: event.eventType,
    input: event.input,
    name: event.name,
    output: event.output,
    raw: event.raw,
    status: "blocked",
    title: `Ran outside allowlist: ${event.title}`
  };
}
