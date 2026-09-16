/* Explora: one accounting engine for the browser, administrator and Telegram.
 * No Firebase, DOM, floating percentage accumulation or mutation of input rows.
 * Positive balance: driver pays Explora. Negative balance: Explora pays driver.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExploraPeriodSettlement = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 'net_period_cashbox_10_split_50_v1';
  const AMOUNTS = ['amount','monto','valor','finalPrice','total','importe','price','precio',
    'precioFinal','montoFinal','montoCobrado','importeTotal','finalAmount','totalAmount',
    'billingAmount','chargedAmount','paidAmount','fare','tarifa','value','totalCobrado','facturacion','billingTotal'];
  const text = value => String(value == null ? '' : value).trim();
  function numeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const clean = text(value).replace(/[^0-9,.\-]/g, '');
    if (!clean) return 0;
    const comma = clean.lastIndexOf(','), dot = clean.lastIndexOf('.');
    let normalized = clean;
    if (comma >= 0 && dot >= 0) normalized = comma > dot ? clean.replace(/\./g, '').replace(',', '.') : clean.replace(/,/g, '');
    else if (comma >= 0) normalized = clean.length - comma - 1 === 3 ? clean.replace(/,/g, '') : clean.replace(',', '.');
    else if (dot >= 0 && clean.length - dot - 1 === 3) normalized = clean.replace(/\./g, '');
    const number = Number(normalized);
    return Number.isFinite(number) ? number : 0;
  }
  function cents(value) {
    const result = Math.round((numeric(value) + Number.EPSILON) * 100);
    if (!Number.isSafeInteger(result)) throw new RangeError('Importe fuera del rango admitido.');
    return result;
  }
  const money = value => value / 100;
  function amount(row = {}) {
    for (const key of AMOUNTS) {
      if (row[key] == null || row[key] === '') continue;
      const value = numeric(row[key]);
      if (value > 0) return value;
    }
    return 0;
  }
  function time(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value === 'object') {
      const seconds = value.seconds ?? value._seconds;
      if (typeof seconds === 'number') return seconds * 1000 + Math.floor((value.nanoseconds ?? value._nanoseconds ?? 0) / 1e6);
    }
    if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function rowTime(row = {}) {
    // An explicit creation time must not move when a PDF/Telegram status is updated.
    return Number(row.createdAtMs || row.timestampMs || 0) || time(row.createdAt) ||
      Number(row.completedAtMs || 0) || time(row.completedAt) || time(row.expenseDate) ||
      time(row.fechaISO) || time(row.date) || time(row.updatedAt);
  }
  function active(row) {
    if (!row || row.deleted === true || row.isDeleted === true || row.eliminado === true ||
        row.isSimulated === true || row.createdBySimulation === true || row.verificationMode === 'simulation') return false;
    return !/deleted|eliminad|borrad|anulad|cancel|reject|rechaz/.test(text(row.status || row.estado || row.state).toLowerCase());
  }
  function method(row = {}) {
    const raw = text(row.paymentMethod || row.metodoPago || row.financialCategory || row.receiptPaymentMethod ||
      row.paymentProvider || row.method || row.tipoPago).toLowerCase();
    if (/cash|efectivo/.test(raw)) return 'cash';
    if (/digital|card|tarjeta|point|posnet|transfer|transf|alias|qr|online|electr/.test(raw)) return 'digital';
    return '';
  }
  function direction(row = {}) {
    const raw = text(row.adjustmentDirection || row.settlementDirection || row.paymentDirection).toLowerCase();
    if (['driver_to_explora','driver_pays_explora','chofer_a_explora','chofer_a_david'].includes(raw)) return 'driver_to_explora';
    if (['explora_to_driver','explora_pays_driver','explora_a_chofer','david_a_chofer'].includes(raw)) return 'explora_to_driver';
    const type = text(row.type || row.operationType || row.movementType).toLowerCase();
    if (type === 'admin_billing_settlement_payment' || (type === 'driver_payment' && /factur|billing/.test(text(row.sourceModule || row.category)))) return 'driver_to_explora';
    return '';
  }
  function compensation(row = {}) {
    return ['reimbursement_compensation','debt_compensation'].includes(text(row.type || row.operationType || row.movementType).toLowerCase());
  }
  function cutoffFor(closures = []) {
    let cutoff = 0;
    for (const row of closures) {
      if (!active(row) || text(row.closureMode || row.periodType).toLowerCase() !== 'on_demand' ||
          row.rejected === true || row.rollbackRestored === true || row.invalidatesCutoff === true || row.cutoffActive === false) continue;
      const status = [row.status,row.estado,row.closureStatus,row.paymentStatus,row.receiptStatus,row.rejectionReason,row.rollbackStatus].join(' ').toLowerCase();
      if (/reject|rechaz|cancel|anulad|no aceptado/.test(status)) continue;
      const kind = text(row.closureKind || row.closureType || row.payTab || row.closeKind || row.kind ||
        row.cierreTipo || row.type || row.category || row.homeModule || row.homeTab || row.moduleKey).toLowerCase();
      if (/gasto|expense|caja|chica|cashbox|pendiente|deuda|debt|prestamo|advance/.test(kind)) continue;
      if (!/factur|billing|cobro|explora|digital|transfer|qr|card|tarjeta|chofer|driver|efectivo|cash/.test(kind)) continue;
      const stamp = Number(row.cutoffAtMs || row.requestedAtMs || row.createdAtMs || 0) || time(row.cutoffAt) || time(row.requestedAt) || rowTime(row);
      cutoff = Math.max(cutoff, stamp);
    }
    return cutoff;
  }
  function uberActive(row = {}) {
    if (!active(row)) return false;
    const workflow = text(row.settlementWorkflowVersion || row.workflowVersion).toLowerCase();
    const status = text(row.reviewStatus || row.status).toLowerCase();
    if (workflow === 'v85_verified_direct') return row.verifiedAutomatically === true && status === 'completed';
    if (workflow === 'v84_driver_submission_admin_review') return row.adminConfirmed === true && /approved|confirmed|completed/.test(status);
    if (workflow === 'v82_admin_driver_confirmation') return row.driverConfirmed === true && /approved|confirmed|completed/.test(status);
    return !/pending|pendient|draft|borrador|reject|rechaz|cancel|anulad/.test(status);
  }
  function uberSplit(row = {}) {
    const hasSplit = ['cashAmount','uberCashAmount','transferAmount','uberTransferAmount'].some(key => Object.prototype.hasOwnProperty.call(row,key));
    if (hasSplit) return {cash:cents(row.cashAmount ?? row.uberCashAmount ?? 0), digital:cents(row.transferAmount ?? row.uberTransferAmount ?? row.digitalAmount ?? 0)};
    const gross = cents(row.grossAmount ?? row.totalAmount ?? amount(row));
    return row.moneyHolder === 'explora' || row.settlementDestination === 'digital' ? {cash:0,digital:gross} : {cash:gross,digital:0};
  }
  function isSelfDeclaredDebt(row = {}) {
    return row.type === 'driver_debt_100' && row.debtRuleVersion === 'driver_debt_100_v1' &&
      row.registrationOrigin === 'driver_expense_debt_menu' && row.debtResponsibility === 'driver';
  }
  function debtAmount(row = {}) {
    if (!active(row)) return 0;
    const type = text(row.type || row.debtType).toLowerCase();
    const source = text(row.sourceModule || row.registrationOrigin || row.origin).toLowerCase();
    const role = text(row.createdByRole || row.registeredByRole).toLowerCase();
    if (source === 'uber_weekly' || type === 'uber_weekly') return 0;
    if (!(isSelfDeclaredDebt(row) || type === 'admin_debt' || /^(admin|administrador)$/.test(role) || row.registeredByAdmin === true || source === 'admin_debt_menu')) return 0;
    if ((isSelfDeclaredDebt(row) || row.driverConfirmationRequired === true) && row.acknowledgedByDriver !== true) return 0;
    if (/paid|pagad|closed|cerrad/.test(text(row.status || row.debtStatus || row.estado).toLowerCase())) return 0;
    return Math.max(0,cents(row.remainingAmount ?? row.saldoPendiente ?? row.amount ?? row.totalAmount ?? 0));
  }
  function calculate(input = {}) {
    const records = input.records || [], expenseRecords = input.expenses || [], uberWeeks = input.uberWeeks || [];
    const baseline = input.baseline == null ? cutoffFor(input.closures || []) : Number(input.baseline);
    let effectiveCutoffMs = baseline || 0, opening = cents(input.openingBalance || 0), anchor = null;
    // Old authoritative compensation snapshots are carried as an OPENING balance,
    // never treated as new revenue or as a second reimbursement.
    if (input.useLegacyAnchor !== false) {
      for (const row of records) {
        const stamp = rowTime(row);
        if (!active(row) || !compensation(row) || stamp <= effectiveCutoffMs || row.settlementAfter == null || !Number.isFinite(Number(row.settlementAfter))) continue;
        effectiveCutoffMs = stamp;
        opening = cents(Number(row.settlementAfter));
        anchor = {timestamp:stamp,balance:money(opening)};
      }
    }
    const inPeriod = row => active(row) && (effectiveCutoffMs === 0 || rowTime(row) > effectiveCutoffMs);
    let cash = 0, digital = 0, uberCash = 0, uberDigital = 0, expenseCash = 0, expenseDigital = 0;
    let driverPaid = 0, exploraPaid = 0, advanceRepayments = 0;
    const rows = {cash:[], digital:[], expenses:[], uberCash:[], uberDigital:[], debts:[], adjustments:[]};
    for (const row of records) {
      if (!inPeriod(row) || compensation(row)) continue;
      const value = cents(amount(row)), route = direction(row);
      if (route) {
        const forAdvance = route === 'driver_to_explora' ? Math.min(value,cents(row.advanceRepaymentAmount || 0)) : 0;
        if (route === 'driver_to_explora') driverPaid += value - forAdvance;
        else exploraPaid += value;
        rows.adjustments.push(row);
        continue;
      }
      if (row.excludeFromBillingSettlement === true || row.internalSettlementAdjustment === true || row.internalManagement === true) continue;
      const mode = method(row);
      if (mode === 'cash') { cash += value; rows.cash.push(row); }
      if (mode === 'digital') {
        digital += value; rows.digital.push(row);
        // This money has already been applied to a separate advance balance. It
        // cannot simultaneously be paid out again as the driver's entitlement.
        advanceRepayments += Math.max(0,Math.min(value,cents(row.advanceRepaymentAmount || 0)));
      }
    }
    for (const row of uberWeeks) {
      if (!inPeriod(row) || !uberActive(row)) continue;
      // Uber no longer has its own accounting route. Historical rows are kept
      // immutable but their gross amount behaves exactly like ordinary cash.
      const split = uberSplit(row);
      const explicitGross = cents(row.grossAmount ?? row.totalAmount ?? amount(row));
      const grossUber = explicitGross || split.cash + split.digital;
      if (grossUber < 0) throw new RangeError('Cobro histórico con importe negativo.');
      if (!grossUber) continue;
      cash += grossUber; uberCash += grossUber;
      const statementRow={...row,statementAmount:money(grossUber),statementKind:'uber',statementLabel:'Cobro en efectivo'};
      rows.cash.push(statementRow);
      rows.uberCash.push(statementRow);
    }
    for (const row of expenseRecords) {
      if (!inPeriod(row)) continue;
      const value = cents(amount(row));
      const paidByExplora = ['explora','admin','administrador'].includes(text(row.payerRole || row.paidByRole).toLowerCase());
      if (paidByExplora) expenseDigital += value;
      else expenseCash += value;
      rows.expenses.push(row);
    }
    const gross = cash + digital;
    const expense = expenseCash + expenseDigital;
    const available = gross - expense;
    // A loss never creates a negative reserve or a fictitious refund from Caja.
    const cashbox = Math.round(Math.max(0,available) / 10);
    const toSplit = available - cashbox;
    const driverShare = Math.trunc(toSplit / 2);
    const exploraShare = toSplit - driverShare; // odd cent remains with Explora
    const cashRemaining = cash - expenseCash;
    const digitalRemaining = digital - expenseDigital;
    const periodBalance = cashRemaining - driverShare;
    let adminDebt = 0;
    for (const row of input.debts || []) {
      const pending = debtAmount(row);
      if (!pending) continue;
      adminDebt += pending;
      // Outstanding debts carry across periods; PDF conversion and metadata never move dates.
      rows.debts.push({...row, statementAmount:money(pending)});
    }
    const balance = opening + periodBalance + adminDebt + advanceRepayments - driverPaid + exploraPaid;
    for (const value of [gross,expense,available,cashbox,toSplit,balance]) if (!Number.isSafeInteger(value)) throw new RangeError('Totales fuera del rango admitido.');
    const netBeforePayments = -(opening + periodBalance + adminDebt + advanceRepayments);
    return {
      version:VERSION, baseline, billingCutoffMs:effectiveCutoffMs, effectiveCutoffMs, cutoffMs:effectiveCutoffMs,
      openingBalance:money(opening), legacySettlementAnchor:anchor, rows,
      cash:money(cash), cashRevenue:money(cash), digital:money(digital), digitalRevenue:money(digital),
      uber:money(uberCash+uberDigital), uberCash:money(uberCash), uberTransfer:money(uberDigital),
      uberGrossTotal:money(uberCash+uberDigital), uberCashTotal:money(uberCash), uberTransferTotal:money(uberDigital),
      totalDigital:money(digital), expense:money(expense), expenseTotal:money(expense),
      expenseCash:money(expenseCash), expenseDigital:money(expenseDigital),
      cashRemaining:money(cashRemaining), digitalRemaining:money(digitalRemaining),
      driverHeld:money(cashRemaining), available:money(available), grand:money(gross), gross:money(gross),
      cashBox:money(cashbox), cashboxTotal:money(cashbox), cashboxGeneratedTotal:money(cashbox),
      cashboxResetMs:0, cashboxOffsetPreviouslyApplied:0, regularCashboxGenerated:money(cashbox), uberCashboxGenerated:0,
      totalToSplit:money(toSplit), driverShare:money(driverShare), exploraShare:money(exploraShare),
      shareEach:money(driverShare), billingShareEach:money(driverShare), exploraWithCashbox:money(exploraShare+cashbox),
      periodBalance:money(periodBalance), baseBalance:money(opening+periodBalance+adminDebt+advanceRepayments),
      adminDebt:money(adminDebt), adminDebtTotal:money(adminDebt), driverDebtTotal:money(adminDebt), advanceRepayments:money(advanceRepayments),
      driverPaid:money(driverPaid), exploraPaid:money(exploraPaid), driverSettlementTotal:money(driverPaid), exploraSettlementTotal:money(exploraPaid),
      settlementPaymentTotal:money(driverPaid-exploraPaid), settlementPaymentCount:rows.adjustments.length,
      balance:money(balance), amount:money(Math.abs(balance)), driverWallet:money(balance), exploraWallet:money(-balance),
      netToDriver:money(-balance), netBeforePayments:money(netBeforePayments), amountFromDriver:money(Math.max(0,balance)), amountToDriver:money(Math.max(0,-balance)),
      direction:balance > 0 ? 'driver_to_explora' : balance < 0 ? 'explora_to_driver' : 'balanced',
      from:balance > 0 ? 'cash' : balance < 0 ? 'digital' : 'balanced', to:balance > 0 ? 'digital' : balance < 0 ? 'cash' : 'balanced',
      includedCount:rows.cash.length+rows.digital.length,
      // Kept for consumers of older model properties; no second expense posting.
      cashShare:money(cash)*.55, digitalShare:money(digital)*.45, digitalShareGross:money(digital)*.45,
      uberShare:money(uberCash+uberDigital)*.45, expenseHalf:money(expense)*.5,
      expenseShare:money(expense)*.5, expenseReimbursement:0, reimbursementApplied:0,
      automaticExpenseImpact:0, expenseBillingImpact:0, compensationAvailable:0,
      cashAdjusted:money(cashRemaining+opening+adminDebt+advanceRepayments+exploraPaid),
      digitalAdjusted:money(driverShare+driverPaid), cashDebt:money(cashRemaining), digitalDebt:money(driverShare),
      netBeforeCashboxToDriver:money(Math.trunc(available/2)-cashRemaining)
    };
  }
  function incremental(model, kind, value, destination = 'cash') {
    const amt = cents(value);
    if (amt < 0) throw new RangeError('El importe no puede ser negativo.');
    if (kind === 'debt') return money(amt); // Not income, not expense, not a cash withdrawal.
    const availableBefore = cents(model.available || 0);
    const availableAfter = availableBefore + (kind === 'expense' ? -amt : amt);
    const boxAfter = Math.round(Math.max(0,availableAfter)/10);
    const shareAfter = Math.trunc((availableAfter-boxAfter)/2);
    const shareBefore = cents(model.driverShare || 0);
    const heldChange = kind === 'expense' ? -amt : kind === 'cash' || (kind === 'uber' && destination === 'cash') ? amt : 0;
    return money(heldChange - (shareAfter-shareBefore));
  }
  return Object.freeze({VERSION,calculate,incremental,numeric,amount,rowTime,active,method,direction,compensation,uberActive,uberSplit,cutoffFor,debtAmount,isSelfDeclaredDebt});
});
