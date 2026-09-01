import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface ScanScope {
  include: string[];
  exclude: string[];
}

export interface InterviewScope {
  categories?: string[];
  findings?: string[];
}

const REGEXP_SPECIAL = /[.+^${}()|[\]\\]/;

// Converts a glob pattern into an anchored RegExp. Supports "**" (crosses
// path separators, including zero directories), "*" and "?" (never cross a
// path separator). Every other character is matched literally.
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 3;
      } else {
        source += ".*";
        index += 2;
      }
    } else if (char === "*") {
      source += "[^/]*";
      index += 1;
    } else if (char === "?") {
      source += "[^/]";
      index += 1;
    } else {
      source += REGEXP_SPECIAL.test(char as string) ? `\\${char}` : char;
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

// A path is in scope when it matches at least one include pattern (or no
// include patterns were given, meaning everything is included) and does not
// match any exclude pattern. Exclude always wins over include.
export function inScope(relativePath: string, scope: ScanScope): boolean {
  const included =
    scope.include.length === 0 ||
    scope.include.some((pattern) => globToRegExp(pattern).test(relativePath));
  if (!included) {
    return false;
  }
  return !scope.exclude.some((pattern) => globToRegExp(pattern).test(relativePath));
}

// Minimal interactive picker: prints a numbered list on a TTY and reads a
// comma-separated selection. Empty input selects everything. Callers are
// responsible for only invoking this when stdin is a TTY.
export async function selectInteractively(
  title: string,
  items: Array<{ id: string; label: string }>,
): Promise<string[]> {
  console.log(`\n${title}`);
  items.forEach((item, position) => {
    console.log(`  ${position + 1}. ${item.label}`);
  });

  const terminal = createInterface({ input, output });
  try {
    const raw = (await terminal.question("Select (comma-separated numbers, empty = all): ")).trim();
    if (!raw) {
      return items.map((item) => item.id);
    }
    const selected = new Set<string>();
    for (const part of raw.split(",")) {
      const position = Number(part.trim());
      if (Number.isInteger(position) && position >= 1 && position <= items.length) {
        selected.add(items[position - 1]!.id);
      }
    }
    return items.filter((item) => selected.has(item.id)).map((item) => item.id);
  } finally {
    terminal.close();
  }
}
