import { readFileSync } from 'node:fs';
import picomatch from 'picomatch';
import { parse } from 'yaml';
import { z } from 'zod';
import type { FileChange } from './git.js';

export const ZONES = ['immutable', 'ignored', 'extensible', 'deletable', 'rebuildable'] as const;
export type Zone = (typeof ZONES)[number];
export type Classification = Zone | 'unclassified';

const zoneSchema = z.object({
  description: z.string().default(''),
  paths: z.array(z.string()).default([]),
});

export const boundaryPolicySchema = z.object({
  version: z.literal(1),
  /** What to do with a changed path that matches no zone. */
  unclassified: z.enum(['deny', 'allow']).default('deny'),
  zones: z.object({
    immutable: zoneSchema.default({ description: '', paths: [] }),
    extensible: zoneSchema.default({ description: '', paths: [] }),
    rebuildable: zoneSchema.default({ description: '', paths: [] }),
    deletable: zoneSchema.default({ description: '', paths: [] }),
    ignored: zoneSchema.default({ description: '', paths: [] }),
  }),
});

export type BoundaryPolicy = z.infer<typeof boundaryPolicySchema>;

export function parseBoundaryPolicy(text: string, source = 'boundary-policy.yaml'): BoundaryPolicy {
  const result = boundaryPolicySchema.safeParse(parse(text));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid ${source}:\n${issues}`);
  }
  return result.data;
}

export function loadBoundaryPolicy(file: string): BoundaryPolicy {
  return parseBoundaryPolicy(readFileSync(file, 'utf8'), file);
}

/**
 * Classifies repository-relative paths. When several zones match, the most restrictive wins:
 * immutable > ignored > extensible > deletable > rebuildable.
 */
export class BoundaryClassifier {
  private readonly matchers: [Zone, picomatch.Matcher][];

  constructor(readonly policy: BoundaryPolicy) {
    this.matchers = ZONES.map((zone) => [
      zone,
      picomatch(policy.zones[zone].paths.length ? policy.zones[zone].paths : ['\u0000never'], {
        dot: true,
      }),
    ]);
  }

  classify(file: string): Classification {
    const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const [zone, match] of this.matchers) {
      if (match(normalized)) {
        return zone;
      }
    }
    return 'unclassified';
  }
}

export type ViolationRule =
  | 'immutable-changed'
  | 'extensible-lines-removed'
  | 'extensible-file-removed'
  | 'out-of-scope'
  | 'unclassified';

export interface BoundaryViolation {
  path: string;
  zone: Classification;
  status: FileChange['status'];
  rule: ViolationRule;
  message: string;
  /** Original path when the change is a rename. */
  from?: string;
}

export interface BoundaryReport {
  baseline: string;
  changes: (FileChange & { zone: Classification })[];
  violations: BoundaryViolation[];
  /** Lines / files changed per zone. */
  stats: Record<string, { files: number; added: number; deleted: number }>;
}

const MESSAGES: Record<ViolationRule, string> = {
  'immutable-changed':
    'Immutable zone: reuse it (import), never edit, add, rename or delete files here.',
  'extensible-lines-removed':
    'Extensible zone is append-only: existing lines were changed or removed. Only add new entries.',
  'extensible-file-removed': 'Extensible zone: existing files must not be deleted or renamed.',
  'out-of-scope': 'Ignored zone: unrelated to this change and must not be touched.',
  unclassified: 'Path matches no zone in boundary-policy.yaml and unclassified changes are denied.',
};

/** Evaluates a list of changes against the policy. Pure function: no git, no filesystem. */
export function evaluateChanges(
  classifier: BoundaryClassifier,
  baseline: string,
  changes: readonly FileChange[],
): BoundaryReport {
  const report: BoundaryReport = { baseline, changes: [], violations: [], stats: {} };
  for (const change of changes) {
    const zone = classifier.classify(change.path);
    const fromZone = change.from ? classifier.classify(change.from) : undefined;
    report.changes.push({ ...change, zone });
    const stat = (report.stats[zone] ??= { files: 0, added: 0, deleted: 0 });
    stat.files += 1;
    stat.added += change.added ?? 0;
    stat.deleted += change.deleted ?? 0;

    const rule = ruleFor(zone, change, fromZone, classifier.policy.unclassified);
    if (rule) {
      report.violations.push({
        path: change.path,
        zone: fromZone === 'immutable' ? 'immutable' : zone,
        status: change.status,
        rule,
        message: MESSAGES[rule],
        ...(change.from ? { from: change.from } : {}),
      });
    }
  }
  return report;
}

function ruleFor(
  zone: Classification,
  change: FileChange,
  fromZone: Classification | undefined,
  unclassified: BoundaryPolicy['unclassified'],
): ViolationRule | undefined {
  // Moving a file out of a protected zone is a change of that zone.
  if (fromZone === 'immutable') return 'immutable-changed';
  if (fromZone === 'extensible') return 'extensible-file-removed';
  if (fromZone === 'ignored') return 'out-of-scope';
  switch (zone) {
    case 'immutable':
      return 'immutable-changed';
    case 'ignored':
      return 'out-of-scope';
    case 'extensible':
      if (change.status === 'deleted' || change.status === 'renamed')
        return 'extensible-file-removed';
      if (change.status === 'modified' && (change.deleted ?? 0) > 0)
        return 'extensible-lines-removed';
      return undefined;
    case 'unclassified':
      return unclassified === 'deny' ? 'unclassified' : undefined;
    default:
      return undefined;
  }
}

/** Markdown summary of the policy, injected into prompts. */
export function describePolicy(policy: BoundaryPolicy): string {
  const lines: string[] = [];
  for (const zone of ZONES) {
    const z = policy.zones[zone];
    if (!z.paths.length) continue;
    lines.push(`- **${zone}** — ${z.description}`);
    for (const p of z.paths) lines.push(`  - \`${p}\``);
  }
  lines.push(`- **unclassified paths** — ${policy.unclassified === 'deny' ? 'denied' : 'allowed'}`);
  return lines.join('\n');
}
