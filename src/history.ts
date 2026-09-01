import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface AreaOwnership {
  area: string;
  commits: number;
  lastChangeAt: string | null;
  contributors: Array<{ name: string; commits: number; share: number; lastCommitAt: string }>;
  topShare: number;
}

export interface HistoryInsights {
  available: boolean;
  analyzedCommits: number;
  excludedIdentities: string[];
  methodology: string;
  areas: AreaOwnership[];
}

export const METHODOLOGY =
  "Counts each commit once per area (the first path segment of files it touched, or \"(root)\" " +
  "for files at the repository root) per contributor, from up to the most recent commits analyzed. " +
  "This is a familiarity signal derived from commit-touch frequency, not a measure of code ownership, " +
  "current expertise, or contribution quality, and it excludes bot identities and any configured exclusions.";

const RECORD_SEPARATOR = "\x1f";
// 7-64 hex chars covers abbreviated hashes through full SHA-256 object ids.
const COMMIT_HEADER_PATTERN = /^[0-9a-f]{7,64}\x1f/;
const NUMSTAT_LINE_PATTERN = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/;
const BOT_IDENTITY_PATTERN = /\[bot\]$/i;

interface ParsedCommit {
  hash: string;
  author: string;
  date: string;
  files: string[];
}

export async function analyzeHistory(
  root: string,
  options?: { excludeIdentities?: string[]; maxCommits?: number },
): Promise<HistoryInsights> {
  const excludeIdentities = options?.excludeIdentities ?? [];
  const maxCommits = options?.maxCommits ?? 2000;

  const unavailable = (): HistoryInsights => ({
    available: false,
    analyzedCommits: 0,
    excludedIdentities: [...excludeIdentities],
    methodology: METHODOLOGY,
    areas: [],
  });

  let stdout: string;
  try {
    const result = await execFile(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "log",
        "--numstat",
        "--no-merges",
        "--date=iso-strict",
        `--pretty=format:%H${RECORD_SEPARATOR}%an${RECORD_SEPARATOR}%aI`,
        "-n",
        String(maxCommits),
      ],
      { cwd: root, maxBuffer: 1024 * 1024 * 64 },
    );
    stdout = result.stdout;
  } catch {
    return unavailable();
  }

  const commits = parseLog(stdout);
  const excludedLower = new Set(excludeIdentities.map((name) => name.toLowerCase()));
  const isExcluded = (author: string): boolean =>
    BOT_IDENTITY_PATTERN.test(author) || excludedLower.has(author.toLowerCase());

  const areaMap = new Map<
    string,
    {
      lastChangeAt: string | null;
      contributors: Map<string, { commits: number; lastCommitAt: string }>;
    }
  >();

  for (const commit of commits) {
    if (isExcluded(commit.author)) {
      continue;
    }
    const areasTouched = new Set(commit.files.map(areaOf));
    for (const area of areasTouched) {
      let entry = areaMap.get(area);
      if (!entry) {
        entry = { lastChangeAt: null, contributors: new Map() };
        areaMap.set(area, entry);
      }
      if (isNewer(commit.date, entry.lastChangeAt)) {
        entry.lastChangeAt = commit.date;
      }
      const contributor = entry.contributors.get(commit.author);
      if (contributor) {
        contributor.commits += 1;
        if (isNewer(commit.date, contributor.lastCommitAt)) {
          contributor.lastCommitAt = commit.date;
        }
      } else {
        entry.contributors.set(commit.author, { commits: 1, lastCommitAt: commit.date });
      }
    }
  }

  const areas: AreaOwnership[] = [...areaMap.entries()].map(([area, entry]) => {
    const contributors = [...entry.contributors.entries()]
      .map(([name, contributor]) => ({ name, commits: contributor.commits, lastCommitAt: contributor.lastCommitAt }))
      .sort((a, b) => b.commits - a.commits);
    const totalCommits = contributors.reduce((sum, contributor) => sum + contributor.commits, 0);
    const withShare = contributors.map((contributor) => ({
      ...contributor,
      share: totalCommits === 0 ? 0 : contributor.commits / totalCommits,
    }));
    const topShare = withShare.reduce((max, contributor) => Math.max(max, contributor.share), 0);
    return {
      area,
      commits: totalCommits,
      lastChangeAt: entry.lastChangeAt,
      contributors: withShare,
      topShare,
    };
  });
  areas.sort((a, b) => b.commits - a.commits);

  return {
    available: true,
    analyzedCommits: commits.length,
    excludedIdentities: [...excludeIdentities],
    methodology: METHODOLOGY,
    areas,
  };
}

