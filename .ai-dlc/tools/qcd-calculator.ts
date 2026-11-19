/**
 * QCD (Quality / Cost / Delivery) comparison between an AI-DLC run and the human baseline.
 *
 *   npm run aidlc:qcd                    # latest full-loop run
 *   npm run aidlc:qcd -- --run-id <id>   # a specific run
 *
 * Inputs : .ai-dlc/outputs/telemetry/run-history.json
 *          .ai-dlc/inputs/human-baseline/human-qcd.json
 * Outputs: .ai-dlc/outputs/reports/qcd-comparison-report.{md,json}
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AidlcConfig, AidlcPaths, findRepoRoot, loadConfig, resolvePaths } from './lib/config.js';
import { isMain, log, rel, runCli } from './lib/cli.js';
import { enforceSandbox } from './lib/sandbox.js';
import {
  CopilotCallRecord,
  GateResult,
  RunRecord,
  readRunHistory,
  writeJsonAtomic,
} from './lib/telemetry.js';

export const humanBaselineSchema = z.object({
  project: z.string(),
  requirementId: z.string().optional(),
  description: z.string().optional(),
  quality: z.object({
    subsystemTestFirstPassRate: z.number().min(0).max(1).optional(),
    subsystemTestFinalPassRate: z.number().min(0).max(1).optional(),
    unitTestCoverage: z
      .object({
        statements: z.number().optional(),
        branches: z.number().optional(),
        lines: z.number().optional(),
      })
      .optional(),
    staticAnalysisWarnings: z.number().int().nonnegative().optional(),
    defectsFound: z.number().int().nonnegative().optional(),
    /** Size of the delivered change in KLOC (for defect density). */
    sizeKloc: z.number().positive().optional(),
  }),
  cost: z.object({
    effortHours: z.record(z.string(), z.number().nonnegative()),
    hourlyRate: z.number().nonnegative().optional(),
    currency: z.string().optional(),
  }),
  delivery: z.object({
    leadTimeHours: z.number().nonnegative(),
    calendarDays: z.number().nonnegative().optional(),
  }),
});

export type HumanBaseline = z.infer<typeof humanBaselineSchema>;

type Num = number | null;

export interface QcdResult {
  runId: string;
  dryRun: boolean;
  /** False for dry-runs and runs that did not pass the final gate: reductions are then not reported. */
  comparable: boolean;
  generatedAt: string;
  currency: string;
  quality: {
    ai: {
      subsystemFirstPassRate: Num;
      subsystemFinalPassRate: Num;
      passRateByIteration: (number | null)[];
      coverageStatements: Num;
      coverageBranches: Num;
      coverageLines: Num;
      lintWarnings: Num;
      defectsDetected: Num;
      changedKloc: Num;
      defectDensityPerKloc: Num;
    };
    human: {
      subsystemFirstPassRate: Num;
      subsystemFinalPassRate: Num;
      coverageLines: Num;
      lintWarnings: Num;
      defectsFound: Num;
      defectDensityPerKloc: Num;
    };
  };
  cost: {
    ai: {
      copilotCalls: number;
      aiCredits: Num;
      premiumRequests: Num;
      inputTokens: number;
      outputTokens: number;
      tokensAreEstimated: boolean;
      aiCost: number;
      humanHours: number;
      humanCost: number;
      totalCost: number;
    };
    human: {
      effortHours: number;
      hourlyRate: number;
      totalCost: number;
      breakdown: Record<string, number>;
    };
    reductionRate: Num;
  };
  delivery: {
    ai: {
      leadTimeHours: number;
      iterations: number;
      maxIterations: number;
      result: RunRecord['result'];
    };
    human: { leadTimeHours: number; calendarDays: Num };
    reductionRate: Num;
  };
}

const lastWith = (gates: GateResult[][], gate: GateResult['gate']) =>
  [...gates]
    .reverse()
    .flat()
    .find((g) => g.gate === gate && g.status !== 'skipped');
const firstWith = (gates: GateResult[][], gate: GateResult['gate']) =>
  gates.flat().find((g) => g.gate === gate && g.status !== 'skipped');
