import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {eligibleUberWeek,validateUberText}=require('../functions/uber-proof');
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const declarations=[...source.matchAll(/^(?:async )?function \w+\([^\n]*/gm)].map(match=>source.slice(match.index,source.indexOf('\n}',match.index)+2)).join('\n');
const front=(now,records=[])=>vm.runInNewContext(`${declarations}\npendingUberWeeks(new Date(now))`,{now,uberClosures:records,UBER_TRACKING_START_DATE:'2026-09-07'});
test('cierre lunes 14: oculto hasta el martes 15 en Argentina; se repite cada semana',()=>{
  for(const when of ['2026-09-13T18:00:00Z','2026-09-14T18:00:00Z','2026-09-15T02:59:59Z']) {
    assert.equal(eligibleUberWeek(new Date(when)),null);
    assert.equal(front(when).length,0);
  }
  for(let n=0;n<80;n++) {
    const date=new Date('2026-09-15T03:00:00Z'); date.setUTCDate(date.getUTCDate()+n*7);
    const back=eligibleUberWeek(date), weeks=front(date.toISOString());
    assert.equal(weeks.length,1); assert.equal(weeks[0].weekStartDate,back.start); assert.equal(weeks[0].weekCloseDate,back.close);
    assert.equal(front(date.toISOString(),[{...weeks[0],reviewStatus:'pending_admin_review'}]).length,0);
    assert.equal(front(date.toISOString(),[{...weeks[0],reviewStatus:'approved'}]).length,0);
    assert.equal(front(date.toISOString(),[{...weeks[0],reviewStatus:'completed',settlementWorkflowVersion:'v85_verified_direct'}]).length,0);
    assert.equal(front(date.toISOString(),[{...weeks[0],reviewStatus:'rejected'}]).length,1);
    const monday=new Date(date); monday.setUTCDate(monday.getUTCDate()+6);
    assert.deepEqual(eligibleUberWeek(monday),back);
  }
});
test('lector requiere ganancias, semana exacta, total y legibilidad',()=>{
  const week={start:'2026-09-07',close:'2026-09-14'};
  for(const date of ['7 sept - 14 sept','7 - 14 de septiembre','7 de sept. - 14 de sept.','07/09 - 14/09','7 sept 2026 - 14 sept 2026']) {
    assert.equal(validateUberText(`Ganancias\n${date}\n$ 100.000,00\nEn línea 25 h\nViajes 30`,92,week,100000).valid,true,date);
  }
  const sample='Ganancias\n7 sept - 14 sept\n$100.000,00\nViajes 30';
  assert.equal(validateUberText(sample.replace('$100.000,00','ARS 100.000,00'),92,week,100000).valid,true);
  assert.equal(validateUberText(sample.replace('$100.000,00','ARS $ 100,000.00'),92,week,100000).valid,true);
  for(const [text,confidence,amount] of [[sample.replace('7 sept - 14 sept','31 ago - 7 sept'),92,100000],[sample,40,100000],[sample,92,105000],[sample+'\nEJEMPLO',92,100000],['Saldo $100.000\n7 sept - 14 sept',90,100000],[sample.replace('Ganancias','Ganancias del viaje'),90,100000],[sample.replace('14 sept','14 sept 2025'),90,100000]]) {
    assert.equal(validateUberText(text,confidence,week,amount).valid,false);
  }
});

test('monto semanal admite centavos sin convertirlos en pesos adicionales',()=>{
  for(const [text,value] of [['100000',100000],['100.000',100000],['100.000,55',100000.55],['100000.55',100000.55],['',0]]) {
    assert.equal(vm.runInNewContext(`${declarations}\nparseUberAmount(value)`,{value:text}),value);
  }
});
