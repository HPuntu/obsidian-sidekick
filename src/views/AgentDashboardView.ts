import { Component, ItemView, WorkspaceLeaf } from "obsidian";

import type AgentDashboardPlugin from "../main";
import type { AgentEvent } from "../agent/AgentSession";
import {
  createDashboardUiState,
  hasStreamSelection,
  renderDashboardShell,
  updateStreamedEventText
} from "../ui/renderDashboard";
import type {
  DashboardHost,
  DashboardRenderOptions
} from "../ui/renderDashboard";

export const AGENT_DASHBOARD_VIEW_TYPE = "local-sidekick-view";

/** Streamed text repaints per second. Fast enough to read, cheap enough to run. */
const STREAM_UPDATE_INTERVAL_MS = 100;

export class AgentDashboardView extends ItemView {
  plugin: AgentDashboardPlugin;

  private host: DashboardHost;
  private markdownHolder?: Component;
  private renderFrame?: number;
  private streamTimeout?: number;
  private pendingStreamEvent?: AgentEvent;

  constructor(leaf: WorkspaceLeaf, plugin: AgentDashboardPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.host = {
      markdownComponent: this.replaceMarkdownHolder(),
      rerender: () => this.scheduleRender(),
      ui: createDashboardUiState()
    };
  }

  getViewType(): string {
    return AGENT_DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Local Sidekick";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    let hadSelection = false;
    this.registerDomEvent(this.contentEl.ownerDocument, "selectionchange", () => {
      const selected = hasStreamSelection(this.contentEl);
      if (hadSelection && !selected) this.scheduleRender();
      hadSelection = selected;
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.cancelPendingWork();
  }

  /**
   * Coalesces render requests into one repaint per frame. Callers fire this
   * from event handlers and streaming callbacks without worrying about rate.
   */
  scheduleRender(): void {
    if (this.renderFrame !== undefined) {
      return;
    }

    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = undefined;
      this.render();
    });
  }

  /**
   * Repaints only the text of a streaming event. Falls back to a full render
   * when the event has no element yet (the first delta of a new message).
   */
  scheduleStreamUpdate(event: AgentEvent): void {
    this.pendingStreamEvent = event;
    if (this.streamTimeout !== undefined || this.renderFrame !== undefined) {
      return;
    }

    this.streamTimeout = window.setTimeout(() => {
      this.streamTimeout = undefined;
      const pending = this.pendingStreamEvent;
      this.pendingStreamEvent = undefined;
      if (!pending) {
        return;
      }

      const patched = updateStreamedEventText(
        this.plugin,
        this.contentEl,
        this.getRenderOptions(),
        pending
      );
      if (!patched) {
        this.scheduleRender();
      }
    }, STREAM_UPDATE_INTERVAL_MS);
  }

  render(): void {
    if (hasStreamSelection(this.contentEl)) return;
    // A full rebuild discards every node the previous render's markdown
    // cleanup handlers point at, so retire that Component with it.
    this.host.markdownComponent = this.replaceMarkdownHolder();
    renderDashboardShell(this.plugin, this.contentEl, this.getRenderOptions());
  }

  private getRenderOptions(): DashboardRenderOptions {
    return {
      embedded: false,
      host: this.host,
      workspace: "vault",
      layout: "agent-sidebar"
    };
  }

  private replaceMarkdownHolder(): Component {
    if (this.markdownHolder) {
      this.removeChild(this.markdownHolder);
    }

    this.markdownHolder = this.addChild(new Component());
    return this.markdownHolder;
  }

  private cancelPendingWork(): void {
    if (this.renderFrame !== undefined) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = undefined;
    }

    if (this.streamTimeout !== undefined) {
      window.clearTimeout(this.streamTimeout);
      this.streamTimeout = undefined;
    }

    this.pendingStreamEvent = undefined;
  }
}
