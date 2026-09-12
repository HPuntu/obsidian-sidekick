## Unreleased

### Added

- Model-aware thinking effort control in the composer, defaulting to Medium and exposing Extra high only when supported by Pi.
- Reviewed append proposals that preserve existing note contents, including support for nested code fences.
- Copy buttons for assistant messages and selectable output while replies stream.

### Fixed

- Share concurrent Pi model discovery requests and allow more time for cold starts when sending a new chat with Enter.
- Verify that Ollama has unloaded the selected model and reset the Kill button after successful unloading.
- Refresh missing model metadata before starting prompts or choosing thinking effort.
- Repair Markdown tables immediately following prose without changing copied source text or fenced code.
- Avoid unsolicited edit proposals on answer-only questions and remove repetitive no-file-changes status messages.

## 1.0.0 - 2026-08-13

First stable release. Local Sidekick reads your vault by default, writes only
with per-edit approval, and one clearly-labelled setting hands control of Pi
back to your own configuration.

### Added

- Queue a prompt while a reply is streaming. Send becomes Queue, the pending prompt is shown above the composer with a Cancel action, and it is sent when the current run finishes. Stopping a run discards anything queued for it.
- Resend and Edit last, which stop the current run and either resubmit the previous prompt or return it to the composer. Pi keeps its own session history, so neither rewinds the model's context.
- Pin notes to a session. Pinned files are attached to every prompt in that session, shown as removable chips, and persist with the session. A pinned file that is deleted or unreadable is reported and skipped rather than failing the run.
- A Stop button in the composer, shown only while a reply is streaming.
- Test suite (vitest, 161 tests) covering the security boundaries and pure logic: path containment, the Pi tool-mode decision, the safe-command allowlist and shell-metacharacter refusal, web-fetch host allowlisting and private/metadata IP blocking, `@`-mention resolution, vault path normalisation, edit-intent detection, and settings migration.
- ESLint with typescript-eslint and `eslint-plugin-obsidianmd`, wired into `npm run check` and CI.

### Security

- Default `Pi tools` to **Read-only** (`read`, `grep`, `find`, `ls`) rather than `Disabled`. Pi can open and search vault files on its own initiative on a fresh install, which is the plugin's purpose. Writes, deletes, shell access, and network access remain restricted.
- Keep Pi extensions, skills, prompt templates, and context files **disabled by default**. Pi's `--tools`/`--no-tools` filter built-in tools only; extension-registered tools bypass them ([earendil-works/pi#2835](https://github.com/earendil-works/pi/issues/2835)), so passing `--no-extensions` is what makes the tool restriction mean anything. The two defaults are a pair: read-only is only meaningful while extensions are off.
- Rename `piExperimentalFeaturesEnabled` to `allowPiUserConfig`, shown as `Allow Pi extensions and user configuration`. Existing values migrate automatically, so an explicit choice survives the upgrade.
- Correct the approval note, which claimed "Execution disabled. Approval can be recorded for UX testing only." Approving a proposed edit really does write the file; the note predated that being implemented and understated what approval does.
- Report a tool Pi ran outside the requested mode as `Ran outside allowlist: ...` rather than "Blocked", and stop queueing an approval for it. Tool events arrive after Pi has already executed the call, so the old wording implied a prevention the plugin cannot perform.
- Decide whether a run may use tools from the tool mode itself rather than by re-parsing an assembled command string.
- Correct the safety audit log, which recorded `--experimental-pi-features` — a flag never passed to Pi.
- Reframe README and SECURITY.md around what the plugin does: it reads your vault by default. Both state plainly that Pi, not this plugin, enforces tool limits; that Pi is not confined to the vault by Local Sidekick; and that enabling Pi extensions allows unverified agent code to run outside every documented boundary.

### Changed

