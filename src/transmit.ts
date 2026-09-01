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

// Full file content is privately associated with the TransmissionItem that
// buildTransmissionPreview produced for it, keyed by a non-exported symbol.
// approvedPayload uses this (when present) to redact secrets from the full
// content before re-truncating, so a secret straddling the excerpt boundary
// can never leave a partial, unredacted fragment in the returned excerpt.
// A plain assignment (rather than Object.defineProperty) keeps the property
// enumerable, so it survives the idiomatic `{ ...item, excluded: true }`
// update a caller uses to mark an item excluded.
const FULL_CONTENT = Symbol("loreline.transmit.fullContent");

interface FullContentStash {
  fullText: string;
  maxExcerptBytes: number;
}

function attachFullContent(item: TransmissionItem, stash: FullContentStash): void {
  (item as unknown as Record<symbol, FullContentStash>)[FULL_CONTENT] = stash;
}

function readFullContent(item: TransmissionItem): FullContentStash | undefined {
  return (item as unknown as Record<symbol, FullContentStash | undefined>)[FULL_CONTENT];
}

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

    const fullText = buffer.toString("utf8");
    const excerpt = buffer.subarray(0, maxExcerptBytes).toString("utf8");
    const secretFindings = scanTextForSecrets(fullText, file);
    const item: TransmissionItem = {
      file,
      excerpt,
      bytes: buffer.byteLength,
      secretFindings,
      excluded: false,
    };
    attachFullContent(item, { fullText, maxExcerptBytes });
    items.push(item);
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
 * excerpts redacted. Blockedness is always re-derived from `preview.items`
 * here (any non-excluded item with a high-confidence finding blocks); the
 * caller-supplied `preview.blocked` / `preview.highFindings` fields are
 * ignored for this decision, since a caller could recompute them
 * incorrectly (or a stale/hand-built preview could carry a wrong value) and
 * this is the last line of defense before data leaves the machine.
 */
export function approvedPayload(preview: TransmissionPreview): Array<{ file: string; excerpt: string }> {
  const highFindings = countHighFindings(preview.items);
  if (highFindings > 0) {
    throw new Error(
      `transmission blocked: ${highFindings} high-confidence secret finding(s); redact or exclude them first`,
    );
  }

  return preview.items
    .filter((item) => !item.excluded)
    .map((item) => ({ file: item.file, excerpt: redactedExcerptFor(item) }));
}

// Redacts from the item's full original content (when available) and only
// then truncates to the original excerpt's byte budget, so a high-confidence
// secret that straddles the excerpt boundary is fully removed before any
// truncation can leave a partial, unredacted fragment behind. Falls back to
// redacting the excerpt alone when no full-content association exists (e.g.
// a TransmissionItem constructed by hand rather than by
// buildTransmissionPreview).
function redactedExcerptFor(item: TransmissionItem): string {
  const stash = readFullContent(item);
  if (!stash) {
    return redactSecrets(item.excerpt);
  }
  const redactedFull = redactSecrets(stash.fullText);
  return Buffer.from(redactedFull, "utf8").subarray(0, stash.maxExcerptBytes).toString("utf8");
}

function countHighFindings(items: TransmissionItem[]): number {
  return items
    .filter((item) => !item.excluded)
    .reduce((sum, item) => sum + item.secretFindings.filter((finding) => finding.severity === "high").length, 0);
}
