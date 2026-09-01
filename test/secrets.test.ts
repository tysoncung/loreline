import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { redactSecrets, scanTextForSecrets } from "../src/secrets.js";
import {
  approvedPayload,
  buildTransmissionPreview,
  renderTransmissionPreview,
  type TransmissionPreview,
} from "../src/transmit.js";

// ---------------------------------------------------------------------------
// Planted fixtures are built at test runtime by concatenation so nothing that
// looks like a real, working credential is ever committed to the repository.
// ---------------------------------------------------------------------------

function highEntropyRun(): string {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  // 64 distinct characters used exactly once: Shannon entropy = log2(64) = 6 bits/char.
  return upper + lower + digits + "+/";
}

function assertNoPlantedValue(haystack: string, planted: string): void {
  assert.equal(haystack.includes(planted), false, `planted value leaked: ${planted}`);
}

// ---------------------------------------------------------------------------
// scanTextForSecrets: one test per rule
// ---------------------------------------------------------------------------

test("scanTextForSecrets flags a PEM private key block as high severity", () => {
  const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n";
  const findings = scanTextForSecrets(text, "config/deploy.txt");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "private-key");
  assert.equal(findings[0]?.severity, "high");
  assert.equal(findings[0]?.line, 1);
  assert.equal(findings[0]?.preview.endsWith("...private-key"), true);
});

test("scanTextForSecrets flags an AWS access key id as high severity", () => {
  const planted = "AKIA" + "1234567890ABCDEF";
  const findings = scanTextForSecrets(`aws_access_key_id = ${planted}\n`, "notes.txt");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "aws-access-key-id");
  assert.equal(findings[0]?.severity, "high");
  assertNoPlantedValue(findings[0]?.preview ?? "", planted);
});

test("scanTextForSecrets flags a GitHub personal token as high severity", () => {
  const planted = "ghp_" + "x".repeat(40);
  const findings = scanTextForSecrets(`export GH_TOKEN=${planted}\n`, "notes.txt");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "github-token");
  assert.equal(findings[0]?.severity, "high");
  assertNoPlantedValue(findings[0]?.preview ?? "", planted);
});

test("scanTextForSecrets flags a fine-grained GitHub PAT as high severity", () => {
  const planted = "github_pat_" + "y".repeat(30);
  const findings = scanTextForSecrets(`token=${planted}\n`, "notes.txt");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "github-pat");
  assert.equal(findings[0]?.severity, "high");
});

test("scanTextForSecrets flags a Slack token as high severity", () => {
  const planted = "xoxb-" + "1".repeat(15);
  const findings = scanTextForSecrets(`SLACK_TOKEN=${planted}\n`, "notes.txt");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "slack-token");
  assert.equal(findings[0]?.severity, "high");
});

test("scanTextForSecrets flags a Stripe live key as high severity", () => {
  const planted = "sk_live_" + "z".repeat(20);
  const findings = scanTextForSecrets(`stripe key: ${planted}\n`, "notes.txt");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "stripe-live-key");
  assert.equal(findings[0]?.severity, "high");
});

test("scanTextForSecrets flags a quoted generic assignment as high severity", () => {
  const planted = "s" + "3".repeat(13);
  const findings = scanTextForSecrets(`password = "${planted}"\n`, "notes.txt");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "generic-assignment");
  assert.equal(findings[0]?.severity, "high");
  assertNoPlantedValue(findings[0]?.preview ?? "", planted);
});

test("scanTextForSecrets does not flag an unquoted generic assignment", () => {
  const planted = "s" + "3".repeat(13);
  const findings = scanTextForSecrets(`password = ${planted}\n`, "notes.txt");

  assert.equal(findings.some((finding) => finding.rule === "generic-assignment"), false);
});

test("scanTextForSecrets flags a JWT-shaped string as medium severity", () => {
  const planted = `eyJ${"A".repeat(20)}.${"B".repeat(20)}.${"C".repeat(10)}`;
  const findings = scanTextForSecrets(`Authorization: Bearer ${planted}\n`, "notes.txt");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "jwt");
  assert.equal(findings[0]?.severity, "medium");
});