const metric = (g: GateResult | undefined, key: string): Num => (g?.metrics?.[key] ?? null) as Num;
const rate = (ai: number, human: number): Num => (human > 0 ? (human - ai) / human : null);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function calculateQcd(run: RunRecord, human: HumanBaseline, config: AidlcConfig): QcdResult {
  const gates = run.iterations.map((i) => i.gates);
  const firstSub = firstWith(gates, 'subsystem');
  const lastSub = lastWith(gates, 'subsystem');
  const lastUnit = lastWith(gates, 'unit');
  const lastLint = lastWith(gates, 'lint');
  const firstCases = metric(firstSub, 'cases');
  const firstPassed = metric(firstSub, 'passed');
  const defects = firstCases !== null && firstPassed !== null ? firstCases - firstPassed : null;
  const changedLines = Object.entries(run.changeStats ?? {})
    .filter(([zone]) => ['rebuildable', 'extensible', 'deletable'].includes(zone))
    .reduce((sum, [, s]) => sum + s.added, 0);
  const changedKloc = changedLines > 0 ? changedLines / 1000 : null;

  const calls: CopilotCallRecord[] = [
    ...run.iterations.flatMap((i) => i.copilotCalls),
    ...run.postProcess,
  ];
  const realCalls = calls.filter((c) => !c.dryRun);
  const withUsage = realCalls.filter((c) => c.usage);
  const sum = (f: (c: CopilotCallRecord) => number) => calls.reduce((s, c) => s + f(c), 0);
  const aiCredits = withUsage.length
    ? withUsage.reduce((s, c) => s + (c.usage?.aiCredits ?? 0), 0)
    : null;
  const premiumRequests = withUsage.length
    ? withUsage.reduce((s, c) => s + (c.usage?.premiumRequests ?? 0), 0)
    : null;
  const tokensAreEstimated = withUsage.length !== calls.length;
  const inputTokens = sum((c) => c.usage?.inputTokens ?? c.estimatedInputTokens);
  const outputTokens = sum((c) => c.usage?.outputTokens ?? c.estimatedOutputTokens);
  const aiCost =
    (aiCredits ?? 0) * config.qcd.aiCreditUnitCost +
    (premiumRequests ?? 0) * config.qcd.premiumRequestUnitCost;
  const hourlyRate = human.cost.hourlyRate ?? config.qcd.humanHourlyRate;
  const aiHumanHours = Object.values(config.qcd.aiDlcHumanHours).reduce((a, b) => a + b, 0);
  const aiHumanCost = aiHumanHours * config.qcd.humanHourlyRate;
  const humanHours = Object.values(human.cost.effortHours).reduce((a, b) => a + b, 0);
  const humanCost = humanHours * hourlyRate;
  const aiTotal = aiCost + aiHumanCost;

  // Reductions are only meaningful for a real run that passed the final gate.
  const comparable = !run.dryRun && run.result === 'passed';
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const leadTimeHours = (end - Date.parse(run.startedAt)) / 3_600_000;
  return {
    runId: run.runId,
    dryRun: run.dryRun,
    comparable,
    generatedAt: new Date().toISOString(),
    currency: human.cost.currency ?? config.qcd.currency,
    quality: {
      ai: {
        subsystemFirstPassRate: metric(firstSub, 'passRate'),
        subsystemFinalPassRate: metric(lastSub, 'passRate'),
        passRateByIteration: gates.map((g) =>
          metric(
            g.find((x) => x.gate === 'subsystem' && x.status !== 'skipped'),
            'passRate',
          ),
        ),
        coverageStatements: metric(lastUnit, 'coverageStatements'),
        coverageBranches: metric(lastUnit, 'coverageBranches'),
        coverageLines: metric(lastUnit, 'coverageLines'),
        lintWarnings: metric(lastLint, 'warnings'),
        defectsDetected: defects,
        changedKloc: changedKloc === null ? null : round(changedKloc, 3),
        defectDensityPerKloc: defects !== null && changedKloc ? round(defects / changedKloc) : null,
      },
      human: {
        subsystemFirstPassRate: human.quality.subsystemTestFirstPassRate ?? null,
        subsystemFinalPassRate: human.quality.subsystemTestFinalPassRate ?? null,
        coverageLines: human.quality.unitTestCoverage?.lines ?? null,
        lintWarnings: human.quality.staticAnalysisWarnings ?? null,
        defectsFound: human.quality.defectsFound ?? null,
        defectDensityPerKloc:
          human.quality.defectsFound !== undefined && human.quality.sizeKloc
            ? round(human.quality.defectsFound / human.quality.sizeKloc)
            : null,
      },
    },
    cost: {
      ai: {
        copilotCalls: calls.length,
        aiCredits,
        premiumRequests,
        inputTokens,
        outputTokens,
        tokensAreEstimated,
        aiCost: round(aiCost),
        humanHours: aiHumanHours,
        humanCost: round(aiHumanCost),
        totalCost: round(aiTotal),
      },
      human: {
        effortHours: humanHours,
        hourlyRate,
        totalCost: round(humanCost),
        breakdown: human.cost.effortHours,
      },
      reductionRate: comparable ? rate(aiTotal, humanCost) : null,
    },
    delivery: {
      ai: {
        leadTimeHours: round(leadTimeHours, 3),
        iterations: run.iterations.length,
        maxIterations: run.maxIterations,
        result: run.result,
      },
      human: {
        leadTimeHours: human.delivery.leadTimeHours,
        calendarDays: human.delivery.calendarDays ?? null,
      },
      reductionRate: comparable ? rate(leadTimeHours, human.delivery.leadTimeHours) : null,
    },
  };
}

