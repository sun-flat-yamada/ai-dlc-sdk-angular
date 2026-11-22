/**
 * Structural (AST) check of the generated subsystem tests (issue #18), run by Gate 4 before Playwright.
 * Together with the verification records written at run time by the subsystem kit and the one-time
 * mutation check, it makes sure that the agent's tests really check what the Excel cases expect:
 *
 *   - cases are loaded with `loadCase('<literal ID>')`; `test` and the helpers come from the kit,
 *   - no `.skip` / `.fixme` / `.only`, no `waitForTimeout`, no `force: true`, no annotations,
 *   - every kit assertion is awaited and runs unconditionally: no `if`, `?:`, `&&` / `||`, `switch`,
 *     `catch` or helper function between it and the test body (only `test.step` / `expectUi` callbacks),
 *   - every `expectUi(c, i, …)` callback contains a real assertion (`expect(…).matcher(…)` or
 *     `expectNoRequest`),
 *   - for every case: `expectApiRequests(…, c)` when it has expectedApi, `expectCss(…, c)` when it has
 *     expectedCss and `expectUi(c, i, …)` for every expectedUi line `i`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { SubsystemCase } from './subsystem-cases.js';
import type { GateFailure } from './telemetry.js';

const KIT_MODULE = /(^|\/)tools\/subsystem-kit(\.js|\.ts)?$/;
const KIT_ASSERTIONS = new Set(['expectApiRequests', 'expectCss', 'expectUi', 'expectNoRequest']);

interface Found {
  api: Set<string>;
  css: Set<string>;
  ui: Set<string>;
}

export interface StructureReport {
  problems: GateFailure[];
  /** Case IDs loaded by at least one test file. */
  loaded: Set<string>;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** `test(...)`, `test.describe(...)`, `test.step(...)` style calls on the identifier `test`. */
function testCallKind(call: ts.CallExpression): 'test' | 'step' | 'describe' | 'hook' | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e) && e.text === 'test') return 'test';
  if (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === 'test'
  ) {
    const n = e.name.text;
    if (n === 'step') return 'step';
    if (n === 'describe') return 'describe';
    if (['beforeEach', 'afterEach', 'beforeAll', 'afterAll'].includes(n)) return 'hook';
  }
  if (
    ts.isPropertyAccessExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    ts.isIdentifier(e.expression.expression) &&
    e.expression.expression.text === 'test' &&
    e.expression.name.text === 'describe'
  )
    return 'describe';
  return undefined;
}

const isFunction = (n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/** True when `fn` is the callback argument of a test, test.step or expectUi call. */
function isAllowedCallback(fn: ts.Node): boolean {
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(fn as ts.Expression))
    return false;
  const kind = testCallKind(call);
  return kind === 'test' || kind === 'step' || calleeName(call) === 'expectUi';
}

/** Why `node` does not run unconditionally inside its test, or undefined when it does. */
function conditionalReason(node: ts.Node): string | undefined {
  let child: ts.Node = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    if (ts.isIfStatement(p) && child !== p.expression) return 'inside an `if`';
    if (ts.isConditionalExpression(p) && child !== p.condition) return 'inside `?:`';
    if (
      ts.isBinaryExpression(p) &&
      child === p.right &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(p.operatorToken.kind)
    )
      return 'behind `&&` / `||` / `??`';
    if (ts.isSwitchStatement(p)) return 'inside a `switch`';
    if (ts.isCatchClause(p)) return 'inside a `catch`';
    if (
      ts.isForStatement(p) ||
      ts.isForInStatement(p) ||
      ts.isForOfStatement(p) ||
      ts.isWhileStatement(p) ||
      ts.isDoStatement(p)
    )
      return 'inside a loop';
    if (isFunction(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) {
      if (!isAllowedCallback(p)) return 'inside a helper function';
      if (p.parent && ts.isCallExpression(p.parent) && testCallKind(p.parent) === 'test')
        return undefined;
    }
  }
  return 'outside a test';
}

function isAwaited(call: ts.CallExpression): boolean {
  let n: ts.Node = call;
  while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (!p) return false;
  if (ts.isAwaitExpression(p) || ts.isReturnStatement(p)) return true;
  return ts.isArrowFunction(p) && p.body === n;
}

