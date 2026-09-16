"use strict";

function precedes(candidate, current) {
  const a=candidate.createdAt, b=current.createdAt;
  if (!a || !b) return false;
  return a.seconds < b.seconds || (a.seconds === b.seconds && (
    a.nanoseconds < b.nanoseconds || (a.nanoseconds === b.nanoseconds && candidate.id < current.id)
  ));
}

// Save the notification decision once: retries must not count trips added later.
function createCalendarNotifier({db,notify,notificationKey,compact}) {
  return async event => {
    const data=event.data?.data(), id=event.params?.docId || event.data?.id;
    if (!data || !id || data.version !== 'trip_calendar_v1') return {skipped:true};
    const planRef=db.collection('calendar_notification_plans').doc(id);
    const plan=await db.runTransaction(async transaction => {
      const source=await transaction.get(db.collection('trip_calendar').doc(id));
      if(!source.exists || source.data().deletedAt) return null;
      const existing=await transaction.get(planRef);
      if(existing.exists && existing.data().version === 2) return existing.data();
      const sameDay=await transaction.get(db.collection('trip_calendar').where('serviceDate','==',data.serviceDate));
      const previous=sameDay.docs.map(item=>({...item.data(),id:item.id}))
        .filter(item=>item.id!==id && !item.deletedAt && precedes(item,{...data,id}));
      const matchingTrips=[...previous,{...data,id}]
        .sort((a,b)=>precedes(a,b)?-1:precedes(b,a)?1:0)
        .map(item=>({driverName:item.driverName,serviceDate:item.serviceDate,detail:item.detail || ''}));
      const result={version:2,driverName:data.driverName,serviceDate:data.serviceDate,detail:data.detail || '',
        coincidences:previous.length,matchingTrips};
      transaction.set(planRef,result);
      return result;
    });
    if(!plan) return {skipped:true,reason:'deleted-trip'};
    const common={docId:id,notificationKey:notificationKey(data,id),sourceCollection:'trip_calendar',
      sourceDocumentId:id,data,eventId:event.id,requirePhoto:false};
    await notify({...common,kind:'calendar_trip',caption:compact.calendarSummary(plan)});
    const pages=plan.coincidences?compact.calendarCoincidenceMessages(plan):[];
    for(let index=0;index<pages.length;index++)await notify({...common,
      kind:index===0?'calendar_coincidence':`calendar_coincidence_${index+1}`,caption:pages[index]});
    return {notifications:1+pages.length};
  };
}
module.exports={createCalendarNotifier,precedes};