test("scanTextForSecrets flags a long high-entropy run as medium severity", () => {
  const planted = highEntropyRun();
  const findings = scanTextForSecrets(`blob=${planted}\n`, "notes.txt");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.rule, "high-entropy");
  assert.equal(findings[0]?.severity, "medium");
});

test("scanTextForSecrets flags any .env, .pem, or id_rsa file as a single sensitive-file finding", () => {
  const planted = "ghp_" + "x".repeat(40);
  for (const file of [".env", ".env.production", "server.pem", "id_rsa", "keys/id_rsa.backup"]) {
    const findings = scanTextForSecrets(`API_TOKEN=${planted}\n`, file);
    assert.equal(findings.length, 1, `expected exactly one finding for ${file}`);
    assert.equal(findings[0]?.rule, "sensitive-file");
    assert.equal(findings[0]?.severity, "high");
    assert.equal(findings[0]?.line, 0);
    assert.equal(findings[0]?.preview, path.basename(file));
    assertNoPlantedValue(findings[0]?.preview ?? "", planted);
  }
});

// ---------------------------------------------------------------------------
// False positives
// ---------------------------------------------------------------------------

test("scanTextForSecrets treats a sha256 hex digest in lockfile-like text as not-high", () => {
  const hexDigits = "0123456789abcdef";
  let digest = "";
  for (let i = 0; i < 64; i++) {
    digest += hexDigits[(i * 7 + 3) % hexDigits.length];
  }
  const text = `"resolved": "sha256:${digest}"\n`;
  const findings = scanTextForSecrets(text, "package-lock.json");

  assert.equal(
    findings.some((finding) => finding.severity === "high"),
    false,
  );
});

test("scanTextForSecrets returns no findings for ordinary prose", () => {
  const text = "This document explains how to onboard a new engineer to the payments team.\n" +
    "Please read the runbook before your first on-call shift and ask questions in the channel.\n";
  const findings = scanTextForSecrets(text, "onboarding.md");

  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

test("redactSecrets removes high-confidence values and leaves medium matches untouched", () => {
  const highPlanted = "ghp_" + "x".repeat(40);
  const jwtPlanted = `eyJ${"A".repeat(20)}.${"B".repeat(20)}.${"C".repeat(10)}`;
  const text = `token=${highPlanted}\njwt=${jwtPlanted}\n`;

  const redacted = redactSecrets(text);

  assertNoPlantedValue(redacted, highPlanted);
  assert.equal(redacted.includes("[REDACTED:github-token]"), true);
  assert.equal(redacted.includes(jwtPlanted), true);
});

// ---------------------------------------------------------------------------
// buildTransmissionPreview / renderTransmissionPreview / approvedPayload
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-secrets-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true });
  }
}

test("buildTransmissionPreview builds items in deterministic sorted order regardless of input order", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "b.txt"), "clean content\n");
    await writeFile(path.join(root, "a.txt"), "also clean\n");
    await writeFile(path.join(root, "c.txt"), "still clean\n");

    const preview = await buildTransmissionPreview(root, ["c.txt", "a.txt", "b.txt"]);

    assert.deepEqual(
      preview.items.map((item) => item.file),
      ["a.txt", "b.txt", "c.txt"],
    );
    assert.equal(preview.blocked, false);
    assert.equal(preview.highFindings, 0);
  });
});

