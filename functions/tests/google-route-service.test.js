'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {queryGoogleRoute,withinArea}=require('../google-route-service');
test('Google: devuelve solo lugares dentro de 100 km y protege la clave',async()=>{
  const place=(id,lat,country='AR')=>({id,displayName:{text:id},location:{latitude:lat,longitude:-54.5736},addressComponents:[{types:['country'],shortText:country}]});
  const result=await queryGoogleRoute({action:'search',query:'hotel'},'test-only',async(url,options)=>{
    assert.equal(url,'https://places.googleapis.com/v1/places:searchText');assert.equal(options.headers['X-Goog-Api-Key'],'test-only');assert.ok(!url.includes('test-only'));
    assert.ok(JSON.parse(options.body).locationRestriction.rectangle);
    return {ok:true,json:async()=>({places:[place('Local',-25.6),place('Brasil',-25.55,'BR'),place('Paraguay',-25.55,'PY'),place('Lejano',-27),place('Inválido',200)]})};
  });
  assert.deepEqual(result.places.map(p=>p.id),['Local','Brasil','Paraguay']);
});
test('Google: filtro circular incluye 99 km y excluye 101 km',()=>{
  assert.equal(withinArea([-54.5736,-25.5972+99/6371*180/Math.PI]),true);
  assert.equal(withinArea([-54.5736,-25.5972+101/6371*180/Math.PI]),false);
});
test('Google: no consulta sin clave ni con puntos fuera del radio',async()=>{
  const never=()=>assert.fail('No debe contactar al proveedor');
  await assert.rejects(queryGoogleRoute({action:'search',query:'hotel'},'',never),{code:'failed-precondition'});
  await assert.rejects(queryGoogleRoute({action:'route',origin:[-54.57,-25.6],destination:[-58,-34]},'test',never),{code:'invalid-argument'});
});
test('Google: kilómetros reales de ruta y errores sin datos ficticios',async()=>{
  const input={action:'route',origin:[-54.57,-25.6],destination:[-54.58,-25.61]};
  const result=await queryGoogleRoute(input,'test',async(url,options)=>{
    assert.equal(JSON.parse(options.body).origin.location.latLng.longitude,-54.57);
    return {ok:true,json:async()=>({routes:[{distanceMeters:12345}]})};
  });assert.equal(result.distanceKm,12.3);
  await assert.rejects(queryGoogleRoute(input,'test',async()=>({ok:false,status:403})),{code:'failed-precondition'});
  await assert.rejects(queryGoogleRoute(input,'test',async()=>({ok:false,status:429})),{code:'resource-exhausted'});
  await assert.rejects(queryGoogleRoute(input,'test',async()=>({ok:true,json:async()=>({routes:[]})})),{code:'not-found'});
});
