import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { LorelineConfig } from "../src/types.js";
import { validateArtifact } from "../src/validation.js";

const fixtures = path.join(import.meta.dirname, "fixtures", "schema");

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

test("rejects unsupported schema versions", async () => {
  const value: unknown = JSON.parse(
    await readFile(path.join(fixtures, "valid-config.json"), "utf8"),
  );
  assert.ok(typeof value === "object" && value !== null);
  (value as { schemaVersion: number }).schemaVersion = 2;

  await assert.rejects(
    validateArtifact("config", value, "future-config.json"),
    /\/schemaVersion: must be equal to constant/,
  );
});
