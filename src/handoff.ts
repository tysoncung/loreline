import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HistoryInsights } from "./history.js";
import type { KnowledgeContext, LorelineConfig, ReadinessReport, VerificationReport } from "./types.js";
import { validateArtifact } from "./validation.js";

export interface HandoffRisk {
  id: string;
  title: string;
  severity: number;
  factors: string[];
  recommendedTopics: string[];
  suggestedValidators: string[];
  area?: string;
}

export interface HandoffPlan {
  schemaVersion: 1;
  generatedAt: string;
  project: string;
  departing?: string;
  departureDate?: string;
  risks: HandoffRisk[];
  openQuestions: Array<{ question: string; sourceFile: string }>;
  verificationSummary?: { valid: boolean; issues: number };
  methodology?: string;
}

// Maps a readiness finding id to the interview category that would close the
// gap it describes. Mirrors src/interview.ts's private FINDING_QUESTIONS
// table (its `category` field per finding id): that table is not exported,
// so the same category strings are hardcoded here rather than redeclaring
// the whole question set.
const FINDING_CATEGORY: Record<string, string> = {
  "project-overview": "purpose",
  "ai-guidance": "workflow",
  ownership: "ownership",
  architecture: "architecture",
  decisions: "decisions",
  operations: "operations",
  verification: "verification",
  "knowledge-concentration": "ownership",
};

const CONCENTRATION_THRESHOLD = 0.8;
const QUALIFYING_AREA_COMMITS = 5;
const CONCENTRATION_BASE_SEVERITY = 15;
const KNOWLEDGE_REVIEW_SEVERITY = 10;
const VERIFICATION_ISSUE_SEVERITY = 10;
const DEPARTURE_SOON_SEVERITY = 10;
const DEPARTURE_SOON_DAYS = 30;
const MAX_RISKS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface BuildHandoffPlanOptions {
  config: LorelineConfig;
  outputDirectory: string;
  report?: ReadinessReport;
  history?: HistoryInsights;
  departing?: string;
  departureDate?: string;
  redactNames?: boolean;
  now?: Date;
}

