import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from './project.mjs';

const options = JSON.parse(
  fs.readFileSync(path.join(ROOT,'functions/deployment-options.json'),'utf8')
);

const index = fs.readFileSync(path.join(ROOT,'functions/index.js'),'utf8');
const arca = fs.readFileSync(path.join(ROOT,'functions/arca-functions.js'),'utf8');

const direct = [...index.matchAll(
  /^exports\.([A-Za-z][A-Za-z0-9_]*)\s*=/gm
)].map(m => m[1]);

const assigned = [...arca.matchAll(
  /^    ([A-Za-z][A-Za-z0-9_]*):on(?:Call|DocumentCreated|Schedule)\(/gm
)].map(m => m[1]);

let names = [...new Set([...direct,...assigned])].sort();

if (!options.arcaEnabled) {
  const disabledArcaTriggers = new Set([
    'prepareArcaInvoiceDraft',
    'queueArcaInvoice',
    'issueArcaInvoice',
    'retryArcaInvoices',
    'notifyArcaInvoiceTelegramV1'
  ]);
  names = names.filter(name => !disabledArcaTriggers.has(name));
}

if (
  names.length < 15 ||
  !names.includes('receiptPdf') ||
  !names.includes('arcaBillingStatus')
) {
  throw new Error('No se pudo determinar una lista segura de funciones.');
}

console.log(names.map(name => 'functions:' + name).join(','));
