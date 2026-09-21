'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarizeAddress,summarizeGooglePlace}=require('../address-summary');
const {queryGoogleRoute}=require('../google-route-service');
const {billingSummary}=require('../telegram-compact');
const component=(type,longText,shortText=longText)=>({types:[type],longText,shortText});
const place={id:'hotel-example',displayName:{text:'Hotel Ejemplo'},formattedAddress:'Av. Victoria Aguirre 123, N3370ABC Puerto Iguazú, Misiones, Argentina',location:{latitude:-25.5972,longitude:-54.5736},addressComponents:[component('route','Av. Victoria Aguirre'),component('street_number','123'),component('locality','Puerto Iguazú'),component('administrative_area_level_1','Misiones'),component('postal_code','N3370ABC'),component('country','Argentina','AR')]};
test('Maps resume lugar, calle y ciudad sin provincia, país ni código postal, manteniendo coordenadas e identificación',async()=>{
  const result=await queryGoogleRoute({action:'search',query:'Hotel Ejemplo'},'test',async()=>({ok:true,json:async()=>({places:[place]})}));
  assert.equal(result.places[0].label,'Hotel Ejemplo · Av. Victoria Aguirre 123 · Puerto Iguazú');
  assert.equal(result.places[0].id,place.id);
  assert.deepEqual(result.places[0].coordinates,[-54.5736,-25.5972]);
  assert.equal(result.places[0].country,'AR');
});
test('una dirección no repite la calle y conserva altura; ciudades distinguen sucursales',()=>{
  assert.equal(summarizeGooglePlace({...place,displayName:{text:'Av. Victoria Aguirre 123'}}),'Av. Victoria Aguirre 123 · Puerto Iguazú');
  const brazil={...place,addressComponents:[component('route','Av. das Cataratas'),component('street_number','1000'),component('administrative_area_level_2','Foz do Iguaçu'),component('postal_code','85853-000'),component('country','Brasil','BR')]};
  assert.equal(summarizeGooglePlace(brazil),'Hotel Ejemplo · Av. das Cataratas 1000 · Foz do Iguaçu');
  assert.equal(summarizeGooglePlace({...place,addressComponents:[component('locality','Ciudad del Este')]}),'Hotel Ejemplo · Ciudad del Este');
});
test('sin componentes Google se resume la dirección disponible; no se inventan datos',()=>{
  assert.equal(summarizeGooglePlace({...place,addressComponents:[]}),'Hotel Ejemplo · Av. Victoria Aguirre 123 · Puerto Iguazú');
  assert.equal(summarizeGooglePlace({displayName:{text:'Aeropuerto Iguazú'}}),'Aeropuerto Iguazú');
  assert.equal(summarizeAddress('Ruta Nacional 12 km 5 · Puerto Iguazú'),'Ruta Nacional 12 km 5 · Puerto Iguazú');
});
test('Telegram resume etiquetas antiguas y nuevas de salida y destino en efectivo y digital',()=>{
  const origin='Hotel Ejemplo · Av. Victoria Aguirre 123, N3370ABC Puerto Iguazú, Misiones, Argentina';
  const destination='Hotel Brasil · Av. das Cataratas, 1000, Foz do Iguaçu - PR, 85853-000, Brasil';
  for(const cash of [true,false]){
    const result=billingSummary({data:{invoiceRequest:{origin,destination}},driverName:'Javier',amount:70000,cash});
    assert.match(result,/Detalle: Hotel Ejemplo · Av\. Victoria Aguirre 123 · Puerto Iguazú → Hotel Brasil · Av\. das Cataratas · 1000 · Foz do Iguaçu/);
    assert.doesNotMatch(result,/N3370|85853|Misiones|Argentina| - PR/);
    assert.match(result,/70\.000/);
  }
  const short=summarizeGooglePlace(place);
  assert.equal(summarizeAddress(short),short);
});
