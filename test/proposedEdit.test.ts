import { expect, it } from "vitest";
import { parseProposedEditsFromMarkdown } from "../src/agent/ProposedEdit";

it("parses an append proposal without treating it as a replacement", () => {
  expect(parseProposedEditsFromMarkdown("```agent-edit\npath: Notes/Test.md\noperation: append\n---\nAdded text\n```"))
    .toEqual([{ path: "Notes/Test.md", operation: "append", replacementText: "Added text" }]);
});
it("preserves fenced code inside four-backtick proposals", () => {
  const content = "# Note\n```js\nconsole.log(1);\n```\nEnd";
  expect(parseProposedEditsFromMarkdown(`\`\`\`\`agent-edit\npath: Test.md\n---\n${content}\n\`\`\`\``)[0].replacementText).toBe(content);
});
it("rejects unsupported operations and prose-only claims", () => {
  expect(parseProposedEditsFromMarkdown("I edited Test.md")).toEqual([]);
  expect(parseProposedEditsFromMarkdown("```agent-edit\npath: Test.md\noperation: delete\n---\ntext\n```" )).toEqual([]);
});
