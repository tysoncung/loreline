import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { citeFile } from "./citations.js";
import { inScope, type ScanScope } from "./scope.js";
import type { Finding, FindingStatus, LorelineConfig, ReadinessReport } from "./types.js";

const DOCUMENT_PATTERN = /\.(?:md|mdx|txt|rst|adoc)$/i;
const OPERATIONS_PATTERN = /runbook|procedure|process|policy|escalation/i;
const TERMINOLOGY_PATTERN = /glossary|terminology|definitions/i;
const H1_PATTERN = /^#(?!#)\s*(.+)$/;
const FRESHNESS_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const PURPOSE_LOOKAHEAD_LINES = 5;

const MAX_EVIDENCE = 10;

interface DocumentRecord {
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
  mtimeMs: number;
}

interface DocumentInventory {
  documents: DocumentRecord[];
  unreadable: string[];
}

export async function scanDocuments(root: string, config: LorelineConfig): Promise<ReadinessReport> {
  const scope: ScanScope = { include: config.scan.include, exclude: config.scan.exclude };
  const inventory = await inventoryDocuments(root, config, scope);
  const findings = await citeFindings(root, buildFindings(inventory.documents, new Date()));

  const totalWeight = findings.reduce((sum, finding) => sum + finding.weight, 0);
  const earnedWeight = findings.reduce((sum, finding) => {
    const multiplier = finding.status === "pass" ? 1 : finding.status === "partial" ? 0.5 : 0;
    return sum + finding.weight * multiplier;
  }, 0);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    root,
    score: totalWeight === 0 ? 0 : Math.round((earnedWeight / totalWeight) * 100),
    summary: {
      passed: findings.filter((finding) => finding.status === "pass").length,
      partial: findings.filter((finding) => finding.status === "partial").length,
      missing: findings.filter((finding) => finding.status === "missing").length,
      filesScanned: inventory.documents.length,
    },
    mode: "documents",
    findings,
    unreadable: inventory.unreadable,
  };
}

async function citeFindings(root: string, findings: Finding[]): Promise<Finding[]> {
  return Promise.all(
    findings.map(async (finding) => {
      if (finding.evidence.length === 0) {
        return finding;
      }
      const citations = await Promise.all(finding.evidence.map((file) => citeFile(root, file)));
      return { ...finding, citations };
    }),
  );
}

function buildFindings(documents: DocumentRecord[], now: Date): Finding[] {
  const total = documents.length;

  const purposeOffenders = documents.filter((doc) => !hasPurpose(doc)).map((doc) => doc.path);
  const ownershipOffenders = documents.filter((doc) => !hasOwnership(doc)).map((doc) => doc.path);
  const freshnessOffenders = documents.filter((doc) => !isFresh(doc, now)).map((doc) => doc.path);
  const linkage = linkageAnalysis(documents);
  const structurePresent = documents.some((doc) => /^(?:readme|index)\.md$/i.test(doc.path));
  const terminologyFiles = documents
    .filter((doc) => TERMINOLOGY_PATTERN.test(basename(doc.path)))
    .map((doc) => doc.path);
  const operationsFiles = operationsDocuments(documents).map((doc) => doc.path);

  return [
    finding(
      "doc-purpose",
      "Document purpose",
      coverageStatus(total - purposeOffenders.length, total, 0.8, 0.5),
      15,
      sortedEvidence(purposeOffenders),
      "Start each document with an H1 heading or a frontmatter title within the first 5 lines.",
    ),
    finding(
      "doc-ownership",
      "Document ownership",
      coverageStatus(total - ownershipOffenders.length, total, 0.8, 0.5),
      15,
      sortedEvidence(ownershipOffenders),
      "Add a frontmatter `owner:` or `author:` field to each document.",
    ),
    finding(
      "doc-freshness",
      "Document freshness",
      coverageStatus(total - freshnessOffenders.length, total, 0.8, 0.5),
      15,
      sortedEvidence(freshnessOffenders),
      "Update stale documents, or set a frontmatter `updated:`/`date:` field when a review confirms they are current.",
    ),
    finding(
      "doc-structure",
      "Collection entry point",
      structurePresent ? "pass" : "missing",
      10,
      structurePresent ? documents.filter((doc) => /^(?:readme|index)\.md$/i.test(doc.path)).map((doc) => doc.path) : [],
      "Add a README.md or index.md at the root of the document collection as an entry point.",
    ),
    finding(
      "doc-linkage",
      "Document linkage",
      coverageStatus(total - linkage.orphans.length, total, 0.6, 0.3),
      15,
      sortedEvidence(linkage.orphans),
      "Link orphaned documents from an index or another document so readers (and agents) can discover them.",
    ),
    finding(
      "doc-terminology",
      "Glossary or terminology reference",
      terminologyFiles.length > 0 ? "pass" : "missing",
      10,
      sortedEvidence(terminologyFiles),
      "Add a glossary, terminology, or definitions document for domain-specific vocabulary.",
    ),
    finding(
      "doc-operations",
      "Operational documentation",
      operationsFiles.length > 0 ? "pass" : "missing",
      20,
      sortedEvidence(operationsFiles),
      "Add a runbook, procedure, process, policy, or escalation document with real content.",
    ),
  ];
}

