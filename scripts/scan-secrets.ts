/**
 * Secret & privacy scanner for tracked and untracked (non-ignored) files.
 *
 *   npm run secret-scan
 *
 * Fails (exit 1) on credentials, private keys, personal e-mail addresses and absolute user home paths.
 * Suppress a reviewed false positive by adding `secret-scan:allow` on the same line.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

interface Rule {
  id: string;
  pattern: RegExp;
  description: string;
}

const RULES: Rule[] = [
  {
    id: 'github-token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
    description: 'GitHub token',
  },
  {
    id: 'aws-access-key',
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
    description: 'AWS access key id',
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/,
    description: 'Private key',
  },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, description: 'Slack token' },
  {
    id: 'openai-key',
    pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/,
    description: 'OpenAI-style API key',
  },
  {
    id: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    description: 'Anthropic API key',
  },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, description: 'Google API key' },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/, description: 'npm token' },
  {
    id: 'hardcoded-secret',
    pattern:
      /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
    description: 'Hard-coded secret assignment',
  },
  {
    id: 'email',
    pattern:
      /\b[A-Za-z0-9._%+-]+@(?!(?:example\.(?:com|org|net|invalid)|users\.noreply\.github\.com|anthropic\.com)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    description: 'Personal e-mail address (use example.invalid)',
  },
  {
    // Allowed: CI runner, generic `user`, and `node` (the sandbox user of the dev container image).
    id: 'user-home-path',
    pattern:
      /\b[A-Za-z]:\\Users\\(?!Public\\|Default\\|<)[^\\\s"'`]+\\|\/home\/(?!runner\/|user\/|node\/|<)[a-z0-9._-]+\/|\/Users\/(?!Shared\/|<)[A-Za-z0-9._-]+\//,
    description: 'Absolute user home path',
  },
];

const SKIP = [
  /^package-lock\.json$/,
  /\.(xlsx|png|ico|jpg|jpeg|gif|woff2?)$/i,
  /^scripts\/scan-secrets\.ts$/,
];
const MAX_BYTES = 2_000_000;

function listFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  );
  return out.split('\0').filter(Boolean);
}

export interface Finding {
  file: string;
  line: number;
  rule: string;
  description: string;
  excerpt: string;
}

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('secret-scan:allow')) return;
    for (const rule of RULES) {
      const m = rule.pattern.exec(line);
      if (m) {
        const hit = m[0];
        const masked = hit.length > 8 ? `${hit.slice(0, 4)}…${hit.slice(-2)}` : '****';
        findings.push({
          file,
          line: i + 1,
          rule: rule.id,
          description: rule.description,
          excerpt: masked,
        });
      }
    }
  });
  return findings;
}

function main(): number {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const file of listFiles()) {
    if (SKIP.some((re) => re.test(file))) continue;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue; // deleted in the working tree
    }
    if (size > MAX_BYTES) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes('\u0000')) continue; // binary
    scanned++;
    findings.push(...scanText(file, text));
  }
  for (const f of findings) {
    console.error(`[secret-scan] ${f.file}:${f.line} ${f.rule} (${f.description}) ${f.excerpt}`);
  }
  console.log(`[secret-scan] ${scanned} file(s) scanned, ${findings.length} finding(s)`);
  return findings.length ? 1 : 0;
}

process.exitCode = main();
