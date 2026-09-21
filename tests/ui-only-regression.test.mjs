import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const baseline=JSON.parse(fs.readFileSync(new URL('./ui-only-baseline.json',import.meta.url)));
const approved=JSON.parse(fs.readFileSync(new URL('./approved-reconstruction-changes.json',import.meta.url)));
const normalize=s=>s.replace(/\r\n/g,'\n');
const expectedHash=(section,key,fallback)=>{const change=approved[section][key];if(change)assert.ok(change.reason.length>30,key);return change ? change.hash : fallback;};
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const hash=s=>createHash('sha256').update(typeof s==='string' ? normalize(s) : s.includes(0) ? s : Buffer.from(s.toString('utf8').replace(/\r\n/g,'\n'))).digest('hex');
test('regresión: funciones originales y cambios expresamente aprobados',()=>{
 for(const [name,expected] of Object.entries(baseline.functions)) {
  const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.ok(start>=0,name);assert.equal(hash(source.slice(start,source.indexOf('\n}',start)+2)),expectedHash('functions',name,expected),name);
 }
});
test('regresión: formularios originales y cierre único aprobado',()=>{
 for(const [id,expected] of Object.entries(baseline.handlers)) {
  const start=source.indexOf(`$("${id}")`+ (id==='managementForm'?'':'?')+`.addEventListener("submit",`);
  if(expectedHash('handlers',id,expected)===null){assert.equal(start,-1,id);continue;}
  assert.ok(start>=0,id);assert.equal(hash(source.slice(start,source.indexOf('\n});',start)+4)),expectedHash('handlers',id,expected),id);
 }
});
test('regresión: archivos protegidos y excepciones documentadas de reconstrucción',()=>{
 for(const [file,expected] of Object.entries(baseline.protectedFiles))assert.equal(hash(fs.readFileSync(new URL('../'+file,import.meta.url))),expectedHash('protectedFiles',file,expected),file);
});
test('solo UI: sin saldo confirmado, sin nuevas funciones financieras, sin activación',()=>{
 for(const term of ['financial-store.js','settlement-ledger','driver_settlement_accounts','activateSettlementAccount','Saldos seguros']) {
  assert.ok(!source.includes(term),term);assert.ok(!fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').includes(term),term);
 }
});
