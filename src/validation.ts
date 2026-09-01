import { readFile } from "node:fs/promises";
import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

export type ArtifactKind =
  | "config"
  | "readiness"
  | "interview"
  | "session"
  | "context"
  | "verification";

// Only lists versions for kinds that exist today. Later tasks extend both the
// ArtifactKind union and these maps when they introduce new schema versions.
export const SUPPORTED_VERSIONS: Record<ArtifactKind, number[]> = {
  config: [1],
  readiness: [1, 2],
  interview: [1],
  session: [1],
  context: [1],
  verification: [1],
};

export const LATEST_VERSION: Record<ArtifactKind, number> = {
  config: 1,
  readiness: 2,
  interview: 1,
  session: 1,
  context: 1,
  verification: 1,
};

const validators = new Map<string, Promise<ValidateFunction>>();

export async function validateArtifact<T>(
  kind: ArtifactKind,
  value: unknown,
  source: string,
): Promise<T> {
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (!isSupportedVersion(kind, version)) {
    const supported = SUPPORTED_VERSIONS[kind].join(", ");
    throw new Error(
      `Invalid ${kind} artifact ${source}: unsupported schemaVersion ${String(version)} (supported: ${supported})`,
    );
  }

  const validate = await getValidator(kind, version);
  if (!validate(value)) {
    throw new Error(`Invalid ${kind} artifact ${source}:\n${formatErrors(validate.errors)}`);
  }
  return value as T;
}

function isSupportedVersion(kind: ArtifactKind, version: unknown): version is number {
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    SUPPORTED_VERSIONS[kind].includes(version)
  );
}

function getValidator(kind: ArtifactKind, version: number): Promise<ValidateFunction> {
  const cacheKey = `${kind}:${version}`;
  const existing = validators.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = loadValidator(kind, version);
  validators.set(cacheKey, pending);
  return pending;
}

async function loadValidator(kind: ArtifactKind, version: number): Promise<ValidateFunction> {
  const schemaUrl = new URL(`../schemas/v${version}/${kind}.schema.json`, import.meta.url);
  const schema: unknown = JSON.parse(await readFile(schemaUrl, "utf8"));
  if (typeof schema !== "object" || schema === null) {
    throw new Error(`Invalid packaged schema: ${schemaUrl.pathname}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true, formats: {
    "date-time": {
      type: "string",
      validate: (value: string) => !Number.isNaN(Date.parse(value)),
    },
  } });
  return ajv.compile(schema as AnySchema);
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "- validation failed";
  }
  return errors
    .map((error) => {
      const location = error.instancePath || "/";
      if (error.keyword === "additionalProperties") {
        const property = String(error.params.additionalProperty);
        return `- ${location}: unknown property "${property}"`;
      }
      return `- ${location}: ${error.message ?? error.keyword}`;
    })
    .join("\n");
}
