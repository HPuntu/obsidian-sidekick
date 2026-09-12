import { expect, it } from "vitest";
import { normalizeTableSpacing } from "../src/markdown/normalizeTables";
const table = "| Action | Reason |\n|---|---|\n| A | B |";
it("separates tables from preceding paragraphs", () => {
  expect(normalizeTableSpacing(`Intro:\n${table}`)).toBe(`Intro:\n\n${table}`);
});
it("preserves fenced examples and existing spacing", () => {
  const code = `\`\`\`md\nIntro:\n${table}\n\`\`\``;
  expect(normalizeTableSpacing(code)).toBe(code);
  expect(normalizeTableSpacing(`Intro:\n\n${table}`)).toBe(`Intro:\n\n${table}`);
});
it("does not transform incomplete streamed tables", () => {
  expect(normalizeTableSpacing("Intro:\n| A | B |\n|--")).toBe("Intro:\n| A | B |\n|--");
});
