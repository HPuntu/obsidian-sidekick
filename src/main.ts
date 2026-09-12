import { resolveThinking } from "./bridge/pi/thinking";
import {
  FileSystemAdapter,
  MarkdownFileInfo,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import path from "path";

import {
  AgentEvent,
  AgentEventKind,
  AgentSessionStatus,
  AgentToolEvent,
  createAgentEvent
} from "./agent/AgentSession";
import {
  createLineDiff,
  parseProposedEditsFromMarkdown
} from "./agent/ProposedEdit";
import {
  buildPiPromptTemplate,
  buildPiSkillResource,
  mergeStringSetting,
  sanitizePiResourceName
} from "./agent/piResources";
import {
  findSidekickProfile,
  getSidekickProfileDisplayName,
  getSidekickProfileSlug,
  getStarterSidekickFiles,
  loadSidekickProfiles,
  normalizeSidekickRoot,
  SidekickProfile
} from "./agent/SidekickProfile";
import {
  checkOllama,
  createCheckingOllamaSnapshot,
  createUnknownOllamaSnapshot,
  OllamaSnapshot,
  unloadOllamaModel
} from "./bridge/ollama/OllamaClient";
import {
  createCheckingPiSnapshot,
  createUnknownPiSnapshot,
  PiSnapshot,
  probePiExecutable
} from "./bridge/pi/PiProbe";
import {
  createCheckingPiRpcDiscoverySnapshot,
  createUnknownPiRpcDiscoverySnapshot,
  discoverPiRpc,
  PiRpcDiscoverySnapshot
} from "./bridge/pi/PiRpcDiscovery";
import {
  PiReadOnlyPromptRun,
  PiSessionState,
  setPiRpcModel
} from "./bridge/pi/PiReadOnlyPrompt";
import {
  createUnexpectedToolEvent,
  createPiToolEvent,
  describePiToolMode,
  formatPiUserConfigFlag,
  formatPiToolFlag,
  getOllamaModelName,
  isPiRunPhaseNoise,
  isPiToolSupportErrorStatus,
  isReadOnlyPiToolEvent
} from "./bridge/pi/piFlags";
import { buildChatExportMarkdown } from "./export/chatExport";
import { registerAgentDashboardBlock } from "./markdown/agentDashboardBlock";
import {
  normalizeMentionedPath,
  scoreVaultFileSuggestion
} from "./prompt/mentions";
import { looksLikeEditRequest } from "./prompt/editIntent";
import {
  buildDirectiveContext,
  buildMentionedFileContext,
  buildNoteContext,
  buildPinnedContext,
  buildSidekickProfileContext,
  buildVaultSearchContext,
  PromptContextDeps
} from "./prompt/buildContext";
import {
  getEditProposalInstructions,
  getVaultGroundingInstructions,
} from "./prompt/promptContext";
import {
  ApprovalRecord,
  countPendingApprovals,
  createApprovalRecord
} from "./security/ApprovalQueue";
import {
  assessSafetyRequest,
  describeSafetyRequest,
  parseExternalRoots,
  SafetyDecision,
  SafetyRequest,
  SafetySnapshot,
  summarizeAllowedRoots
} from "./security/SafetyPolicy";
import {
  countConversationMessages,
  createAgentSessionName,
  getHistoryItemForSessionRecord,
  getPersistedAgentSession,
  getPersistedAgentSessions,
  getPersistedSettings,
  getSessionLastMessage,
  getSessionTitle,
  isPersistedAgentSessionRecord,
  normalizeSettings,
  sanitizeSessionFileName
} from "./session/persistence";
import {
  AgentDashboardSettingTab,
  AgentDashboardSettings,
  DEFAULT_SETTINGS
} from "./settings";
import {
  formatInternalLinkSuggestions,
  proposeInternalLinksForFile
} from "./tools/InternalLinks";
import type {
  AgentDashboardAgentView,
  AgentPromptContextMode,
  AgentSessionHistoryItem,
  PersistedAgentDashboardData,
  PersistedAgentSessionRecord,
  PersistedAgentSessionState,
  PiToolMode,
  PromptContextBlock,
  PromptSidekickProfileSelection,
  QueuedPrompt,
  ProposedEditRecord
} from "./types";
import { AgentChatExportModal } from "./ui/modals/AgentChatExportModal";
import { confirmLocalRisk } from "./ui/modals/ConfirmationModal";
import {
  asPlainRecord,
  getErrorMessage,
  getMaxIdCounter,
  sanitizeProjectIndexText,
} from "./util/text";
import {
  normalizeChatExportPath,
  normalizeProposedEditPath,
  normalizeVaultFolderPath,
  slugifyFileName
} from "./util/vaultPath";
import {
  AGENT_DASHBOARD_VIEW_TYPE,
  AgentDashboardView
} from "./views/AgentDashboardView";

const MAX_SIDEKICK_PROJECT_INDEX_FILES = 500;
const MAX_SIDEKICK_PROJECT_INDEX_HEADINGS_PER_FILE = 8;
const DEFAULT_CHAT_EXPORT_FOLDER = "Chats";

export type {
  AgentDashboardAgentView,
  AgentPromptContextMode,
  AgentSessionHistoryItem,
  ProposedEditRecord,
  ProposedEditStatus
} from "./types";

export default class AgentDashboardPlugin extends Plugin {
  agentEvents: AgentEvent[] = [];
  agentSessionStatus: AgentSessionStatus = "idle";
  approvalRecords: ApprovalRecord[] = [];
  lastSafetyDecision?: SafetyDecision;
  ollamaSnapshot: OllamaSnapshot = createUnknownOllamaSnapshot(
    DEFAULT_SETTINGS.ollamaHost
  );
  piSnapshot: PiSnapshot = createUnknownPiSnapshot(
    DEFAULT_SETTINGS.piExecutablePath
  );
  piRpcDiscoverySnapshot: PiRpcDiscoverySnapshot =
    createUnknownPiRpcDiscoverySnapshot(DEFAULT_SETTINGS.piExecutablePath);
  safetyAuditLog: SafetyDecision[] = [];
  settings: AgentDashboardSettings = DEFAULT_SETTINGS;
  proposedEdits: ProposedEditRecord[] = [];
  agentSessionHistory: AgentSessionHistoryItem[] = [];
  agentViewMode: AgentDashboardAgentView = "history";
  sidekickProfiles: SidekickProfile[] = [];
  piSessionId?: string;
  piSessionMessageCount?: number;
  piSessionPath?: string;
  /** Held while a run is in flight, dispatched at the turn boundary. */
  queuedPrompt?: QueuedPrompt;
  /** Backs resend and edit-last. */
  lastSubmittedPrompt?: QueuedPrompt;
  /** Vault files attached to every prompt in this session. */
  pinnedContextPaths: string[] = [];
  private agentEventCounter = 0;
  private approvalCounter = 0;
  private proposedEditCounter = 0;
  private activePromptRun?: PiReadOnlyPromptRun;
  private pendingPiDiscovery?: Promise<void>;
  pipelineStopped = false;
  pipelineStopping = false;
  private confirmedPiExecutablePaths = new Set<string>([DEFAULT_SETTINGS.piExecutablePath]);
  private agentSessionRecords: PersistedAgentSessionRecord[] = [];
  private lastMarkdownFileInfo: MarkdownFileInfo | null = null;
  private savePluginDataTimeout?: number;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.ollamaSnapshot = createUnknownOllamaSnapshot(this.settings.ollamaHost);
    this.piSnapshot = createUnknownPiSnapshot(this.settings.piExecutablePath);
    this.piRpcDiscoverySnapshot = createUnknownPiRpcDiscoverySnapshot(
      this.settings.piExecutablePath
    );
    await this.refreshSidekickProfiles();

    this.addAgentEvent(
      "status",
      `Persistent agent session ready: ${this.settings.agentSessionName}. Shell commands and deletes are blocked; approved vault Markdown edits can be applied.`
    );
    this.agentViewMode = "history";

    this.registerView(
      AGENT_DASHBOARD_VIEW_TYPE,
      (leaf) => new AgentDashboardView(leaf, this)
    );

    registerAgentDashboardBlock(this);
    this.addSettingTab(new AgentDashboardSettingTab(this.app, this));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.rememberActiveMarkdownFileInfo();
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, info) => {
        if (info.file) {
          this.lastMarkdownFileInfo = info;
        }
      })
    );

    this.addRibbonIcon("bot", "Open Local Sidekick", async () => {
      await this.activateView();
    });

    this.addCommand({
      id: "open-sidekick",
      name: "Open Sidekick",
      callback: async () => {
        await this.activateView();
      }
    });

    this.addCommand({
      id: "insert-sidekick-block",
      name: "Insert Sidekick block",
      editorCallback: (editor) => {
        editor.replaceSelection(
          [
            "```sidekick",
            "workspace: vault",
            "mode: compact",
            "session: default",
            "```"
          ].join("\n")
        );
      }
    });



    this.addCommand({
      id: "check-ollama-status",
      name: "Check Ollama status",
      callback: async () => {
        await this.refreshOllamaStatus(true);
      }
    });

    this.addCommand({
      id: "check-pi-executable",
      name: "Check Pi executable",
      callback: async () => {
        await this.refreshPiStatus(true);
      }
    });

    this.addCommand({
      id: "discover-pi-rpc",
      name: "Discover Pi RPC",
      callback: async () => {
        await this.refreshPiRpcDiscovery(true);
      }
    });

    this.addCommand({
      id: "stop-agent-run",
      name: "Stop agent run",
      callback: () => {
        this.stopAgentRun();
      }
    });

    this.addCommand({
      id: "clear-agent-events",
      name: "Clear agent events",
      callback: () => {
        this.clearAgentEvents();
      }
    });

    this.addCommand({
      id: "start-new-agent-session",
      name: "Start new persistent agent session",
      callback: () => {
        void this.startNewAgentSession();
      }
    });

    this.addCommand({
      id: "refresh-sidekick-profiles",
      name: "Refresh Sidekick agent profiles",
      callback: async () => {
        await this.refreshSidekickProfiles(true);
      }
    });

    this.addCommand({
      id: "create-sidekick-starter-files",
      name: "Create Sidekick starter files",
      callback: async () => {
        await this.createSidekickStarterFiles();
      }
    });

    this.addCommand({
      id: "refresh-sidekick-project-index",
      name: "Refresh Sidekick project index",
      callback: async () => {
        await this.refreshSidekickProjectIndex();
      }
    });

    this.addCommand({
      id: "export-sidekick-pi-resources",
      name: "Export Sidekick Pi resources",
      callback: async () => {
        await this.exportSidekickPiResources();
      }
    });

    this.addCommand({
      id: "export-agent-chat",
      name: "Export active agent chat to Markdown",
      callback: () => {
        this.openChatExportModal();
      }
    });

    this.addCommand({
      id: "suggest-internal-links",
      name: "Suggest internal links for current note",
      callback: () => {
        void this.suggestInternalLinksForActiveNote();
      }
    });

    this.addCommand({
      id: "run-agent-safety-self-check",
      name: "Run agent safety self-check",
      callback: () => {
        this.runSafetySelfCheck();
      }
    });


    void this.refreshOllamaStatus(false);

    new Notice("Local Sidekick loaded");
  }

  onunload(): void {
    if (this.activePromptRun) {
      this.activePromptRun.abort();
      this.activePromptRun = undefined;
    }

    void this.flushPluginDataSave();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(AGENT_DASHBOARD_VIEW_TYPE)[0] ?? null;

    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) {
        leaf = workspace.getLeaf(true);
      }

      if (!leaf) {
        new Notice("Unable to open Local Sidekick");
        return;
      }

      await leaf.setViewState({
        type: AGENT_DASHBOARD_VIEW_TYPE,
        active: true
      });
    }

    await workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    const data: unknown = await this.loadData();
    const settings = getPersistedSettings(data);
    this.settings = normalizeSettings(
      Object.assign({}, DEFAULT_SETTINGS, settings)
    );
    this.restorePersistedAgentSessions(data);
  }

  async saveSettings(): Promise<void> {
    await this.savePluginData();
  }

  resetPiSessionMetadata(): void {
    this.piSessionId = undefined;
    this.piSessionMessageCount = undefined;
    this.piSessionPath = undefined;
    this.queuePluginDataSave();
  }

  async startNewAgentSession(): Promise<void> {
    if (this.agentSessionStatus === "running") {
      new Notice("Stop the current agent run before starting a new session");
      return;
    }

    this.saveCurrentSessionToHistory();
    this.settings.agentSessionName = createAgentSessionName();
    this.resetPiSessionMetadata();
    this.agentEvents = [];
    this.approvalRecords = [];
    this.proposedEdits = [];
    this.agentEventCounter = 0;
    this.approvalCounter = 0;
    this.proposedEditCounter = 0;
    this.pinnedContextPaths = [];
    this.queuedPrompt = undefined;
    this.lastSubmittedPrompt = undefined;
    this.agentViewMode = "chat";
    this.addAgentEvent(
      "status",
      `Started new persistent agent session: ${this.settings.agentSessionName}.`
    );
    await this.savePluginData();
    this.refreshDashboardViews();
  }

  async openAgentSession(name: string): Promise<void> {
    if (this.agentSessionStatus === "running") {
      new Notice("Stop the current agent run before switching sessions");
      return;
    }

    this.saveCurrentSessionToHistory();
    const session = this.getPersistedSessionRecord(name);
    if (!session) {
      new Notice(`Session not found: ${name}`);
      return;
    }

    this.restorePersistedAgentSession(session);
    this.settings.agentSessionName = session.name;
    this.queuedPrompt = undefined;
    this.lastSubmittedPrompt = undefined;
    this.agentViewMode = "chat";
    await this.savePluginData();
    this.refreshDashboardViews();
  }

  async showAgentHistory(): Promise<void> {
    if (this.agentSessionStatus === "running") {
      new Notice("Stop the current agent run before leaving chat");
      return;
    }

    this.saveCurrentSessionToHistory();
    this.agentViewMode = "history";
    await this.savePluginData();
    this.refreshDashboardViews();
  }

  async showActiveAgentSession(): Promise<void> {
    this.agentViewMode = "chat";
    await this.savePluginData();
    this.refreshDashboardViews();
  }

  getAgentSessionHistory(): AgentSessionHistoryItem[] {
    this.saveCurrentSessionToHistory();
    return [...this.agentSessionHistory].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    );
  }

  getAgentSessionSummary(): string {
    const parts = [this.settings.agentSessionName || DEFAULT_SETTINGS.agentSessionName];

    if (this.piSessionMessageCount !== undefined) {
      parts.push(`${this.piSessionMessageCount} messages`);
    }

    if (this.piSessionId) {
      parts.push(this.piSessionId.slice(0, 8));
    }

    return parts.join(" · ");
  }

  async refreshSidekickProfiles(showNotice = false): Promise<void> {
    this.sidekickProfiles = await loadSidekickProfiles(
      this.app,
      this.settings.sidekickRootFolder
    );

    let shouldSaveSettings = false;
    if (
      this.settings.selectedAgentProfilePath &&
      !this.getSelectedSidekickProfile()
    ) {
      this.settings.selectedAgentProfilePath = "";
      shouldSaveSettings = true;
    }

    const selectedProfile = this.getSelectedSidekickProfile();
    if (
      selectedProfile &&
      selectedProfile.modelLabels.length > 0 &&
      !selectedProfile.modelLabels.includes(this.settings.selectedPiModel)
    ) {
      this.settings.selectedPiModel = selectedProfile.modelLabels[0];
      shouldSaveSettings = true;
    }

    if (shouldSaveSettings) {
      await this.saveSettings();
    }

    if (showNotice) {
      new Notice(
        `Loaded ${this.sidekickProfiles.length} Sidekick agent profile${this.sidekickProfiles.length === 1 ? "" : "s"}.`
      );
    }

    this.refreshDashboardViews();
  }

  getSidekickProfiles(): SidekickProfile[] {
    return [...this.sidekickProfiles];
  }

  getSelectedSidekickProfile(): SidekickProfile | undefined {
    if (!this.settings.selectedAgentProfilePath) {
      return undefined;
    }

    return findSidekickProfile(
      this.sidekickProfiles,
      this.settings.selectedAgentProfilePath
    );
  }


  async selectSidekickProfile(profilePath: string): Promise<void> {
    await this.refreshSidekickProfiles();
    const profile = profilePath
      ? findSidekickProfile(this.sidekickProfiles, profilePath)
      : undefined;

    if (profilePath && !profile) {
      new Notice(`Sidekick agent profile not found: ${profilePath}`);
      return;
    }

    this.settings.selectedAgentProfilePath = profile?.path ?? "";
    if (profile && profile.modelLabels.length > 0) {
      this.settings.selectedPiModel = profile.modelLabels.includes(this.settings.selectedPiModel)
        ? this.settings.selectedPiModel
        : profile.modelLabels[0];
    }

    await this.saveSettings();
    this.addAgentEvent(
      "status",
      profile
        ? `Selected Sidekick agent profile: ${getSidekickProfileDisplayName(profile)}.`
        : "Cleared Sidekick agent profile."
    );
    this.refreshDashboardViews();
  }

  async createSidekickStarterFiles(): Promise<void> {
    const files = getStarterSidekickFiles(this.settings.sidekickRootFolder);
    let created = 0;
    let skipped = 0;
    for (const file of files) {
      await this.ensureVaultFolder(path.posix.dirname(file.path));
      if (this.app.vault.getFileByPath(file.path)) {
        skipped += 1;
        continue;
      }

      await this.app.vault.create(file.path, file.content);
      created += 1;
    }

    await this.refreshSidekickProjectIndex(false);
    await this.refreshSidekickProfiles();
    new Notice(`Sidekick starter files: ${created} created, ${skipped} already existed.`);
  }

  async refreshSidekickProjectIndex(showNotice = true): Promise<void> {
    const root = normalizeSidekickRoot(this.settings.sidekickRootFolder);
    const indexPath = root + "/Memory/project-index.md";
    await this.ensureVaultFolder(path.posix.dirname(indexPath));
    const contents = this.buildSidekickProjectIndex(indexPath);
    const existing = this.app.vault.getFileByPath(indexPath);
    if (existing) {
      await this.app.vault.modify(existing, contents);
    } else {
      await this.app.vault.create(indexPath, contents);
    }

    if (showNotice) {
      new Notice(`Refreshed ${indexPath}.`);
    }
  }

  async exportSidekickPiResources(): Promise<void> {
    await this.refreshSidekickProfiles();
    if (this.sidekickProfiles.length === 0) {
      new Notice("Create or refresh Sidekick agent profiles before exporting Pi resources.");
      return;
    }

    await this.ensureVaultFolder(".pi/prompts");
    await this.ensureVaultFolder(".pi/skills/sidekick-vault-linker");
    await this.ensureVaultFolder(".pi/skills/sidekick-glossary-curator");

    let promptCount = 0;
    for (const profile of this.sidekickProfiles) {
      const promptPath = `.pi/prompts/${sanitizePiResourceName(getSidekickProfileSlug(profile))}.md`;
      await this.upsertVaultFile(promptPath, buildPiPromptTemplate(profile));
      promptCount += 1;
    }

    await this.upsertVaultFile(
      ".pi/skills/sidekick-vault-linker/SKILL.md",
      buildPiSkillResource(
        "sidekick-vault-linker",
        "Suggest conservative Obsidian internal links between related notes.",
        [
          "Use the vault project index, glossary, filenames, and headings as evidence.",
          "Suggest links only for meaningful terms that clearly correspond to existing notes or top-level concepts.",
          "Do not link common words or weak matches.",
          "When used through Local Sidekick, prefer reviewed edit blocks for proposed link changes."
        ]
      )
    );
    await this.upsertVaultFile(
      ".pi/skills/sidekick-glossary-curator/SKILL.md",
      buildPiSkillResource(
        "sidekick-glossary-curator",
        "Create and maintain a grounded glossary for an Obsidian vault.",
        [
          "Only add terms that are supported by supplied note context.",
          "For each term, include a short definition and source note path when available.",
          "Prefer concise definitions over speculation.",
          "When used through Local Sidekick, prefer reviewed edit blocks for glossary updates."
        ]
      )
    );

    const settings = await this.buildMergedPiSettings();
    if (!settings) {
      return;
    }
    await this.upsertVaultFile(".pi/settings.json", settings);

    new Notice(`Exported ${promptCount} Sidekick prompt template(s) and 2 skills to .pi/.`);
  }

  private async buildMergedPiSettings(): Promise<string | undefined> {
    const settingsPath = ".pi/settings.json";
    const existing = this.app.vault.getFileByPath(settingsPath);
    let data: Record<string, unknown> = {};
    if (existing) {
      const raw = (await this.app.vault.cachedRead(existing)).trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          const record = asPlainRecord(parsed);
          if (record) {
            data = record;
          } else {
            throw new Error("Pi settings must be a JSON object.");
          }
        } catch (error) {
          new Notice(`Could not merge .pi/settings.json: ${getErrorMessage(error)}`);
          return undefined;
        }
      }
    }

    data.prompts = mergeStringSetting(data.prompts, "prompts");
    data.skills = mergeStringSetting(data.skills, "skills");
    return JSON.stringify(data, null, 2) + "\n";
  }

  private async upsertVaultFile(vaultPath: string, contents: string): Promise<void> {
    const existing = this.app.vault.getFileByPath(vaultPath);
    if (existing) {
      await this.app.vault.modify(existing, contents);
      return;
    }

    await this.app.vault.create(vaultPath, contents);
  }

  private buildSidekickProjectIndex(indexPath: string): string {
    const markdownFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path !== indexPath)
      .sort((left, right) => left.path.localeCompare(right.path));
    const indexedFiles = markdownFiles.slice(0, MAX_SIDEKICK_PROJECT_INDEX_FILES);
    const lines = [
      "# Project Index",
      "",
      "Generated by Local Sidekick: " + new Date().toISOString(),
      "Markdown files indexed: " + indexedFiles.length.toLocaleString() +
        (markdownFiles.length > indexedFiles.length
          ? " of " + markdownFiles.length.toLocaleString()
          : ""),
      "",
      "This file is generated from vault filenames and top headings. Edit durable summaries in `vault-summary.md`, `user-preferences.md`, and `glossary.md` instead.",
      "",
      "## Files"
    ];

    for (const file of indexedFiles) {
      lines.push("- " + file.path);
      const headings = (this.app.metadataCache.getFileCache(file)?.headings ?? [])
        .filter((heading) => heading.level <= 2)
        .slice(0, MAX_SIDEKICK_PROJECT_INDEX_HEADINGS_PER_FILE);
      for (const heading of headings) {
        lines.push(
          "  - " + "#".repeat(heading.level) + " " + sanitizeProjectIndexText(heading.heading)
        );
      }
    }

    if (markdownFiles.length > indexedFiles.length) {
      lines.push("", "_Index truncated. Narrow the Sidekick root or refresh from a smaller vault if needed._");
    }

    return lines.join("\n") + "\n";
  }

  getSuggestedChatExportPath(): string {
    const record = this.createCurrentSessionRecord();
    const title = record.title || this.settings.agentSessionName || "chat";
    const fileName = `${slugifyFileName(title)}.md`;
    return `${DEFAULT_CHAT_EXPORT_FOLDER}/${fileName}`;
  }

  openChatExportModal(): void {
    if (countConversationMessages(this.agentEvents) === 0) {
      new Notice("No chat messages to export yet");
      return;
    }

    new AgentChatExportModal(this.app, this).open();
  }

  async exportActiveAgentChat(exportPath: string): Promise<void> {
    if (this.agentSessionStatus === "running") {
      new Notice("Stop the current agent run before exporting");
      return;
    }

    const record = this.createCurrentSessionRecord();
    if (countConversationMessages(record.events ?? []) === 0) {
      new Notice("No chat messages to export yet");
      return;
    }

    let normalizedPath: string;
    try {
      normalizedPath = normalizeChatExportPath(exportPath);
    } catch (error) {
      new Notice(getErrorMessage(error));
      return;
    }

    const folderPath = path.posix.dirname(normalizedPath);
    if (folderPath && folderPath !== ".") {
      await this.ensureVaultFolder(folderPath);
    }

    const outputPath = await this.getAvailableVaultPath(normalizedPath);
    const markdown = buildChatExportMarkdown(record, {
      exportedAt: new Date().toISOString(),
      model: this.settings.selectedPiModel,
      pluginVersion: this.manifest.version
    });

    await this.app.vault.create(outputPath, markdown);
    new Notice(`Exported chat to ${outputPath}`);

    const exportedFile = this.app.vault.getFileByPath(outputPath);
    if (exportedFile) {
      await this.app.workspace.getLeaf(false).openFile(exportedFile);
    }
  }

  resetOllamaStatus(): void {
    this.ollamaSnapshot = createUnknownOllamaSnapshot(this.settings.ollamaHost);
    this.refreshDashboardViews();
  }

  resetPiStatus(): void {
    this.piSnapshot = createUnknownPiSnapshot(this.settings.piExecutablePath);
    this.piRpcDiscoverySnapshot = createUnknownPiRpcDiscoverySnapshot(
      this.settings.piExecutablePath
    );
    this.refreshDashboardViews();
  }

  async refreshOllamaStatus(showNotice: boolean): Promise<void> {
    this.ollamaSnapshot = createCheckingOllamaSnapshot(this.settings.ollamaHost);
    this.refreshDashboardViews();

    this.ollamaSnapshot = await checkOllama(
      this.settings.ollamaHost,
      this.settings.defaultModel
    );
    this.refreshDashboardViews();

    if (!showNotice) {
      return;
    }

    if (this.ollamaSnapshot.status === "running") {
      new Notice(
        `Ollama reachable: ${this.ollamaSnapshot.models.length} model(s) found`
      );
      return;
    }

    new Notice(`Ollama unreachable: ${this.ollamaSnapshot.error}`);
  }

  async refreshPiStatus(showNotice: boolean): Promise<void> {
    if (!(await this.confirmPiExecutableForSession("check Pi executable"))) {
      return;
    }

    this.assessSafetyRequest({
      kind: "diagnostic",
      command: `${this.settings.piExecutablePath} --version`,
      description: "Check Pi executable"
    });
    this.piSnapshot = createCheckingPiSnapshot(this.settings.piExecutablePath);
    this.refreshDashboardViews();

    this.piSnapshot = await probePiExecutable(
      this.settings.piExecutablePath
    );
    this.refreshDashboardViews();

    if (!showNotice) {
      return;
    }

    if (this.piSnapshot.status === "available") {
      new Notice(`Pi executable available: ${this.piSnapshot.version}`);
      return;
    }

    new Notice(`Pi executable unavailable: ${this.piSnapshot.error}`);
  }

  async refreshPiRpcDiscovery(showNotice: boolean): Promise<void> {
    if (!this.pendingPiDiscovery) {
      this.pendingPiDiscovery = this.runPiRpcDiscovery().finally(() => {
        this.pendingPiDiscovery = undefined;
      });
    }
    await this.pendingPiDiscovery;
    if (showNotice) {
      new Notice(this.piRpcDiscoverySnapshot.status === "ready"
        ? "Pi RPC discovery ready"
        : `Pi RPC discovery failed: ${this.piRpcDiscoverySnapshot.error}`);
    }
  }

  private async runPiRpcDiscovery(): Promise<void> {
    if (!(await this.confirmPiExecutableForSession("discover Pi RPC"))) {
      return;
    }


    this.assessSafetyRequest({
      kind: "diagnostic",
      command: `${this.settings.piExecutablePath} --mode rpc --no-session ${formatPiUserConfigFlag(this.settings.allowPiUserConfig)}`,
      description: "Discover Pi RPC readiness"
    });
    this.piRpcDiscoverySnapshot = {
      ...createCheckingPiRpcDiscoverySnapshot(this.settings.piExecutablePath),
      models: this.piRpcDiscoverySnapshot.models,
      currentModel: this.piRpcDiscoverySnapshot.currentModel
    };
    this.refreshDashboardViews();

    this.piRpcDiscoverySnapshot = await discoverPiRpc(
      this.settings.piExecutablePath,
      undefined,
      this.settings.allowPiUserConfig
    );
    this.refreshDashboardViews();

    if (this.piRpcDiscoverySnapshot.status === "ready") {
      this.selectDefaultPiModelIfNeeded();
    }
  }

  async startPipeline(): Promise<void> {
    if (this.pipelineStopping) return;
    this.pipelineStopped = false;
    // Boot the full local pipeline behind one action: check Ollama, probe Pi,
    // discover the RPC models, start the bridge, then activate a model.
    await this.refreshOllamaStatus(false);
    await this.refreshPiStatus(false);
    await this.refreshPiRpcDiscovery(false);
    this.selectDefaultPiModelIfNeeded();

    const model = this.settings.selectedPiModel;
    if (model && this.agentSessionStatus !== "running") {
      await this.selectPiModel(model);
    }

    new Notice(
      this.piRpcDiscoverySnapshot.status === "ready"
        ? `Sidekick started${model ? ` with ${model}` : ""}.`
        : "Sidekick start incomplete — check the status menu."
    );
    this.refreshDashboardViews();
  }

  /**
   * Tears the pipeline down: stops any run, closes the bridge, and evicts the
   * model from Ollama so its memory is actually released. Ollama holds a model
   * resident on its own timer, so without the eviction this frees nothing.
   */
  async shutdownPipeline(): Promise<void> {
    if (this.pipelineStopping) return;
    this.pipelineStopping = true;
    this.stopAgentRun();
    this.refreshDashboardViews();

    try {

    const model = getOllamaModelName(this.settings.selectedPiModel);
    if (!model) {
      this.pipelineStopped = true;
      new Notice("Sidekick stopped.");
      this.refreshDashboardViews();
      return;
    }

    const result = await unloadOllamaModel(this.settings.ollamaHost, model);
    this.pipelineStopped = result.success;
    new Notice(
      result.success
        ? `Sidekick stopped and unloaded ${result.model}.`
        : `Sidekick stopped. Could not unload ${result.model}: ${result.error}`
    );

    await this.refreshOllamaStatus(false);
    } finally {
      this.pipelineStopping = false;
      this.refreshDashboardViews();
    }
  }

  async sendAgentPrompt(
    prompt: string,
    contextMode: AgentPromptContextMode = "none"
  ): Promise<boolean> {
    if (this.pipelineStopping) {
      new Notice("Wait for the model to finish unloading.");
      return false;
    }
    let trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      new Notice("Enter a prompt first");
      return false;
    }

    // Typing ahead is the point: hold the prompt and send it when the current
    // run finishes, rather than making the user wait and resubmit.
    if (this.agentSessionStatus === "running") {
      this.queuedPrompt = { contextMode, prompt: trimmedPrompt };
      this.refreshDashboardViews();
      return true;
    }

    this.lastSubmittedPrompt = { contextMode, prompt: trimmedPrompt };
    const profileSelection = await this.resolveSidekickProfileForPrompt(trimmedPrompt);
    if (!profileSelection) {
      return false;
    }

    trimmedPrompt = profileSelection.prompt.trim();
    const activeProfile = profileSelection.profile;
    if (!trimmedPrompt) {
      new Notice("Enter a prompt after the /agent command");
      return false;
    }

    if (!(await this.confirmPiExecutableForSession("run a Pi prompt"))) {
      return false;
    }

    if (!this.piRpcDiscoverySnapshot.models.some(
      (model) => model.label === this.settings.selectedPiModel
    )) {
      await this.refreshPiRpcDiscovery(false);
      this.selectDefaultPiModelIfNeeded();
      if (!this.piRpcDiscoverySnapshot.models.some(
        (model) => model.label === this.settings.selectedPiModel
      )) {
        new Notice(this.piRpcDiscoverySnapshot.error ?? "Selected model is unavailable in Pi. Refresh models and select an available model.");
        return false;
      }
    }


    // Built once so settings and the active file stay consistent for this run.
    const deps = this.createPromptContextDeps();
    const contextBlocks: PromptContextBlock[] = [];
    const profileContext = await buildSidekickProfileContext(deps, activeProfile);
    if (!profileContext) {
      return false;
    }

    contextBlocks.push(...profileContext);
    contextBlocks.push(
      ...(await buildPinnedContext(deps, this.pinnedContextPaths))
    );

    if (contextMode !== "none" && contextMode !== "vault") {
      const context = await buildNoteContext(deps, contextMode);
      if (!context) {
        return false;
      }

      contextBlocks.push(context);
    }

    if (contextMode === "vault") {
      contextBlocks.push(...(await buildVaultSearchContext(deps, trimmedPrompt)));
    }

    const mentionContext = await buildMentionedFileContext(deps, trimmedPrompt);
    if (!mentionContext) {
      return false;
    }

    contextBlocks.push(...mentionContext);
    contextBlocks.push(...(await buildDirectiveContext(deps, trimmedPrompt)));
    for (const context of contextBlocks) {
      this.addAgentEvent("tool", context.eventText);
    }

    // The edit format goes before the grounding rules so the last thing the
    // model reads before the user's request is how to source its answer, not
    // an output template it might copy.
    const promptForPi = [
      ...contextBlocks.map((context) => context.promptPrefix),
      // Withheld for prompts that only want an answer: a model that never sees
      // the edit format cannot answer a summary with an edit proposal.
      looksLikeEditRequest(trimmedPrompt) ? getEditProposalInstructions() : "For this turn, answer the user's question only. Do not propose file changes, invent a destination file, or output agent-edit blocks, even if earlier turns requested edits.",
      getVaultGroundingInstructions(),
      trimmedPrompt
    ].filter(Boolean).join("\n\n");

    this.addAgentEvent("user", trimmedPrompt);
    this.agentViewMode = "chat";
    this.agentSessionStatus = "running";
    this.pipelineStopped = false;
    const sessionPath = this.getPiSessionPath();
    const toolMode = activeProfile?.toolMode ?? this.settings.piToolMode;
    const workspaceRoot = this.getVaultRoot();
    if (toolMode === "read-only" && !workspaceRoot) {
      this.agentSessionStatus = "idle";
      new Notice("Read-only Pi tools require a local filesystem vault.");
      this.refreshDashboardViews();
      return false;
    }

    const promptDecision = this.assessSafetyRequest({
      kind: "prompt",
      // The command is recorded for the audit log; the decision uses toolMode.
      command: `${this.settings.piExecutablePath} --mode rpc ${sessionPath ? `--session ${sessionPath}` : "--no-session"} ${formatPiToolFlag(toolMode)} ${formatPiUserConfigFlag(this.settings.allowPiUserConfig)}`,
      description: `Run Pi prompt with ${describePiToolMode(toolMode)}`,
      toolMode
    });

    if (!promptDecision.allowed) {
      this.agentSessionStatus = "idle";
      this.addAgentEvent(
        "tool",
        `Safety guard blocked prompt: ${promptDecision.reason}`
      );
      this.refreshDashboardViews();
      return false;
    }

    const sessionFolderError = await this.preparePiSessionFolder();
    if (sessionFolderError) {
      this.agentSessionStatus = "idle";
      this.addAgentEvent("status", sessionFolderError);
      new Notice(sessionFolderError);
      this.refreshDashboardViews();
      return false;
    }

    // Only blocked decisions are worth a line in the stream; an allowed run is
    // self-evident from the reply that follows.
    this.refreshDashboardViews();
    this.startReadOnlyPiPrompt(promptForPi, sessionPath, toolMode, workspaceRoot, looksLikeEditRequest(trimmedPrompt));

    return true;
  }

  stopAgentRun(): void {
    // A queued follow-up was meant for the run being cancelled.
    this.queuedPrompt = undefined;

    if (this.activePromptRun) {
      this.activePromptRun.abort();
      this.activePromptRun = undefined;
    }

    if (this.agentSessionStatus === "running") {
      this.agentSessionStatus = "idle";
      this.addAgentEvent("status", "Pi run stopped.");
      this.refreshDashboardViews();
    }
  }

  cancelQueuedPrompt(): void {
    this.queuedPrompt = undefined;
    this.refreshDashboardViews();
  }

  /** Stops the current run and submits the last prompt again unchanged. */
  async resendLastPrompt(): Promise<void> {
    const last = this.lastSubmittedPrompt;
    if (!last) {
      new Notice("No previous prompt to resend");
      return;
    }

    this.stopAgentRun();
    await this.sendAgentPrompt(last.prompt, last.contextMode);
  }

  /**
   * Stops the run and hands the last prompt back for editing. Pi keeps its own
   * session history, so this does not rewind the model's context.
   */
  takeLastPromptForEditing(): QueuedPrompt | undefined {
    const last = this.lastSubmittedPrompt;
    if (!last) {
      new Notice("No previous prompt to edit");
      return undefined;
    }

    this.stopAgentRun();
    return last;
  }

  togglePinnedContextPath(vaultPath: string): void {
    const index = this.pinnedContextPaths.indexOf(vaultPath);
    if (index === -1) {
      this.pinnedContextPaths.push(vaultPath);
    } else {
      this.pinnedContextPaths.splice(index, 1);
    }

    this.queuePluginDataSave();
    this.refreshDashboardViews();
  }

  pinActiveNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note to pin");
      return;
    }

    this.togglePinnedContextPath(file.path);
  }

  clearAgentEvents(): void {
    this.agentEvents = [];
    this.addAgentEvent("status", "Agent event stream cleared.");
    this.refreshDashboardViews();
  }

  assessSafetyRequest(request: SafetyRequest): SafetyDecision {
    const decision = assessSafetyRequest(this.getSafetySnapshot(), request);
    this.lastSafetyDecision = decision;
    this.safetyAuditLog.push(decision);

    if (this.safetyAuditLog.length > 100) {
      this.safetyAuditLog = this.safetyAuditLog.slice(-100);
    }

    return decision;
  }

  approveRequest(id: string): void {
    const record = this.approvalRecords.find((item) => item.id === id);
    if (!record || record.status !== "pending") {
      return;
    }

    record.status = "approved";
    record.decidedAt = new Date().toISOString();
    const proposedEdit = this.proposedEdits.find(
      (edit) => edit.approvalId === record.id
    );
    if (proposedEdit) {
      proposedEdit.status = "approved";
      record.note = "Approval recorded. Apply from the proposed edit card.";
    } else {
      record.note =
        "Approval recorded only. No execution path is available for this request.";
    }
    this.addAgentEvent(
      "tool",
      `Approval recorded for ${describeSafetyRequest(record.decision.request)}.`
    );
    this.refreshDashboardViews();
  }

  denyRequest(id: string): void {
    const record = this.approvalRecords.find((item) => item.id === id);
    if (!record || record.status !== "pending") {
      return;
    }

    record.status = "denied";
    record.decidedAt = new Date().toISOString();
    record.note = "Denied by user.";
    const proposedEdit = this.proposedEdits.find(
      (edit) => edit.approvalId === record.id
    );
    if (proposedEdit) {
      proposedEdit.status = "denied";
    }
    this.addAgentEvent(
      "tool",
      `Approval denied for ${describeSafetyRequest(record.decision.request)}.`
    );
    this.refreshDashboardViews();
  }

  getSafetySnapshot(): SafetySnapshot {
    const vaultRoot = this.getVaultRoot();
    const externalRoots = parseExternalRoots(
      this.settings.allowedExternalWorkspaceRoots
    );
    const allowedRoots = [...(vaultRoot ? [vaultRoot] : []), ...externalRoots];

    return {
      allowedRoots,
      mode: "reviewed-edits",
      pendingApprovals: countPendingApprovals(this.approvalRecords),
      vaultRoot
    };
  }

  getPendingApprovalRecords(): ApprovalRecord[] {
    return this.approvalRecords.filter((record) => record.status === "pending");
  }

  getProposedEditsForEvent(eventId: string): ProposedEditRecord[] {
    return this.proposedEdits.filter((record) => record.eventId === eventId);
  }

  async openVaultFilePath(vaultPath: string): Promise<void> {
    const file = this.app.vault.getFileByPath(vaultPath);
    if (!file) {
      new Notice(`File not found: ${vaultPath}`);
      return;
    }

    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async applyProposedEdit(id: string): Promise<void> {
    const proposedEdit = this.proposedEdits.find((record) => record.id === id);
    if (!proposedEdit) {
      new Notice("Proposed edit not found");
      return;
    }

    const approval = proposedEdit.approvalId
      ? this.approvalRecords.find((record) => record.id === proposedEdit.approvalId)
      : undefined;
    if (!approval || approval.status !== "approved") {
      new Notice("Approve the proposed edit before applying it");
      return;
    }

    if (!proposedEdit.path.toLowerCase().endsWith(".md")) {
      proposedEdit.status = "apply-error";
      proposedEdit.applyError = "Only Markdown files can be applied.";
      this.addAgentEvent(
        "tool",
        `Apply blocked for ${proposedEdit.path}: only Markdown files can be applied.`
      );
      this.refreshDashboardViews();
      return;
    }

    const targetPath = this.getVaultPathAbsolutePath(proposedEdit.path);
    const applyDecision = this.assessSafetyRequest({
      description: `Apply approved proposed edit to ${proposedEdit.path}`,
      kind: "approved-write",
      targetPath
    });

    if (!applyDecision.allowed) {
      proposedEdit.status = "apply-error";
      proposedEdit.applyError = applyDecision.reason;
      this.addAgentEvent(
        "tool",
        `Apply blocked for ${proposedEdit.path}: ${applyDecision.reason}`
      );
      this.refreshDashboardViews();
      return;
    }

    const existingFile = this.app.vault.getFileByPath(proposedEdit.path);
    if (proposedEdit.fileExists) {
      if (!existingFile) {
        this.markProposedEditStale(
          proposedEdit,
          "Target file no longer exists."
        );
        return;
      }

      const currentText = await this.app.vault.read(existingFile);
      if (currentText !== proposedEdit.originalText) {
        this.markProposedEditStale(
          proposedEdit,
          "Target file changed after the diff was generated."
        );
        return;
      }

      await this.app.vault.modify(existingFile, proposedEdit.replacementText);
      this.markProposedEditApplied(proposedEdit);
      return;
    }

    if (existingFile) {
      this.markProposedEditStale(
        proposedEdit,
        "Target file was created after the diff was generated."
      );
      return;
    }

    try {
      await this.app.vault.create(proposedEdit.path, proposedEdit.replacementText);
      proposedEdit.fileExists = true;
      this.markProposedEditApplied(proposedEdit);
    } catch (error) {
      proposedEdit.status = "apply-error";
      proposedEdit.applyError = getErrorMessage(error);
      this.addAgentEvent(
        "tool",
        `Apply failed for ${proposedEdit.path}: ${proposedEdit.applyError}`
      );
      this.refreshDashboardViews();
    }
  }

  async selectPiModel(modelLabel: string): Promise<void> {
    if (!(await this.confirmPiExecutableForSession("set the Pi model"))) {
      return;
    }


    this.settings.selectedPiModel = modelLabel;
    await this.saveSettings();
    if (!modelLabel) {
      this.addAgentEvent("status", "Cleared selected Pi model.");
      this.refreshDashboardViews();
      return;
    }

    if (this.agentSessionStatus === "running") {
      this.addAgentEvent(
        "status",
        `Selected Pi model for the next run: ${modelLabel}.`
      );
      this.refreshDashboardViews();
      return;
    }

    const sessionPath = this.getPiSessionPath();
    const sessionFolderError = await this.preparePiSessionFolder();
    if (sessionFolderError) {
      this.addAgentEvent("status", sessionFolderError);
      this.refreshDashboardViews();
      return;
    }

    // Use the provider and id Pi gave us at discovery rather than re-deriving
    // them from the display label.
    const discovered = this.piRpcDiscoverySnapshot.models.find(
      (model) => model.label === modelLabel
    );
    const result = await setPiRpcModel(
      this.settings.piExecutablePath,
      sessionPath,
      modelLabel,
      5000,
      this.settings.allowPiUserConfig,
      { modelId: discovered?.id, provider: discovered?.provider }
    );

    if (result.success) {
      if (result.sessionState) {
        this.rememberPiSessionState(result.sessionState);
      }
      this.addAgentEvent("status", `Set active Pi session model: ${modelLabel}.`);
    } else {
      const notFound = /not found/i.test(result.error ?? "");
      this.addAgentEvent(
        "status",
        [
          `Selected ${modelLabel} for future runs, but Pi could not activate it now: ${result.error ?? "unknown error"}`,
          notFound
            ? "Pi listed this model but cannot load it. Check it is actually pulled (`ollama list`) and that its provider matches, then press Start to rediscover."
            : ""
        ].filter(Boolean).join(" ")
      );
    }
    this.refreshDashboardViews();
  }

  getVaultFileSuggestions(query: string, limit = 8): string[] {
    const normalizedQuery = normalizeMentionedPath(query)
      .replace(/^\[\[/, "")
      .toLowerCase();
    const scoredFiles = this.app.vault.getFiles()
      .map((file) => ({
        path: file.path,
        score: scoreVaultFileSuggestion(file.path, normalizedQuery)
      }))
      .filter((item) => item.score < Number.POSITIVE_INFINITY)
      .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));

    return scoredFiles.slice(0, limit).map((item) => item.path);
  }

  async suggestInternalLinksForActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile() ?? this.getActiveMarkdownFileInfo()?.file;
    if (!file) {
      new Notice("No active note found");
      return;
    }

    const proposal = await proposeInternalLinksForFile(this.app, file);
    const summary = formatInternalLinkSuggestions(file.path, proposal.suggestions);
    const event = this.addAgentEvent("assistant", summary);

    if (proposal.suggestions.length === 0) {
      this.refreshDashboardViews();
      return;
    }

    this.recordProposedReplacement(
      event.id,
      file.path,
      proposal.originalText,
      proposal.replacementText,
      `Apply conservative internal link suggestions to ${file.path}`
    );
    this.refreshDashboardViews();
  }

  runSafetySelfCheck(): void {
    const snapshot = this.getSafetySnapshot();
    const rootsSummary = summarizeAllowedRoots(snapshot);
    this.addAgentEvent("status", `Safety self-check: ${rootsSummary}.`);

    if (snapshot.vaultRoot) {
      const readDecision = this.assessSafetyRequest({
        kind: "read",
        targetPath: snapshot.vaultRoot,
        description: "Read vault root"
      });
      this.addAgentEvent(
        "tool",
        `Read check: ${readDecision.allowed ? "allowed" : "blocked"} - ${readDecision.reason}`
      );
    }

    // Report only. These probes previously called enqueueApproval, which put
    // fabricated entries into the real approval queue for the user to clear.
    const shellDecision = this.assessSafetyRequest({
      kind: "shell",
      command: "pwd",
      description: "Safety self-check probe: shell command"
    });
    this.addAgentEvent(
      "tool",
      `Shell check: ${shellDecision.allowed ? "allowed" : "blocked"} - ${shellDecision.reason}`
    );

    const writeDecision = this.assessSafetyRequest({
      kind: "write",
      targetPath: snapshot.vaultRoot,
      description: "Safety self-check probe: file write"
    });
    this.addAgentEvent(
      "tool",
      `Write check: ${writeDecision.allowed ? "allowed" : "blocked"} - ${writeDecision.reason}`
    );
    this.refreshDashboardViews();
  }

  /** Full repaint, coalesced to one per frame by the view. */
  refreshDashboardViews(): void {
    for (const view of this.getDashboardViews()) {
      view.scheduleRender();
    }
  }

  /**
   * Repaints just this event's text. Used for streamed assistant deltas, where
   * a full rebuild per token costs O(events) markdown renders and would throw
   * away the composer draft, focus, and scroll position.
   */
  private refreshStreamedEvent(event: AgentEvent): void {
    for (const view of this.getDashboardViews()) {
      view.scheduleStreamUpdate(event);
    }
  }

  private getDashboardViews(): AgentDashboardView[] {
    const views: AgentDashboardView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType(
      AGENT_DASHBOARD_VIEW_TYPE
    )) {
      if (leaf.view instanceof AgentDashboardView) {
        views.push(leaf.view);
      }
    }

    return views;
  }


  private restorePersistedAgentSession(
    state: PersistedAgentSessionState | undefined
  ): void {
    if (!state) {
      return;
    }

    this.agentEvents = Array.isArray(state.events) ? state.events.slice(-60) : [];
    this.approvalRecords = Array.isArray(state.approvalRecords)
      ? state.approvalRecords.slice(0, 40)
      : [];
    this.proposedEdits = Array.isArray(state.proposedEdits)
      ? state.proposedEdits.slice(0, 40)
      : [];
    this.piSessionId = state.piSessionId;
    this.piSessionMessageCount = state.piSessionMessageCount;
    this.piSessionPath = state.piSessionPath;
    this.pinnedContextPaths = Array.isArray(state.pinnedContextPaths)
      ? state.pinnedContextPaths.filter(
          (item): item is string => typeof item === "string"
        )
      : [];
    this.agentEventCounter =
      state.agentEventCounter ?? getMaxIdCounter(this.agentEvents, "agent-event-");
    this.approvalCounter =
      state.approvalCounter ?? getMaxIdCounter(this.approvalRecords, "approval-");
    this.proposedEditCounter =
      state.proposedEditCounter ??
      getMaxIdCounter(this.proposedEdits, "proposed-edit-");
  }

  private restorePersistedAgentSessions(data: unknown): void {
    const sessions = getPersistedAgentSessions(data);
    if (!sessions) {
      this.restorePersistedAgentSession(getPersistedAgentSession(data));
      this.saveCurrentSessionToHistory();
      return;
    }

    const records = Array.isArray(sessions.records)
      ? sessions.records.filter(isPersistedAgentSessionRecord)
      : [];
    this.agentSessionRecords = records;
    this.agentSessionHistory = records.map((record) =>
      getHistoryItemForSessionRecord(record)
    );
    this.agentViewMode = sessions.viewMode ?? "history";

    const currentName =
      sessions.currentSessionName ||
      this.settings.agentSessionName ||
      DEFAULT_SETTINGS.agentSessionName;
    const currentRecord =
      records.find((record) => record.name === currentName) ?? records[0];

    if (currentRecord) {
      this.settings.agentSessionName = currentRecord.name;
      this.restorePersistedAgentSession(currentRecord);
    }
  }

  private saveCurrentSessionToHistory(): void {
    const record = this.createCurrentSessionRecord();
    this.agentSessionRecords = [
      record,
      ...this.agentSessionRecords.filter((item) => item.name !== record.name)
    ].slice(0, 24);
    this.agentSessionHistory = [
      getHistoryItemForSessionRecord(record),
      ...this.agentSessionHistory.filter((item) => item.name !== record.name)
    ].slice(0, 24);
  }

  private getPersistedSessionRecord(
    name: string
  ): PersistedAgentSessionRecord | undefined {
    this.saveCurrentSessionToHistory();
    return this.agentSessionRecords.find(
      (record) => record.name === name
    );
  }

  private createAllPersistedSessionRecords(): PersistedAgentSessionRecord[] {
    const currentRecord = this.createCurrentSessionRecord();
    const historyRecords = this.agentSessionRecords.filter(
      (item) => item.name !== currentRecord.name
    );

    return [currentRecord, ...historyRecords].slice(0, 24);
  }

  private createCurrentSessionRecord(): PersistedAgentSessionRecord {
    const existing = this.agentSessionHistory.find(
      (item) => item.name === this.settings.agentSessionName
    );
    const updatedAt = new Date().toISOString();

    return {
      agentEventCounter: this.agentEventCounter,
      approvalCounter: this.approvalCounter,
      approvalRecords: this.approvalRecords,
      createdAt:
        existing?.createdAt ?? this.agentEvents[0]?.createdAt ?? updatedAt,
      events: this.agentEvents,
      lastMessage: getSessionLastMessage(this.agentEvents),
      messageCount: countConversationMessages(this.agentEvents),
      name: this.settings.agentSessionName || DEFAULT_SETTINGS.agentSessionName,
      piSessionId: this.piSessionId,
      piSessionMessageCount: this.piSessionMessageCount,
      piSessionPath: this.piSessionPath,
      pinnedContextPaths: this.pinnedContextPaths,
      proposedEditCounter: this.proposedEditCounter,
      proposedEdits: this.proposedEdits,
      title: getSessionTitle(
        this.agentEvents,
        existing?.title ?? this.settings.agentSessionName
      ),
      updatedAt
    };
  }

  private queuePluginDataSave(): void {
    if (this.savePluginDataTimeout !== undefined) {
      window.clearTimeout(this.savePluginDataTimeout);
    }

    this.savePluginDataTimeout = window.setTimeout(() => {
      this.savePluginDataTimeout = undefined;
      void this.savePluginData();
    }, 300);
  }

  private async flushPluginDataSave(): Promise<void> {
    if (this.savePluginDataTimeout !== undefined) {
      window.clearTimeout(this.savePluginDataTimeout);
      this.savePluginDataTimeout = undefined;
    }

    await this.savePluginData();
  }

  private async savePluginData(): Promise<void> {
    this.saveCurrentSessionToHistory();
    const sessionRecords = this.createAllPersistedSessionRecords();
    const data: PersistedAgentDashboardData = {
      agentSession: {
        agentEventCounter: this.agentEventCounter,
        approvalCounter: this.approvalCounter,
        approvalRecords: this.approvalRecords,
        events: this.agentEvents,
        piSessionId: this.piSessionId,
        piSessionMessageCount: this.piSessionMessageCount,
        piSessionPath: this.piSessionPath,
        pinnedContextPaths: this.pinnedContextPaths,
        proposedEditCounter: this.proposedEditCounter,
        proposedEdits: this.proposedEdits,
        updatedAt: new Date().toISOString()
      },
      agentSessions: {
        currentSessionName: this.settings.agentSessionName,
        records: sessionRecords,
        viewMode: this.agentViewMode
      },
      schemaVersion: 3,
      settings: this.settings
    };

    await this.saveData(data);
  }

  private getVaultRoot(): string | undefined {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }

    return undefined;
  }


  private async confirmPiExecutableForSession(action: string): Promise<boolean> {
    const executablePath =
      this.settings.piExecutablePath.trim() || DEFAULT_SETTINGS.piExecutablePath;

    if (executablePath === DEFAULT_SETTINGS.piExecutablePath) {
      return true;
    }

    if (this.confirmedPiExecutablePaths.has(executablePath)) {
      return true;
    }

    const confirmed = await confirmLocalRisk(
      this.app,
      "Confirm Pi executable",
      [
        `This vault configures Pi executable: ${executablePath}`,
        `Action: ${action}.`,
        "Only continue if you trust this vault's Local Sidekick settings. This confirmation is remembered only for the current Obsidian session."
      ].join("\n\n")
    );

    if (confirmed) {
      this.confirmedPiExecutablePaths.add(executablePath);
      return true;
    }

    new Notice("Pi executable action cancelled");
    return false;
  }
  private getPiSessionPath(): string | undefined {
    const vaultRoot = this.getVaultRoot();
    const sessionFolder = this.getPiSessionVaultFolderPath();
    if (!vaultRoot || !sessionFolder) {
      return undefined;
    }

    const sessionName = sanitizeSessionFileName(
      this.settings.agentSessionName || DEFAULT_SETTINGS.agentSessionName
    );

    return path.join(vaultRoot, sessionFolder, sessionName + ".jsonl");
  }

  private getPiSessionVaultFolderPath(): string | undefined {
    if (!this.getVaultRoot()) {
      return undefined;
    }

    const pluginDir = this.manifest.dir
      ? normalizeVaultFolderPath(this.manifest.dir)
      : normalizeVaultFolderPath(
          path.posix.join(this.app.vault.configDir, "plugins", this.manifest.id)
        );

    return normalizeVaultFolderPath(path.posix.join(pluginDir, "pi-sessions"));
  }

  private async preparePiSessionFolder(): Promise<string | undefined> {
    const folderPath = this.getPiSessionVaultFolderPath();
    if (!folderPath) {
      return undefined;
    }

    try {
      await this.ensureVaultAdapterFolder(folderPath);
      return undefined;
    } catch (error) {
      return `Unable to prepare Pi session folder: ${getErrorMessage(error)}`;
    }
  }

  private async ensureVaultAdapterFolder(folderPath: string): Promise<void> {
    const normalized = normalizeVaultFolderPath(folderPath);
    if (!normalized) {
      return;
    }

    const segments = normalized.split("/");
    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? currentPath + "/" + segment : segment;
      if (await this.app.vault.adapter.exists(currentPath)) {
        continue;
      }

      await this.app.vault.adapter.mkdir(currentPath);
    }
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const normalized = normalizeVaultFolderPath(folderPath);
    if (!normalized) {
      return;
    }

    const segments = normalized.split("/");
    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (await this.app.vault.adapter.exists(currentPath)) {
        continue;
      }

      await this.app.vault.createFolder(currentPath);
    }
  }

  private async getAvailableVaultPath(vaultPath: string): Promise<string> {
    if (!(await this.app.vault.adapter.exists(vaultPath))) {
      return vaultPath;
    }

    const extension = path.posix.extname(vaultPath) || ".md";
    const basePath = vaultPath.slice(0, -extension.length);
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${basePath}-${index}${extension}`;
      if (!(await this.app.vault.adapter.exists(candidate))) {
        return candidate;
      }
    }

    return `${basePath}-${Date.now()}${extension}`;
  }

  private rememberPiSessionState(state: PiSessionState): void {
    if (state.sessionFile) {
      this.piSessionPath = state.sessionFile;
    }

    if (state.sessionId) {
      this.piSessionId = state.sessionId;
    }

    if (state.messageCount !== undefined) {
      this.piSessionMessageCount = state.messageCount;
    }

    this.queuePluginDataSave();
  }

  private addAgentEvent(
    kind: AgentEventKind,
    text: string,
    tool?: AgentToolEvent
  ): AgentEvent {
    this.agentEventCounter += 1;
    const event = createAgentEvent(
      `agent-event-${this.agentEventCounter}`,
      kind,
      text,
      tool
    );
    this.agentEvents.push(event);

    if (this.agentEvents.length > 60) {
      this.agentEvents = this.agentEvents.slice(-60);
    }

    this.queuePluginDataSave();
    return event;
  }

  private addToolEvent(event: AgentToolEvent): AgentEvent {
    return this.addAgentEvent("tool", event.title, event);
  }

  private enqueueApproval(decision: SafetyDecision): ApprovalRecord {
    this.approvalCounter += 1;
    const record = createApprovalRecord(
      `approval-${this.approvalCounter}`,
      decision
    );
    this.approvalRecords.unshift(record);

    if (this.approvalRecords.length > 40) {
      this.approvalRecords = this.approvalRecords.slice(0, 40);
    }

    this.queuePluginDataSave();
    return record;
  }


  private markProposedEditApplied(proposedEdit: ProposedEditRecord): void {
    proposedEdit.status = "applied";
    proposedEdit.applyError = undefined;
    proposedEdit.originalText = proposedEdit.replacementText;
    proposedEdit.diffLines = createLineDiff(
      proposedEdit.replacementText,
      proposedEdit.replacementText
    );
    this.addAgentEvent(
      "tool",
      `Applied proposed edit to ${proposedEdit.path}.`
    );
    this.refreshDashboardViews();
  }

  private markProposedEditStale(
    proposedEdit: ProposedEditRecord,
    reason: string
  ): void {
    proposedEdit.status = "apply-error";
    proposedEdit.applyError = reason;
    this.addAgentEvent(
      "tool",
      `Apply blocked for ${proposedEdit.path}: ${reason}`
    );
    this.refreshDashboardViews();
  }

  private recordProposedReplacement(
    eventId: string,
    vaultPath: string,
    originalText: string,
    replacementText: string,
    description: string
  ): void {
    if (originalText === replacementText) {
      return;
    }

    const targetPath = this.getVaultPathAbsolutePath(vaultPath);
    const decision = this.assessSafetyRequest({
      description,
      kind: "write",
      targetPath
    });
    const approval = this.enqueueApproval(decision);
    const file = this.app.vault.getFileByPath(vaultPath);

    this.proposedEditCounter += 1;
    this.proposedEdits.unshift({
      approvalId: approval.id,
      createdAt: new Date().toISOString(),
      diffLines: createLineDiff(originalText, replacementText),
      eventId,
      fileExists: file !== null,
      id: `proposed-edit-${this.proposedEditCounter}`,
      originalText,
      path: vaultPath,
      replacementText,
      status: "pending-approval"
    });

    if (this.proposedEdits.length > 40) {
      this.proposedEdits = this.proposedEdits.slice(0, 40);
    }
  }

  private async recordProposedEdits(
    eventId: string | undefined,
    text: string
  ): Promise<void> {
    if (!eventId) {
      return;
    }

    const parsedEdits = parseProposedEditsFromMarkdown(text);
    if (parsedEdits.length === 0) {
      return;
    }

    let recordedCount = 0;
    for (const parsedEdit of parsedEdits) {
      const vaultPath = normalizeProposedEditPath(parsedEdit.path);
      if (!vaultPath) {
        this.addAgentEvent(
          "tool",
          `Ignored proposed edit with invalid path: ${parsedEdit.path}`
        );
        continue;
      }

      const duplicate = this.proposedEdits.some(
        (record) =>
          record.eventId === eventId &&
          record.path === vaultPath &&
          record.replacementText === parsedEdit.replacementText
      );
      if (duplicate) {
        continue;
      }

      const file = this.app.vault.getFileByPath(vaultPath);
      const originalText = file ? await this.app.vault.read(file) : "";
      if (parsedEdit.operation === "append") {
        parsedEdit.replacementText = originalText + (originalText && !originalText.endsWith("\n") ? "\n\n" : originalText ? "\n" : "") + parsedEdit.replacementText;
      }
      const targetPath = this.getVaultPathAbsolutePath(vaultPath);
      const decision = this.assessSafetyRequest({
        description: `Apply proposed edit to ${vaultPath}`,
        kind: "write",
        targetPath
      });
      const approval = this.enqueueApproval(decision);

      this.proposedEditCounter += 1;
      this.proposedEdits.unshift({
        approvalId: approval.id,
        createdAt: new Date().toISOString(),
        diffLines: createLineDiff(originalText, parsedEdit.replacementText),
        eventId,
        fileExists: file !== null,
        id: `proposed-edit-${this.proposedEditCounter}`,
        originalText,
        path: vaultPath,
        replacementText: parsedEdit.replacementText,
        status: "pending-approval"
      });
      recordedCount += 1;
    }

    if (this.proposedEdits.length > 40) {
      this.proposedEdits = this.proposedEdits.slice(0, 40);
    }

    if (recordedCount > 0) {
      this.addAgentEvent(
        "tool",
        `Detected ${recordedCount} proposed edit(s). Approve before applying.`
      );
      this.refreshDashboardViews();
    }
  }

  private async resolveSidekickProfileForPrompt(
    prompt: string
  ): Promise<PromptSidekickProfileSelection | undefined> {
    await this.refreshSidekickProfiles();
    const lines = prompt.split(/\r?\n/);
    const firstLine = lines[0]?.trim() ?? "";
    if (!/^\/agent(?:\s|$)/i.test(firstLine)) {
      return {
        profile: this.getSelectedSidekickProfile(),
        prompt
      };
    }

    const reference = firstLine.replace(/^\/agent\b/i, "").trim();
    const remainingPrompt = lines.slice(1).join("\n").trim();
    if (!reference || /^(none|off|clear)$/i.test(reference)) {
      if (this.settings.selectedAgentProfilePath) {
        this.settings.selectedAgentProfilePath = "";
        await this.saveSettings();
        this.addAgentEvent("status", "Cleared Sidekick agent profile.");
      }

      return { prompt: remainingPrompt };
    }

    const profile = findSidekickProfile(this.sidekickProfiles, reference);
    if (!profile) {
      new Notice(`Sidekick agent profile not found: ${reference}`);
      this.addAgentEvent(
        "tool",
        `Blocked /agent context: ${reference} was not found under ${this.settings.sidekickRootFolder}/Agents.`
      );
      this.refreshDashboardViews();
      return undefined;
    }

    let shouldSaveSettings = false;
    if (this.settings.selectedAgentProfilePath !== profile.path) {
      this.settings.selectedAgentProfilePath = profile.path;
      shouldSaveSettings = true;
    }

    // A profile's `models:` list constrains which model runs. Overriding the
    // user's pick silently made it look like the plugin ignored the picker, so
    // say so and name the profile responsible.
    if (
      profile.modelLabels.length > 0 &&
      !profile.modelLabels.includes(this.settings.selectedPiModel)
    ) {
      const previous = this.settings.selectedPiModel;
      this.settings.selectedPiModel = profile.modelLabels[0];
      shouldSaveSettings = true;
      this.addAgentEvent(
        "status",
        `Switched to ${this.settings.selectedPiModel} because the ${getSidekickProfileDisplayName(profile)} profile does not list ${previous || "the selected model"}. Add it to that profile's models, or clear the profile with /agent clear, to use it here.`
      );
    }

    if (shouldSaveSettings) {
      await this.saveSettings();
    }

    return { profile, prompt: remainingPrompt };
  }

  private createPromptContextDeps(): PromptContextDeps {
    return {
      activeMarkdownFile: this.getActiveMarkdownFileInfo(),
      app: this.app,
      assess: (request) => this.assessSafetyRequest(request),
      report: (text) => {
        this.addAgentEvent("tool", text);
      },
      reportBlocked: (text) => {
        this.addAgentEvent("tool", text);
        this.refreshDashboardViews();
      },
      settings: this.settings,
      toAbsolutePath: (vaultPath) => this.getVaultPathAbsolutePath(vaultPath),
      vaultRoot: this.getVaultRoot()
    };
  }

  private getActiveMarkdownFileInfo(): MarkdownFileInfo | null {
    const activeEditor = this.app.workspace.activeEditor;
    if (activeEditor?.file) {
      this.lastMarkdownFileInfo = activeEditor;
      return activeEditor;
    }

    return this.lastMarkdownFileInfo;
  }

  private rememberActiveMarkdownFileInfo(): void {
    const activeEditor = this.app.workspace.activeEditor;
    if (activeEditor?.file) {
      this.lastMarkdownFileInfo = activeEditor;
    }
  }

  private getVaultFileAbsolutePath(file: TFile): string {
    return this.getVaultPathAbsolutePath(file.path);
  }

  private getVaultPathAbsolutePath(vaultPath: string): string {
    const vaultRoot = this.getVaultRoot();
    if (!vaultRoot) {
      return vaultPath;
    }

    return path.join(vaultRoot, vaultPath);
  }

  private selectDefaultPiModelIfNeeded(): void {
    if (this.settings.selectedPiModel) {
      return;
    }

    const currentModel = this.piRpcDiscoverySnapshot.currentModel;
    const discoveredModels = this.piRpcDiscoverySnapshot.models;
    const fallbackModel = discoveredModels[0]?.label;
    const selectedModel = currentModel || fallbackModel;

    if (selectedModel) {
      this.settings.selectedPiModel = selectedModel;
      void this.saveSettings();
    }
  }

  private startReadOnlyPiPrompt(
    prompt: string,
    sessionPath: string | undefined,
    toolMode: PiToolMode,
    workspaceRoot: string | undefined,
    expectEdits = false
  ): void {
    let assistantText = "";
    let assistantEventId: string | undefined;
    const selectedModel = this.settings.selectedPiModel;
    // Stands in for the run's lifecycle chatter until real output arrives.
    const thinkingEventId = this.addAgentEvent("status", "Thinking...").id;
    const clearThinking = () => this.removeAgentEvent(thinkingEventId);

    this.activePromptRun = new PiReadOnlyPromptRun(
      {
        executablePath: this.settings.piExecutablePath,
        modelLabel: selectedModel,
        thinkingLevel: resolveThinking(this.settings.thinkingLevel,
          this.piRpcDiscoverySnapshot.models.find((model) => model.label === selectedModel)),
        prompt,
        sessionPath,
        timeoutMs: this.settings.piPromptTimeoutMinutes * 60_000,
        toolMode,
        workspaceRoot,
        allowPiUserConfig: this.settings.allowPiUserConfig
      },
      {
        onAssistantDelta: (delta) => {
          assistantText += delta;
          if (!assistantEventId) {
            // First delta adds an element, so the stream needs a full render.
            clearThinking();
            assistantEventId = this.addAgentEvent("assistant", assistantText).id;
            this.refreshDashboardViews();
            return;
          }

          const event = this.updateAgentEvent(assistantEventId, assistantText);
          if (event) {
            this.refreshStreamedEvent(event);
          }
        },
        onError: (message) => {
          this.activePromptRun = undefined;
          this.agentSessionStatus = "error";
          clearThinking();
          this.addAgentEvent("status", `Pi run failed: ${message}`);
          this.refreshDashboardViews();
        },
        onSessionState: (state) => {
          this.rememberPiSessionState(state);
          this.refreshDashboardViews();
        },
        onComplete: (reason) => {
          if (reason === "completed" && expectEdits) {
            void this.recordProposedEdits(assistantEventId, assistantText);
          }

          this.activePromptRun = undefined;
          this.agentSessionStatus = "idle";
          clearThinking();
          void this.flushPluginDataSave();
          this.refreshDashboardViews();

          if (reason === "completed") {
            this.dispatchQueuedPrompt();
          }
        },
        onStatus: (message) => {
          if (isPiToolSupportErrorStatus(message)) {
            new Notice("Selected model does not support Pi tools. Disable Pi tools or choose another model.");
          }

          // Per-phase chatter would bury the reply, so only actionable
          // statuses earn a line in the stream.
          if (!isPiRunPhaseNoise(message)) {
            this.addAgentEvent("status", message);
          }

          this.refreshDashboardViews();
        },
        onToolEvent: (event) => {
          if (toolMode === "read-only" && isReadOnlyPiToolEvent(event)) {
            this.addToolEvent(createPiToolEvent(event));
            this.refreshDashboardViews();
            return;
          }

          // Pi has already run this. There is nothing to approve after the
          // fact, so record it as a warning rather than queueing a decision.
          this.assessSafetyRequest({
            description: `Pi used a tool outside the requested mode: ${event.title}`,
            kind: "shell"
          });
          this.addToolEvent(createUnexpectedToolEvent(event));
          this.addAgentEvent(
            "status",
            `Pi ran "${event.name ?? event.title}", which is outside the tools Local Sidekick requested. This is reported after the fact; the plugin cannot stop Pi's tool calls.`
          );
          this.refreshDashboardViews();
        }
      }
    );

    this.activePromptRun.start();
  }

  /**
   * Sends a queued prompt once the current run has fully settled. Deferred to a
   * fresh task so it does not start a run from inside the previous run's
   * completion callback.
   */
  private dispatchQueuedPrompt(): void {
    const queued = this.queuedPrompt;
    if (!queued) {
      return;
    }

    this.queuedPrompt = undefined;
    window.setTimeout(() => {
      if (this.agentSessionStatus === "running") {
        // Something else claimed the turn; put it back rather than drop it.
        this.queuedPrompt = queued;
        this.refreshDashboardViews();
        return;
      }

      void this.sendAgentPrompt(queued.prompt, queued.contextMode);
    }, 0);
  }

  private removeAgentEvent(id: string): void {
    const index = this.agentEvents.findIndex((event) => event.id === id);
    if (index === -1) {
      return;
    }

    this.agentEvents.splice(index, 1);
  }

  private updateAgentEvent(id: string, text: string): AgentEvent | undefined {
    const event = this.agentEvents.find((item) => item.id === id);
    if (!event) {
      return undefined;
    }

    event.text = text;
    // Each save rewrites the whole of data.json (every session, event, and
    // proposed edit), so streaming deltas do not queue one. The run's terminal
    // status event flushes the final text.
    if (this.agentSessionStatus !== "running") {
      this.queuePluginDataSave();
    }

    return event;
  }
}
