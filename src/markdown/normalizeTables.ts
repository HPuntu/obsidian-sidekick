/** Obsidian needs a paragraph break before a pipe table. Leave code untouched. */
export function normalizeTableSpacing(markdown: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      result.push(line);
      continue;
    }
    const separator = lines[index + 1]?.trim() ?? "";
    const cells = separator.replace(/^\|/, "").replace(/\|$/, "").split("|");
    if (!fence && /^ {0,3}\|.+\|\s*$/.test(line) && cells.length >= 2 &&
      cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell)) &&
      result.length > 0 && result[result.length - 1].trim()) result.push("");
    result.push(line);
  }
  return result.join("\n");
}
