#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { plannedExportPaths } from "./adapters/markdown.js";
import { getAdapter, loadImportLog, saveImportLog, type ImportLog, type ImportPlan } from "./adapters/types.js";
import { compileWithAi, previewCategories } from "./ai/compiler.js";
import { initialize, loadConfig, loadRequiredConfig } from "./config.js";
import { analyzeHistory } from "./history.js";
import { conductInterview, writeInterview } from "./interview.js";
import {
  compileKnowledge,
  verifyKnowledge,
  writeVerificationReport,
} from "./knowledge.js";
import { scanDocuments } from "./docscan.js";
import { createProvider, resolveAiSettings } from "./providers/index.js";
import type { AiProvider } from "./providers/types.js";
import { applyReview } from "./review.js";
import { scanRepository, writeReport } from "./scanner.js";
import { selectInteractively, type InterviewScope } from "./scope.js";
import { approvedPayload, buildTransmissionPreview, renderTransmissionPreview } from "./transmit.js";
import type { KnowledgeContext, ReadinessReport } from "./types.js";
import { validateArtifact } from "./validation.js";

const VERSION = "0.2.0";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case "init":
      await initCommand(args);
      break;
    case "scan":
      await scanCommand(args);
      break;
    case "interview":
      await interviewCommand(args);
      break;
    case "compile":
      await compileCommand(args);
      break;
    case "verify":
      await verifyCommand(args);
      break;
    case "review":
      await reviewCommand(args);
      break;
    case "import":
      await importCommand(args);
      break;
    case "export":
      await exportCommand(args);
      break;
    default:
      throw new Error(`Unknown command "${command}". Run "loreline help" for usage.`);
  }

}

async function initCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { path: { type: "string", short: "p", default: "." } },
  });
  const root = path.resolve(values.path);
  const result = await initialize(root);
  console.log(result.created ? `Created ${result.configPath}` : `Already initialized: ${result.configPath}`);
}

async function scanCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      json: { type: "boolean", default: false },
      "fail-under": { type: "string" },
      include: { type: "string", multiple: true, default: [] },
      exclude: { type: "string", multiple: true, default: [] },
      "no-history": { type: "boolean", default: false },
      "exclude-identity": { type: "string", multiple: true, default: [] },
      mode: { type: "string", default: "repository" },
    },
  });
  if (values.mode !== "repository" && values.mode !== "documents") {
    throw new Error('--mode must be "repository" or "documents".');
  }

  const root = path.resolve(values.path);
  const config = await loadConfig(root);

  let report: ReadinessReport;
  if (values.mode === "documents") {
    // Document mode inspects a documentation collection rather than the
    // whole repository, so git history analysis (which characterizes
    // ownership across source files) does not apply and is skipped entirely.
    report = await scanDocuments(root, config);
  } else {
    const history = values["no-history"]
      ? undefined
      : await analyzeHistory(root, { excludeIdentities: values["exclude-identity"] });
    report = await scanRepository(
      root,
      config,
      {
        include: values.include,
        exclude: values.exclude,
      },
      history ? { history } : undefined,
    );
  }
  const output = await writeReport(report, path.join(root, config.output.directory));

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, output.markdownPath);
  }

  if (values["fail-under"] !== undefined) {
    const threshold = Number(values["fail-under"]);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      throw new Error("--fail-under must be a number from 0 to 100.");
    }
    if (report.score < threshold) {
      process.exitCode = 2;
    }
  }
}

