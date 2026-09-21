'use strict';
const {onCall,HttpsError}=require('firebase-functions/v2/https');
const {onSchedule}=require('firebase-functions/v2/scheduler');
const {getDownloadURL}=require('firebase-admin/storage');
const {loadMonthlyReport,monthlyPdf}=require('./monthly-report');
module.exports=({db,bucket,assertViewer})=>{
  const options={region:'southamerica-east1',timeoutSeconds:300,memory:'512MiB'};
  async function archive(uid,month) {
    const report=await loadMonthlyReport(db,uid,month),pdf=await monthlyPdf(report);
    const path=`monthly_reports/${uid}/${month}/${report.revision}.pdf`;
    await bucket.file(path).save(pdf,{resumable:false,contentType:'application/pdf'});
    await db.collection('driver_monthly_reports').doc(`${uid}_${month}`).set({driverUid:uid,month,revision:report.revision,pdfPath:path,totals:report.totals,issues:report.issues,generatedAtMs:report.generatedAtMs,closedMonth:report.closedMonth},{merge:true});
    return {...report,pdf:{base64:pdf.toString('base64'),filename:`Explora-resumen-contadora-${month}.pdf`}};
  }
  return {
    driverMonthlyReport:onCall(options,async request=>{
      const uid=await assertViewer(request),month=String(request.data?.month||'');
      try{
        const report=request.data?.pdf===true?await archive(uid,month):await loadMonthlyReport(db,uid,month);
        const invoices=await db.collection('driver_monthly_invoices').where('driverUid','==',uid).get();
        report.invoices=invoices.docs.map(row=>row.data()).filter(row=>row.month===month);
        return report;
      }catch(error){if(error instanceof HttpsError)throw error;throw new HttpsError('failed-precondition','No se pudo preparar el resumen. Verificá el mes y volvé a intentar.');}
    }),
    attachDriverMonthlyInvoice:onCall(options,async request=>{
      const uid=await assertViewer(request),month=String(request.data?.month||''),path=String(request.data?.path||'');
      if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||!path.startsWith(`driver_monthly_invoices/${uid}/${month}/`)||!/^[-\w]+\.pdf$/.test(path.split('/').at(-1))||path.split('/').length!==4)throw new HttpsError('invalid-argument','Archivo inválido.');
      const file=bucket.file(path),[metadata]=await file.getMetadata();if(metadata.contentType!=='application/pdf'||Number(metadata.size)<=0||Number(metadata.size)>15*1024*1024)throw new HttpsError('invalid-argument','Elegí un PDF de hasta 15 MB.');
      const id=path.split('/').at(-1).replace('.pdf','');
      await db.collection('driver_monthly_invoices').doc(`${uid}_${id}`).set({driverUid:uid,month,path,url:await getDownloadURL(file),status:'uploaded',uploadedAtMs:Date.now()},{merge:true});return {ok:true};
    }),
    archiveDriverMonthlyReports:onSchedule({...options,timeoutSeconds:540,schedule:'0 4 1 * *',timeZone:'America/Argentina/Buenos_Aires',retryCount:3},async()=>{
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const [year,month]=today.split('-').map(Number);const previous=new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,7);
      const drivers=new Map();for(const col of ['usuarios','choferes']){const snap=await db.collection(col).get();for(const row of snap.docs){const d=row.data();if(!['admin','administrador'].includes(d.role)&&d.active!==false&&!d.deleted)drivers.set(row.id,d);}}
      for(const uid of drivers.keys())await archive(uid,previous);
    })
  };
};