test("buildTransmissionPreview blocks when a file has a high-confidence finding, and reflects it after exclusion", async () => {
  await withTempDir(async (root) => {
    const planted = "ghp_" + "x".repeat(40);
    await writeFile(path.join(root, "clean.txt"), "nothing to see here\n");
    await writeFile(path.join(root, "leaky.txt"), `token=${planted}\n`);

    const preview = await buildTransmissionPreview(root, ["leaky.txt", "clean.txt"]);

    assert.equal(preview.blocked, true);
    assert.equal(preview.highFindings, 1);
    assert.throws(() => approvedPayload(preview), /transmission blocked: 1 high-confidence secret finding/);

    // Simulate a caller excluding the offending item, then recomputing the
    // derived blocked/highFindings state per the documented derivation:
    // blocked = any non-excluded item has a high finding; highFindings
    // counts high findings on non-excluded items.
    const excludedItems = preview.items.map((item) =>
      item.file === "leaky.txt" ? { ...item, excluded: true } : item,
    );
    const recomputedHighFindings = excludedItems
      .filter((item) => !item.excluded)
      .reduce(
        (sum, item) => sum + item.secretFindings.filter((finding) => finding.severity === "high").length,
        0,
      );
    const cleared: TransmissionPreview = {
      items: excludedItems,
      blocked: recomputedHighFindings > 0,
      highFindings: recomputedHighFindings,
    };

    assert.equal(cleared.blocked, false);
    assert.equal(cleared.highFindings, 0);

    const payload = approvedPayload(cleared);
    assert.deepEqual(
      payload.map((item) => item.file),
      ["clean.txt"],
    );
    for (const item of payload) {
      assertNoPlantedValue(item.excerpt, planted);
    }
  });
});

test("buildTransmissionPreview truncates excerpts but still scans the full content for secrets", async () => {
  await withTempDir(async (root) => {
    const planted = "ghp_" + "x".repeat(40);
    const padding = "x".repeat(50);
    const content = `${padding}\ntoken=${planted}\n`;
    await writeFile(path.join(root, "big.txt"), content);

    const preview = await buildTransmissionPreview(root, ["big.txt"], { maxExcerptBytes: 10 });
    const item = preview.items[0];

    assert.ok(item);
    assert.equal(item.excerpt.length <= 10, true);
    assert.equal(item.excerpt.includes(planted), false);
    assert.equal(item.bytes, Buffer.byteLength(content));
    assert.equal(
      item.secretFindings.some((finding) => finding.rule === "github-token"),
      true,
    );
    assert.equal(preview.blocked, true);
  });
});

test("buildTransmissionPreview throws a plain error naming a missing file", async () => {
  await withTempDir(async (root) => {
    await assert.rejects(
      () => buildTransmissionPreview(root, ["does-not-exist.txt"]),
      /does-not-exist\.txt/,
    );
  });
});

test("renderTransmissionPreview never includes planted secret values", async () => {
  await withTempDir(async (root) => {
    const planted = "ghp_" + "x".repeat(40);
    await writeFile(path.join(root, "leaky.txt"), `token=${planted}\n`);

    const preview = await buildTransmissionPreview(root, ["leaky.txt"]);
    const rendered = renderTransmissionPreview(preview);

    assertNoPlantedValue(rendered, planted);
    assert.equal(rendered.includes("leaky.txt"), true);
    assert.equal(rendered.includes("github-token"), true);
  });
});

test("approvedPayload throws while blocked and never leaks planted values in the thrown error", async () => {
  await withTempDir(async (root) => {
    const planted = "sk_live_" + "z".repeat(20);
    await writeFile(path.join(root, "leaky.txt"), `stripe=${planted}\n`);

    const preview = await buildTransmissionPreview(root, ["leaky.txt"]);

    try {
      approvedPayload(preview);
      assert.fail("expected approvedPayload to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /^transmission blocked: 1 high-confidence secret finding\(s\); redact or exclude them first$/);
      assertNoPlantedValue(message, planted);
    }
  });
});

test("approvedPayload redacts high-confidence values from excerpts of non-blocking items", async () => {
  await withTempDir(async (root) => {
    const planted = "s" + "3".repeat(13);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "notes.txt"), `password = "${planted}"\n`);

    const preview = await buildTransmissionPreview(root, ["notes.txt"]);
    // generic-assignment is a high-confidence rule, so this file blocks; the
    // test asserts the thrown state never leaks the value, and that a
    // redacted, non-blocked payload also never leaks it.
    assert.equal(preview.blocked, true);

    const cleared: TransmissionPreview = {
      items: preview.items,
      blocked: false,
      highFindings: 0,
    };
    const payload = approvedPayload(cleared);
    for (const item of payload) {
      assertNoPlantedValue(item.excerpt, planted);
    }
  });
});
