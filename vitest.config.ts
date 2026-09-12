import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

export default defineConfig({
  plugins: [{
    name: "test-pi-extension",
    resolveId: (id) => id === "sidekick:pi-extension" ? id : undefined,
    async load(id) {
      if (id !== "sidekick:pi-extension") return;
      const source = await readFile("src/bridge/pi/vaultToolsExtension.ts", "utf8");
      const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022" });
      return `export default ${JSON.stringify(compiled.code)};`;
    }
  }],
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
