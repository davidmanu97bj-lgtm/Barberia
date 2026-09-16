import test from 'node:test';
import assert from 'node:assert/strict';
import {todayKey,validDay,shiftMonth,monthRange,monthCells,normalizeTripDraft,tripsForDay,activeTrips,canManageTrip,createMonthFeed} from '../calendar-core.js';

test('calendar dates use Argentina, leap years and cross-year navigation',()=>{
  assert.equal(todayKey(new Date('2026-09-14T01:00:00Z')),'2026-09-13');
  assert.equal(todayKey(new Date('2026-09-14T03:00:00Z')),'2026-09-14');
  assert.equal(validDay('2028-02-29'),true);
  for(const day of ['2026-02-29','2026-04-31','2026-13-01','2026-00-10','2026-09-00','1999-12-31'])assert.equal(validDay(day),false,day);
  assert.equal(shiftMonth('2026-12',1),'2027-01');
  assert.equal(shiftMonth('2026-01',-1),'2025-12');
  assert.deepEqual(monthRange('2026-12'),{start:'2026-12-01',end:'2027-01-01'});
  assert.equal(monthCells('2026-09')[0],null);
  assert.equal(monthCells('2026-09')[1],'2026-09-01');
  assert.equal(monthCells('2026-09').filter(Boolean).length,30);
  assert.equal(monthCells('2026-02').length,35);
  assert.equal(monthCells('2028-02').filter(Boolean).length,29);
});
test('trip date/detail are required and the optional phone is validated only when provided',()=>{
  assert.deepEqual(normalizeTripDraft({serviceDate:'2026-09-14',detail:'  Aeropuerto  ',phone:'+54 (9) 3757-123456'}),{
    serviceDate:'2026-09-14',detail:'Aeropuerto',phone:'+5493757123456'});
  const base={serviceDate:'2026-09-14',detail:'Traslado',phone:'3757123456'};
  assert.equal(normalizeTripDraft({...base,phone:''}).phone,'');
  assert.equal(normalizeTripDraft({...base,phone:undefined}).phone,'');
  for(const patch of [{serviceDate:'2026-02-30'},{detail:' '},{detail:'x'.repeat(501)},{phone:'123'},{phone:'javascript:alert(1)'},{phone:'9'.repeat(16)}])
    assert.throws(()=>normalizeTripDraft({...base,...patch}));
});
test('deleted trips disappear from personal and team lists and only owner/admin can manage them',()=>{
  const own={id:'one',driverUid:'a',driverName:'Ana',serviceDate:'2026-09-14'},deleted={...own,id:'two',deletedAt:{seconds:1}};
  assert.deepEqual(activeTrips([own,deleted]),[own]);
  assert.equal(tripsForDay([own,deleted],'2026-09-14','a').length,1);
  assert.equal(tripsForDay([own,deleted],'2026-09-14').length,1);
  assert.equal(canManageTrip(own,{uid:'a'}),true);
  assert.equal(canManageTrip(own,{uid:'b'}),false);
  assert.equal(canManageTrip(own,{uid:'b',isAdmin:true}),true);
  assert.equal(canManageTrip(own,null),false);
});
test('two trips on one day stay separate and personal filtering excludes other drivers',()=>{
  const rows=[{id:'1',driverUid:'a',serviceDate:'2026-09-14',driverName:'Ana'},
    {id:'2',driverUid:'a',serviceDate:'2026-09-14',driverName:'Ana'},
    {id:'3',driverUid:'b',serviceDate:'2026-09-14',driverName:'Bruno'},
    {id:'4',driverUid:'b',serviceDate:'2026-10-14',driverName:'Bruno'}];
  assert.equal(tripsForDay(rows,'2026-09-14','a').length,2);
  assert.equal(tripsForDay(rows,'2026-09-14').length,3);
  assert.equal(rows.length,4);
});
function fixture(maxCache=4){
  const calls=[];let renders=0;
  const feed=createMonthFeed({maxCache,onChange:()=>renders++,listen:(month,next,error)=>{
    const item={month,next,error,stopped:false};calls.push(item);return()=>item.stopped=true;
  }});
  return {feed,calls,renders:()=>renders};
}
test('month views share one subscription; independent navigation never keeps more than two',()=>{
  const {feed,calls}=fixture();
  feed.setMonths(['2026-09','2026-09']);assert.equal(calls.length,1);
  calls[0].next([{id:'a'}]);assert.equal(feed.get('2026-09').rows.length,1);
  feed.setMonths(['2026-09','2026-10']);assert.equal(calls.length,2);
  feed.setMonths(['2026-11','2026-10']);assert.equal(calls[0].stopped,true);assert.equal(calls[1].stopped,false);
  assert.equal(calls.filter(call=>!call.stopped).length,2);
  feed.stop();assert.equal(calls.every(call=>call.stopped),true);
});
test('stale callbacks after closing or changing user cannot repopulate the calendar',()=>{
  const {feed,calls,renders}=fixture();feed.setMonths(['2026-09']);feed.clear();
  const count=renders();calls[0].next([{id:'private'}]);calls[0].error({code:'permission-denied'});
  assert.equal(renders(),count);assert.deepEqual(feed.get('2026-09').rows,[]);
  feed.setMonths(['2026-09']);calls[0].next([{id:'stale'}]);assert.deepEqual(feed.get('2026-09').rows,[]);
  calls[1].next([{id:'new'}]);assert.equal(feed.get('2026-09').rows[0].id,'new');
});
test('cached months open immediately, errors clear inaccessible rows, and retry replaces listeners',()=>{
  const {feed,calls}=fixture(2);feed.setMonths(['2026-09']);calls[0].next([{id:'a'}]);feed.stop();
  feed.setMonths(['2026-09']);assert.equal(feed.get('2026-09').rows[0].id,'a');
  calls[1].error({code:'permission-denied'});assert.deepEqual(feed.get('2026-09').rows,[]);
  assert.match(feed.get('2026-09').error,/acceso/);feed.retry();assert.equal(calls[1].stopped,true);
  calls[2].next([{id:'b'}]);assert.equal(feed.get('2026-09').error,'');
  for(const month of ['2026-10','2026-11','2026-12'])feed.setMonths([month]);
  assert.deepEqual(feed.get('2026-09').rows,[]);
});
