import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { LorelineConfig } from "./types.js";

export const CONFIG_FILE = "loreline.yaml";

export function defaultConfig(root: string): LorelineConfig {
  return {
    schemaVersion: 1,
    project: {
      name: path.basename(root),
      owner: "TODO",
    },
    scan: {
      include: ["**/*"],
      exclude: [".git", "node_modules", "dist", "build", "coverage", ".loreline"],
      maxFiles: 10_000,
    },
    output: {
      directory: ".loreline",
    },
  };
}

export async function initialize(root: string): Promise<{ configPath: string; created: boolean }> {
  const configPath = path.join(root, CONFIG_FILE);
  try {
    await access(configPath);
    return { configPath, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const config = defaultConfig(root);
  await writeFile(configPath, YAML.stringify(config), { flag: "wx" });
  await mkdir(path.join(root, config.output.directory, "interviews"), { recursive: true });
  return { configPath, created: true };
}

export async function loadConfig(root: string): Promise<LorelineConfig> {
  const configPath = path.join(root, CONFIG_FILE);
  try {
    const parsed: unknown = YAML.parse(await readFile(configPath, "utf8"));
    return validateConfig(parsed, configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig(root);
    }
    throw error;
  }
}

function validateConfig(value: unknown, configPath: string): LorelineConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    !("project" in value) ||
    !("scan" in value) ||
    !("output" in value)
  ) {
    throw new Error(`Invalid Loreline configuration: ${configPath}`);
  }

  const candidate = value as Partial<LorelineConfig>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.project?.name !== "string" ||
    typeof candidate.project.owner !== "string" ||
    !Array.isArray(candidate.scan?.include) ||
    !Array.isArray(candidate.scan.exclude) ||
    typeof candidate.scan.maxFiles !== "number" ||
    typeof candidate.output?.directory !== "string"
  ) {
    throw new Error(`Invalid Loreline configuration fields: ${configPath}`);
  }
  return candidate as LorelineConfig;
}