export async function buildHandoffPlan(options: BuildHandoffPlanOptions): Promise<HandoffPlan> {
  const { config, outputDirectory } = options;
  const report = options.report ?? (await loadOptionalArtifact<ReadinessReport>("readiness", outputDirectory, "readiness.json"));
  if (!report) {
    throw new Error(
      `No readiness report found in ${outputDirectory}; run loreline scan first.`,
    );
  }

  // buildHandoffPlan never runs git itself: history comes from the report's
  // embedded v2 history, or from an insights object the caller (typically
  // the CLI, which can call analyzeHistory) already computed.
  const history = report.history ?? options.history;

  const verification = await loadOptionalArtifact<VerificationReport>(
    "verification",
    outputDirectory,
    "verification.json",
  );
  const context = await loadOptionalArtifact<KnowledgeContext>("context", outputDirectory, "context.json");

  let departureDays: number | undefined;
  if (options.departureDate !== undefined) {
    departureDays = daysUntil(options.departureDate, options.now ?? new Date());
  }

  const redact = options.redactNames === true;
  const aliasMap = new Map<string, string>();
  const alias = (name: string): string => {
    if (!redact) {
      return name;
    }
    let assigned = aliasMap.get(name);
    if (!assigned) {
      assigned = `Contributor ${aliasMap.size + 1}`;
      aliasMap.set(name, assigned);
    }
    return assigned;
  };

  const departingLower = options.departing?.toLowerCase();
  // Resolve the departing person's canonical (as-recorded) casing from
  // history so their alias matches the one assigned wherever their name
  // appears as a contributor, regardless of how --departing was typed.
  let departingCanonical = options.departing;
  if (departingLower !== undefined && history?.available) {
    outer: for (const area of history.areas) {
      for (const contributor of area.contributors) {
        if (contributor.name.toLowerCase() === departingLower) {
          departingCanonical = contributor.name;
          break outer;
        }
      }
    }
  }

  const risks: HandoffRisk[] = [];

  for (const finding of report.findings) {
    if (finding.status === "pass") {
      continue;
    }
    const severity = finding.status === "missing" ? finding.weight : finding.weight / 2;
    const category = FINDING_CATEGORY[finding.id];
    risks.push({
      id: finding.id,
      title: finding.title,
      severity,
      factors: [
        `The "${finding.title}" readiness finding is ${finding.status}, contributing ${severity} point(s) to this risk.`,
      ],
      recommendedTopics: category ? [category] : [],
      suggestedValidators: [config.project.owner],
    });
  }

  if (history?.available) {
    for (const area of history.areas) {
      if (!(area.topShare > CONCENTRATION_THRESHOLD && area.commits >= QUALIFYING_AREA_COMMITS)) {
        continue;
      }
      const top = area.contributors[0];
      const topName = top?.name ?? "an unidentified contributor";
      const topAlias = alias(topName);
      const isDeparting = top !== undefined && departingLower !== undefined && top.name.toLowerCase() === departingLower;
      const severity = CONCENTRATION_BASE_SEVERITY * (isDeparting ? 2 : 1);
      const pct = Math.round(area.topShare * 100);

      const factors = [
        `single-person dependency: ${topAlias} authored ${pct}% of ${area.commits} commits in ${area.area}.`,
      ];
      if (isDeparting) {
        factors.push(
          `${topAlias} is the named departing contributor for ${area.area}, doubling this concentration risk.`,
        );
      }

      const second = area.contributors[1];
      const suggestedValidators = second ? [alias(second.name)] : [config.project.owner];

      risks.push({
        id: `concentration-${area.area}`,
        title: `Knowledge concentration in ${area.area}`,
        severity,
        factors,
        recommendedTopics: ["ownership", area.area],
        suggestedValidators,
        area: area.area,
      });
    }
  }

  if (context) {
    // Boost every risk whose recommended topics cover a category with stale
    // or disputed knowledge, once per affected category (not once per
    // affected entry), naming the reviewer who last looked at it.
    const affectedCategories = new Map<string, string>();
    for (const entry of context.entries) {
      const review = entry.review;
      if (!review) {
        continue;
      }
      if ((review.stale || review.status === "disputed") && !affectedCategories.has(entry.category)) {
        affectedCategories.set(entry.category, review.owner);
      }
    }
    for (const [category, owner] of affectedCategories) {
      boostByCategory(
        risks,
        category,
        KNOWLEDGE_REVIEW_SEVERITY,
        `Stale or disputed knowledge review in the ${category} category (last reviewed by ${alias(owner)}).`,
      );
    }
  }

  if (verification) {
    const staleCitation = verification.issues.some(
      (issue) => /evidence changed/.test(issue.message) || /evidence missing/.test(issue.message),
    );
    if (staleCitation) {
      boostByCategory(
        risks,
        "verification",
        VERIFICATION_ISSUE_SEVERITY,
        "Cited evidence has changed or gone missing since the readiness scan.",
      );
    }
    if (!verification.valid) {
      boostByCategory(
        risks,
        "verification",
        VERIFICATION_ISSUE_SEVERITY,
        "The most recent knowledge verification run failed.",
      );
    }
  }

  if (departureDays !== undefined) {
    for (const risk of risks) {
      risk.factors.push(`days until departure: ${departureDays}`);
      if (departureDays < DEPARTURE_SOON_DAYS) {
        risk.severity += DEPARTURE_SOON_SEVERITY;
      }
    }
  }

  risks.sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));
  const cappedRisks = risks.slice(0, MAX_RISKS);

  const openQuestions = (context?.unresolved ?? []).map((item) => ({
    question: item.question,
    sourceFile: item.sourceFile,
  }));

  const verificationSummary = verification
    ? { valid: verification.valid, issues: verification.issues.length }
    : undefined;

  const methodology = history?.available ? history.methodology : undefined;

  return {
    schemaVersion: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    project: config.project.name,
    ...(departingCanonical !== undefined ? { departing: alias(departingCanonical) } : {}),
    ...(options.departureDate !== undefined ? { departureDate: options.departureDate } : {}),
    risks: cappedRisks,
    openQuestions,
    ...(verificationSummary ? { verificationSummary } : {}),
    ...(methodology ? { methodology } : {}),
  };
}

