import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { KnowledgeContext, KnowledgeEntry } from "../types.js";
import type { ImportedDocument, ImportLog, ImportPlan, KnowledgeAdapter } from "./types.js";

const ADAPTER_NAME = "markdown";
const MARKDOWN_PATTERN = /\.(?:md|markdown)$/i;
const H1_PATTERN = /^#(?!#)\s*(.+)$/;

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

// Mirrors the minimal leading "---"-delimited frontmatter parsing in
// src/docscan.ts: any failure to find a well-formed block, or to parse it as
// YAML, is treated as "no frontmatter" rather than an error.
function parseFrontmatter(raw: string): ParsedMarkdown {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: raw };
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingIndex === -1) {
    return { frontmatter: {}, body: raw };
  }
  const block = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n");
  try {
    const parsed: unknown = YAML.parse(block);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body };
    }
    return { frontmatter: {}, body };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

function firstH1(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = H1_PATTERN.exec(line.trim());
    if (match) {
      return match[1]?.trim();
    }
  }
  return undefined;
}

function stringField(frontmatter: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function titleFor(relativePath: string, frontmatter: Record<string, unknown>, body: string): string {
  const fromFrontmatter = stringField(frontmatter, "title");
  if (fromFrontmatter) {
    return fromFrontmatter;
  }
  const heading = firstH1(body);
  if (heading) {
    return heading;
  }
  return path.basename(relativePath).replace(MARKDOWN_PATTERN, "");
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function fingerprintContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function walkMarkdownFiles(source: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && MARKDOWN_PATTERN.test(entry.name)) {
        results.push(path.relative(source, absolute).split(path.sep).join("/"));
      }
    }
  }
  await walk(source);
  return results.sort();
}

interface ReadResult {
  content: string;
  title: string;
  author?: string;
  updatedAt?: string;
  link?: string;
}

