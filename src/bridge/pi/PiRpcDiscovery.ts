import { spawn } from "child_process";
import path from "path";

import { piChildEnv } from "./piEnv";
import { THINKING_LEVELS, type ThinkingModel } from "./thinking";

export type PiRpcDiscoveryStatus = "checking" | "error" | "ready" | "unknown";
export const PI_DISCOVERY_TIMEOUT_MS = 15000;

export interface PiRpcModelSummary {
  thinkingLevelMap?: ThinkingModel["thinkingLevelMap"];
  contextWindow?: number;
  id?: string;
  label: string;
  name?: string;
  provider?: string;
  reasoning?: boolean;
}

export interface PiRpcDiscoverySnapshot {
  checkedAt?: string;
  commandCount?: number;
  currentModel?: string;
  error?: string;
  executablePath: string;
  isStreaming?: boolean;
  modelCount?: number;
  models: PiRpcModelSummary[];
  noSession: true;
  responseCount?: number;
  sessionId?: string;
  sessionName?: string;
  status: PiRpcDiscoveryStatus;
}

interface RpcResponse {
  command?: string;
  data?: unknown;
  id?: string;
  success?: boolean;
  type?: string;
}

const DISCOVERY_COMMANDS = [
  { id: "local-sidekick-get-state", type: "get_state" },
  { id: "local-sidekick-get-models", type: "get_available_models" }
];

export function createUnknownPiRpcDiscoverySnapshot(
  executablePath: string
): PiRpcDiscoverySnapshot {
  return {
    executablePath,
    models: [],
    noSession: true,
    status: "unknown"
  };
}

export function createCheckingPiRpcDiscoverySnapshot(
  executablePath: string
): PiRpcDiscoverySnapshot {
  return {
    executablePath,
    models: [],
    noSession: true,
    status: "checking"
  };
}

export async function discoverPiRpc(
  executablePath: string,
  timeoutMs = PI_DISCOVERY_TIMEOUT_MS,
  allowPiUserConfig = false
): Promise<PiRpcDiscoverySnapshot> {
  const normalizedPath = executablePath.trim() || "pi";
  const validationError = validateExecutablePath(normalizedPath);

  if (validationError) {
    return {
      checkedAt: new Date().toISOString(),
      error: validationError,
      executablePath: normalizedPath,
      models: [],
      noSession: true,
      status: "error"
    };
  }

  try {
    const responses = await runRpcDiscovery(
      normalizedPath,
      timeoutMs,
      allowPiUserConfig
    );
    const failedResponse = responses.find((response) => response.success === false);

    if (failedResponse) {
      return {
        checkedAt: new Date().toISOString(),
        commandCount: DISCOVERY_COMMANDS.length,
        error: `RPC ${failedResponse.command ?? "command"} failed.`,
        executablePath: normalizedPath,
        models: [],
        noSession: true,
        responseCount: responses.length,
        status: "error"
      };
    }

    return buildReadySnapshot(normalizedPath, responses);
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(),
      commandCount: DISCOVERY_COMMANDS.length,
      error: getErrorMessage(error),
      executablePath: normalizedPath,
      models: [],
      noSession: true,
      status: "error"
    };
  }
}

function runRpcDiscovery(
  executablePath: string,
  timeoutMs: number,
  allowPiUserConfig: boolean
): Promise<RpcResponse[]> {
  return new Promise((resolve, reject) => {
    const args = ["--mode", "rpc", "--no-session"];
    if (!allowPiUserConfig) {
      args.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files");
    }

    const child = spawn(executablePath, args, {
      env: piChildEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const responses = new Map<string, RpcResponse>();
    let settled = false;
    let stderr = "";
    let stdoutBuffer = "";

    const timeout = window.setTimeout(() => {
      rejectOnce(new Error(`Pi RPC discovery timed out. ${stderr}`.trim()));
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
      rejectOnce(error);
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }

      rejectOnce(
        new Error(
          `Pi RPC exited before discovery completed (code ${code ?? "none"}, signal ${signal ?? "none"}). ${stderr}`.trim()
        )
      );
    });

    for (const command of DISCOVERY_COMMANDS) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }

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

      if (!isRpcResponse(parsed) || !parsed.id) {
        return;
      }

      responses.set(parsed.id, parsed);

      if (DISCOVERY_COMMANDS.every((command) => responses.has(command.id))) {
        resolveOnce(DISCOVERY_COMMANDS.map((command) => responses.get(command.id)!));
      }
    }

    function resolveOnce(value: RpcResponse[]): void {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(value);
    }

    function rejectOnce(error: Error): void {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function cleanup(): void {
      window.clearTimeout(timeout);
      child.stdin.end();

      if (!child.killed) {
        child.kill();
      }
    }
  });
}

function buildReadySnapshot(
  executablePath: string,
  responses: RpcResponse[]
): PiRpcDiscoverySnapshot {
  const state = getResponseByCommand(responses, "get_state");
  const models = getResponseByCommand(responses, "get_available_models");
  const stateData = asRecord(state?.data);
  const modelsData = asRecord(models?.data);
  const modelList = Array.isArray(modelsData?.models) ? modelsData.models : [];
  const modelSummaries = modelList
    .map((model) => getModelSummary(model))
    .filter((model): model is PiRpcModelSummary => model !== undefined);
  const currentModel = getModelLabel(stateData?.model);

  return {
    checkedAt: new Date().toISOString(),
    commandCount: DISCOVERY_COMMANDS.length,
    currentModel,
    executablePath,
    isStreaming: typeof stateData?.isStreaming === "boolean"
      ? stateData.isStreaming
      : undefined,
    modelCount: modelSummaries.length,
    models: modelSummaries,
    noSession: true,
    responseCount: responses.length,
    sessionId: typeof stateData?.sessionId === "string"
      ? stateData.sessionId
      : undefined,
    sessionName: typeof stateData?.sessionName === "string"
      ? stateData.sessionName
      : undefined,
    status: "ready"
  };
}

function getResponseByCommand(
  responses: RpcResponse[],
  command: string
): RpcResponse | undefined {
  return responses.find((response) => response.command === command);
}

function getModelLabel(model: unknown): string | undefined {
  return getModelSummary(model)?.label;
}

function getModelSummary(model: unknown): PiRpcModelSummary | undefined {
  const modelRecord = asRecord(model);
  if (!modelRecord) {
    return undefined;
  }

  const provider = typeof modelRecord.provider === "string"
    ? modelRecord.provider
    : undefined;
  const id = typeof modelRecord.id === "string" ? modelRecord.id : undefined;
  const name = typeof modelRecord.name === "string"
    ? modelRecord.name
    : undefined;
  const contextWindow = typeof modelRecord.contextWindow === "number"
    ? modelRecord.contextWindow
    : undefined;
  const reasoning = typeof modelRecord.reasoning === "boolean"
    ? modelRecord.reasoning
    : undefined;

  const label = provider && id ? `${provider}/${id}` : id ?? name;

  if (!label) {
    return undefined;
  }

  return {
    contextWindow,
    thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.flatMap((level) => {
      const value = asRecord(modelRecord.thinkingLevelMap)?.[level];
      return value === null || typeof value === "string" ? [[level, value]] : [];
    })),
    id,
    label,
    name,
    provider,
    reasoning
  };
}

function isRpcResponse(value: unknown): value is RpcResponse {
  const record = asRecord(value);
  return record?.type === "response";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function stripTrailingCarriageReturn(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
