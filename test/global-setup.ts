import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The CLI tests run the built bin, so build once before any test file starts. */
export default function setup() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsup', '--silent'], { cwd: root, stdio: 'inherit' });
}
