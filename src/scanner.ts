import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { citeFile } from "./citations.js";
import { METHODOLOGY as HISTORY_METHODOLOGY, type AreaOwnership, type HistoryInsights } from "./history.js";
import { inScope, type ScanScope } from "./scope.js";
import type { Finding, FindingStatus, LorelineConfig, ReadinessReport } from "./types.js";
import { validateArtifact } from "./validation.js";

const DOCUMENT_PATTERN = /\.(?:md|mdx|txt|rst|adoc)$/i;

const MIN_ANALYZED_COMMITS = 10;
const QUALIFYING_AREA_COMMITS = 5;
const CONCENTRATION_THRESHOLD = 0.8;

const NO_HISTORY: HistoryInsights = {
  available: false,
  analyzedCommits: 0,
  excludedIdentities: [],
  methodology: HISTORY_METHODOLOGY,
  areas: [],
};

interface RepositoryInventory {
  files: string[];
  documents: string[];
  packageScripts: Record<string, string>;
}

export async function scanRepository(
  root: string,
  config: LorelineConfig,
  cliScope?: ScanScope,
  options?: { history?: HistoryInsights },
): Promise<ReadinessReport> {
  const narrowed = Boolean(cliScope && (cliScope.include.length > 0 || cliScope.exclude.length > 0));
  // CLI includes replace the config include list entirely rather than
  // appending to it: config.scan.include defaults to "**/*", and appending
  // to a pattern that already matches everything would make --include a
  // no-op. CLI excludes stay additive to config excludes; exclude-wins
  // semantics are unchanged.
  const scope: ScanScope = {
    include: cliScope && cliScope.include.length > 0 ? cliScope.include : config.scan.include,
    exclude: [...config.scan.exclude, ...(cliScope?.exclude ?? [])],
  };
  const history = options?.history ?? NO_HISTORY;

  const inventory = await inventoryRepository(root, config, scope);
  const findings = await citeFindings(root, [...buildFindings(inventory), knowledgeConcentrationFinding(history)]);
  const totalWeight = findings.reduce((sum, finding) => sum + finding.weight, 0);
  const earnedWeight = findings.reduce((sum, finding) => {
    const multiplier = finding.status === "pass" ? 1 : finding.status === "partial" ? 0.5 : 0;
    return sum + finding.weight * multiplier;
  }, 0);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    root,
    score: Math.round((earnedWeight / totalWeight) * 100),
    summary: {
      passed: findings.filter((finding) => finding.status === "pass").length,
      partial: findings.filter((finding) => finding.status === "partial").length,
      missing: findings.filter((finding) => finding.status === "missing").length,
      filesScanned: inventory.files.length,
    },
    ...(narrowed ? { scope } : {}),
    mode: "repository",
    findings,
    ...(history.available ? { history } : {}),
  };
}

export async function writeReport(
  report: ReadinessReport,
  outputDirectory: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, "readiness.json");
  const markdownPath = path.join(outputDirectory, "readiness.md");
  await validateArtifact<ReadinessReport>("readiness", report, jsonPath);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdownReport(report)),
  ]);
  return { jsonPath, markdownPath };
}

// Findings whose "evidence" strings are human-readable summaries rather than
// repository file paths cannot be cited: citeFile would try to read them as
// files and fail.
const UNCITABLE_FINDINGS = new Set(["knowledge-concentration"]);

async function citeFindings(root: string, findings: Finding[]): Promise<Finding[]> {
  return Promise.all(
    findings.map(async (finding) => {
      if (finding.evidence.length === 0 || UNCITABLE_FINDINGS.has(finding.id)) {
        return finding;
      }
      const citations = await Promise.all(finding.evidence.map((file) => citeFile(root, file)));
      return { ...finding, citations };
    }),
  );
}

function buildFindings(inventory: RepositoryInventory): Finding[] {
  const files = new Set(inventory.files.map((file) => file.toLowerCase()));
  const docs = inventory.documents.map((file) => file.toLowerCase());
  const matching = (...patterns: RegExp[]): string[] =>
    inventory.files.filter((file) => patterns.some((pattern) => pattern.test(file)));

  return [
    finding(
      "project-overview",
      "Project overview",
      files.has("readme.md") ? "pass" : "missing",
      15,
      matching(/^readme\.(?:md|rst|txt)$/i),
      "Add a README explaining the project's purpose, users, boundaries, and setup.",
    ),
    finding(
      "ai-guidance",
      "AI agent guidance",
      matching(/(^|\/)(?:agents|claude)\.md$/i, /(^|\/)\.github\/copilot-instructions\.md$/i).length > 0
        ? "pass"
        : "missing",
      15,
      matching(/(^|\/)(?:agents|claude)\.md$/i, /(^|\/)\.github\/copilot-instructions\.md$/i),
      "Add AGENTS.md with repository-specific conventions, commands, boundaries, and verification steps.",
    ),
    finding(
      "ownership",
      "Explicit ownership",
      matching(/(^|\/)codeowners$/i, /ownership\.(?:ya?ml|md)$/i).length > 0 ? "pass" : "missing",
      15,
      matching(/(^|\/)codeowners$/i, /ownership\.(?:ya?ml|md)$/i),
      "Document maintainers and subject-matter experts using CODEOWNERS or ownership metadata.",
    ),
    finding(
      "architecture",
      "Architecture and boundaries",
      docs.some((file) => /architecture|design|system-overview/.test(file)) ? "pass" : "missing",
      15,
      matching(/architecture|design|system-overview/i),
      "Describe components, boundaries, dependencies, and important data flows.",
    ),
    finding(
      "decisions",
      "Decision history",
      docs.some((file) => /(^|\/)(adr|decisions?)(\/|\.|$)/.test(file)) ? "pass" : "missing",
      10,
      matching(/(^|\/)(adr|decisions?)(\/|\.|$)/i),
      "Record consequential decisions and rejected alternatives as ADRs.",
    ),
    finding(
      "operations",
      "Operations and troubleshooting",
      docs.some((file) => /runbook|operations|troubleshoot|incident/.test(file)) ? "pass" : "missing",
      15,
      matching(/runbook|operations|troubleshoot|incident/i),
      "Add runbooks covering deployment, common failures, diagnostics, and recovery.",
    ),
    finding(
      "verification",
      "Automated verification",
      verificationStatus(inventory),
      15,
      matching(/(^|\/)(test|tests|spec|specs)(\/|\.|$)/i),
      "Provide a documented, automated test or verification command.",
    ),
  ];
}

