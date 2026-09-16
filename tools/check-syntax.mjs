import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './project.mjs';
import { command } from './command.mjs';

const files = ['auth-session.js', 'movement-colors.js', 'app.js', 'firebase-config.js', 'service-worker.js', 'calendar-core.js', 'trip-calendar.js', 'receipt-files.js', 'period-statement.js'];
for (const dir of ['functions', 'tools', 'js/core']) {
  files.push(...fs.readdirSync(path.join(ROOT, dir)).filter(name => /\.(mjs|js)$/.test(name)).map(name => `${dir}/${name}`));
}
for (const file of files) command(process.execPath, ['--check', file], ROOT);
console.log(`Sintaxis: ${files.length} archivos OK`);
