"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {queryRouteService,validateRouteRequest} = require("../route-service");
test("rutas: rechaza acciones y coordenadas inválidas antes de contactar al proveedor", () => {
  for (const data of [{action:"other"},{action:"search",query:"a"},{action:"route",origin:[181,0],destination:[0,0]},{action:"route",origin:["1",2],destination:[0,0]}]) assert.throws(()=>validateRouteRequest(data));
});
test("rutas: sin clave no consulta y devuelve un error recuperable", async () => {
  await assert.rejects(queryRouteService({action:"search",query:"Iguazú"},"",()=>assert.fail("No debe consultar")),{code:"failed-precondition"});
});
test("rutas: búsqueda acotada, clave solo en cabecera y resultados sanitizados", async () => {
  const result = await queryRouteService({action:"search",query:"Hotel Iguazú"},"test-key",async (url,options)=> {
    assert.equal(url.hostname,"api.heigit.org");
    assert.equal(url.pathname,"/pelias/v1/search");
    assert.equal(url.searchParams.get("text"),"Hotel Iguazú");
    assert.equal(url.searchParams.get("size"),"5");
    assert.equal(url.searchParams.get("boundary.country"),"ARG,BRA,PRY");
    assert.equal(url.searchParams.get("boundary.circle.radius"),"100");
    assert.equal(url.searchParams.has("api_key"),false);
    assert.equal(options.headers.Authorization,"test-key");
    return {ok:true,json:async()=>({features:[{properties:{label:"Lugar de prueba",country_a:"ARG",secret:"discard"},geometry:{coordinates:[-54.57,-25.60]}},{properties:{label:"Inválido"},geometry:{coordinates:[500,0]}}]})};
  });
  assert.deepEqual(result.places,[{label:"Lugar de prueba",coordinates:[-54.57,-25.60],country:"ARG"}]);
});
test("rutas: calcula kilómetros por carretera y conserva orden longitud latitud",async()=> {
  const result = await queryRouteService({action:"route",origin:[-54,-25],destination:[-55,-26]},"test-key",async(url,options)=> {
    assert.equal(url.pathname,"/openrouteservice/v2/directions/driving-car/json");
    assert.deepEqual(JSON.parse(options.body).coordinates,[[-54,-25],[-55,-26]]);
    return {ok:true,json:async()=>({routes:[{summary:{distance:12345}}]})};
  });
  assert.equal(result.distanceKm,12.3);
  assert.equal(result.source,"openrouteservice");
});
test("rutas: incluye las tres fronteras y descarta lugares fuera de 100 km",async()=> {
  const feature=(label,country_a,coordinates)=>({properties:{label,country_a},geometry:{coordinates}});
  const result=await queryRouteService({action:"search",query:"Terminal"},"test",async()=>({ok:true,json:async()=>({features:[
    feature("Local","ARG",[-54.57,-25.60]),
    feature("Brasil","BRA",[-54.57,-25.55]),
    feature("Paraguay","PRY",[-54.62,-25.55]),
    feature("Lejano","ARG",[-54.57,-27.00]),
    feature("Sin país",undefined,[-54.57,-25.60])
  ]})}));
  assert.deepEqual(result.places.map(place=>place.label),["Local","Brasil","Paraguay"]);
});
test("rutas: cuota, red y ruta vacía nunca producen kilómetros ficticios",async()=> {
  const input={action:"route",origin:[-54,-25],destination:[-55,-26]};
  await assert.rejects(queryRouteService(input,"test",async()=>({ok:false,status:429})),{code:"resource-exhausted"});
  await assert.rejects(queryRouteService(input,"test",async()=>{throw Error("secret provider error");}),{code:"unavailable"});
  await assert.rejects(queryRouteService(input,"test",async()=>({ok:true,json:async()=>({routes:[]})})),{code:"not-found"});
});
