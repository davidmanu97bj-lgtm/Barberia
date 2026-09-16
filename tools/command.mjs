import { spawnSync } from 'node:child_process';

export function command(executable, args, cwd, capture = false) {
  const result = spawnSync(executable, args, {
    cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: 16 * 1024 * 1024, shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} falló (${result.status}). ${result.stderr || ''}`);
  return (result.stdout || '').trim();
}
