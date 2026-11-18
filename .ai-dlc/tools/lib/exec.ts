import spawn from 'cross-spawn';

export interface ExecResult {
  command: string[];
  exitCode: number;
  /** Combined stdout + stderr in arrival order. */
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Mirror the child output to this process (for long-running gates). */
  echo?: boolean;
  /** Keep only the last N characters of output in memory. */
  maxOutputChars?: number;
}

/**
 * Runs a command without a shell (arguments are never re-parsed) and captures its output.
 * `cross-spawn` resolves `.cmd` shims on Windows (npx, ng, copilot).
 */
export function exec(command: readonly string[], options: ExecOptions): Promise<ExecResult> {
  const [file, ...args] = command;
  if (!file) {
    return Promise.reject(new Error('exec: empty command'));
  }
  const started = Date.now();
  const max = options.maxOutputChars ?? 2_000_000;
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const append = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (options.echo) {
        process.stdout.write(text);
      }
      output += text;
      if (output.length > max) {
        output = output.slice(output.length - max);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, options.timeoutMs)
        : undefined;
    const finish = (exitCode: number) => {
      if (timer) clearTimeout(timer);
      resolve({
        command: [...command],
        exitCode,
        output,
        durationMs: Date.now() - started,
        timedOut,
      });
    };
    child.on('error', (error) => {
      output += `\n[exec] ${error.message}\n`;
      finish(127);
    });
    child.on('close', (code) => finish(timedOut ? 124 : (code ?? 1)));
  });
}

/** Removes ANSI escape sequences from tool output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Returns the last `lines` lines of a text block. */
export function tail(text: string, lines: number): string {
  const all = text.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}
