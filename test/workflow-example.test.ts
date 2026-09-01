import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

const workflowPath = path.join(
  import.meta.dirname,
  "..",
  "examples",
  "github-actions",
  "loreline.yml",
);

interface WorkflowStep {
  uses?: string;
  run?: string;
  [key: string]: unknown;
}

interface WorkflowJob {
  steps: WorkflowStep[];
  [key: string]: unknown;
}

interface Workflow {
  permissions?: { contents?: string; [key: string]: unknown };
  jobs: Record<string, WorkflowJob>;
  [key: string]: unknown;
}

async function loadWorkflow(): Promise<{ raw: string; parsed: Workflow }> {
  const raw = await readFile(workflowPath, "utf8");
  const parsed = YAML.parse(raw) as Workflow;
  return { raw, parsed };
}

function allSteps(workflow: Workflow): WorkflowStep[] {
  return Object.values(workflow.jobs).flatMap((job) => job.steps);
}

test("example workflow parses cleanly", async () => {
  const { parsed } = await loadWorkflow();
  assert.ok(parsed.jobs && Object.keys(parsed.jobs).length > 0);
});

test("example workflow restricts permissions to read-only contents", async () => {
  const { parsed } = await loadWorkflow();
  assert.equal(parsed.permissions?.contents, "read");
});

test("every uses: value pins a version tag", async () => {
  const { parsed } = await loadWorkflow();
  const steps = allSteps(parsed);
  const usesSteps = steps.filter((step) => step.uses !== undefined);
  assert.ok(usesSteps.length > 0, "expected at least one uses: step");
  for (const step of usesSteps) {
    assert.match(step.uses as string, /@v/, `${step.uses} must pin a version tag`);
  }
});

test("every loreline invocation pins an exact version", async () => {
  const { raw } = await loadWorkflow();
  const invocations = raw.match(/npx @tysoncung\/loreline\S*/g) ?? [];
  assert.ok(invocations.length > 0, "expected at least one loreline invocation");
  for (const invocation of invocations) {
    assert.match(
      invocation,
      /^npx @tysoncung\/loreline@\d+\.\d+\.\d+$/,
      `${invocation} must pin an exact @x.y.z version`,
    );
  }
});

test("no step references secrets. outside of comments", async () => {
  const { raw } = await loadWorkflow();
  const activeLines = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"));
  for (const line of activeLines) {
    assert.doesNotMatch(line, /secrets\./, `active line references secrets.: ${line}`);
  }
});
