"use strict";
const {RouteError,validateRouteRequest}=require('./route-service');
const {summarizeGooglePlace}=require('./address-summary');
const CENTER={latitude:-25.5972,longitude:-54.5736};
function withinArea(point){
  if(!Array.isArray(point)||point.length!==2||!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>90)return false;
  const rad=n=>n*Math.PI/180;
  const a=Math.sin(rad(point[1]-CENTER.latitude)/2)**2+Math.cos(rad(CENTER.latitude))*Math.cos(rad(point[1]))*Math.sin(rad(point[0]-CENTER.longitude)/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)))<=100;
}
async function queryGoogleRoute(data,key,fetcher=fetch){
  const request=validateRouteRequest(data),search=request.action==='search';
  if(!key)throw new RouteError('failed-precondition','Google Maps todavía no está conectado. Podés elegir uno de los lugares de la lista.');
  if(!search&&(!withinArea(request.origin)||!withinArea(request.destination)))throw new RouteError('invalid-argument','Elegí lugares dentro de los 100 km de Puerto Iguazú.');
  const endpoint=search?'https://places.googleapis.com/v1/places:searchText':'https://routes.googleapis.com/directions/v2:computeRoutes';
  const waypoint=p=>({location:{latLng:{latitude:p[1],longitude:p[0]}}});
  const body=search?{textQuery:request.query,languageCode:'es',pageSize:20,locationRestriction:{rectangle:{low:{latitude:-26.51,longitude:-55.58},high:{latitude:-24.68,longitude:-53.56}}}}:{origin:waypoint(request.origin),destination:waypoint(request.destination),travelMode:'DRIVE',routingPreference:'TRAFFIC_UNAWARE'};
  let response;
  try{response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':search?'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents,places.attributions':'routes.distanceMeters'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});}catch{throw new RouteError('unavailable','No pudimos conectar con Google Maps. Reintentá.');}
  if(!response.ok)throw new RouteError(response.status===429?'resource-exhausted':response.status===403?'failed-precondition':'unavailable',response.status===403?'Falta habilitar Google Maps en la cuenta de Explora.':'Google Maps no está disponible en este momento.');
  let result;try{result=await response.json();}catch{throw new RouteError('unavailable','Google Maps devolvió una respuesta inválida.');}
  if(search){
    const places=(Array.isArray(result.places)?result.places:[]).flatMap(place=>{
      const point=[place.location?.longitude,place.location?.latitude];
      const country=place.addressComponents?.find(c=>c.types?.includes('country'))?.shortText;
      if(!withinArea(point)||!['AR','BR','PY'].includes(country)||!place.id)return [];
      const label=summarizeGooglePlace(place).slice(0,300);
      return label?[{id:place.id,label,coordinates:point,country,source:'google',attributions:place.attributions||[]}]:[];
    }).slice(0,8);
    return {places,source:'google'};
  }
  const meters=result.routes?.[0]?.distanceMeters;
  if(!Number.isFinite(meters)||meters<=0||meters>20000000)throw new RouteError('not-found','No encontramos un recorrido entre esos lugares.');
  return {distanceKm:Math.max(.1,Math.round(meters/100)/10),source:'google',calculatedAt:new Date().toISOString()};
}
module.exports={queryGoogleRoute,withinArea};
