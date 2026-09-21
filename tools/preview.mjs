import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {ROOT,HOSTING_FILES} from './project.mjs';
import {MemoryStore} from './preview/memory-store.mjs';
const require=createRequire(import.meta.url);
const mapsSecretPath=path.join(ROOT,'.env.maps.local');
if(fs.existsSync(mapsSecretPath))process.loadEnvFile(mapsSecretPath);
const port=Number(process.env.PORT || 8080);
const previewAdmin=process.env.PREVIEW_ROLE==='admin';
const uid=previewAdmin?'preview-admin':'preview-driver', now=Date.now();
const profile={uid,driverUid:uid,username:'prueba',displayName:previewAdmin?'Admin de prueba':'Chofer de prueba',nombre:previewAdmin?'Admin de prueba':'Chofer de prueba',role:previewAdmin?'admin':'driver',active:true,createdAtMs:now};
const seed={['usuarios/'+uid]:profile,['choferes/'+uid]:profile};
if(previewAdmin)for(const [id,nombre] of [['preview-driver','Javier de prueba'],['preview-marcelo','Marcelo de prueba'],['preview-nicolas','Nicolás de prueba']])for(const col of ['usuarios','choferes'])seed[col+'/'+id]={uid:id,nombre,displayName:nombre,role:'driver',active:true};
for(const [index,method,amount,detail] of [[1,'cash',136000,'Traslado Aeropuerto → Hotel'],[2,'digital',284000,'Viaje a Cataratas'],[3,'digital',92000,'Traslado de pasajeros']]) {
  seed['billing_records/demo-'+index]={driverUid:'preview-driver',uid:'preview-driver',method,paymentMethod:method,amount,service:detail,detail:method==='cash'?'Cobro en efectivo':'Cobro digital',type:method==='cash'?'billing':'payment',status:'completed',settlementRuleVersion:'net_wallets_cashbox_10_v1',createdAtMs:now-(4-index)*3600000};
}
// Illustrative local-only example requested for reviewing the settlement screen.
seed['deudas_choferes/demo-multa']={driverUid:'preview-driver',uid:'preview-driver',type:'admin_debt',amount:50000,remainingAmount:50000,status:'active',detail:'Multa',createdAtMs:now-3600000};
const statePath=path.resolve(ROOT,'..',previewAdmin?'preview-admin-state.json':'preview-state.json');
const saved=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):null;
const db=new MemoryStore(saved?.records||seed), uploads=new Map(saved?.uploadEntries||[]);
function match(data,c) {if(c.type==='or')return c.conditions.some(item=>match(data,item));if(c.type!=='where')return true;const value=data[c.field];return c.op==='=='?value===c.value:c.op==='>='?value>=c.value:c.op==='<='?value<=c.value:c.op==='>'?value>c.value:c.op==='<'?value<c.value:true;}
async function api(body) {
  const {action,target}=body;
  if(action==='get')return {data:db.data.get(target.path)||null};
  if(action==='list')return {rows:[...db.data].filter(([p,data])=>p.startsWith(target.path+'/')&&p.split('/').length===target.path.split('/').length+1&&(target.conditions||[]).every(c=>match(data,c))).map(([path,data])=>({path,data}))};
  if(action==='set'){db.data.set(target.path,body.options?.merge?{...db.data.get(target.path),...body.data}:body.data);return {};}
  if(action==='writes'){for(const row of body.writes){if(row.remove)db.data.delete(row.target.path);else db.data.set(row.target.path,row.options?.merge?{...db.data.get(row.target.path),...row.data}:row.data);}return {};}
  if(action==='upload'){uploads.set(body.path,body);return {};}
  if(action==='inspect')return {records:Object.fromEntries(db.data),uploads:[...uploads.keys()]};
  if(action==='reset'){db.data=new Map(Object.entries(structuredClone(seed)));uploads.clear();return {};}
  if(action==='call') {
    if(body.name==='adminMonthlyDocuments'&&previewAdmin)return require('../functions/admin-monthly-documents')({db,assertAdmin:async()=>uid}).adminMonthlyDocuments.run({data:body.input});
    if(body.name==='exploraRoute') {
      const {queryGoogleRoute}=require('../functions/google-route-service.js');
      return queryGoogleRoute(body.input,process.env.GOOGLE_MAPS_API_KEY);
    }
    if(body.name==='driverMonthlyReport') {
      const {loadMonthlyReport,monthlyPdf}=require('../functions/monthly-report.js');
      const report=await loadMonthlyReport(db,uid,body.input.month);
      report.invoices=[...db.data.values()].filter(row=>row.previewMonthlyInvoice&&row.driverUid===uid&&row.month===body.input.month);
      if(body.input.pdf){const bytes=await monthlyPdf(report);report.pdf={base64:bytes.toString('base64'),filename:`Explora-resumen-contadora-${report.month}.pdf`};}
      return report;
    }
    if(body.name==='attachDriverMonthlyInvoice') {
      if(!uploads.has(body.input.path))throw new Error('Primero cargá el PDF.');
      db.data.set('driver_monthly_invoices/'+body.input.path.split('/').at(-1),{previewMonthlyInvoice:true,driverUid:uid,month:body.input.month,url:'/__preview__/proof.svg',status:'uploaded'});return {ok:true};
    }
    if(body.name==='getPeriodQuote'||body.name==='confirmPeriodClosure') {
      const {periodQuote,confirmPeriodClosure}=require('../functions/period-closure.js');
      if(body.name==='getPeriodQuote')return periodQuote({db,uid});
      return confirmPeriodClosure({db,uid,input:body.input,proofMetadata:async proofPath=>{
        const file=uploads.get(proofPath);if(!file)throw new Error('No se cargó el comprobante.');return {...file,url:'/__preview__/proof.svg'};
      }});
    }
    if(/Arca|arca/.test(body.name)) return {enabled:false,available:false,invoices:[],status:'disabled',message:'Facturación externa desactivada en esta prueba local.'};
    if(body.name==='ensureTeamRealtimeBalances')return {ok:true};
    throw new Error('La integración '+body.name+' no se ejecuta en la vista local.');
  }
  throw new Error('Operación local desconocida.');
}
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
export const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; form-action 'self'; base-uri 'none'; frame-src 'none'");
  try {
    if(pathname==='/__preview__/maps-setup'){
      if(req.method==='POST'){
        if(req.headers.origin!==`http://${req.headers.host}`||!String(req.headers['content-type']).startsWith('application/json'))throw new Error('Origen no permitido.');
        if(process.env.GOOGLE_MAPS_API_KEY)throw new Error('Google Maps ya está configurado.');
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>256)throw new Error('Solicitud inválida.');}
        const {key}=JSON.parse(raw);if(typeof key!=='string'||!/^AIza[\w-]{35}$/.test(key))throw new Error('Clave inválida.');
        fs.writeFileSync(mapsSecretPath,`GOOGLE_MAPS_API_KEY=${key}\n`,{flag:'wx',mode:0o600});process.env.GOOGLE_MAPS_API_KEY=key;
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({configured:true}));return;
      }
      res.setHeader('Content-Type','text/html');
      res.end(process.env.GOOGLE_MAPS_API_KEY?'<p>Google Maps está configurado en el servidor local.</p>':`<!doctype html><html lang="es"><meta charset="utf-8"><title>Conectar Maps local</title><h1>Conectar Google Maps al servidor local</h1><form><label>Clave de Maps <input name="mapsKey" type="password" autocomplete="off" required></label><button>Guardar en servidor local</button></form><p role="status"></p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const input=document.querySelector('input');const r=await fetch('/__preview__/maps-setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:input.value})});input.value='';document.querySelector('[role=status]').textContent=r.ok?'Google Maps conectado al servidor local.':'No se pudo guardar la configuración.';};</script></html>`);return;
    }
    if(pathname==='/__preview__/api'&&req.method==='POST'){
      // Other websites cannot mutate a local preview through cross-origin forms.
      if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)throw new Error('Origen no permitido.');
      if(!String(req.headers['content-type']).startsWith('application/json'))throw new Error('JSON requerido.');
      let data='';for await(const chunk of req){data+=chunk;if(data.length>23000000)throw new Error('Archivo demasiado grande.');}
      const result=await api(JSON.parse(data));fs.writeFileSync(statePath,JSON.stringify({records:Object.fromEntries(db.data),uploadEntries:[...uploads]}));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
    }
    if(pathname==='/__preview__/proof.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250"><rect width="400" height="250" fill="#e8f2ff"/><text x="30" y="110" font-family="sans-serif" font-size="20">COMPROBANTE DE PRUEBA</text><text x="30" y="145" font-family="sans-serif">Sin valor · Solo vista local</text></svg>');return;}
    const file=pathname==='/'?'index.html':decodeURIComponent(pathname).slice(1);
    if(!HOSTING_FILES.includes(file)&&file!=='__preview__/firebase.js') {res.writeHead(404);res.end('No disponible');return;}
    let bytes=fs.readFileSync(path.join(ROOT,file==='__preview__/firebase.js'?'tools/preview/firebase.js':file));
    if(/\.(js|html)$/.test(file)) {
      let source=bytes.toString().replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[^"']+\.js/g,'/__preview__/firebase.js');
      if(previewAdmin&&file==='__preview__/firebase.js')source=source.replaceAll('preview-driver','preview-admin').replaceAll('Chofer de prueba','Admin de prueba');
      if(file==='index.html')source=source.replace(/<link[^>]+rel="preconnect"[^>]*>/g,'').replace('<body>','<body><div style="background:#183758;color:white;text-align:center;font:11px sans-serif;padding:5px" role="note">VISTA LOCAL · Datos de prueba · Sin conexión a producción</div>');
      bytes=source;
    }
    res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(bytes);
  } catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message,code:error.code||'preview-error'}));}
});
if(process.argv[1]===new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/,'').replace(/\//g,path.sep))server.listen(port,'127.0.0.1',()=>console.log(`Vista local segura: http://localhost:${port}\nUsuario: prueba · Clave: explora-prueba\nLos datos desaparecen al detener este servidor.`));
