import path from "node:path";

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  severity: "high" | "medium";
  // First 4 chars of the matched value + "..." + rule name. Never the full
  // value: this is a defensive-security module, so findings must stay safe
  // to log, render, and put in error messages.
  preview: string;
}

interface ContentRule {
  name: string;
  severity: "high" | "medium";
  source: string;
  flags: string;
  // Index of the capture group holding the "value" to preview/redact, when
  // the rule's match includes surrounding context (e.g. a key label). Falls
  // back to the whole match when omitted.
  valueGroup?: number;
}

const CONTENT_RULES: ContentRule[] = [
  { name: "private-key", severity: "high", source: "-----BEGIN [A-Z ]*PRIVATE KEY-----", flags: "g" },
  { name: "aws-access-key-id", severity: "high", source: "\\bAKIA[0-9A-Z]{16}\\b", flags: "g" },
  {
    name: "github-token",
    severity: "high",
    source: "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\\b",
    flags: "g",
  },
  { name: "github-pat", severity: "high", source: "\\bgithub_pat_[A-Za-z0-9_]{22,}\\b", flags: "g" },
  { name: "slack-token", severity: "high", source: "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b", flags: "g" },
  { name: "stripe-live-key", severity: "high", source: "\\bsk_live_[A-Za-z0-9]{16,}\\b", flags: "g" },
  {
    name: "generic-assignment",
    severity: "high",
    source: "(?:api[_-]?key|secret|token|password)\\s*[:=]\\s*(['\"])([^'\"\\s]{12,})\\1",
    flags: "gi",
    valueGroup: 2,
  },
  { name: "jwt", severity: "medium", source: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.", flags: "g" },
];

const HIGH_ENTROPY_RUN_SOURCE = "[A-Za-z0-9+/=]{40,}";
const HIGH_ENTROPY_THRESHOLD = 4.5;

const SENSITIVE_FILE_PATTERNS: RegExp[] = [/^\.env$/, /^\.env\..+$/, /\.pem$/, /^id_rsa/];

/**
 * Scans text for likely secrets. Files matching a sensitive-filename pattern
 * (.env, .env.*, *.pem, id_rsa*) are flagged wholesale, without their
 * content being scanned or echoed anywhere.
 */
export function scanTextForSecrets(text: string, file: string): SecretFinding[] {
  if (isSensitiveFile(file)) {
    return [
      {
        file,
        line: 0,
        rule: "sensitive-file",
        severity: "high",
        preview: path.basename(file),
      },
    ];
  }

  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    for (const rule of CONTENT_RULES) {
      const regex = new RegExp(rule.source, rule.flags);
      for (const match of line.matchAll(regex)) {
        const value = rule.valueGroup !== undefined ? match[rule.valueGroup] : match[0];
        if (!value) {
          continue;
        }
        findings.push({
          file,
          line: lineNumber,
          rule: rule.name,
          severity: rule.severity,
          preview: buildPreview(value, rule.name),
        });
      }
    }

    const entropyRegex = new RegExp(HIGH_ENTROPY_RUN_SOURCE, "g");
    for (const match of line.matchAll(entropyRegex)) {
      const value = match[0];
      if (value && shannonEntropy(value) > HIGH_ENTROPY_THRESHOLD) {
        findings.push({
          file,
          line: lineNumber,
          rule: "high-entropy",
          severity: "medium",
          preview: buildPreview(value, "high-entropy"),
        });
      }
    }
  }
  return findings;
}

/**
 * Replaces every high-confidence secret match in text with
 * "[REDACTED:<rule>]". Medium-confidence matches (jwt, high-entropy) are
 * left untouched.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const rule of CONTENT_RULES) {
    if (rule.severity !== "high") {
      continue;
    }
    const regex = new RegExp(rule.source, rule.flags);
    result = result.replace(regex, `[REDACTED:${rule.name}]`);
  }
  return result;
}

function isSensitiveFile(file: string): boolean {
  const base = path.basename(file);
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

function buildPreview(value: string, rule: string): string {
  return `${value.slice(0, 4)}...${rule}`;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
