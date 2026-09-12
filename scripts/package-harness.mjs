import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const id = "local-sidekick-harness-test";
const output = path.join("dist", id);
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
await mkdir(output, { recursive: true });
await copyFile("main.js", path.join(output, "main.js"));
await copyFile("styles.css", path.join(output, "styles.css"));
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  ...manifest, id, name: "Local Sidekick (Harness Test)"
}, null, 2) + "\n");
const result = spawnSync("zip", ["-r", `${id}.zip`, id], { cwd: "dist", stdio: "inherit" });
if (result.status !== 0) throw result.error ?? new Error("Could not package harness test plugin.");
console.log(`Local test plugin: ${output} (separate ID; release assets unchanged on GitHub)`);
