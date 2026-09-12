import {
  ButtonComponent,
  Component,
  MarkdownRenderer,
  Notice,
  setIcon,
  TFile
} from "obsidian";

import type AgentDashboardPlugin from "../main";
import { normalizeTableSpacing } from "../markdown/normalizeTables";
import type {
  AgentSessionHistoryItem,
  PiToolMode,
  ProposedEditRecord
} from "../types";
import { UNKNOWN_TO_PI } from "../types";
import { getOllamaModelName } from "../bridge/pi/piFlags";
import { normalizeThinking, resolveThinking, supportedThinkingLevels } from "../bridge/pi/thinking";
import type { AgentEvent, AgentToolEvent } from "../agent/AgentSession";
import type { ProposedEditDiffLine } from "../agent/ProposedEdit";
import type { OllamaSnapshot } from "../bridge/ollama/OllamaClient";
import type { PiSnapshot } from "../bridge/pi/PiProbe";
import type { PiRpcDiscoverySnapshot } from "../bridge/pi/PiRpcDiscovery";
import type { ApprovalRecord } from "../security/ApprovalQueue";
import { summarizeAllowedRoots } from "../security/SafetyPolicy";

/**
 * Transient view state that must survive a full re-render. Lives on the host
 * (one per dashboard instance) rather than at module scope, so it does not
 * leak across plugin reloads or bleed between leaves.
 */
export interface DashboardUiState {
  thinkingOpen?: boolean;
  agentPickerOpen: boolean;
  /** The Chats dropdown in the top bar. Mutually exclusive with menuOpen. */
  chatsOpen: boolean;
  expandedModelLabel: string | null;
  menuOpen: boolean;
  openToolEventIds: Set<string>;
  /** Unsent composer text, restored after a rebuild. */
  promptDraft: string;
}

export interface DashboardHost {
  /**
   * Owns the lifetime of MarkdownRenderer output. Replaced on each full
   * render so the previous render's children are unloaded.
   */
  markdownComponent: Component;
  /** Requests a coalesced full re-render of this dashboard. */
  rerender(): void;
  ui: DashboardUiState;
}

export interface DashboardRenderOptions {
  embedded: boolean;
  host: DashboardHost;
  workspace?: string;
  mode?: string;
  layout?: string;
  session?: string;
  model?: string;
}

export function createDashboardUiState(): DashboardUiState {
  return {
    agentPickerOpen: false,
    chatsOpen: false,
    expandedModelLabel: null,
    menuOpen: false,
    openToolEventIds: new Set<string>(),
    promptDraft: ""
  };
}

export function renderDashboardShell(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  if (hasStreamSelection(containerEl)) return;
  // A rebuild destroys the composer. Status events repaint mid-stream, so
  // without this the caret jumps while the user is still typing.
  const composerFocus = captureFocusedComposer(containerEl);
  const streamScroll = captureStreamScroll(containerEl);

  containerEl.empty();
  containerEl.addClass("agent-dashboard");
  containerEl.toggleClass("agent-dashboard--embedded", options.embedded);
  containerEl.toggleClass("agent-dashboard--standalone", !options.embedded);

  if (options.embedded) {
    containerEl.style.setProperty(
      "--sidekick-compact-block-height",
      `${plugin.settings.compactBlockHeight}px`
    );
    renderEmbeddedShell(plugin, containerEl, options);
    return;
  }

  renderTopBar(plugin, containerEl, options);
  if (options.host.ui.menuOpen) {
    renderMenuDropdown(plugin, containerEl, options);
  }

  if (options.host.ui.chatsOpen) {
    renderChatsDropdown(plugin, containerEl, options);
  }

  const bodyEl = containerEl.createDiv({ cls: "agent-dashboard__body" });
  renderAgentPanel(plugin, bodyEl, options);
  restoreStreamScroll(containerEl, streamScroll);
  restoreFocusedComposer(containerEl, composerFocus);
}

interface IconButtonOptions {
  /** Shown instead of the icon if this Obsidian build lacks that Lucide name. */
  fallbackText: string;
  icon: string;
  onClick: () => void;
  /** Drives the accent colour, via .agent-dashboard__icon-button--<variant>. */
  variant: string;
  disabled?: boolean;
  tooltip: string;
}

/**
 * Icon-only action button. Obsidian ships a fixed Lucide version, so an unknown
 * icon name silently renders nothing; falling back to the label keeps the
 * control usable rather than blank.
 */
function renderIconButton(
  containerEl: HTMLElement,
  options: IconButtonOptions
): ButtonComponent {
  const button = new ButtonComponent(containerEl)
    .setTooltip(options.tooltip)
    .setDisabled(options.disabled === true)
    .onClick(options.onClick);

  button.buttonEl.addClass("agent-dashboard__icon-button");
  button.buttonEl.addClass(`agent-dashboard__icon-button--${options.variant}`);
  button.buttonEl.setAttr("aria-label", options.tooltip);

  setIcon(button.buttonEl, options.icon);
  if (!button.buttonEl.querySelector("svg")) {
    button.setButtonText(options.fallbackText);
  }

  return button;
}

/**
 * Both dropdowns are toggled from the top bar, which is not obvious once one is
 * open and the list under it has the focus. This gives each an explicit close.
 */
function renderDropdownClose(
  containerEl: HTMLElement,
  options: DashboardRenderOptions,
  tooltip: string
): void {
  renderIconButton(containerEl, {
    fallbackText: "Close",
    icon: "x",
    tooltip,
    variant: "close",
    onClick: () => {
      options.host.ui.menuOpen = false;
      options.host.ui.chatsOpen = false;
      options.host.rerender();
    }
  });
}

/** Vault files attached to every prompt until unpinned. */
function renderPinnedContext(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement
): void {
  if (plugin.pinnedContextPaths.length === 0) {
    return;
  }

  const pinnedEl = containerEl.createDiv({ cls: "agent-dashboard__pinned" });
  pinnedEl.createSpan({
    cls: "agent-dashboard__pinned-label",
    text: "Pinned:"
  });

  for (const pinnedPath of plugin.pinnedContextPaths) {
    const chipEl = pinnedEl.createDiv({ cls: "agent-dashboard__pinned-chip" });
    chipEl.createSpan({ text: pinnedPath });
    const removeEl = chipEl.createSpan({
      attr: {
        "aria-label": `Unpin ${pinnedPath}`,
        role: "button",
        tabindex: "0"
      },
      cls: "agent-dashboard__pinned-remove"
    });
    setIcon(removeEl, "x");
    removeEl.addEventListener("click", () => {
      plugin.togglePinnedContextPath(pinnedPath);
    });
  }
}

function renderQueuedPrompt(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const queued = plugin.queuedPrompt;
  if (!queued) {
    return;
  }

  const queuedEl = containerEl.createDiv({ cls: "agent-dashboard__queued" });
  const iconEl = queuedEl.createSpan({ cls: "agent-dashboard__queued-icon" });
  setIcon(iconEl, "clock");
  queuedEl.createSpan({
    cls: "agent-dashboard__queued-text",
    text: `Queued: ${truncateForDisplay(queued.prompt, 72)}`
  });

  new ButtonComponent(queuedEl)
    .setButtonText("Cancel")
    .setTooltip("Discard the queued prompt")
    .onClick(() => {
      plugin.cancelQueuedPrompt();
      options.host.rerender();
    });
}

/** Actions that only make sense once something has been sent. */
function renderRunControls(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const canPin = plugin.app.workspace.getActiveFile() !== null;
  if (!plugin.lastSubmittedPrompt && !canPin) {
    return;
  }

  const controlsEl = containerEl.createDiv({
    cls: "agent-dashboard__run-controls"
  });

  if (canPin) {
    new ButtonComponent(controlsEl)
      .setButtonText("Pin note")
      .setTooltip("Attach the current note to every prompt in this session")
      .onClick(() => {
        plugin.pinActiveNote();
      });
  }

  if (!plugin.lastSubmittedPrompt) {
    return;
  }

  new ButtonComponent(controlsEl)
    .setButtonText("Resend")
    .setTooltip("Stop the current run and send the last prompt again")
    .onClick(() => {
      void plugin.resendLastPrompt();
    });

  new ButtonComponent(controlsEl)
    .setButtonText("Edit last")
    .setTooltip("Stop the current run and put the last prompt back in the composer")
    .onClick(() => {
      const last = plugin.takeLastPromptForEditing();
      if (!last) {
        return;
      }

      options.host.ui.promptDraft = last.prompt;
      options.host.rerender();
    });
}

function renderThinkingControl(plugin: AgentDashboardPlugin, container: HTMLElement, options: DashboardRenderOptions): void {
  const model = plugin.piRpcDiscoverySnapshot.models.find(
    (entry) => entry.label === getCurrentModelLabel(plugin)
  );
  const levels = supportedThinkingLevels(model);
  const details = container.createEl("details", { cls: "agent-dashboard__thinking" });
  details.open = options.host.ui.thinkingOpen === true;
  const summary = details.createEl("summary", { attr: { "aria-label": "Thinking effort" } });
  details.addEventListener("toggle", () => {
    if (details.isConnected) options.host.ui.thinkingOpen = details.open;
  });
  summary.addEventListener("click", () => {
    options.host.ui.thinkingOpen = !details.open;
    if (!model && !details.open && plugin.piRpcDiscoverySnapshot.status !== "checking") {
      void plugin.refreshPiRpcDiscovery(false);
    }
  });
  setIcon(summary.createSpan(), "brain");
  const caption = summary.createSpan();
  setIcon(summary.createSpan(), "chevron-up");
  const panel = details.createDiv({ cls: "agent-dashboard__thinking-panel" });
  panel.createEl("strong", { text: "Thinking effort" });
  const slider = panel.createEl("input", { type: "range", attr: {
    min: "0", max: String(Math.max(0, levels.length - 1)), step: "1", "aria-label": "Thinking effort"
  } });
  slider.disabled = levels.length <= 1;
  const effective = resolveThinking(plugin.settings.thinkingLevel, model);
  slider.value = String(Math.max(0, levels.findIndex((level) => level === effective)));
  const labels = panel.createDiv({ cls: "agent-dashboard__thinking-labels" });
  const name = (value: string) => value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1);
  for (const level of levels) labels.createSpan({ text: name(level) });
  if (!model) {
    panel.createEl("p", { text: plugin.piRpcDiscoverySnapshot.status === "checking"
      ? "Loading model details..."
      : plugin.piRpcDiscoverySnapshot.error ?? "Model details unavailable." });
    new ButtonComponent(panel).setButtonText("Refresh models")
      .setDisabled(plugin.piRpcDiscoverySnapshot.status === "checking")
      .onClick(() => { void plugin.refreshPiRpcDiscovery(false); });
  }
  else if (!model.reasoning) panel.createEl("p", { text: "This model is not configured for thinking." });
  const update = () => {
    const level = levels[Number(slider.value)] ?? (model && !model.reasoning ? "off" : "medium");
    caption.textContent = name(level);
    slider.setAttribute("aria-valuetext", name(level));
    summary.title = `Thinking: ${name(level)} (next prompt)`;
  };
  update();
  slider.addEventListener("input", update);
  slider.addEventListener("change", () => {
    plugin.settings.thinkingLevel = normalizeThinking(levels[Number(slider.value)]);
    void plugin.saveSettings();
  });
  details.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { details.open = false; summary.focus(); }
  });
  details.addEventListener("focusout", (event) => {
    if (!event.relatedTarget || !details.contains(event.relatedTarget as Node)) details.open = false;
  });
}

