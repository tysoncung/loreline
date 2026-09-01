import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { LorelineConfig } from "./types.js";
import { validateArtifact } from "./validation.js";

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
    return validateArtifact<LorelineConfig>("config", parsed, configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig(root);
    }

    throw error;
  }
}

export async function loadRequiredConfig(root: string): Promise<LorelineConfig> {
  const configPath = path.join(root, CONFIG_FILE);
  try {
    await access(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Loreline is not initialized in ${root}. Run "loreline init" first.`);
    }
    throw error;
  }
  return loadConfig(root);
}
