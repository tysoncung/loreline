import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { analyzeHistory, decodeQuotedPath } from "../src/history.js";

const execFile = promisify(execFileCallback);

async function initRepo(root: string): Promise<void> {
  await execFile("git", ["init"], { cwd: root });
}

async function commitFile(
  root: string,
  relativeFile: string,
  content: string,
  author: { name: string; email: string },
  isoDate: string,
): Promise<void> {
  const absolute = path.join(root, relativeFile);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  await execFile("git", ["add", relativeFile], { cwd: root });
  await execFile(
    "git",
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-m",
      `update ${relativeFile}`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_DATE: isoDate,
      },
    },
  );
}

test("analyzeHistory reports area ownership from real git history and excludes bots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-"));
  try {
    await initRepo(root);

    for (let index = 0; index < 6; index += 1) {
      await commitFile(
        root,
        `alpha/file-${index}.txt`,
        `alpha change ${index}\n`,
        { name: "A", email: "a@x.test" },
        `2026-01-0${index + 1}T00:00:00Z`,
      );
    }
    await commitFile(
      root,
      "beta/file.txt",
      "beta change\n",
      { name: "B", email: "b@x.test" },
      "2026-01-07T00:00:00Z",
    );
    await commitFile(
      root,
      "gamma/generated.txt",
      "bot change\n",
      { name: "dep-bot[bot]", email: "bot@x.test" },
      "2026-01-08T00:00:00Z",
    );

    const insights = await analyzeHistory(root);

    assert.equal(insights.available, true);
    assert.equal(insights.analyzedCommits, 8);
    assert.ok(insights.methodology.length > 0);

    const areaNames = insights.areas.map((area) => area.area);
    assert.ok(areaNames.includes("alpha"));
    assert.ok(areaNames.includes("beta"));
    assert.ok(!areaNames.includes("gamma"), "bot-only area must be excluded entirely");

    const alpha = insights.areas.find((area) => area.area === "alpha");
    assert.equal(alpha?.commits, 6);
    assert.equal(alpha?.topShare, 1);
    assert.deepEqual(
      alpha?.contributors.map((contributor) => contributor.name),
      ["A"],
    );
    const alphaShareSum = alpha?.contributors.reduce((sum, contributor) => sum + contributor.share, 0);
    assert.equal(alphaShareSum, 1);

    const beta = insights.areas.find((area) => area.area === "beta");
    assert.equal(beta?.commits, 1);
    assert.equal(beta?.topShare, 1);
    const betaShareSum = beta?.contributors.reduce((sum, contributor) => sum + contributor.share, 0);
    assert.equal(betaShareSum, 1);

    // Areas are sorted by commits descending.
    assert.equal(insights.areas[0]?.area, "alpha");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyzeHistory excludes identities passed via options, case-insensitively", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-"));
  try {
    await initRepo(root);
    for (let index = 0; index < 5; index += 1) {
      await commitFile(
        root,
        `alpha/file-${index}.txt`,
        `alpha change ${index}\n`,
        { name: "A", email: "a@x.test" },
        `2026-01-0${index + 1}T00:00:00Z`,
      );
    }
    await commitFile(
      root,
      "alpha/other.txt",
      "alpha change from C\n",
      { name: "C", email: "c@x.test" },
      "2026-01-06T00:00:00Z",
    );

    const insights = await analyzeHistory(root, { excludeIdentities: ["a"] });
    const alpha = insights.areas.find((area) => area.area === "alpha");
    assert.deepEqual(
      alpha?.contributors.map((contributor) => contributor.name),
      ["C"],
    );
    assert.equal(alpha?.commits, 1);
    assert.deepEqual(insights.excludedIdentities, ["a"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyzeHistory returns available false silently for a non-git directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-nongit-"));
  try {
    const insights = await analyzeHistory(root);
    assert.deepEqual(insights, {
      available: false,
      analyzedCommits: 0,
      excludedIdentities: [],
      methodology: insights.methodology,
      areas: [],
    });
    assert.ok(insights.methodology.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyzeHistory normalizes renamed paths to the new path when computing areas", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-rename-"));
  try {
    await initRepo(root);
    await commitFile(
      root,
      "alpha/old.txt",
      "content\n".repeat(20),
      { name: "A", email: "a@x.test" },
      "2026-01-01T00:00:00Z",
    );
    await mkdir(path.join(root, "beta"), { recursive: true });
    await execFile("git", ["mv", "alpha/old.txt", "beta/new.txt"], { cwd: root });
    await execFile(
      "git",
      ["-c", "user.name=A", "-c", "user.email=a@x.test", "commit", "-m", "rename"],
      {
        cwd: root,
        env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-02T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z" },
      },
    );

    const insights = await analyzeHistory(root);
    const areaNames = insights.areas.map((area) => area.area);
    assert.ok(areaNames.includes("beta"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyzeHistory computes a clean area name for a non-ASCII file path and merges its commit into the same area", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "loreline-history-unicode-"));
  try {
    await initRepo(root);
    await commitFile(
      root,
      "alpha/plain.txt",
      "plain\n",
      { name: "A", email: "a@x.test" },
      "2026-01-01T00:00:00Z",
    );
    await commitFile(
      root,
      "alpha/café-note.txt",
      "unicode filename\n",
      { name: "A", email: "a@x.test" },
      "2026-01-02T00:00:00Z",
    );

    const insights = await analyzeHistory(root);
    const areaNames = insights.areas.map((area) => area.area);

    // Exactly one "alpha" area: no bogus quote-mangled duplicate like `"alpha`.
    assert.deepEqual(areaNames, ["alpha"]);
    const alpha = insights.areas.find((area) => area.area === "alpha");
    assert.equal(alpha?.commits, 2);
    assert.equal(alpha?.contributors[0]?.commits, 2);
    assert.equal(alpha?.topShare, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decodeQuotedPath decodes octal byte escapes in a quoted UTF-8 path", () => {
  // "alpha/café.txt" with é (U+00E9) encoded as UTF-8 bytes 0xC3 0xA9, which
  // git's quoting renders as the octal escapes \303\251.
  const quoted = '"alpha/caf\\303\\251.txt"';
  assert.equal(decodeQuotedPath(quoted), "alpha/café.txt");
});

test("decodeQuotedPath decodes a literal double quote and backslash escape inside a quoted path", () => {
  const quoted = '"alpha/say \\"hi\\".txt"';
  assert.equal(decodeQuotedPath(quoted), 'alpha/say "hi".txt');

  const withBackslash = '"alpha\\\\legacy\\\\note.txt"';
  assert.equal(decodeQuotedPath(withBackslash), "alpha\\legacy\\note.txt");
});

test("decodeQuotedPath leaves an unquoted path unchanged", () => {
  assert.equal(decodeQuotedPath("alpha/plain.txt"), "alpha/plain.txt");
});
