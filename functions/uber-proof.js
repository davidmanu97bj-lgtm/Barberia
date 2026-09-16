"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { Timestamp } = require("firebase-admin/firestore");

function eligibleUberWeek(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone:"America/Argentina/Buenos_Aires", year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  const date = new Date(`${part("year")}-${part("month")}-${part("day")}T12:00:00Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day + 6) % 7 - (day === 1 ? 14 : 7));
  const start = date.toISOString().slice(0,10);
  date.setUTCDate(date.getUTCDate() + 7);
  return start < "2026-09-07" ? null : {start, close:date.toISOString().slice(0,10)};
}

function normalizeText(text) {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[–—−]/g, "-");
}
const monthNames = ["ene(?:ro)?", "feb(?:rero)?", "mar(?:zo)?", "abr(?:il)?", "may(?:o)?", "jun(?:io)?", "jul(?:io)?", "ago(?:sto)?", "sep(?:t(?:iembre)?|tiembre)?", "oct(?:ubre)?", "nov(?:iembre)?", "dic(?:iembre)?"];
function datePattern(key, optionalMonth = false) {
  const [,m,d] = key.split("-").map(Number);
  const month = `(?:${monthNames[m-1]}\\.?|0?${m})`;
  const suffix = `\\s*(?:[/.]\\s*|de\\s+)?${month}`;
  return `0?${d}` + (optionalMonth ? `(?:${suffix})?` : suffix);
}
function readAmount(text) {
  let value = text.replace(/\s/g, "");
  // Uber in Argentina displays dot thousands and comma cents; also accept English locale.
  if (/[,\.]\d{2}$/.test(value)) {
    const cents = value.slice(-2);
    return Number(value.slice(0,-3).replace(/[.,]/g,"")) + Number(cents) / 100;
  }
  return Number(value.replace(/[.,]/g,""));
}
function validateUberText(text, confidence, week, amount) {
  const normalized = normalizeText(text);
  const fail = reason => ({valid:false, reason});
  if (!week || confidence < 60 || normalized.length < 15) return fail("No pudimos leer la captura. Subí una imagen completa y nítida de las ganancias semanales.");
  if (/ejemplo|este es el numero|demostracion/.test(normalized)) return fail("La imagen es un ejemplo. Subí la captura real de tu semana en Uber Driver.");
  if (!/\bganancias\b/.test(normalized) || /ganancias del viaje|detalle del viaje|recibo del viaje/.test(normalized)) return fail("Esa no es la pantalla de ganancias semanales. Abrí Ganancias y elegí la semana indicada.");
  // Require a complete seven-day range in the header, not a date elsewhere in a trip list.
  const currency = /(?:ars\s*\$?|\$)\s*\d/;
  const firstCurrency = normalized.search(currency);
  const header = normalized.slice(0, Math.min(firstCurrency < 0 ? 350 : firstCurrency, 350));
  const sameMonth = week.start.slice(0,7) === week.close.slice(0,7);
  const separator = "\\s*(?:del?\\s+)?(?:-|al?|hasta)\\s*";
  const range = new RegExp(`(?:^|\\D)${datePattern(week.start,sameMonth)}(?:[ /,]+20\\d{2})?${separator}${datePattern(week.close)}(?!\\d)`);
  if (!range.test(header)) return fail("La semana no coincide o sus fechas no se leen completas. Subí las ganancias de la semana indicada.");
  const years = header.match(/\b20\d{2}\b/g) || [];
  if (years.some(year => ![week.start.slice(0,4),week.close.slice(0,4)].includes(year))) return fail("El año de la captura no corresponde a esta semana.");
  // Read the main amount below the heading. Do not accept a coinciding fee or withdrawal.
  const earnings = normalized.slice(normalized.indexOf("ganancias"));
  const first = earnings.match(/(?:ars\s*\$?|\$)\s*([\d][\d., ]*)/);
  if (!first || Math.abs(readAmount(first[1]) - amount) > 0.01) return fail("El total de la captura no coincide con el monto ingresado. Revisá el importe o elegí otra captura.");
  return {valid:true, amount, weekStartDate:week.start, weekCloseDate:week.close};
}

async function recognizeScreenshot(bytes) {
  const { createWorker } = require("tesseract.js");
  const worker = await createWorker("spa", 1, {langPath:path.join(__dirname,"ocr-data"), gzip:true, cacheMethod:"none", errorHandler:() => {}});
  try {
    await worker.setParameters({tessedit_pageseg_mode:"11"});
    const {data} = await worker.recognize(bytes);
    return data;
  } finally { await worker.terminate(); }
}

function createUberProofFunction({db, bucket, assertViewer}) {
  return onCall({region:"southamerica-east1", timeoutSeconds:90, memory:"1GiB", concurrency:1, maxInstances:2}, async request => {
    const uid = await assertViewer(request);
    const week = eligibleUberWeek();
    const input = request.data || {};
    const amount = Number(input.amount);
    if (!week || input.weekStartDate !== week.start || input.weekCloseDate !== week.close) throw new HttpsError("failed-precondition","Esta semana todavía no está disponible. Volvé al inicio.");
    if (!(amount > 0) || amount > 100000000 || !Number.isFinite(amount)) throw new HttpsError("invalid-argument","Revisá el monto de la liquidación.");
    if (typeof input.image !== "string" || input.image.length > 5600000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.image)) throw new HttpsError("invalid-argument","Subí una captura de hasta 4 MB.");
    const bytes = Buffer.from(input.image, "base64");
    if (bytes.length > 4 * 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new HttpsError("invalid-argument","La captura no se pudo abrir. Elegí otra foto.");
    const usageRef = db.collection("uber_proof_usage").doc(uid);
    const day = new Date().toISOString().slice(0,10), minute = Math.floor(Date.now()/60000);
    await db.runTransaction(async tx => {
      const previous = (await tx.get(usageRef)).data() || {};
      const daily = previous.day === day ? Number(previous.daily || 0) : 0;
      const recent = previous.minute === minute ? Number(previous.recent || 0) : 0;
      if (daily >= 20 || recent >= 3) throw new HttpsError("resource-exhausted","Esperá un momento antes de volver a revisar la captura.");
      tx.set(usageRef,{day,minute,daily:daily+1,recent:recent+1});
    });
    let data;
    try { data = await recognizeScreenshot(bytes); }
    catch (_) { throw new HttpsError("unavailable","No se pudo leer la captura. Probá con otra imagen nítida."); }
    const result = validateUberText(data.text,data.confidence,week,amount);
    if (!result.valid) return result;
    // Invalid images never reach Storage or the financial collection. Valid proofs
    // are immutable, server-written, and bound to the exact owner/week/amount.
    const id = crypto.randomUUID(), photoToken = crypto.randomUUID(), pdfToken = crypto.randomUUID();
    const telegramPhotoPath = `uber_verified/${uid}/${id}.jpg`;
    const proofPath = `uber_verified/${uid}/${id}.pdf`;
    const pdf = Buffer.from(require("./jpeg-pdf").create(bytes));
    await bucket.file(telegramPhotoPath).save(bytes,{resumable:false,metadata:{contentType:"image/jpeg",metadata:{firebaseStorageDownloadTokens:photoToken}}});
    await bucket.file(proofPath).save(pdf,{resumable:false,metadata:{contentType:"application/pdf",metadata:{firebaseStorageDownloadTokens:pdfToken}}});
    const download = (path,token) => `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    const proofUrl=download(proofPath,pdfToken),telegramPhotoUrl=download(telegramPhotoPath,photoToken);
    await db.collection("uber_proof_checks").doc(id).set({uid,amount,weekStartDate:week.start,weekCloseDate:week.close,
      proofPath,proofUrl,telegramPhotoPath,telegramPhotoUrl,valid:true,createdAt:Timestamp.now(),expiresAt:Timestamp.fromMillis(Date.now()+3600000),imageHash:crypto.createHash("sha256").update(bytes).digest("hex")});
    return {...result,id,proofPath,proofUrl};
  });
}
module.exports = {eligibleUberWeek, validateUberText, recognizeScreenshot, createUberProofFunction};
