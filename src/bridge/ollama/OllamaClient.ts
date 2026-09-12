import { request as requestHttp } from "http";
import { request as requestHttps } from "https";

export type OllamaStatus = "unknown" | "checking" | "running" | "unreachable";

export interface OllamaModel {
  capabilities?: string[];
  name: string;
  modifiedAt?: string;
  size?: number;
}

export interface OllamaSnapshot {
  status: OllamaStatus;
  host: string;
  checkedAt?: string;
  error?: string;
  models: OllamaModel[];
  selectedModel?: string;
  selectedModelAvailable?: boolean;
  version?: string;
}

interface OllamaTagsResponse {
  models?: Array<{
    modified_at?: string;
    name?: string;
    size?: number;
  }>;
}

interface OllamaVersionResponse {
  version?: string;
}

interface OllamaShowResponse {
  capabilities?: string[];
}

export function createUnknownOllamaSnapshot(host: string): OllamaSnapshot {
  return {
    status: "unknown",
    host,
    models: []
  };
}

export function createCheckingOllamaSnapshot(host: string): OllamaSnapshot {
  return {
    status: "checking",
    host,
    models: []
  };
}

export async function checkOllama(
  host: string,
  selectedModel: string,
  timeoutMs = 2500
): Promise<OllamaSnapshot> {
  let normalizedHost: string;

  try {
    normalizedHost = normalizeHost(host);
  } catch (error) {
    return {
      status: "unreachable",
      host,
      checkedAt: new Date().toISOString(),
      error: getErrorMessage(error),
      models: [],
      selectedModel: selectedModel.trim() || undefined
    };
  }

  try {
    const [versionResponse, tagsResponse] = await Promise.all([
      requestJson<OllamaVersionResponse>(normalizedHost, "/api/version", timeoutMs),
      requestJson<OllamaTagsResponse>(normalizedHost, "/api/tags", timeoutMs)
    ]);

    const modelsWithoutCapabilities = (tagsResponse.models ?? [])
      .filter((model) => typeof model.name === "string" && model.name.length > 0)
      .map((model) => ({
        name: model.name ?? "",
        modifiedAt: model.modified_at,
        size: model.size
      }))
      .sort((first, second) => first.name.localeCompare(second.name));
    const models = await hydrateModelCapabilities(
      normalizedHost,
      modelsWithoutCapabilities,
      Math.max(800, timeoutMs)
    );

    const selected = selectedModel.trim();

    return {
      status: "running",
      host: normalizedHost,
      checkedAt: new Date().toISOString(),
      models,
      selectedModel: selected || undefined,
      selectedModelAvailable: selected
        ? models.some((model) => model.name === selected)
        : undefined,
      version: versionResponse.version
    };
  } catch (error) {
    return {
      status: "unreachable",
      host: normalizedHost,
      checkedAt: new Date().toISOString(),
      error: getErrorMessage(error),
      models: [],
      selectedModel: selectedModel.trim() || undefined
    };
  }
}

export interface OllamaUnloadResult {
  error?: string;
  model: string;
  success: boolean;
}

/**
 * Evicts a model from Ollama's memory. Ollama unloads on a generate request
 * carrying `keep_alive: 0`, which is what `ollama stop` does; there is no
 * dedicated unload endpoint.
 */
export async function unloadOllamaModel(
  host: string,
  model: string,
  timeoutMs = 5000
): Promise<OllamaUnloadResult> {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return { error: "No model selected.", model, success: false };
  }

  try {
    await requestJson<unknown>(
      normalizeHost(host),
      "/api/generate",
      timeoutMs,
      "POST",
      { keep_alive: 0, model: trimmedModel, prompt: "", stream: false }
    );
    const resident = await requestJson<OllamaTagsResponse>(normalizeHost(host), "/api/ps", timeoutMs);
    if (isModelResident(trimmedModel, resident.models ?? [])) {
      return { model: trimmedModel, success: false, error: "Ollama still reports this model as loaded. Try again after active requests finish." };
    }
    return { model: trimmedModel, success: true };
  } catch (error) {
    return {
      error: getErrorMessage(error),
      model: trimmedModel,
      success: false
    };
  }
}

export function isModelResident(model: string, resident: Array<{ name?: string; model?: string }>): boolean {
  const canonical = (name: string) => name.includes(":") ? name : `${name}:latest`;
  return resident.some((entry) => canonical(entry.name ?? entry.model ?? "") === canonical(model));
}

async function hydrateModelCapabilities(
  host: string,
  models: OllamaModel[],
  timeoutMs: number
): Promise<OllamaModel[]> {
  const limitedModels = models.slice(0, 16);
  const capabilityResults = await Promise.all(
    limitedModels.map(async (model) => {
      try {
        const response = await requestJson<OllamaShowResponse>(
          host,
          "/api/show",
          timeoutMs,
          "POST",
          { model: model.name }
        );
        return {
          ...model,
          capabilities: Array.isArray(response.capabilities)
            ? response.capabilities.filter(
                (capability): capability is string => typeof capability === "string"
              )
            : undefined
        };
      } catch {
        return model;
      }
    })
  );

  return [
    ...capabilityResults,
    ...models.slice(limitedModels.length)
  ];
}

function normalizeHost(host: string): string {
  const trimmed = host.trim() || "http://127.0.0.1:11434";
  const withProtocol = /^https?:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  const url = new URL(withProtocol);
  url.pathname = "";
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/$/, "");
}

function requestJson<T>(
  host: string,
  pathname: string,
  timeoutMs: number,
  method = "GET",
  body?: unknown
): Promise<T> {
  const url = new URL(pathname, host);
  const requester = url.protocol === "https:" ? requestHttps : requestHttp;

  return new Promise<T>((resolve, reject) => {
    const request = requester(
      url,
      {
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        method
      },
      (response) => {
        let body = "";

        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`Ollama returned HTTP ${statusCode}`));
            return;
          }

          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Ollama request timed out"));
    });
    request.on("error", reject);
    if (body !== undefined) {
      request.write(JSON.stringify(body));
    }
    request.end();
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
