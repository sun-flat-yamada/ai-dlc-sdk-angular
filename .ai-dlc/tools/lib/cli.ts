import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when the module at `metaUrl` is the entry point (`tsx file.ts`), not an import. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Runs an async CLI main function and maps errors to exit code 2. */
export function runCli(main: () => Promise<number>): void {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`[ai-dlc] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}

/** Repository-relative POSIX path for display and for git. */
export function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export const log = {
  info: (msg: string) => console.log(`[ai-dlc] ${msg}`),
  warn: (msg: string) => console.warn(`[ai-dlc] WARN ${msg}`),
  step: (msg: string) => console.log(`\n[ai-dlc] ── ${msg}`),
};