/** True when the callback contains `expect(…).<matcher>(…)` (also `.not.` / `.soft`) or expectNoRequest. */
function hasAssertion(fn: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      if (calleeName(n) === 'expectNoRequest') found = true;
      // matcher call: <expect(...)[.not|.soft…]>.<matcher>(...)
      let target: ts.Expression = n.expression;
      if (ts.isPropertyAccessExpression(target)) {
        target = target.expression;
        while (ts.isPropertyAccessExpression(target)) target = target.expression;
        if (ts.isCallExpression(target)) {
          const inner = target.expression;
          const name = ts.isIdentifier(inner)
            ? inner.text
            : ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.expression)
              ? inner.expression.text
              : '';
          if (name === 'expect') found = true;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

export function analyzeTestFile(
  file: string,
  text: string,
  cases: ReadonlyMap<string, SubsystemCase>,
  found: Map<string, Found>,
  loaded: Set<string>,
): GateFailure[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: GateFailure[] = [];
  const at = (node: ts.Node, message: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    problems.push({ where: `${file}:${line + 1}`, message });
  };
  const caseVars = new Map<string, string>();
  const entry = (id: string) => {
    let f = found.get(id);
    if (!f) found.set(id, (f = { api: new Set(), css: new Set(), ui: new Set() }));
    return f;
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      const names =
        node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
          ? node.importClause.namedBindings.elements.map((e) => (e.propertyName ?? e.name).text)
          : [];
      if (from === '@playwright/test' && names.includes('test'))
        at(
          node,
          'Import `test` from the subsystem kit (`../../../tools/subsystem-kit`), not from @playwright/test.',
        );
      if (!KIT_MODULE.test(from) && names.some((n) => KIT_ASSERTIONS.has(n) || n === 'loadCase'))
        at(
          node,
          `Import the subsystem kit helpers from \`../../../tools/subsystem-kit\`, not from "${from}".`,
        );
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      if (calleeName(node.initializer) === 'loadCase') {
        const arg = node.initializer.arguments[0];
        if (!arg || !ts.isStringLiteralLike(arg) || !ts.isIdentifier(node.name)) {
          at(node, "Load cases as `const c = loadCase('<case ID>')` with a literal ID.");
        } else if (!cases.has(arg.text)) {
          at(node, `Case ${arg.text} is not in the Excel specification.`);
        } else {
          caseVars.set(node.name.text, arg.text);
          loaded.add(arg.text);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const n = node.name.text;
      if (['skip', 'fixme', 'only', 'fail'].includes(n) && ts.isIdentifier(node.expression))
        at(node, `\`${node.expression.text}.${n}\` is not allowed in subsystem tests.`);
      if (n === 'waitForTimeout')
        at(node, '`waitForTimeout` is not allowed: use web-first assertions.');
      if (n === 'annotations')
        at(
          node,
          'Generated tests must not touch test annotations: the subsystem kit records them.',
        );
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'force' &&
      node.initializer.kind === ts.SyntaxKind.TrueKeyword
    )
      at(node, '`force: true` is not allowed: interact with the element as a user would.');
    if (ts.isStringLiteralLike(node) && /\baidlc-(verified|evaluated|killed)\b/.test(node.text))
      at(node, 'Generated tests must not write the verification records of the subsystem kit.');

    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && KIT_ASSERTIONS.has(name) && ts.isIdentifier(node.expression)) {
        if (!isAwaited(node)) at(node, `\`${name}(…)\` must be awaited (\`await ${name}(…)\`).`);
        const reason = conditionalReason(node);
        if (reason)
          at(node, `\`${name}(…)\` must run unconditionally in the test body, not ${reason}.`);
        const caseArg = name === 'expectUi' ? node.arguments[0] : node.arguments[1];
        const id = caseArg && ts.isIdentifier(caseArg) ? caseVars.get(caseArg.text) : undefined;
        if (name !== 'expectNoRequest' && !id) {
          at(node, `\`${name}(…)\` must receive a case loaded with loadCase('<case ID>').`);
        } else if (id && !reason) {
          const c = cases.get(id)!;
          if (name === 'expectApiRequests') entry(id).api.add('all');
          if (name === 'expectCss') entry(id).css.add('all');
          if (name === 'expectUi') {
            const index = node.arguments[1];
            const callback = node.arguments[2];
            if (!index || !ts.isNumericLiteral(index)) {
              at(
                node,
                '`expectUi(c, <index>, …)` needs the expectedUi line index as a number literal.',
              );
            } else if (Number(index.text) >= c.expectedUi.length) {
              at(node, `${id} has no expectedUi[${index.text}] (${c.expectedUi.length} line(s)).`);
            } else if (!callback || !isFunction(callback) || !hasAssertion(callback)) {
              at(
                node,
                `expectUi(${caseArg!.getText(source)}, ${index.text}, …) must contain an assertion for "${c.expectedUi[Number(index.text)]}" (expect(…).toHaveText(…), toBeDisabled(), …).`,
              );
            } else {
              entry(id).ui.add(index.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/** Runs the structural check over the spec files and checks that every expectation is asserted. */
export function analyzeGeneratedTests(
  root: string,
  specFiles: readonly string[],
  cases: readonly SubsystemCase[],
): StructureReport {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const found = new Map<string, Found>();
  const loaded = new Set<string>();
  const problems: GateFailure[] = [];
  for (const abs of specFiles) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    problems.push(...analyzeTestFile(rel, readFileSync(abs, 'utf8'), byId, found, loaded));
  }
  for (const c of cases) {
    if (!loaded.has(c.id)) continue; // reported as "No test titled with [ID]" by the gate
    const f = found.get(c.id) ?? { api: new Set(), css: new Set(), ui: new Set() };
    if (c.expectedApi.length && !f.api.size)
      problems.push({
        where: c.id,
        message: 'No unconditional `await expectApiRequests(api, c)` for this case.',
      });
    if (c.expectedCss.length && !f.css.size)
      problems.push({
        where: c.id,
        message: 'No unconditional `await expectCss(page, c)` for this case.',
      });
    c.expectedUi.forEach((line, i) => {
      if (!f.ui.has(String(i)))
        problems.push({
          where: c.id,
          message: `No \`await expectUi(c, ${i}, () => expect(…)…)\` for expectedUi[${i}] "${line}".`,
        });
    });
  }
  return { problems, loaded };
}
