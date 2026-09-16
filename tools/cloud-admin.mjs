/** Operations explicitly selected in explora.sh; never run on npm test/build. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {ROOT,PROJECT_ID} from './project.mjs';
import {firebaseConfig} from '../firebase-config.js';
const require=createRequire(path.join(ROOT,'functions/index.js'));
const [action,project,...args]=process.argv.slice(2);
if (!project || project!==PROJECT_ID || project!==firebaseConfig.projectId) throw new Error('El proyecto solicitado no coincide con la configuración del cliente.');
const {initializeApp,applicationDefault}=require('firebase-admin/app');
const {getFirestore,FieldPath,FieldValue}=require('firebase-admin/firestore');
const {getAuth}=require('firebase-admin/auth');
const {getStorage}=require('firebase-admin/storage');
initializeApp({credential:applicationDefault(),projectId:project,storageBucket:firebaseConfig.storageBucket});
const db=getFirestore(),auth=getAuth(),bucket=getStorage().bucket();
const state=path.join(ROOT,'.explora-local');fs.mkdirSync(state,{recursive:true,mode:0o700});
const readPrivate=filename=>JSON.parse(fs.readFileSync(filename,'utf8'));
async function administrator() {
  const input=readPrivate(args[0]);
  const email=String(input.email||'').trim().toLowerCase();
  const alias=String(input.alias||'david').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^[a-z0-9._-]{2,40}$/.test(alias)) throw new Error('Correo o alias inválido.');
  let user;try{user=await auth.getUserByEmail(email);}catch(error){if(error.code!=='auth/user-not-found')throw error;}
  if (!user) {
    if (String(input.password||'').length<12) throw new Error('La contraseña de una cuenta nueva debe tener al menos 12 caracteres.');
    user=await auth.createUser({email,password:input.password,displayName:input.name||'David — Explora',disabled:false});
  }
  await auth.setCustomUserClaims(user.uid,{...user.customClaims,admin:true});
  const name=input.name||user.displayName||'David';
  const batch=db.batch();
  for (const collection of ['usuarios','administradores']) batch.set(db.collection(collection).doc(user.uid),{
    uid:user.uid,authUid:user.uid,email,username:alias,usuario:alias,displayName:name,nombre:name,
    role:'admin',rol:'admin',active:true,activo:true,updatedAt:FieldValue.serverTimestamp()
  },{merge:true});
  batch.set(db.collection('login_aliases').doc(alias),{email,uid:user.uid,authUid:user.uid,active:true,updatedAt:FieldValue.serverTimestamp()},{merge:true});
  await batch.commit();
  console.log(`Administrador habilitado en ${project}. Alias: ${alias}. Cerrá e iniciá sesión para renovar el token.`);
}
async function diagnose() {
  console.log(`Proyecto: ${project}\nBucket: ${bucket.name}`);
  const issues=[];
  try{const metadata=await bucket.getMetadata();console.log('Storage accesible:',metadata[0].name);}catch(e){issues.push('Storage: '+e.code);}
  try{await auth.listUsers(1);console.log('Firebase Authentication accesible.');}catch(e){issues.push('Authentication: '+e.code);}
  try{await db.collection('usuarios').limit(1).get();console.log('Firestore accesible.');}catch(e){issues.push('Firestore: '+e.code);}
  const settings=(await db.collection('arca_settings').doc('current').get()).data()||{};
  console.log(`ARCA: ${settings.enabled===true?settings.environment:'inactiva'}, comprobantes pendientes no se fabrican.`);
  const recent=await db.collection('telegram_notifications').where('status','==','error').limit(10).get();
  console.log(`Avisos Telegram con error (máximo mostrado: 10): ${recent.size}. No se envió ningún mensaje de prueba.`);
  if(issues.length)throw new Error(issues.join('; '));
}
async function configureArca() {
  const cfg=readPrivate(args[0]);
  const {enabled}=require('./arca-worker');
  const cuit=String(cfg.cuit||'').replace(/\D/g,'');
  if(!/^\d{11}$/.test(cuit)||!Number.isInteger(cfg.pointOfSale)||cfg.pointOfSale<1||cfg.pointOfSale>99998)throw new Error('CUIT/punto de venta inválidos.');
  let sum=0;[5,4,3,2,7,6,5,4,3,2].forEach((n,i)=>sum+=Number(cuit[i])*n);
  let check=11-(sum%11);if(check===11)check=0;if(check===10||check!==Number(cuit[10]))throw new Error('El dígito verificador del CUIT no coincide.');
  if(!String(cfg.legalName||'').trim()||!String(cfg.address||'').trim()||!String(cfg.grossIncomeId||'').trim()||!/^\d{4}-\d{2}-\d{2}$/.test(cfg.activityStart||''))throw new Error('Falta razón social, domicilio, IIBB o fecha de inicio.');
  if(!enabled(cfg))throw new Error('ARCA no cumple las condiciones de activación. Primero homologación; producción requiere validaciones explícitas.');
  const previous=(await db.collection('arca_settings').doc('current').get()).data()||{};
  if(previous.enabled===true&&(previous.cuit!==cuit||previous.pointOfSale!==cfg.pointOfSale||previous.environment!==cfg.environment))throw new Error('Ya hay una serie fiscal activa diferente. No se cambiará automáticamente.');
  // Do not enqueue historical movements when activating a new environment.
  const activeFrom=previous.activeFrom||new Date().toISOString();
  await db.collection('arca_settings').doc('current').set({...cfg,cuit,activeFrom,updatedAt:FieldValue.serverTimestamp()},{merge:true});
  console.log(`ARCA configurada en ${cfg.environment}. Inicio: ${activeFrom}. Ninguna factura fue emitida por este comando.`);
}
async function migrate() {
  const apply=args.includes('--apply');
  const {COLLECTIONS,ensureReceiptPdf,sourcePath}=require('./receipt-pdf');
  const checkpoint=path.join(state,`pdf-migration-${project}.json`);
  const previous=apply&&!args.includes('--restart')&&fs.existsSync(checkpoint)?readPrivate(checkpoint):{cursors:{},converted:0,failed:[]};
  const report={project,apply,startedAt:new Date().toISOString(),scanned:0,candidates:0,converted:0,alreadyPdf:0,errors:[]};
  for(const collection of Object.keys(COLLECTIONS)) {
    let cursor=apply?previous.cursors?.[collection]:null;
    while(true) {
      let query=db.collection(collection).orderBy(FieldPath.documentId()).limit(100);
      if(cursor)query=query.startAfter(cursor);
      const page=await query.get();if(page.empty)break;
      for(const snap of page.docs) {
        report.scanned++;
        const data=snap.data();
        if(!data.proofPath&&!data.receiptPath&&!data.proofUrl&&!data.receiptUrl){cursor=snap.id;continue;}
        try {
          const source=sourcePath(data,bucket.name);
          if(source.endsWith('.pdf')||data.receiptPdfSourcePath===source){report.alreadyPdf++;}
          else {
            report.candidates++;
            if(apply){const result=await ensureReceiptPdf({bucket,ref:snap.ref,data,collection,id:snap.id});if(result.converted)report.converted++;}
          }
        }catch(error){report.errors.push({collection,id:snap.id,code:String(error.code||'conversion-failed')});}
        cursor=snap.id;
      }
      if(apply){previous.cursors[collection]=cursor;previous.converted=report.converted;previous.failed=report.errors;fs.writeFileSync(checkpoint,JSON.stringify(previous,null,2),{mode:0o600});}
      if(page.size<100)break;
    }
  }
  report.finishedAt=new Date().toISOString();
  const filename=path.join(state,`pdf-${apply?'aplicada':'simulacion'}-${Date.now()}.json`);
  fs.writeFileSync(filename,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({project,apply,scanned:report.scanned,candidates:report.candidates,converted:report.converted,errors:report.errors.length,report:filename},null,2));
  if(report.errors.length)process.exitCode=2;
}
try {
  if(action==='admin')await administrator();
  else if(action==='doctor')await diagnose();
  else if(action==='arca')await configureArca();
  else if(action==='migrate-pdfs')await migrate();
  else throw new Error('Acción administrativa desconocida.');
}catch(error){console.error(`Operación detenida (${error.code||'error'}): ${error.message}`);process.exitCode=1;}