async function interviewCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      interviewee: { type: "string" },
      interviewer: { type: "string", default: "Loreline" },
      answers: { type: "string" },
      resume: { type: "string" },
      revise: { type: "boolean", default: false },
      categories: { type: "string" },
      findings: { type: "string" },
      interactive: { type: "boolean", default: false },
      ai: { type: "boolean", default: false },
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "max-followups": { type: "string", default: "2" },
      yes: { type: "boolean", default: false },
    },
  });
  if (!values.interviewee && !values.resume) {
    throw new Error("--interviewee is required.");
  }

  const root = path.resolve(values.path);
  const config = await loadConfig(root);
  const reportPath = path.join(root, config.output.directory, "readiness.json");
  let report: ReadinessReport;
  try {
    const value: unknown = JSON.parse(await readFile(reportPath, "utf8"));
    report = await validateArtifact<ReadinessReport>("readiness", value, reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    report = await scanRepository(root, config);
    await writeReport(report, path.join(root, config.output.directory));
  }

  let findings = values.findings ? splitList(values.findings) : undefined;
  const categories = values.categories ? splitList(values.categories) : undefined;

  if (values.interactive) {
    if (!process.stdin.isTTY) {
      throw new Error("--interactive requires an interactive terminal (TTY) for stdin.");
    }
    const items = report.findings
      .filter((finding) => finding.status !== "pass")
      .map((finding) => ({ id: finding.id, label: `${finding.title} (${finding.status})` }));
    findings = await selectInteractively("Select findings to focus the interview on", items);
  }

  const scope: InterviewScope | undefined =
    categories || findings ? { ...(categories ? { categories } : {}), ...(findings ? { findings } : {}) } : undefined;

  let aiContext:
    | { provider: AiProvider; maxFollowups: number; evidence: Array<{ file: string; excerpt: string }> }
    | undefined;

  if (values.ai) {
    const maxFollowups = Number(values["max-followups"]);
    if (!Number.isInteger(maxFollowups) || maxFollowups < 0) {
      throw new Error("--max-followups must be a non-negative whole number.");
    }

    // Resolve settings and construct the provider first, so a
    // misconfigured provider fails fast before any evidence is read from
    // disk or previewed.
    const settings = resolveAiSettings(config, {
      ...(values.provider ? { provider: values.provider } : {}),
      ...(values.model ? { model: values.model } : {}),
      ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
    });
    const provider = createProvider(settings, process.env);

    const evidenceFiles = selectEvidenceFiles(report, scope, 8);
    const preview = await buildTransmissionPreview(root, evidenceFiles);
    console.log(renderTransmissionPreview(preview));

    if (preview.blocked) {
      throw new Error(
        "Transmission blocked by high-confidence secret finding(s); redact the affected content or exclude those files, then retry.",
      );
    }

    if (!values.yes) {
      if (!process.stdin.isTTY) {
        throw new Error(
          `Refusing to send context to ${settings.provider} without confirmation in a non-interactive terminal; pass --yes to proceed.`,
        );
      }
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      let confirmation: string;
      try {
        confirmation = await terminal.question(`Send this context to ${settings.provider}? [y/N] `);
      } finally {
        terminal.close();
      }
      if (confirmation.trim().toLowerCase() !== "y") {
        throw new Error("Aborted: transmission to the AI provider was not confirmed.");
      }
    }

    aiContext = {
      provider,
      maxFollowups,
      evidence: approvedPayload(preview),
    };
  }

  const record = await conductInterview({
    config,
    report,
    reportPath: path.relative(root, reportPath),
    ...(values.interviewee ? { interviewee: values.interviewee } : {}),
    interviewer: values.interviewer,
    outputDirectory: path.join(root, config.output.directory),
    ...(values.answers ? { answersPath: path.resolve(values.answers) } : {}),
    ...(values.resume ? { resume: values.resume } : {}),
    revise: values.revise,
    ...(scope ? { scope } : {}),
    ...(aiContext ? { ai: aiContext } : {}),
    onSessionStart: (session) => {
      console.log(`Session: ${session.sessionId} (resume with --resume ${session.sessionId})`);
    },
  });
  const output = await writeInterview(record, path.join(root, config.output.directory));
  console.log(`Captured ${record.answers.length} answers (${record.unanswered.length} unanswered).`);
  console.log(`Knowledge record: ${output.markdownPath}`);
}

