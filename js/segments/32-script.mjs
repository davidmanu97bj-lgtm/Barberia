import {
  VEHICLE_COMPLIANCE_VERSION,
  DEFAULT_SERVICE_INTERVAL_KM,
  integerKm,
  formatKm,
  normalizeDateKey,
  formatDateKey,
  isValidDateKey,
  operationalDateKey,
  documentComplianceStatus,
  serviceComplianceStatus,
  overallComplianceStatus,
  sameStoredValue
} from "../core/vehicle-compliance-core.mjs";

const MI_AUTO_MODULE_VERSION = "v2.2.7-mi-auto-lazy-firebase";

if (window.ExploraVehicleDashboard?.version !== MI_AUTO_MODULE_VERSION) {
  "use strict";

  const { getApps, getApp } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
  const { getAuth } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js");
  const {
    getFirestore,
    doc,
    getDoc,
    collection,
    getDocs,
    query,
    where,
    limit,
    runTransaction,
    serverTimestamp
  } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");

  let auth = null;
  let db = null;
  let firebaseReadyPromise = null;

  async function ensureFirebaseContext(timeoutMs = 15000) {
    if (auth && db) return { auth, db };
    if (firebaseReadyPromise) return firebaseReadyPromise;
    firebaseReadyPromise = (async () => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const live = window.ExploraFirebase || {};
        if (live.auth && live.db) {
          auth = live.auth;
          db = live.db;
          return { auth, db };
        }
        const apps = getApps();
        if (apps.length) {
          const app = getApp();
          auth = getAuth(app);
          db = getFirestore(app);
          return { auth, db };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("EXPLORA_FIREBASE_NOT_READY_FOR_MI_AUTO");
    })();
    try {
      return await firebaseReadyPromise;
    } catch (error) {
      firebaseReadyPromise = null;
      throw error;
    }
  }

  const currentUser = () => auth?.currentUser || window.ExploraFirebase?.auth?.currentUser || null;

  const $ = id => document.getElementById(id);
  const clean = value => String(value ?? "").trim();
  const first = (source, keys) => {
    for (const key of keys) {
      const value = source?.[key];
      if (value !== undefined && value !== null && clean(value) !== "") return value;
    }
    return "";
  };
  const esc = value => clean(value).replace(/[&<>'"]/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[char]));
  const money = value => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Math.max(0, Number(value) || 0));
  const displayDate = value => {
    const key = normalizeDateKey(value);
    if (key) return formatDateKey(key);
    try {
      const date = value?.toDate ? value.toDate() : new Date(value);
      return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("es-AR", { day:"2-digit", month:"2-digit", year:"numeric" }).format(date);
    } catch {
      return "—";
    }
  };
  const operationalNow = () => window.ExploraOperationalClock?.getNow?.() || window.ExploraAppNow?.() || new Date();
  const currentRole = profile => clean(window.ExploraSession?.role || profile?.rol || profile?.role || "chofer").toLowerCase() || "chofer";
  const ADMIN_ROLES = new Set(["admin", "administrador", "owner", "superadmin"]);
  const isAdminRole = value => ADMIN_ROLES.has(clean(value).toLowerCase());
  const isAdminSession = () => document.body?.classList.contains("explora-shared-admin") || isAdminRole(window.ExploraSession?.role || window.ExploraSession?.profile?.role || window.ExploraSession?.profile?.rol);
  const profileUid = profile => clean(profile?.uid || profile?.authUid || profile?.firebaseUid || profile?.id);
  const profileName = profile => clean(profile?.nombreCompleto || profile?.nombre || profile?.displayName || profile?.usuario || profile?.username || profile?.email || profile?.id || "Chofer");

  const VEHICLE_DATE_FIELDS = Object.freeze({
    vtv: {
      key:"vtv",
      label:"VTV",
      scope:"vehicle",
      type:"date",
      aliases:["vtvExpiry", "vencimientoVTV", "vencimientoVtv", "fechaVencimientoVtv", "vtvVence"],
      patch:value => ({ vtvExpiry:value, vencimientoVTV:value })
    },
    vehicleInsurance: {
      key:"vehicleInsurance",
      label:"Seguro del auto",
      scope:"vehicle",
      type:"date",
      aliases:["vehicleInsuranceExpiry", "vencimientoSeguro", "insuranceExpiry", "seguroVence", "fechaVencimientoSeguro"],
      patch:value => ({ vehicleInsuranceExpiry:value, vencimientoSeguro:value })
    },
    plate: {
      key:"plate",
      label:"Patente",
      scope:"vehicle",
      type:"date",
      aliases:["plateExpiry", "vencimientoPatente", "patenteExpiry", "fechaVencimientoPatente"],
      patch:value => ({ plateExpiry:value, vencimientoPatente:value })
    },
    municipalControl: {
      key:"municipalControl",
      label:"Control municipal",
      scope:"vehicle",
      type:"date",
      aliases:["municipalControlExpiry", "vencimientoControlMunicipal", "controlMunicipalExpiry", "fechaControlMunicipal"],
      patch:value => ({ municipalControlExpiry:value, vencimientoControlMunicipal:value })
    }
  });

  const DRIVER_DATE_FIELDS = Object.freeze({
    lifeInsurance: {
      key:"lifeInsurance",
      label:"Seguro de vida",
      scope:"driver",
      type:"date",
      aliases:["lifeInsuranceExpiry", "vencimientoSeguroVida", "seguroVidaExpiry", "fechaVencimientoSeguroVida"],
      patch:value => ({ lifeInsuranceExpiry:value, vencimientoSeguroVida:value })
    },
    healthCard: {
      key:"healthCard",
      label:"Carnet de sanidad",
      scope:"driver",
      type:"date",
      aliases:["healthCardExpiry", "vencimientoCarnetSanidad", "carnetSanidadExpiry", "fechaVencimientoSanidad"],
      patch:value => ({ healthCardExpiry:value, vencimientoCarnetSanidad:value })
    },
    driverLicense: {
      key:"driverLicense",
      label:"Carnet de conducir",
      scope:"driver",
      type:"date",
      aliases:["driverLicenseExpiry", "vencimientoCarnetConducir", "carnetConducirExpiry", "fechaVencimientoLicencia"],
      patch:value => ({ driverLicenseExpiry:value, vencimientoCarnetConducir:value })
    }
  });

  const DATE_FIELDS = Object.freeze({ ...VEHICLE_DATE_FIELDS, ...DRIVER_DATE_FIELDS });
  const ALL_FIELD_KEYS = Object.freeze(["currentKm", "service", ...Object.keys(VEHICLE_DATE_FIELDS), ...Object.keys(DRIVER_DATE_FIELDS)]);

  const state = {
    activeScreen:null,
    context:null,
    contextGeneration:0,
    dashboardGeneration:0,
    adminGeneration:0,
    dashboardStatus:Object.freeze({ code:"pending", label:"Estado pendiente de completar", fullLabel:"Estado pendiente de completar", count:0, missing:8 }),
    inFlight:new Set(),
    messages:new Map(),
    renderTarget:null,
    mode:"driver",
    adminProfiles:[],
    adminHost:null,
    lastOperationalDateKey:operationalDateKey(operationalNow())
  };

  function updateVehicleOverlayState() {
    const hasOpen = Boolean(document.querySelector(".vehicle-detail-screen.is-open"));
    document.body.classList.toggle("vehicle-detail-open", hasOpen);
    if (!hasOpen) document.body.style.overflow = "";
  }

  function openScreen(screen) {
    document.querySelectorAll(".vehicle-detail-screen.is-open").forEach(closeScreen);
    screen.hidden = false;
    screen.removeAttribute("inert");
    screen.classList.add("is-open");
    screen.setAttribute("aria-hidden", "false");
    state.activeScreen = screen;
    document.body.style.overflow = "hidden";
    document.body.classList.add("vehicle-detail-open");
    screen.scrollTop = 0;
  }

  function closeScreen(screen) {
    if (!screen) return;
    screen.classList.remove("is-open");
    screen.setAttribute("aria-hidden", "true");
    screen.setAttribute("inert", "");
    screen.hidden = true;
    if (state.activeScreen === screen) state.activeScreen = null;
    updateVehicleOverlayState();
  }

  async function loadProfile(uid) {
    const sessionProfile = window.ExploraSession?.profile;
    const sessionId = clean(window.ExploraSession?.profileDocumentId || sessionProfile?.id);
    if (sessionId) {
      const snap = await getDoc(doc(db, "choferes", sessionId)).catch(() => null);
      if (snap?.exists()) return { ...snap.data(), id:snap.id, ref:snap.ref };
    }
    const direct = await getDoc(doc(db, "choferes", uid)).catch(() => null);
    if (direct?.exists()) return { ...direct.data(), id:direct.id, ref:direct.ref };
    for (const field of ["uid", "authUid", "firebaseUid"]) {
      const snap = await getDocs(query(collection(db, "choferes"), where(field, "==", uid), limit(1))).catch(() => null);
      if (snap && !snap.empty) {
        const found = snap.docs[0];
        return { ...found.data(), id:found.id, ref:found.ref };
      }
    }
    if (sessionProfile && (sessionId || profileUid(sessionProfile))) {
      const id = sessionId || profileUid(sessionProfile) || uid;
      return { ...sessionProfile, id, ref:doc(db, "choferes", id) };
    }
    return null;
  }

  function assignedVehicleIds(profile = {}) {
    return [profile.assignedVehicleId, profile.vehicleId, profile.vehiculoId, profile.autoId, profile.vehiculoAsignado, profile.vehiculo]
      .map(clean)
      .filter(Boolean);
  }

  function identitySet(uid, profile = {}) {
    return new Set([
      uid,
      profile.id,
      profile.uid,
      profile.authUid,
      profile.firebaseUid,
      profile.usuario,
      profile.username,
      profile.nombre,
      profile.nombreCompleto
    ].map(clean).filter(Boolean).map(value => value.toLowerCase()));
  }

  function vehicleAssignmentValues(vehicle = {}) {
    return [
      vehicle.currentDriverUid,
      vehicle.currentDriverDocumentId,
      vehicle.choferId,
      vehicle.conductorId,
      vehicle.driverId,
      vehicle.asignadoA,
      vehicle.chofer,
      vehicle.uidChofer
    ].map(clean).filter(Boolean).map(value => value.toLowerCase());
  }

  function isVehicleAssignedTo(uid, profile, vehicleId, vehicle) {
    const directIds = assignedVehicleIds(profile);
    if (directIds.includes(vehicleId)) return true;
    const identities = identitySet(uid, profile);
    return vehicleAssignmentValues(vehicle).some(value => identities.has(value));
  }

  async function loadVehicle(uid, profile = {}) {
    for (const id of [...new Set(assignedVehicleIds(profile))]) {
      const snap = await getDoc(doc(db, "vehiculos", id)).catch(() => null);
      if (snap?.exists()) return { ...snap.data(), id:snap.id, ref:snap.ref };
    }
    const identities = [...identitySet(uid, profile)];
    for (const field of ["currentDriverUid", "currentDriverDocumentId", "choferId", "conductorId", "driverId", "asignadoA", "chofer", "uidChofer"]) {
      for (const identity of identities) {
        const snap = await getDocs(query(collection(db, "vehiculos"), where(field, "==", identity), limit(1))).catch(() => null);
        if (snap && !snap.empty) {
          const found = snap.docs[0];
          const data = found.data();
          if (isVehicleAssignedTo(uid, profile, found.id, data)) return { ...data, id:found.id, ref:found.ref };
        }
      }
    }
    return null;
  }

  function vehicleDisplay(profile, vehicle) {
    const brand = first(vehicle, ["marca", "brand"]) || first(profile, ["marcaVehiculo", "vehiculoMarca", "autoMarca"]);
    const model = first(vehicle, ["modelo", "model", "marcaModelo", "nombre", "tipoVehiculo"]) || first(profile, ["assignedVehicleModel", "modeloVehiculo", "vehiculoModelo", "autoModelo"]);
    const plate = clean(first(vehicle, ["patente", "plate", "plateNormalized", "matricula", "dominio"]) || first(profile, ["assignedVehiclePlate", "patenteVehiculo", "vehiculoPatente", "autoPatente"])).toUpperCase();
    return { name:[brand, model].filter(Boolean).join(" ") || "Vehículo asignado", plate:plate || "Patente no informada" };
  }

  function buildContext(user, profile, vehicle, options = {}) {
    const now = operationalNow();
    const intervalKm = integerKm(first(vehicle, ["serviceIntervalKm", "intervaloServiceKm", "serviceInterval", "intervaloService"])) || DEFAULT_SERVICE_INTERVAL_KM;
    const currentKm = integerKm(first(vehicle, ["currentKm", "kilometraje", "mileage", "km", "odometro", "odometer"]));
    const lastServiceKm = integerKm(first(vehicle, ["lastServiceKm", "serviceKm", "kilometrajeUltimoService", "ultimoServiceKm", "serviceMileage"]));
    const explicitNextServiceKm = integerKm(first(vehicle, ["nextServiceKm", "proximoServiceKm", "kilometrajeProximoService"]));
    const serviceStatus = serviceComplianceStatus({ currentKm, lastServiceKm, nextServiceKm:explicitNextServiceKm, intervalKm });
    const dates = {};
    const dateStatuses = {};
    for (const definition of Object.values(DATE_FIELDS)) {
      const source = definition.scope === "vehicle" ? vehicle : profile;
      const value = normalizeDateKey(first(source, definition.aliases));
      dates[definition.key] = value;
      dateStatuses[definition.key] = documentComplianceStatus(value, now);
    }
    const overall = overallComplianceStatus([serviceStatus, ...Object.values(dateStatuses)]);
    const mode = options.mode === "admin" ? "admin" : "driver";
    const actorRole = mode === "admin" ? "admin" : currentRole(profile);
    const targetDriverUid = mode === "driver" ? user.uid : profileUid(profile);
    return {
      version:MI_AUTO_MODULE_VERSION,
      complianceVersion:VEHICLE_COMPLIANCE_VERSION,
      mode,
      actorUid:user.uid,
      userUid:user.uid,
      driverUid:targetDriverUid,
      driverName:profileName(profile),
      role:actorRole,
      profileId:profile.id,
      profileRef:profile.ref || doc(db, "choferes", profile.id),
      profile,
      vehicleId:vehicle.id,
      vehicleRef:vehicle.ref || doc(db, "vehiculos", vehicle.id),
      vehicle,
      display:vehicleDisplay(profile, vehicle),
      currentKm,
      lastServiceKm,
      nextServiceKm:serviceStatus.nextServiceKm,
      serviceIntervalKm:serviceStatus.intervalKm,
      serviceStatus,
      dates,
      dateStatuses,
      overall,
      operationalDateKey:operationalDateKey(now)
    };
  }

  async function loadContext() {
    await ensureFirebaseContext();
    const user = currentUser();
    if (!user?.uid) throw new Error("MI_AUTO_AUTH_REQUIRED");
    const profile = await loadProfile(user.uid);
    if (!profile) throw new Error("MI_AUTO_DRIVER_PROFILE_NOT_FOUND");
    const vehicle = await loadVehicle(user.uid, profile);
    if (!vehicle) return { user, profile, vehicle:null, context:null };
    return { user, profile, vehicle, context:buildContext(user, profile, vehicle, { mode:"driver" }) };
  }

  async function loadAdminProfiles() {
    await ensureFirebaseContext();
    const snapshot = await getDocs(collection(db, "choferes"));
    return snapshot.docs
      .map(item => ({ ...item.data(), id:item.id, ref:item.ref }))
      .filter(profile => !isAdminRole(profile.role || profile.rol || profile.tipoUsuario || profile.tipo))
      .filter(profile => profile.isDeleted !== true && clean(profile.status).toLowerCase() !== "deleted")
      .sort((a,b) => profileName(a).localeCompare(profileName(b), "es"));
  }

  async function loadAdminContext(profileId) {
    await ensureFirebaseContext();
    const user = currentUser();
    if (!user?.uid || !isAdminRole(window.ExploraSession?.role || window.ExploraSession?.profile?.role || window.ExploraSession?.profile?.rol)) throw new Error("MI_AUTO_ADMIN_REQUIRED");
    const profile = state.adminProfiles.find(item => item.id === profileId);
    if (!profile) throw new Error("Selecciona un chofer válido.");
    const targetUid = profileUid(profile);
    const vehicle = await loadVehicle(targetUid, profile);
    if (!vehicle) return { user, profile, vehicle:null, context:null };
    return { user, profile, vehicle, context:buildContext(user, profile, vehicle, { mode:"admin" }) };
  }

  function statusBadge(status) {
    const code = status?.code || "missing";
    const text = `${status?.icon ? `${status.icon} ` : ""}${status?.label || "Pendiente de completar"}`;
    return `<span class="mi-auto-state mi-auto-state--${esc(code)}">${esc(text)}</span>`;
  }

  function rowMessage(fieldKey) {
    const message = state.messages.get(fieldKey);
    if (!message) return `<div class="mi-auto-row-message" data-mi-auto-message="${esc(fieldKey)}" aria-live="polite"></div>`;
    return `<div class="mi-auto-row-message is-${esc(message.type)}" data-mi-auto-message="${esc(fieldKey)}" aria-live="polite">${esc(message.text)}</div>`;
  }

  function numberInput(fieldKey, placeholder) {
    const busy = state.inFlight.has(fieldKey);
    return `<div class="mi-auto-update"><input aria-label="Nuevo valor para ${esc(fieldKey)}" data-mi-auto-input="${esc(fieldKey)}" inputmode="numeric" min="0" step="1" type="number" placeholder="${esc(placeholder)}" autocomplete="off"><button data-mi-auto-save="${esc(fieldKey)}" type="button"${busy ? " disabled" : ""}>${busy ? "Guardando…" : "Guardar"}</button></div>${rowMessage(fieldKey)}`;
  }

  function dateInput(definition) {
    const busy = state.inFlight.has(definition.key);
    return `<div class="mi-auto-update"><input aria-label="Nueva fecha para ${esc(definition.label)}" data-mi-auto-input="${esc(definition.key)}" type="date" autocomplete="off"><button data-mi-auto-save="${esc(definition.key)}" type="button"${busy ? " disabled" : ""}>${busy ? "Guardando…" : "Guardar"}</button></div>${rowMessage(definition.key)}`;
  }

  function renderCurrentKm(context) {
    return `<article class="mi-auto-row" data-mi-auto-row="currentKm"><div class="mi-auto-row-head"><div><h2>KM ACTUAL</h2><p>Actual: <strong>${esc(formatKm(context.currentKm))}</strong></p></div></div>${numberInput("currentKm", "Nuevo kilometraje")}</article>`;
  }

  function renderService(context) {
    return `<article class="mi-auto-row" data-mi-auto-row="service"><div class="mi-auto-row-head"><div><h2>SERVICE DEL AUTO</h2><p>Último service: <strong>${esc(formatKm(context.lastServiceKm))}</strong></p><p>Próximo service: <strong>${esc(formatKm(context.nextServiceKm))}</strong></p></div>${statusBadge(context.serviceStatus)}</div>${numberInput("service", "KM del service")}</article>`;
  }

  function renderDateField(context, definition) {
    const current = context.dates[definition.key];
    const compliance = context.dateStatuses[definition.key];
    return `<article class="mi-auto-row" data-mi-auto-row="${esc(definition.key)}"><div class="mi-auto-row-head"><div><h2>${esc(definition.label.toUpperCase())}</h2><p>Actual: <strong>${esc(formatDateKey(current))}</strong></p></div>${statusBadge(compliance)}</div>${dateInput(definition)}</article>`;
  }

  function renderVehicleContent(context, content = state.renderTarget || $("myVehicleContent")) {
    if (!content) return;
    const driverLine = context.mode === "admin" ? `<span class="mi-auto-admin-driver">CHOFER: ${esc(context.driverName)}</span>` : "";
    content.innerHTML = `<article class="vehicle-info-card vehicle-info-hero mi-auto-hero"><small>VEHÍCULO ASIGNADO</small><strong>${esc(context.display.name)}</strong><b>${esc(context.display.plate)}</b>${driverLine}<span class="mi-auto-overall mi-auto-overall--${esc(context.overall.code)}">${esc(context.overall.fullLabel)}</span></article><div class="mi-auto-list">${renderCurrentKm(context)}${renderService(context)}${Object.values(VEHICLE_DATE_FIELDS).map(definition => renderDateField(context, definition)).join("")}${Object.values(DRIVER_DATE_FIELDS).map(definition => renderDateField(context, definition)).join("")}</div>`;
    content.hidden = false;
    state.renderTarget = content;
  }

  function showScreenMessage(text, type = "info", status = $("myVehicleStatus"), content = $("myVehicleContent")) {
    if (!status || !content) return;
    status.hidden = false;
    status.className = `vehicle-detail-status${type === "error" ? " is-error" : ""}`;
    status.textContent = text;
    content.hidden = true;
    content.innerHTML = "";
  }

  function applyDashboardState(status = state.dashboardStatus) {
    const button = document.querySelector('[data-action="mi-auto"]');
    if (!button) return;
    if (isAdminSession()) {
      button.dataset.miAutoState = "admin";
      let adminStatus = button.querySelector("#myVehicleDashboardStatus, .vehicle-management-status");
      if (!adminStatus) {
        adminStatus = document.createElement("small");
        adminStatus.id = "myVehicleDashboardStatus";
        adminStatus.className = "vehicle-management-status";
        button.appendChild(adminStatus);
      }
      adminStatus.textContent = "Editar vehículos y documentación";
      button.setAttribute("aria-label", "Abrir Mi auto para seleccionar un chofer y editar su vehículo y documentación");
      return;
    }
    const normalized = status || { code:"pending", label:"Estado pendiente de completar", fullLabel:"Estado pendiente de completar" };
    button.dataset.miAutoState = normalized.code || "pending";
    let statusElement = button.querySelector("#myVehicleDashboardStatus, .vehicle-management-status");
    if (!statusElement) {
      statusElement = document.createElement("small");
      statusElement.id = "myVehicleDashboardStatus";
      statusElement.className = "vehicle-management-status";
      button.appendChild(statusElement);
    }
    statusElement.textContent = normalized.code === "expired" ? `🔴 ${normalized.label}` : normalized.code === "warning" ? `🟡 ${normalized.label}` : normalized.code === "ok" ? "🟢 Todo al día" : "Estado pendiente de completar";
    button.setAttribute("aria-label", `Abrir información de mi auto asignado. ${normalized.fullLabel || normalized.label}`);
  }

  function setDashboardPending() {
    state.dashboardStatus = Object.freeze({ code:"pending", label:"Estado pendiente de completar", fullLabel:"Estado pendiente de completar", count:0, missing:8 });
    applyDashboardState();
  }

  async function refreshDashboard() {
    const generation = ++state.dashboardGeneration;
    if (isAdminSession()) {
      applyDashboardState();
      return state.context?.mode === "admin" ? state.context : null;
    }
    try {
      await ensureFirebaseContext();
    } catch (error) {
      console.error("MI_AUTO_FIREBASE_INIT_FAILED", error);
      setDashboardPending();
      return null;
    }
    const userUid = currentUser()?.uid || "";
    if (!userUid) {
      state.context = null;
      setDashboardPending();
      return null;
    }
    try {
      const loaded = await loadContext();
      if (generation !== state.dashboardGeneration || currentUser()?.uid !== userUid) return null;
      if (!loaded.context) {
        state.context = null;
        setDashboardPending();
        return null;
      }
      state.context = loaded.context;
      state.dashboardStatus = loaded.context.overall;
      state.lastOperationalDateKey = loaded.context.operationalDateKey;
      applyDashboardState();
      return loaded.context;
    } catch (error) {
      if (generation !== state.dashboardGeneration) return null;
      console.error("MI_AUTO_DASHBOARD_LOAD_FAILED", error);
      setDashboardPending();
      return null;
    }
  }

  async function showVehicle() {
    const screen = $("myVehicleScreen");
    if (!screen) return;
    state.mode = "driver";
    state.renderTarget = $("myVehicleContent");
    openScreen(screen);
    showScreenMessage("Cargando información del vehículo…");
    const generation = ++state.contextGeneration;
    try {
      await ensureFirebaseContext();
    } catch (error) {
      console.error("MI_AUTO_FIREBASE_INIT_FAILED", error);
      showScreenMessage("No se pudo iniciar Firebase para Mi auto. Recarga la app e inténtalo nuevamente.", "error");
      return;
    }
    const userUid = currentUser()?.uid || "";
    if (!userUid) {
      showScreenMessage("No hay una sesión activa.", "error");
      return;
    }
    try {
      const loaded = await loadContext();
      if (generation !== state.contextGeneration || currentUser()?.uid !== userUid) return;
      if (!loaded.context) {
        state.context = null;
        setDashboardPending();
        showScreenMessage("No tienes un vehículo asignado");
        return;
      }
      state.context = loaded.context;
      state.dashboardStatus = loaded.context.overall;
      state.lastOperationalDateKey = loaded.context.operationalDateKey;
      applyDashboardState();
      const status = $("myVehicleStatus");
      status.hidden = true;
      renderVehicleContent(loaded.context);
    } catch (error) {
      console.error("MI_AUTO_LOAD_FAILED", error);
      showScreenMessage(error?.message === "MI_AUTO_DRIVER_PROFILE_NOT_FOUND" ? "No se encontró tu perfil de chofer." : "No se pudo cargar Mi auto. Revisa tu conexión e inténtalo nuevamente.", "error");
    }
  }

  function valueForField(source, fieldKey) {
    if (fieldKey === "currentKm") return integerKm(first(source, ["currentKm", "kilometraje", "mileage", "km", "odometro", "odometer"]));
    if (fieldKey === "service") {
      const lastServiceKm = integerKm(first(source, ["lastServiceKm", "serviceKm", "kilometrajeUltimoService", "ultimoServiceKm", "serviceMileage"]));
      const intervalKm = integerKm(first(source, ["serviceIntervalKm", "intervaloServiceKm", "serviceInterval", "intervaloService"])) || DEFAULT_SERVICE_INTERVAL_KM;
      const nextServiceKm = integerKm(first(source, ["nextServiceKm", "proximoServiceKm", "kilometrajeProximoService"])) ?? (lastServiceKm === null ? null : lastServiceKm + intervalKm);
      return { lastServiceKm, nextServiceKm, intervalKm };
    }
    const definition = DATE_FIELDS[fieldKey];
    return definition ? normalizeDateKey(first(source, definition.aliases)) : null;
  }

  function operationId(fieldKey) {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${fieldKey}-${random}`.replace(/[^a-zA-Z0-9_-]/g, "");
  }

  function fieldPatch(fieldKey, value, source) {
    if (fieldKey === "currentKm") return { currentKm:value, kilometraje:value };
    if (fieldKey === "service") {
      const intervalKm = integerKm(first(source, ["serviceIntervalKm", "intervaloServiceKm", "serviceInterval", "intervaloService"])) || DEFAULT_SERVICE_INTERVAL_KM;
      return { lastServiceKm:value, kilometrajeUltimoService:value, nextServiceKm:value + intervalKm, proximoServiceKm:value + intervalKm, serviceIntervalKm:intervalKm };
    }
    return DATE_FIELDS[fieldKey]?.patch(value) || {};
  }

  function validateInput(fieldKey, rawValue, context) {
    if (fieldKey === "currentKm" || fieldKey === "service") {
      const value = integerKm(rawValue);
      if (value === null) throw new Error("Ingresa un número válido mayor o igual a cero.");
      if (fieldKey === "currentKm" && context.currentKm !== null && value < context.currentKm) throw new Error("El KM actual no puede ser menor al último registrado.");
      return value;
    }
    if (!isValidDateKey(rawValue)) throw new Error("Selecciona una fecha válida.");
    return rawValue;
  }

  async function persistField(fieldKey, value) {
    await ensureFirebaseContext();
    const context = state.context;
    const user = currentUser();
    if (!context || !user?.uid || user.uid !== context.actorUid) throw new Error("La sesión o el vehículo cambió. Vuelve a abrir Mi auto.");
    const adminMode = context.mode === "admin";
    if (adminMode && !isAdminRole(window.ExploraSession?.role || window.ExploraSession?.profile?.role || window.ExploraSession?.profile?.rol)) throw new Error("No tienes permisos para editar este vehículo.");
    if (!adminMode && context.driverUid !== user.uid && !identitySet(user.uid, context.profile).has(user.uid.toLowerCase())) throw new Error("No puedes editar información de otro chofer.");
    if (!ALL_FIELD_KEYS.includes(fieldKey)) throw new Error("Campo de Mi auto no válido.");
    const definition = DATE_FIELDS[fieldKey];
    const scope = definition?.scope || "vehicle";
    const targetRef = scope === "driver" ? context.profileRef : context.vehicleRef;
    const historyRef = doc(collection(targetRef, "mi_auto_history"), operationId(fieldKey));
    const role = context.role || "chofer";

    return runTransaction(db, async transaction => {
      const freshProfileSnap = await transaction.get(context.profileRef);
      if (!freshProfileSnap.exists()) throw new Error("Tu perfil de chofer ya no está disponible.");
      const freshProfile = { ...freshProfileSnap.data(), id:freshProfileSnap.id };
      let freshVehicle = null;
      let targetSnap = freshProfileSnap;
      if (scope === "vehicle") {
        const freshVehicleSnap = await transaction.get(context.vehicleRef);
        if (!freshVehicleSnap.exists()) throw new Error("El vehículo asignado ya no está disponible.");
        freshVehicle = { ...freshVehicleSnap.data(), id:freshVehicleSnap.id };
        if (!isVehicleAssignedTo(context.driverUid, freshProfile, context.vehicleId, freshVehicle)) throw new Error("El vehículo asignado cambió. No se guardó ningún dato.");
        targetSnap = freshVehicleSnap;
      }
      const source = targetSnap.data() || {};
      const previous = valueForField(source, fieldKey);
      const comparePrevious = fieldKey === "service" ? previous?.lastServiceKm : previous;
      const type = fieldKey === "currentKm" || fieldKey === "service" ? "number" : "date";
      if (sameStoredValue(type, comparePrevious, value)) return { unchanged:true, freshProfile, freshVehicle };
      if (fieldKey === "currentKm") {
        const storedKm = integerKm(previous);
        if (storedKm !== null && value < storedKm) throw new Error("El KM actual no puede ser menor al último registrado.");
      }
      const patch = fieldPatch(fieldKey, value, source);
      const metadata = {
        miAutoUpdatedAt:serverTimestamp(),
        miAutoUpdatedByUid:user.uid,
        miAutoUpdatedByRole:role,
        miAutoSchemaVersion:1
      };
      transaction.set(targetRef, { ...patch, ...metadata }, { merge:true });
      transaction.set(historyRef, {
        operationId:historyRef.id,
        module:"mi_auto",
        field:fieldKey,
        scope,
        previousValue:previous ?? null,
        newValue:value,
        vehicleId:context.vehicleId,
        driverUid:context.driverUid,
        driverProfileId:context.profileId,
        updatedByUid:user.uid,
        updatedByRole:role,
        createdAt:serverTimestamp(),
        clientCreatedAt:new Date().toISOString(),
        schemaVersion:1
      });
      return {
        unchanged:false,
        patch,
        scope,
        freshProfile:scope === "driver" ? { ...freshProfile, ...patch } : freshProfile,
        freshVehicle:scope === "vehicle" ? { ...freshVehicle, ...patch } : { ...context.vehicle }
      };
    });
  }

  function setRowMessage(fieldKey, text, type) {
    state.messages.set(fieldKey, { text, type });
    const element = state.renderTarget?.querySelector?.(`[data-mi-auto-message="${CSS.escape(fieldKey)}"]`) || document.querySelector(`[data-mi-auto-message="${CSS.escape(fieldKey)}"]`);
    if (element) {
      element.className = `mi-auto-row-message is-${type}`;
      element.textContent = text;
    }
  }

  async function saveField(fieldKey) {
    if (state.inFlight.has(fieldKey)) return;
    const input = state.renderTarget?.querySelector?.(`[data-mi-auto-input="${CSS.escape(fieldKey)}"]`) || document.querySelector(`[data-mi-auto-input="${CSS.escape(fieldKey)}"]`);
    const button = state.renderTarget?.querySelector?.(`[data-mi-auto-save="${CSS.escape(fieldKey)}"]`) || document.querySelector(`[data-mi-auto-save="${CSS.escape(fieldKey)}"]`);
    if (!input || !button || !state.context) return;
    let value;
    try {
      value = validateInput(fieldKey, input.value, state.context);
    } catch (error) {
      setRowMessage(fieldKey, error.message, "error");
      input.focus({ preventScroll:true });
      return;
    }
    state.inFlight.add(fieldKey);
    button.disabled = true;
    button.textContent = "Guardando…";
    setRowMessage(fieldKey, "Guardando en Firestore…", "saving");
    try {
      const result = await persistField(fieldKey, value);
      if (result.unchanged) {
        setRowMessage(fieldKey, "Ese valor ya está guardado.", "success");
      } else {
        state.context = buildContext(currentUser(), result.freshProfile, result.freshVehicle, { mode:state.context.mode });
        state.dashboardStatus = state.context.overall;
        state.messages.set(fieldKey, { text:"Guardado correctamente.", type:"success" });
        applyDashboardState();
        renderVehicleContent(state.context, state.renderTarget);
      }
      window.dispatchEvent(new CustomEvent("explora:mi-auto-updated", { detail:{ field:fieldKey, vehicleId:state.context?.vehicleId || "", driverUid:state.context?.driverUid || currentUser()?.uid || "" } }));
      setTimeout(() => {
        const message = state.messages.get(fieldKey);
        if (message?.type === "success") {
          state.messages.delete(fieldKey);
          const element = state.renderTarget?.querySelector?.(`[data-mi-auto-message="${CSS.escape(fieldKey)}"]`) || document.querySelector(`[data-mi-auto-message="${CSS.escape(fieldKey)}"]`);
          if (element) { element.className = "mi-auto-row-message"; element.textContent = ""; }
        }
      }, 2400);
    } catch (error) {
      console.error("MI_AUTO_SAVE_FAILED", { fieldKey, error });
      setRowMessage(fieldKey, error?.message || "Firestore no pudo guardar el dato. Inténtalo nuevamente.", "error");
      button.disabled = false;
      button.textContent = "Guardar";
    } finally {
      state.inFlight.delete(fieldKey);
      const currentButton = state.renderTarget?.querySelector?.(`[data-mi-auto-save="${CSS.escape(fieldKey)}"]`) || document.querySelector(`[data-mi-auto-save="${CSS.escape(fieldKey)}"]`);
      if (currentButton) { currentButton.disabled = false; currentButton.textContent = "Guardar"; }
    }
  }


  function adminSelectorMarkup(profiles) {
    return `<section class="admin-mi-auto-shell"><div class="admin-mi-auto-select"><label for="adminMiAutoDriverSelect">CHOFER</label><select id="adminMiAutoDriverSelect"><option value="">Selecciona un chofer</option>${profiles.map(profile => `<option value="${esc(profile.id)}">${esc(profileName(profile))}</option>`).join("")}</select></div><div aria-live="polite" class="vehicle-detail-status" id="adminMiAutoStatus">Selecciona un chofer para editar su vehículo y documentación.</div><div class="vehicle-detail-content" hidden id="adminMiAutoEditor"></div></section>`;
  }

  async function selectAdminDriver(profileId) {
    const generation = ++state.adminGeneration;
    const status = $("adminMiAutoStatus");
    const editor = $("adminMiAutoEditor");
    if (!status || !editor) return;
    state.messages.clear();
    state.context = null;
    state.renderTarget = editor;
    if (!profileId) {
      status.hidden = false;
      status.className = "vehicle-detail-status";
      status.textContent = "Selecciona un chofer para editar su vehículo y documentación.";
      editor.hidden = true;
      editor.innerHTML = "";
      return;
    }
    status.hidden = false;
    status.className = "vehicle-detail-status";
    status.textContent = "Cargando vehículo asignado…";
    editor.hidden = true;
    editor.innerHTML = "";
    try {
      const loaded = await loadAdminContext(profileId);
      if (generation !== state.adminGeneration) return;
      if (!loaded.context) {
        status.textContent = "El chofer seleccionado no tiene un vehículo asignado.";
        return;
      }
      state.mode = "admin";
      state.context = loaded.context;
      state.renderTarget = editor;
      status.hidden = true;
      renderVehicleContent(loaded.context, editor);
    } catch (error) {
      console.error("ADMIN_MI_AUTO_LOAD_FAILED", error);
      status.className = "vehicle-detail-status is-error";
      status.textContent = error?.message || "No se pudo cargar Mi auto para el chofer seleccionado.";
    }
  }

  async function mountAdminEditor(container) {
    if (!container) return;
    const generation = ++state.adminGeneration;
    state.mode = "admin";
    state.context = null;
    state.messages.clear();
    container.innerHTML = '<div class="vehicle-detail-status">Cargando choferes y vehículos…</div>';
    try {
      if (!isAdminRole(window.ExploraSession?.role || window.ExploraSession?.profile?.role || window.ExploraSession?.profile?.rol)) throw new Error("Se requieren permisos de administrador.");
      const profiles = await loadAdminProfiles();
      if (generation !== state.adminGeneration) return;
      state.adminProfiles = profiles;
      container.innerHTML = adminSelectorMarkup(profiles);
      state.adminHost = container;
      if (!profiles.length) {
        const status = $("adminMiAutoStatus");
        if (status) status.textContent = "No hay choferes disponibles.";
      }
    } catch (error) {
      console.error("ADMIN_MI_AUTO_MOUNT_FAILED", error);
      container.innerHTML = `<div class="vehicle-detail-status is-error">${esc(error?.message || "No se pudo abrir Mi auto.")}</div>`;
    }
  }

  function recalculateForOperationalDate() {
    const nextDateKey = operationalDateKey(operationalNow());
    if (nextDateKey === state.lastOperationalDateKey) return;
    state.lastOperationalDateKey = nextDateKey;
    if (!state.context || !currentUser()) return;
    state.context = buildContext(currentUser(), state.context.profile, state.context.vehicle, { mode:state.context.mode });
    state.dashboardStatus = state.context.overall;
    applyDashboardState();
    if (state.renderTarget && state.inFlight.size === 0) renderVehicleContent(state.context, state.renderTarget);
  }

  async function openMiAutoByRole() {
    if (isAdminSession()) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const openAdminMiAuto = window.ExploraActions?.["admin-mi-auto"];
        if (typeof openAdminMiAuto === "function") {
          openAdminMiAuto();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      console.error("MI_AUTO_ADMIN_ACTION_NOT_READY");
      const screen = $("myVehicleScreen");
      if (screen) {
        openScreen(screen);
        showScreenMessage("No se pudo abrir el editor administrativo de Mi auto. Recarga la app e inténtalo nuevamente.", "error");
      }
      return;
    }
    await showVehicle();
  }

  document.addEventListener("change", event => {
    if (event.target?.id === "adminMiAutoDriverSelect") selectAdminDriver(event.target.value);
  });

  document.addEventListener("click", event => {
    const saveButton = event.target.closest?.("[data-mi-auto-save]");
    if (!saveButton) return;
    event.preventDefault();
    saveField(saveButton.dataset.miAutoSave);
  }, { passive:false });

  $("myVehicleBack")?.addEventListener("click", () => closeScreen($("myVehicleScreen")));
  $("myVehicleScreen")?.addEventListener("focusin", event => {
    if (!event.target.matches?.(".mi-auto-update input")) return;
    setTimeout(() => event.target.scrollIntoView({ behavior:"smooth", block:"center" }), 220);
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape" && state.activeScreen) closeScreen(state.activeScreen); });

  window.addEventListener("explora:session-opened", () => refreshDashboard());
  window.addEventListener("explora:auth-ready", () => refreshDashboard());
  window.addEventListener("explora:app-date-refresh", recalculateForOperationalDate);
  window.addEventListener("explora:operational-date-changed", recalculateForOperationalDate);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshDashboard(); });
  window.addEventListener("explora:auth-cleared", () => {
    state.contextGeneration++;
    state.dashboardGeneration++;
    state.context = null;
    state.inFlight.clear();
    state.messages.clear();
    document.querySelectorAll(".vehicle-detail-screen.is-open").forEach(closeScreen);
    state.renderTarget = null;
    state.adminProfiles = [];
    state.adminHost = null;
    setDashboardPending();
  });

  document.documentElement.dataset.miAutoModule = MI_AUTO_MODULE_VERSION;
  applyDashboardState();
  queueMicrotask(() => refreshDashboard());

  window.ExploraActions = window.ExploraActions || {};
  window.ExploraActions["mi-auto"] = openMiAutoByRole;

  window.ExploraVehicleDashboard = Object.freeze({
    version:MI_AUTO_MODULE_VERSION,
    complianceVersion:VEHICLE_COMPLIANCE_VERSION,
    showVehicle,
    mountAdminEditor,
    selectAdminDriver,
    showIncidents:() => window.ExploraDriverIncidents?.show?.(),
    refreshDashboard,
    applyDashboardState:() => applyDashboardState(),
    close:() => state.activeScreen && closeScreen(state.activeScreen),
    ensureFirebase:ensureFirebaseContext
  });
}
