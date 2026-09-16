import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {shortInvoiceName,shortReceiptName} from '../receipt-files.js';
const require=createRequire(import.meta.url);
const {storagePath,sourcePath,imageToPdf,ensureReceiptPdf,shortName}=require('../functions/receipt-pdf');
const jpeg=fs.readFileSync(new URL('./fixtures/receipt-sample.jpg',import.meta.url));
const bucketName='demo.firebasestorage.app',uid='driver-a',source=`gastos/${uid}/foto.jpg`;
test('comprobantes fiscales con nombre corto solo para facturas autorizadas',()=>{
 assert.equal(shortInvoiceName({status:'queued',number:7,pointOfSale:1}),'');
 assert.equal(shortInvoiceName({status:'authorized',number:637,issuer:{pointOfSale:1},environment:'production'}),'FC-1-637.pdf');
 assert.equal(shortInvoiceName({status:'authorized',number:637,issuer:{pointOfSale:1},environment:'homologation'}),'PRUEBA-FC-1-637.pdf');
 assert.equal(shortReceiptName('expense','abc'),'G-abc.pdf');assert.equal(shortName('gastos','abc'),'G-abc.pdf');
});
test('solo Storage del proyecto y del titular, sin proxy HTTP ni rutas cruzadas',()=>{
 assert.equal(storagePath(source,bucketName,uid),source);
 assert.equal(storagePath(`https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(source)}?alt=media&token=test`,bucketName,uid),source);
 assert.equal(storagePath(`gs://${bucketName}/${source}`,bucketName,uid),source);
 for(const value of ['https://example.test/foto.jpg','http://localhost/secret',`gastos/other/foto.jpg`,`gastos/${uid}/../secret`,`gastos/${uid}//foto.jpg`,`gs://other/${source}`,`https://firebasestorage.googleapis.com/v0/b/other/o/${encodeURIComponent(source)}`])assert.throws(()=>storagePath(value,bucketName,uid),value);
 assert.equal(sourcePath({driverUid:uid,proofPath:source},bucketName),source);
});
test('JPEG a PDF verdadero: cabecera, objeto imagen y tabla xref con offsets válidos',async()=>{
 const pdf=await imageToPdf(jpeg),text=pdf.toString('latin1');
 assert.equal(text.slice(0,8),'%PDF-1.4');assert.match(text,/\/Subtype \/Image/);assert.match(text,/%%EOF\s*$/);
 const offset=Number(text.match(/startxref\s+(\d+)/)[1]);assert.equal(text.slice(offset,offset+4),'xref');
 const entries=text.slice(offset).match(/\d{10} 00000 n/g);assert.ok(entries.length>=4);
 for(const [i,entry] of entries.entries())assert.equal(text.slice(Number(entry.slice(0,10)),Number(entry.slice(0,10))+`${i+1} 0 obj`.length),`${i+1} 0 obj`);
 assert.deepEqual(await imageToPdf(pdf),pdf);
 await assert.rejects(imageToPdf(Buffer.alloc(0)));
});
test('migración idempotente: PDF nuevo, original intacto, sin modificar monto ni fecha',async()=>{
 const objects=new Map([[source,jpeg]]),saves=[];const document={driverUid:uid,amount:40000,createdAtMs:12345,proofPath:source,proofUrl:'source-original'};
 const bucket={name:bucketName,file:path=>({getMetadata:async()=>[{size:objects.get(path)?.length}],download:async()=>[objects.get(path)],save:async(bytes,options)=>{saves.push({path,options});if(objects.has(path))throw Object.assign(Error('exists'),{code:412});objects.set(path,bytes);}})};
 const updates=[];const ref={firestore:{runTransaction:fn=>fn({get:async()=>({exists:true,data:()=>document}),update:(_r,data)=>{updates.push(data);Object.assign(document,data);}})}};
 const first=await ensureReceiptPdf({bucket,ref,data:document,collection:'gastos',id:'g1'});
 const second=await ensureReceiptPdf({bucket,ref,data:document,collection:'gastos',id:'g1'});
 assert.equal(first.path,second.path);assert.equal(first.filename,'G-g1.pdf');assert.equal(objects.size,2);
 assert.deepEqual(objects.get(source),jpeg);assert.equal(document.amount,40000);assert.equal(document.createdAtMs,12345);assert.equal(document.proofPath,source);
 for(const update of updates){assert.equal(update.amount,undefined);assert.equal(update.createdAtMs,undefined);assert.equal(update.proofPath,undefined);}
 assert.equal(saves[0].options.preconditionOpts.ifGenerationMatch,0);assert.equal(saves[0].options.metadata.contentType,'application/pdf');
});
test('si un administrador cambia el adjunto durante la conversión, no se pisan sus metadatos',async()=>{
 const document={driverUid:uid,proofPath:source};let updated=false;
 const bucket={name:bucketName,file:()=>({getMetadata:async()=>[{size:jpeg.length}],download:async()=>[jpeg],save:async()=>{}})};
 const ref={firestore:{runTransaction:fn=>fn({get:async()=>({exists:true,data:()=>({...document,proofPath:`gastos/${uid}/otra.jpg`})}),update:()=>{updated=true;}})}};
 await ensureReceiptPdf({bucket,ref,data:document,collection:'gastos',id:'g1'});assert.equal(updated,false);
});