async function readMarkdownDocument(source: string, relativePath: string): Promise<ReadResult> {
  const absolute = path.join(source, relativePath);
  const content = await readFile(absolute, "utf8");
  const { frontmatter, body } = parseFrontmatter(content);
  const title = titleFor(relativePath, frontmatter, body);
  const author = stringField(frontmatter, "author", "owner");
  const updatedAt = isoOrUndefined(stringField(frontmatter, "updated", "date"));
  const link = stringField(frontmatter, "link", "url");
  return {
    content,
    title,
    ...(author ? { author } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(link ? { link } : {}),
  };
}

type Classification =
  | { kind: "new" }
  | { kind: "unchanged" }
  | { kind: "changed" }
  | { kind: "conflict"; reason: string };

// Conflict is narrower than "the source file changed": it only fires when
// the log's stored fingerprint for a sourceId differs from BOTH the current
// source file's fingerprint AND the stored content's own recomputed sha256
// (i.e. the log entry itself was hand-edited/tampered, not just re-imported
// after a normal source edit).
function classify(existingDoc: ImportedDocument | undefined, sourceFingerprint: string): Classification {
  if (!existingDoc) {
    return { kind: "new" };
  }
  if (existingDoc.fingerprint === sourceFingerprint) {
    return { kind: "unchanged" };
  }
  const recomputed = fingerprintContent(existingDoc.content);
  if (recomputed !== existingDoc.fingerprint) {
    return {
      kind: "conflict",
      reason:
        `Stored import log entry for "${existingDoc.sourceId}" does not match its own fingerprint ` +
        "(the log was likely hand-edited); leaving it untouched instead of overwriting local changes.",
    };
  }
  return { kind: "changed" };
}

async function plan(source: string, existing: ImportLog | undefined): Promise<ImportPlan> {
  const files = await walkMarkdownFiles(source);
  const byId = new Map((existing?.documents ?? []).map((doc) => [doc.sourceId, doc]));

  const result: ImportPlan = { newDocuments: [], changed: [], unchanged: [], conflicts: [] };
  for (const relativePath of files) {
    const { content } = await readMarkdownDocument(source, relativePath);
    const sourceFingerprint = fingerprintContent(content);
    const classification = classify(byId.get(relativePath), sourceFingerprint);
    switch (classification.kind) {
      case "new":
        result.newDocuments.push(relativePath);
        break;
      case "unchanged":
        result.unchanged.push(relativePath);
        break;
      case "changed":
        result.changed.push(relativePath);
        break;
      case "conflict":
        result.conflicts.push({ path: relativePath, reason: classification.reason });
        break;
    }
  }
  return result;
}

// Returns the full resulting document set to persist as ImportLog.documents:
// new and changed files are (re-)imported with a fresh importedAt, unchanged
// entries are carried over untouched, conflicting entries are left exactly
// as stored (never overwritten), and log entries for files no longer present
// under `source` are preserved rather than silently dropped.
async function importMarkdown(
  source: string,
  existing: ImportLog | undefined,
): Promise<ImportedDocument[]> {
  const files = await walkMarkdownFiles(source);
  const byId = new Map((existing?.documents ?? []).map((doc) => [doc.sourceId, doc]));
  const seen = new Set<string>();
  const importedAt = new Date().toISOString();
  const result: ImportedDocument[] = [];

  for (const relativePath of files) {
    seen.add(relativePath);
    const existingDoc = byId.get(relativePath);
    const doc = await readMarkdownDocument(source, relativePath);
    const sourceFingerprint = fingerprintContent(doc.content);
    const classification = classify(existingDoc, sourceFingerprint);

    if (classification.kind === "conflict") {
      if (existingDoc) {
        result.push(existingDoc);
      }
      continue;
    }
    if (classification.kind === "unchanged" && existingDoc) {
      result.push(existingDoc);
      continue;
    }

    result.push({
      sourceId: relativePath,
      adapter: ADAPTER_NAME,
      path: relativePath,
      title: doc.title,
      content: doc.content,
      ...(doc.author ? { author: doc.author } : {}),
      ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
      ...(doc.link ? { link: doc.link } : {}),
      fingerprint: sourceFingerprint,
      importedAt,
    });
  }

  for (const doc of existing?.documents ?? []) {
    if (!seen.has(doc.sourceId)) {
      result.push(doc);
    }
  }

  return result;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "category";
}

function categorize(context: KnowledgeContext): Array<[string, KnowledgeEntry[]]> {
  const categories = new Map<string, KnowledgeEntry[]>();
  for (const entry of context.entries) {
    const list = categories.get(entry.category) ?? [];
    list.push(entry);
    categories.set(entry.category, list);
  }
  return [...categories.entries()].sort(([left], [right]) => left.localeCompare(right));
}

// Two distinct category names can slugify to the same string (e.g. "Risk!"
// and "risk" both become "risk"). Rather than let a later category silently
// clobber (with --force) or spuriously conflict with (without --force) an
// earlier one's file, every category gets a distinct file: the first
// category to produce a given base slug (in the categorize() sort order,
// which is stable and identical between plannedExportPaths and export) keeps
// it, and each subsequent collision is disambiguated with a -2, -3, ...
// suffix.
function slugsForCategories(grouped: Array<[string, KnowledgeEntry[]]>): Map<string, string> {
  const counts = new Map<string, number>();
  const slugs = new Map<string, string>();
  for (const [category] of grouped) {
    const base = slugify(category);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    slugs.set(category, count === 1 ? base : `${base}-${count}`);
  }
  return slugs;
}

// Computes the destination file paths one `export` call would write, without
// touching the filesystem. Used both by the CLI to render a dry-run preview
// and by tests to assert a dry run leaves the destination untouched. Applies
// the same slug disambiguation as `export` so the printed plan always
// matches what --yes actually writes.
export function plannedExportPaths(context: KnowledgeContext, destination: string): string[] {
  const grouped = categorize(context);
  const slugs = slugsForCategories(grouped);
  return grouped.map(([category]) => path.join(destination, `${slugs.get(category) ?? slugify(category)}.md`));
}

function renderCategoryMarkdown(category: string, entries: KnowledgeEntry[]): string {
  const title = category
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const body = entries
    .map((entry) => {
      const reviewLine = entry.review
        ? `\n_Review: ${entry.review.stale ? "stale" : entry.review.status} by ${entry.review.owner} on ${entry.review.reviewedAt}_`
        : "";
      return `## ${entry.question}

${entry.answer}

_Source: ${entry.source.interviewee}, ${entry.source.generatedAt}, \`${entry.source.file}\`_${reviewLine}
`;
    })
    .join("\n");
  return `# ${title}

${body}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function exportMarkdown(
  context: KnowledgeContext,
  destination: string,
  options: { force: boolean },
): Promise<string[]> {
  await mkdir(destination, { recursive: true });
  const grouped = categorize(context);
  const slugs = slugsForCategories(grouped);
  const files: string[] = [];
  for (const [category, entries] of grouped) {
    const filePath = path.join(destination, `${slugs.get(category) ?? slugify(category)}.md`);
    if (!options.force && (await fileExists(filePath))) {
      throw new Error(`Refusing to overwrite existing file "${filePath}" without --force.`);
    }
    await writeFile(filePath, renderCategoryMarkdown(category, entries));
    files.push(filePath);
  }
  return files;
}

export const markdownAdapter: KnowledgeAdapter = {
  name: ADAPTER_NAME,
  plan,
  import: importMarkdown,
  export: exportMarkdown,
};
