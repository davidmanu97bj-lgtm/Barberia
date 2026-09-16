import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('function receiptBalanceSnapshot(');
const end = source.indexOf('function receiptBalanceLabel(', start);
const excludedStart = source.indexOf('function cashboxIsExcluded(');
const excludedEnd = source.indexOf('\n}', excludedStart) + 2;
const uberStart = source.indexOf('function uberUsesGrossCashRule(');
const uberEnd = source.indexOf('\n}', uberStart) + 2;
const snapshot = vm.runInNewContext(`${source.slice(uberStart, uberEnd)}\n${source.slice(excludedStart, excludedEnd)}\n(${source.slice(start, end).trim()})`, {isSettlementAdjustment:item=>item.type==='settlement_adjustment',isReimbursementCompensation:item=>['reimbursement_compensation','debt_compensation'].includes(item.type)});

test('el historial expresa cambios del saldo con signo y admite saldo cero', () => {
  const cash = snapshot({telegramSettlementBeforeBalance:0, telegramSettlementAfterBalance:55000});
  assert.equal(cash.before, 0);
  assert.equal(cash.movementImpact, 55000);
  const digital = snapshot({telegramSettlementBeforeBalance:55000, telegramSettlementAfterBalance:-25000});
  assert.equal(digital.movementImpact, -80000);
  assert.equal(digital.after, -25000);
});

test('no inventa saldos cuando los registros antiguos tienen datos ausentes o inválidos', () => {
  for (const value of [undefined, null, '', ' ', true, {}, NaN, Infinity, 'desconocido']) {
    assert.equal(snapshot({telegramSettlementBeforeBalance:value, telegramSettlementAfterBalance:12}), null);
    assert.equal(snapshot({telegramSettlementBeforeBalance:12, telegramSettlementAfterBalance:value}), null);
  }
  assert.equal(snapshot({amount:90000}), null);
  assert.equal(snapshot({amountCorrectionCount:1, telegramSettlementBeforeBalance:0, telegramSettlementAfterBalance:55}), null);
  assert.equal(snapshot({settlementBeforeAdminDecision:'10', settlementAfterAdminDecision:'0'}).movementImpact, -10);
});

test('la caja chica derivada y los adelantos separados no repiten el impacto del cobro', () => {
  for (const type of ['cashbox_receipt', 'cash_advance']) {
    assert.equal(snapshot({type, telegramSettlementBeforeBalance:0, telegramSettlementAfterBalance:55000}), null);
  }
});
