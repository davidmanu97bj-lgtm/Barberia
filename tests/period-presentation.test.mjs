import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {periodBreakdown,periodMarkup} from '../period-ui.js';
const require=createRequire(import.meta.url);
const {quoteFromInput}=require('../functions/period-closure.js');
const {VERSION}=require('../functions/period-policy.js');
const base={driverUid:'test',createdAtMs:1000,settlementRuleVersion:VERSION};
function quote(cash,digital,expenses=[],debts=[]) {
  return quoteFromInput('test',{records:[{...base,id:'cash',method:'cash',amount:cash},{...base,id:'digital',method:'digital',amount:digital}],expenses,debts,closures:[],uberWeeks:[]});
}
test('ejemplo solicitado: caja 51.200, multa 50.000 y billetera a favor 120.000 dejan 18.800 a cobrar',()=>{
  const q=quote(136000,376000,[],[{id:'fine',driverUid:'test',type:'admin_debt',amount:50000,detail:'Multa'}]);
  const result=periodBreakdown(q);
  assert.equal(q.balance,-18800);
  assert.deepEqual(result.lines.map(line=>line.balance),[51200,50000,-120000]);
  assert.deepEqual(result.lines.map(line=>line.label),['Debés de caja chica','Debés de multa','Explora te debe de billetera']);
  assert.equal(result.walletTarget,256000);
  const html=periodMarkup(q);
  assert.equal((html.match(/Para que ambos tengan/g)||[]).length,1);
  assert.doesNotMatch(html.split('</section>')[0],/period-instruction/);
  assert.match(html.split('</section>')[1],/Explora te pasa/);
  for(const text of ['Explora te pasa','120.000','256.000','De caja chica.','Por tu deuda.','18.800','Y queda todo cerrado.'])assert.ok(html.includes(text),text);
});
test('efectivo mayor invierte el aviso, billeteras iguales no requieren una transferencia entre ellas',()=>{
  const sections=periodMarkup(quote(376000,136000)).split('</section>');
  assert.match(sections[0],/Pasale <span>[^<]*120\.000<\/span> a Explora/);
  assert.doesNotMatch(sections[1],/period-instruction/);
  const q=quote(100000,100000);
  assert.equal(periodBreakdown(q).walletTarget,100000);
  for(const section of periodMarkup(q).split('</section>').slice(0,2))assert.doesNotMatch(section,/period-instruction/);
  const negative=periodMarkup(quote(0,0,[{...base,id:'expense',expenseType:'combustible',expensePaymentMethod:'digital',amount:100000,receiptFlowVersion:'gross_expense_policy_v3'}])).split('</section>');
  assert.match(negative[0],/Pasale <span>[^<]*50\.000<\/span> a Explora/);
  assert.doesNotMatch(negative[1],/period-instruction/);
});
test('el resumen cuadra con el saldo, incluso con gastos personales, gastos de Explora y billeteras negativas',()=>{
  for(const expenseType of ['combustible','multa','cubiertas'])for(const expensePaymentMethod of ['cash','digital']) {
    const q=quote(100,200,[{...base,id:'expense',expenseType,expensePaymentMethod,amount:600,receiptFlowVersion:'gross_expense_policy_v3'}]);
    const result=periodBreakdown(q);
    assert.equal(result.lines.reduce((sum,line)=>sum+line.balance,0),q.balance,expenseType+' '+expensePaymentMethod);
    assert.equal(result.walletTarget,-150);
    if(expenseType==='multa'&&expensePaymentMethod==='digital') {
      assert.equal(result.debtTotal,600);
      assert.equal(result.compensation,-300);
    }
  }
});
test('motivos de deuda se escapan como texto y los saldos previos permanecen visibles',()=>{
  const q=quote(100,200,[],[{id:'d',driverUid:'test',type:'admin_debt',amount:40,detail:'<img onerror=alert(1)>'}]);
  assert.ok(!periodMarkup(q).includes('<img onerror'));
  assert.match(periodMarkup(q), /&lt;img onerror=alert\(1\)&gt;/);
  q.summary.previousBalance=80;q.balance+=80;q.amount=Math.abs(q.balance);
  assert.match(periodMarkup(q),/Debés de saldo anterior/);
});
