import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {filterAdminRows} from '../admin-workspace.js';
import {buildAdminDigitalExpense} from '../admin-digital-expense.js';
import {MemoryStore} from '../tools/preview/memory-store.mjs';
const require=createRequire(import.meta.url),expensePolicy=require('../functions/expense-policy'),periodPolicy=require('../functions/period-policy');
const monthly=require('../functions/admin-monthly-documents');
const {calculateTeamRealtimeSettlementBalance}=require('../functions/telegram-billing-balance');
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
test('filtra todo el equipo por mes argentino, tipo y nombre sin perder acentos',()=>{
 const rows=[{driver:'Nicolás',detail:'Combustible',kind:'expense',time:Date.parse('2026-10-01T01:00:00Z')},{driver:'Javier',detail:'Viaje',kind:'cash',time:Date.parse('2026-09-20T10:00:00Z')}];
 assert.equal(filterAdminRows(rows,{month:'2026-09',type:'expense',search:'nicolas'}).length,1);
 assert.equal(filterAdminRows(rows,{month:'2026-10'}).length,0);
});
test('gasto digital usa la política vigente y no duplica el cargo 100% chofer',()=>{
 for(const [typeId,expected] of [['combustible',50000],['canon',100000],['cubiertas',0]]){
  const row=buildAdminDigitalExpense({driver:{id:'javier',name:'Javier'},actor:{uid:'david',name:'David'},amount:100000,detail:'Prueba',typeId,proofUrl:'https://example.test/proof.jpg',proofPath:'gastos/javier/op/proof.jpg',file:{name:'proof.jpg',type:'image/jpeg'},operation:{operationId:'op',createdAtMs:10000},fingerprint:'fp',businessId:'explora',dayKey:'2026-09-19'},expensePolicy,periodPolicy);
  assert.equal(row.billingImpactAmount,expected);
  assert.equal(row.driverUid,'javier');assert.equal(row.createdByUid,'david');assert.equal(row.expensePaymentMethod,'digital');
  assert.equal(calculateTeamRealtimeSettlementBalance({expenses:[row]}).balance,expected);
 }
 assert.throws(()=>buildAdminDigitalExpense({driver:{id:'javier'},actor:{uid:'admin'},amount:-1,typeId:'combustible'},expensePolicy,periodPolicy));
});
test('contadora usa 40% bruto por chofer, sin sumar pagos ni deudas a la facturación',()=>{
 const stamp=Date.parse('2026-09-20T12:00:00Z');
 const result=monthly.buildOverview({profiles:[{id:'javier',nombre:'Javier',active:true},{id:'marcelo',nombre:'Marcelo',active:true},{id:'admin',role:'admin'}],month:'2026-09',now:Date.parse('2026-10-02T12:00:00Z'),input:{cobros:[{id:'cash',driverUid:'javier',uid:'marcelo',amount:100000,type:'billing',method:'cash',status:'completed',createdAtMs:stamp},{id:'close',driverUid:'javier',amount:70000,type:'settlement_adjustment',createdAtMs:stamp}],deudas:[{id:'debt',driverUid:'javier',amount:80000,createdAtMs:stamp}]},invoices:[{driverUid:'javier',month:'2026-09',url:'https://example.test/factura.pdf'}]});
 assert.equal(result.length,2);assert.equal(result[0].totals.gross,100000);assert.equal(result[0].totals.participation,40000);assert.equal(result[0].invoices.length,1);assert.equal(result[1].totals.gross,0);
});
test('documentación administrativa rechaza a un chofer antes de consultar datos y valida el mes',async()=>{
 let reads=0;const blocked=monthly({db:{collection(){reads++;throw Error('read');}},assertAdmin:async()=>{throw Error('Solo administradores');}}).adminMonthlyDocuments;
 await assert.rejects(blocked.run({data:{month:'2026-09'}}),/Solo administradores/);assert.equal(reads,0);
 const allowed=monthly({db:new MemoryStore(),assertAdmin:async()=> 'admin'}).adminMonthlyDocuments;
 await assert.rejects(allowed.run({data:{month:'2099-01'}}),/mes válido/);
 const result=await allowed.run({data:{month:'2026-09'}});assert.deepEqual(result.rows,[]);
});
test('deuda grupal carga el importe completo a cada activo y un reintento conserva una única operación',async()=>{
 const start=source.indexOf('async function registerGroupDriverDebt('),end=source.indexOf('\n}',start)+2;
 const data=new Map();let uploads=0;
 const context={pendingGroupDebt:null,adminDrivers:[{id:'javier',active:true},{id:'marcelo',active:true},{id:'baja',active:false},{id:'admin',active:true,role:'admin'}],adminDriverIsAdministrator:d=>d.role==='admin',adminDriverIsActive:d=>d.active,adminDriverLabel:d=>d.id,window:{confirm:()=>true},money:String,crypto:{randomUUID:()=> 'group-id'},currentProfile:{displayName:'David'},Date,db:{},storage:{},ROOT_COLLECTIONS:{debts:'deudas_choferes'},BUSINESS_ID:'explora',localDayKey:()=> '2026-09-19',serverTimestamp:()=> 'now',ref:(_,path)=>({path}),uploadBytes:async()=>{uploads++;},getDownloadURL:async()=> 'https://example.test/proof.jpg',doc:(_,col,id)=>({path:col+'/'+id}),runTransaction:async(_,fn)=>fn({get:async ref=>({exists:()=>data.has(ref.path)}),set:(ref,row)=>data.set(ref.path,row)})};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const request={admin:{uid:'david'},amount:150000,detail:'Canon',file:{name:'proof.jpg',size:100,lastModified:1,type:'image/jpeg'}};
 await context.registerGroupDriverDebt(request);await context.registerGroupDriverDebt(request);
 assert.equal(data.size,3);assert.equal(data.get('deudas_choferes/group_group-id_javier').amount,150000);assert.equal(data.get('deudas_choferes/group_group-id_marcelo').amount,150000);assert.ok(![...data.keys()].some(k=>k.includes('baja')));
 assert.equal(data.get('admin_audit/group_debt_group-id').drivers.length,2);assert.ok(uploads>=1);
});
