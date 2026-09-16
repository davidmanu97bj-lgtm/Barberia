import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Read the actual client target; the manager separately asks for explicit deployment approval.
const targetSource = fs.readFileSync(path.join(ROOT, 'firebase-config.js'), 'utf8');
export const PROJECT_ID = targetSource.match(/projectId:\s*["']([a-z][a-z0-9-]{4,61}[a-z0-9])["']/)?.[1];
if (!PROJECT_ID) throw new Error('Falta un projectId válido en firebase-config.js.');
export const HOSTING_FILES = [
  'index.html', 'app.js', 'auth-session.js', 'movement-colors.js', 'movement-colors.css', 'tourism-catalog.js', 'calendar-core.js', 'trip-calendar.js', 'styles.css', 'firebase-config.js',
  'service-worker.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'closure-report.js',
  'assets/explora-logo.png', 'assets/explora-logo-login.png', 'assets/uber-logo.svg', 'functions/expense-policy.js', 'functions/period-settlement.js', 'functions/jpeg-pdf.js', 'receipt-files.js', 'period-statement.js', 'period-statement.css'
];

export function assertNode22(version = process.versions.node) {
  if (version.split('.')[0] !== '22') throw new Error('Usa Node.js 22, igual que Cloud Functions.');
}

export function validateProject(root = ROOT) {
  const required = [...HOSTING_FILES, 'firebase.json', 'firestore.rules', 'storage.rules',
    'functions/index.js', 'functions/package.json', 'functions/package-lock.json'];
  for (const file of required) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || fs.statSync(full).size === 0) {
      throw new Error(`Archivo obligatorio ausente o vacío: ${file}`);
    }
  }
  const config = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  if (config.hosting.public !== 'dist' || config.functions[0].source !== 'functions' ||
      config.firestore.rules !== 'firestore.rules' || config.storage.rules !== 'storage.rules') {
    throw new Error('firebase.json debe usar dist, functions y las reglas versionadas.');
  }
  const functionsPackage = JSON.parse(fs.readFileSync(path.join(root, 'functions/package.json')));
  if (functionsPackage.engines.node !== '22') throw new Error('Functions debe usar Node 22.');
  const client = fs.readFileSync(path.join(root, 'firebase-config.js'), 'utf8');
  if (!client.includes(`projectId: "${PROJECT_ID}"`)) throw new Error('Proyecto Firebase del cliente inesperado.');

  // Every literal local resource used by the current entry must be in the release.
  const check = (reference, parent) => {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
    const clean = reference.split(/[?#]/)[0];
    if (!clean) return;
    const file = path.posix.normalize(path.posix.join(path.posix.dirname(parent), clean));
    if (!HOSTING_FILES.includes(file)) throw new Error(`Recurso fuera del paquete: ${parent} → ${reference}`);
  };
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) check(match[1], 'index.html');
  for (const file of ['app.js', 'auth-session.js', 'movement-colors.js', 'firebase-config.js', 'calendar-core.js', 'trip-calendar.js', 'receipt-files.js', 'period-statement.js', 'closure-report.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) check(match[1], file);
  }
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  for (const match of css.matchAll(/url\(\s*["']?([^\s)"']+)["']?\s*\)/g)) check(match[1], 'styles.css');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  for (const icon of manifest.icons) check(icon.src, 'manifest.json');
  check(manifest.start_url, 'manifest.json');
  return HOSTING_FILES;
}

export function buildHosting(root = ROOT, commit = null) {
  validateProject(root);
  const output = path.resolve(root, 'dist');
  // Only this generated directory can be replaced; never follow a dist symlink.
  if (path.dirname(output) !== path.resolve(root) ||
      (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())) throw new Error('Directorio dist inseguro.');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const hashes = {};
  for (const file of HOSTING_FILES) {
    const bytes = fs.readFileSync(path.join(root, file));
    const target = path.join(output, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
  }
  fs.writeFileSync(path.join(output, 'release.json'), JSON.stringify({ commit, files: hashes }, null, 2) + '\n');
  return output;
}
