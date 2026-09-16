import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),E=require('../functions/period-settlement.js');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const statement=fs.readFileSync(new URL('../period-statement.js',import.meta.url),'utf8');
const receipt=fs.readFileSync(new URL('../receipt-files.js',import.meta.url),'utf8');

test('Uber desaparece de los accesos y del filtro, pero el legado queda invisible',()=>{
 assert.doesNotMatch(html,/id="addUberBtn"/);
 assert.doesNotMatch(html,/<option value="uber">/);
 assert.doesNotMatch(statement,/Uber digital|Total Uber digital|Total digital/);
 assert.match(app,/Los viajes de Uber se registran como Cobro efectivo/);
});

test('un Uber histórico se cuenta una sola vez como efectivo y nunca como digital',()=>{
 const m=E.calculate({uberWeeks:[{id:'u',grossAmount:75000,cashAmount:0,transferAmount:75000,verifiedAutomatically:true,settlementWorkflowVersion:'v85_verified_direct',reviewStatus:'completed'}]});
 assert.equal(m.cash,75000);assert.equal(m.digital,0);assert.equal(m.totalDigital,0);assert.equal(m.gross,75000);
 assert.equal(m.rows.cash.length,1);assert.equal(m.rows.cash[0].statementLabel,'Cobro en efectivo');
});

test('comprobante operativo usa imagen primero y PDF posterior',()=>{
 assert.match(receipt,/export async function createReceiptPhoto/);
 assert.match(app,/receiptFormatVersion:\"image-first-pdf-later-v2\"/);
 assert.match(app,/prepareOperationalPdfInBackground/);
 assert.match(app,/Subiendo comprobante…/);
 assert.doesNotMatch(app,/Subiendo imagen y PDF…/);
});
