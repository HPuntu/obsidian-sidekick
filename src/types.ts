import type { TFile } from "obsidian";

import type { AgentEvent } from "./agent/AgentSession";
import type { ProposedEditDiffLine } from "./agent/ProposedEdit";
import type { SidekickProfile } from "./agent/SidekickProfile";
import type { ApprovalRecord } from "./security/ApprovalQueue";
import type { AgentDashboardSettings } from "./settings";

export type AgentPromptContextMode = "none" | "note" | "selection" | "vault";
export type AgentDashboardAgentView = "chat" | "history";
export type PiToolMode = "disabled" | "read-only";

/**
 * A model Ollama has pulled but Pi did not report at discovery. Pi can only
 * activate models in its own configuration, so these are shown but not
 * selectable — otherwise set_model fails with "Model not found".
 */
export const UNKNOWN_TO_PI = "unknown-to-pi";

export interface PromptContextBlock {
  eventText: string;
  promptPrefix: string;
}

/** A prompt the user submitted while a run was in flight. */
export interface QueuedPrompt {
  contextMode: AgentPromptContextMode;
  prompt: string;
}

export interface MentionedVaultFileReference {
  end: number;
  file: TFile;
  mention: string;
  start: number;
}

export interface PromptToolDirective {
  kind: "cmd" | "index" | "links" | "search" | "semantic" | "url";
  value: string;
}

export interface PromptSidekickProfileSelection {
  profile?: SidekickProfile;
  prompt: string;
}

export interface AgentSessionHistoryItem {
  createdAt: string;
  lastMessage: string;
  messageCount?: number;
  name: string;
  piSessionId?: string;
  title: string;
  updatedAt: string;
}

export type ProposedEditStatus =
  | "applying"
  | "cancelled"
  | "applied"
  | "apply-error"
  | "approved"
  | "denied"
  | "pending-approval";

export interface ProposedEditRecord {
  source?: "agent-tool";
  approvalId?: string;
  applyError?: string;
  createdAt: string;
  diffLines: ProposedEditDiffLine[];
  eventId: string;
  fileExists: boolean;
  id: string;
  originalText: string;
  path: string;
  replacementText: string;
  status: ProposedEditStatus;
}

export interface PersistedAgentDashboardData {
  agentSession?: PersistedAgentSessionState;
  agentSessions?: PersistedAgentSessionsState;
  schemaVersion?: number;
  settings?: Partial<AgentDashboardSettings>;
}

export interface PersistedAgentSessionsState {
  currentSessionName?: string;
  records?: PersistedAgentSessionRecord[];
  viewMode?: AgentDashboardAgentView;
}

export interface PersistedAgentSessionRecord extends PersistedAgentSessionState {
  createdAt: string;
  lastMessage?: string;
  messageCount?: number;
  name: string;
  title: string;
}

export interface PersistedAgentSessionState {
  agentEventCounter?: number;
  approvalCounter?: number;
  approvalRecords?: ApprovalRecord[];
  events?: AgentEvent[];
  piSessionId?: string;
  piSessionMessageCount?: number;
  piSessionPath?: string;
  pinnedContextPaths?: string[];
  proposedEditCounter?: number;
  proposedEdits?: ProposedEditRecord[];
  updatedAt?: string;
}
