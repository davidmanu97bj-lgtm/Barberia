"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {prepareInvoiceDraft}=require('../arca-invoice-draft');
const payment=(method='cash',distanceKm=25,scope='national')=>({amount:100000,method,driverUid:'test',invoiceRequest:{version:'arca_preparation_v1',origin:'Origen de prueba',destination:'Destino de prueba',distanceKm,scope,serviceDate:'2026-09-12',paymentChannel:method,customer:{}}});
test('el total fiscal es el bruto, sin agregar ni descontar caja chica',()=>{
  for(const method of ['cash','digital']) {
    const draft=prepareInvoiceDraft(payment(method),'payment-test');
    assert.equal(draft.total,100000);assert.equal(draft.targetRegime,'monotributo');
    assert.equal(draft.emissionEnabled,false);assert.equal(draft.fiscalValidity,false);
    assert.equal(draft.vatTreatment,'monotributo_no_vat_breakdown');assert.equal(draft.voucherType,11);
    assert.equal(draft.CAE,undefined);
    assert.equal(draft.idempotencyKey,'billing:payment-test');
  }
});
test('ninguna distancia o configuración convierte el borrador en factura exenta',()=>{
  for(const [km,scope,reason] of [[100,'national','national_taxi_eligibility'],[100.1,'national','national_over_100km'],[20,'international','international_transport']]) {
    const draft=prepareInvoiceDraft(payment('cash',km,scope),'test',{regime:'general',cuit:'20111111112',legalName:'Emisor de prueba',pointOfSale:1,emissionEnabled:true,vatTreatment:'exempt'});
    assert.equal(draft.reviewReason,reason);assert.equal(draft.emissionEnabled,false);
    assert.equal(draft.vatTreatment,'pending_review');assert.equal(draft.issuer.registrationVerified,false);
  }
});
test('conserva antiguos y detecta datos incompletos sin fabricar autorización',()=>{
  assert.equal(prepareInvoiceDraft({amount:10},'old'),null);
  const data=payment();data.invoiceRequest.origin='';data.invoiceRequest.distanceKm=NaN;
  const draft=prepareInvoiceDraft(data,'test');
  assert.ok(draft.blockers.includes('route'));assert.ok(draft.blockers.includes('distanceKm'));
  assert.ok(draft.blockers.includes('issuerCuit'));assert.ok(!draft.blockers.includes('customerReview'));assert.ok(draft.blockers.includes('receiver_requirements_unverified'));
});

test('viajes internacionales requieren revisión y un cambio de régimen no supone exención',()=>{
 const cross=prepareInvoiceDraft(payment('digital',30,'international'),'cross');
 assert.equal(cross.voucherType,null);assert.equal(cross.emissionEnabled,false);
 const general=prepareInvoiceDraft(payment(),'general',{regime:'general'});
 assert.equal(general.targetRegime,'general');assert.equal(general.voucherType,null);
 assert.equal(general.vatTreatment,'pending_review');
});
