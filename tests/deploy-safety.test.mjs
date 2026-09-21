import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { parseArguments, verifyRelease, deploySnapshot } from '../tools/deploy.mjs';
import { assertNode22 } from '../tools/project.mjs';

const sha = 'a'.repeat(40);
const root = path.resolve('fixture');
function git(overrides = {}, calls = []) {
  const outputs = {
    'rev-parse --show-toplevel': root,
    'remote get-url origin': 'https://github.com/davidmanu97bj-lgtm/santander.git',
    'status --porcelain --untracked-files=all': '',
    'rev-parse HEAD': sha,
    'ls-remote --exit-code origin refs/heads/main': `${sha}\trefs/heads/main`
  };
  return (exe, args) => {
    assert.equal(exe, 'git'); calls.push(args);
    const key = args.join(' ');
    assert.ok(key in outputs, `Operación Git inesperada: ${key}`);
    if (overrides[key] instanceof Error) throw overrides[key];
    return overrides[key] ?? outputs[key];
  };
}

test('validar es la opción predeterminada y publicar exige SHA completo', () => {
  assert.deepEqual(parseArguments([]), { deploy: false });
  assert.deepEqual(parseArguments(['--validate']), { deploy: false });
  assert.equal(parseArguments(['--deploy', sha]).scope, 'all');
  for (const args of [['--deploy'], ['--deploy', 'main'], ['--force'], ['--deploy', sha, '--only', 'other']])
    assert.throws(() => parseArguments(args));
  assertNode22('22.23.2');
  assert.throws(() => assertNode22('24.0.0'));
});

test('la aprobación remota es de solo lectura y bloquea copias locales, remotos incorrectos y red caída', () => {
  const calls = [];
  verifyRelease(root, sha, git({}, calls));
  assert.equal(calls.length, 5);
  for (const overrides of [
    { 'status --porcelain --untracked-files=all': ' M app.js' },
    { 'rev-parse HEAD': 'b'.repeat(40) },
    { 'remote get-url origin': 'https://github.com/other/repo.git' },
    { 'ls-remote --exit-code origin refs/heads/main': 'b'.repeat(40) + '\trefs/heads/main' },
    { 'ls-remote --exit-code origin refs/heads/main': new Error('offline') }
  ]) assert.throws(() => verifyRelease(root, sha, git(overrides)));
});

function pipeline(failAt) {
  const calls = [];
  let builds = 0;
  const execute = () => deploySnapshot(root, { sha, npm: 'npm-cli.js',
    run: (exe, args, cwd) => {
      assert.equal(cwd, root);
      calls.push(args);
      if (args.includes(failAt)) throw new Error('fallo simulado');
    }, build: (cwd, commit) => { assert.equal(cwd, root); assert.equal(commit, sha); builds++; } });
  return { execute, calls, builds: () => builds };
}

test('las dependencias se instalan antes de probar y una prueba fallida impide publicar', () => {
  const p = pipeline('tools/check.mjs');
  assert.throws(p.execute, /fallo simulado/);
  assert.equal(p.calls.length, 2);
  assert.ok(p.calls[0].includes('ci'));
  assert.equal(p.calls.some(args => args.includes('firebase')), false);
  assert.equal(p.builds(), 0);
});

test('fallos de dependencias y reglas detienen las etapas posteriores', () => {
  for (const stage of ['ci', 'firestore:rules,firestore:indexes,storage', 'functions']) {
    const p = pipeline(stage);
    assert.throws(p.execute, /fallo simulado/);
    assert.equal(p.calls.some(args => args.includes('hosting')), false);
  }
});

test('una entrega válida publica las tres etapas del mismo commit sin force', () => {
  const p = pipeline(); p.execute();
  assert.equal(p.builds(), 1);
  const deploys = p.calls.filter(args => args.includes('firebase'));
  assert.deepEqual(deploys.map(args => args[args.indexOf('--only') + 1]), ['firestore:rules,firestore:indexes,storage', 'functions', 'hosting']);
  for (const args of deploys) {
    assert.ok(args.includes('--package=firebase-tools@15.30.0'));
    assert.ok(args.includes('explora-control-operativo'));
    assert.ok(args.includes(`GitHub main ${sha}`));
    assert.equal(args.includes('--force'), false);
  }
});

test('si main avanza durante las pruebas, no se inicia la publicación', () => {
  const calls = [];
  assert.throws(() => deploySnapshot(root, { sha, npm: 'npm-cli.js',
    run: (exe, args) => calls.push(args), build: () => {},
    beforePublish: () => { throw new Error('main cambió'); }
  }), /main cambió/);
  assert.equal(calls.some(args => args.includes('firebase')), false);
});

test('confirmación interactiva conserva controles y nunca acepta todas las advertencias', () => {
  assert.equal(parseArguments(['--deploy', sha, '--interactive']).interactive, true);
  assert.equal(parseArguments(['--deploy', sha, '--only', 'backend', '--interactive']).scope, 'backend');
  assert.throws(() => parseArguments(['--interactive']));
  assert.throws(() => parseArguments(['--deploy', sha, '--interactive', '--interactive']));
  const calls = []; let checks = 0;
  deploySnapshot(root, { sha, interactive: true, npm: 'npm-cli.js', build: () => {},
    beforePublish: () => checks++, run: (exe, args) => calls.push(args) });
  const deploys = calls.filter(args => args.includes('firebase'));
  assert.equal(checks, 3);
  for (const args of deploys) {
    const isFunctions = args[args.indexOf('--only') + 1] === 'functions';
    assert.equal(args.includes('--interactive'), isFunctions);
    assert.equal(args.includes('--non-interactive'), !isFunctions);
    assert.equal(args.includes('--force'), false);
  }
});

test('los alcances parciales no publican servicios fuera de lo solicitado', () => {
  for (const scope of ['hosting', 'backend']) {
    const calls = [];
    let builds = 0;
    deploySnapshot(root, { sha, scope, npm: 'npm-cli.js',
      run: (exe, args) => calls.push(args), build: () => builds++ });
    const stages = calls.filter(args => args.includes('firebase')).map(args => args[args.indexOf('--only') + 1]);
    assert.deepEqual(stages, scope === 'hosting' ? ['hosting'] : ['firestore:rules,firestore:indexes,storage', 'functions']);
    assert.equal(calls.some(args => args.includes('ci')), true);
    assert.equal(builds, scope === 'hosting' ? 1 : 0);
  }
});
