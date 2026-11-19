export interface ContextSection {
  id: string;
  content: string;
  priority: number;
  required?: boolean;
  truncatable?: boolean;
}

export interface ContextBudgetOptions {
  maxContextTokens: number;
  reservedOutputTokens: number;
  reservedToolTokens: number;
  separator?: string;
}

export interface ContextBudgetReport {
  maxContextTokens: number;
  promptBudgetTokens: number;
  estimatedPromptTokens: number;
  reservedOutputTokens: number;
  reservedToolTokens: number;
  included: string[];
  excluded: string[];
  truncated: string[];
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const ASCII_TERM = /[a-z0-9][a-z0-9._/-]+/gu;
const CJK_RUN = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/gu;

const relevanceTerms = (text: string) => {
  const normalized = text.toLocaleLowerCase();
  const terms = new Set(normalized.match(ASCII_TERM) ?? []);
  for (const run of normalized.match(CJK_RUN) ?? []) {
    if (run.length === 1) terms.add(run);
    else for (let index = 0; index < run.length - 1; index++) terms.add(run.slice(index, index + 2));
  }
  return terms;
};

/** Bounded lexical relevance for deterministic pre-routing; semantic retrieval can replace it later. */
export const contextRelevance = (query: string, candidate: string) => {
  const wanted = relevanceTerms(query);
  if (!wanted.size) return 0;
  const available = relevanceTerms(candidate);
  let matches = 0;
  for (const term of wanted) if (available.has(term)) matches++;
  return Math.min(100, Math.round((matches / wanted.size) * 100));
};

/** Conservative mixed Chinese/ASCII estimate without binding the platform to one tokenizer. */
export const estimateTokens = (text: string) => {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (CJK.test(character)) cjk++;
    else if (!/\s/u.test(character)) other++;
  }
  return cjk + Math.ceil(other / 4);
};

const integer = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`${name} must be a non-negative integer`);
  return value;
};

const truncateToTokens = (text: string, budget: number) => {
  if (estimateTokens(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).trimEnd();
};

export const assembleContext = (sections: ContextSection[], options: ContextBudgetOptions) => {
  const maxContextTokens = integer(options.maxContextTokens, "maxContextTokens");
  const reservedOutputTokens = integer(options.reservedOutputTokens, "reservedOutputTokens");
  const reservedToolTokens = integer(options.reservedToolTokens, "reservedToolTokens");
  const promptBudgetTokens = maxContextTokens - reservedOutputTokens - reservedToolTokens;
  if (promptBudgetTokens < 1) throw Error("Context reserves leave no prompt budget");
  const separator = options.separator ?? "\n\n";
  const separatorTokens = estimateTokens(separator);
  const ordered = [...sections].sort(
    (a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)) || b.priority - a.priority,
  );
  const included: string[] = [];
  const excluded: string[] = [];
  const truncated: string[] = [];
  const content: string[] = [];
  let used = 0;

  for (const section of ordered) {
    if (!section.id || !section.content) continue;
    const separatorCost = content.length ? separatorTokens : 0;
    const remaining = promptBudgetTokens - used - separatorCost;
    const tokens = estimateTokens(section.content);
    if (tokens <= remaining) {
      content.push(section.content);
      included.push(section.id);
      used += separatorCost + tokens;
      continue;
    }
    if (section.required && section.truncatable === false)
      throw Error(`Required context section exceeds the prompt budget: ${section.id}`);
    if (remaining > 16 && section.truncatable !== false) {
      const suffix = "\n[context section truncated]";
      const shortened = truncateToTokens(section.content, Math.max(1, remaining - estimateTokens(suffix)));
      if (shortened) {
        content.push(`${shortened}${suffix}`);
        included.push(section.id);
        truncated.push(section.id);
        used += separatorCost + estimateTokens(`${shortened}${suffix}`);
        continue;
      }
    }
    excluded.push(section.id);
  }

  const text = content.join(separator);
  const report: ContextBudgetReport = {
    maxContextTokens,
    promptBudgetTokens,
    estimatedPromptTokens: estimateTokens(text),
    reservedOutputTokens,
    reservedToolTokens,
    included,
    excluded,
    truncated,
  };
  return { text, report };
};
