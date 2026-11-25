/**
 * Removing references to deleted deletable files from extensible files (issue #20).
 *
 * Extensible files are append-only, but they can reference code in the deletable zone, for example
 * the lazy route of a legacy screen in `app.routes.ts` and its menu entry in `home-page.ts`. When the
 * legacy files are deleted, those references must go too, or the build breaks. This module finds the
 * syntactic units of an extensible file that only exist for deleted files:
 *
 *   1. import / export declarations whose relative module specifier resolves to a deleted file,
 *   2. the array element (or, outside arrays, the top-level statement) around a dynamic `import()` of
 *      a deleted file,
 *   3. array elements and top-level statements that use an identifier imported from a deleted file or
 *      declared by a removed top-level statement,
 *   4. array elements that mention the route path of a removed route object (one with
 *      `path: '<segment>'` found by 1-3), such as `{ route: '/network-legacy' }` in a menu.
 *
 * The change is accepted when every baseline line outside those units (and apart from blank lines)
 * is still present, in order, in the new file. The units may be removed or rewritten; every other
 * existing line must stay, so the file is still append-only apart from the dead references.
 * Units must start and end on their own lines; anything sharing a line with other code fails closed.
 *
 * Pure functions: the caller reads the file contents from git.
 */
import path from 'node:path';
import ts from 'typescript';

export interface ExtensibleFileVersions {
  /** Repository-relative POSIX path. */
  path: string;
  baseline: string;
  current: string;
}

export interface ReferenceUnit {
  /** 1-based baseline lines covered by the unit (including its own-line leading comments). */
  startLine: number;
  endLine: number;
  /** Why the unit may go, e.g. `imports src/app/features/legacy-x/page.ts`. */
  reason: string;
  /** False when the unit's text is still present unchanged in the new file. */
  removed: boolean;
}

export interface ReferenceRemoval {
  path: string;
  /** True when all removed baseline lines are inside reference units (or blank). */
  allowed: boolean;
  units: ReferenceUnit[];
  /** First baseline line that is missing from the new file and not part of a unit. */
  firstUnexplainedLine?: number;
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Resolves a relative module specifier of `from` to the repository paths it could denote. */
export function moduleCandidates(from: string, specifier: string): string[] {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return [];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
  return [
    base,
    ...EXTENSIONS.map((e) => `${stem}${e}`),
    ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ];
}

interface Candidate {
  node: ts.Node;
  reason: string;
}

interface Parsed {
  file: ExtensibleFileVersions;
  sf: ts.SourceFile;
  /** Units keyed by node, so each node is reported once. */
  units: Map<ts.Node, Candidate>;
  dead: Set<string>;
}

/** The array element around `node`, or else the top-level statement around it. */
function enclosingUnit(node: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (n.parent && ts.isArrayLiteralExpression(n.parent)) return n;
    if (n.parent && ts.isSourceFile(n.parent)) return n;
  }
  return undefined;
}

function stringValue(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

/** Names declared by a top-level statement (`const X`, `function f`, `class C`, ...). */
function declaredNames(node: ts.Node): string[] {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    );
  }
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)) &&
    node.name
  ) {
    return [node.name.text];
  }
  return [];
}

/** Names bound by an import declaration. */
function importedNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (!clause) return [];
  const names = clause.name ? [clause.name.text] : [];
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  if (bindings && ts.isNamedImports(bindings))
    names.push(...bindings.elements.map((e) => e.name.text));
  return names;
}

/** True when the identifier is a use of a binding (not a property name or a declaration name). */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isQualifiedName(p) && p.right === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  return true;
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function addUnit(parsed: Parsed, node: ts.Node | undefined, reason: string): boolean {
  if (!node || parsed.units.has(node)) return false;
  // A unit inside a unit adds nothing.
  for (let n = node.parent; n; n = n.parent) if (parsed.units.has(n)) return false;
  parsed.units.set(node, { node, reason });
  if (node.parent && ts.isSourceFile(node.parent)) {
    for (const name of declaredNames(node)) parsed.dead.add(name);
  }
  return true;
}

function routePath(node: ts.Node): string | undefined {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'path') {
      const value = stringValue(p.initializer);
      return value && value !== '**' ? value.replace(/^\/+|\/+$/g, '') : undefined;
    }
  }
  return undefined;
}

