export interface ParsedProposedEdit {
  operation?: "replace" | "append";
  path: string;
  replacementText: string;
}

export type ProposedEditDiffKind = "added" | "removed" | "unchanged";

export interface ProposedEditDiffLine {
  kind: ProposedEditDiffKind;
  newLineNumber?: number;
  oldLineNumber?: number;
  text: string;
}

export function parseProposedEditsFromMarkdown(
  markdown: string
): ParsedProposedEdit[] {
  const edits: ParsedProposedEdit[] = [];
  const blockPattern = /^(`{3,})agent-edit[^\r\n]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(markdown)) !== null) {
    const parsed = parseProposedEditBlock(match[2]);
    if (parsed) {
      edits.push(parsed);
    }
  }

  return edits;
}

export function createLineDiff(
  originalText: string,
  replacementText: string,
  maxLines = 240
): ProposedEditDiffLine[] {
  const originalLines = splitLines(originalText);
  const replacementLines = splitLines(replacementText);
  const diff = buildLineDiff(originalLines, replacementLines);

  if (diff.length <= maxLines) {
    return diff;
  }

  const headCount = Math.floor(maxLines / 2);
  const tailCount = maxLines - headCount - 1;
  return [
    ...diff.slice(0, headCount),
    {
      kind: "unchanged",
      text: `... ${diff.length - maxLines + 1} diff lines hidden ...`
    },
    ...diff.slice(diff.length - tailCount)
  ];
}

function parseProposedEditBlock(value: string): ParsedProposedEdit | undefined {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const separatorIndex = lines.findIndex((line) => line.trim() === "---");

  if (separatorIndex === -1) {
    return undefined;
  }

  const metadata = parseMetadata(lines.slice(0, separatorIndex));
  const path = normalizeVaultPath(metadata.path ?? "");
  const replacementText = lines.slice(separatorIndex + 1).join("\n");

  if (!path) {
    return undefined;
  }

  if (metadata.operation && !["replace", "append"].includes(metadata.operation)) return undefined;

  return {
    operation: metadata.operation === "append" ? "append" : "replace",
    path,
    replacementText
  };
}

function parseMetadata(lines: string[]): Record<string, string> {
  const metadata: Record<string, string> = {};

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    metadata[key] = value;
  }

  return metadata;
}

function normalizeVaultPath(value: string): string {
  return value
    .replace(/^["']|["']$/g, "")
    .replace(/^\/+/, "")
    .trim();
}

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }

  return value.replace(/\r\n/g, "\n").split("\n");
}

function buildLineDiff(
  originalLines: string[],
  replacementLines: string[]
): ProposedEditDiffLine[] {
  if (originalLines.length * replacementLines.length > 40000) {
    return buildSimpleLineDiff(originalLines, replacementLines);
  }

  const table = createLcsTable(originalLines, replacementLines);
  const diff: ProposedEditDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < originalLines.length && newIndex < replacementLines.length) {
    if (originalLines[oldIndex] === replacementLines[newIndex]) {
      diff.push({
        kind: "unchanged",
        newLineNumber: newIndex + 1,
        oldLineNumber: oldIndex + 1,
        text: originalLines[oldIndex]
      });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      diff.push({
        kind: "removed",
        oldLineNumber: oldIndex + 1,
        text: originalLines[oldIndex]
      });
      oldIndex += 1;
    } else {
      diff.push({
        kind: "added",
        newLineNumber: newIndex + 1,
        text: replacementLines[newIndex]
      });
      newIndex += 1;
    }
  }

  appendRemainingLines(diff, originalLines, replacementLines, oldIndex, newIndex);
  return diff;
}

function buildSimpleLineDiff(
  originalLines: string[],
  replacementLines: string[]
): ProposedEditDiffLine[] {
  const diff: ProposedEditDiffLine[] = [];
  for (let index = 0; index < originalLines.length; index += 1) {
    diff.push({
      kind: "removed",
      oldLineNumber: index + 1,
      text: originalLines[index]
    });
  }

  for (let index = 0; index < replacementLines.length; index += 1) {
    diff.push({
      kind: "added",
      newLineNumber: index + 1,
      text: replacementLines[index]
    });
  }

  return diff;
}

function createLcsTable(left: string[], right: string[]): number[][] {
  const table = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0)
  );

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      table[leftIndex][rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? table[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(
              table[leftIndex + 1][rightIndex],
              table[leftIndex][rightIndex + 1]
            );
    }
  }

  return table;
}

function appendRemainingLines(
  diff: ProposedEditDiffLine[],
  originalLines: string[],
  replacementLines: string[],
  oldIndex: number,
  newIndex: number
): void {
  for (let index = oldIndex; index < originalLines.length; index += 1) {
    diff.push({
      kind: "removed",
      oldLineNumber: index + 1,
      text: originalLines[index]
    });
  }

  for (let index = newIndex; index < replacementLines.length; index += 1) {
    diff.push({
      kind: "added",
      newLineNumber: index + 1,
      text: replacementLines[index]
    });
  }
}
