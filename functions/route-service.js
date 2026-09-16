"use strict";

// Search radius is geographical; it is not road distance or fiscal eligibility.
const LOCAL_CENTER = [-54.5736,-25.5972];
function withinSearchArea(point) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(point[1]-LOCAL_CENTER[1]), dLon = radians(point[0]-LOCAL_CENTER[0]);
  const a = Math.sin(dLat/2)**2 + Math.cos(radians(LOCAL_CENTER[1])) * Math.cos(radians(point[1])) * Math.sin(dLon/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a))) <= 100;
}

class RouteError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function coordinates(value) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite) || Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) {
    throw new RouteError("invalid-argument", "Elegí una dirección válida para cada punto.");
  }
  return value;
}
function validateRouteRequest(data = {}) {
  if (data.action === "search") {
    const query = String(data.query || "").trim();
    if (query.length < 3 || query.length > 160) throw new RouteError("invalid-argument", "Escribí entre 3 y 160 caracteres.");
    return { action:"search", query };
  }
  if (data.action === "route") return { action:"route", origin:coordinates(data.origin), destination:coordinates(data.destination) };
  throw new RouteError("invalid-argument", "Solicitud de recorrido inválida.");
}
async function queryRouteService(data, key, fetcher = fetch) {
  const request = validateRouteRequest(data);
  if (!key) throw new RouteError("failed-precondition", "La búsqueda de direcciones todavía no está activada. Podés completar los datos manualmente.");
  const url = new URL(request.action === "search" ? "https://api.heigit.org/pelias/v1/search" : "https://api.heigit.org/openrouteservice/v2/directions/driving-car/json");
  const options = { headers:{ Authorization:key, "Content-Type":"application/json" }, signal:AbortSignal.timeout(12000) };
  if (request.action === "search") {
    url.searchParams.set("text",request.query);
    url.searchParams.set("size","5");
    url.searchParams.set("boundary.country","ARG,BRA,PRY");
    url.searchParams.set("boundary.circle.lon",String(LOCAL_CENTER[0]));
    url.searchParams.set("boundary.circle.lat",String(LOCAL_CENTER[1]));
    url.searchParams.set("boundary.circle.radius","100");
    url.searchParams.set("focus.point.lon","-54.5736");
    url.searchParams.set("focus.point.lat","-25.5972");
  } else {
    options.method = "POST";
    options.body = JSON.stringify({ coordinates:[request.origin,request.destination], instructions:false });
  }
  let response;
  try { response = await fetcher(url,options); }
  catch { throw new RouteError("unavailable", "No pudimos conectar con las direcciones. Reintentá o cargá el recorrido manualmente."); }
  if (!response.ok) throw new RouteError(response.status === 429 ? "resource-exhausted" : "unavailable", response.status === 429 ? "Se alcanzó el límite de consultas. Podés cargar el recorrido manualmente." : "No pudimos encontrar el recorrido. Revisá los puntos o completá los kilómetros manualmente.");
  let body;
  try { body = await response.json(); } catch { throw new RouteError("unavailable","La respuesta de direcciones no es válida."); }
  if (request.action === "search") {
    const places = (Array.isArray(body.features) ? body.features : []).slice(0,5).flatMap(feature => {
      try {
        const point = coordinates(feature.geometry?.coordinates);
        const country = String(feature.properties?.country_a || "").toUpperCase();
        if (!["ARG","AR","BRA","BR","PRY","PY"].includes(country) || !withinSearchArea(point)) return [];
        const label = String(feature.properties?.label || "").trim().slice(0,160);
        return label ? [{ label, coordinates:point, country }] : [];
      } catch { return []; }
    });
    return { places };
  }
  const meters = body.routes?.[0]?.summary?.distance;
  if (!Number.isFinite(meters) || meters <= 0 || meters > 20000000) throw new RouteError("not-found","No encontramos una ruta entre esos puntos.");
  return { distanceKm:Math.max(0.1,Math.round(meters / 100) / 10), source:"openrouteservice", calculatedAt:new Date().toISOString() };
}
module.exports = { RouteError, validateRouteRequest, queryRouteService };
