const pad = value => String(value).padStart(2, '0');
const todayFormatter = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'});
const monthFormatter = new Intl.DateTimeFormat('es-AR',{month:'long',year:'numeric'});
const dayFormatter = new Intl.DateTimeFormat('es-AR',{weekday:'long',day:'numeric',month:'long'});
export function todayKey(now = new Date()) {
  const parts = todayFormatter.formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function validDay(value) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value || '')) return false;
  const [year,month,day] = value.split('-').map(Number);
  return new Date(year,month-1,day,12).getMonth() === month-1;
}
export function shiftMonth(month, offset) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Mes inválido');
  const [year,number] = month.split('-').map(Number);
  const date = new Date(year,number-1+offset,1,12);
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}`;
}
export function monthRange(month) { return {start:month+'-01', end:shiftMonth(month,1)+'-01'}; }
export function monthCells(month) {
  const [year,number] = month.split('-').map(Number);
  const leading = (new Date(year,number-1,1,12).getDay()+6)%7;
  const count = new Date(year,number,0,12).getDate();
  const length = Math.ceil((leading+count)/7)*7;
  return Array.from({length},(_,index) => index < leading || index >= leading+count ? null : `${month}-${pad(index-leading+1)}`);
}
export function monthLabel(month) {
  const [year,number] = month.split('-').map(Number);
  return monthFormatter.format(new Date(year,number-1,1,12));
}
export function dayLabel(day) {
  const [year,month,number] = day.split('-').map(Number);
  return dayFormatter.format(new Date(year,month-1,number,12));
}
export function normalizeTripDraft(input) {
  const serviceDate = String(input.serviceDate || '');
  const detail = String(input.detail || '').trim();
  const phone = String(input.phone || '').trim().replace(/[\s().-]+/g,'');
  if (!validDay(serviceDate)) throw new Error('Elegí un día válido en Mi calendario.');
  if (!detail || detail.length > 500) throw new Error('Escribí el detalle del viaje (hasta 500 caracteres).');
  if (phone && !/^\+?[0-9]{7,15}$/.test(phone)) throw new Error('Ingresá un teléfono válido o dejá el campo vacío.');
  return {serviceDate,detail,phone};
}
export function tripsForDay(rows, date, driverUid = null) {
  return activeTrips(rows).filter(row => row.serviceDate === date && (!driverUid || row.driverUid === driverUid))
    .sort((a,b) => String(a.driverName).localeCompare(String(b.driverName),'es') || String(a.id).localeCompare(String(b.id)));
}
export function activeTrips(rows) { return rows.filter(row => !row.deletedAt); }
export function canManageTrip(trip, user) { return Boolean(user?.uid && (user.isAdmin || trip.driverUid === user.uid)); }

// One listener per visible month, shared by both calendars. No background polling.
export function createMonthFeed({listen,onChange,maxCache=4}) {
  const active = new Map(), cache = new Map();
  const trim = () => {
    for (const key of cache.keys()) if (cache.size > maxCache && !active.has(key)) cache.delete(key);
  };
  function setMonths(months) {
    const wanted = new Set(months);
    for (const [key,entry] of active) if (!wanted.has(key)) { active.delete(key); entry.stop?.(); }
    for (const key of wanted) {
      if (active.has(key)) continue;
      const entry = {};
      active.set(key,entry);
      const previous = cache.get(key);
      cache.delete(key);
      cache.set(key,{rows:previous?.rows || [],loading:true,fromCache:true,error:''});
      entry.stop = listen(key, (rows,metadata={}) => {
        if (active.get(key) !== entry) return;
        cache.set(key,{rows,loading:false,fromCache:Boolean(metadata.fromCache),error:''});
        onChange();
      }, error => {
        if (active.get(key) !== entry) return;
        cache.set(key,{rows:[],loading:false,fromCache:false,error:error?.code === 'permission-denied' ? 'Tu cuenta no tiene acceso al calendario.' : 'No pudimos actualizar este mes.'});
        onChange();
      });
    }
    trim();
    onChange();
  }
  function stop() { for (const entry of active.values()) entry.stop?.(); active.clear(); trim(); }
  function clear() { stop(); cache.clear(); }
  function retry() { const months=[...active.keys()]; stop(); setMonths(months); }
  return {setMonths,stop,clear,retry,get:month => cache.get(month) || {rows:[],loading:true,fromCache:true,error:''}};
}
