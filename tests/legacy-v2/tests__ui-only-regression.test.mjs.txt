import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const baseline=JSON.parse(fs.readFileSync(new URL('./ui-only-baseline.json',import.meta.url)));
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const hash=s=>createHash('sha256').update(s).digest('hex');
test('solo UI: todas las funciones no visuales conservan su texto original',()=>{
 for(const [name,expected] of Object.entries(baseline.functions)) {
  const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.ok(start>=0,name);assert.equal(hash(source.slice(start,source.indexOf('\n}',start)+2)),expected,name);
 }
});
test('solo UI: handlers de cobros, gastos, gestión y credenciales idénticos al original',()=>{
 for(const [id,expected] of Object.entries(baseline.handlers)) {
  const start=source.indexOf(`$("${id}")`+ (id==='managementForm'?'':'?')+`.addEventListener("submit",`);
  assert.ok(start>=0,id);assert.equal(hash(source.slice(start,source.indexOf('\n});',start)+4)),expected,id);
 }
});
test('solo UI: Functions, Rules, índices, configuración y estilos base idénticos',()=>{
 for(const [file,expected] of Object.entries(baseline.protectedFiles))assert.equal(hash(fs.readFileSync(new URL('../'+file,import.meta.url))),expected,file);
});
test('solo UI: sin saldo confirmado, sin nuevas funciones financieras, sin activación',()=>{
 for(const term of ['financial-store.js','settlement-ledger','driver_settlement_accounts','activateSettlementAccount','Saldos seguros']) {
  assert.ok(!source.includes(term),term);assert.ok(!fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').includes(term),term);
 }
});
