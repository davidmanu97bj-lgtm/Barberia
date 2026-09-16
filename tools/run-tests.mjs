import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './project.mjs';
import { command } from './command.mjs';

const directories = process.argv.includes('--functions') ? ['functions/tests'] : ['tests', 'functions/tests'];
let files = directories.flatMap(dir => fs.readdirSync(path.join(ROOT, dir))
  .filter(name => /\.test\.(mjs|js)$/.test(name)).sort().map(name => `${dir}/${name}`));
if (process.argv.includes('--offline')) {
  const integration=new Set(['functions/tests/arca-integration.test.js','functions/tests/uber-proof-ocr.test.js','functions/tests/uber-submission.test.js','tests/uber-schedule-proof.test.mjs']);
  const excluded=files.filter(name=>integration.has(name));
  files=files.filter(name=>!integration.has(name));
  console.log('MODO OFFLINE. No ejecutadas (dependencias externas): '+excluded.join(', '));
}
if (!files.length) throw new Error('No se encontraron pruebas.');
command(process.execPath, ['--test', ...files], ROOT);
