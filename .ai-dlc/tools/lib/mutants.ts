/**
 * Mutants for the one-time mutation check of Gate 4 (issue #18). Each mutant breaks the running app
 * in the browser in one way that the steps of a test do not depend on (texts, input values, the
 * disabled / checked state, URL changes) or, for `request`, makes `expectNoRequest` see a request.
 * A test that still passes under a mutant does not check what its expectation line says.
 *
 * `installMutant` runs in the browser (page.addInitScript): it must not reference anything outside.
 */
export const MUTANTS = ['text', 'value', 'disabled', 'checked', 'navigation', 'request'] as const;
export type Mutant = (typeof MUTANTS)[number];

/** Annotation types the kit records in mutation runs. */
export const EVALUATED_ANNOTATION = 'aidlc-evaluated';
export const KILLED_ANNOTATION = 'aidlc-killed';

/** Mark appended to texts and input values by the `text` and `value` mutants. */
export const MUTATION_MARK = '※';

export function installMutant(kind: string): void {
  const mark = '※';
  const w = window as unknown as Window & typeof globalThis;
  const patchSetter = (
    proto: object,
    prop: string,
    map: (el: HTMLElement, value: unknown) => unknown,
  ) => {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.set || !desc.get) return;
    const set = desc.set;
    Object.defineProperty(proto, prop, {
      ...desc,
      set(this: HTMLElement, value: unknown) {
        set.call(this, map(this, value));
      },
    });
  };
  if (kind === 'text') {
    const touch = (node: Node) => {
      if (node.nodeType !== Node.TEXT_NODE) return;
      const parent = node.parentElement;
      const text = node.nodeValue ?? '';
      if (parent?.closest('[data-ui-id]') && text.trim() && !text.endsWith(mark))
        node.nodeValue = text + mark;
    };
    const walk = (root: Node) => {
      const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = it.nextNode(); n; n = it.nextNode()) touch(n);
    };
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') touch(r.target);
        r.addedNodes.forEach((n) => (n.nodeType === Node.TEXT_NODE ? touch(n) : walk(n)));
        if (r.type === 'attributes') walk(r.target);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-ui-id'],
    });
  } else if (kind === 'value') {
    patchSetter(w.HTMLInputElement.prototype, 'value', (_el, v) =>
      typeof v === 'string' && v !== '' && !v.endsWith(mark) ? v + mark : v,
    );
  } else if (kind === 'disabled') {
    for (const C of [
      w.HTMLButtonElement,
      w.HTMLInputElement,
      w.HTMLSelectElement,
      w.HTMLTextAreaElement,
    ])
      patchSetter(C.prototype, 'disabled', () => false);
    const setAttribute = w.Element.prototype.setAttribute;
    w.Element.prototype.setAttribute = function (name: string, value: string) {
      if (name.toLowerCase() === 'disabled' || name.toLowerCase() === 'aria-disabled') return;
      setAttribute.call(this, name, value);
    };
  } else if (kind === 'checked') {
    patchSetter(w.HTMLInputElement.prototype, 'checked', (_el, v) => !v);
    const setAttribute = w.Element.prototype.setAttribute;
    w.Element.prototype.setAttribute = function (name: string, value: string) {
      const n = name.toLowerCase();
      if (n === 'aria-checked' || n === 'aria-pressed')
        value = value === 'true' ? 'false' : value === 'false' ? 'true' : value;
      setAttribute.call(this, name, value);
    };
  } else if (kind === 'navigation') {
    w.history.pushState = () => undefined;
    w.history.replaceState = () => undefined;
  }
}