function verificationStatus(inventory: RepositoryInventory): "pass" | "partial" | "missing" {
  if (inventory.packageScripts.test && !inventory.packageScripts.test.includes("no test specified")) {
    return "pass";
  }
  if (inventory.files.some((file) => /(^|\/)(test|tests|spec|specs)(\/|\.|$)/i.test(file))) {
    return "partial";
  }
  return "missing";
}

function knowledgeConcentrationFinding(history: HistoryInsights): Finding {
  if (!history.available || history.analyzedCommits < MIN_ANALYZED_COMMITS) {
    return finding(
      "knowledge-concentration",
      "Knowledge distribution",
      "partial",
      10,
      [],
      "Not enough git history was available for automated analysis; review contributor concentration manually.",
    );
  }

  const qualifying = history.areas.filter((area) => area.commits >= QUALIFYING_AREA_COMMITS);
  const risky = qualifying.filter((area) => area.topShare > CONCENTRATION_THRESHOLD);

  let status: FindingStatus;
  if (risky.length === 0) {
    status = "pass";
  } else if (risky.length > qualifying.length / 2) {
    status = "missing";
  } else {
    status = "partial";
  }

  const evidence = risky.map((area) => concentrationEvidence(area));

  return finding(
    "knowledge-concentration",
    "Knowledge distribution",
    status,
    10,
    evidence,
    "Cross-train a backup contributor for areas where git history shows knowledge concentrated in one person.",
  );
}

function concentrationEvidence(area: AreaOwnership): string {
  const top = area.contributors[0];
  const name = top?.name ?? "unknown";
  const pct = Math.round(area.topShare * 100);
  return `${area.area}: ${name} authored ${pct}% of ${area.commits} commits`;
}

function finding(
  id: string,
  title: string,
  status: Finding["status"],
  weight: number,
  evidence: string[],
  recommendation: string,
): Finding {
  return { id, title, status, weight, evidence, recommendation };
}

async function inventoryRepository(
  root: string,
  config: LorelineConfig,
  scope: ScanScope,
): Promise<RepositoryInventory> {
  const files: string[] = [];
  // Simple name-based exclusion prunes whole directories during the walk so
  // excluded trees (e.g. node_modules) are never descended into; this stays
  // in place for speed even though the fuller glob-based scope below is what
  // ultimately decides which files are kept.
  const excluded = new Set(config.scan.exclude);

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= config.scan.maxFiles) {
        return;
      }
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name) && !excluded.has(relative)) {
          await walk(absolute);
        }
      } else if (entry.isFile()) {
        if (inScope(relative, scope)) {
          files.push(relative);
        }
      }
    }
  }

  await walk(root);
  const packageScripts = await readPackageScripts(root);
  return {
    files,
    documents: files.filter((file) => DOCUMENT_PATTERN.test(file)),
    packageScripts,
  };
}

async function readPackageScripts(root: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && "scripts" in parsed) {
      const scripts = (parsed as { scripts?: unknown }).scripts;
      if (typeof scripts === "object" && scripts !== null) {
        return Object.fromEntries(
          Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      }
    }
    return {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to parse package.json: ${(error as Error).message}`, { cause: error });
  }
}

function renderMarkdownReport(report: ReadinessReport): string {
  const rows = report.findings
    .map((finding) => {
      const citedFiles = finding.citations?.length
        ? ` ${finding.citations.map((citation) => `\`${citation.file}\``).join(" ")}`
        : "";
      return `| ${finding.status === "pass" ? "PASS" : finding.status.toUpperCase()} | ${finding.title} | ${finding.recommendation}${citedFiles} |`;
    })
    .join("\n");
  return `# AI Readiness Report

**Score:** ${report.score}/100
**Generated:** ${report.generatedAt}
**Files scanned:** ${report.summary.filesScanned}

| Status | Area | Next action |
| --- | --- | --- |
${rows}

Generated by [Loreline](https://github.com/tysoncung/loreline).
`;
}
