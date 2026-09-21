// Versioned policy shared by the browser and Functions. Existing documents keep their rules.
(function(root,factory){const policy=factory();if(typeof module==='object'&&module.exports)module.exports=policy;else root.ExploraPeriodPolicy=policy;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const VERSION='net_wallets_cashbox_10_v1';
  const isNew=item=>item?.settlementRuleVersion===VERSION;
  const round=value=>Math.round((Number(value)+Number.EPSILON)*100)/100;
  const cashboxRate=item=>isNew(item)?0.10:0.05;
  const method=item=>/digital|transfer|qr|card|tarjeta/i.test(item.paymentMethod||item.metodoPago||item.method||'')?'digital':'cash';
  const expenseMethod=item=>item.expensePaymentMethod==='digital'?'digital':'cash';
  // Category responsibilities are kept; shared expenses affect their source wallet.
  function expenseRate(item,category) {
    if(category?.group==='driver')return expenseMethod(item)==='digital'?1:0;
    if(category?.group==='explora')return expenseMethod(item)==='cash'?-1:0;
    return expenseMethod(item)==='cash'?-0.5:0.5;
  }
  const chargeDelta=(amount,mode)=>round(Number(amount)*(mode==='cash'?0.60:-0.40));
  return Object.freeze({VERSION,isNew,round,cashboxRate,method,expenseMethod,expenseRate,chargeDelta});
});
