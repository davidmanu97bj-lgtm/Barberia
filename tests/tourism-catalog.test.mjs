import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tourismCatalog as c,tourismRoute,searchTourismPlaces} from '../tourism-catalog.js';
test('catálogo: seis ciudades, identificadores únicos y matriz completa de ida y vuelta',()=>{
 assert.equal(new Set(c.places.map(p=>p.city)).size,6);
 assert.equal(new Set(c.places.map(p=>p.id)).size,c.places.length);
 assert.equal(c.distances.length,c.places.length);
 let count=0;
 for(let i=0;i<c.places.length;i++){
  assert.equal(c.distances[i].length,c.places.length);
  for(let j=0;j<c.places.length;j++){
   if(i===j){assert.equal(tourismRoute(c.places[i].id,c.places[j].id),null);continue;}
   const route=tourismRoute(c.places[i].id,c.places[j].id);
   assert.ok(route.distance>0 && route.distance<20000);
   assert.equal(route.origin.id,c.places[i].id);assert.equal(route.destination.id,c.places[j].id);
   count++;
  }
 }
 assert.equal(count,c.places.length*(c.places.length-1));
});
test('catálogo: conserva la medición comprobada aeropuerto-terminal y rechaza opciones inválidas',()=>{
 const airport=c.places.find(p=>p.name==='Aeropuerto Internacional de Puerto Iguazú');
 const terminal=c.places.find(p=>p.name==='Terminal de Ómnibus de Puerto Iguazú');
 assert.equal(tourismRoute(airport.id,terminal.id).distance,20.2);
 assert.equal(tourismRoute('missing',terminal.id),null);
 assert.equal(tourismRoute(airport.id,''),null);
});

test("búsqueda local tolera tildes, fragmentos y errores sin elegir automáticamente",()=>{
 assert.ok(searchTourismPlaces("catarats arg").some(p=>p.id==="cataratas-argentina"));
 assert.ok(searchTourismPlaces("picafloerz").some(p=>p.name.includes("Picaflores")));
 assert.ok(searchTourismPlaces("iguazu").length>0);
 assert.deepEqual(searchTourismPlaces("zzzzzzzz"),[]);
 assert.deepEqual(searchTourismPlaces(""),[]);
 const point=c.places.find(p=>p.id==="cataratas-argentina");
 assert.ok(point && c.places.every(p=>p.id===point.id || tourismRoute(p.id,point.id)));
});

test('países filtran solos y combinados con lugares y errores',()=>{
 for(const [query,country] of [['paraguay','PRY'],['paraguai','PRY'],['brasil','BRA'],['brazil','BRA'],['argentina','ARG'],['aduana paraguai','PRY'],['aduana brasil','BRA']]){
  const results=searchTourismPlaces(query);assert.ok(results.length,query);assert.ok(results.every(p=>p.country===country),query);
 }
 assert.ok(searchTourismPlaces('cabecera paraguai').some(p=>p.id==='aduana-amistad-paraguay'));
 assert.ok(searchTourismPlaces('tancredo argentina').some(p=>p.id==='aduana-tancredo-argentina'));
 assert.deepEqual(searchTourismPlaces('cataratas paraguay'),[]);
});

test('sugerencias priorizan habituales y aprenden sin ignorar país ni coincidencia',()=>{
 assert.equal(searchTourismPlaces('',{},true)[0].id,'cataratas-argentina');
 assert.equal(searchTourismPlaces('',{'place-2':4},true)[0].id,'place-2');
 assert.ok(searchTourismPlaces('brasil',{'place-2':100},true).every(p=>p.country==='BRA'));
 assert.equal(searchTourismPlaces('picafloerz',{'place-2':100},true)[0].name,'Jardín de los Picaflores');
});