async function compileCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      ai: { type: "boolean", default: false },
      provider: { type: "string" },
      model: { type: "string" },
      "base-url": { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  const root = path.resolve(values.path);
  const config = await loadRequiredConfig(root);
  const outputDirectory = path.join(root, config.output.directory);
  const result = await compileKnowledge(config, outputDirectory);
  console.log(`Compiled ${result.answers} answers from ${result.records} interview record(s).`);
  console.log(`AI context: ${result.markdownPath}`);
  console.log(`Structured context: ${result.jsonPath}`);

  if (!values.ai) {
    return;
  }

  // Resolve settings and construct the provider first, so a misconfigured
  // provider fails fast before any transmission preview is built.
  const settings = resolveAiSettings(config, {
    ...(values.provider ? { provider: values.provider } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
  });
  const provider = createProvider(settings, process.env);

  const contextValue: unknown = JSON.parse(await readFile(result.jsonPath, "utf8"));
  const context = await validateArtifact<KnowledgeContext>("context", contextValue, result.jsonPath);

  const preview = await previewCategories(context, outputDirectory);
  console.log(
    `Categories to send: ${
      preview.length > 0
        ? preview.map((item) => `${item.category} (${item.bytes} bytes)`).join(", ")
        : "(none)"
    }`,
  );

  if (!values.yes) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Refusing to send context to ${settings.provider} without confirmation in a non-interactive terminal; pass --yes to proceed.`,
      );
    }
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let confirmation: string;
    try {
      confirmation = await terminal.question(`Send this context to ${settings.provider}? [y/N] `);
    } finally {
      terminal.close();
    }
    if (confirmation.trim().toLowerCase() !== "y") {
      throw new Error("Aborted: transmission to the AI provider was not confirmed.");
    }
  }

  try {
    const proposals = await compileWithAi({ provider, context, outputDirectory });
    console.log(`Proposals: ${proposals.directory}`);
    for (const file of proposals.files) {
      console.log(`- ${path.relative(root, file)}`);
    }
    console.log(`Conflicts detected: ${proposals.conflicts}`);
  } catch (error) {
    throw new Error(
      `AI proposal generation failed; deterministic compile artifacts remain intact at ` +
        `${path.relative(root, result.markdownPath)} and ${path.relative(root, result.jsonPath)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function verifyCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      "max-age": { type: "string", default: "180" },
      json: { type: "boolean", default: false },
      "require-approval": { type: "boolean", default: false },
    },
  });
  const maxAgeDays = Number(values["max-age"]);
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) {
    throw new Error("--max-age must be a positive whole number of days.");
  }

  const root = path.resolve(values.path);
  const config = await loadRequiredConfig(root);
  const outputDirectory = path.join(root, config.output.directory);
  const report = await verifyKnowledge(config, outputDirectory, maxAgeDays, root, new Date(), {
    requireApproval: values["require-approval"],
  });
  const reportPath = await writeVerificationReport(report, outputDirectory);
  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.valid) {
    console.log(`Knowledge verification passed (${report.recordsChecked} record(s)).`);
    console.log(`Report: ${reportPath}`);
  } else {
    console.log(`Knowledge verification found ${report.issues.length} issue(s):`);
    for (const issue of report.issues) {
      console.log(`- ${issue.severity.toUpperCase()} ${issue.file}: ${issue.message}`);
    }
    console.log(`Report: ${reportPath}`);
  }
  if (!report.valid) {
    process.exitCode = 2;
  }
}

