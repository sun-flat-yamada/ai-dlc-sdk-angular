import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordBaseline, runBoundaryGuard } from '../boundary-guard.js';
import { resolvePaths } from '../lib/config.js';
import { explainReferenceRemovals, moduleCandidates } from '../lib/reference-removal.js';
import { REPO_ROOT, commitAll, tempRepo, write } from './helpers.js';

const ROUTES = 'src/app/app.routes.ts';
const HOME = 'src/app/features/home/home-page.ts';
const LEGACY = 'src/app/features/legacy-network/legacy-network-page.ts';
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

/** The sample's routes with the legacy route taken out (what a replacement leaves behind). */
const routesWithoutLegacy = (text: string) =>
  text.replace(
    /  \{\n    path: 'network-legacy',\n[\s\S]*?\n  \},\n/,
    "  {\n    path: 'network-settings',\n    loadComponent: () =>\n      import('./features/network-settings/network-settings-page').then((m) => m.NetworkSettingsPage),\n  },\n",
  );

describe('moduleCandidates', () => {
  it('resolves relative specifiers to repository paths', () => {
    expect(moduleCandidates(ROUTES, './features/legacy-network/legacy-network-page')).toContain(
      LEGACY,
    );
    expect(moduleCandidates(HOME, '../legacy-network/legacy-network-page.js')).toContain(LEGACY);
    expect(moduleCandidates(ROUTES, './features/legacy-network')).toContain(
      'src/app/features/legacy-network/index.ts',
    );
    expect(moduleCandidates(ROUTES, '@app/legacy')).toEqual([]);
  });
});

