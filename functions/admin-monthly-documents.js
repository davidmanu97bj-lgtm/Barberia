'use strict';
const {buildMonthlyReport,loadMonthlyReport,monthlyPdf}=require('./monthly-report');
const owners=['driverUid','choferUid','uid','ownerUid','driverId','choferId','userUid','operatorUid'];
const sources={cobros:'billing_records',gastos:'gastos',cierres:'cierres_semanales',deudas:'deudas_choferes',pagosDeuda:'deuda_pagos',adelantos:'prestamos_operativos',uber:'uber_weekly_closures'};
function belongs(row,uid){return (!row.driverUid||row.driverUid===uid)&&owners.some(field=>row[field]===uid);}
function buildOverview({profiles,input,invoices,month,now=Date.now()}){
  return profiles.filter(p=>!['admin','administrador','owner','superadmin'].includes(String(p.role||p.rol||'').toLowerCase())&&p.id!=='2LziyTTdFcZzSOhK3hLbAKs2U4s2')
    .map(profile=>{
      const owned=Object.fromEntries(Object.entries(input).map(([source,rows])=>[source,rows.filter(row=>belongs(row,profile.id))]));
      const report=buildMonthlyReport({uid:profile.id,profile,month,input:owned,now});
      const attached=invoices.filter(i=>i.driverUid===profile.id&&i.month===month).sort((a,b)=>Number(b.uploadedAtMs||0)-Number(a.uploadedAtMs||0));
      return {uid:profile.id,name:report.driverName,active:profile.active!==false&&profile.activo!==false&&!profile.deleted&&!profile.isDeleted&&!profile.eliminado&&!/inactiv|disabled|eliminad|deleted/.test(String(profile.status||profile.estado||'').toLowerCase()),totals:report.totals,issues:report.issues,closedMonth:report.closedMonth,invoices:attached,hasActivity:report.rows.length>0};
    }).filter(row=>row.active||row.hasActivity||row.invoices.length).sort((a,b)=>a.name.localeCompare(b.name,'es'));
}
module.exports=({db,assertAdmin})=>{
  const {onCall,HttpsError}=require('firebase-functions/v2/https');
  return {adminMonthlyDocuments:onCall({region:'southamerica-east1',timeoutSeconds:300,memory:'512MiB'},async request=>{
    await assertAdmin(request);
    const month=String(request.data?.month||''),uid=String(request.data?.driverUid||'');
    const current=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit'}).format(new Date());
    if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month>current)throw new HttpsError('invalid-argument','Elegí un mes válido.');
    if(uid){
      if(!/^[\w-]{1,128}$/.test(uid))throw new HttpsError('invalid-argument','Chofer inválido.');
      const report=await loadMonthlyReport(db,uid,month);
      return {pdf:{base64:(await monthlyPdf(report)).toString('base64'),filename:`Explora-${report.driverName.replace(/[^a-zA-Z0-9_-]/g,'_')}-${month}.pdf`}};
    }
    return db.runTransaction(async tx=>{
      const names=[...Object.values(sources),'choferes','usuarios','driver_monthly_invoices'];
      const snaps=await Promise.all(names.map(name=>tx.get(db.collection(name))));
      const records=Object.fromEntries(names.map((name,i)=>[name,snaps[i].docs.map(d=>({...d.data(),id:d.id}))]));
      const profiles=new Map(records.choferes.map(p=>[p.id,p]));
      for(const profile of records.usuarios)if(profiles.has(profile.id))profiles.set(profile.id,{...profiles.get(profile.id),...profile});
      return {month,rows:buildOverview({profiles:[...profiles.values()],input:Object.fromEntries(Object.entries(sources).map(([key,name])=>[key,records[name]])),invoices:records.driver_monthly_invoices,month})};
    });
  })};
};
module.exports.buildOverview=buildOverview;
