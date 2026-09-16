// One catalogue is used by the browser and by Firebase Functions.
(function(root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.ExploraExpensePolicy = policy;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const version = 'gross_expense_policy_v3';
  const groups = [
    {id:'shared',label:'50% chofer · 50% Explora',refundRate:0.5,description:'Explora reintegra el 50%',types:[
      ['service','Service del auto','wrench'],['combustible','Combustible','fuel'],['lavadero','Lavadero','wash'],
      ['patente','Patente','plate'],['seguro_auto','Seguro del auto','carShield'],['control_municipal','Control municipal','municipal'],['vtv','VTV','inspection']
    ]},
    {id:'driver',label:'100% chofer',refundRate:0,description:'Sin reintegro · 100% deuda del chofer',types:[
      ['seguro_vida','Seguro de vida','heart'],['monotributo','Monotributo','tax'],['multa','Multa','ticket'],
      ['choque','Choque','collision'],['ruptura','Ruptura','broken'],['prestamo','Préstamo','loan'],['canon','Canon','key']
    ]},
    {id:'explora',label:'100% Explora',refundRate:1,description:'Explora reintegra el 100%',types:[
      ['cubiertas','Cubiertas','tire'],['picos','Picos','valve'],['luces','Luces quemadas','light'],
      ['pastillas','Pastillas','pads'],['disco_freno','Disco de freno','disc']
    ]}
  ];
  const types = groups.flatMap(group => group.types.map(([id,label,icon]) => Object.freeze({id,label,icon,group:group.id,groupLabel:group.label,refundRate:group.refundRate})));
  const debtVersion = 'driver_debt_100_v1';
  const entryGroups = Object.freeze([
    Object.freeze({id:'shared', label:'Gasto pagado en efectivo',
      description:'Lo paga el chofer y se descuenta antes de la caja y el reparto.',
      types:Object.freeze(types.filter(type => type.group !== 'driver'))}),
    Object.freeze({id:'debt', label:'Deuda del chofer 100%',
      description:'Choque, préstamo, multa o ruptura. Se debe a Explora, sin compartir.',
      types:Object.freeze(['choque','prestamo','multa','ruptura','seguro_vida','monotributo','canon'].map(id => types.find(type => type.id === id)))})
  ]);
  function find(type) { return types.find(item => item.id === type) || null; }
  // Applied only when registering NEW data. Never reclassify historical gastos.
  function entryKind(type) { const item = find(type); return item ? (item.group === 'driver' ? 'debt' : 'shared') : ''; }
  function isSelfDeclaredDebt(data = {}) {
    return data.type === 'driver_debt_100' && data.debtRuleVersion === debtVersion &&
      data.registrationOrigin === 'driver_expense_debt_menu' && data.debtResponsibility === 'driver';
  }
  function refundRate(expense = {}) {
    return expense.receiptFlowVersion === version ? (find(expense.expenseType)?.refundRate ?? 0) : 0.5;
  }
  function netDriverRate(expense = {}) {
    if (expense.receiptFlowVersion === version) return 1-refundRate(expense);
    return expense.receiptFlowVersion === 'gross_expense_driver_debit_50_v2' ? 0.5 : -0.5;
  }
  const icons = {
    fuel:'<path d="M4 21V3h10v18M4 10h10M2 21h14M14 7h2l4 4v7a1 1 0 0 0 2 0V8l-4-4"/>',
    wash:'<path d="m4 12 2-6h12l2 6M3 12h18v7H3zM6 19v2M18 19v2M6 15h2M16 15h2M5 2v1M12 1v2M19 2v1"/>',
    wrench:'<path d="m14 6 4 4 3-3a6 6 0 0 1-8 7l-6 6a2 2 0 0 1-3-3l6-6a6 6 0 0 1 7-8z"/>',
    plate:'<rect x="2" y="6" width="20" height="12" rx="3"/><path d="M6 10h4m4 0h4M6 14h12"/>',
    carShield:'<path d="m3 11 2-5h10l2 5M2 11h14M3 11v7h5m-3-4h2M4 18v2m13-8 5 2v4c0 2-3 4-5 5-2-1-5-3-5-5v-4z"/>',
    municipal:'<path d="m3 8 9-5 9 5H3Zm2 3v7m5-7v7m4-7v7m5-7v7M3 21h18"/>',
    inspection:'<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 4V2h6v2M8 13l3 3 5-6"/>',
    heart:'<path d="M12 21 3 12C-2 5 7 0 12 7c5-7 14-2 9 5zM8 12h2l2-3 2 6 2-3h2"/>',
    tax:'<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7m-7 4h7"/>',
    ticket:'<path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4zM12 8v5m0 3v.1"/>',
    collision:'<path d="m3 15 2-5h6l2 5M2 15h12v5H2zM4 20v2m8-2v2m3-10 2-3 2 4 3-1M13 3l-1 4m6-5-2 3M6 17h2"/>',
    broken:'<path d="m4 4 5 1 2 5-5 6-3-3 3-5zM20 20l-5-1-2-5 5-6 3 3-3 5zM10 2l2 3-2 3m4 8-2 3 2 3"/>',
    loan:'<path d="M3 15h4l3 2h7a2 2 0 0 1 0 4H9l-6-3M3 13v9"/><circle cx="15" cy="7" r="5"/><path d="M15 4v6m-2-4h3m-3 2h3"/>',
    key:'<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-6-6 3-3m0 6 3-3M6 7h.1"/>',
    tire:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="m7 4 2 3m7-3-2 3M4 9l3 1m-3 6 3-2m10-4 3-1m-3 5 3 2m-6 1 2 3m-7-3-2 3"/>',
    valve:'<path d="M9 3h6v4H9zM10 7v7l-5 5v3h6l5-5V7M8 19l4-4M9 1h6"/>',
    light:'<path d="M9 4C1 5 1 19 9 20h5V4zM18 5l4-2m-4 7h4m-4 5h4m-4 4 4 2M9 5v14"/>',
    pads:'<path d="M6 4h4v16H6C1 16 1 8 6 4Zm12 0h-4v16h4c5-4 5-12 0-16ZM10 7h4m-4 10h4"/>',
    disc:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 5v1m6 6h1m-7 6v1m-7-7h1m1-5 1 1m8 8 1 1m0-10-1 1m-8 8-1 1"/>'
  };
  return Object.freeze({version,groups,types,find,refundRate,netDriverRate,icons,debtVersion,entryGroups,entryKind,isSelfDeclaredDebt});
});
