import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding, LorelineConfig, ReadinessReport } from "./types.js";
import { validateArtifact } from "./validation.js";

const DOCUMENT_PATTERN = /\.(?:md|mdx|txt|rst|adoc)$/i;

interface RepositoryInventory {
  files: string[];
  documents: string[];
  packageScripts: Record<string, string>;
}

export async function scanRepository(root: string, config: LorelineConfig): Promise<ReadinessReport> {
  const inventory = await inventoryRepository(root, config);
  const findings = buildFindings(inventory);
  const totalWeight = findings.reduce((sum, finding) => sum + finding.weight, 0);
  const earnedWeight = findings.reduce((sum, finding) => {
    const multiplier = finding.status === "pass" ? 1 : finding.status === "partial" ? 0.5 : 0;
    return sum + finding.weight * multiplier;
  }, 0);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    score: Math.round((earnedWeight / totalWeight) * 100),
    summary: {
      passed: findings.filter((finding) => finding.status === "pass").length,
      partial: findings.filter((finding) => finding.status === "partial").length,
      missing: findings.filter((finding) => finding.status === "missing").length,
      filesScanned: inventory.files.length,
    },
    findings,
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

async function inventoryRepository(root: string, config: LorelineConfig): Promise<RepositoryInventory> {
  const files: string[] = [];
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
        files.push(relative);
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
    .map(
      (finding) =>
        `| ${finding.status === "pass" ? "PASS" : finding.status.toUpperCase()} | ${finding.title} | ${finding.recommendation} |`,
    )
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