function isNewer(candidate: string, current: string | null): boolean {
  if (current === null) {
    return true;
  }
  return Date.parse(candidate) > Date.parse(current);
}

function areaOf(filePath: string): string {
  const separatorIndex = filePath.indexOf("/");
  return separatorIndex === -1 ? "(root)" : filePath.slice(0, separatorIndex);
}

function parseLog(stdout: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | undefined;

  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    if (COMMIT_HEADER_PATTERN.test(line)) {
      const [hash, author, date] = line.split(RECORD_SEPARATOR);
      current = { hash: hash ?? "", author: author ?? "", date: date ?? "", files: [] };
      commits.push(current);
      continue;
    }
    const numstatMatch = NUMSTAT_LINE_PATTERN.exec(line);
    if (numstatMatch && current) {
      current.files.push(normalizeRenamedPath(decodeQuotedPath(numstatMatch[1] ?? "")));
    }
  }

  return commits;
}

// Even with core.quotePath=false (set above), git still wraps a path in
// double quotes and C-style-escapes it when the path itself contains a
// literal double quote, backslash, or control character. Decoding must
// happen before rename resolution, since a quoted rename line quotes the
// whole "old => new" (or "{old => new}") string, braces and arrow included.
export function decodeQuotedPath(rawPath: string): string {
  if (!(rawPath.length >= 2 && rawPath.startsWith('"') && rawPath.endsWith('"'))) {
    return rawPath;
  }
  const inner = rawPath.slice(1, -1);
  const simpleEscapes: Record<string, number> = {
    "\\": 0x5c,
    '"': 0x22,
    t: 0x09,
    n: 0x0a,
    r: 0x0d,
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    v: 0x0b,
  };
  const chunks: Buffer[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char !== "\\") {
      chunks.push(Buffer.from(char ?? "", "utf8"));
      continue;
    }
    const next = inner[i + 1];
    if (next !== undefined && next in simpleEscapes) {
      chunks.push(Buffer.from([simpleEscapes[next] as number]));
      i += 1;
      continue;
    }
    const octalMatch = /^[0-7]{1,3}/.exec(inner.slice(i + 1, i + 4));
    if (octalMatch) {
      chunks.push(Buffer.from([Number.parseInt(octalMatch[0], 8) & 0xff]));
      i += octalMatch[0].length;
      continue;
    }
    // Unrecognized escape sequence: keep the backslash literally.
    chunks.push(Buffer.from("\\", "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Numstat rename lines come in two shapes: a bare "old => new" when the
// paths share no common prefix/suffix, or "common/{old => new}/tail" when
// they do. Both describe a single file; only the new path matters for area
// attribution.
function normalizeRenamedPath(rawPath: string): string {
  const braceMatch = /^(.*)\{.* => (.*)\}(.*)$/.exec(rawPath);
  if (braceMatch) {
    const [, prefix, newPart, suffix] = braceMatch;
    return `${prefix ?? ""}${newPart ?? ""}${suffix ?? ""}`.replace(/\/{2,}/g, "/");
  }
  const arrowMatch = /^(.*) => (.*)$/.exec(rawPath);
  if (arrowMatch) {
    return arrowMatch[2] ?? rawPath;
  }
  return rawPath;
}
