import './functions/jpeg-pdf.js';

const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_SIDE = 3200;

export function shortReceiptName(kind, id) {
  const prefixes = {expense:'G',uber:'U',payment:'P',debt:'D',advance:'A',closure:'C',management:'P',debtPayment:'DP'};
  const suffix = String(id || '').replace(/[^A-Za-z0-9_-]/g,'').slice(-10);
  if (!suffix) throw new Error('El comprobante necesita un identificador.');
  return `${prefixes[kind] || 'R'}-${suffix}.pdf`;
}

export function shortInvoiceName(invoice = {}) {
  if (invoice.status !== 'authorized') return '';
  const pos = Number(invoice.issuer?.pointOfSale || invoice.pointOfSale || 0), number = Number(invoice.number || 0);
  if (!Number.isInteger(pos) || pos < 1 || !Number.isInteger(number) || number < 1) return '';
  return `${invoice.environment === 'production' ? 'FC' : 'PRUEBA-FC'}-${pos}-${number}.pdf`;
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('No se pudo preparar la imagen.')),mime,quality));
}

// Fast path used by operational charges/expenses: normalize one image first and
// let the server prepare the PDF after the movement has already been confirmed.
export async function createReceiptPhoto(file) {
  if (!file || !file.size || file.size > MAX_SOURCE_BYTES) throw new Error('Adjuntá un comprobante de hasta 15 MB.');
  if (!String(file.type || '').startsWith('image/')) throw new Error('Usá una foto JPG, PNG o WebP legible.');
  const sourceUrl=URL.createObjectURL(file);
  try {
    const image=new Image();image.src=sourceUrl;
    try { await image.decode(); } catch { throw new Error('No se pudo abrir la imagen. Guardala como JPG o PNG y volvé a adjuntarla.'); }
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Imagen vacía.');
    if (image.naturalWidth*image.naturalHeight>80000000) throw new Error('La imagen tiene demasiados píxeles. Usá una copia más pequeña.');
    const factor=Math.min(1,MAX_IMAGE_SIDE/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(image.naturalWidth*factor));
    canvas.height=Math.max(1,Math.round(image.naturalHeight*factor));
    const context=canvas.getContext('2d');
    if (!context) throw new Error('Tu navegador no pudo preparar el comprobante.');
    context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(image,0,0,canvas.width,canvas.height);
    let photo=await canvasBlob(canvas,'image/jpeg',0.90);
    if (photo.size>5*1024*1024) photo=await canvasBlob(canvas,'image/jpeg',0.78);
    if (photo.size>8*1024*1024) throw new Error('La foto es demasiado pesada. Elegí una imagen más pequeña.');
    return photo;
  } finally { URL.revokeObjectURL(sourceUrl); }
}

// Historical/admin flows can still request an immediate PDF bundle.
export async function createReceiptBundle(file, filename) {
  if (!file || !file.size || file.size > MAX_SOURCE_BYTES) throw new Error('Adjuntá un comprobante de hasta 15 MB.');
  if (!/\.pdf$/i.test(filename || '')) throw new Error('Nombre PDF inválido.');
  const head = new Uint8Array(await file.slice(0,8).arrayBuffer());
  const isPdf = new TextDecoder().decode(head).startsWith('%PDF-');
  if (isPdf) return {pdf:file, filename, photo:null};
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) throw new Error('El archivo no contiene un PDF válido.');
  const photo=await createReceiptPhoto(file);
  const bytes=globalThis.ExploraJpegPdf.create(new Uint8Array(await photo.arrayBuffer()));
  return {photo,pdf:new Blob([bytes],{type:'application/pdf'}),filename};
}
