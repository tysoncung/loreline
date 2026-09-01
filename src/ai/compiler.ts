import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadInterviews } from "../knowledge.js";
import { redactSecrets, scanTextForSecrets } from "../secrets.js";
import type { AiMessage, AiProvider } from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import type { KnowledgeContext, KnowledgeEntry } from "../types.js";
import { stripCodeFences } from "./interviewer.js";

export const COMPILE_PROMPT_VERSION = "compile-v1";

export interface ProposalResult {
  directory: string;
  files: string[];
  conflicts: number;
}

interface RawSuggestion {
  target: string;
  content: string;
}

interface RawProposal {
  summary: string;
  conflicts: string[];
  suggestions: RawSuggestion[];
}

interface UnresolvedItem {
  id: string;
  question: string;
  sourceFile: string;
}

interface ConflictGroup {
  id: string;
  question: string;
  answers: Array<{ answer: string; interviewee: string; file: string }>;
}

interface CategoryGroup {
  category: string;
  entries: KnowledgeEntry[];
  unresolved: UnresolvedItem[];
  text: string;
}

const SYSTEM_PROMPT = `You are helping compile organizational knowledge captured during interviews into
documentation update proposals for a software project. Read the category name and the question/answer
pairs in the user message. Return ONLY strict JSON shaped as
{"summary": string, "conflicts": string[], "suggestions": [{"target": string, "content": string}]}.
"summary" is a consolidated inferred summary of the knowledge in this category.
"conflicts" lists any claims among the provided answers that contradict each other (an empty array when
there are none).
"suggestions" lists proposed updates to project documentation such as AGENTS.md, an architecture decision
record (ADR), an operational runbook, or an ownership document: each item's "target" is a short label for
what should be updated (for example "AGENTS.md", "adr-authentication", "runbook-deploy", "ownership") and
"content" is the proposed Markdown content for that update.
Do not include any prose, explanation, or markdown code fences outside the JSON. Return only the raw JSON
object.`;

const RETRY_INSTRUCTION =
  'Your previous response was not valid JSON shaped as {"summary": string, "conflicts": string[], ' +
  '"suggestions": [{"target": string, "content": string}]}. Reply again with ONLY that JSON object, no ' +
  "prose or markdown code fences.";

/**
 * Compiles AI-assisted documentation-update proposals from an already
 * compiled knowledge context. Groups entries by category, asks the provider
 * for one completion per category, and writes everything under
 * `<outputDirectory>/proposals/<stamp>/`; nothing outside that directory is
 * ever created or modified. Conflicting answers (same category and question
 * id, different trimmed text) are always surfaced, independent of whether
 * the model itself reports them.
 */
export async function compileWithAi(options: {
  provider: AiProvider;
  context: KnowledgeContext;
  outputDirectory: string;
}): Promise<ProposalResult> {
  const { provider, context, outputDirectory } = options;
  const groups = await buildCategoryGroups(context, outputDirectory);

  const proposalsDirectory = path.join(outputDirectory, "proposals", stamp(new Date()));
  const suggestionsDirectory = path.join(proposalsDirectory, "suggestions");

  const sections: string[] = [];
  const suggestionContents = new Map<string, string[]>();
  let totalConflicts = 0;

  for (const group of groups) {
    // Secrets scan runs, and the run aborts on a high-confidence finding,
    // before any network call is made for this category.
    const findings = scanTextForSecrets(group.text, `context:${group.category}`);
    if (findings.some((finding) => finding.severity === "high")) {
      throw new Error(
        `AI proposal generation blocked: high-confidence secret finding(s) in category "${group.category}"; ` +
          "redact the offending answer(s) and retry.",
      );
    }
    const safeText = redactSecrets(group.text);

    const proposal = await requestProposal(provider, group.category, safeText);
    const deterministicConflicts = detectConflicts(group.entries);

    totalConflicts += proposal.conflicts.length + deterministicConflicts.length;

    sections.push(
      renderCategorySection(group, proposal, deterministicConflicts, provider),
    );

    for (const suggestion of proposal.suggestions) {
      const slug = slugifyTarget(suggestion.target);
      const existing = suggestionContents.get(slug) ?? [];
      existing.push(suggestion.content);
      suggestionContents.set(slug, existing);
    }
  }

  const proposalMarkdown = renderProposalDocument(context, sections);

  await mkdir(suggestionsDirectory, { recursive: true });
  const files: string[] = [];

  const proposalPath = path.join(proposalsDirectory, "proposal.md");
  await writeFile(proposalPath, proposalMarkdown);
  files.push(proposalPath);

  for (const slug of [...suggestionContents.keys()].sort()) {
    const content = suggestionContents.get(slug)!.join("\n\n---\n\n");
    const suggestionPath = path.join(suggestionsDirectory, slug);
    await writeFile(suggestionPath, content.endsWith("\n") ? content : `${content}\n`);
    files.push(suggestionPath);
  }

  return { directory: proposalsDirectory, files, conflicts: totalConflicts };
}

