import { App, PluginSettingTab, Setting } from "obsidian";

// Type-only: settings.ts is imported by modules that must not pull in main.ts.
import type AgentDashboardPlugin from "./main";
import { DEFAULT_SIDEKICK_ROOT, normalizeSidekickRoot } from "./agent/SidekickProfile";
import type { PiToolMode } from "./types";
import type { ThinkingPreference } from "./bridge/pi/thinking";

export interface AgentDashboardSettings {
  thinkingLevel: ThinkingPreference;
  agentSessionName: string;
  allowedExternalWorkspaceRoots: string;
  piToolMode: PiToolMode;
  allowPiUserConfig: boolean;
  piPromptTimeoutMinutes: number;
  piExecutablePath: string;
  selectedPiModel: string;
  selectedAgentProfilePath: string;
  sidekickRootFolder: string;
  ollamaHost: string;
  defaultModel: string;
  compactBlockHeight: number;
  safeCommandAllowlist: string;
  webFetchAllowedHosts: string;
  webFetchEnabled: boolean;
}

export const DEFAULT_SETTINGS: AgentDashboardSettings = {
  thinkingLevel: "medium",
  agentSessionName: "default",
  allowedExternalWorkspaceRoots: "",
  // Pi's built-in read, grep, find, and ls. Meaningful only while
  // allowPiUserConfig stays false — see below.
  piToolMode: "read-only",
  // Must stay false. Pi's --tools/--no-tools filter built-in tools only;
  // extension-registered tools bypass them (earendil-works/pi#2835). Passing
  // --no-extensions is therefore what makes the read-only mode above mean
  // anything at all.
  allowPiUserConfig: false,
  piPromptTimeoutMinutes: 10,
  piExecutablePath: "pi",
  selectedPiModel: "",
  selectedAgentProfilePath: "",
  sidekickRootFolder: DEFAULT_SIDEKICK_ROOT,
  ollamaHost: "http://127.0.0.1:11434",
  defaultModel: "",
  compactBlockHeight: 360,
  safeCommandAllowlist: [
    "git status",
    "git diff --stat"
  ].join("\n"),
  webFetchAllowedHosts: "",
  webFetchEnabled: false
};

export class AgentDashboardSettingTab extends PluginSettingTab {
  plugin: AgentDashboardPlugin;