describe('explainReferenceRemovals (issue #20)', () => {
  const deleted = new Set([LEGACY]);

  it('accepts replacing the legacy route and its menu entry in the sample app', () => {
    const routes = read(ROUTES);
    const home = read(HOME);
    const result = explainReferenceRemovals(
      [
        { path: ROUTES, baseline: routes, current: routesWithoutLegacy(routes) },
        {
          path: HOME,
          baseline: home,
          current: home.replace(
            "  { id: 'network', label: 'ネットワーク設定', route: '/network-legacy' },\n",
            "  { id: 'network', label: 'ネットワーク設定', route: '/network-settings' },\n",
          ),
        },
      ],
      deleted,
    );
    expect(result.get(ROUTES)).toMatchObject({ allowed: true });
    expect(result.get(ROUTES)?.units.map((u) => u.reason)).toEqual([
      'loads ./features/legacy-network/legacy-network-page',
    ]);
    expect(result.get(HOME)).toMatchObject({ allowed: true });
    expect(result.get(HOME)?.units[0]?.reason).toBe("links to the removed route 'network-legacy'");
  });

  it('does not accept menu entries whose route still exists', () => {
    const routes = read(ROUTES);
    const home = read(HOME);
    // The route keeps its path and only points to a new page: the menu entry must stay.
    const rewired = routes.replace(
      "import('./features/legacy-network/legacy-network-page').then((m) => m.LegacyNetworkPage)",
      "import('./features/network-settings/network-settings-page').then((m) => m.NetworkSettingsPage)",
    );
    const result = explainReferenceRemovals(
      [
        { path: ROUTES, baseline: routes, current: rewired },
        { path: HOME, baseline: home, current: home.replace(/ {2}\{ id: 'network'.*\n/, '') },
      ],
      deleted,
    );
    expect(result.get(ROUTES)?.allowed).toBe(true);
    expect(result.get(HOME)).toMatchObject({ allowed: false, units: [] });
  });

  it('keeps every other existing line append-only', () => {
    const routes = read(ROUTES);
    const result = explainReferenceRemovals(
      [
        {
          path: ROUTES,
          baseline: routes,
          current: routesWithoutLegacy(routes).replace("  { path: '**', redirectTo: '' },\n", ''),
        },
      ],
      deleted,
    );
    const removal = result.get(ROUTES);
    expect(removal?.allowed).toBe(false);
    expect(routes.split('\n')[(removal?.firstUnexplainedLine ?? 0) - 1]).toContain("path: '**'");
  });

  it('needs a deleted file: references to existing files stay protected', () => {
    const routes = read(ROUTES);
    const result = explainReferenceRemovals(
      [{ path: ROUTES, baseline: routes, current: routesWithoutLegacy(routes) }],
      new Set(['src/app/features/legacy-other/page.ts']),
    );
    expect(result.get(ROUTES)?.allowed).toBe(false);
  });

  it('follows static imports to the entries that use them', () => {
    const baseline = [
      "import { Routes } from '@angular/router';",
      "import { LegacyPage } from './features/legacy-x/legacy-page';",
      '',
      'export const routes: Routes = [',
      "  { path: '', component: HomePage },",
      '  // Old screen, kept for the field service tool.',
      "  { path: 'legacy', component: LegacyPage },",
      '];',
      '',
    ].join('\n');
    const current = [
      "import { Routes } from '@angular/router';",
      '',
      'export const routes: Routes = [',
      "  { path: '', component: HomePage },",
      "  { path: 'new', component: NewPage },",
      '];',
      '',
    ].join('\n');
    const result = explainReferenceRemovals(
      [{ path: ROUTES, baseline, current }],
      new Set(['src/app/features/legacy-x/legacy-page.ts']),
    ).get(ROUTES);
    expect(result?.allowed).toBe(true);
    expect(result?.units.map((u) => [u.startLine, u.endLine, u.reason])).toEqual([
      [2, 2, 'imports ./features/legacy-x/legacy-page'],
      [6, 7, 'uses LegacyPage'],
    ]);
  });

  it('fails closed when a reference shares a line with other code', () => {
    const baseline =
      "export const routes = [{ path: '' }, { path: 'l', loadComponent: () => import('./features/legacy-x/p') }];\n";
    const result = explainReferenceRemovals(
      [{ path: ROUTES, baseline, current: "export const routes = [{ path: '' }];\n" }],
      new Set(['src/app/features/legacy-x/p.ts']),
    ).get(ROUTES);
    expect(result).toMatchObject({ allowed: false, firstUnexplainedLine: 1 });
  });
});

describe('boundary guard with deleted deletable files (issue #20)', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function prepareRepo(policy = read('.ai-dlc/config/boundary-policy.yaml')) {
    const repo = tempRepo();
    cleanup = repo.cleanup;
    const { dir } = repo;
    write(dir, '.ai-dlc/config/boundary-policy.yaml', policy);
    for (const f of [ROUTES, HOME, LEGACY]) write(dir, f, read(f));
    write(dir, '.gitignore', '/.ai-dlc/outputs/\n');
    commitAll(dir);
    return { dir, paths: resolvePaths(dir) };
  }

  const violations = async (paths: ReturnType<typeof resolvePaths>, baseline: string) => {
    const { report, gate } = await runBoundaryGuard(paths, { baseline, revert: false });
    return {
      gate,
      report,
      list: report.violations.map((v) => `${v.path}:${v.rule}`).sort(),
    };
  };

  function replaceLegacy(dir: string) {
    write(dir, ROUTES, routesWithoutLegacy(read(ROUTES)));
    write(dir, HOME, read(HOME).replace("route: '/network-legacy'", "route: '/network-settings'"));
    write(dir, 'src/app/features/network-settings/network-settings-page.ts', 'export {};\n');
  }

  it('lets the legacy screen be deleted together with its route and menu entry', async () => {
    const { dir, paths } = prepareRepo();
    const baseline = await recordBaseline(paths);
    replaceLegacy(dir);
    // Keeping the legacy page: the references are not dead, so the edits are violations.
    expect((await violations(paths, baseline.sha)).list).toEqual([
      `${ROUTES}:extensible-lines-removed`,
      `${HOME}:extensible-lines-removed`,
    ]);

    rmSync(path.join(dir, LEGACY));
    const { gate, report, list } = await violations(paths, baseline.sha);
    expect(list).toEqual([]);
    expect(gate.status).toBe('pass');
    expect(gate.metrics?.['referenceRemovals']).toBe(2);
    expect(report.referenceRemovals.map((r) => r.path).sort()).toEqual([ROUTES, HOME]);
  });

  it('can be switched off in the policy', async () => {
    const { dir, paths } = prepareRepo(
      read('.ai-dlc/config/boundary-policy.yaml').replace(
        'removeReferencesToDeleted: true',
        'removeReferencesToDeleted: false',
      ),
    );
    const baseline = await recordBaseline(paths);
    replaceLegacy(dir);
    rmSync(path.join(dir, LEGACY));
    expect((await violations(paths, baseline.sha)).list).toEqual([
      `${ROUTES}:extensible-lines-removed`,
      `${HOME}:extensible-lines-removed`,
    ]);
  });
});
