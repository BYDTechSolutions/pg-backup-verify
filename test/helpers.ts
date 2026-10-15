import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built CLI. `onStderr` sees stderr as it arrives, with the child,
 * so a test can send it a signal at the right moment.
 */
export function runCli(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; onStderr?: (soFar: string, child: ReturnType<typeof spawn>) => void } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...opts.env };
    delete env.FORCE_COLOR;
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      opts.onStderr?.(stderr, child);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export const has = (cmd: string, args = ['--version']) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 });
  return r.status === 0 ? r.stdout : null;
};