- Remove the loopback HTTP bridge. It served only `/health` and nothing consumed it. The plugin now opens no listening sockets. This removes the `Start bridge automatically` setting and the `Restart Sidekick bridge` and `Stop Sidekick bridge` commands.
- Rework the top bar: Config, Chats, the model and profile picker, then Start/Kill. Chats opens a scrollable list of every chat, newest first; the home page shows only the five most recent with a link to the rest.
- Rename the top-bar Stop to Kill, green while it reads Start and red once it reads Kill. Kill now unloads the model from Ollama, which is what actually frees memory.
- Base Start/Kill on whether Pi discovery has succeeded, which is what a prompt actually needs. The partial state now reads "Ollama only" — Ollama answering while Pi has no model list — which is the half-configured state users land in.
- Stream replies by repainting only the message being written rather than rebuilding the sidebar on every token. Long chats no longer slow down as they grow.
- Replace per-phase run chatter with a single "Thinking..." line that clears when the reply arrives. Retries, extension errors, and failures are still shown.
- Group consecutive tool events into one collapsed row summarising the steps, instead of a card per call.
- Enter sends; Shift+Enter inserts a newline. When the `@`-mention list is open, Enter still accepts the highlighted suggestion.
- Replace the composer's text buttons with colour-coded icons and hover tooltips. If an icon name is missing from your Obsidian build the button falls back to its text label.
- Rework the sidebar's surfaces so it blends with the workspace, using only Obsidian's semantic variables so themes and light/dark follow automatically.
- Mark models Ollama has pulled but Pi has not been configured with as `not in Pi`. Clicking one copies the `models.json` entry to paste into your Pi config, rather than failing at `set_model`.
- Show only agent profiles compatible with the selected model in the picker's submenu, and say so when a profile overrides your model choice.
- Cut the prompt scaffolding back to the minimum. The plugin decides in code whether the edit format is needed; the prose only describes mechanics, so the model behaves normally and simply knows the vault is there.
- Apply Obsidian's sentence-case guidance to UI text, capitalising "Sidekick" as the product name.
- Remove test scaffolding and dead settings: the `Create sample approval request` command, the fabricated approvals the safety self-check added to the real queue, the `permissionMode` setting that was never read, and the `statusPanelHeight` setting for a panel that no longer exists.
- Split `main.ts` into focused modules, and move prompt-context assembly into `prompt/buildContext` behind an explicit dependency object built once per run.
- Signal run completion through an explicit `onComplete` callback rather than inferring it from status text.

### Fixed

- Give the Config and Chats dropdowns an explicit close button. Both could only be dismissed by re-clicking their top-bar toggle, which is undiscoverable when the chat list was opened from the home page's "more in Chats" link rather than from the Chats button itself.
- Keep the transcript where you scrolled it. Repaints during a run were re-pinning to the bottom, which made it impossible to scroll back and read anything mid-reply.
- Keep the composer editable while a reply streams, preserving the draft, focus, and caret position across repaints. Sending is still gated on the run finishing.
- Let the transcript shrink when a dropdown opens, so the composer is no longer pushed off the bottom of the panel.
- Match `@`-mentions for filenames containing spaces.
- Restore blue inline links for `@`-mentioned files in rendered messages.
- Activate Pi models by the provider and id Pi reported at discovery, rather than re-deriving them from the display label.
- Stop rewriting the entire plugin data file while a reply is streaming; the final text is flushed when the run ends.
- Move markdown rendering onto a Component owned by the view, and per-view UI state off module scope, so nothing leaks across plugin reloads or bleeds between leaves.
- Build inline file links with the text node's own document rather than the global one.

## 0.2.4 - 2026-07-02

- Merge remote-tracking branch 'origin/main' (0ec4d78)
- fixed tool action blocked notifications showing even when not blocked (29f8b63)

## 0.2.3 - 2026-07-02

- Merge remote-tracking branch 'origin/main' (92e25aa)
- some dropdown model election box fixes (a321aa6)

## 0.2.2 - 2026-07-01

- Merge remote-tracking branch 'origin/main' (f8f6998)
- chore: remove stray manifest.jsony (9a8c130)
- fix: address second Obsidian review (settings heading + lint warnings) (b6a769b)

## 0.2.1 - 2026-06-30

### Fixed

- Address the Obsidian plugin review: require Obsidian 1.7.2+ for modern vault and workspace APIs, use `Setting` headings in the settings tab, render Markdown through a managed component instead of the plugin instance, move tool-card styling into CSS, await leaf reveal, and stop detaching the view leaf on unload.

## 0.2.0 - 2026-06-30

### Added

## 0.1.11 - 2026-06-29

### Fixed

- One-click Start/Stop pipeline: checks Ollama, probes Pi, discovers RPC models, starts the bridge, and activates the selected model.

### Changed

- Redesign the sidebar into a single clean view — top bar with a status menu, a combined model/agent-profile picker (profiles cascade from each model), and a Start/Stop button; recent chats stacked above a pinned chat input.
- Slim recent-chat rows to a single line showing only the title and date.

## 0.1.10 - 2026-05-29

- readme update (18d7063)

## 0.1.9 - 2026-05-29

- readme update (185e175)

## 0.1.8 - 2026-05-29

### Added

- Add vault-native Sidekick `.agent.md` profiles with selectable model lists, disabled/read-only tool preferences, included memory files, `/agent` prompt selection, and starter research/writing/code/linking/glossary agents.
- Add generated `Sidekick/Prompts/*.prompt.md` prompt library starter files.
- Add `Sidekick/Memory/project-index.md` generation from Markdown filenames and top headings.
- Add explicit `.pi/` resource export for Sidekick prompt templates and vault-linker/glossary-curator skills.
- Add persistent sidebar controls for Sidekick agent profiles alongside the model rail.

### Changed

- Prepare Pi session folders through the Obsidian vault adapter instead of runtime Node fs access.
- Clarify shell execution, Pi launch, safe command allowlist, and vault enumeration boundaries in public docs.

### Fixed