const L = {
  ja: {
    title: 'QCD 比較レポート（AI-DLC vs 人間開発）',
    dry: '> ⚠ dry-run の結果です。Copilot CLI は呼び出されておらず、数値はハーネスの動作確認用です。',
    notComparable: '> ⚠ 最終品質ゲートを通過していないため、削減率は算出していません（N/A）。',
    item: '指標',
    ai: 'AI-DLC',
    human: '人間開発',
    diff: '差 / 削減率',
    q: 'Quality（品質）',
    c: 'Cost（コスト）',
    d: 'Delivery（納期）',
    firstPass: 'サブシステムテスト初回合格率',
    finalPass: 'サブシステムテスト最終合格率',
    trend: '合格率の推移（イテレーション別）',
    covLines: 'Unit Test カバレッジ（行）',
    covStmts: 'Unit Test カバレッジ（命令）',
    lint: '静的解析の警告数',
    defects: '摘出バグ数（AI: 初回ゲートの不合格ケース数）',
    density: 'バグ密度（件/KLOC）',
    calls: 'Copilot CLI 呼び出し回数',
    credits: 'AI クレジット / プレミアムリクエスト',
    tokens: 'トークン（入力 / 出力）',
    estimated: '推定値を含む',
    aiCost: 'AI 実行コスト',
    humanHours: '人の工数（時間）',
    humanCost: '人のコスト',
    total: '総コスト',
    lead: 'リードタイム（時間）',
    loops: 'ループ回数',
    days: '暦日数',
    result: 'ゲート結果',
    breakdown: '人間開発の工数内訳',
    notes: '算出方法',
    notesBody: [
      'AI コスト = AI クレジット × `qcd.aiCreditUnitCost` + プレミアムリクエスト × `qcd.premiumRequestUnitCost`（`aidlc.config.yaml`）。',
      'AI-DLC の人の工数 = `qcd.aiDlcHumanHours`（インプット配置・レビュー等）。',
      'トークン数は Copilot CLI の `--usage-output-file` の実測値。取得できない呼び出しは文字数 ÷ 4 の推定値。',
      'リードタイム = ループ開始から事後処理（リバース設計書生成）完了まで。',
      '削減率 = (人間 − AI) ÷ 人間。正の値は AI-DLC が少ない（良い）ことを示す。',
    ],
  },
  en: {
    title: 'QCD comparison report (AI-DLC vs human development)',
    dry: '> ⚠ Dry-run result. Copilot CLI was not called; the numbers only validate the harness.',
    notComparable:
      '> ⚠ The final quality gate was not passed, so reductions are not calculated (N/A).',
    item: 'Metric',
    ai: 'AI-DLC',
    human: 'Human',
    diff: 'Delta / reduction',
    q: 'Quality',
    c: 'Cost',
    d: 'Delivery',
    firstPass: 'Subsystem test first pass rate',
    finalPass: 'Subsystem test final pass rate',
    trend: 'Pass rate per iteration',
    covLines: 'Unit test coverage (lines)',
    covStmts: 'Unit test coverage (statements)',
    lint: 'Static analysis warnings',
    defects: 'Defects found (AI: failing cases at the first gate)',
    density: 'Defect density (per KLOC)',
    calls: 'Copilot CLI calls',
    credits: 'AI credits / premium requests',
    tokens: 'Tokens (input / output)',
    estimated: 'includes estimates',
    aiCost: 'AI execution cost',
    humanHours: 'Human effort (hours)',
    humanCost: 'Human cost',
    total: 'Total cost',
    lead: 'Lead time (hours)',
    loops: 'Iterations',
    days: 'Calendar days',
    result: 'Gate result',
    breakdown: 'Human effort breakdown',
    notes: 'Method',
    notesBody: [
      'AI cost = AI credits × `qcd.aiCreditUnitCost` + premium requests × `qcd.premiumRequestUnitCost` (`aidlc.config.yaml`).',
      'AI-DLC human effort = `qcd.aiDlcHumanHours` (input preparation, review, ...).',
      'Tokens come from Copilot CLI `--usage-output-file`; calls without usage data use characters ÷ 4.',
      'Lead time = from loop start until post-processing (reverse docs) finished.',
      'Reduction = (human − AI) ÷ human. Positive means AI-DLC needed less.',
    ],
  },
} as const;

