import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, validateProject, buildHosting, HOSTING_FILES } from '../tools/project.mjs';
import os from 'node:os';

test('la entrada actual carga app.js, estilos, manifest y registra su service worker', () => {
  validateProject();
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(html, /<script[^>]*type="module"[^>]*src="\.\/app\.js(?:\?[^\"]*)?"/);
  assert.match(html, /href="\.\/styles\.css(?:\?[^\"]*)?"/);
  assert.match(html, /rel="manifest" href="\.\/manifest\.json(?:\?[^\"]*)?"/);
  assert.match(app, /serviceWorker\.register\("\.\/service-worker\.js"\)/);
});

test('el service worker retira solamente sus cachÃ©s antiguas y deja las peticiones a la red', async () => {
  const listeners = {};
  const removed = [];
  let claimed = false;
  let skipped = false;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'service-worker.js'), 'utf8'), {
    self: { addEventListener: (event, callback) => { listeners[event] = callback; },
      skipWaiting: () => { skipped = true; }, clients: { claim: () => { claimed = true; } } },
    caches: { keys: async () => ['explora-shell-old', 'another-app'], delete: async key => removed.push(key) }
  });
  listeners.install();
  let pending;
  listeners.activate({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.equal(skipped, true);
  assert.equal(claimed, true);
  assert.deepEqual(removed, ['explora-shell-old']);
  listeners.fetch({ respondWith: () => assert.fail('El worker no debe servir una versiÃ³n cacheada') });
});

test('el paquete de Hosting contiene solo recursos publicados, limpia sobrantes y detecta recursos faltantes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explora-hosting-test-'));
  try {
    for (const file of [...HOSTING_FILES, 'firebase.json', 'firestore.rules', 'storage.rules',
      'functions/index.js', 'functions/package.json', 'functions/package-lock.json']) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), target);
    }
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist/old.js'), 'old');
    const sha = 'a'.repeat(40);
    const output = buildHosting(root, sha);
    assert.equal(fs.existsSync(path.join(output, 'old.js')), false);
    assert.deepEqual(fs.readdirSync(path.join(output, 'functions')), ['expense-policy.js', 'period-policy.js']);
    assert.equal(fs.existsSync(path.join(output, 'functions/index.js')), false);
    const release = JSON.parse(fs.readFileSync(path.join(output, 'release.json')));
    assert.equal(release.commit, sha);
    assert.deepEqual(Object.keys(release.files).sort(), [...HOSTING_FILES].sort());
    for (const file of HOSTING_FILES) assert.deepEqual(fs.readFileSync(path.join(output, file)), fs.readFileSync(path.join(ROOT, file)));
    fs.appendFileSync(path.join(root, 'index.html'), '<script src="./missing.js"></script>');
    assert.throws(() => validateProject(root), /Recurso fuera del paquete/);
    fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(root, 'index.html'));
    fs.unlinkSync(path.join(root, 'app.js'));
    assert.throws(() => validateProject(root), /app.js/);
  } finally {
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('explora-hosting-test-'))
      fs.rmSync(root, { recursive: true, force: true });
  }
});
