import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { pathInside, type Snapshot } from "./files.ts"

export interface SecretFinding {
  path: string
  kind: string
  key?: string
}

const KEY_PATTERN = /(api[-_]?key|token|secret|password|passwd|authorization|client[-_]?secret|access[-_]?token|refresh[-_]?token|private[-_]?key)/i
const SAFE_PLACEHOLDER = /(?:\{(?:env|file):[^}]+\}|\$\{?[A-Z][A-Z0-9_]*\}?|<[^>]*(?:TOKEN|KEY|SECRET|PASSWORD)[^>]*>|REPLACE[_ -]?ME)/i
const ASSIGNMENT_EXTENSIONS = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml", ".js", ".ts", ".mjs", ".cjs"])

function looksText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  return !sample.includes(0)
}

function shouldScanAssignments(path: string): boolean {
  const lower = path.toLowerCase()
  return ASSIGNMENT_EXTENSIONS.has(extname(lower)) || lower.split("/").at(-1)?.startsWith(".env") === true
}

function addFinding(findings: SecretFinding[], finding: SecretFinding) {
  if (!findings.some((item) => item.path === finding.path && item.kind === finding.kind && item.key === finding.key)) {
    findings.push(finding)
  }
}

function scanText(path: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = []

  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    addFinding(findings, { path, kind: "private-key-pem" })
  }

  if (/https?:\/\/[^\s/:@]+:[^\s/@]+@/i.test(text)) {
    addFinding(findings, { path, kind: "credential-in-url" })
  }

  if (!shouldScanAssignments(path)) return findings

  const quoted = /["']([A-Za-z0-9_.-]+)["']\s*[:=]\s*["']([^"'\r\n]+)["']/g
  for (const match of text.matchAll(quoted)) {
    const key = match[1] ?? ""
    const value = match[2] ?? ""
    if (!KEY_PATTERN.test(key)) continue
    if (!value || SAFE_PLACEHOLDER.test(value)) continue
    addFinding(findings, { path, kind: "literal-sensitive-value", key })
  }

  const unquoted = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*([^#\r\n]+?)\s*$/gm
  for (const match of text.matchAll(unquoted)) {
    const key = match[1] ?? ""
    const value = (match[2] ?? "").trim().replace(/^['"]|['"]$/g, "")
    if (!KEY_PATTERN.test(key)) continue
    if (!value || SAFE_PLACEHOLDER.test(value)) continue
    if (/^(>:true|false|null|undefined|process\.env\.|Deno\.env\.|Bun\.env\.)/i.test(value)) continue
    addFinding(findings, { path, kind: "literal-sensitive-value", key })
  }

  return findings
}

export async function scanForSecrets(root: string, snapshot: Snapshot): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = []
  for (const path of Object.keys(snapshot).sort()) {
    const data = await readFile(pathInside(root, path))
    if (!looksText(data)) continue
    findings.push(...scanText(path, data.toString("utf8")))
  }
  return findings
}
