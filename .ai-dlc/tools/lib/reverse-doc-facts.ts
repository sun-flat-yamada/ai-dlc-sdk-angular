import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BoundaryClassifier, BoundaryPolicy, Classification } from './boundary.js';
import { AidlcPaths } from './config.js';
import { rel } from './cli.js';
import { FileChange } from './git.js';
import { SubsystemCaseFile } from './subsystem-cases.js';

export interface ComponentFact {
  file: string;
  className: string;
  selector: string;
  zone: Classification;
  usesServices: string[];
  testIds: string[];
  hasSpec: boolean;
}

export interface ServiceFact {
  file: string;
  className: string;
  zone: Classification;
  apiCalls: { method: string; path: string }[];
  hasSpec: boolean;
}

export interface RouteFact {
  path: string;
  target: string;
}

/** Deterministic facts about the code base, consumed by skill 05 and by the dry-run renderer. */
export interface ReverseDocFacts {
  generatedAt: string;
  baseline: string | null;
  zones: Record<string, string[]>;
  changes: (FileChange & { zone: Classification })[];
  components: ComponentFact[];
  services: ServiceFact[];
  routes: RouteFact[];
  uiDesignFiles: string[];
  apiSpecFiles: string[];
  requirementFiles: string[];
  subsystemCases: { id: string; category: string; title: string; requirements: string[]; uiRefs: string[]; expectedApi: string[] }[];
}

function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walkTs(abs));
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(abs);
  }
  return out.sort();
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

export function extractComponent(source: string): Pick<ComponentFact, 'className' | 'selector' | 'usesServices' | 'testIds'> | undefined {
  if (!/@Component\s*\(/.test(source)) return undefined;
  const className = /export\s+class\s+(\w+)/.exec(source)?.[1] ?? '';
  const selector = /selector:\s*['"]([^'"]+)['"]/.exec(source)?.[1] ?? '';
  const usesServices = unique([...source.matchAll(/inject\(\s*(\w+)\s*\)/g)].map((m) => m[1]!)).filter(
    (s) => !['Router', 'DestroyRef', 'ActivatedRoute', 'ElementRef', 'Injector'].includes(s),
  );
  const testIds = unique([...source.matchAll(/data-testid="([^"]+)"|testId="([^"]+)"/g)].map((m) => (m[1] ?? m[2])!));
  return { className, selector, usesServices, testIds };
}

export function extractService(source: string): Pick<ServiceFact, 'className' | 'apiCalls'> | undefined {
  if (!/@Injectable\s*\(/.test(source)) return undefined;
  const className = /export\s+class\s+(\w+)/.exec(source)?.[1] ?? '';
  const found = [
    ...source.matchAll(/\b(?:api|client|http)\.(get|put|post|patch|delete)\s*(?:<[^(]*>)?\(\s*[`'"]([^`'"]+)[`'"]/g),
  ].map((m) => ({ method: m[1]!.toUpperCase(), path: m[2]! }));
  const seen = new Set<string>();
  const calls = found.filter((c) => {
    const key = `${c.method} ${c.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { className, apiCalls: calls };
}

export function extractRoutes(source: string): RouteFact[] {
  const routes: RouteFact[] = [];
  const re = /path:\s*['"]([^'"]*)['"][^}]*?(?:import\(\s*['"]([^'"]+)['"]\)|component:\s*(\w+)|redirectTo:\s*['"]([^'"]*)['"])/gs;
  for (const m of source.matchAll(re)) {
    routes.push({ path: `/${m[1]}`, target: m[2] ?? m[3] ?? `redirect → /${m[4] ?? ''}` });
  }
  return routes;
}

export function collectFacts(
  paths: AidlcPaths,
  policy: BoundaryPolicy,
  baseline: string | null,
  changes: FileChange[],
): ReverseDocFacts {
  const classifier = new BoundaryClassifier(policy);
  const root = paths.root;
  const components: ComponentFact[] = [];
  const services: ServiceFact[] = [];
  for (const file of walkTs(path.join(root, 'src', 'app'))) {
    const source = readFileSync(file, 'utf8');
    const relPath = rel(root, file);
    const hasSpec = existsSync(file.replace(/\.ts$/, '.spec.ts'));
    const zone = classifier.classify(relPath);
    const component = extractComponent(source);
    if (component) components.push({ file: relPath, zone, hasSpec, ...component });
    const service = extractService(source);
    if (service) services.push({ file: relPath, zone, hasSpec, ...service });
  }
  const routesFile = path.join(root, 'src', 'app', 'app.routes.ts');
  const cases = existsSync(paths.subsystemCases)
    ? (JSON.parse(readFileSync(paths.subsystemCases, 'utf8')) as SubsystemCaseFile).cases
    : [];
  const list = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f !== '.gitkeep' && f.toLowerCase() !== 'readme.md')
          .map((f) => rel(root, path.join(dir, f)))
      : [];
  return {
    generatedAt: new Date().toISOString(),
    baseline,
    zones: Object.fromEntries(Object.entries(policy.zones).map(([k, v]) => [k, v.paths])),
    changes: changes.map((c) => ({ ...c, zone: classifier.classify(c.path) })),
    components,
    services,
    routes: existsSync(routesFile) ? extractRoutes(readFileSync(routesFile, 'utf8')) : [],
    uiDesignFiles: list(paths.inputs.uiDesign),
    apiSpecFiles: list(paths.inputs.apiSpecs),
    requirementFiles: list(paths.inputs.requirements),
    subsystemCases: cases.map((c) => ({
      id: c.id,
      category: c.category,
      title: c.title,
      requirements: [...new Set([...`${c.notes} ${c.title}`.matchAll(/\bREQ-[A-Z0-9][A-Z0-9-]*/g)].map((m) => m[0]))],
      uiRefs: c.uiRefs ?? [],
      expectedApi: c.expectedApi.map((a) => `${a.method} ${a.path}`),
    })),
  };
}