async function reviewCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      entry: { type: "string" },
      approve: { type: "boolean", default: false },
      dispute: { type: "boolean", default: false },
      owner: { type: "string" },
      reviewer: { type: "string", multiple: true, default: [] },
      reason: { type: "string" },
      due: { type: "string" },
    },
  });

  if (!values.entry) {
    throw new Error("--entry is required.");
  }
  if (values.approve === values.dispute) {
    throw new Error("Exactly one of --approve or --dispute is required.");
  }
  if (!values.owner) {
    throw new Error("--owner is required.");
  }

  const root = path.resolve(values.path);
  const config = await loadRequiredConfig(root);
  const outputDirectory = path.join(root, config.output.directory);
  const status = values.approve ? "approved" : "disputed";
  const result = await applyReview(outputDirectory, {
    entryId: values.entry,
    status,
    owner: values.owner,
    reviewers: values.reviewer,
    ...(values.reason ? { reason: values.reason } : {}),
    ...(values.due ? { dueDate: values.due } : {}),
  });

  console.log(
    `Recorded ${status} review for "${values.entry}" (${result.entriesReviewed} answer version(s)).`,
  );
  console.log(`Reviews: ${result.reviewsPath}`);
}

async function importCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      adapter: { type: "string" },
      source: { type: "string" },
      yes: { type: "boolean", default: false },
    },
  });
  if (!values.adapter) {
    throw new Error("--adapter is required.");
  }
  if (!values.source) {
    throw new Error("--source is required.");
  }

  const root = path.resolve(values.path);
  const config = await loadRequiredConfig(root);
  const outputDirectory = path.join(root, config.output.directory);
  const source = path.resolve(values.source);
  const adapter = getAdapter(values.adapter);
  const existing = await loadImportLog(outputDirectory);

  const plan = await adapter.plan(source, existing);
  printImportPlan(plan);

  if (!values.yes) {
    console.log("Dry run: no changes written. Pass --yes to import.");
    return;
  }

  const documents = await adapter.import(source, existing);
  const log: ImportLog = { schemaVersion: 1, project: config.project.name, documents };
  const importsPath = await saveImportLog(outputDirectory, log);
  console.log(
    `Imported ${plan.newDocuments.length} new and ${plan.changed.length} changed document(s); ` +
      `${plan.conflicts.length} conflict(s) left untouched.`,
  );
  console.log(`Import log: ${importsPath}`);
}

function printImportPlan(plan: ImportPlan): void {
  console.log(`New: ${plan.newDocuments.length}`);
  for (const file of plan.newDocuments) {
    console.log(`  + ${file}`);
  }
  console.log(`Changed: ${plan.changed.length}`);
  for (const file of plan.changed) {
    console.log(`  ~ ${file}`);
  }
  console.log(`Unchanged: ${plan.unchanged.length}`);
  console.log(`Conflicts: ${plan.conflicts.length}`);
  for (const conflict of plan.conflicts) {
    console.log(`  ! ${conflict.path}: ${conflict.reason}`);
  }
}