/**
 * Previews the per-category payload compileWithAi would send: category
 * names and the byte size of the assembled (pre-redaction) outbound text,
 * in the same order compileWithAi processes them. Used by the CLI to print
 * a transmission summary before confirming.
 */
export async function previewCategories(
  context: KnowledgeContext,
  outputDirectory: string,
): Promise<Array<{ category: string; bytes: number }>> {
  const groups = await buildCategoryGroups(context, outputDirectory);
  return groups.map((group) => ({ category: group.category, bytes: Buffer.byteLength(group.text, "utf8") }));
}

async function buildCategoryGroups(
  context: KnowledgeContext,
  outputDirectory: string,
): Promise<CategoryGroup[]> {
  const entriesByCategory = new Map<string, KnowledgeEntry[]>();
  for (const entry of context.entries) {
    const list = entriesByCategory.get(entry.category) ?? [];
    list.push(entry);
    entriesByCategory.set(entry.category, list);
  }

  // context.unresolved (schemaVersion 2) does not carry a category, so
  // unresolved questions are re-derived here from the underlying interview
  // records, which do carry it on every answer (including unanswered ones).
  // This never touches or reshapes knowledge.ts's own output.
  const unresolvedByCategory = new Map<string, UnresolvedItem[]>();
  const sources = await loadInterviews(outputDirectory);
  for (const source of sources) {
    for (const answer of source.record.answers) {
      if (answer.answer.trim()) {
        continue;
      }
      const list = unresolvedByCategory.get(answer.category) ?? [];
      list.push({ id: answer.id, question: answer.question, sourceFile: source.file });
      unresolvedByCategory.set(answer.category, list);
    }
  }

  const categories = new Set<string>([...entriesByCategory.keys(), ...unresolvedByCategory.keys()]);
  return [...categories].sort((left, right) => left.localeCompare(right)).map((category) => {
    const entries = entriesByCategory.get(category) ?? [];
    const unresolved = unresolvedByCategory.get(category) ?? [];
    return { category, entries, unresolved, text: buildOutboundText(entries) };
  });
}

function buildOutboundText(entries: KnowledgeEntry[]): string {
  if (entries.length === 0) {
    return "(no answered questions recorded for this category yet)";
  }
  return entries.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`).join("\n\n");
}

// Entries in the same category sharing a question id but disagreeing (after
// trimming) on the answer text are always treated as a conflict, regardless
// of whether the model itself notices.
function detectConflicts(entries: KnowledgeEntry[]): ConflictGroup[] {
  const byId = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    const list = byId.get(entry.id) ?? [];
    list.push(entry);
    byId.set(entry.id, list);
  }

  const conflicts: ConflictGroup[] = [];
  for (const [id, group] of byId) {
    const distinct = new Set(group.map((entry) => entry.answer.trim()));
    if (distinct.size <= 1) {
      continue;
    }
    conflicts.push({
      id,
      question: group[0]!.question,
      answers: group.map((entry) => ({
        answer: entry.answer,
        interviewee: entry.source.interviewee,
        file: entry.source.file,
      })),
    });
  }
  return conflicts.sort((left, right) => left.id.localeCompare(right.id));
}

async function requestProposal(
  provider: AiProvider,
  category: string,
  text: string,
): Promise<RawProposal> {
  const messages: AiMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Category: ${category}\n\n${text}` },
  ];

  let proposal = await tryParseProposal(provider, messages);
  if (proposal === undefined) {
    messages.push({ role: "user", content: RETRY_INSTRUCTION });
    proposal = await tryParseProposal(provider, messages);
  }
  if (proposal === undefined) {
    throw new ProviderError("provider returned invalid proposal JSON");
  }
  return proposal;
}

