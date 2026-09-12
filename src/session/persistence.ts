import type { AgentEvent } from "../agent/AgentSession";
import { normalizeSidekickRoot } from "../agent/SidekickProfile";
import {
  AgentDashboardSettings,
  DEFAULT_SETTINGS
} from "../settings";
import type {
  AgentSessionHistoryItem,
  PersistedAgentSessionRecord,
  PersistedAgentSessionsState,
  PersistedAgentSessionState
} from "../types";
import { asPlainRecord, truncatePlainText } from "../util/text";

export function getPersistedSettings(
  data: unknown
): Partial<AgentDashboardSettings> {
  const record = asPlainRecord(data);
  if (!record) {
    return {};
  }

  // Pre-schemaVersion data stored settings at the top level.
  const settings = asPlainRecord(record.settings) ?? record;
  return migrateLegacySettingKeys(settings);
}

/** `allowPiUserConfig` was `piExperimentalFeaturesEnabled` before 1.0.0. */
const LEGACY_PI_USER_CONFIG_KEY = "piExperimentalFeaturesEnabled";

/**
 * Carries renamed keys forward. Without this a rename silently resets the
 * user's choice to the default on first load after upgrading.
 */
export function migrateLegacySettingKeys(
  settings: Record<string, unknown>
): Partial<AgentDashboardSettings> {
  const legacyValue = settings[LEGACY_PI_USER_CONFIG_KEY];
  if (
    settings.allowPiUserConfig === undefined &&
    typeof legacyValue === "boolean"
  ) {
    return {
      ...settings,
      allowPiUserConfig: legacyValue
    };
  }

  return settings;
}

export function getPersistedAgentSession(
  data: unknown
): PersistedAgentSessionState | undefined {
  return asPlainRecord(asPlainRecord(data)?.agentSession);
}

export function getPersistedAgentSessions(
  data: unknown
): PersistedAgentSessionsState | undefined {
  return asPlainRecord(asPlainRecord(data)?.agentSessions);
}

export function isPersistedAgentSessionRecord(
  value: unknown
): value is PersistedAgentSessionRecord {
  const record = asPlainRecord(value);
  return typeof record?.name === "string" && typeof record.title === "string";
}

export function getHistoryItemForSessionRecord(
  record: PersistedAgentSessionRecord
): AgentSessionHistoryItem {
  return {
    createdAt: record.createdAt,
    lastMessage: record.lastMessage ?? getSessionLastMessage(record.events ?? []),
    messageCount:
      record.messageCount ??
      record.piSessionMessageCount ??
      countConversationMessages(record.events ?? []),
    name: record.name,
    piSessionId: record.piSessionId,
    title: record.title,
    updatedAt: record.updatedAt ?? record.createdAt
  };
}

export function getSessionTitle(events: AgentEvent[], fallback: string): string {
  const userEvent = events.find((event) => event.kind === "user");
  const title = userEvent?.text.trim() || fallback;
  return truncatePlainText(title, 56);
}

export function getSessionLastMessage(events: AgentEvent[]): string {
  const event = [...events]
    .reverse()
    .find((item) => item.kind === "assistant" || item.kind === "user");
  return event ? truncatePlainText(event.text, 96) : "";
}

export function countConversationMessages(events: AgentEvent[]): number {
  return events.filter(
    (event) => event.kind === "assistant" || event.kind === "user"
  ).length;
}

export function createAgentSessionName(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace(/[^\dT]/g, "")
    .replace("T", "-");

  return `session-${stamp}`;
}

export function sanitizeSessionFileName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized || DEFAULT_SETTINGS.agentSessionName;
}

import { normalizeThinking } from "../bridge/pi/thinking";

export function normalizeSettings(
  settings: AgentDashboardSettings
): AgentDashboardSettings {
  return {
    ...settings,
    thinkingLevel: normalizeThinking(settings.thinkingLevel),
    agentSessionName:
      settings.agentSessionName?.trim() || DEFAULT_SETTINGS.agentSessionName,
    ollamaHost: settings.ollamaHost?.trim() || DEFAULT_SETTINGS.ollamaHost,
    piExecutablePath:
      settings.piExecutablePath?.trim() || DEFAULT_SETTINGS.piExecutablePath,
    piPromptTimeoutMinutes: normalizePiPromptTimeout(
      settings.piPromptTimeoutMinutes
    ),
    piToolMode: settings.piToolMode === "read-only" ? "read-only" : "disabled",
    allowPiUserConfig: settings.allowPiUserConfig === true,
    selectedAgentProfilePath: settings.selectedAgentProfilePath?.trim() ?? "",
    sidekickRootFolder: normalizeSidekickRoot(settings.sidekickRootFolder),
    safeCommandAllowlist:
      settings.safeCommandAllowlist ?? DEFAULT_SETTINGS.safeCommandAllowlist,
    webFetchAllowedHosts:
      settings.webFetchAllowedHosts ?? DEFAULT_SETTINGS.webFetchAllowedHosts,
    webFetchEnabled: settings.webFetchEnabled === true
  };
}

function normalizePiPromptTimeout(value: unknown): number {
  const timeout =
    typeof value === "number" ? value : DEFAULT_SETTINGS.piPromptTimeoutMinutes;
  if (!Number.isFinite(timeout)) {
    return DEFAULT_SETTINGS.piPromptTimeoutMinutes;
  }

  return Math.min(30, Math.max(2, Math.round(timeout)));
}
