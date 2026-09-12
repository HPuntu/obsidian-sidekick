// This file is bundled separately and embedded in main.js. It executes in Pi,
// never writes notes itself, and uses Pi's existing RPC UI channel as transport.
interface ExtensionContext {
  ui: {
    editor(title: string, prefill: string): Promise<string | undefined>;
    notify(message: string, type: string): void;
  };
}
interface ExtensionApi {
  getActiveTools(): string[];
  registerTool(tool: {
    name: string; label: string; description: string; parameters: unknown;
    execute(id: string, args: Record<string, unknown>, signal: AbortSignal | undefined,
      update: unknown, ctx: ExtensionContext): Promise<unknown>;
  }): void;
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void): void;
}

export default function vaultToolsExtension(pi: ExtensionApi): void {
  const token = process.env.SIDEKICK_RPC_TOKEN;
  if (!token) throw new Error("Sidekick vault tools require a private RPC session.");
  const reviewed = process.env.SIDEKICK_VAULT_MODE === "reviewed";
  const string = { type: "string" };
  const definitions = [
    { name: "read_note", description: "Read a vault Markdown note and its version. Required before edit_note.", properties: { path: string }, required: ["path"] },
    { name: "create_note", description: "Create a new Markdown note after user diff approval. Parent folder must exist. Supply text OR answerId to save an exact previous answer.", properties: { path: string, text: string, answerId: string }, required: ["path"] },
    { name: "append_note", description: "Append to an existing note after user diff approval, preserving its contents. Supply text OR answerId.", properties: { path: string, text: string, answerId: string }, required: ["path"] },
    { name: "edit_note", description: "Replace one exact passage after user diff approval. First read_note, then provide its version and a unique oldText plus newText.", properties: { path: string, version: string, oldText: string, newText: string }, required: ["path", "version", "oldText", "newText"] }
  ];
  for (const definition of definitions) {
    if (!reviewed && definition.name !== "read_note") continue;
    pi.registerTool({
      ...definition,
      label: definition.name,
      parameters: { type: "object", properties: definition.properties, required: definition.required, additionalProperties: false },
      async execute(callId, args, signal, _update, ctx) {
        signal?.throwIfAborted();
        const response = await ctx.ui.editor(`local-sidekick-tool:${token}`, JSON.stringify({ callId, name: definition.name, args }));
        signal?.throwIfAborted();
        const result = response ? JSON.parse(response) as { status: string } : { status: "cancelled" };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }], details: result,
          isError: !["read", "applied", "unchanged"].includes(result.status)
        };
      }
    });
  }
  pi.on("session_start", (_event, ctx) => {
    const expected = reviewed ? definitions.map((tool) => tool.name) : ["read_note"];
    if (!expected.every((name) => pi.getActiveTools().includes(name))) {
      ctx.ui.notify(`local-sidekick-error:${token}:Pi did not activate the requested vault tools. Update Pi.`, "error");
      return;
    }
    ctx.ui.notify(`local-sidekick-ready:${token}`, "info");
  });
}
