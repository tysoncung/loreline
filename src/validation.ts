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
  | "context"
  | "verification";

const validators = new Map<ArtifactKind, Promise<ValidateFunction>>();

export async function validateArtifact<T>(
  kind: ArtifactKind,
  value: unknown,
  source: string,
): Promise<T> {
  const validate = await getValidator(kind);
  if (!validate(value)) {
    throw new Error(`Invalid ${kind} artifact ${source}:\n${formatErrors(validate.errors)}`);
  }
  return value as T;
}

function getValidator(kind: ArtifactKind): Promise<ValidateFunction> {
  const existing = validators.get(kind);
  if (existing) {
    return existing;
  }

  const pending = loadValidator(kind);
  validators.set(kind, pending);
  return pending;
}

async function loadValidator(kind: ArtifactKind): Promise<ValidateFunction> {
  const schemaUrl = new URL(`../schemas/v1/${kind}.schema.json`, import.meta.url);
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
