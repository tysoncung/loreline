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

test("routes to the v1 schema for every existing artifact kind", () => {
  for (const kind of existingKinds) {
    assert.deepEqual(SUPPORTED_VERSIONS[kind], [1]);
    assert.equal(LATEST_VERSION[kind], 1);
  }
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