  constructor(app: App, plugin: AgentDashboardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // A Setting with no control renders as an empty row, so state the posture
    // as a section heading rather than a setting that cannot be set.
    new Setting(containerEl)
      .setName("Safety")
      .setDesc(
        "Pi reads the vault with its read-only tools. Shell commands and deletes are blocked, and file changes arrive as reviewed Markdown proposals you approve individually."
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Allowed external workspace roots")
      .setDesc(
        "Optional absolute folder paths, one per line. The vault root is allowed automatically for read-only context."
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("/Users/example/dev/project")
          .setValue(this.plugin.settings.allowedExternalWorkspaceRoots)
          .onChange(async (value) => {
            this.plugin.settings.allowedExternalWorkspaceRoots = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDashboardViews();
          })
      );

    new Setting(containerEl)
      .setName("Sidekick root folder")
      .setDesc("Vault folder for Sidekick agent profiles and memory files. Agent files live under Sidekick/Agents by default.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SIDEKICK_ROOT)
          .setValue(this.plugin.settings.sidekickRootFolder)
          .onChange(async (value) => {
            this.plugin.settings.sidekickRootFolder = normalizeSidekickRoot(value);
            await this.plugin.saveSettings();
            await this.plugin.refreshSidekickProfiles();
          })
      );

    new Setting(containerEl)
      .setName("Sidekick vault files")
      .setDesc("Create starter .agent.md profiles and memory files, then refresh the generated project index.")
      .addButton((button) =>
        button
          .setButtonText("Create starters")
          .onClick(async () => {
            await this.plugin.createSidekickStarterFiles();
            this.display();
          })
      )
      .addButton((button) =>
        button
          .setButtonText("Refresh index")
          .onClick(async () => {
            await this.plugin.refreshSidekickProjectIndex();
            this.display();
          })
      )
      .addButton((button) =>
        button
          .setButtonText("Export Pi resources")
          .onClick(async () => {
            await this.plugin.exportSidekickPiResources();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Agent session")
      .setDesc(
        "Persistent Pi session name. Changing it starts using a different stored conversation."
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.agentSessionName)
          .setValue(this.plugin.settings.agentSessionName)
          .onChange(async (value) => {
            this.plugin.settings.agentSessionName =
              value.trim() || DEFAULT_SETTINGS.agentSessionName;
            this.plugin.resetPiSessionMetadata();
            await this.plugin.saveSettings();
            this.plugin.refreshDashboardViews();
          })
      );

    new Setting(containerEl)
      .setName("Pi executable")
      .setDesc("Command or absolute path used by Pi. Non-default paths are confirmed per Obsidian session because vault plugin data can be untrusted.")
      .addText((text) =>
        text
          .setPlaceholder("pi")
          .setValue(this.plugin.settings.piExecutablePath)
          .onChange(async (value) => {
            this.plugin.settings.piExecutablePath = value.trim() || "pi";
            await this.plugin.saveSettings();
            this.plugin.resetPiStatus();
          })
      );

    new Setting(containerEl)
      .setName("Pi tools")
      .setDesc(
        "Read-only is the default: Pi may use its read, grep, find, and ls tools from the vault root, while bash, edit, and write stay off. Disabled keeps Pi fully tool-free. This only limits Pi's built-in tools, so it holds only while the extensions setting below is off."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("disabled", "Disabled")
          .addOption("read-only", "Read-only: read, grep, find, ls")
          .setValue(this.plugin.settings.piToolMode)
          .onChange(async (value) => {
            this.plugin.settings.piToolMode = value as PiToolMode;
            await this.plugin.saveSettings();
            this.plugin.refreshDashboardViews();
          })
      );

    new Setting(containerEl)
      .setName("Pi prompt timeout")
      .setDesc(
        "Maximum time to wait for a Pi response. Larger local models and read-only tools may need several minutes."
      )
      .addSlider((slider) =>
        slider
          .setLimits(2, 30, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.piPromptTimeoutMinutes)
          .onChange(async (value) => {
            this.plugin.settings.piPromptTimeoutMinutes = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDashboardViews();
          })
      );

    new Setting(containerEl)
      .setName("Ollama host")
      .setDesc("Local Ollama server URL.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.ollamaHost)
          .setValue(this.plugin.settings.ollamaHost)
          .onChange(async (value) => {
            this.plugin.settings.ollamaHost =
              value.trim() || DEFAULT_SETTINGS.ollamaHost;
            await this.plugin.saveSettings();
            this.plugin.resetOllamaStatus();
          })
      );

    new Setting(containerEl)
      .setName("Default model")
      .setDesc("Optional Ollama model name to preselect in Sidekick blocks.")
      .addText((text) =>
        text
          .setPlaceholder("qwen2.5-coder:latest")
          .setValue(this.plugin.settings.defaultModel)
          .onChange(async (value) => {
            this.plugin.settings.defaultModel = value.trim();
            await this.plugin.saveSettings();
            this.plugin.resetOllamaStatus();
          })
      );

    new Setting(containerEl)
      .setName("Compact block height")
      .setDesc("Default height, in pixels, for embedded Sidekick blocks.")
      .addSlider((slider) =>
        slider
          .setLimits(240, 720, 20)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.compactBlockHeight)
          .onChange(async (value) => {
            this.plugin.settings.compactBlockHeight = value;
            await this.plugin.saveSettings();
          })
      );


    new Setting(containerEl)
      .setName("Safe command allowlist")
      .setDesc(
        "Exact commands the plugin may run with @cmd(...). Commands run without a shell from the vault root. Keep this short; npm scripts are intentionally not included by default."
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("git status\ngit diff --stat")
          .setValue(this.plugin.settings.safeCommandAllowlist)
          .onChange(async (value) => {
            this.plugin.settings.safeCommandAllowlist = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Web fetch")
      .setDesc(
        "Allow @url(...) prompt context. Requires HTTPS and an explicit host allowlist; DNS results resolving to private/local/metadata IP ranges are blocked."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.webFetchEnabled)
          .onChange(async (value) => {
            this.plugin.settings.webFetchEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDashboardViews();
          })
      );

    new Setting(containerEl)
      .setName("Web fetch allowed hosts")
      .setDesc(
        "Required host allowlist, one per line. HTTPS only. Examples: arxiv.org, github.com."
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("arxiv.org\ngithub.com")
          .setValue(this.plugin.settings.webFetchAllowedHosts)
          .onChange(async (value) => {
            this.plugin.settings.webFetchAllowedHosts = value;
            await this.plugin.saveSettings();
          })
      );


    new Setting(containerEl)
      .setName("Allow Pi extensions and user configuration")
      .setDesc(
        "Off by default, so Pi ignores your own extensions, skills, prompt templates, and context files. Turn this on if you want Pi to use extensions you have written or installed. Be aware that Pi's tool limits only cover its built-in tools: an extension can register tools that ignore the Pi tools setting above, so enabling this means Local Sidekick can no longer bound what Pi does. Only enable it if you trust every extension your Pi configuration loads."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allowPiUserConfig)
          .onChange(async (value) => {
            this.plugin.settings.allowPiUserConfig = value;
            await this.plugin.saveSettings();
            this.plugin.refreshDashboardViews();
          })
      );

  }
}