const pct = (n: Num) => (n === null ? 'N/A' : `${(n * 100).toFixed(1)}%`);
const num = (n: Num, d = 2) =>
  n === null ? 'N/A' : n.toLocaleString('en-US', { maximumFractionDigits: d });
const covPct = (n: Num) => (n === null ? 'N/A' : `${n.toFixed(1)}%`);

export function renderQcdMarkdown(r: QcdResult, language: 'ja' | 'en'): string {
  const t = L[language];
  const money = (n: number) =>
    `${r.currency} ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const humanCovLines = r.quality.human.coverageLines;
  const rows = (items: [string, string, string, string][]) =>
    [
      `| ${t.item} | ${t.ai} | ${t.human} | ${t.diff} |`,
      '| --- | ---: | ---: | ---: |',
      ...items.map((i) => `| ${i.join(' | ')} |`),
    ].join('\n');
  const diffPct = (a: Num, h: Num) =>
    a === null || h === null ? '—' : `${((a - h) * 100).toFixed(1)} pt`;
  const out = [
    `# ${t.title}`,
    '',
    `- Run: \`${r.runId}\` / ${r.generatedAt}`,
    r.dryRun ? `\n${t.dry}` : '',
    r.comparable ? '' : `\n${t.notComparable}`,
    '',
    `## ${t.q}`,
    '',
    rows([
      [
        t.firstPass,
        pct(r.quality.ai.subsystemFirstPassRate),
        pct(r.quality.human.subsystemFirstPassRate),
        diffPct(r.quality.ai.subsystemFirstPassRate, r.quality.human.subsystemFirstPassRate),
      ],
      [
        t.finalPass,
        pct(r.quality.ai.subsystemFinalPassRate),
        pct(r.quality.human.subsystemFinalPassRate),
        diffPct(r.quality.ai.subsystemFinalPassRate, r.quality.human.subsystemFinalPassRate),
      ],
      [
        t.covLines,
        covPct(r.quality.ai.coverageLines),
        covPct(humanCovLines),
        r.quality.ai.coverageLines !== null && humanCovLines !== null
          ? `${(r.quality.ai.coverageLines - humanCovLines).toFixed(1)} pt`
          : '—',
      ],
      [t.covStmts, covPct(r.quality.ai.coverageStatements), 'N/A', '—'],
      [t.lint, num(r.quality.ai.lintWarnings, 0), num(r.quality.human.lintWarnings, 0), '—'],
      [t.defects, num(r.quality.ai.defectsDetected, 0), num(r.quality.human.defectsFound, 0), '—'],
      [
        t.density,
        num(r.quality.ai.defectDensityPerKloc),
        num(r.quality.human.defectDensityPerKloc),
        '—',
      ],
    ]),
    '',
    `${t.trend}: ${r.quality.ai.passRateByIteration.map((p, i) => `#${i + 1} ${pct(p)}`).join(' → ') || 'N/A'}`,
    '',
    `## ${t.c}`,
    '',
    rows([
      [t.calls, num(r.cost.ai.copilotCalls, 0), '—', '—'],
      [t.credits, `${num(r.cost.ai.aiCredits)} / ${num(r.cost.ai.premiumRequests)}`, '—', '—'],
      [
        t.tokens,
        `${num(r.cost.ai.inputTokens, 0)} / ${num(r.cost.ai.outputTokens, 0)}${r.cost.ai.tokensAreEstimated ? ` (${t.estimated})` : ''}`,
        '—',
        '—',
      ],
      [t.aiCost, money(r.cost.ai.aiCost), '—', '—'],
      [t.humanHours, num(r.cost.ai.humanHours), num(r.cost.human.effortHours), '—'],
      [t.humanCost, money(r.cost.ai.humanCost), money(r.cost.human.totalCost), '—'],
      [
        `**${t.total}**`,
        `**${money(r.cost.ai.totalCost)}**`,
        `**${money(r.cost.human.totalCost)}**`,
        `**${pct(r.cost.reductionRate)}**`,
      ],
    ]),
    '',
    `${t.breakdown}: ${Object.entries(r.cost.human.breakdown)
      .map(([k, v]) => `${k} ${v}h`)
      .join(', ')}`,
    '',
    `## ${t.d}`,
    '',
    rows([
      [
        `**${t.lead}**`,
        `**${num(r.delivery.ai.leadTimeHours, 3)}**`,
        `**${num(r.delivery.human.leadTimeHours)}**`,
        `**${pct(r.delivery.reductionRate)}**`,
      ],
      [t.loops, `${r.delivery.ai.iterations} / ${r.delivery.ai.maxIterations}`, '—', '—'],
      [t.days, '—', num(r.delivery.human.calendarDays, 1), '—'],
      [t.result, r.delivery.ai.result, '—', '—'],
    ]),
    '',
    `## ${t.notes}`,
    '',
    ...t.notesBody.map((n) => `- ${n}`),
    '',
  ];
  return out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

