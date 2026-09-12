export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type ThinkingPreference = ThinkingLevel | "default";

export interface ThinkingModel {
  provider?: string;
  id?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export function normalizeThinking(value: unknown): ThinkingPreference {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? value as ThinkingLevel : "medium";
}

export function supportedThinkingLevels(model?: ThinkingModel): ThinkingLevel[] {
  if (!model?.reasoning) return [];
  const levels: readonly ThinkingLevel[] = model.provider === "ollama"
    ? ["off", "low", "medium", "high", "xhigh"]
    : THINKING_LEVELS;
  return levels.filter((level) => {
    if (model.thinkingLevelMap?.[level] === null) return false;
    if (level === "xhigh") return typeof model.thinkingLevelMap?.xhigh === "string";
    if (model.provider === "ollama" && level === "off") {
      return !model.id?.startsWith("gpt-oss") && typeof model.thinkingLevelMap?.off === "string";
    }
    return true;
  });
}

export function resolveThinking(value: ThinkingPreference, model?: ThinkingModel): ThinkingPreference {
  const levels = supportedThinkingLevels(model);
  const preferred = normalizeThinking(value);
  if (preferred !== "default" && levels.includes(preferred)) return preferred;
  return levels.includes("medium") ? "medium" : levels.find((level) => level !== "off") ?? "default";
}
