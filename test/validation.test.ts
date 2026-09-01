import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { LorelineConfig } from "../src/types.js";
import {
  type ArtifactKind,
  LATEST_VERSION,
  SUPPORTED_VERSIONS,
  validateArtifact,
} from "../src/validation.js";

const fixtures = path.join(import.meta.dirname, "fixtures", "schema");
const existingKinds: ArtifactKind[] = [
  "config",
  "readiness",
  "interview",
  "context",
  "verification",
];

// The smallest object each kind's v1 schema accepts (schemas are strict:
// additionalProperties is false and every listed field is required).
const minimalV1Fixtures: Record<ArtifactKind, Record<string, unknown>> = {
  config: {
    schemaVersion: 1,
    project: { name: "payments", owner: "platform-team" },
    scan: { include: ["**/*"], exclude: [], maxFiles: 10000 },
    output: { directory: ".loreline" },
  },
  readiness: {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    root: ".",
    score: 0,
    summary: { passed: 0, partial: 0, missing: 0, filesScanned: 0 },
    findings: [],
  },
  interview: {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    project: "payments",
    interviewee: "Alex",
    interviewer: "Loreline",
    sourceReport: ".loreline/readiness.json",
    answers: [],
    unanswered: [],
  },
  context: {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    project: "payments",
    owner: "platform-team",
    entries: [],
    unresolved: [],
    sources: [],
  },
  verification: {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    project: "payments",
    recordsChecked: 0,
    valid: true,
    issues: [],
  },
};

test("accepts a valid version 1 configuration fixture", async () => {
  const value: unknown = JSON.parse(
    await readFile(path.join(fixtures, "valid-config.json"), "utf8"),
  );
  const config = await validateArtifact<LorelineConfig>("config", value, "valid-config.json");
  assert.equal(config.project.name, "payments");
});

test("reports field-level errors for invalid artifacts", async () => {
  const value: unknown = JSON.parse(
    await readFile(path.join(fixtures, "invalid-interview.json"), "utf8"),
  );

  await assert.rejects(
    validateArtifact("interview", value, "invalid-interview.json"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unknown property "unexpected"/);
      assert.match(error.message, /\/generatedAt: must match format "date-time"/);
      assert.match(error.message, /\/project: must NOT have fewer than 1 characters/);
      return true;
    },
  );
});

test("routes to the v1 schema for every existing artifact kind", async () => {
  for (const kind of existingKinds) {
    if (kind === "readiness" || kind === "interview" || kind === "context") {
      // Readiness gained a v2 schema (evidence citations); interview gained a
      // v2 schema (scope); context gained a v2 schema (review metadata). All
      // three keep v1 supported.
      assert.deepEqual(SUPPORTED_VERSIONS[kind], [1, 2]);
      assert.equal(LATEST_VERSION[kind], 2);
    } else {
      assert.deepEqual(SUPPORTED_VERSIONS[kind], [1]);
      assert.equal(LATEST_VERSION[kind], 1);
    }

    const fixture = minimalV1Fixtures[kind];
    const result = await validateArtifact<Record<string, unknown>>(
      kind,
      fixture,
      `minimal-${kind}.json`,
    );
    assert.deepEqual(result, fixture);
  }
});

test("routes to the v2 schema for a readiness report with citations", async () => {
  const fixture = {
    schemaVersion: 2,
    generatedAt: "2026-01-01T00:00:00Z",
    root: ".",
    score: 0,
    summary: { passed: 0, partial: 0, missing: 0, filesScanned: 1 },
    findings: [
      {
        id: "project-overview",
        title: "Project overview",
        status: "pass",
        weight: 15,
        evidence: ["README.md"],
        recommendation: "Keep the README current.",
        citations: [
          {
            file: "README.md",
            fingerprint: "a".repeat(64),
            kind: "evidence",
          },
        ],
      },
    ],
  };

  const result = await validateArtifact<Record<string, unknown>>(
    "readiness",
    fixture,
    "minimal-readiness-v2.json",
  );
  assert.deepEqual(result, fixture);
});

test("rejects an unsupported schema version", async () => {
  const value: unknown = JSON.parse(
    await readFile(path.join(fixtures, "valid-config.json"), "utf8"),
  );
  assert.ok(typeof value === "object" && value !== null);
  (value as { schemaVersion: number }).schemaVersion = 99;

  await assert.rejects(
    validateArtifact("config", value, "future-config.json"),
    /unsupported schemaVersion 99 \(supported: 1\)/,
  );
});

test("rejects a missing schemaVersion", async () => {
  const value: unknown = JSON.parse(
    await readFile(path.join(fixtures, "valid-config.json"), "utf8"),
  );
  assert.ok(typeof value === "object" && value !== null);
  delete (value as { schemaVersion?: number }).schemaVersion;

  await assert.rejects(
    validateArtifact("config", value, "missing-version-config.json"),
    /unsupported schemaVersion undefined \(supported: 1\)/,
  );
});

test("rejects a non-integer schemaVersion", async () => {
  const value: unknown = JSON.parse(
    await readFile(path.join(fixtures, "valid-config.json"), "utf8"),
  );
  assert.ok(typeof value === "object" && value !== null);
  (value as { schemaVersion: unknown }).schemaVersion = 1.5;

  await assert.rejects(
    validateArtifact("config", value, "fractional-version-config.json"),
    /unsupported schemaVersion 1\.5 \(supported: 1\)/,
  );
});
