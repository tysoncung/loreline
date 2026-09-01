import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeContext } from "../types.js";
import { validateArtifact } from "../validation.js";
import { markdownAdapter } from "./markdown.js";

export interface ImportedDocument {
  sourceId: string;
  adapter: string;
  path: string;
  title: string;
  content: string;
  author?: string;
  updatedAt?: string;
  link?: string;
  fingerprint: string;
  importedAt: string;
}

// .loreline/imports.json
export interface ImportLog {
  schemaVersion: 1;
  project: string;
  documents: ImportedDocument[];
}

export interface ImportPlan {
  newDocuments: string[];
  changed: string[];
  unchanged: string[];
  conflicts: Array<{ path: string; reason: string }>;
}

export interface KnowledgeAdapter {
  readonly name: string;
  plan(source: string, existing: ImportLog | undefined): Promise<ImportPlan>;
  import(source: string, existing: ImportLog | undefined): Promise<ImportedDocument[]>;
  export(
    context: KnowledgeContext,
    destination: string,
    options: { force: boolean },
  ): Promise<string[]>;
}

const ADAPTERS: Record<string, KnowledgeAdapter> = {
  markdown: markdownAdapter,
};

export function getAdapter(name: string): KnowledgeAdapter {
  const adapter = ADAPTERS[name];
  if (!adapter) {
    throw new Error(`unknown adapter "${name}" (available: ${Object.keys(ADAPTERS).join(", ")})`);
  }
  return adapter;
}

const IMPORTS_FILE = "imports.json";

// Reads .loreline/imports.json. Tolerant of the file not existing (no import
// log yet); an existing-but-invalid file throws with the validator's
// field-level error message rather than being silently ignored.
export async function loadImportLog(outputDirectory: string): Promise<ImportLog | undefined> {
  const importsPath = path.join(outputDirectory, IMPORTS_FILE);
  try {
    const value: unknown = JSON.parse(await readFile(importsPath, "utf8"));
    return await validateArtifact<ImportLog>("imports", value, importsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveImportLog(outputDirectory: string, log: ImportLog): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const importsPath = path.join(outputDirectory, IMPORTS_FILE);
  await validateArtifact<ImportLog>("imports", log, importsPath);
  const tempPath = `${importsPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(log, null, 2)}\n`);
  await rename(tempPath, importsPath);
  return importsPath;
}