// Attaches a review-driven severity boost only to the finding-based risk
// whose FINDING_CATEGORY mapping matches `category` (at most one such risk
// per category in practice, since risk.id equals the finding id). A
// concentration risk's `recommendedTopics` always includes "ownership" as a
// recommendation to act on, not as a claim that the concentration itself
// was caused by a stale or disputed review, so concentration risks
// (identifiable by having `area` set) never receive this boost even when
// their topics happen to include the affected category. When no matching
// finding risk exists, the boost is skipped entirely: it never creates a
// risk of its own.
function boostByCategory(risks: HandoffRisk[], category: string, points: number, factor: string): void {
  for (const risk of risks) {
    if (risk.area === undefined && risk.recommendedTopics.includes(category)) {
      risk.severity += points;
      risk.factors.push(factor);
    }
  }
}

function daysUntil(dateOnly: string, now: Date): number {
  if (!isValidDateOnly(dateOnly)) {
    throw new Error(`--date must be a valid YYYY-MM-DD calendar date, got "${dateOnly}".`);
  }
  const target = Date.parse(`${dateOnly}T00:00:00.000Z`);
  return Math.ceil((target - now.getTime()) / DAY_MS);
}

// The regex alone accepts calendar-invalid dates like "2026-02-30": Date.parse
// silently rolls those over to a valid nearby date (e.g. 2026-03-02) instead
// of failing, so the round trip back through toISOString must reproduce the
// exact input to confirm it named a real calendar day.
function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return false;
  }
  const target = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(target)) {
    return false;
  }
  return new Date(target).toISOString().slice(0, 10) === value;
}

async function loadOptionalArtifact<T>(
  kind: "readiness" | "verification" | "context",
  outputDirectory: string,
  fileName: string,
): Promise<T | undefined> {
  const filePath = path.join(outputDirectory, fileName);
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return await validateArtifact<T>(kind, value, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeHandoffPlan(
  plan: HandoffPlan,
  outputDirectory: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, "handoff.json");
  const markdownPath = path.join(outputDirectory, "handoff.md");
  await validateArtifact<HandoffPlan>("handoff", plan, jsonPath);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(plan, null, 2)}\n`),
    writeFile(markdownPath, renderHandoffPlan(plan)),
  ]);
  return { jsonPath, markdownPath };
}

export function renderHandoffPlan(plan: HandoffPlan): string {
  const header = [
    `# Handoff Plan: ${plan.project}`,
    "",
    `**Generated:** ${plan.generatedAt}`,
  ];
  if (plan.departing !== undefined) {
    header.push(`**Departing:** ${plan.departing}`);
  }
  if (plan.departureDate !== undefined) {
    header.push(`**Departure date:** ${plan.departureDate}`);
  }

  const risksSection = [
    "## Risks",
    "",
    ...(plan.risks.length > 0
      ? plan.risks.flatMap((risk, index) => [
          `${index + 1}. **${risk.title}** (severity ${risk.severity})`,
          ...risk.factors.map((factor) => `   - ${factor}`),
          `   - Recommended topics: ${risk.recommendedTopics.length > 0 ? risk.recommendedTopics.join(", ") : "(none)"}`,
          `   - Suggested validators: ${risk.suggestedValidators.join(", ")}`,
        ])
      : ["No risks identified."]),
  ];

  const openQuestionsSection = [
    "## Open questions",
    "",
    ...(plan.openQuestions.length > 0
      ? plan.openQuestions.map((item) => `- ${item.question} (\`${item.sourceFile}\`)`)
      : ["No open questions."]),
  ];

  const verificationSection = [
    "## Verification",
    "",
    plan.verificationSummary
      ? `${plan.verificationSummary.valid ? "Valid" : "Invalid"}: ${plan.verificationSummary.issues} issue(s) recorded.`
      : "No verification report available.",
  ];

  const footer = plan.methodology
    ? ["", "---", "", `_Ownership analysis methodology: "${plan.methodology}"_`]
    : [];

  return [
    ...header,
    "",
    ...risksSection,
    "",
    ...openQuestionsSection,
    "",
    ...verificationSection,
    ...footer,
    "",
  ].join("\n");
}
