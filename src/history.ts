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
const COMMIT_HEADER_PATTERN = /^[0-9a-f]{7,40}\x1f/;
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
      current.files.push(normalizeRenamedPath(numstatMatch[1] ?? ""));
    }
  }

  return commits;
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
