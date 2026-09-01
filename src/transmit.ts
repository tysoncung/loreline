import { readFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets, scanTextForSecrets, type SecretFinding } from "./secrets.js";

export interface TransmissionItem {
  file: string;
  excerpt: string;
  bytes: number;
  secretFindings: SecretFinding[];
  excluded: boolean;
}

export interface TransmissionPreview {
  items: TransmissionItem[];
  blocked: boolean;
  highFindings: number;
}

const DEFAULT_MAX_EXCERPT_BYTES = 2000;

/**
 * Builds a preview of what would be sent to a remote AI provider: for each
 * file, a size, a truncated excerpt, and the secrets found in the file's
 * full content. Files are read relative to root and processed in
 * deterministic (sorted) path order regardless of input order.
 */
export async function buildTransmissionPreview(
  root: string,
  files: string[],
  options?: { maxExcerptBytes?: number },
): Promise<TransmissionPreview> {
  const maxExcerptBytes = options?.maxExcerptBytes ?? DEFAULT_MAX_EXCERPT_BYTES;
  const sortedFiles = [...files].sort();

  const items: TransmissionItem[] = [];
  for (const file of sortedFiles) {
    let buffer: Buffer;
    try {
      buffer = await readFile(path.join(root, file));
    } catch {
      throw new Error(`cannot read file for transmission preview: ${file}`);
    }

    const excerpt = buffer.subarray(0, maxExcerptBytes).toString("utf8");
    const secretFindings = scanTextForSecrets(buffer.toString("utf8"), file);
    items.push({
      file,
      excerpt,
      bytes: buffer.byteLength,
      secretFindings,
      excluded: false,
    });
  }

  const highFindings = countHighFindings(items);
  return {
    items,
    blocked: highFindings > 0,
    highFindings,
  };
}

/** Stable text listing files, sizes, and redacted (preview-only) findings. */
export function renderTransmissionPreview(preview: TransmissionPreview): string {
  const lines: string[] = [
    `Transmission preview: ${preview.items.length} file(s), ${preview.highFindings} high-confidence finding(s)` +
      (preview.blocked ? " (BLOCKED)" : ""),
  ];

  for (const item of preview.items) {
    const hasHigh = item.secretFindings.some((finding) => finding.severity === "high");
    const status = item.excluded ? "excluded" : hasHigh ? "blocked" : "ok";
    lines.push(`- ${item.file} (${item.bytes} bytes) [${status}]`);
    for (const finding of item.secretFindings) {
      lines.push(`    ${finding.severity} ${finding.rule} line ${finding.line}: ${finding.preview}`);
    }
  }

  return lines.join("\n");
}

/**
 * Returns the payload that is safe to send: non-excluded items only, with
 * excerpts passed through redactSecrets. Throws while the preview is
 * blocked, since a caller must first redact or exclude the offending items.
 */
export function approvedPayload(preview: TransmissionPreview): Array<{ file: string; excerpt: string }> {
  if (preview.blocked) {
    throw new Error(
      `transmission blocked: ${preview.highFindings} high-confidence secret finding(s); redact or exclude them first`,
    );
  }

  return preview.items
    .filter((item) => !item.excluded)
    .map((item) => ({ file: item.file, excerpt: redactSecrets(item.excerpt) }));
}

function countHighFindings(items: TransmissionItem[]): number {
  return items
    .filter((item) => !item.excluded)
    .reduce((sum, item) => sum + item.secretFindings.filter((finding) => finding.severity === "high").length, 0);
}
