import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface Citation {
  file: string;
  startLine?: number;
  endLine?: number;
  fingerprint: string;
  kind: "evidence" | "inference";
}

export type CitationState = "intact" | "changed" | "missing";

export async function citeFile(root: string, file: string): Promise<Citation> {
  const relative = toRelative(root, file);
  const contents = await readFile(path.join(root, relative));
  return {
    file: relative,
    fingerprint: fingerprint(contents),
    kind: "evidence",
  };
}

export async function checkCitation(root: string, citation: Citation): Promise<CitationState> {
  let contents: Buffer;
  try {
    contents = await readFile(path.join(root, citation.file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  return fingerprint(contents) === citation.fingerprint ? "intact" : "changed";
}

function fingerprint(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function toRelative(root: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(root, file) : file;
  return relative.split(path.sep).join("/");
}
