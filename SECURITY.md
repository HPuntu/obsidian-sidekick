# Security

This document describes the tool-based harness introduced in 1.2.0. Earlier releases use the reviewed-proposal workflow. Test updates in a copied vault before using them on important notes.

## Execution Boundaries

Agent prompt runs disable auto-discovered Pi extensions, skills, prompt templates, and context files. Native bash, edit, and write tools are not enabled. When tools are enabled, the explicit allowlist contains native read, grep, find, ls and the permitted bundled vault tools. Tools-disabled runs load no extension.

The bundled extension is embedded in main.js and written to a private temporary directory for each run. Pi loads this one explicit extension even with auto-discovery disabled. It communicates over the existing stdin/stdout RPC connection; the plugin opens no listening sockets. Startup requires a successful extension/tool handshake before the user prompt is sent.

Pi enforces native tool availability. An unexpected native tool event remains an after-the-fact report, not a prevention. Local Sidekick does not OS-sandbox Pi or restrict native reads to the vault. Non-default Pi executable paths require per-session confirmation.

## Managed Vault Tools

Chat mode exposes read_note only. Reviewed edits mode also exposes create_note, append_note, and edit_note. The permission mode is captured for the run, not inferred from a prompt regex. Chat prose and legacy agent-edit fences are not converted into new write requests.

The extension never writes notes. All managed operations are validated and executed in the Obsidian process:

- Targets must be vault-relative Markdown paths, without absolute paths, traversal, hidden segments, or symlinks. The configured Obsidian configuration directory is excluded.
- Parent folders must already exist. Create refuses to overwrite an existing note. Append refuses a missing note.
- edit_note requires a read in the same run, a matching version, and a unique oldText passage.
- Every mutation waits for a visible diff and an explicit user approval. Denial returns to the agent without a write.
- Approval authorizes the exact prepared original/replacement contents. Existing-note changes use vault.process to compare and write in its atomic callback.
- A post-write read verifies the result. Conflicts and errors are returned to the model, not reported as successful edits.
- Calls on the same path are serialized. Repeated call IDs return their original result; reuse with different arguments is rejected.
- Stop aborts pending approvals and queued operations. Once a write is already committed it is not rolled back by Stop.
- Pending tool proposals restored after restart are cancelled and cannot execute through the legacy Apply path.
- The active execution timeout pauses during host requests, including user review. Note sizes, per-run tool calls, and simultaneous reviews are bounded.

These checks are not an OS sandbox. Symlink checks happen before operations, not through kernel-enforced directory handles; external filesystem changes can race them. Obsidian's process callback protects against ordinary in-app content changes, not every possible external writer. Keep backups.

Legacy persisted proposals and plugin-driven internal-link suggestions retain their existing separate approval/application path. They are not new agent tool calls.

## Pi User Configuration

Pi user configuration for discovery is off by default. Enabling it permits your installed extensions/resources during discovery and model selection only. Those extensions execute as trusted local code and may perform arbitrary actions; they are not covered by the managed vault-tool controls. Prompt runs always disable them.

Tool-filter semantics differ across Pi versions. The integration tests use Pi 0.75.4. A failed tool handshake prevents the prompt from starting rather than silently falling back to chat-fence editing.

## Other Local Actions

The plugin launches local processes for Pi integration and exact safe-command allowlist entries. They are launched without a shell. The default safe commands are git status and git diff --stat. Commands you add may execute project code; allowlist only commands you trust.

Explicit UI commands can create starter profiles, export chats, suggest internal links, and export resources under .pi. Those are user-invoked plugin workflows, independent of agent capability modes. Inspect exported Pi resources before using Pi directly in the vault.

Deletes are not offered as an agent capability.

## Data And Network

Prompts are sent through Pi to the selected provider. For a local-only setup, select a local Ollama provider; custom Pi providers may send content elsewhere. Native tool access and third-party code are not network-sandboxed by this plugin.

Optional web fetch is disabled by default. It requires HTTPS and an explicit host allowlist, checks resolved IPs for private/metadata destinations, and pins requests to the checked address. No telemetry is implemented.

Settings, chat history, proposed contents, approvals, and Pi sessions are stored under the plugin's vault configuration directory. Sync and backup tools may copy them. Treat that directory as private data and do not publish it.

## Untrusted Inputs

Notes, PDFs, fetched pages, tool output, profile files, and included memory can contain instructions that attempt to steer the model. Prompt guidance distinguishes source material from user authorization, but it cannot guarantee the model will follow that distinction. The per-operation approval gate is the safeguard for managed writes. Read every diff.

Imported vault settings may select a different executable, provider, profile, safe-command allowlist, or discovery configuration. Inspect them before using an unfamiliar vault. Profiles can change prompt guidance and native read-tool availability, but cannot enable native mutation tools through the plugin.

## Known Limitations

- Models can hallucinate facts, paths, and edits or claim success despite an error.
- PDF extraction is best-effort, without OCR; parsing limits do not make it a complete PDF sandbox.
- Search and indexing helpers enumerate vault files locally.
- Human approval does not prove an edit is correct.
- Live Obsidian rendering and compatibility with individual themes require local testing beyond the automated host/transport tests.

## Reporting Issues

Use GitHub Private Vulnerability Reporting when available. Otherwise open a minimal issue requesting a private contact path, without private notes, tokens, prompts, or exploit payloads.