- Collapse tool-use events by default behind expandable `Tool used: <tool>` cards in the chat stream.
- Fix tool-use cards so expanded content can show message, input, output, or raw event details.

## 0.1.7 - 2026-05-27

- Revise README for clarity on Local Sidekick features (e1f0533)

## 0.1.6 - 2026-05-27

- Reduce runtime filesystem access warning (d7b28b4)

## 0.1.5 - 2026-05-27

- Merge remote-tracking branch 'origin/dev' (69325b6)
- Fix release version selection (c56d31d)
- Merge pull request #1 from HPuntu/dev (acab437)
- Merge branch 'main' into dev (59c8dbb)
- Fix community plugin review issues (667057f)

## 0.1.4 - 2026-05-27

- Merge remote-tracking branch 'origin/main' (cc643c1)
- up (f102b0d)

## 0.1.3 - 2026-05-27

- Merge remote-tracking branch 'origin/main' (7ca2ff7)
- readme update (d2fd1a5)

## 0.1.2 - 2026-05-27

- Merge remote-tracking branch 'origin/main' (8dc076f)
- several updates to ui (dab3a4a)

## 0.1.1 - 2026-05-27

- increased overall safety for web fetch and pdf accession among otheres ( see changelog) (8204eb6)
- versioning and package build release v0.10 implemented (3462dcf)
- readme update (fbb1639)
- release commit v0.1.0 (da82f01)
- up (69ad520)
- tool usage implemented (fa33b5e)
- light changes to some stdout readout (706c306)
- up (f468a92)
- made the status view panel smaller (2bc507f)
- added full session history, agent selection and Pi agent RCPa (c6eae36)
- initial commit (38b3bd8)

## 0.1.0

Initial alpha release candidate.

### Added

- Right-sidebar Local Sidekick view for Obsidian desktop.
- Local Pi and Ollama status checks.
- Pi RPC discovery and model selection.
- Persistent chat sessions with history view.
- Streaming chat display with Markdown and math rendering through Obsidian.
- Vault `@` file mentions for Markdown, text-like files, attachments, and PDFs.
- Best-effort PDF text extraction for text-based PDFs.
- Prompt context helpers for vault search, related-note search, vault index, safe commands, web fetch, and internal link suggestions.
- Reviewed Markdown edit proposals with diff rendering and approval queue.
- Chat export to Markdown in a vault `Chats/` folder.
- Conservative default safety mode with Pi tools disabled.
- Optional read-only Pi tools for `read`, `grep`, `find`, and `ls`.
- Settings for Pi executable, Pi timeout, Ollama host, safe commands, web fetch, allowed external read roots, and sidebar status panel height.
- Draggable vertical divider between Status and Agent panels, with persisted height, keyboard resizing, and double-click reset.
- Main-push release promotion workflow and dev-branch CI health workflow.
- Release packaging for `main.js`, `manifest.json`, `styles.css`, and the versioned release zip.

### Changed

- Replaced the large sidebar text title with the same `bot` icon used by the Obsidian ribbon action.
- Made the Status panel compact, scrollable, and user-resizable so the Agent view can take more vertical space.
- Moved model selection into a compact persistent model rail.
- Narrowed the default safe command allowlist to low-risk read-only commands: `git status` and `git diff --stat`.
- Pi prompt, discovery, and model-switch runs disable Pi extensions, skills, prompt templates, and context files by default unless the experimental setting is enabled.
- Updated public release documentation, release checklist, privacy notes, and security notes.

### Fixed

- Fixed recent chat history rows rendering as overlapping button boxes by resetting Obsidian button layout styles for session cards.
- Fixed `@` mention handling from the fresh session landing page.
- Fixed file mention path resolution for vault paths, wiki-style paths, and extensionless Markdown/PDF references.
- Improved model/tool error messaging when a selected Ollama model does not support Pi tools.
- Improved chat event rendering so status messages stream inline with model output instead of boxed cards.

### Security

- Web fetch now requires HTTPS and an explicit allowed-host list.
- Web fetch resolves DNS before request, blocks localhost/private/link-local/reserved/multicast/metadata-style addresses, and pins the HTTPS request to the checked DNS result.
- PDF text extraction now enforces stricter compressed stream, per-stream decoded, and total decoded byte limits.
- Non-default Pi executable paths require once-per-Obsidian-session confirmation before use.
- Experimental Pi extensions, skills, prompt templates, and context files require once-per-session confirmation before launch when enabled by vault settings.
- Documented that `.obsidian/plugins/local-sidekick/data.json` may contain prompts, replies, note excerpts, proposed edits, and settings, and may sync with vault configuration.

### Known Limitations

- Alpha release intended for private or trusted beta testing.
- Not all Ollama models support tools.
- Local models may hallucinate without explicit context.
- PDF extraction is best-effort and does not include OCR.
- Web fetch is disabled by default and intentionally limited.
- Reviewed edits currently target Markdown files.
- Automated end-to-end tests are not yet included.