async function exportCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      path: { type: "string", short: "p", default: "." },
      adapter: { type: "string" },
      dest: { type: "string" },
      yes: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });
  if (!values.adapter) {
    throw new Error("--adapter is required.");
  }
  if (!values.dest) {
    throw new Error("--dest is required.");
  }

  const root = path.resolve(values.path);
  const config = await loadRequiredConfig(root);
  const outputDirectory = path.join(root, config.output.directory);
  const contextPath = path.join(outputDirectory, "context.json");
  let context: KnowledgeContext;
  try {
    const value: unknown = JSON.parse(await readFile(contextPath, "utf8"));
    context = await validateArtifact<KnowledgeContext>("context", value, contextPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No compiled knowledge context found at ${contextPath}. Run "loreline compile" first.`,
      );
    }
    throw error;
  }

  const destination = path.resolve(values.dest);
  const adapter = getAdapter(values.adapter);
  const planned = plannedExportPaths(context, destination);

  console.log(`Would write ${planned.length} file(s):`);
  for (const file of planned) {
    console.log(`  ${file}`);
  }

  if (!values.yes) {
    console.log("Dry run: no files written. Pass --yes to export.");
    return;
  }

  const files = await adapter.export(context, destination, { force: values.force });
  console.log(`Wrote ${files.length} file(s):`);
  for (const file of files) {
    console.log(`  ${file}`);
  }
}

// Picks up to `limit` distinct files cited by non-pass findings, honoring
// `scope.findings` when present (an explicit allow-list of finding ids).
// `scope.categories` has no direct analogue on a Finding (categories exist
// only on interview questions), so it does not further restrict evidence
// selection here.
function selectEvidenceFiles(
  report: ReadinessReport,
  scope: InterviewScope | undefined,
  limit: number,
): string[] {
  const findings = report.findings
    .filter((finding) => finding.status !== "pass")
    .filter((finding) => !scope?.findings || scope.findings.includes(finding.id));

  const files = new Set<string>();
  outer: for (const finding of findings) {
    for (const citation of finding.citations ?? []) {
      if (files.size >= limit) {
        break outer;
      }
      files.add(citation.file);
    }
  }
  return [...files];
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function printReport(report: ReadinessReport, outputPath: string): void {
  console.log(`\nLoreline AI readiness: ${report.score}/100\n`);
  for (const finding of report.findings) {
    const marker = finding.status === "pass" ? "✓" : finding.status === "partial" ? "~" : "✗";
    console.log(`${marker} ${finding.title}: ${finding.status}`);
  }
  console.log(`\nReport: ${outputPath}`);
}

function printHelp(): void {
  console.log(`Loreline ${VERSION}
Turn undocumented organizational knowledge into verified, AI-ready context.

Usage:
  loreline init [--path <directory>]
  loreline scan [--path <directory>] [--json] [--fail-under <score>] [--include <glob>] [--exclude <glob>]
  loreline scan [...] [--no-history] [--exclude-identity <name>]
  loreline scan [...] [--mode repository|documents]
  loreline interview --interviewee <name> [--path <directory>] [--answers <file>]
  loreline interview --resume <sessionId> [--revise] [--path <directory>] [--answers <file>]
  loreline interview [...] [--categories <list>] [--findings <list>] [--interactive]
  loreline interview [...] [--ai --provider <name> --model <name> --base-url <url>]
  loreline interview [...] [--ai [--max-followups <n>] [--yes]]
  loreline compile [--path <directory>]
  loreline compile [...] [--ai --provider <name> --model <name> --base-url <url>] [--yes]
  loreline verify [--path <directory>] [--max-age <days>] [--json] [--require-approval]
  loreline review --entry <id> --approve|--dispute --owner <name> [--reviewer <name> ...] [--reason <text>] [--due <YYYY-MM-DD>]
  loreline import --adapter markdown --source <directory> [--path <directory>] [--yes]
  loreline export --adapter markdown --dest <directory> [--path <directory>] [--yes] [--force]

Commands:
  init       Create loreline.yaml and the knowledge workspace
  scan       Assess a repository and write machine-readable readiness reports
             --mode repository (default) scans the whole project; --mode
             documents scans a documentation collection (README/index
             structure, ownership, freshness, linkage, terminology,
             operational docs) and skips git history analysis
  interview  Run an adaptive knowledge-transfer interview
             --ai adds AI-generated questions and follow-ups, after previewing
             and confirming what evidence would be sent to the provider
  compile    Compile interview records into reviewable AI context
             --ai additionally proposes documentation updates (AGENTS.md,
             ADRs, runbooks, ownership docs) under .loreline/proposals/,
             after previewing and confirming what would be sent
  verify     Check knowledge records for completeness and freshness
  review     Record human approval or dispute for a compiled knowledge entry
  import     Import external documents into .loreline/imports.json via an
             adapter (currently: markdown). Without --yes, prints the import
             plan (new/changed/unchanged/conflicts) and writes nothing.
  export     Export compiled context into a destination directory via an
             adapter (currently: markdown). Without --yes, prints the file
             list and writes nothing; --force allows overwriting existing
             files.
`);
}

main().catch((error: unknown) => {
  console.error(`Loreline error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
