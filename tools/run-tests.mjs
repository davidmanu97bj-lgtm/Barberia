import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './project.mjs';
import { command } from './command.mjs';

const directories = process.argv.includes('--functions') ? ['functions/tests'] : ['tests', 'functions/tests'];
const files = directories.flatMap(dir => fs.readdirSync(path.join(ROOT, dir))
  .filter(name => /\.test\.(mjs|js)$/.test(name)).sort().map(name => `${dir}/${name}`));
if (!files.length) throw new Error('No se encontraron pruebas.');
command(process.execPath, ['--test', ...files], ROOT);
