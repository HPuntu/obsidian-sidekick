/** Require a change instruction and a document target, not isolated words in a question. */
export function looksLikeEditRequest(prompt: string): boolean {
  const text = prompt.replace(/```[\s\S]*?```/g, "").trim().toLowerCase();
  if (/\b(?:do not|don't|never)\s+(?:edit|write|modify|change|save)\b/.test(text)) return false;
  const verbs = /^(?:(?:please|can you|could you|would you|will you)\s+)*(?:save|persist|put|add|amend|append|annotate|apply|change|clean\s+up|correct|create|edit|expand|fill\s+in|fix|format|insert|link|make|merge|move|reformat|refactor|remove|rename|reorganise|reorganize|replace|restructure|rewrite|tidy|update|write)(?:s|d|ed|ing)?\b/;
  if (/^(?:please\s+)?propose an edit\b/.test(text)) return true;
  const target = /\b(?:notes?|files?|frontmatter|headings?|introduction|sections?|paragraphs?|typos?|glossary|document|vault)\b|\.md\b|@\S+/.test(text);
  return text.split(/(?:[.!?;]\s+|\b(?:and|then)\s+)/).some((part) => verbs.test(part.trim())) &&
    (target || /\binsert\b.*\b(?:top|bottom)\b/.test(text));
}
