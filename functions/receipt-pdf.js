'use strict';
const crypto = require('node:crypto');
const jpegPdf = require('./jpeg-pdf');
const COLLECTIONS = Object.freeze({billing_records:'P',gastos:'G',uber_weekly_closures:'U',
  deudas_choferes:'D',deuda_pagos:'DP',prestamos_operativos:'A',cierres_semanales:'C'});
const MAX_BYTES=15*1024*1024;

function ownerOf(data = {}) {
  return String(data.driverUid || data.choferUid || data.operatorUid || data.uid || data.ownerUid || data.userUid || '').trim();
}
function shortName(collection,id) {
  const suffix=String(id || '').replace(/[^A-Za-z0-9_-]/g,'').slice(-10);
  if (!COLLECTIONS[collection] || !suffix) throw new Error('Referencia de comprobante inválida.');
  return `${COLLECTIONS[collection]}-${suffix}.pdf`;
}
function storagePath(value,bucketName,owner) {
  let path=String(value || '').trim();
  if (/^https?:/i.test(path)) {
    const url=new URL(path);
    if (url.protocol !== 'https:') throw new Error('URL de comprobante no permitida.');
    if (url.hostname === 'firebasestorage.googleapis.com') {
      const match=url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
      if (!match || decodeURIComponent(match[1]) !== bucketName) throw new Error('El comprobante pertenece a otro bucket.');
      path=decodeURIComponent(match[2]);
    } else if (url.hostname === 'storage.googleapis.com') {
      const prefix=`/${bucketName}/`;
      if (!url.pathname.startsWith(prefix)) throw new Error('El comprobante pertenece a otro bucket.');
      path=decodeURIComponent(url.pathname.slice(prefix.length));
    } else throw new Error('Solo se admiten archivos del Storage de este proyecto.');
  } else if (path.startsWith('gs://')) {
    const prefix=`gs://${bucketName}/`;
    if (!path.startsWith(prefix)) throw new Error('El comprobante pertenece a otro bucket.');
    path=path.slice(prefix.length);
  }
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part==='.' || part==='..') || /[\u0000-\u001f]/.test(path)) throw new Error('Ruta de comprobante inválida.');
  // A writable document must never become a proxy to another driver's files.
  if (!owner || !path.split('/').includes(owner)) throw new Error('La ruta no corresponde al titular del movimiento.');
  return path;
}
function sourcePath(data,bucketName) {
  const owner=ownerOf(data);
  const source=data.proofPath || data.receiptPath || data.receiptPdfPath || data.proofUrl || data.receiptUrl;
  return storagePath(source,bucketName,owner);
}
async function imageToPdf(bytes) {
  const input=Buffer.from(bytes);
  if (!input.length || input.length>MAX_BYTES) throw new Error('El comprobante supera 15 MB o está vacío.');
  if (input.subarray(0,5).toString()==='%PDF-') return input;
  if (input[0]===255 && input[1]===216) {
    try { return Buffer.from(jpegPdf.create(input)); } catch { /* CMYK/other JPEG: normalize below. */ }
  }
  try {
    // PNG/WebP/GIF/TIFF and supported HEIF: decode a real image, normalize orientation,
    // keep the first frame, preserve the original object and embed a JPEG in PDF.
    const sharp=require('sharp');
    const jpeg=await sharp(input,{limitInputPixels:80000000,pages:1}).rotate().flatten({background:'#ffffff'})
      .resize({width:4200,height:6000,fit:'inside',withoutEnlargement:true}).jpeg({quality:94}).toBuffer();
    return Buffer.from(jpegPdf.create(jpeg));
  } catch(error) {
    throw Object.assign(new Error('No se pudo decodificar esta imagen histórica. Conservá el original y subí una copia JPG o PNG legible.'),{code:'UNSUPPORTED_IMAGE'});
  }
}
async function ensureReceiptPdf({bucket,ref,data,collection,id}) {
  const filename=shortName(collection,id);
  const owner=ownerOf(data), source=sourcePath(data,bucket.name);
  const file=bucket.file(source);
  const [metadata]=await file.getMetadata();
  if (!Number(metadata.size) || Number(metadata.size)>MAX_BYTES) throw new Error('El comprobante supera 15 MB o está vacío.');
  const [original]=await file.download({validation:'crc32c'});
  const pdf=await imageToPdf(original);
  if (pdf.length>MAX_BYTES) throw new Error('El PDF supera el límite de 15 MB.');
  if (original.subarray(0,5).toString()==='%PDF-') return {bytes:pdf,filename,path:source,converted:false};
  const sourceHash=crypto.createHash('sha256').update(original).digest('hex');
  const target=`receipt_pdfs/${owner}/${collection}/${id}-${sourceHash.slice(0,16)}.pdf`;
  try {
    await bucket.file(target).save(pdf,{resumable:false,validation:'crc32c',preconditionOpts:{ifGenerationMatch:0},
      metadata:{contentType:'application/pdf',contentDisposition:`inline; filename="${filename}"`,
        metadata:{ownerUid:owner,sourcePath:source,sourceSha256:sourceHash,conversion:'image-to-pdf-v1'}}});
  } catch(error) { if (![409,412].includes(Number(error.code))) throw error; }
  // Conversion adds metadata only. Original image, original amount and dates survive.
  // Guard against an admin replacing the proof while this conversion was running.
  if (ref?.firestore?.runTransaction) {
    await ref.firestore.runTransaction(async tx => {
      const latest=await tx.get(ref);
      if (!latest.exists || sourcePath(latest.data(),bucket.name)!==source) return;
      tx.update(ref,{receiptPdfPath:target,receiptPdfFileName:filename,receiptPdfSourcePath:source,
        receiptPdfSourceSha256:sourceHash,receiptPdfMimeType:'application/pdf'});
    });
  }
  return {bytes:pdf,filename,path:target,converted:true};
}
function createReceiptPdfFunction({db,bucket,assertViewer,assertAdmin}) {
  const {onCall,HttpsError}=require('firebase-functions/v2/https');
  return onCall({region:'southamerica-east1',memory:'512MiB',timeoutSeconds:90,maxInstances:5,invoker:'public'},async request => {
    const uid=await assertViewer(request);
    const collection=String(request.data?.collectionName || ''), id=String(request.data?.id || '');
    if (!COLLECTIONS[collection] || !/^[A-Za-z0-9_-]{1,180}$/.test(id)) throw new HttpsError('invalid-argument','Comprobante inválido.');
    const ref=db.collection(collection).doc(id), snapshot=await ref.get();
    if (!snapshot.exists) throw new HttpsError('not-found','El movimiento ya no está disponible.');
    const data=snapshot.data();
    if (ownerOf(data)!==uid) await assertAdmin(request);
    try {
      const result=await ensureReceiptPdf({bucket,ref,data,collection,id});
      return {base64:result.bytes.toString('base64'),filename:result.filename,converted:result.converted};
    } catch(error) {
      console.error('receiptPdf',collection,id,error.code || error.message);
      throw new HttpsError('failed-precondition',error.code==='UNSUPPORTED_IMAGE' ? error.message : 'No se pudo preparar el PDF. Revisá que el comprobante original exista en Storage y corresponda al chofer.');
    }
  });
}
module.exports={COLLECTIONS,MAX_BYTES,ownerOf,shortName,storagePath,sourcePath,imageToPdf,ensureReceiptPdf,createReceiptPdfFunction};
