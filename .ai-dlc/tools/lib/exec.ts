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
  /** Written to the child's stdin (otherwise stdin is closed). */
  input?: string;
  /**
   * POSIX only: start the child in its own process group and kill the whole group when the child
   * exits or times out, so that no grandchild (a background server, a watcher) outlives the call.
   */
  killProcessGroup?: boolean;
}

/** Sends SIGKILL to the process group `pgid` (ignored when it no longer exists). */
export function killGroup(pgid: number | undefined): void {
  if (!pgid || process.platform === 'win32') return;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // ESRCH: the group is already gone.
  }
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
  const group = options.killProcessGroup === true && process.platform !== 'win32';
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: group,
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
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            if (group) killGroup(child.pid);
            else child.kill('SIGTERM');
          }, options.timeoutMs)
        : undefined;
    const finish = (exitCode: number) => {
      if (timer) clearTimeout(timer);
      if (group) killGroup(child.pid);
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
    // Grandchildren holding the output pipes would delay 'close' until they exit: end them now.
    if (group) child.on('exit', () => killGroup(child.pid));
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