export function selectRun(runs: RunRecord[], runId?: string): RunRecord | undefined {
  if (runId) return runs.find((r) => r.runId === runId);
  return [...runs].reverse().find((r) => r.mode === 'full-loop');
}

export function writeQcdReport(
  paths: AidlcPaths,
  config: AidlcConfig,
  runId?: string,
): { md: string; json: string; result: QcdResult } {
  const run = selectRun(readRunHistory(paths.runHistory).runs, runId);
  if (!run)
    throw new Error(
      `No full-loop run in ${rel(paths.root, paths.runHistory)}${runId ? ` with id ${runId}` : ''}. Run \`npm run aidlc:run\` first.`,
    );
  const baselineFile = path.join(paths.inputs.humanBaseline, 'human-qcd.json');
  if (!existsSync(baselineFile))
    throw new Error(`Human baseline not found: ${rel(paths.root, baselineFile)}`);
  const parsed = humanBaselineSchema.safeParse(JSON.parse(readFileSync(baselineFile, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      `Invalid human-qcd.json:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  const result = calculateQcd(run, parsed.data, config);
  mkdirSync(paths.outputs.reports, { recursive: true });
  const md = path.join(paths.outputs.reports, 'qcd-comparison-report.md');
  const json = path.join(paths.outputs.reports, 'qcd-comparison-report.json');
  writeFileSync(md, renderQcdMarkdown(result, config.output.language), 'utf8');
  writeJsonAtomic(json, result);
  return { md, json, result };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { 'run-id': { type: 'string' } } });
  const root = findRepoRoot();
  const paths = resolvePaths(root);
  const config = loadConfig(paths.config);
  await enforceSandbox(config, 'aidlc:qcd', 'tool');
  const { md, result } = writeQcdReport(paths, config, values['run-id']);
  log.info(`QCD report: ${rel(root, md)}`);
  log.info(
    `Cost reduction ${pct(result.cost.reductionRate)}, lead time reduction ${pct(result.delivery.reductionRate)}`,
  );
  return 0;
}

if (isMain(import.meta.url)) {
  runCli(main);
}
