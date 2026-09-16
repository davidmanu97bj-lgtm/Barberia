import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, PROJECT_ID, assertNode22, buildHosting } from './project.mjs';
import { command } from './command.mjs';

const FIREBASE_CLI_VERSION = '15.30.0';
const REMOTES = new Set([
  'https://github.com/davidmanu97bj-lgtm/Barberia.git',
  'https://github.com/davidmanu97bj-lgtm/Barberia',
  'git@github.com:davidmanu97bj-lgtm/Barberia.git'
]);
const SCOPES = new Set(['all', 'hosting', 'backend']);

export function parseArguments(args) {
  if (!args.length || (args.length === 1 && args[0] === '--validate')) return { deploy: false };
  const interactiveCount = args.filter(arg => arg === '--interactive').length;
  args = args.filter(arg => arg !== '--interactive');
  if (args[0] !== '--deploy' || !/^[a-f0-9]{40}$/.test(args[1] || '') ||
      interactiveCount > 1 || ![2, 4].includes(args.length) || (args.length === 4 && (args[2] !== '--only' || !SCOPES.has(args[3])))) {
    throw new Error('Uso: npm run deploy -- --deploy <commit SHA de 40 caracteres> [--only all|hosting|backend] [--interactive]. Sin argumentos solo valida.');
  }
  return { deploy: true, sha: args[1], scope: args[3] || 'all', interactive: interactiveCount === 1 };
}

export function verifyRelease(root, sha, run = command) {
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Se requiere un commit completo.');
  const gitRoot = run('git', ['rev-parse', '--show-toplevel'], root, true);
  if (path.resolve(gitRoot) !== path.resolve(root)) throw new Error('Ejecuta desde el repositorio de Explora.');
  const remote = run('git', ['remote', 'get-url', 'origin'], root, true);
  if (!REMOTES.has(remote)) throw new Error('origin no es el repositorio autorizado de Explora.');
  if (run('git', ['status', '--porcelain', '--untracked-files=all'], root, true)) {
    throw new Error('Hay cambios sin confirmar. Guarda y sube el trabajo antes de publicar.');
  }
  if (run('git', ['rev-parse', 'HEAD'], root, true) !== sha) throw new Error('HEAD no coincide con el commit solicitado.');
  const advertised = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], root, true);
  if (advertised.split(/\s+/)[0] !== sha) throw new Error('El commit debe coincidir con main en GitHub.');
}

function npmCli() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!cli) throw new Error('No encuentro npm. Ejecuta mediante npm run deploy.');
  return cli;
}

export function deploySnapshot(snapshot, { sha, scope = 'all', interactive = false, npm = npmCli(), run = command, build = buildHosting, beforePublish = () => {}, progress = () => {} }) {
  if (!SCOPES.has(scope)) throw new Error('Alcance de despliegue inválido.');
  // Fiscal integration tests require the pinned backend dependencies even for Hosting validation.
  run(process.execPath, [npm, 'ci', '--prefix', 'functions', '--ignore-scripts', '--no-audit', '--no-fund'], snapshot);
  progress('dependencies');
  run(process.execPath, ['tools/check.mjs'], snapshot);
  progress('validation');
  if (scope !== 'backend') build(snapshot, sha);
  const stages = scope === 'hosting' ? ['hosting'] : scope === 'backend'
    ? ['firestore:rules,firestore:indexes,storage', 'functions'] : ['firestore:rules,firestore:indexes,storage', 'functions', 'hosting'];
  for (const stage of stages) {
    beforePublish();
    run(process.execPath, [npm, 'exec', '--yes', `--package=firebase-tools@${FIREBASE_CLI_VERSION}`, '--',
      'firebase', 'deploy', '--project', PROJECT_ID, '--config', 'firebase.json',
      '--only', stage, interactive && stage === 'functions' ? '--interactive' : '--non-interactive', '--message', `GitHub main ${sha}`], snapshot);
    progress(stage);
  }
}

export function main(args = process.argv.slice(2)) {
  assertNode22();
  const options = parseArguments(args);
  if (!options.deploy) {
    command(process.execPath, ['tools/check.mjs'], ROOT);
    console.log('Validación completa. No se publicó en Firebase.');
    return;
  }
  verifyRelease(ROOT, options.sha);
  const parent = path.resolve(ROOT, '.deploy');
  if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('.deploy no puede ser un enlace.');
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, 'release-'));
  const snapshot = path.join(temp, 'source');
  fs.mkdirSync(snapshot);
  const record = { commit: options.sha, project: PROJECT_ID, scope: options.scope, interactive: options.interactive,
    startedAt: new Date().toISOString(), completed: [], status: 'running' };
  const log = path.join(parent, path.basename(temp) + '.json');
  const save = () => fs.writeFileSync(log, JSON.stringify(record, null, 2) + '\n');
  save();
  try {
    const archive = path.join(temp, 'source.tar');
    command('git', ['archive', '--format=tar', `--output=${archive}`, options.sha], ROOT);
    command('tar', ['-xf', archive, '-C', snapshot], ROOT);
    // Tests, installation and publication use this immutable Git snapshot, not the working copy.
    deploySnapshot(snapshot, { ...options, beforePublish: () => verifyRelease(ROOT, options.sha),
      progress: stage => { record.completed.push(stage); save(); } });
    record.status = 'success';
    console.log(`Publicado ${options.sha}. Registro: ${log}`);
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    console.error(`Despliegue detenido. Etapas completadas: ${record.completed.join(', ') || 'ninguna'}. Registro: ${log}`);
    throw error;
  } finally {
    record.finishedAt = new Date().toISOString();
    save();
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) === parent && path.basename(resolved).startsWith('release-') &&
        !fs.lstatSync(resolved).isSymbolicLink()) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
