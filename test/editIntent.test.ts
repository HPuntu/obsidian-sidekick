import { describe, expect, it } from "vitest";

import { looksLikeEditRequest } from "../src/prompt/editIntent";

describe("looksLikeEditRequest", () => {
  const asks = [
    "take the last answer and add it to a new note file",
    "append the last answer to an existing note",
    "save the last response to Notes/test.md",
    "add internal links to this note",
    "update the frontmatter",
    "rewrite the introduction",
    "fix the typo in @Notes/a.md",
    "create a glossary entry",
    "link these two notes",
    "tidy up the headings",
    "reorganise this note",
    "please propose an edit",
    "insert a summary at the top",
    "rename this file",
    "make a bullet list in the note"
  ];

  it.each(asks)("treats %j as an edit request", (prompt) => {
    expect(looksLikeEditRequest(prompt)).toBe(true);
  });

  const answersOnly = [
    "Given this formal definition of a distribution, would it be also correct to define it as a bijection: Formally, the distribution of a random variable X is the map B → P(X ∈ B), considered on a suitable collection of subsets B ⊆ R.",
    "Is this correct in the note?",
    "Explain the change of variables formula",
    "make a table comparing the definitions",
    "Do not edit any files; explain the definition",
    "summarise @Learning/Gradient Descent.md",
    "explain gradient descent",
    "what does this note say about regularisation?",
    "compare these two approaches",
    "list the key definitions",
    "quiz me on this",
    "what files exist in this folder?",
    "summarise this and tell me the main result"
  ];

  it.each(answersOnly)("treats %j as answer-only", (prompt) => {
    expect(looksLikeEditRequest(prompt)).toBe(false);
  });

  it("matches inflected verbs", () => {
    expect(looksLikeEditRequest("adding a section")).toBe(true);
    expect(looksLikeEditRequest("updated the note")).toBe(true);
    expect(looksLikeEditRequest("links the notes together")).toBe(true);
  });

  it("does not fire on a verb embedded in a longer word", () => {
    // "summarise" contains "marise"; "addendum" contains "add".
    expect(looksLikeEditRequest("summarise the addendum")).toBe(false);
  });
});
