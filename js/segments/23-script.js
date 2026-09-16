(function(){
  "use strict";
  const $ = id => document.getElementById(id);
  let latest = null;
  let busy = false;
  let adminBusy = false;
  let adminCacheAt = 0;
  const ADMIN_REFRESH_MS = 25000;
  const money = value => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Number(value) || 0);
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
  const isAdmin = () => document.body.classList.contains("explora-admin-authenticated") || window.ExploraSession?.role === "admin" || window.ExploraAccessState?.isAdmin === true;
  const role = () => isAdmin() ? "admin" : "driver";
  const requirementMeta = {
    validBilling8Weeks:{ name:"FACTURACIÓN VÁLIDA 8 SEMANAS", icon:"💰" },
    rhythmReal:{ name:"RITMO REAL", icon:"📆" },
    closureUpToDate:{ name:"CIERRES AL DÍA", icon:"✅" },
    collaborationOk:{ name:"COLABORACIÓN EXPLORA", icon:"🤝" },
    noActiveLoan:{ name:"SIN PRÉSTAMO ACTIVO", icon:"🔓" },
    davidApproval:{ name:"APROBACIÓN DE DAVID", icon:"✍️" }
  };

  function card(snapshot, item){
    const unlocked = !!item.unlocked;
    const icon = unlocked ? "✅" : (item.icon || requirementMeta[item.id]?.icon || "🔒");
    const id = escapeHtml(item.id || "");
    return `<article class="explore-loan-requirement ${unlocked ? "is-unlocked" : "is-locked"}" data-requirement-key="${id}"><span class="explore-loan-requirement-icon">${escapeHtml(icon)}</span><strong>${escapeHtml(item.name || requirementMeta[item.id]?.name || item.id)}</strong><small>${escapeHtml(item.statusText || "PENDIENTE")}</small><em>${unlocked ? "CUMPLIDO" : "PENDIENTE"}</em></article>`;
  }

  function setMessage(text, ok = false){
    const message = $("exploreLoanRequestMessage");
    if (!message) return;
    message.textContent = text || "";
    message.className = "explore-loan-request-message" + (ok ? " is-ok" : "");
  }

  function updateAmountInput(max){
    const amountInput = $("exploreLoanAmountInput");
    if (!amountInput) return;
    const safeMax = Math.max(0, Number(max) || 0);
    amountInput.max = String(safeMax);
    amountInput.disabled = safeMax <= 0;
    if (safeMax <= 0) {
      amountInput.value = "";
      amountInput.placeholder = "Sin monto disponible";
      return;
    }
    amountInput.placeholder = `Máximo ${money(safeMax)}`;
    const current = Number(amountInput.value || 0);
    if (!(current > 0) || current > safeMax) amountInput.value = String(safeMax);
  }

  function render(snapshot = {}){
    latest = snapshot;
    const activeLoan = snapshot.activeLoan || {};
    const active = !!activeLoan.active;
    const pending = !!activeLoan.pendingApproval;
    const max = Number(snapshot.availableBenefit || snapshot.benefitAvailable || 0);
    const status = $("exploreLoanStatusCard");
    if (status) status.dataset.state = active ? "active" : pending ? "pending" : snapshot.eligibility?.eligible ? "available" : "locked";
    if ($("exploreLoanStatusKicker")) $("exploreLoanStatusKicker").textContent = active ? "PRÉSTAMO ACTIVO" : pending ? "PENDIENTE DE DAVID" : "SIN INTERÉS";
    if ($("exploreLoanStatusTitle")) $("exploreLoanStatusTitle").textContent = active ? "PRÉSTAMO EXPLORA EN CURSO" : pending ? "SOLICITUD ENVIADA A DAVID" : snapshot.eligibility?.eligible ? "MONTO DISPONIBLE" : "TODAVÍA NO DISPONIBLE";
    if ($("exploreLoanAvailableAmount")) $("exploreLoanAvailableAmount").textContent = money(max);
    if ($("exploreLoanStatusMessage")) $("exploreLoanStatusMessage").textContent = active ? "Se descuenta automáticamente en el cierre semanal." : pending ? "David debe aprobar o rechazar la solicitud desde administración." : snapshot.eligibility?.eligible ? "Podés pedir un monto menor o igual al máximo y elegir hasta 8 cuotas." : "Disponible según constancia, cierres al día, colaboración y aprobación de David.";

    const activeCard = $("exploreLoanActiveCard");
    if (activeCard) activeCard.hidden = !(active || pending);
    if ($("exploreLoanActiveCardLabel")) $("exploreLoanActiveCardLabel").textContent = pending ? "SOLICITUD PENDIENTE" : "PRÉSTAMO ACTIVO";
    if ($("exploreLoanActiveCardTitle")) $("exploreLoanActiveCardTitle").textContent = pending ? "Tu solicitud está pendiente de aprobación." : "Ya tenés un préstamo Explora en curso.";
    if ($("exploreLoanOriginalAmount")) $("exploreLoanOriginalAmount").textContent = money(activeLoan.originalAmount || 0);
    if ($("exploreLoanBalance")) $("exploreLoanBalance").textContent = money(activeLoan.balance || 0);
    if ($("exploreLoanWeeklyDiscount")) $("exploreLoanWeeklyDiscount").textContent = money(activeLoan.weeklyDiscount || 0);
    if ($("exploreLoanActiveState")) $("exploreLoanActiveState").textContent = pending ? "PENDIENTE" : "ACTIVO";

    const list = snapshot.requirementList?.length ? snapshot.requirementList : Object.keys(requirementMeta).map(id => ({ id, name:requirementMeta[id].name, icon:requirementMeta[id].icon, unlocked:false, statusText:"PENDIENTE" }));
    if ($("exploreLoanRequirementGrid")) $("exploreLoanRequirementGrid").innerHTML = list.map(item => card(snapshot, item)).join("");
    const nonDavid = list.filter(item => item.id !== "davidApproval");
    const met = nonDavid.filter(item => item.unlocked).length;
    const david = list.find(item => item.id === "davidApproval")?.unlocked;
    if ($("exploreLoanRequirementCount")) $("exploreLoanRequirementCount").textContent = `${met} de ${nonDavid.length} + David ${david ? "✓" : ""}`;

    updateAmountInput(max);
    const installmentsInput = $("exploreLoanInstallmentsInput");
    if (installmentsInput && !installmentsInput.value) installmentsInput.value = "8";
    const btn = $("exploreLoanRequestBtn");
    if (btn) {
      btn.disabled = busy || !snapshot.eligibility?.eligible || active || pending;
      btn.textContent = pending ? "SOLICITUD PENDIENTE" : active ? "PRÉSTAMO ACTIVO" : "SOLICITAR APROBACIÓN";
    }
    renderAdminPanel({ force:false }).catch(() => {});
  }

  async function refresh(force = false){
    try {
      const uid = window.ExploraFirebase?.auth?.currentUser?.uid || window.ExploraSession?.authUser?.uid;
      if (!uid) return;
      const snapshot = await window.getExploreLoanSnapshot?.(uid, { force });
      if (snapshot) render(snapshot);
    } catch (error) {
      showDiagnostic({ module:"EXPLORE_LOAN_REQUIREMENTS", stage:"LOAN_RENDER", code:"LOAN_RENDER_FAILED", javascriptMessage:error?.message || String(error), stack:error?.stack || "—", functionName:"refresh", uid:window.ExploraFirebase?.auth?.currentUser?.uid || "—", role:role(), weeklyPeriodId:window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.().id || "—", exploraLoanLookbackId:latest?.exploraLoanLookbackId || "—", activeLoan:Boolean(latest?.activeLoan?.active), activeWeeks:Number(latest?.activeWeeks || 0), requirementsMet:Number(latest?.requirementsMet || 0), calculatedAmount:Number(latest?.availableBenefit || 0), firestorePath:"acumulados_semanales", operation:"render loan screen", timestamp:new Date().toISOString() });
    }
  }

  function open(){
    const screen = $("exploreLoanScreen");
    if (screen) { screen.hidden = false; screen.classList.add("is-open"); }
    refresh(true);
  }
  function close(){
    const screen = $("exploreLoanScreen");
    if (screen) { screen.classList.remove("is-open"); screen.hidden = true; }
  }

  async function request(){
    if (busy || !latest?.eligibility?.eligible) return;
    const max = Math.round(Number(latest.availableBenefit || 0));
    const requested = Math.round(Number($("exploreLoanAmountInput")?.value || 0));
    const installments = Math.min(8, Math.max(1, Math.round(Number($("exploreLoanInstallmentsInput")?.value || 8))));
    if (!(requested > 0)) return setMessage("Ingresá un monto válido para solicitar.");
    if (requested > max) return setMessage(`El monto supera tu máximo disponible: ${money(max)}.`);
    busy = true;
    const button = $("exploreLoanRequestBtn");
    if (button) { button.disabled = true; button.textContent = "SOLICITANDO…"; }
    setMessage("");
    try {
      const result = await window.ExploraRequestLoan?.(latest.driverUid, { amount:requested, installments });
      setMessage(`Solicitud enviada a David por ${money(result.amount)} en ${installments} cuotas. Sin interés.`, true);
      await refresh(true);
    } catch(error) {
      setMessage(error?.message || "No se pudo solicitar el préstamo.");
      showDiagnostic({ module:"EXPLORE_LOAN_REQUIREMENTS", stage:"LOAN_REQUEST", code:error?.code || "LOAN_ENGINE_FAILED", javascriptMessage:error?.message || String(error), stack:error?.stack || "—", functionName:"request", uid:latest?.driverUid || "—", role:role(), weeklyPeriodId:latest?.weeklyPeriodId || "—", exploraLoanLookbackId:latest?.exploraLoanLookbackId || "—", activeLoan:Boolean(latest?.activeLoan?.active), activeWeeks:Number(latest?.activeWeeks || 0), requirementsMet:Number(latest?.requirementsMet || 0), calculatedAmount:Number(latest?.availableBenefit || 0), firestorePath:`prestamos_explora/${latest?.driverUid || "—"}`, operation:"request loan", timestamp:new Date().toISOString() });
    } finally {
      busy = false;
      if (latest) render(latest);
    }
  }

  function openRejectReasonModal(driverUid = "", driverName = "Chofer") {
    const modal = $("exploreLoanRejectModal");
    const textarea = $("exploreLoanRejectReason");
    const title = $("exploreLoanRejectTitle");
    const driver = $("exploreLoanRejectDriver");
    if (!modal || !textarea) {
      return Promise.resolve("No cumple requisitos actuales");
    }
    if (title) title.textContent = "Rechazar solicitud";
    if (driver) driver.textContent = `Chofer: ${driverName || driverUid || "Chofer"}`;
    textarea.value = "";
    modal.dataset.driverUid = driverUid;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    textarea.focus?.();
    return new Promise(resolve => {
      const cleanup = () => {
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
        confirm?.removeEventListener("click", onConfirm);
        cancel?.removeEventListener("click", onCancel);
        close?.removeEventListener("click", onCancel);
        modal.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKeydown);
      };
      const onConfirm = () => {
        const reason = textarea.value.trim();
        if (!reason) {
          setMessage("Ingresá un motivo para rechazar la solicitud.");
          textarea.focus?.();
          return;
        }
        cleanup();
        resolve(reason);
      };
      const onCancel = () => { cleanup(); resolve(null); };
      const onBackdrop = event => { if (event.target === modal) onCancel(); };
      const onKeydown = event => { if (event.key === "Escape") onCancel(); };
      const confirm = $("exploreLoanRejectConfirm");
      const cancel = $("exploreLoanRejectCancel");
      const close = $("exploreLoanRejectClose");
      confirm?.addEventListener("click", onConfirm);
      cancel?.addEventListener("click", onCancel);
      close?.addEventListener("click", onCancel);
      modal.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKeydown);
    });
  }

  async function renderAdminPanel({ force = false } = {}){
    const panel = $("exploreLoanAdminPanel");
    if (!panel) return;
    panel.hidden = !isAdmin();
    if (panel.hidden || adminBusy) return;
    const list = $("exploreLoanAdminList");
    if (!list) return;
    if (!force && Date.now() - adminCacheAt < ADMIN_REFRESH_MS && list.dataset.loaded === "true") return;
    adminBusy = true;
    try {
      const rows = await window.ExploraListPendingLoans?.({ force }) || [];
      adminCacheAt = Date.now();
      list.dataset.loaded = "true";
      const warnings = Array.isArray(rows.partialWarnings) && rows.partialWarnings.length ? `<p class="explore-loan-admin-empty is-warning">Se cargaron solicitudes, pero una consulta secundaria falló: ${escapeHtml(rows.partialWarnings.join(" · "))}</p>` : "";
      list.innerHTML = warnings + (rows.length ? rows.map(row => {
        const rawUid = String(row.driverUid || "");
        const uid = escapeHtml(rawUid);
        const amount = Number(row.amount || row.originalAmount || 0);
        const installments = Number(row.installments || row.cuotas || 8);
        const driverName = escapeHtml(row.driverName || "Chofer");
        const username = row.driverUsername ? `<small>Usuario: ${escapeHtml(row.driverUsername)}</small>` : "";
        const vehicle = row.driverVehicle ? `<small>Vehículo: ${escapeHtml(row.driverVehicle)}</small>` : "";
        return `<article class="explore-loan-admin-row" data-driver-uid="${uid}" data-driver-name="${driverName}"><div><strong>${driverName}</strong><small>UID ${uid}</small>${username}${vehicle}<small>${escapeHtml(row.requestedLabel || "Pendiente de aprobación")}</small></div><b>${money(amount)} · ${installments} cuotas</b><button data-loan-action="approve" type="button">APROBAR</button><button data-loan-action="reject" type="button">RECHAZAR</button></article>`;
      }).join("") : '<p class="explore-loan-admin-empty">No hay solicitudes pendientes.</p>');
    } catch(error) {
      list.dataset.loaded = "false";
      const code = escapeHtml(error?.code || "LOAN_PENDING_LIST_FAILED");
      const message = escapeHtml(error?.message || "No se pudieron cargar las solicitudes.");
      list.innerHTML = `<p class="explore-loan-admin-empty is-error">Error cargando solicitudes: ${message} <small>${code}</small></p>`;
      showDiagnostic({ module:"EXPLORE_LOAN_ADMIN", stage:"LOAN_PENDING_LIST", code, javascriptMessage:error?.message || String(error), stack:error?.stack || "—", functionName:"renderAdminPanel", uid:window.ExploraFirebase?.auth?.currentUser?.uid || "—", role:role(), firestorePath:"prestamos_explora", operation:"list pending loans", timestamp:new Date().toISOString() });
    } finally {
      adminBusy = false;
    }
  }

  async function adminAction(event){
    const button = event.target.closest?.("button[data-loan-action]");
    if (!button) return;
    const row = button.closest("[data-driver-uid]");
    const uid = row?.dataset?.driverUid;
    if (!uid) return;
    button.disabled = true;
    try {
      if (button.dataset.loanAction === "approve") {
        await window.ExploraApproveLoan?.(uid);
        setMessage("Préstamo aprobado correctamente.", true);
      } else {
        const reason = await openRejectReasonModal(uid, row?.dataset?.driverName || "Chofer");
        if (!reason) {
          setMessage("Rechazo cancelado. No se modificó la solicitud.");
          return;
        }
        await window.ExploraRejectLoan?.(uid, reason);
        setMessage("Solicitud rechazada correctamente.", true);
      }
      adminCacheAt = 0;
      await renderAdminPanel({ force:true });
      await refresh(true);
    } catch(error) {
      setMessage(error?.message || "No se pudo completar la acción.");
      showDiagnostic({ module:"EXPLORE_LOAN_ADMIN", stage:"LOAN_ADMIN_ACTION", code:error?.code || "LOAN_ADMIN_ACTION_FAILED", javascriptMessage:error?.message || String(error), stack:error?.stack || "—", functionName:"adminAction", uid, role:role(), firestorePath:`prestamos_explora/${uid}`, operation:button.dataset.loanAction || "admin loan action", timestamp:new Date().toISOString() });
    } finally {
      button.disabled = false;
    }
  }

  function showDiagnostic(payload){
    const modal = $("exploreLoanDiagnostic"), pre = $("exploreLoanDiagnosticText");
    if (!modal || !pre) return;
    pre.textContent = [`MÓDULO: ${payload.module || "EXPLORE_LOAN_REQUIREMENTS"}`,`ETAPA: ${payload.stage || "—"}`,`CÓDIGO: ${payload.code || "—"}`,`MENSAJE REAL FIREBASE: ${payload.firebaseMessage || "—"}`,`MENSAJE REAL JAVASCRIPT: ${payload.javascriptMessage || "—"}`,`STACK: ${payload.stack || "—"}`,`FUNCIÓN: ${payload.functionName || "—"}`,`UID: ${payload.uid || "—"}`,`ROL: ${payload.role || "—"}`,`SEMANA: ${payload.weeklyPeriodId || "—"}`,`PERÍODO PRÉSTAMO EXPLORA: ${payload.exploraLoanLookbackId || "—"}`,`PRÉSTAMO ACTIVO: ${payload.activeLoan ? "SÍ" : "NO"}`,`SEMANAS CON MOVIMIENTO: ${payload.activeWeeks ?? "—"}`,`REQUISITOS OBTENIDOS: ${payload.requirementsMet ?? "—"}`,`MONTO CALCULADO INTERNO: ${payload.calculatedAmount ?? "—"}`,`RUTA FIRESTORE: ${payload.firestorePath || "—"}`,`OPERATION: ${payload.operation || "—"}`,`TIMESTAMP: ${payload.timestamp || new Date().toISOString()}`].join("\n");
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  }
  function closeDiagnostic(){ const modal = $("exploreLoanDiagnostic"); if (modal) { modal.classList.remove("is-open"); modal.setAttribute("aria-hidden", "true"); } }
  function copyDiagnostic(){ navigator.clipboard?.writeText($("exploreLoanDiagnosticText")?.textContent || "").catch(() => {}); }

  window.addEventListener("explora:open-loan", open);
  window.addEventListener("explora:loan-diagnostic", event => showDiagnostic(event.detail || {}));
  ["explora:loan-requested","explora:loan-payment","explora:loan-approved","explora:loan-rejected"].forEach(name => window.addEventListener(name, () => { adminCacheAt = 0; refresh(true); }));
  window.addEventListener("explora:unified-weekly-snapshot", event => {
    const source = event.detail || {};
    render({ driverUid:source.driverUid || source.uid, weeklyPeriodId:source.weeklyPeriodId, exploraLoanLookbackId:source.exploraLoanLookbackId || source.exploraLoanLookback?.id || "", exploraLoanLookbackBilling:source.exploraLoanLookbackBilling || source.validBilling8Weeks || 0, validBilling8Weeks:source.validBilling8Weeks || source.exploraLoanLookbackBilling || 0, movementDays:source.movementDays || source.eligibility?.movementDays || 0, activeWeeks:source.activeWeeks || 0, requirements:source.requirements || {}, requirementList:source.requirementList || [], requirementsMet:source.requirementsMet || 0, activeLoan:source.activeLoan || null, availableBenefit:source.availableBenefit || source.benefitAvailable || 0, eligibility:source.eligibility || { validBilling8Weeks:false, rhythmReal:false, closureUpToDate:false, collaborationOk:false, noActiveLoan:true, eligible:false } });
  });
  document.addEventListener("DOMContentLoaded", () => {
    $("exploreLoanBackBtn")?.addEventListener("click", close);
    $("exploreLoanRequestBtn")?.addEventListener("click", request);
    $("exploreLoanAdminList")?.addEventListener("click", adminAction);
    $("exploreLoanDiagnosticClose")?.addEventListener("click", closeDiagnostic);
    $("exploreLoanDiagnosticCloseBottom")?.addEventListener("click", closeDiagnostic);
    $("exploreLoanDiagnosticCopy")?.addEventListener("click", copyDiagnostic);
  });
  window.ExploraActions = window.ExploraActions || {};
  window.ExploraActions["prestamo-explora"] = open;
})();
