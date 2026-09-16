import { ROOT, assertNode22, validateProject } from './project.mjs';
import { command } from './command.mjs';

assertNode22();
validateProject();
command(process.execPath, ['tools/check-syntax.mjs'], ROOT);
command(process.execPath, ['tools/run-tests.mjs'], ROOT);