function truncateForDisplay(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}...`;
}

/**
 * Caret only. The text itself comes from host.ui.promptDraft, which the input
 * listener keeps current — carrying the value here too would let a stale
 * textarea resurrect text that was just sent.
 */
/**
 * Where the transcript was scrolled before a rebuild. Repaints happen while a
 * reply streams, so re-pinning unconditionally made it impossible to scroll
 * back and read anything — every status event yanked the view down again.
 */
interface StreamScrollState {
  atBottom: boolean;
  scrollTop: number;
}

function captureStreamScroll(
  containerEl: HTMLElement
): StreamScrollState | undefined {
  const streamEl = containerEl.querySelector(".agent-dashboard__event-stream");
  if (!(streamEl instanceof HTMLElement)) {
    return undefined;
  }

  return {
    atBottom: isScrolledToBottom(streamEl),
    scrollTop: streamEl.scrollTop
  };
}

function restoreStreamScroll(
  containerEl: HTMLElement,
  state: StreamScrollState | undefined
): void {
  const streamEl = containerEl.querySelector(".agent-dashboard__event-stream");
  if (!(streamEl instanceof HTMLElement)) {
    return;
  }

  // First paint of a chat, or the user was already following along: stay at the
  // bottom as async content lands. Otherwise leave them exactly where they were.
  if (!state || state.atBottom) {
    stickToBottom(streamEl);
    return;
  }

  streamEl.scrollTop = state.scrollTop;
}

interface ComposerFocusState {
  end: number;
  start: number;
}

/** Returns state only when the composer currently holds focus. */
function captureFocusedComposer(
  containerEl: HTMLElement
): ComposerFocusState | undefined {
  const active = containerEl.ownerDocument.activeElement;
  if (
    !(active instanceof HTMLTextAreaElement) ||
    !active.hasClass("agent-dashboard__prompt-input") ||
    !containerEl.contains(active)
  ) {
    return undefined;
  }

  return {
    end: active.selectionEnd,
    start: active.selectionStart
  };
}

function restoreFocusedComposer(
  containerEl: HTMLElement,
  state: ComposerFocusState | undefined
): void {
  if (!state) {
    return;
  }

  const promptEl = containerEl.querySelector(".agent-dashboard__prompt-input");
  if (!(promptEl instanceof HTMLTextAreaElement)) {
    return;
  }

  // The value was already set from the draft; clamp the caret in case the
  // draft shrank (most obviously when the prompt was just sent).
  const limit = promptEl.value.length;
  promptEl.focus();
  promptEl.setSelectionRange(
    Math.min(state.start, limit),
    Math.min(state.end, limit)
  );
}

/** Class applied to each event wrapper so incremental updates can find it. */
const EVENT_ID_ATTR = "data-sidekick-event-id";

/** Chats shown on the home page. The rest are behind the Chats dropdown. */
const RECENT_CHAT_LIMIT = 5;

/**
 * Re-renders only the text of a single streamed event. Returns false when the
 * element is not on screen (e.g. a structural change is pending), in which
 * case the caller should fall back to a full render.
 */
export function updateStreamedEventText(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions,
  event: AgentEvent
): boolean {
  if (hasStreamSelection(containerEl)) return true;
  const eventEl = containerEl.querySelector(
    `[${EVENT_ID_ATTR}="${CSS.escape(event.id)}"]`
  );
  if (!(eventEl instanceof HTMLElement)) {
    return false;
  }

  const textEl = eventEl.querySelector(".agent-dashboard__event-text");
  if (!(textEl instanceof HTMLElement)) {
    return false;
  }

  const streamEl = eventEl.closest(".agent-dashboard__event-stream");
  const pinned =
    streamEl instanceof HTMLElement ? isScrolledToBottom(streamEl) : false;

  textEl.empty();
  void MarkdownRenderer.render(
    plugin.app,
    normalizeTableSpacing(event.text),
    textEl,
    plugin.app.workspace.getActiveFile()?.path ?? "",
    options.host.markdownComponent
  ).then(() => {
    linkInlineReferencedFiles(plugin, textEl);
    if (pinned && streamEl instanceof HTMLElement) {
      streamEl.scrollTop = streamEl.scrollHeight;
    }
  });


  return true;
}

/** Within a few pixels of the bottom, so auto-scroll does not fight the user. */
function isScrolledToBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

/**
 * Markdown, maths, and embeds all render asynchronously, so setting scrollTop
 * during the render lands on a height that is about to grow — which is why the
 * view appeared to jump upwards. This re-pins as content settles, and gets out
 * of the way the moment the user scrolls.
 */
function stickToBottom(streamEl: HTMLElement, settleMs = 2000): void {
  const pin = (): void => {
    streamEl.scrollTop = streamEl.scrollHeight;
  };

  pin();

  const observer = new ResizeObserver(pin);
  observer.observe(streamEl);
  for (const child of Array.from(streamEl.children)) {
    observer.observe(child);
  }

  const release = (): void => {
    observer.disconnect();
    streamEl.removeEventListener("wheel", release);
    streamEl.removeEventListener("touchstart", release);
  };

  streamEl.addEventListener("wheel", release, { passive: true });
  streamEl.addEventListener("touchstart", release, { passive: true });
  window.setTimeout(release, settleMs);
}

function renderEmbeddedShell(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const headerEl = containerEl.createDiv({ cls: "agent-dashboard__header" });
  const titleWrapEl = headerEl.createDiv({ cls: "agent-dashboard__title-wrap" });
  const titleIconEl = titleWrapEl.createSpan({
    attr: { "aria-label": "Local Sidekick", title: "Local Sidekick" },
    cls: "agent-dashboard__title-icon"
  });
  setIcon(titleIconEl, "bot");
  titleWrapEl.createEl("p", { text: describeDashboard(plugin, options) });

  const actionsEl = headerEl.createDiv({ cls: "agent-dashboard__actions" });
  new ButtonComponent(actionsEl)
    .setButtonText("Open")
    .setTooltip("Open full dashboard")
    .onClick(async () => {
      await plugin.activateView();
    });

  const listEl = containerEl.createDiv({ cls: "agent-dashboard__status-list" });
  renderStatusList(plugin, listEl, options);
}

function renderTopBar(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const barEl = containerEl.createDiv({ cls: "agent-dashboard__topbar" });
  const rowEl = barEl.createDiv({ cls: "agent-dashboard__topbar-row" });

  const configButton = new ButtonComponent(rowEl)
    .setButtonText("Config")
    .setTooltip(
      options.host.ui.menuOpen
        ? "Hide status and configuration"
        : "Show status and configuration"
    )
    .onClick(() => {
      options.host.ui.menuOpen = !options.host.ui.menuOpen;
      // The two dropdowns share the space below the bar.
      options.host.ui.chatsOpen = false;
      options.host.rerender();
    });
  configButton.buttonEl.addClass("agent-dashboard__menu-toggle");
  configButton.buttonEl.toggleClass("is-active", options.host.ui.menuOpen);

  const chatsButton = new ButtonComponent(rowEl)
    .setButtonText("Chats")
    .setTooltip("Browse every chat, newest first")
    .onClick(() => {
      options.host.ui.chatsOpen = !options.host.ui.chatsOpen;
      options.host.ui.menuOpen = false;
      options.host.rerender();
    });
  chatsButton.buttonEl.addClass("agent-dashboard__menu-toggle");
  chatsButton.buttonEl.toggleClass("is-active", options.host.ui.chatsOpen);

  renderAgentPickerToggle(plugin, rowEl, options);

  // Kill only once Pi discovery has succeeded, so the button never offers to
  // tear down something that was never brought up.
  const ready = isPipelineReady(plugin);
  const startButton = new ButtonComponent(
    rowEl.createDiv({ cls: "agent-dashboard__topbar-actions" })
  )
    // "Kill" rather than "Stop", so it is not mistaken for the composer's
    // Stop, which ends the current reply. This tears down the whole pipeline.
    .setButtonText(plugin.pipelineStopping ? "Unloading..." : ready ? "Kill" : "Start")
    .setDisabled(plugin.pipelineStopping)
    .setTooltip(
      ready
        ? "Unload the model from Ollama to free memory. Press Start to bring it back."
        : "Check Ollama, probe Pi, discover models, and activate one"
    )
    .setCta()
    .onClick(async () => {
      if (ready) {
        await plugin.shutdownPipeline();
      } else {
        await plugin.startPipeline();
      }
      options.host.rerender();
    });
  startButton.buttonEl.addClass("agent-dashboard__start-button");
  startButton.buttonEl.toggleClass("is-kill", ready);
  startButton.buttonEl.toggleClass("is-start", !ready);

  if (options.host.ui.agentPickerOpen) {
    renderAgentPickerPopover(plugin, barEl, options);
  }

  renderPipelineIndicator(plugin, barEl);
}

function renderAgentPickerToggle(
  plugin: AgentDashboardPlugin,
  rowEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const profile = plugin.getSelectedSidekickProfile();
  const modelLabel = getCurrentModelLabel(plugin);
  const toggleEl = rowEl.createEl("button", {
    cls: "agent-dashboard__agent-picker-toggle",
    type: "button"
  });
  toggleEl.toggleClass("is-active", options.host.ui.agentPickerOpen);
  toggleEl.createSpan({
    cls: "agent-dashboard__agent-picker-label",
    text: `${profile ? profile.name : "No profile"} · ${modelLabel ? getShortModelLabel(modelLabel) : "no model"}`
  });
  setIcon(
    toggleEl.createSpan({ cls: "agent-dashboard__agent-picker-caret" }),
    options.host.ui.agentPickerOpen ? "chevron-up" : "chevron-down"
  );
  toggleEl.addEventListener("click", () => {
    options.host.ui.agentPickerOpen = !options.host.ui.agentPickerOpen;
    options.host.rerender();
  });
}

// Pi's RPC discovery only lists models configured in Pi, but Pi can run any
// model the local Ollama server has via `ollama/<name>`. Merge both so every
// local model is selectable, not just the ones Pi happens to pre-list.
function collectPickerModels(
  plugin: AgentDashboardPlugin
): PiRpcDiscoverySnapshot["models"] {
  const seen = new Set<string>();
  const merged: PiRpcDiscoverySnapshot["models"] = [];

  for (const model of plugin.piRpcDiscoverySnapshot.models) {
    if (!seen.has(model.label)) {
      seen.add(model.label);
      merged.push(model);
    }
  }

  // Only meaningful once discovery has actually returned a list. Before Start
  // the snapshot is empty because nothing has asked Pi yet, not because Pi is
  // missing these models — flagging then would condemn every model on load.
  const piListIsKnown = plugin.piRpcDiscoverySnapshot.status === "ready";

  // Ollama's inventory is not Pi's model list. Anything only Ollama knows about
  // is surfaced so a freshly pulled model is not invisible, but flagged once we
  // can tell, because Pi cannot activate a model absent from its own config.
  for (const model of plugin.ollamaSnapshot.models) {
    const label = `ollama/${model.name}`;
    if (!seen.has(label)) {
      seen.add(label);
      merged.push(piListIsKnown ? { label, name: UNKNOWN_TO_PI } : { label });
    }
  }

  return merged;
}

function isUnknownToPi(model: { name?: string }): boolean {
  return model.name === UNKNOWN_TO_PI;
}

/**
 * Pi only offers models listed in ~/.pi/agent/models.json; it does not read
 * Ollama's inventory. Rather than editing that file ourselves — it sits outside
 * the vault, which this plugin never writes to — hand the user the entry to
 * paste.
 */
function copyPiModelEntry(modelLabel: string): void {
  const modelId = getOllamaModelName(modelLabel);
  const snippet = `{ "id": ${JSON.stringify(modelId)} }`;

  void navigator.clipboard
    .writeText(snippet)
    .then(() => {
      new Notice(
        `Copied ${snippet}\n\nPaste it into the "models" array for your ollama provider in ~/.pi/agent/models.json, then press Start to rediscover.`,
        10000
      );
    })
    .catch(() => {
      new Notice(
        `Add this to the "models" array for your ollama provider in ~/.pi/agent/models.json, then press Start:\n\n${snippet}`,
        10000
      );
    });
}

function renderAgentPickerPopover(
  plugin: AgentDashboardPlugin,
  barEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const popoverEl = barEl.createDiv({
    cls: "agent-dashboard__agent-picker-popover"
  });

  const headingEl = popoverEl.createDiv({
    cls: "agent-dashboard__agent-picker-heading-row"
  });
  headingEl.createSpan({
    cls: "agent-dashboard__agent-picker-heading",
    text: "Model · profile"
  });
  const controlsEl = headingEl.createDiv({
    cls: "agent-dashboard__panel-controls"
  });
  new ButtonComponent(controlsEl)
    .setButtonText("Refresh")
    .setTooltip("Reload Sidekick agent profiles")
    .onClick(async () => {
      await plugin.refreshSidekickProfiles(true);
      options.host.rerender();
    });
  new ButtonComponent(controlsEl)
    .setButtonText("Create")
    .setTooltip("Create starter Sidekick agent and memory files")
    .onClick(async () => {
      await plugin.createSidekickStarterFiles();
      options.host.rerender();
    });

  const models = collectPickerModels(plugin);
  if (models.length === 0) {
    popoverEl.createDiv({
      cls: "agent-dashboard__agent-picker-empty",
      text:
        plugin.piRpcDiscoverySnapshot.status === "checking"
          ? "Discovering models…"
          : "Press Start to discover local models."
    });
    return;
  }

  const modelLabel = getCurrentModelLabel(plugin);
  const profiles = plugin.getSidekickProfiles();
  const selectedProfile = plugin.getSelectedSidekickProfile();

  for (const model of models) {
    const isSelectedModel = model.label === modelLabel;
    const isExpanded = options.host.ui.expandedModelLabel === model.label;
    const modelEl = popoverEl.createDiv({
      cls: "agent-dashboard__agent-picker-model"
    });
    modelEl.toggleClass("is-selected", isSelectedModel);
    modelEl.toggleClass("is-expanded", isExpanded);

    const rowEl = modelEl.createDiv({
      cls: "agent-dashboard__agent-picker-model-row"
    });

    const labelEl = rowEl.createEl("button", {
      cls: "agent-dashboard__agent-picker-option agent-dashboard__agent-picker-option--model",
      type: "button"
    });
    const unknownToPi = isUnknownToPi(model);
    labelEl.toggleClass("is-selected", isSelectedModel);
    labelEl.toggleClass("is-unavailable", unknownToPi);
    labelEl.createSpan({
      cls: "agent-dashboard__agent-picker-option-label",
      text: getShortModelLabel(model.label)
    });

    if (unknownToPi) {
      labelEl.setAttr(
        "aria-label",
        `${model.label} is installed in Ollama but is not in your Pi configuration. Click to copy the entry to add to models.json`
      );
      labelEl.setAttr(
        "title",
        "Pulled in Ollama, missing from your Pi config. Click to copy the models.json entry."
      );
      labelEl.createSpan({
        cls: "agent-dashboard__agent-picker-badge",
        text: "not in Pi"
      });
    }

    labelEl.addEventListener("click", () => {
      if (unknownToPi) {
        copyPiModelEntry(model.label);
        return;
      }

      options.host.ui.agentPickerOpen = false;
      void plugin.selectPiModel(model.label);
      options.host.rerender();
    });

    const caretEl = rowEl.createEl("button", {
      attr: { "aria-label": isExpanded ? "Hide profiles" : "Choose a profile" },
      cls: "agent-dashboard__agent-picker-caret-button",
      type: "button"
    });
    setIcon(
      caretEl.createSpan({ cls: "agent-dashboard__agent-picker-caret" }),
      isExpanded ? "chevron-down" : "chevron-right"
    );
    caretEl.addEventListener("click", () => {
      options.host.ui.expandedModelLabel = isExpanded ? null : model.label;
      options.host.rerender();
    });

    if (!isExpanded) {
      continue;
    }

    const submenuEl = modelEl.createDiv({
      cls: "agent-dashboard__agent-picker-submenu"
    });
    const applyPair = (profilePath: string): void => {
      options.host.ui.agentPickerOpen = false;
      void (async () => {
        await plugin.selectSidekickProfile(profilePath);
        await plugin.selectPiModel(model.label);
      })();
      options.host.rerender();
    };

    const noneOptionEl = submenuEl.createEl("button", {
      cls: "agent-dashboard__agent-picker-option",
      type: "button"
    });
    noneOptionEl.toggleClass("is-selected", isSelectedModel && !selectedProfile);
    noneOptionEl.createSpan({
      cls: "agent-dashboard__agent-picker-option-label",
      text: "No profile / default"
    });
    noneOptionEl.addEventListener("click", () => {
      applyPair("");
    });

    // Only profiles that can actually run on this model. A profile listing no
    // models works with any; one that lists models would otherwise be offered
    // here and then silently switch the model away on the next prompt.
    const compatibleProfiles = profiles.filter(
      (profile) =>
        profile.modelLabels.length === 0 ||
        profile.modelLabels.includes(model.label)
    );

    for (const profile of compatibleProfiles) {
      const optionEl = submenuEl.createEl("button", {
        cls: "agent-dashboard__agent-picker-option",
        type: "button"
      });
      optionEl.toggleClass(
        "is-selected",
        isSelectedModel && selectedProfile?.path === profile.path
      );
      optionEl.createSpan({
        cls: "agent-dashboard__agent-picker-option-label",
        text: profile.name
      });
      optionEl.addEventListener("click", () => {
        applyPair(profile.path);
      });
    }

    if (profiles.length > 0 && compatibleProfiles.length === 0) {
      submenuEl.createDiv({
        cls: "agent-dashboard__agent-picker-empty",
        text: "No profile lists this model"
      });
    }
  }
}

/**
 * Usable means Pi answered discovery with a model list — that is what a prompt
 * actually needs. Both the Start/Kill button and the indicator read this, so
 * they cannot disagree.
 */
function isPipelineReady(plugin: AgentDashboardPlugin): boolean {
  return !plugin.pipelineStopped && plugin.piRpcDiscoverySnapshot.status === "ready";
}

function renderPipelineIndicator(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement
): void {
  const ready = isPipelineReady(plugin);
  // Amber when Ollama answers but Pi has not produced a model list yet: the
  // half-configured state users actually land in.
  const ollamaUp = plugin.ollamaSnapshot.status === "running";
  const indicatorEl = containerEl.createDiv({
    cls: "agent-dashboard__topbar-title"
  });
  const dotEl = indicatorEl.createSpan({ cls: "agent-dashboard__pipeline-dot" });
  dotEl.toggleClass("is-running", ready);
  dotEl.toggleClass("is-partial", ollamaUp && !ready);

  const model = getCurrentModelLabel(plugin);
  indicatorEl.createSpan({
    cls: "agent-dashboard__pipeline-label",
    text: ready
      ? model
        ? getShortModelLabel(model)
        : "ready"
      : ollamaUp
        ? "Ollama only"
        : "stopped"
  });
}

function renderMenuDropdown(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const menuEl = containerEl.createDiv({ cls: "agent-dashboard__menu" });

  const statusSection = menuEl.createDiv({ cls: "agent-dashboard__menu-section" });
  const statusHeadingEl = statusSection.createDiv({
    cls: "agent-dashboard__menu-heading"
  });
  statusHeadingEl.createEl("h4", { text: "Status" });
  const statusControlsEl = statusHeadingEl.createDiv({
    cls: "agent-dashboard__panel-controls"
  });
  new ButtonComponent(statusControlsEl)
    .setButtonText("Recheck")
    .setTooltip("Re-run the full start pipeline")
    .onClick(async () => {
      await plugin.startPipeline();
      options.host.rerender();
    });
  renderDropdownClose(statusControlsEl, options, "Close config");
  const listEl = statusSection.createDiv({ cls: "agent-dashboard__status-list" });
  renderStatusList(plugin, listEl, options);
}

/** Every chat, newest first. The home page shows only the most recent few. */
function renderChatsDropdown(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const menuEl = containerEl.createDiv({
    cls: "agent-dashboard__menu agent-dashboard__menu--chats"
  });

  const headingEl = menuEl.createDiv({ cls: "agent-dashboard__menu-heading" });
  headingEl.createEl("h4", { text: "All chats" });
  const controlsEl = headingEl.createDiv({
    cls: "agent-dashboard__panel-controls"
  });
  new ButtonComponent(controlsEl)
    .setButtonText("New")
    .setTooltip("Open an empty new chat")
    .setDisabled(plugin.agentSessionStatus === "running")
    .onClick(() => {
      options.host.ui.chatsOpen = false;
      void plugin.startNewAgentSession();
      options.host.rerender();
    });
  renderDropdownClose(controlsEl, options, "Close all chats");

  const sessions = plugin.getAgentSessionHistory();
  if (sessions.length === 0) {
    menuEl.createEl("p", {
      cls: "agent-dashboard__empty",
      text: "No chats yet."
    });
    return;
  }

  const listEl = menuEl.createDiv({
    cls: "agent-dashboard__session-list agent-dashboard__session-list--scroll"
  });
  for (const session of sessions) {
    renderSessionHistoryItem(plugin, listEl, options, session, () => {
      options.host.ui.chatsOpen = false;
    });
  }
}

function renderStatusList(
  plugin: AgentDashboardPlugin,
  listEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  renderPiStatusItems(listEl, plugin.piSnapshot);
  renderPiRpcStatusItems(listEl, plugin.piRpcDiscoverySnapshot);
  renderOllamaStatusItems(listEl, plugin.ollamaSnapshot);
  renderSafetyStatusItems(plugin, listEl);
  renderStatusItem(listEl, "Agent", plugin.agentSessionStatus);
  renderStatusItem(
    listEl,
    "Selected Pi",
    plugin.settings.selectedPiModel || "not selected"
  );
  renderStatusItem(listEl, "Workspace", options.workspace ?? "vault");
  renderStatusItem(listEl, "Session", plugin.getAgentSessionSummary());
}

function renderOllamaStatusItems(
  containerEl: HTMLElement,
  snapshot: OllamaSnapshot
): void {
  const status =
    snapshot.status === "running" && snapshot.version
      ? `running ${snapshot.version}`
      : snapshot.error
        ? `${snapshot.status}: ${snapshot.error}`
        : snapshot.status;

  renderStatusItem(containerEl, "Ollama", status);
  renderStatusItem(containerEl, "Host", snapshot.host);
  renderStatusItem(containerEl, "Models", describeModels(snapshot));

  if (snapshot.selectedModel) {
    renderStatusItem(
      containerEl,
      "Selected",
      snapshot.selectedModelAvailable === false
        ? `${snapshot.selectedModel} (missing)`
        : snapshot.selectedModel
    );
  }
}

function renderPiStatusItems(
  containerEl: HTMLElement,
  snapshot: PiSnapshot
): void {
  const status =
    snapshot.status === "available" && snapshot.version
      ? snapshot.version
      : snapshot.error
        ? `${snapshot.status}: ${snapshot.error}`
        : snapshot.status;

  renderStatusItem(containerEl, "Pi", status);
  renderStatusItem(containerEl, "Pi path", snapshot.executablePath);

  if (snapshot.probe) {
    renderStatusItem(containerEl, "Pi probe", snapshot.probe);
  }
}

function renderPiRpcStatusItems(
  containerEl: HTMLElement,
  snapshot: PiRpcDiscoverySnapshot
): void {
  const status =
    snapshot.status === "ready"
      ? describePiRpcReady(snapshot)
      : snapshot.error
        ? `${snapshot.status}: ${snapshot.error}`
        : snapshot.status;

  renderStatusItem(containerEl, "Pi RPC", status);

  if (snapshot.currentModel) {
    renderStatusItem(containerEl, "RPC model", snapshot.currentModel);
  }

  if (snapshot.modelCount !== undefined) {
    renderStatusItem(containerEl, "RPC models", String(snapshot.modelCount));
  }

  if (snapshot.models.length > 0) {
    renderStatusItem(containerEl, "RPC list", describePiRpcModels(snapshot));
  }
}

function describePiRpcReady(snapshot: PiRpcDiscoverySnapshot): string {
  const commandCount = snapshot.commandCount ?? 0;
  const responseCount = snapshot.responseCount ?? 0;
  return `ready (${responseCount}/${commandCount} discovery responses)`;
}

function describePiRpcModels(snapshot: PiRpcDiscoverySnapshot): string {
  const names = snapshot.models.slice(0, 3).map((model) => model.label);
  const extraCount = snapshot.models.length - names.length;

  if (extraCount > 0) {
    return `${names.join(", ")} +${extraCount}`;
  }

  return names.join(", ");
}

function describeModels(snapshot: OllamaSnapshot): string {
  if (snapshot.status === "checking") {
    return "checking...";
  }

  if (snapshot.status !== "running") {
    return "unknown";
  }

  if (snapshot.models.length === 0) {
    return "none found";
  }

  const names = snapshot.models.slice(0, 3).map((model) => model.name);
  const extraCount = snapshot.models.length - names.length;

  if (extraCount > 0) {
    return `${names.join(", ")} +${extraCount}`;
  }

  return names.join(", ");
}

function renderSafetyStatusItems(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement
): void {
  const snapshot = plugin.getSafetySnapshot();
  renderStatusItem(containerEl, "Safety", snapshot.mode);
  renderStatusItem(containerEl, "Pi tools", formatPiToolModeLabel(plugin.settings.piToolMode));
  renderStatusItem(
    containerEl,
    "Pi extras",
    plugin.settings.allowPiUserConfig ? "enabled" : "disabled"
  );
  renderStatusItem(
    containerEl,
    "Timeout",
    `${plugin.settings.piPromptTimeoutMinutes} min`
  );
  renderStatusItem(containerEl, "Roots", summarizeAllowedRoots(snapshot));
  renderStatusItem(containerEl, "Approvals", String(snapshot.pendingApprovals));
  renderStatusItem(
    containerEl,
    "Audit",
    `${plugin.safetyAuditLog.length} decisions`
  );

  if (plugin.lastSafetyDecision) {
    renderStatusItem(
      containerEl,
      "Last guard",
      plugin.lastSafetyDecision.allowed ? "allowed" : "blocked"
    );
  }
}

/** Short form for the status list. See describePiToolMode for the prose form. */
function formatPiToolModeLabel(toolMode: PiToolMode): string {
  if (toolMode === "read-only") {
    return "read, grep, find, ls";
  }

  return "disabled";
}

function renderAgentPanel(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const panelEl = containerEl.createDiv({
    cls: "agent-dashboard__panel agent-dashboard__panel--agent"
  });

  if (plugin.agentViewMode === "history") {
    renderAgentHistoryPage(plugin, panelEl, options);
    return;
  }

  const headingEl = panelEl.createDiv({ cls: "agent-dashboard__panel-heading" });
  const titleEl = headingEl.createDiv({
    cls: "agent-dashboard__chat-title"
  });
  new ButtonComponent(titleEl)
    .setIcon("arrow-left")
    .setTooltip("Back to chats")
    .onClick(() => {
      void plugin.showAgentHistory();
    });
  titleEl.createEl("h4", { text: "Chat" });
  renderCurrentAgentProfilePill(plugin, titleEl);
  renderCurrentModelPill(plugin, titleEl);

  const controlsEl = headingEl.createDiv({
    cls: "agent-dashboard__panel-controls"
  });

  // Stopping a run lives on the composer, next to where the reply is arriving.
  new ButtonComponent(controlsEl)
    .setButtonText("Clear")
    .setTooltip("Clear agent event stream")
    .onClick(() => {
      plugin.clearAgentEvents();
      options.host.rerender();
    });

  new ButtonComponent(controlsEl)
    .setButtonText("New")
    .setTooltip("Start a fresh persistent Pi session")
    .setDisabled(plugin.agentSessionStatus === "running")
    .onClick(() => {
      void plugin.startNewAgentSession();
      options.host.rerender();
    });

  new ButtonComponent(controlsEl)
    .setButtonText("Export")
    .setTooltip("Export chat to Markdown")
    .setDisabled(
      plugin.agentSessionStatus === "running" || plugin.agentEvents.length === 0
    )
    .onClick(() => {
      plugin.openChatExportModal();
    });

  renderApprovalQueue(plugin, panelEl, options);

  const streamEl = panelEl.createDiv({ cls: "agent-dashboard__event-stream" });
  if (plugin.agentEvents.length === 0) {
    streamEl.createEl("p", {
      cls: "agent-dashboard__empty",
      text: "No agent events yet."
    });
  } else {
    // Consecutive tool events collapse into one summary row, so a run that
    // reads a dozen files does not bury the reply under a dozen cards.
    for (const group of groupConsecutiveToolEvents(plugin.agentEvents)) {
      if (group.length === 1 && group[0].kind !== "tool") {
        renderAgentEvent(plugin, streamEl, options, group[0]);
        continue;
      }

      renderToolEventGroup(plugin, streamEl, options, group);
    }
  }

  const composerEl = panelEl.createDiv({ cls: "agent-dashboard__composer" });
  renderPinnedContext(plugin, composerEl);
  renderQueuedPrompt(plugin, composerEl, options);
  renderRunControls(plugin, composerEl, options);

  const promptEl = composerEl.createEl("textarea", {
    cls: "agent-dashboard__prompt-input",
    attr: {
      placeholder: "Ask the agent...  Enter to send, Shift+Enter for a new line",
      rows: "3"
    }
  });
  // A rebuild destroys the textarea, so an unsent draft is kept on the host.
  promptEl.value = options.host.ui.promptDraft;
  promptEl.addEventListener("input", () => {
    options.host.ui.promptDraft = promptEl.value;
  });
  // Deliberately still editable while a reply streams, so the next message can
  // be written without waiting. Only sending is gated on the run finishing.
  const suggestionsEl = composerEl.createDiv({
    cls: "agent-dashboard__mention-suggestions"
  });
  suggestionsEl.hide();
  let mentionSuggestions: string[] = [];
  let selectedMentionIndex = 0;

  promptEl.addEventListener("keydown", (event) => {
    // Enter sends; Shift+Enter is a newline. When the mention list is open
    // Enter belongs to it, so that case is handled further down.
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !suggestionsEl.hasClass("is-visible")
    ) {
      event.preventDefault();
      void sendPrompt("none");
      closeMentionSuggestions();
      return;
    }

    if (!suggestionsEl.hasClass("is-visible")) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedMentionIndex = Math.min(
        selectedMentionIndex + 1,
        mentionSuggestions.length - 1
      );
      renderMentionSuggestions();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedMentionIndex = Math.max(selectedMentionIndex - 1, 0);
      renderMentionSuggestions();
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      acceptMentionSuggestion(mentionSuggestions[selectedMentionIndex]);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionSuggestions();
    }
  });
  promptEl.addEventListener("input", () => {
    updateMentionSuggestions();
  });
  promptEl.addEventListener("click", () => {
    updateMentionSuggestions();
  });

  const running = plugin.agentSessionStatus === "running";
  const composerActionsEl = composerEl.createDiv({
    cls: "agent-dashboard__composer-actions"
  });

  renderIconButton(composerActionsEl, {
    fallbackText: "Note",
    icon: "file-text",
    tooltip: "Send with the current note as context",
    variant: "note",
    onClick: () => void sendPrompt("note")
  });

  renderIconButton(composerActionsEl, {
    fallbackText: "Selection",
    icon: "mouse-pointer",
    tooltip: "Send with the current editor selection as context",
    variant: "selection",
    onClick: () => void sendPrompt("selection")
  });

  renderIconButton(composerActionsEl, {
    fallbackText: "Vault",
    icon: "vault",
    tooltip: "Send with vault search and related-note context",
    variant: "vault",
    onClick: () => void sendPrompt("vault")
  });

  renderIconButton(composerActionsEl, {
    disabled: running,
    fallbackText: "Links",
    icon: "link-2",
    tooltip: "Suggest conservative internal links for the current note",
    variant: "links",
    onClick: () => {
      // suggestInternalLinksForActiveNote repaints when it resolves; repainting
      // here as well would only render the state from before it ran.
      void plugin.suggestInternalLinksForActiveNote();
    }
  });

  composerActionsEl.createDiv({ cls: "agent-dashboard__composer-spacer" });
  renderThinkingControl(plugin, composerActionsEl, options);

  if (running) {
    renderIconButton(composerActionsEl, {
      fallbackText: "Stop",
      icon: "square",
      tooltip: "Stop the current response",
      variant: "stop",
      onClick: () => {
        plugin.stopAgentRun();
        options.host.rerender();
      }
    });
  }

  // Sends normally; queues instead when a run is already in flight.
  renderIconButton(composerActionsEl, {
    fallbackText: running ? "Queue" : "Send",
    icon: running ? "clock" : "corner-down-left",
    tooltip: running
      ? "Queue this prompt for when the current run finishes"
      : "Send prompt (Enter)",
    variant: running ? "queue" : "send",
    onClick: () => void sendPrompt("none")
  });

  async function sendPrompt(
    contextMode: "none" | "note" | "selection" | "vault"
  ): Promise<void> {
    const accepted = await plugin.sendAgentPrompt(promptEl.value, contextMode);
    if (!accepted) {
      return;
    }

    promptEl.value = "";
    options.host.ui.promptDraft = "";
    closeMentionSuggestions();
    options.host.rerender();
  }

  function updateMentionSuggestions(): void {
    const mention = getActiveMention(promptEl);
    if (!mention) {
      closeMentionSuggestions();
      return;
    }

    mentionSuggestions = plugin.getVaultFileSuggestions(mention.query);
    selectedMentionIndex = 0;

    if (mentionSuggestions.length === 0) {
      closeMentionSuggestions();
      return;
    }

    renderMentionSuggestions();
  }

  function renderMentionSuggestions(): void {
    suggestionsEl.empty();
    suggestionsEl.show();
    suggestionsEl.addClass("is-visible");

    for (let index = 0; index < mentionSuggestions.length; index += 1) {
      const suggestion = mentionSuggestions[index];
      const itemEl = suggestionsEl.createDiv({
        cls: "agent-dashboard__mention-suggestion",
        text: suggestion
      });
      itemEl.toggleClass("is-selected", index === selectedMentionIndex);
      itemEl.addEventListener("mousedown", (event) => {
        event.preventDefault();
        acceptMentionSuggestion(suggestion);
      });
    }
  }

  function closeMentionSuggestions(): void {
    mentionSuggestions = [];
    selectedMentionIndex = 0;
    suggestionsEl.removeClass("is-visible");
    suggestionsEl.hide();
    suggestionsEl.empty();
  }

  function acceptMentionSuggestion(suggestion: string | undefined): void {
    if (!suggestion) {
      closeMentionSuggestions();
      return;
    }

    const mention = getActiveMention(promptEl);
    if (!mention) {
      closeMentionSuggestions();
      return;
    }

    const value = promptEl.value;
    const suffix = value.slice(mention.end);
    const trailingSpace = suffix.length > 0 && !/^\s/.test(suffix) ? " " : "";
    const insertion = mention.query.startsWith("[[")
      ? `@[[${suggestion.replace(/\.md$/i, "")}]]${trailingSpace}`
      : `@${suggestion}${trailingSpace}`;
    promptEl.value = `${value.slice(0, mention.start)}${insertion}${suffix}`;
    options.host.ui.promptDraft = promptEl.value;
    const cursor = mention.start + insertion.length;
    promptEl.setSelectionRange(cursor, cursor);
    promptEl.focus();
    closeMentionSuggestions();
  }
}

function renderAgentHistoryPage(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const pageEl = containerEl.createDiv({
    cls: "agent-dashboard__session-page"
  });

  const composerEl = pageEl.createDiv({
    cls: "agent-dashboard__session-composer"
  });
  const promptEl = composerEl.createEl("textarea", {
    cls: "agent-dashboard__prompt-input",
    attr: {
      placeholder: "Start a new chat...  Enter to send, Shift+Enter for a new line",
      rows: "3"
    }
  });
  // A rebuild destroys the textarea, so an unsent draft is kept on the host.
  promptEl.value = options.host.ui.promptDraft;
  promptEl.addEventListener("input", () => {
    options.host.ui.promptDraft = promptEl.value;
  });
  const suggestionsEl = composerEl.createDiv({
    cls: "agent-dashboard__mention-suggestions"
  });
  suggestionsEl.hide();
  let mentionSuggestions: string[] = [];
  let selectedMentionIndex = 0;

  const actionsEl = composerEl.createDiv({
    cls: "agent-dashboard__composer-actions"
  });

  renderIconButton(actionsEl, {
    fallbackText: "Note",
    icon: "file-text",
    tooltip: "Start a new chat with the current note as context",
    variant: "note",
    onClick: () => void startSession("note")
  });

  renderIconButton(actionsEl, {
    fallbackText: "Selection",
    icon: "mouse-pointer",
    tooltip: "Start a new chat with the current editor selection as context",
    variant: "selection",
    onClick: () => void startSession("selection")
  });

  renderIconButton(actionsEl, {
    fallbackText: "Vault",
    icon: "vault",
    tooltip: "Start a new chat with vault search and related-note context",
    variant: "vault",
    onClick: () => void startSession("vault")
  });

  actionsEl.createDiv({ cls: "agent-dashboard__composer-spacer" });
  renderThinkingControl(plugin, actionsEl, options);

  renderIconButton(actionsEl, {
    fallbackText: "Send",
    icon: "corner-down-left",
    tooltip: "Start a new chat (Enter)",
    variant: "send",
    onClick: () => void startSession("none")
  });

  promptEl.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !suggestionsEl.hasClass("is-visible")
    ) {
      event.preventDefault();
      void startSession("none");
      closeMentionSuggestions();
      return;
    }

    if (!suggestionsEl.hasClass("is-visible")) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedMentionIndex = Math.min(
        selectedMentionIndex + 1,
        mentionSuggestions.length - 1
      );
      renderMentionSuggestions();
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedMentionIndex = Math.max(selectedMentionIndex - 1, 0);
      renderMentionSuggestions();
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      acceptMentionSuggestion(mentionSuggestions[selectedMentionIndex]);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionSuggestions();
    }
  });
  promptEl.addEventListener("input", () => {
    updateMentionSuggestions();
  });
  promptEl.addEventListener("click", () => {
    updateMentionSuggestions();
  });

  const historyEl = pageEl.createDiv({
    cls: "agent-dashboard__session-history"
  });
  const headingEl = historyEl.createDiv({
    cls: "agent-dashboard__session-history-heading"
  });
  headingEl.createSpan({ text: "Recent chats" });
  new ButtonComponent(headingEl)
    .setButtonText("New")
    .setTooltip("Open an empty new chat")
    .onClick(() => {
      void plugin.startNewAgentSession();
      options.host.rerender();
    });

  const sessions = plugin.getAgentSessionHistory();
  if (sessions.length === 0) {
    historyEl.createEl("p", {
      cls: "agent-dashboard__empty",
      text: "No chats yet."
    });
  } else {
    const listEl = historyEl.createDiv({
      cls: "agent-dashboard__session-list"
    });
    // Only the most recent few; the rest live behind Chats in the top bar.
    for (const session of sessions.slice(0, RECENT_CHAT_LIMIT)) {
      renderSessionHistoryItem(plugin, listEl, options, session);
    }

    const hiddenCount = sessions.length - RECENT_CHAT_LIMIT;
    if (hiddenCount > 0) {
      const moreEl = historyEl.createEl("button", {
        cls: "agent-dashboard__session-more",
        text: `${hiddenCount} more in Chats`,
        type: "button"
      });
      moreEl.addEventListener("click", () => {
        options.host.ui.chatsOpen = true;
        options.host.ui.menuOpen = false;
        options.host.rerender();
      });
    }
  }

  async function startSession(
    contextMode: "none" | "note" | "selection" | "vault"
  ): Promise<void> {
    const prompt = promptEl.value.trim();
    if (!prompt) {
      return;
    }

    await plugin.startNewAgentSession();
    const accepted = await plugin.sendAgentPrompt(prompt, contextMode);
    if (accepted) {
      promptEl.value = "";
      options.host.ui.promptDraft = "";
      closeMentionSuggestions();
    }
    options.host.rerender();
  }

  function updateMentionSuggestions(): void {
    const mention = getActiveMention(promptEl);
    if (!mention) {
      closeMentionSuggestions();
      return;
    }

    mentionSuggestions = plugin.getVaultFileSuggestions(mention.query);
    selectedMentionIndex = 0;

    if (mentionSuggestions.length === 0) {
      closeMentionSuggestions();
      return;
    }

    renderMentionSuggestions();
  }

  function renderMentionSuggestions(): void {
    suggestionsEl.empty();
    suggestionsEl.show();
    suggestionsEl.addClass("is-visible");

    for (let index = 0; index < mentionSuggestions.length; index += 1) {
      const suggestion = mentionSuggestions[index];
      const itemEl = suggestionsEl.createDiv({
        cls: "agent-dashboard__mention-suggestion",
        text: suggestion
      });
      itemEl.toggleClass("is-selected", index === selectedMentionIndex);
      itemEl.addEventListener("mousedown", (event) => {
        event.preventDefault();
        acceptMentionSuggestion(suggestion);
      });
    }
  }

  function closeMentionSuggestions(): void {
    mentionSuggestions = [];
    selectedMentionIndex = 0;
    suggestionsEl.removeClass("is-visible");
    suggestionsEl.hide();
    suggestionsEl.empty();
  }

  function acceptMentionSuggestion(suggestion: string | undefined): void {
    if (!suggestion) {
      closeMentionSuggestions();
      return;
    }

    const mention = getActiveMention(promptEl);
    if (!mention) {
      closeMentionSuggestions();
      return;
    }

    const value = promptEl.value;
    const suffix = value.slice(mention.end);
    const trailingSpace = suffix.length > 0 && !/^\s/.test(suffix) ? " " : "";
    const insertion = mention.query.startsWith("[[")
      ? `@[[${suggestion.replace(/\.md$/i, "")}]]${trailingSpace}`
      : `@${suggestion}${trailingSpace}`;
    promptEl.value = `${value.slice(0, mention.start)}${insertion}${suffix}`;
    options.host.ui.promptDraft = promptEl.value;
    const cursor = mention.start + insertion.length;
    promptEl.setSelectionRange(cursor, cursor);
    promptEl.focus();
    closeMentionSuggestions();
  }
}

function renderSessionHistoryItem(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions,
  session: AgentSessionHistoryItem,
  /** Lets the dropdown close itself before the chat opens. */
  beforeOpen?: () => void
): void {
  const itemEl = containerEl.createDiv({
    attr: {
      role: "button",
      tabindex: "0"
    },
    cls: "agent-dashboard__session-item"
  });
  itemEl.createSpan({
    cls: "agent-dashboard__session-title",
    text: session.title
  });
  itemEl.createSpan({
    cls: "agent-dashboard__session-date",
    text: formatSessionDate(session.updatedAt)
  });

  const openSession = (): void => {
    beforeOpen?.();
    void plugin.openAgentSession(session.name);
    options.host.rerender();
  };

  itemEl.addEventListener("click", openSession);
  itemEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    openSession();
  });
}

function getActiveMention(
  promptEl: HTMLTextAreaElement
): { end: number; query: string; start: number } | undefined {
  const cursor = promptEl.selectionStart ?? 0;
  const beforeCursor = promptEl.value.slice(0, cursor);
  // Vault filenames contain spaces, so the query may too. Bounded by a newline,
  // a second @, and a length cap; once it stops matching any file the caller
  // closes the list, which is what ends the mention when you carry on typing.
  const match = beforeCursor.match(/(^|\s)@([^\n@]{0,80})$/);
  if (!match || match.index === undefined) {
    return undefined;
  }

  const start = match.index + match[1].length;
  return {
    end: cursor,
    query: match[2],
    start
  };
}

function renderCurrentAgentProfilePill(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement
): void {
  const profile = plugin.getSelectedSidekickProfile();
  if (!profile) {
    return;
  }

  const pillEl = containerEl.createSpan({
    cls: "agent-dashboard__chat-agent-pill"
  });
  setIcon(pillEl.createSpan({ cls: "agent-dashboard__chat-agent-pill-icon" }), "sparkles");
  pillEl.createSpan({
    cls: "agent-dashboard__chat-agent-pill-label",
    text: profile.name
  });
}

function renderCurrentModelPill(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement
): void {
  const selectedLabel = getCurrentModelLabel(plugin);
  if (!selectedLabel) {
    return;
  }

  renderModelBadge(containerEl, selectedLabel, "agent-dashboard__chat-model-pill");
}

function renderModelBadge(
  containerEl: HTMLElement,
  modelLabel: string,
  className: string
): void {
  const badgeEl = containerEl.createSpan({
    cls: className
  });
  badgeEl.createSpan({
    cls: "agent-dashboard__model-logo",
    text: getModelLogoText(modelLabel)
  });

  if (
    className === "agent-dashboard__model-current" ||
    className === "agent-dashboard__chat-model-pill"
  ) {
    badgeEl.createSpan({
      cls: "agent-dashboard__model-current-label",
      text: getShortModelLabel(modelLabel)
    });
  }
}

function getCurrentModelLabel(plugin: AgentDashboardPlugin): string {
  return (
    plugin.settings.selectedPiModel ||
    plugin.piRpcDiscoverySnapshot.currentModel ||
    ""
  );
}

function getShortModelLabel(modelLabel: string): string {
  return modelLabel.replace(/^ollama\//, "");
}

function getModelLogoText(modelLabel: string): string {
  const label = modelLabel.toLowerCase();
  if (label.includes("deepseek")) {
    return "D";
  }

  if (label.includes("gemma")) {
    return "G";
  }

  if (label.includes("qwen")) {
    return "Q";
  }

  if (label.includes("llama")) {
    return "L";
  }

  if (label.includes("mistral")) {
    return "M";
  }

  return "O";
}

function renderApprovalQueue(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions
): void {
  const pendingRecords = plugin.getPendingApprovalRecords();
  if (pendingRecords.length === 0) {
    return;
  }

  const queueEl = containerEl.createDiv({
    cls: "agent-dashboard__approval-queue"
  });
  const headingEl = queueEl.createDiv({
    cls: "agent-dashboard__approval-heading"
  });
  headingEl.createSpan({ text: "Approvals" });
  headingEl.createSpan({
    cls: "agent-dashboard__approval-note",
    text: "record only"
  });

  for (const record of pendingRecords) {
    renderApprovalRecord(plugin, queueEl, options, record);
  }
}

function renderApprovalRecord(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions,
  record: ApprovalRecord
): void {
  const cardEl = containerEl.createDiv({ cls: "agent-dashboard__approval-card" });
  const titleEl = cardEl.createDiv({ cls: "agent-dashboard__approval-title" });
  titleEl.createSpan({ text: getApprovalTitle(record) });
  titleEl.createSpan({
    cls: "agent-dashboard__approval-kind",
    text: record.decision.request.kind
  });

  cardEl.createDiv({
    cls: "agent-dashboard__approval-reason",
    text: record.decision.reason
  });

  const detail = getApprovalDetail(record);
  if (detail) {
    cardEl.createDiv({
      cls: "agent-dashboard__approval-detail",
      text: detail
    });
  }

  cardEl.createDiv({
    cls: "agent-dashboard__approval-note",
    text: record.note
  });

  const actionsEl = cardEl.createDiv({
    cls: "agent-dashboard__approval-actions"
  });
  new ButtonComponent(actionsEl)
    .setButtonText("Approve")
    .setTooltip("Record approval without executing")
    .onClick(() => {
      plugin.approveRequest(record.id);
      options.host.rerender();
    });

  new ButtonComponent(actionsEl)
    .setButtonText("Deny")
    .setTooltip("Deny request")
    .onClick(() => {
      plugin.denyRequest(record.id);
      options.host.rerender();
    });
}

function getApprovalTitle(record: ApprovalRecord): string {
  return record.decision.request.description || "Approval request";
}

function getApprovalDetail(record: ApprovalRecord): string {
  const request = record.decision.request;

  if (request.command) {
    return request.command;
  }

  if (request.targetPath) {
    return request.targetPath;
  }

  return "";
}

export function hasStreamSelection(container: HTMLElement): boolean {
  const selection = container.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return [selection.anchorNode, selection.focusNode].some((node) => {
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
    return !!element?.closest(".agent-dashboard__event-text") && !!node && container.contains(node);
  });
}

function renderAgentEvent(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions,
  event: AgentEvent
): void {
  if (event.kind === "status") {
    renderStatusLogLine(containerEl, event);
    return;
  }

  if (event.kind === "tool") {
    renderToolEvent(plugin, containerEl, options, event);
    return;
  }

  const eventEl = containerEl.createDiv({
    attr: { [EVENT_ID_ATTR]: event.id },
    cls: `agent-dashboard__event agent-dashboard__event--${event.kind}`
  });
  const metaEl = eventEl.createDiv({ cls: "agent-dashboard__event-meta" });
  const labelEl = metaEl.createSpan({ cls: "agent-dashboard__event-label" });
  const iconEl = labelEl.createSpan({ cls: "agent-dashboard__event-icon" });
  setIcon(iconEl, getAgentEventIcon(event));
  labelEl.createSpan({ text: getAgentEventLabel(event) });

  metaEl.createSpan({
    cls: "agent-dashboard__event-time",
    text: formatEventTime(event.createdAt)
  });
  if (event.kind === "assistant") {
    new ButtonComponent(metaEl).setIcon("copy").setTooltip("Copy response")
      .onClick(async () => {
        const latest = plugin.agentEvents.find((entry) => entry.id === event.id)?.text ?? event.text;
        try { await navigator.clipboard.writeText(latest); new Notice("Response copied."); }
        catch { new Notice("Could not access clipboard. Select the response text to copy it."); }
      });
  }

  const textEl = eventEl.createDiv({
    cls: "agent-dashboard__event-text markdown-rendered"
  });
  void MarkdownRenderer.render(
    plugin.app,
    normalizeTableSpacing(event.text),
    textEl,
    plugin.app.workspace.getActiveFile()?.path ?? "",
    options.host.markdownComponent
  ).then(() => {
    linkInlineReferencedFiles(plugin, textEl);
  });
  renderReferencedFiles(plugin, eventEl, event.text);
  renderProposedEdits(plugin, eventEl, event.id);
}

/** Runs of adjacent tool events; every other event is its own group of one. */
function groupConsecutiveToolEvents(events: AgentEvent[]): AgentEvent[][] {
  const groups: AgentEvent[][] = [];

  for (const event of events) {
    const lastGroup = groups[groups.length - 1];
    if (event.kind === "tool" && lastGroup?.[0]?.kind === "tool") {
      lastGroup.push(event);
      continue;
    }

    groups.push([event]);
  }

  return groups;
}

/** One collapsed row for a run of tool events, expanding to the full list. */
function renderToolEventGroup(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions,
  events: AgentEvent[]
): void {
  const groupId = `tool-group-${events[0].id}`;
  const isOpen = options.host.ui.openToolEventIds.has(groupId);
  const hasWarning = events.some((event) => event.tool?.status === "blocked");

  const groupEl = containerEl.createDiv({ cls: "agent-dashboard__tool-group" });
  groupEl.toggleClass("is-open", isOpen);
  groupEl.toggleClass("has-warning", hasWarning);

  const headerEl = groupEl.createDiv({
    attr: {
      "aria-expanded": String(isOpen),
      role: "button",
      tabindex: "0"
    },
    cls: "agent-dashboard__tool-group-header"
  });

  headerEl.createSpan({
    cls: "agent-dashboard__tool-group-disclosure",
    text: isOpen ? "▾" : "▸"
  });
  const iconEl = headerEl.createSpan({ cls: "agent-dashboard__tool-group-icon" });
  setIcon(iconEl, hasWarning ? "alert-triangle" : "wrench");
  headerEl.createSpan({
    cls: "agent-dashboard__tool-group-label",
    text: summarizeToolGroup(events)
  });

  const toggle = (): void => {
    if (options.host.ui.openToolEventIds.has(groupId)) {
      options.host.ui.openToolEventIds.delete(groupId);
    } else {
      options.host.ui.openToolEventIds.add(groupId);
    }

    options.host.rerender();
  };

  headerEl.addEventListener("click", toggle);
  headerEl.addEventListener("keydown", (keyboardEvent) => {
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") {
      return;
    }

    keyboardEvent.preventDefault();
    toggle();
  });

  if (!isOpen) {
    return;
  }

  const bodyEl = groupEl.createDiv({ cls: "agent-dashboard__tool-group-body" });
  for (const event of events) {
    renderToolEvent(plugin, bodyEl, options, event);
  }
}

function summarizeToolGroup(events: AgentEvent[]): string {
  const names = new Set(
    events.map((event) => event.tool?.name).filter((name): name is string => !!name)
  );
  const count = events.length;
  const noun = count === 1 ? "step" : "steps";

  if (names.size === 0) {
    return `${count} context ${noun}`;
  }

  const shown = [...names].slice(0, 3).join(", ");
  const extra = names.size - Math.min(names.size, 3);
  return `${count} ${noun} · ${shown}${extra > 0 ? ` +${extra}` : ""}`;
}

function renderToolEvent(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  options: DashboardRenderOptions,
  event: AgentEvent
): void {
  const tool = event.tool ?? inferToolEvent(event.text);
  const cardEl = containerEl.createDiv({
    cls: `agent-dashboard__tool-card agent-dashboard__tool-card--${tool.status}`
  });

  const bodyId = `agent-dashboard-tool-${event.id}`;
  const headerEl = cardEl.createDiv({
    attr: {
      "aria-controls": bodyId,
      "aria-expanded": "false",
      role: "button",
      tabindex: "0"
    },
    cls: "agent-dashboard__tool-header"
  });

  const disclosureEl = headerEl.createSpan({
    attr: { "aria-hidden": "true" },
    cls: "agent-dashboard__tool-disclosure"
  });
  disclosureEl.setText("▸");

  const titleEl = headerEl.createSpan({
    cls: "agent-dashboard__tool-title"
  });
  const iconEl = titleEl.createSpan({
    cls: "agent-dashboard__tool-icon"
  });
  setIcon(iconEl, getToolStatusIcon(tool));
  titleEl.createSpan({
    cls: "agent-dashboard__tool-label",
    text: `Tool used: ${getToolDisplayName(tool)}`
  });

  const summaryMetaEl = headerEl.createSpan({
    cls: "agent-dashboard__tool-summary-meta"
  });
  summaryMetaEl.createSpan({
    cls: "agent-dashboard__tool-status",
    text: tool.status
  });
  summaryMetaEl.createSpan({
    cls: "agent-dashboard__tool-time",
    text: formatEventTime(event.createdAt)
  });

  const bodyEl = cardEl.createDiv({
    attr: { id: bodyId },
    cls: "agent-dashboard__tool-content"
  });
  const setOpen = (nextOpen: boolean) => {
    cardEl.toggleClass("is-open", nextOpen);
    disclosureEl.setText(nextOpen ? "▾" : "▸");
    headerEl.setAttr("aria-expanded", String(nextOpen));
    if (nextOpen) {
      options.host.ui.openToolEventIds.add(event.id);
    } else {
      options.host.ui.openToolEventIds.delete(event.id);
    }
  };
  setOpen(options.host.ui.openToolEventIds.has(event.id));
  const toggleOpen = () => setOpen(!cardEl.hasClass("is-open"));
  cardEl.addEventListener("click", (mouseEvent) => {
    const target = mouseEvent.target;
    if (target instanceof HTMLElement && target.closest(".agent-dashboard__tool-content")) {
      return;
    }

    toggleOpen();
  });
  headerEl.addEventListener("keydown", (keyboardEvent) => {
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") {
      return;
    }

    keyboardEvent.preventDefault();
    toggleOpen();
  });

  const metaItems = [
    tool.title ? `title: ${tool.title}` : "",
    tool.name ? `name: ${tool.name}` : "",
    tool.callId ? `id: ${tool.callId}` : "",
    tool.eventType ? `event: ${tool.eventType}` : ""
  ].filter(Boolean);
  if (metaItems.length > 0) {
    bodyEl.createDiv({
      cls: "agent-dashboard__tool-meta",
      text: metaItems.join(" · ")
    });
  }

  if (tool.input !== undefined) {
    renderToolPayload(bodyEl, "Input", tool.input);
  }

  if (tool.output !== undefined) {
    renderToolPayload(bodyEl, tool.status === "error" ? "Error" : "Output", tool.output);
  }

  if (tool.input === undefined && tool.output === undefined) {
    const textEl = bodyEl.createDiv({
      cls: "agent-dashboard__tool-text markdown-rendered"
    });
    void MarkdownRenderer.render(
      plugin.app,
      event.text,
      textEl,
      plugin.app.workspace.getActiveFile()?.path ?? "",
      options.host.markdownComponent
    ).then(() => {
      linkInlineReferencedFiles(plugin, textEl);
    });
  }

  renderReferencedFiles(plugin, bodyEl, event.text);
}

function getToolDisplayName(tool: AgentToolEvent): string {
  return tool.name || tool.title || tool.eventType || "tool";
}

function renderToolPayload(
  containerEl: HTMLElement,
  label: string,
  value: unknown
): void {
  const sectionEl = containerEl.createDiv({
    cls: "agent-dashboard__tool-payload"
  });
  sectionEl.createDiv({
    cls: "agent-dashboard__tool-payload-label",
    text: label
  });
  sectionEl.createEl("pre", {
    cls: "agent-dashboard__tool-payload-body",
    text: formatToolPayload(value)
  });
}

/**
 * Fallback for plain "tool" events the plugin logs as text rather than as a
 * structured AgentToolEvent — context blocks, safety-guard notes, self-check
 * probes. Real Pi tool calls always carry `event.tool` and never reach here.
 *
 * This reads wording, so it is presentation only: it picks an icon and colour
 * and must never be relied on for a security decision.
 */
function inferToolEvent(text: string): AgentToolEvent {
  const lower = text.toLowerCase();
  const blocked = lower.includes("blocked") || lower.includes("denied");
  const allowed = lower.includes("allowed") || lower.includes("added ");
  const failed = lower.includes("failed") || lower.includes("error");
  const check = text.match(/^([^:]+ check):\s*([^-]+)(?:-\s*(.+))?$/i);

  if (check) {
    return {
      eventType: "safety_check",
      output: check[3]?.trim(),
      status: blocked ? "blocked" : failed ? "error" : "info",
      title: `${check[1]} ${check[2].trim()}`
    };
  }

  return {
    eventType: "dashboard_tool_event",
    status: blocked ? "blocked" : failed ? "error" : allowed ? "result" : "info",
    title: text.split("\n")[0] || "Tool event"
  };
}

function formatToolPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getToolStatusIcon(tool: AgentToolEvent): string {
  if (tool.status === "blocked") {
    return "shield-alert";
  }

  if (tool.status === "error") {
    return "circle-alert";
  }

  if (tool.status === "result") {
    return "check-circle";
  }

  return "wrench";
}

function renderStatusLogLine(
  containerEl: HTMLElement,
  event: AgentEvent
): void {
  const logEl = containerEl.createDiv({
    cls: "agent-dashboard__status-log-line"
  });
  const iconEl = logEl.createSpan({
    cls: "agent-dashboard__status-log-icon"
  });
  setIcon(iconEl, "activity");
  logEl.createSpan({
    cls: "agent-dashboard__status-log-text",
    text: event.text
  });
  logEl.createSpan({
    cls: "agent-dashboard__status-log-time",
    text: formatEventTime(event.createdAt)
  });
}

function renderProposedEdits(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  eventId: string
): void {
  const proposedEdits = plugin.getProposedEditsForEvent(eventId);
  if (proposedEdits.length === 0) {
    return;
  }

  const editsEl = containerEl.createDiv({
    cls: "agent-dashboard__proposed-edits"
  });

  for (const proposedEdit of proposedEdits) {
    renderProposedEdit(plugin, editsEl, proposedEdit);
  }
}

function renderProposedEdit(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  proposedEdit: ProposedEditRecord
): void {
  const cardEl = containerEl.createDiv({
    cls: "agent-dashboard__proposed-edit"
  });
  const headerEl = cardEl.createDiv({
    cls: "agent-dashboard__proposed-edit-header"
  });
  const titleEl = headerEl.createDiv({
    cls: "agent-dashboard__proposed-edit-title"
  });
  titleEl.createSpan({ text: "Proposed edit" });
  titleEl.createSpan({
    cls: "agent-dashboard__proposed-edit-path",
    text: proposedEdit.path
  });

  const metaEl = headerEl.createDiv({
    cls: "agent-dashboard__proposed-edit-meta"
  });
  metaEl.createSpan({
    text: proposedEdit.fileExists ? "existing file" : "new file"
  });
  metaEl.createSpan({ text: describeProposedEditStatus(proposedEdit) });

  if (proposedEdit.applyError) {
    cardEl.createDiv({
      cls: "agent-dashboard__proposed-edit-error",
      text: proposedEdit.applyError
    });
  }

  const diffEl = cardEl.createDiv({
    cls: "agent-dashboard__diff"
  });
  for (const line of proposedEdit.diffLines) {
    renderDiffLine(diffEl, line);
  }

  const actionsEl = cardEl.createDiv({
    cls: "agent-dashboard__proposed-edit-actions"
  });
  new ButtonComponent(actionsEl)
    .setButtonText("Open")
    .setTooltip("Open target note")
    .setDisabled(!proposedEdit.fileExists)
    .onClick(() => {
      void plugin.openVaultFilePath(proposedEdit.path);
    });

  const applyState = getProposedEditApplyState(proposedEdit);
  new ButtonComponent(actionsEl)
    .setButtonText(applyState.label)
    .setTooltip(applyState.tooltip)
    .setDisabled(!applyState.enabled)
    .onClick(() => {
      void plugin.applyProposedEdit(proposedEdit.id);
    });
}

function describeProposedEditStatus(proposedEdit: ProposedEditRecord): string {
  if (proposedEdit.status === "apply-error") {
    return "blocked";
  }

  return proposedEdit.status.replace("-", " ");
}

function getProposedEditApplyState(
  proposedEdit: ProposedEditRecord
): { enabled: boolean; label: string; tooltip: string } {
  if (proposedEdit.status === "approved") {
    return {
      enabled: true,
      label: "Apply",
      tooltip: "Apply approved edit through Obsidian vault APIs"
    };
  }

  if (proposedEdit.status === "applied") {
    return {
      enabled: false,
      label: "Applied",
      tooltip: "This edit has already been applied"
    };
  }

  if (proposedEdit.status === "denied") {
    return {
      enabled: false,
      label: "Denied",
      tooltip: "This edit was denied"
    };
  }

  if (proposedEdit.status === "apply-error") {
    return {
      enabled: false,
      label: "Blocked",
      tooltip: proposedEdit.applyError || "This edit cannot be applied"
    };
  }

  return {
    enabled: false,
    label: "Approve first",
    tooltip: "Approve the queued write request before applying"
  };
}

function renderDiffLine(
  containerEl: HTMLElement,
  line: ProposedEditDiffLine
): void {
  const lineEl = containerEl.createDiv({
    cls: `agent-dashboard__diff-line agent-dashboard__diff-line--${line.kind}`
  });
  lineEl.createSpan({
    cls: "agent-dashboard__diff-old-line",
    text: line.oldLineNumber ? String(line.oldLineNumber) : ""
  });
  lineEl.createSpan({
    cls: "agent-dashboard__diff-new-line",
    text: line.newLineNumber ? String(line.newLineNumber) : ""
  });
  lineEl.createSpan({
    cls: "agent-dashboard__diff-marker",
    text: getDiffMarker(line)
  });
  lineEl.createSpan({
    cls: "agent-dashboard__diff-text",
    text: line.text || " "
  });
}

function getDiffMarker(line: ProposedEditDiffLine): string {
  if (line.kind === "added") {
    return "+";
  }

  if (line.kind === "removed") {
    return "-";
  }

  return " ";
}

function linkInlineReferencedFiles(
  plugin: AgentDashboardPlugin,
  rootEl: HTMLElement
): void {
  const candidates = getInlineFileReferenceCandidates(plugin);
  if (candidates.length === 0) {
    return;
  }

  const textNodes: Text[] = [];
  const walker = rootEl.ownerDocument.createTreeWalker(
    rootEl,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent?.trim()) {
          return NodeFilter.FILTER_REJECT;
        }

        return isInlineLinkableTextNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    }
  );

  let currentNode = walker.nextNode();
  while (currentNode) {
    textNodes.push(currentNode as Text);
    currentNode = walker.nextNode();
  }

  for (const textNode of textNodes) {
    replaceInlineFileReferences(plugin, textNode, candidates);
  }
}

function getInlineFileReferenceCandidates(
  plugin: AgentDashboardPlugin
): { file: TFile; text: string }[] {
  return plugin.app.vault.getMarkdownFiles()
    .flatMap((file) => {
      const candidates = [{ file, text: file.path }];
      const withoutExtension = file.path.replace(/\.md$/i, "");
      if (withoutExtension !== file.path && withoutExtension.includes("/")) {
        candidates.push({ file, text: withoutExtension });
      }

      return candidates;
    })
    .sort((a, b) => b.text.length - a.text.length);
}

function isInlineLinkableTextNode(node: Node): boolean {
  let parent = node.parentElement;
  while (parent) {
    if (
      [
        "A",
        "BUTTON",
        "CODE",
        "MJX-CONTAINER",
        "PRE",
        "SCRIPT",
        "STYLE",
        "TEXTAREA"
      ].includes(parent.tagName)
    ) {
      return false;
    }

    parent = parent.parentElement;
  }

  return true;
}

function replaceInlineFileReferences(
  plugin: AgentDashboardPlugin,
  textNode: Text,
  candidates: { file: TFile; text: string }[]
): void {
  const text = textNode.textContent ?? "";
  // Deliberately the plain DOM API rather than Obsidian's createFragment /
  // createEl helpers: the linter prefers those, but they build against the
  // global document, and this must stay in the text node's own document
  // (rendered messages can live in a pop-out window). The rule's suggested
  // alternative, ownerDocument.win.createEl, does not typecheck either --
  // obsidian 1.12.3 declares neither createEl nor createFragment on Window.
  // Leave the two warnings; obsidianmd/no-restricted-disable forbids silencing
  // them inline.
  const fragment = textNode.ownerDocument.createDocumentFragment();
  let offset = 0;
  let changed = false;

  while (offset < text.length) {
    const match = findNextInlineFileReference(text, offset, candidates);
    if (!match) {
      break;
    }

    if (match.index > offset) {
      fragment.append(text.slice(offset, match.index));
    }

    const linkEl = textNode.ownerDocument.createElement("a");
    linkEl.addClass("agent-dashboard__inline-file-link");
    linkEl.href = "#";
    linkEl.textContent = text.slice(match.index, match.index + match.length);
    linkEl.addEventListener("click", (event) => {
      event.preventDefault();
      void plugin.app.workspace.getLeaf(false).openFile(match.file);
    });
    fragment.append(linkEl);
    offset = match.index + match.length;
    changed = true;
  }

  if (!changed) {
    return;
  }

  if (offset < text.length) {
    fragment.append(text.slice(offset));
  }

  textNode.replaceWith(fragment);
}

function findNextInlineFileReference(
  text: string,
  offset: number,
  candidates: { file: TFile; text: string }[]
): { file: TFile; index: number; length: number } | undefined {
  let bestMatch: { file: TFile; index: number; length: number } | undefined;

  for (const candidate of candidates) {
    let index = text.indexOf(candidate.text, offset);
    while (index !== -1) {
      const end = index + candidate.text.length;
      if (isInlineFileReferenceBoundary(text, index, end)) {
        if (
          !bestMatch ||
          index < bestMatch.index ||
          (index === bestMatch.index && candidate.text.length > bestMatch.length)
        ) {
          bestMatch = {
            file: candidate.file,
            index,
            length: candidate.text.length
          };
        }
        break;
      }

      index = text.indexOf(candidate.text, index + 1);
    }
  }

  return bestMatch;
}

function isInlineFileReferenceBoundary(
  text: string,
  start: number,
  end: number
): boolean {
  const before = text[start - 1];
  const after = text[end];
  const validBefore = before === undefined || /[\s"'`([{:@]/.test(before);
  const validAfter = after === undefined || /[\s"'`),.;:!?}\]]/.test(after);

  return validBefore && validAfter;
}

function renderReferencedFiles(
  plugin: AgentDashboardPlugin,
  containerEl: HTMLElement,
  text: string
): void {
  const referencedFiles = findReferencedVaultFiles(plugin, text);
  if (referencedFiles.length === 0) {
    return;
  }

  const filesEl = containerEl.createDiv({
    cls: "agent-dashboard__referenced-files"
  });
  filesEl.createSpan({
    cls: "agent-dashboard__referenced-label",
    text: "Files"
  });

  for (const file of referencedFiles) {
    const fileEl = filesEl.createEl("button", {
      cls: "agent-dashboard__referenced-file",
      text: file.path,
      type: "button"
    });
    fileEl.addEventListener("click", () => {
      void plugin.app.workspace.getLeaf(false).openFile(file);
    });
  }
}

function findReferencedVaultFiles(
  plugin: AgentDashboardPlugin,
  text: string
): TFile[] {
  const files = plugin.app.vault.getMarkdownFiles();
  const matches: TFile[] = [];

  for (const file of files) {
    if (isFilePathMentioned(text, file.path) && !matches.includes(file)) {
      matches.push(file);
    }
  }

  return matches.slice(0, 8);
}

function isFilePathMentioned(text: string, filePath: string): boolean {
  if (text.includes(filePath)) {
    return true;
  }

  const withoutExtension = filePath.replace(/\.md$/i, "");
  return withoutExtension !== filePath && text.includes(withoutExtension);
}

function getAgentEventLabel(event: AgentEvent): string {
  if (event.kind === "user") {
    return "You";
  }

  if (event.kind === "assistant") {
    return "Agent";
  }

  if (event.kind === "tool") {
    return "Tool";
  }

  return "Status";
}

function getAgentEventIcon(event: AgentEvent): string {
  if (event.kind === "user") {
    return "user";
  }

  if (event.kind === "assistant") {
    return "bot";
  }

  if (event.kind === "tool") {
    return "wrench";
  }

  return "activity";
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatSessionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString([], {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short"
  });
}

function renderStatusItem(
  containerEl: HTMLElement,
  label: string,
  value: string
): void {
  const itemEl = containerEl.createDiv({ cls: "agent-dashboard__status-item" });
  itemEl.createSpan({ cls: "agent-dashboard__status-label", text: label });
  itemEl.createSpan({ cls: "agent-dashboard__status-value", text: value });
}

function describeDashboard(
  plugin: AgentDashboardPlugin,
  options: DashboardRenderOptions
): string {
  const model = options.model || plugin.settings.defaultModel;
  const workspace = options.workspace ?? "vault";

  if (model) {
    return `${workspace} workspace using ${model}`;
  }

  return `${workspace} workspace. Configure an Ollama model when ready.`;
}
