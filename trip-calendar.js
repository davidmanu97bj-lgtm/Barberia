import {todayKey,shiftMonth,monthCells,monthLabel,dayLabel,normalizeTripDraft,tripsForDay,activeTrips,canManageTrip,createMonthFeed} from './calendar-core.js?v=20260913-calendario-detalles';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const calendarIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 10h18m-13 4h1m3 0h1m3 0h1M8 17h1m3 0h1"/></svg>';

export function mountTripCalendar({getUser,listenMonth,saveTrip,setTripDeleted}) {
  const modal = document.getElementById('tripCalendarModal');
  const root = document.getElementById('app');
  const state = {open:false,uid:null,opener:null,saving:false,composing:false,day:{},month:{},session:0,action:null,busyTrip:null};
  const panel = (key,title) => `<section class="trip-calendar-panel" data-calendar="${key}" aria-label="${title}">
    <div class="trip-calendar-panel-heading"><h3>${title}</h3><span data-calendar-count></span></div>
    <div class="trip-month-nav"><button type="button" data-month-step="-1" aria-label="Mes anterior en ${title}">‹</button><h4 data-month-label></h4><button type="button" data-month-step="1" aria-label="Mes siguiente en ${title}">›</button></div>
    <div class="trip-weekdays" aria-hidden="true">${['L','M','M','J','V','S','D'].map(day=>'<span>'+day+'</span>').join('')}</div>
    <div class="trip-month-grid" data-calendar-grid aria-label="Días del mes"></div>
    <div class="trip-month-status" data-month-status role="status"></div>
    ${key==='mine' ? `<form id="calendarTripForm" class="trip-booking-form hidden" novalidate>
      <h4>Agendar un viaje</h4><p id="calendarBookingDate"></p>
      <label for="calendarTripDetail">Detalle del viaje</label><textarea id="calendarTripDetail" maxlength="500" rows="3" placeholder="Ej. Traslado al aeropuerto" required></textarea>
      <label for="calendarTripPhone">WhatsApp o teléfono <span class="trip-optional">(opcional)</span></label><input id="calendarTripPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="30" placeholder="Ej. +54 9…">
      <div id="calendarBookingStatus" class="trip-booking-status" role="status" aria-live="polite"></div>
      <div class="trip-booking-actions"><button type="button" data-booking-cancel>Cancelar</button><button id="calendarSaveTrip" type="submit">Aceptar y agendar</button></div>
    </form>` : ''}
    <div class="trip-day-agenda"><h4 data-selected-day></h4><div data-trip-action class="trip-action-notice" role="status" aria-live="polite"></div><div data-day-trips></div>${key==='mine'?'<button type="button" class="trip-add-for-day" data-booking-start>+ Agendar para este día</button>':''}</div>
  </section>`;
  modal.innerHTML = `<div class="trip-calendar-screen">
    <header class="trip-calendar-header"><div><span class="trip-calendar-emblem">${calendarIcon}</span><h2 id="tripCalendarTitle">Calendario</h2></div><button type="button" class="trip-calendar-close" aria-label="Cerrar calendario">×</button></header>
    <div class="trip-calendar-question" id="calendarBookingQuestion"><div><strong>¿Querés agendar un viaje?</strong><p>Elegí el día y agregá el detalle del viaje.</p></div><div><button type="button" data-booking-start>Agendar un viaje</button><button type="button" data-booking-browse>Ver calendarios</button></div></div>
    <div id="calendarSaveNotice" class="trip-save-notice" role="status" aria-live="polite"></div>
    ${panel('mine','Mi calendario')}${panel('all','Todos')}
  </div>`;
  const $ = id => modal.querySelector('#'+id);
  const feed = createMonthFeed({listen:listenMonth,onChange:render});
  function user() { return getUser(); }
  function synchronize() { feed.setMonths([state.month.mine,state.month.all]); }
  function bookingMode(value) {
    state.composing = value;
    $('calendarTripForm').classList.toggle('hidden',!value);
    $('calendarBookingQuestion').classList.add('hidden');
    $('calendarBookingStatus').textContent='';
    render();
    if(value) modal.querySelector('[data-calendar="mine"]').scrollIntoView({block:'start',behavior:'smooth'});
  }
  function render() {
    if(!state.open) return;
    const today=todayKey();
    for(const key of ['mine','all']) {
      const box = modal.querySelector(`[data-calendar="${key}"]`), month=state.month[key];
      const snapshot = feed.get(month), mine = key === 'mine';
      const rows = activeTrips(snapshot.rows).filter(row => !mine || row.driverUid===state.uid);
      const byDay=new Map();
      for(const row of rows) { const list=byDay.get(row.serviceDate)||[]; list.push(row); byDay.set(row.serviceDate,list); }
      box.querySelector('[data-month-label]').textContent=monthLabel(month);
      box.querySelector('[data-calendar-count]').textContent=`${rows.length} ${rows.length===1?'viaje':'viajes'}`;
      box.querySelector('[data-month-step="-1"]').disabled=state.saving || month==='2000-01';
      box.querySelector('[data-month-step="1"]').disabled=state.saving || month==='2099-12';
      const focused=box.contains(document.activeElement)?document.activeElement.dataset.date:null;
      box.querySelector('[data-calendar-grid]').innerHTML=monthCells(month).map(date=>{
        if(!date) return '<span class="trip-day-blank" aria-hidden="true"></span>';
        const trips=byDay.get(date)||[];
        const label=`${dayLabel(date)} · ${trips.length} ${trips.length===1?'viaje':'viajes'}`;
        return `<button type="button" class="trip-day${date===today?' today':''}${trips.length?' has-trips':''}" data-date="${date}" aria-label="${escape(label)}" ${date===today?'aria-current="date"':''} aria-pressed="${date===state.day[key]}" ${state.saving?'disabled':''}>
          <span class="trip-day-number">${Number(date.slice(-2))}</span>${date===today?'<span class="trip-today-label">Hoy</span>':''}${trips.length ? `<span class="trip-day-count">${trips.length} ${trips.length===1?'viaje':'viajes'}</span>`:''}</button>`;
      }).join('');
      if(focused) box.querySelector(`[data-date="${focused}"]`)?.focus({preventScroll:true});
      const status=box.querySelector('[data-month-status]');
      status.textContent=snapshot.error || (snapshot.loading?'Cargando este mes…':snapshot.fromCache?'Sincronizando…':'En tiempo real');
      status.classList.toggle('error',Boolean(snapshot.error));
      if(snapshot.error) { const retry=document.createElement('button'); retry.type='button'; retry.textContent='Reintentar'; retry.addEventListener('click',()=>feed.retry()); status.append(' ',retry); }
      box.querySelector('[data-selected-day]').textContent=dayLabel(state.day[key]);
      const notice=box.querySelector('[data-trip-action]'), action=state.action;
      const showAction=action?.view===key && action.trip.serviceDate===state.day[key];
      notice.classList.toggle('error',Boolean(showAction && action.error));
      notice.innerHTML=showAction ? `<span>${escape(action.message)}</span>${action.undo?`<button type="button" data-trip-restore="${escape(action.trip.id)}" ${state.saving?'disabled':''}>Deshacer</button>`:''}` : '';
      const trips=tripsForDay(rows,state.day[key]);
      box.querySelector('[data-day-trips]').innerHTML=trips.length ? trips.map(trip=>{
        const phone=String(trip.phone||'');
        const safePhone=/^\+?[0-9]{7,15}$/.test(phone);
        return `<article class="trip-agenda-item"><div class="trip-agenda-heading"><span>${mine?'Tu viaje':escape(trip.driverName)}</span>${trip.pending?'<small>Guardando…</small>':''}</div><p>${escape(trip.detail)}</p>${safePhone ? `<div class="trip-contact"><a href="tel:${phone}">${escape(phone)}</a>${phone.startsWith('+')?`<a class="trip-whatsapp" href="https://wa.me/${phone.slice(1)}" target="_blank" rel="noopener noreferrer">WhatsApp ↗</a>`:''}</div>`:''}${canManageTrip(trip,user())?`<button type="button" class="trip-delete" data-trip-delete="${escape(trip.id)}" aria-label="Eliminar viaje: ${escape(trip.detail)}" ${state.saving||trip.pending?'disabled':''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>${state.busyTrip===trip.id?'Eliminando…':'Eliminar viaje'}</button>`:''}</article>`;
      }).join('') : `<p class="trip-day-empty">${snapshot.loading?'Cargando viajes…':snapshot.error?'Los viajes no están disponibles.':'No hay viajes agendados para este día.'}</p>`;
    }
    $('calendarBookingDate').textContent=dayLabel(state.day.mine)+' · Seleccioná otro día en el calendario si lo necesitás.';
    modal.querySelector('[data-calendar="mine"] [data-booking-start]').classList.toggle('hidden',state.composing);
  }
  function open(opener) {
    const current=user();if(!current)return;
    if(state.uid!==current.uid) feed.clear();
    state.uid=current.uid;state.open=true;state.session++;state.opener=opener;state.composing=false;state.action=null;state.busyTrip=null;setSaving(false);
    const today=todayKey();state.month={mine:today.slice(0,7),all:today.slice(0,7)};state.day={mine:today,all:today};
    $('calendarTripForm').reset();$('calendarTripForm').classList.add('hidden');$('calendarBookingQuestion').classList.remove('hidden');$('calendarSaveNotice').textContent='';
    modal.classList.remove('hidden');root.inert=true;modal.scrollTop=0;synchronize();modal.querySelector('[data-booking-start]').focus({preventScroll:true});
  }
  function close(force=false) {
    if(state.saving&&!force)return;
    state.open=false;state.session++;feed.stop();modal.classList.add('hidden');root.inert=false;
    if(!force)state.opener?.focus({preventScroll:true});
  }
  function setSaving(value) {
    state.saving=value;modal.querySelector('.trip-calendar-close').disabled=value;
    for(const control of $('calendarTripForm').querySelectorAll('input,textarea,button'))control.disabled=value;
    $('calendarSaveTrip').textContent=value?'Agendando…':'Aceptar y agendar';
  }
  function reset() { close(true);feed.clear();state.uid=null;setSaving(false);$('calendarTripForm').reset(); }
  async function changeTripDeletion(trip, view, deleted) {
    if(state.saving || !canManageTrip(trip,user()))return;
    const session=state.session;
    state.busyTrip=deleted?trip.id:null;setSaving(true);render();
    try {
      const changed=await setTripDeleted(trip.id,deleted);
      if(session!==state.session)return;
      state.action={trip,view,undo:deleted&&changed,error:false,message:deleted?'Viaje eliminado de ambos calendarios.':'Viaje recuperado en ambos calendarios.'};
    } catch(error) {
      if(session!==state.session)return;
      state.action={trip,view,undo:!deleted,error:true,message:error?.code==='permission-denied'?'No tenés permiso para modificar este viaje.':'No pudimos actualizar el viaje. Reintentá.'};
    } finally {
      if(session===state.session){state.busyTrip=null;setSaving(false);render();}
    }
  }
  modal.addEventListener('click',event=>{
    if(state.saving)return;
    const button=event.target.closest('button');if(!button)return;
    if(button.matches('.trip-calendar-close')) { close();return; }
    if(button.hasAttribute('data-booking-start')) { bookingMode(true);return; }
    if(button.hasAttribute('data-booking-browse')||button.hasAttribute('data-booking-cancel')) { bookingMode(false);return; }
    const box=button.closest('[data-calendar]');if(!box)return;
    const key=box.dataset.calendar;
    if(button.dataset.tripDelete) {
      const trip=feed.get(state.month[key]).rows.find(row=>row.id===button.dataset.tripDelete);
      if(trip)void changeTripDeletion(trip,key,true);
    } else if(button.dataset.tripRestore && state.action?.trip.id===button.dataset.tripRestore) {
      void changeTripDeletion(state.action.trip,key,false);
    } else if(button.hasAttribute('data-month-step')) {
      const month=shiftMonth(state.month[key],Number(button.dataset.monthStep));
      if(month<'2000-01'||month>'2099-12')return;
      state.month[key]=month;state.day[key]=month===todayKey().slice(0,7)?todayKey():month+'-01';synchronize();
    } else if(button.dataset.date) { state.day[key]=button.dataset.date;render(); }
  });
  $('calendarTripForm').addEventListener('submit',async event=>{
    event.preventDefault();if(state.saving)return;
    let draft;
    try { draft=normalizeTripDraft({serviceDate:state.day.mine,detail:$('calendarTripDetail').value,phone:$('calendarTripPhone').value}); }
    catch(error) { $('calendarBookingStatus').textContent=error.message;return; }
    const session=state.session;
    setSaving(true);$('calendarBookingStatus').textContent='';render();
    try {
      await saveTrip(draft);
      if(session!==state.session)return;
      $('calendarTripForm').reset();
      state.month.all=draft.serviceDate.slice(0,7);state.day.all=draft.serviceDate;
      bookingMode(false);synchronize();$('calendarSaveNotice').textContent='Viaje agendado. Ya aparece en Mi calendario y en Todos.';
    } catch(error) {
      if(session===state.session)$('calendarBookingStatus').textContent=error?.code==='permission-denied'?'No tenés permiso para agendar este viaje.':'No pudimos confirmar el viaje. Volvé a aceptar para reintentar sin duplicarlo.';
    } finally {
      if(session===state.session) {
        setSaving(false);render();
      }
    }
  });
  modal.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close();}
    if(event.key==='Tab'){
      const controls=[...modal.querySelectorAll('button,input,textarea,a')].filter(el=>!el.disabled&&el.getClientRects().length);
      if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1)?.focus();}
      else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0]?.focus();}
    }
  });
  return {open,close,reset};
}
