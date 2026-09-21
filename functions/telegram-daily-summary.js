'use strict';
const zone='America/Argentina/Buenos_Aires';
const safe=v=>String(v||'').replace(/[\r\n\t]+/g,' ').trim().slice(0,100);
function previousDay(scheduledAt) {
  const current=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(scheduledAt));
  const start=Date.parse(current+'T00:00:00-03:00')-86400000;
  return {day:new Date(start-10800000).toISOString().slice(0,10),start,end:start+86400000};
}
function messagesForDay(drivers,records,day) {
  const aliases=new Map(),totals=new Map();
  for(const d of drivers){totals.set(d.id,{name:safe(d.name)||'Chofer',cents:0,count:0});for(const id of d.aliases)if(id)aliases.set(id,d.id);}
  const seen=new Set();
  for(const r of records){
    if(seen.has(r.id))continue;seen.add(r.id);
    if(!['billing','payment'].includes(r.type)||!['completed','paid','approved'].includes(r.status)||r.deleted||r.isDeleted||r.eliminado||r.isSimulation||r.simulated||r.internalSettlementAdjustment||r.internalManagement||r.excludeFromBillingGross)continue;
    const ms=r.createdAt?.toMillis?.()||Number(r.createdAtMs)||Date.parse(r.createdAt);
    if(!(ms>=day.start&&ms<day.end))continue;
    const owner=r.driverUid||r.choferUid||r.uid||r.ownerUid||r.driverId||r.choferId||r.userUid||r.operatorUid;
    const total=totals.get(aliases.get(owner));
    const value=Number(r.amount??r.monto);
    if(total&&Number.isFinite(value)&&value>0){total.cents+=Math.round(value*100);total.count++;}
  }
  const money=v=>new Intl.NumberFormat('es-AR',{maximumFractionDigits:2}).format(v);
  const header=`RESUMEN DEL DÍA · ${day.day.split('-').reverse().join('/')}\n`;
  const lines=[...totals.values()].sort((a,b)=>a.name.localeCompare(b.name,'es')).map(t=>t.count?`${t.name} hizo: $ ${money(t.cents/100)}`:`${t.name}: No trabajó`);
  if(!lines.length)lines.push('Sin choferes activos.');
  const pages=[];let page=header;
  for(const line of lines){if(page.length+line.length+1>3900){pages.push(page);page=header;}page+='\n'+line;}
  pages.push(page);return pages;
}
module.exports={previousDay,messagesForDay};