async function tryParseProposal(
  provider: AiProvider,
  messages: AiMessage[],
): Promise<RawProposal | undefined> {
  const result = await provider.complete({ messages });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(result.text));
  } catch {
    return undefined;
  }
  return isValidRawProposal(parsed) ? parsed : undefined;
}

function isValidRawProposal(value: unknown): value is RawProposal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.summary !== "string") {
    return false;
  }
  if (!Array.isArray(candidate.conflicts) || !candidate.conflicts.every((item) => typeof item === "string")) {
    return false;
  }
  if (!Array.isArray(candidate.suggestions)) {
    return false;
  }
  return candidate.suggestions.every((item) => isValidRawSuggestion(item));
}

function isValidRawSuggestion(value: unknown): value is RawSuggestion {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.target === "string" && candidate.target.trim().length > 0 && typeof candidate.content === "string";
}

// Sanitizes a model-proposed target label into a safe suggestions/<slug>.md
// filename: lowercased, path separators and any other non [a-z0-9-]
// character collapsed to "-", leading/trailing "-" trimmed, ".md" appended.
function slugifyTarget(target: string): string {
  const withoutExtension = target.replace(/\.md$/i, "");
  const slug = withoutExtension
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "suggestion"}.md`;
}

function renderCategorySection(
  group: CategoryGroup,
  proposal: RawProposal,
  deterministicConflicts: ConflictGroup[],
  provider: AiProvider,
): string {
  const title = categoryTitle(group.category);

  const quotedFacts =
    group.entries.length > 0
      ? group.entries
          .map(
            (entry) =>
              `- **${entry.question}** (\`${entry.id}\`): "${entry.answer}" (${entry.source.interviewee}, \`${entry.source.file}\`)`,
          )
          .join("\n")
      : "None.";

  const unresolvedLines = [
    ...proposal.conflicts.map((conflict) => `- ${conflict}`),
    ...deterministicConflicts.map((conflict) => `- ${renderConflictLine(conflict)}`),
    ...group.unresolved.map((item) => `- ${item.question} (\`${item.sourceFile}\`)`),
  ];
  const unresolved = unresolvedLines.length > 0 ? unresolvedLines.join("\n") : "None.";

  return `## ${title}

### Quoted facts

${quotedFacts}

### Inferred summary (AI-generated)

${proposal.summary}

_Generated by ${provider.name}/${provider.model}, prompt ${COMPILE_PROMPT_VERSION}_

### Unresolved and conflicting

${unresolved}`;
}

function renderConflictLine(conflict: ConflictGroup): string {
  const rendered = conflict.answers
    .map((answer) => `"${answer.answer}" (${answer.interviewee}, \`${answer.file}\`)`)
    .join(" vs ");
  return `Conflicting answers for "${conflict.question}" (id: \`${conflict.id}\`): ${rendered}`;
}

function renderProposalDocument(context: KnowledgeContext, sections: string[]): string {
  const generatedAt = new Date().toISOString();
  const body = sections.length > 0 ? sections.join("\n\n") : "No compiled knowledge entries to propose from.";
  return `# ${context.project} Compilation Proposals

> Draft proposals only, generated by Loreline from the compiled knowledge context. Nothing here is applied
> to real project documentation automatically; review and apply by hand.

**Generated:** ${generatedAt}

${body}
`;
}

function categoryTitle(category: string): string {
  return category
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