function coverageStatus(matching: number, total: number, passAt: number, partialAt: number): FindingStatus {
  if (total === 0) {
    return "missing";
  }
  const ratio = matching / total;
  if (ratio >= passAt) {
    return "pass";
  }
  if (ratio >= partialAt) {
    return "partial";
  }
  return "missing";
}

function sortedEvidence(files: string[]): string[] {
  return files.slice().sort().slice(0, MAX_EVIDENCE);
}

function finding(
  id: string,
  title: string,
  status: FindingStatus,
  weight: number,
  evidence: string[],
  recommendation: string,
): Finding {
  return { id, title, status, weight, evidence, recommendation };
}

function hasPurpose(doc: DocumentRecord): boolean {
  const title = doc.frontmatter.title;
  if (typeof title === "string" && title.trim().length > 0) {
    return true;
  }
  const lines = doc.body.split(/\r?\n/).slice(0, PURPOSE_LOOKAHEAD_LINES);
  return lines.some((line) => H1_PATTERN.test(line.trim()));
}

function hasOwnership(doc: DocumentRecord): boolean {
  const owner = doc.frontmatter.owner ?? doc.frontmatter.author;
  return typeof owner === "string" && owner.trim().length > 0;
}

function isFresh(doc: DocumentRecord, now: Date): boolean {
  const declared = doc.frontmatter.updated ?? doc.frontmatter.date;
  const parsed = parseDeclaredDate(declared);
  const reference = parsed ?? new Date(doc.mtimeMs);
  const age = now.getTime() - reference.getTime();
  return age >= 0 && age <= FRESHNESS_WINDOW_MS;
}

function parseDeclaredDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

function firstH1Text(doc: DocumentRecord): string | undefined {
  for (const line of doc.body.split(/\r?\n/)) {
    const match = H1_PATTERN.exec(line.trim());
    if (match) {
      return match[1]?.trim();
    }
  }
  return undefined;
}

function hasBodyContentBeyondHeading(doc: DocumentRecord): boolean {
  const lines = doc.body.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => H1_PATTERN.test(line.trim()));
  const rest = headingIndex === -1 ? lines : lines.slice(headingIndex + 1);
  return rest.some((line) => line.trim().length > 0);
}

function basename(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

function operationsDocuments(documents: DocumentRecord[]): DocumentRecord[] {
  return documents.filter((doc) => {
    const filenameMatches = OPERATIONS_PATTERN.test(basename(doc.path));
    const heading = firstH1Text(doc);
    const headingMatches = heading !== undefined && OPERATIONS_PATTERN.test(heading);
    if (!filenameMatches && !headingMatches) {
      return false;
    }
    return hasBodyContentBeyondHeading(doc);
  });
}

const MARKDOWN_LINK_PATTERN = /\]\(([^)]+)\)/g;

function relativeLinkTargets(doc: DocumentRecord): string[] {
  const targets: string[] = [];
  for (const match of doc.body.matchAll(MARKDOWN_LINK_PATTERN)) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#") || raw.startsWith("//")) {
      // Absolute URL, scheme link, or in-page anchor: not a relative
      // document reference.
      continue;
    }
    const withoutAnchor = raw.split("#")[0]?.trim();
    if (!withoutAnchor) {
      continue;
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(doc.path), withoutAnchor));
    targets.push(resolved);
  }
  return targets;
}

function linkageAnalysis(documents: DocumentRecord[]): { referenced: Set<string>; orphans: string[] } {
  const known = new Set(documents.map((doc) => doc.path));
  const referenced = new Set<string>();

  for (const doc of documents) {
    if (!doc.path.includes("/") && /^(?:readme|index)\.md$/i.test(doc.path)) {
      referenced.add(doc.path);
    }
  }
  for (const doc of documents) {
    for (const target of relativeLinkTargets(doc)) {
      if (known.has(target)) {
        referenced.add(target);
      }
    }
  }

  const orphans = documents.filter((doc) => !referenced.has(doc.path)).map((doc) => doc.path);
  return { referenced, orphans };
}

async function inventoryDocuments(
  root: string,
  config: LorelineConfig,
  scope: ScanScope,
): Promise<DocumentInventory> {
  const candidates: string[] = [];
  const excluded = new Set(config.scan.exclude);

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (candidates.length >= config.scan.maxFiles) {
        return;
      }
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name) && !excluded.has(relative)) {
          await walk(absolute);
        }
      } else if (entry.isFile()) {
        if (DOCUMENT_PATTERN.test(relative) && inScope(relative, scope)) {
          candidates.push(relative);
        }
      }
    }
  }

  await walk(root);

  const documents: DocumentRecord[] = [];
  const unreadable: string[] = [];
  for (const relative of candidates) {
    const absolute = path.join(root, relative);
    const buffer = await readFile(absolute);
    const decoded = decodeUtf8Strict(buffer);
    if (decoded === undefined) {
      unreadable.push(relative);
      continue;
    }
    const stats = await stat(absolute);
    const { frontmatter, body } = parseFrontmatter(decoded);
    documents.push({ path: relative, body, frontmatter, mtimeMs: stats.mtimeMs });
  }

  return { documents, unreadable: unreadable.slice().sort() };
}

function decodeUtf8Strict(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

// Parses a leading "---" delimited YAML frontmatter block. Any failure to
// find a well-formed block, or to parse it as YAML, is treated as "no
// frontmatter" rather than an error: the whole file becomes the body.
function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
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