function mentionsRoute(value: string, route: string): boolean {
  const v = value.replace(/^\/+/, '').split(/[?#]/)[0] ?? '';
  return v === route || v.startsWith(`${route}/`);
}

/** Baseline line span of a unit, or undefined when the unit shares a line with other code. */
function lineSpan(sf: ts.SourceFile, node: ts.Node): { start: number; end: number } | undefined {
  const text = sf.text;
  const ownLine = (pos: number) =>
    /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos));
  let start = node.getStart(sf);
  for (const c of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) {
    if (ownLine(c.pos)) {
      start = c.pos;
      break;
    }
  }
  if (!ownLine(start)) return undefined;
  const end = node.getEnd();
  const lineEnd = text.indexOf('\n', end);
  const rest = text.slice(end, lineEnd < 0 ? text.length : lineEnd);
  if (!/^\s*,?\s*(?:\/\/.*|\/\*.*\*\/\s*)?$/.test(rest)) return undefined;
  return {
    start: sf.getLineAndCharacterOfPosition(start).line + 1,
    end: sf.getLineAndCharacterOfPosition(end).line + 1,
  };
}

function splitLines(text: string): string[] {
  return text.split('\n');
}

/**
 * Decides, for each modified extensible file, whether its removed lines only remove references to
 * `deletedFiles` (deleted files of the deletable zone).
 */
export function explainReferenceRemovals(
  files: readonly ExtensibleFileVersions[],
  deletedFiles: ReadonlySet<string>,
): Map<string, ReferenceRemoval> {
  const parsed: Parsed[] = files
    .filter((f) => SCRIPT.test(f.path))
    .map((file) => ({
      file,
      sf: ts.createSourceFile(file.path, file.baseline, ts.ScriptTarget.Latest, true),
      units: new Map(),
      dead: new Set(),
    }));
  const isDeleted = (from: string, spec: string) =>
    moduleCandidates(from, spec).some((c) => deletedFiles.has(c));

  // 1 + 2: direct references to deleted files.
  for (const p of parsed) {
    visit(p.sf, (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isDeleted(p.file.path, node.moduleSpecifier.text)
      ) {
        addUnit(p, node, `imports ${node.moduleSpecifier.text}`);
        if (ts.isImportDeclaration(node)) for (const n of importedNames(node)) p.dead.add(n);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        isDeleted(p.file.path, stringValue(node.arguments[0]) ?? '')
      ) {
        addUnit(p, enclosingUnit(node), `loads ${stringValue(node.arguments[0])}`);
      }
    });
  }

  // Route paths still defined somewhere in the new versions: those routes were not removed.
  const remaining = new Set<string>();
  for (const p of parsed) {
    const sf = ts.createSourceFile(p.file.path, p.file.current, ts.ScriptTarget.Latest, true);
    visit(sf, (node) => {
      const route = routePath(node);
      if (route !== undefined) remaining.add(route);
    });
  }

  // 3 + 4: uses of dead bindings and of removed routes, until nothing changes.
  const routes = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const p of parsed) {
      for (const unit of p.units.values()) {
        const route = routePath(unit.node);
        if (route && !remaining.has(route) && !routes.has(route)) {
          routes.add(route);
          changed = true;
        }
      }
    }
    for (const p of parsed) {
      visit(p.sf, (node) => {
        if (ts.isIdentifier(node) && p.dead.has(node.text) && isReference(node)) {
          const unit = enclosingUnit(node);
          changed = addUnit(p, unit, `uses ${node.text}`) || changed;
        }
        const value = stringValue(node);
        if (value !== undefined) {
          const route = [...routes].find((r) => mentionsRoute(value, r));
          const unit = enclosingUnit(node);
          if (route !== undefined && unit?.parent && ts.isArrayLiteralExpression(unit.parent)) {
            changed = addUnit(p, unit, `links to the removed route '${route}'`) || changed;
          }
        }
      });
    }
  }

  const result = new Map<string, ReferenceRemoval>();
  for (const p of parsed) {
    const units: ReferenceUnit[] = [];
    const covered = new Set<number>();
    for (const u of p.units.values()) {
      const span = lineSpan(p.sf, u.node);
      if (!span) continue;
      for (let l = span.start; l <= span.end; l++) covered.add(l);
      units.push({
        startLine: span.start,
        endLine: span.end,
        reason: u.reason,
        removed: !p.file.current.includes(u.node.getText(p.sf)),
      });
    }
    units.sort((a, b) => a.startLine - b.startLine);
    // Every other non-blank baseline line must still be there, in order (append-only).
    const current = splitLines(p.file.current);
    let at = 0;
    let firstUnexplainedLine: number | undefined;
    splitLines(p.file.baseline).forEach((line, i) => {
      if (firstUnexplainedLine !== undefined) return;
      if (covered.has(i + 1) || (units.length && !line.trim())) return;
      while (at < current.length && current[at] !== line) at++;
      if (at < current.length) at++;
      else firstUnexplainedLine = i + 1;
    });
    result.set(p.file.path, {
      path: p.file.path,
      allowed: units.length > 0 && firstUnexplainedLine === undefined,
      units,
      ...(firstUnexplainedLine !== undefined ? { firstUnexplainedLine } : {}),
    });
  }
  return result;
}
