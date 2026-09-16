"use strict";
const PDFDocument=require('pdfkit');
const QRCode=require('qrcode');
const date = s => `${s.slice(6,8)}/${s.slice(4,6)}/${s.slice(0,4)}`;
function qrUrl(invoice) {
  const d=invoice.detail;
  const data={ver:1,fecha:`${d.CbteFch.slice(0,4)}-${d.CbteFch.slice(4,6)}-${d.CbteFch.slice(6,8)}`,cuit:Number(invoice.issuer.cuit),ptoVta:invoice.issuer.pointOfSale,tipoCmp:11,nroCmp:invoice.number,importe:d.ImpTotal,moneda:d.MonId,ctz:d.MonCotiz,tipoDocRec:d.DocTipo,nroDocRec:Number(d.DocNro),tipoCodAut:'E',codAut:Number(invoice.cae)};
  return 'https://www.arca.gob.ar/fe/qr/?p='+encodeURIComponent(Buffer.from(JSON.stringify(data)).toString('base64'));
}
async function invoicePdf(invoice) {
  if(invoice.status!=='authorized'||!/^\d{14}$/.test(invoice.cae)||!invoice.number)throw new Error('INVOICE_NOT_AUTHORIZED');
  const doc=new PDFDocument({size:'A4',margin:45,info:{Title:'Factura C - Explora'}}),buffers=[];
  const done=new Promise((resolve,reject)=>{doc.on('data',b=>buffers.push(b));doc.on('end',()=>resolve(Buffer.concat(buffers)));doc.on('error',reject);});
  const i=invoice.issuer,d=invoice.detail;
  const test=invoice.environment!=='production';
  const qr=test?null:await QRCode.toBuffer(qrUrl(invoice),{width:140,margin:1});
  doc.fillColor('#10144a').font('Helvetica-Bold').fontSize(23).text('EXPLORA');
  doc.fontSize(18).text('FACTURA C',360,45,{width:190,align:'right'});
  doc.font('Helvetica').fontSize(10).text('Código 011 · ORIGINAL',360,71,{width:190,align:'right'});
  doc.text(`${String(i.pointOfSale).padStart(5,'0')}-${String(invoice.number).padStart(8,'0')}`,360,88,{width:190,align:'right'});
  doc.text(`Fecha de emisión: ${date(d.CbteFch)}`,360,105,{width:190,align:'right'});
  doc.fontSize(11).text(i.legalName,45,87,{width:290}).text(`CUIT: ${i.cuit}`).text('Responsable Monotributo');
  doc.text(i.address,{width:300}).text(`Ingresos Brutos: ${i.grossIncomeId}`,{width:300}).text(`Inicio de actividades: ${i.activityStart}`);
  doc.moveTo(45,215).lineTo(550,215).strokeColor('#d8dfed').stroke();
  doc.font('Helvetica-Bold').text('RECEPTOR',45,235);
  doc.font('Helvetica').text(invoice.customer.name,{width:505});
  const vat={1:'Responsable inscripto',4:'IVA exento',5:'Consumidor final',6:'Monotributista'}[d.CondicionIVAReceptorId];
  doc.text(`Condición frente al IVA: ${vat}`);
  if(d.DocTipo!==99)doc.text(`${{80:'CUIT',96:'DNI',94:'Pasaporte'}[d.DocTipo]||'Documento'}: ${d.DocNro}`);
  doc.moveDown().text(`Servicio desde ${date(d.FchServDesde)} hasta ${date(d.FchServHasta)}`);
  doc.text(`Vencimiento de pago: ${date(d.FchVtoPago)}`);
  doc.text(`Condición de venta: contado · ${invoice.paymentMethod==='cash'?'Efectivo':'Digital'}`);
  doc.moveDown(2).font('Helvetica-Bold').text('DETALLE DEL SERVICIO');
  doc.font('Helvetica').text(invoice.description.replace('→','a'),{width:500});
  doc.moveDown().text('Cantidad: 1');
  doc.font('Helvetica-Bold').fontSize(18).text(`TOTAL ARS ${d.ImpTotal.toLocaleString('es-AR',{minimumFractionDigits:2})}`,45,520,{align:'right',width:505});
  if(test)doc.fillColor('#a32020').fontSize(14).text('HOMOLOGACIÓN · SIN VALIDEZ FISCAL',45,580,{align:'center',width:505});
  if(qr)doc.image(qr,45,645,{width:105});
  doc.fillColor('#10144a').font('Helvetica').fontSize(11).text(`CAE: ${invoice.cae}`,170,663).text(`Vencimiento CAE: ${date(invoice.caeExpires)}`);
  doc.fontSize(9).text(test?'Comprobante de prueba autorizado en homologación.':'Comprobante autorizado por ARCA.',170,715,{width:370});
  doc.end();return done;
}
module.exports={invoicePdf,qrUrl};
