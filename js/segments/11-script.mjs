
    import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
    import { initializeAuth, getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
    import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, getDocs, query, where, limit, serverTimestamp, runTransaction, writeBatch, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
    import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
    import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
    import { calculateSettlement as calculateCanonicalWeeklySettlement, weeklyPeriodFromDate as canonicalWeeklyPeriodFromDate, previousWeeklyPeriod as canonicalPreviousWeeklyPeriod, exploreLoanLookbackFromPeriod, EXPLORE_LOAN_LOOKBACK_WEEKS, EXPLORE_LOAN_MAX_INSTALLMENTS, EXPLORE_LOAN_MAX_AMOUNT_RATE, previewLoanInstallment } from "../core/weekly-core.mjs?v2442-weekly-payment-production";

    const EXPLORA_FIREBASE_CONFIG = {
apiKey: "AIzaSyDbTWF8fVVMMk2b8eWYv_0mHSl-AQmW2qs",
  authDomain: "explora-control-operativo.firebaseapp.com",
  projectId: "explora-control-operativo",
  storageBucket: "explora-control-operativo.firebasestorage.app",
  messagingSenderId: "708368554540",
  appId: "1:708368554540:web:05871472b575484bc98f89"
};

    const app = getApps().length ? getApp() : initializeApp(EXPLORA_FIREBASE_CONFIG);
    let auth;
    try {
      auth = initializeAuth(app, {
        persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence]
      });
    } catch (error) {
      // Otro módulo puede haber inicializado Auth primero. En ese caso se reutiliza
      // exactamente la misma instancia, sin cambiar ni reiniciar su persistencia.
      auth = getAuth(app);
    }
    const db = getFirestore(app);
    const storage = getStorage(app);
    const functions = getFunctions(app, "southamerica-east1");

    const persistenceReadyPromise = (typeof auth.authStateReady === "function"
      ? auth.authStateReady()
      : Promise.resolve()
    ).catch((error) => {
      console.warn("[EXPLORA login] persistence:error", error && error.code ? error.code : "unknown");
    });


    const EXPLORA_ADMIN_UIDS = new Set([
      "2LziyTTdFcZzSOhK3hLbAKs2U4s2"
    ]);

    const exploraAccessState = {
      user: null,
      uid: null,
      profile: null,
      role: null,
      isAdmin: false,
      vehicle: null
    };

    function resetExploraAccessState() {
      window.ExploraDerivations?.stopSession?.();
      exploraAccessState.user = null;
      exploraAccessState.uid = null;
      exploraAccessState.profile = null;
      exploraAccessState.role = null;
      exploraAccessState.isAdmin = false;
      exploraAccessState.vehicle = null;
      exploraSession.authUser = null;
      exploraSession.driverId = "";
      exploraSession.profileDocumentId = "";
      exploraSession.profileCollection = "";
      exploraSession.profileRef = null;
      exploraSession.profile = null;
      exploraSession.role = null;
      exploraSession.initialized = false;
      exploraSession.vehicle = null;
      exploraSession.vehicleId = "";
    }

    function clearAuthenticatedUI() {
      document.body.classList.remove("explora-admin-authenticated", "explora-authenticated", "explora-role-blocked", "explora-shared-admin");
      closeAdminSharedModule?.();
      closeAdminReceiptViewer?.();
      clearAdminSharedData?.();
      closeAdminCreateDriverModal?.();
      closeAdminCreateVehicleModal?.();
      closeVehicleDiagnostic?.();
      clearDriverVisuals?.();
    }

    async function getTokenClaimsSafe(user) {
      try {
        const tokenResult = await user.getIdTokenResult(true);
        return tokenResult && tokenResult.claims ? tokenResult.claims : {};
      } catch (_) {
        return {};
      }
    }

    async function getProtectedAdminRecord(user) {
      if (!user) return null;
      const refs = [
        doc(db, "administradores", user.uid),
        doc(db, "admins", user.uid),
        doc(db, "usuarios", user.uid)
      ];

      for (const ref of refs) {
        try {
          const snap = await getDoc(ref);
          if (snap.exists()) {
            const data = snap.data() || {};
            const role = String(data.rol || data.role || data.tipo || "").toLowerCase();
            const active = !(data.activo === false || data.active === false || data.estado === "inactivo");
            if (active && ["admin", "administrador", "owner"].includes(role)) {
              return { id: snap.id, ref, data, collectionName: ref.parent.id };
            }
          }
        } catch (_) {}
      }
      return null;
    }

    async function resolveAuthenticatedAccess(user) {
      if (!user) throw new Error("ACCESS_NO_USER");

      const aliasInfo = await getAuthenticatedLoginAlias(user).catch(() => null);
      const aliasData = aliasInfo ? {
        username: aliasInfo.username,
        email: aliasInfo.email,
        authEmail: aliasInfo.email,
        uid: aliasInfo.uid,
        role: aliasInfo.role,
        profileId: aliasInfo.profileId || aliasInfo.driverId || aliasInfo.choferId || aliasInfo.userDocId || ""
      } : {};

      const accessProfile = await loadAuthenticatedAccessProfile(user, aliasData);

      if (accessProfile.role === "admin") {
        if (!EXPLORA_ADMIN_UIDS.has(user.uid)) throw new Error("ACCESS_ADMIN_NOT_ALLOWED");
        return {
          access: "admin",
          isAdmin: true,
          role: "admin",
          profile: {
            id: accessProfile.documentId,
            ref: accessProfile.ref,
            data: accessProfile.profile,
            collectionName: accessProfile.collectionName
          }
        };
      }

      if (accessProfile.role === "chofer") {
        return {
          access: "chofer",
          isAdmin: false,
          role: "chofer",
          profile: {
            id: accessProfile.documentId,
            ref: accessProfile.ref,
            data: accessProfile.profile,
            collectionName: accessProfile.collectionName
          }
        };
      }

      throw new Error("ACCESS_INVALID_ROLE");
    }

    async function assertCurrentAdminAccess() {
      const user = auth.currentUser;
      if (!user || !exploraAccessState.isAdmin || !EXPLORA_ADMIN_UIDS.has(user.uid)) {
        throw new Error("ADMIN_ACCESS_DENIED");
      }
      return true;
    }


    const EXPLORA_SESSION_PREFIX = "explora_sesion_nueva_";
    const EXPLORA_ALLOWED_SCREENS = new Set(["dashboard","operaciones","nuevo-servicio","derivaciones","cargar-gasto","comprobantes","perfil"]);
    const MIN_SPLASH_MS = 420;
    const MAX_SPLASH_MS = 1000;
    const AUTH_RESTORE_GRACE_MS = 12000;
    const splashStartedAt = Date.now();
    let splashHidden = false;
    let authHandledOnce = false;

    const exploraSession = {
      authUser: null,
      profile: null,
      driverId: "",
      profileDocumentId: "",
      profileCollection: "",
      profileRef: null,
      vehicle: null,
      vehicleId: "",
      role: null,
      initialized: false,
      authReady: false,
      generation: 0,
      closing: false,
      openedAt: 0
    };

    window.ExploraSession = exploraSession;
    window.ExploraFirebase = { app, auth, db, storage, functions, httpsCallable };
    const createMercadoPagoDynamicQrCallable = httpsCallable(functions, "createMercadoPagoDynamicQr");
    const cancelMercadoPagoDynamicQrCallable = httpsCallable(functions, "cancelMercadoPagoDynamicQr");
    window.ExploraPayments = {
      async createDynamicQr(payload) { const response = await createMercadoPagoDynamicQrCallable(payload); return response?.data || {}; },
      async cancelDynamicQr(payload) { const response = await cancelMercadoPagoDynamicQrCallable(payload); return response?.data || {}; },
      subscribeOperation(operationId, onValue, onError) {
        const safeId = String(operationId || "").replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeId) throw new Error("PAYMENT_OPERATION_ID_INVALID");
        return onSnapshot(doc(db, "payment_operations", safeId), (snapshot) => onValue?.(snapshot.exists() ? { id:snapshot.id, ...snapshot.data() } : { id:safeId, status:"draft" }), onError);
      }
    };

    let authenticatedSessionWaitPromise = null;
    let sessionProfileRecoveryPromise = null;

    async function waitForAuthenticatedUser(timeoutMs = 4000) {
      if (auth.currentUser?.uid) return auth.currentUser;
      if (authenticatedSessionWaitPromise) return authenticatedSessionWaitPromise;
      authenticatedSessionWaitPromise = new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          if (auth.currentUser?.uid) return resolve(auth.currentUser);
          if (Date.now() - started >= timeoutMs) return reject(new Error("AUTH_SESSION_TIMEOUT"));
          setTimeout(tick, 40);
        };
        tick();
      }).finally(() => { authenticatedSessionWaitPromise = null; });
      return authenticatedSessionWaitPromise;
    }

    async function getAuthenticatedSession(options = {}) {
      const timeoutMs = Math.max(1200, Number(options.timeoutMs || 5000));
      const user = auth.currentUser?.uid ? auth.currentUser : await waitForAuthenticatedUser(timeoutMs);
      if (!user?.uid) throw new Error("AUTH_SESSION_MISSING");

      if (activeSessionOpenPromise && activeSessionUid === user.uid) {
        await profileWithTimeout(activeSessionOpenPromise, timeoutMs, "SESSION_PROFILE_TIMEOUT").catch(() => {});
      }

      if ((!exploraSession.profile || !exploraSession.profileRef || !exploraSession.profileDocumentId) && typeof loadLegacyExploraProfile === "function") {
        if (!sessionProfileRecoveryPromise) {
          sessionProfileRecoveryPromise = profileWithTimeout(loadLegacyExploraProfile(user), timeoutMs, "SESSION_PROFILE_TIMEOUT")
            .then((loaded) => {
              exploraSession.authUser = user;
              exploraSession.profile = loaded.profile || {};
              exploraSession.driverId = loaded.profileDocumentId || "";
              exploraSession.profileDocumentId = loaded.profileDocumentId || "";
              exploraSession.profileCollection = loaded.collectionName || loaded.profileRef?.parent?.id || EXPLORA_LEGACY_PROFILE_COLLECTION;
              exploraSession.profileRef = loaded.profileRef || null;
              exploraSession.role = loaded.role || exploraSession.role || null;
              exploraSession.initialized = Boolean(exploraSession.profileRef && exploraSession.profileDocumentId && exploraSession.profileCollection);
              return loaded;
            })
            .finally(() => { sessionProfileRecoveryPromise = null; });
        }
        await sessionProfileRecoveryPromise;
      } else if (!exploraSession.authUser || exploraSession.authUser.uid !== user.uid) {
        exploraSession.authUser = user;
      }

      return {
        user,
        uid: user.uid,
        profile: exploraSession.profile || null,
        profileDocumentId: exploraSession.profileDocumentId || exploraSession.driverId || "",
        profileCollection: exploraSession.profileCollection || exploraSession.profileRef?.parent?.id || "",
        profileRef: exploraSession.profileRef || null,
        role: exploraSession.role || null,
        initialized: Boolean(exploraSession.initialized)
      };
    }
    window.ExploraGetAuthenticatedSession = getAuthenticatedSession;

    const $ = (id) => document.getElementById(id);

    const DEFAULT_AVATAR_SVG = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#303030"/><stop offset="1" stop-color="#080808"/></linearGradient></defs>
        <rect width="200" height="200" fill="url(#g)"/>
        <circle cx="100" cy="78" r="34" fill="#d4af37" opacity=".88"/>
        <path d="M42 172c8-38 33-58 58-58s50 20 58 58" fill="#d4af37" opacity=".80"/>
      </svg>
    `);
    const EXPLORA_HEADER_LOGO_SRC = "icons/explora-logo-real-mark-v3911.png";

    function setHeaderExploraLogo() {
      const image = $("dashboardProfileAvatar");
      if (!image) return;
      image.src = EXPLORA_HEADER_LOGO_SRC;
      image.alt = "Logo EXPLORA";
      image.setAttribute("aria-label", "Logo EXPLORA");
    }


    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async function hideSplashSafely() {
      splashHidden = true;
      document.body.classList.add("explora-splash-hidden");
      const splash = $("exploraSplash");
      if (splash) {
        splash.setAttribute("aria-hidden", "true");
        splash.style.pointerEvents = "none";
      }
    }

    const splashSyncState = {
      progress: 0,
      visualProgress: 0,
      targetProgress: 0,
      raf: 0,
      startedAt: 0,
      lastFrameAt: 0,
      active: false,
      detail: "",
      finishing: false,
      finishResolve: null
    };

    function paintSplashSyncProgress(progress = 0, title = "Cargando EXPLORA", detail = "Actualizando información…") {
      const safeProgress = Math.max(0, Math.min(100, Number(progress || 0)));
      splashSyncState.visualProgress = safeProgress;
      const titleElement = $("exploraSyncTitle");
      const detailElement = $("exploraSyncDetail");
      const ringElement = $("exploraSyncRing");
      if (titleElement) titleElement.textContent = title || "Cargando EXPLORA";
      if (detailElement) detailElement.textContent = detail || "Actualizando información…";
      if (ringElement) ringElement.style.setProperty("--sync-angle", `${(safeProgress * 3.6).toFixed(3)}deg`);
    }

    function stopSplashSyncAnimation() {
      if (splashSyncState.raf) cancelAnimationFrame(splashSyncState.raf);
      splashSyncState.raf = 0;
      splashSyncState.lastFrameAt = 0;
    }

    function runSplashSyncAnimation(now = performance.now()) {
      if (!splashSyncState.active) {
        splashSyncState.raf = 0;
        return;
      }
      const previous = splashSyncState.lastFrameAt || now;
      const dt = Math.min(48, Math.max(0, now - previous));
      splashSyncState.lastFrameAt = now;
      const elapsed = Math.max(0, now - (splashSyncState.startedAt || now));

      // Mientras Firestore sigue trabajando, el aro avanza siempre de forma continua.
      // Los hitos reales de sincronización solo aceleran el avance; nunca producen saltos visuales.
      const timeFloor = Math.min(96.8, 4 + 92.8 * (1 - Math.exp(-elapsed / 4200)));
      const requestedFloor = Math.min(97.2, Number(splashSyncState.targetProgress || 0));
      const desired = splashSyncState.finishing ? 100 : Math.max(timeFloor, requestedFloor);
      const current = Number(splashSyncState.visualProgress || 0);
      const gap = Math.max(0, desired - current);
      let next = current;

      if (splashSyncState.finishing) {
        // Al confirmarse la sincronización real, completa únicamente el pequeño tramo restante.
        next = Math.min(100, current + Math.max(0.55, gap * 0.22));
      } else if (gap > 0.001) {
        // Interpolación dependiente del tiempo: suave incluso en pantallas de 60/120 Hz.
        const blend = 1 - Math.exp(-dt / 260);
        next = current + gap * blend;
      } else {
        // Nunca queda visualmente congelado mientras todavía se sincroniza.
        next = Math.min(97.2, current + (dt * 0.0018));
      }

      splashSyncState.progress = Math.max(splashSyncState.progress || 0, next);
      paintSplashSyncProgress(next, "Cargando EXPLORA", splashSyncState.detail);

      if (splashSyncState.finishing && next >= 99.94) {
        splashSyncState.progress = 100;
        paintSplashSyncProgress(100, "Cargando EXPLORA", "Información actualizada. Abriendo EXPLORA…");
        const resolve = splashSyncState.finishResolve;
        splashSyncState.finishResolve = null;
        splashSyncState.raf = 0;
        if (resolve) resolve();
        return;
      }
      splashSyncState.raf = requestAnimationFrame(runSplashSyncAnimation);
    }

    function setSplashSyncProgress(progress = 0, title = "Cargando EXPLORA", detail = "Actualizando información…") {
      const safeProgress = Math.max(0, Math.min(100, Number(progress || 0)));
      splashSyncState.targetProgress = Math.max(splashSyncState.targetProgress || 0, safeProgress);
      splashSyncState.detail = detail || splashSyncState.detail || "Actualizando información…";
      const titleElement = $("exploraSyncTitle");
      const detailElement = $("exploraSyncDetail");
      if (titleElement) titleElement.textContent = title || "Cargando EXPLORA";
      if (detailElement) detailElement.textContent = splashSyncState.detail;
      if (splashSyncState.active && !splashSyncState.raf) splashSyncState.raf = requestAnimationFrame(runSplashSyncAnimation);
    }

    function beginSplashSync(detail = "Actualizando información…") {
      // v4125: una apertura de sesión = una sola animación. Si el splash ya está
      // trabajando para esta apertura, solo actualizamos el texto y jamás volvemos a 0°.
      if (splashSyncState.active && !splashHidden) {
        splashSyncState.detail = detail || splashSyncState.detail || "Actualizando información…";
        const detailElement = $("exploraSyncDetail");
        if (detailElement) detailElement.textContent = splashSyncState.detail;
        if (!splashSyncState.raf) splashSyncState.raf = requestAnimationFrame(runSplashSyncAnimation);
        return;
      }
      splashHidden = false;
      stopSplashSyncAnimation();
      splashSyncState.active = true;
      splashSyncState.finishing = false;
      splashSyncState.progress = 0;
      splashSyncState.visualProgress = 0;
      splashSyncState.targetProgress = 0;
      splashSyncState.startedAt = performance.now();
      splashSyncState.detail = detail || "Actualizando información…";
      splashSyncState.finishResolve = null;
      const splash = $("exploraSplash");
      if (splash) { splash.setAttribute("aria-hidden", "false"); splash.style.pointerEvents = "auto"; }
      document.body.classList.remove("explora-splash-hidden");
      paintSplashSyncProgress(0, "Cargando EXPLORA", splashSyncState.detail);
      splashSyncState.raf = requestAnimationFrame(runSplashSyncAnimation);
    }

    async function finishSplashSync() {
      if (splashHidden) return;
      if (splashSyncState.finishing) return;
      splashSyncState.finishing = true;
      splashSyncState.active = true;
      splashSyncState.targetProgress = 100;
      splashSyncState.detail = "Información actualizada. Abriendo EXPLORA…";
      if (!splashSyncState.raf) splashSyncState.raf = requestAnimationFrame(runSplashSyncAnimation);
      await new Promise(resolve => { splashSyncState.finishResolve = resolve; });
      splashSyncState.active = false;
      splashSyncState.finishing = false;
      stopSplashSyncAnimation();
      return hideSplashSafely();
    }

    function updateSplashSync(progress, detail, title = "Cargando EXPLORA") {
      splashSyncState.detail = detail || splashSyncState.detail || "Actualizando información…";
      if (!splashSyncState.active) beginSplashSync(splashSyncState.detail);
      setSplashSyncProgress(progress, title, splashSyncState.detail);
    }

    function finishSplash() { return finishSplashSync(); }

    function setBodyMode(mode) {
      document.body.classList.remove("explora-auth-checking","explora-login-visible","explora-authenticated","explora-role-blocked","explora-admin-authenticated");
      if (mode !== "explora-authenticated") document.body.classList.remove("explora-shared-admin");
      document.body.classList.add(mode);
    }

    function loginMsg(text) {
      const el = $("exploraLoginMsg");
      if (el) el.textContent = text || "";
    }

    function friendlyAuthError(error) {
      const code = String(error && error.code || "");
      if (code.includes("invalid-credential") || code.includes("wrong-password")) return "Correo o contraseña incorrectos.";
      if (code.includes("user-not-found")) return "No existe un usuario con ese correo.";
      if (code.includes("too-many-requests")) return "Demasiados intentos. Esperá unos minutos y volvé a probar.";
      if (code.includes("network")) return "Sin conexión. Revisá internet e intentá nuevamente.";
      if (code.includes("user-disabled")) return "Este usuario está desactivado.";
      return "No se pudo ingresar. Revisá los datos e intentá nuevamente.";
    }

    function normalizedEmailUser(user) {
      const email = String(user && user.email || "").trim().toLowerCase();
      return email ? email.split("@")[0].trim().toLowerCase() : "";
    }

    function getProfileName(data = {}, user = exploraSession.authUser) {
      return data.nombre || data.nombreCompleto || data.displayName || data.name || (user && user.displayName) || exploraSession.driverId || "Chofer";
    }

    function getProfilePhone(data = {}) {
      return data.telefono || data.phone || data.celular || "";
    }

    function getProfileAvatarUrl(data = {}, user = exploraSession.authUser) {
      return data.avatarUrl || data.avatar || data.fotoPerfil || data.foto || data.photoURL || (user && user.photoURL) || "";
    }

    function getRole(data = {}) {
      return String(data.rol || data.role || data.tipoUsuario || data.tipo || "chofer").trim().toLowerCase();
    }

    function isInactiveProfile(data = {}) {
      return data.activo === false || data.active === false || data.estado === "inactivo" || data.habilitado === false;
    }

    async function findDriverProfile(user) {
      if (!user) throw new Error("No hay usuario autenticado.");
      const email = String(user.email || "").trim().toLowerCase();
      const username = normalizedEmailUser(user);
      const candidates = Array.from(new Set([user.uid, username, email].filter(Boolean)));

      for (const id of candidates) {
        const ref = doc(db, "choferes", id);
        const snap = await getDoc(ref).catch(() => null);
        if (snap && snap.exists()) return { id: snap.id, ref, data: snap.data() || {} };
      }

      const qUid = await getDocs(query(collection(db,"choferes"), where("uid","==",user.uid))).catch(() => null);
      if (qUid && !qUid.empty) {
        const snap = qUid.docs[0];
        return { id: snap.id, ref: doc(db,"choferes",snap.id), data: snap.data() || {} };
      }

      if (email) {
        const qEmail = await getDocs(query(collection(db,"choferes"), where("email","==",email))).catch(() => null);
        if (qEmail && !qEmail.empty) {
          const snap = qEmail.docs[0];
          return { id: snap.id, ref: doc(db,"choferes",snap.id), data: snap.data() || {} };
        }
      }

      const all = await getDocs(collection(db, "choferes"));
      let found = null;
      all.forEach((snap) => {
        if (found) return;
        const data = snap.data() || {};
        const values = [
          snap.id, data.nombre, data.nombreCompleto, data.usuario, data.email,
          data.authUid, data.uid, data.choferId
        ].map(v => String(v || "").trim().toLowerCase());
        if (values.includes(username) || values.includes(email) || values.includes(String(user.uid).toLowerCase())) {
          found = { id: snap.id, ref: doc(db,"choferes",snap.id), data };
        }
      });
      if (!found) throw new Error("Tu usuario no tiene perfil de chofer creado en EXPLORA.");
      return found;
    }

    async function loadDriverVehicle(profile = {}, driverId = "") {
      const possibleIds = [
        profile.assignedVehicleId, profile.vehicleId, profile.vehiculoId, profile.autoId,
        profile.vehiculoAsignado, profile.vehiculo, profile.patente, profile.matricula
      ].map(v => String(v || "").trim()).filter(Boolean);

      for (const id of [...new Set(possibleIds)]) {
        const snap = await getDoc(doc(db,"vehiculos",id)).catch(() => null);
        if (snap && snap.exists()) return { id: snap.id, ...snap.data() };
      }

      const identities = [...new Set([
        auth.currentUser?.uid, profile.uid, profile.authUid, profile.firebaseUid,
        driverId, profile.usuario, profile.username, getProfileName(profile, auth.currentUser)
      ].map(value => String(value || "").trim()).filter(Boolean))];
      const fields = ["currentDriverUid","currentDriverName","choferId","conductorId","driverId","asignadoA","chofer","uidChofer"];
      for (const field of fields) {
        for (const identity of identities) {
          const qv = await getDocs(query(collection(db,"vehiculos"), where(field,"==",identity), limit(1))).catch(() => null);
          if (qv && !qv.empty) {
            const snap = qv.docs[0];
            return { id: snap.id, ...snap.data() };
          }
        }
      }

      return null;
    }

    function resolveAssignedVehicle(profile = {}, vehicle = exploraSession.vehicle) {
      const source = vehicle && typeof vehicle === "object" ? vehicle : {};
      const driverName = String(getProfileName(profile, exploraSession.authUser) || "").trim().toLowerCase();
      const username = String(profile.usuario || profile.username || exploraSession.driverId || "").trim().toLowerCase();
      const clean = (value) => String(value || "").trim().replace(/\s+/g, " ");
      const isDriverIdentity = (value) => {
        const normalized = clean(value).toLowerCase();
        return Boolean(normalized && (normalized === driverName || normalized === username));
      };

      let brand = clean(source.marca || source.brand || profile.marcaVehiculo || profile.vehiculoMarca || profile.autoMarca);
      let model = clean(source.model || source.modelo || source.marcaModelo || source.nombre || source.tipoVehiculo || source.tipo || profile.assignedVehicleModel || profile.modeloVehiculo || profile.vehiculoModelo || profile.autoModelo || profile.marcaModelo);
      let plate = clean(source.plate || source.plateNormalized || source.patente || source.matricula || source.dominio || profile.assignedVehiclePlate || profile.patenteVehiculo || profile.vehiculoPatente || profile.autoPatente || profile.patente || profile.matricula).toUpperCase();

      if (isDriverIdentity(brand)) brand = "";
      if (isDriverIdentity(model)) model = "";
      if (isDriverIdentity(plate)) plate = "";

      const modelName = model && brand && model.toLowerCase().startsWith(brand.toLowerCase())
        ? model
        : [brand, model].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      const assigned = Boolean(modelName || plate || profile.assignedVehicleId || source.vehicleId || source.id);
      return {
        assigned,
        brand,
        model,
        modelName: modelName || (assigned ? "Vehículo asignado" : ""),
        plate,
        vehicleId: String(source.vehicleId || source.id || profile.assignedVehicleId || profile.vehicleId || "").trim(),
        displayName: assigned ? [modelName || "Vehículo asignado", plate].filter(Boolean).join(" · ") : "Vehículo no asignado"
      };
    }

    function vehicleLabel(vehicle, profile = exploraSession.profile || {}) {
      return resolveAssignedVehicle(profile, vehicle).displayName;
    }

    function greetingByHour(date = (window.ExploraOperationalClock?.getNow?.() || new Date())) {
      const hour = Number(new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Cordoba",
        hour: "2-digit",
        hour12: false
      }).format(date));
      if (hour < 12) return "Buenos días";
      if (hour < 20) return "Buenas tardes";
      return "Buenas noches";
    }

    function formatArgentinaLongDate(date = (window.ExploraOperationalClock?.getNow?.() || new Date())) {
      return new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Cordoba",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      }).format(date).replace(/^\w/, c => c.toUpperCase());
    }

    function firstNameOf(name) {
      return String(name || "Chofer").trim().split(/\s+/)[0] || "Chofer";
    }

    function profileVehicleLabel(vehicle, profile = exploraSession.profile || {}) {
      return resolveAssignedVehicle(profile, vehicle).displayName;
    }

    function renderDriverHeader(profile = {}, vehicle = exploraSession.vehicle) {
      const user = exploraSession.authUser;
      const name = getProfileName(profile, user);
      const role = getRole(profile) === "admin" ? "Administrador" : "Chofer Premium";
      const avatar = getProfileAvatarUrl(profile, user) || DEFAULT_AVATAR_SVG;
      const assignedVehicle = resolveAssignedVehicle(profile, vehicle);

      const dashName = $("dashboardProfileName");
      const dashRole = $("dashboardProfileRole");
      const dashAvatar = $("dashboardProfileAvatar");
      const greetingName = $("driverGreetingName");
      const greetingDate = $("driverGreetingDate");
      const greetingVehicle = $("driverGreetingVehicle");

      if (dashName) dashName.textContent = name;
      if (dashRole) dashRole.textContent = role;
      if (dashAvatar) setHeaderExploraLogo();
      if (greetingName) greetingName.textContent = `¡${greetingByHour()}, ${firstNameOf(name)}!`;
      if (greetingDate) greetingDate.textContent = formatArgentinaLongDate();
      if (greetingVehicle) greetingVehicle.textContent = assignedVehicle.assigned
        ? `Vehículo: ${assignedVehicle.displayName}`
        : "Vehículo no asignado";
      return assignedVehicle;
    }

    function renderProfileVehicleAssignment(profile = exploraSession.profile || {}, vehicle = exploraSession.vehicle) {
      try {
        const assignedVehicle = resolveAssignedVehicle(profile, vehicle);
        const modelElement = $("profileVehicleText");
        const plateElement = $("profileVehiclePlateText");
        if (modelElement) modelElement.textContent = assignedVehicle.assigned ? assignedVehicle.modelName : "Vehículo no asignado";
        if (plateElement) {
          plateElement.textContent = assignedVehicle.plate ? `Patente: ${assignedVehicle.plate}` : "";
          plateElement.hidden = !assignedVehicle.plate;
        }
        return assignedVehicle;
      } catch (error) {
        window.ExploraVehicleManagement?.reportProfileRenderFailure?.(error, { driverUid: auth.currentUser?.uid || "" });
        const modelElement = $("profileVehicleText");
        const plateElement = $("profileVehiclePlateText");
        if (modelElement) modelElement.textContent = "Vehículo no asignado";
        if (plateElement) plateElement.hidden = true;
        return { assigned:false, modelName:"", plate:"", displayName:"Vehículo no asignado" };
      }
    }

    function applyDriverDataToUI() {
      const profile = exploraSession.profile || {};
      const user = exploraSession.authUser;
      const name = getProfileName(profile, user);
      const avatar = getProfileAvatarUrl(profile, user) || DEFAULT_AVATAR_SVG;
      const email = (user && user.email) || profile.email || "";
      const phone = getProfilePhone(profile);
      const vehicle = exploraSession.vehicle;

      const assignedVehicle = renderDriverHeader(profile, vehicle);

      const profileAvatar = $("profileAvatarPreview");
      const profileName = $("profileNameInput");
      const profilePhone = $("profilePhoneInput");
      const profileEmail = $("profileEmailInput");
      const profileDriverId = $("profileDriverIdText");
      const profileVehicle = $("profileVehicleText");

      if (profileAvatar) profileAvatar.src = avatar;
      [profileName,profilePhone,profileEmail].forEach(field=>{
        if(!field)return;
        field.readOnly=true;
        field.setAttribute("aria-readonly","true");
        field.tabIndex=-1;
      });
      if (profileName) profileName.value = name;
      if (profilePhone) profilePhone.value = phone;
      if (profileEmail) profileEmail.value = email;
      if (profileDriverId) profileDriverId.textContent = exploraSession.driverId || "—";
      if (profileVehicle) renderProfileVehicleAssignment(profile, vehicle);
      const saveButton=$("profileSaveBtn");
      if(saveButton){saveButton.disabled=saveButton.dataset.photoSelected!=="true";saveButton.textContent="Guardar foto";}
    }

    function clearDriverVisuals() {
      const dashName = $("dashboardProfileName");
      const dashRole = $("dashboardProfileRole");
      const dashAvatar = $("dashboardProfileAvatar");
      if (dashName) dashName.textContent = "Cargando perfil…";
      if (dashRole) dashRole.textContent = "Chofer";
      if (dashAvatar) setHeaderExploraLogo();
      const greetingName = $("driverGreetingName");
      const greetingDate = $("driverGreetingDate");
      const greetingVehicle = $("driverGreetingVehicle");
      if (greetingName) greetingName.textContent = "Cargando perfil…";
      if (greetingDate) greetingDate.textContent = formatArgentinaLongDate();
      if (greetingVehicle) greetingVehicle.textContent = "Vehículo no asignado";
      if (typeof renderDriverStatusCard === "function") renderDriverStatusCard({ status: "CLOSURE_LOADING" });
    }

    function showLogin(message = "", reason = "") {
      const persistentUser = auth.currentUser || authSessionState.authenticatedUser;
      if (persistentUser && !authSessionState.logoutInProgress) {
        loginDevDiagnostic("SHOW_LOGIN_BLOCKED", {
          reason: reason || "authenticated-session-present",
          uidMatches: !authSessionState.authenticatedUser || authSessionState.authenticatedUser.uid === persistentUser.uid,
          uiOpened: authSessionState.uiOpened
        });
        if (!authSessionState.uiOpened) {
          setBodyMode("explora-auth-checking");
          beginSplashSync("Restaurando sesión y cargando toda la información…");
        }
        return;
      }
      splashSyncState.active = false;
      if (splashSyncState.timer) { clearInterval(splashSyncState.timer); splashSyncState.timer = null; }
      clearDriverVisuals();
      setBodyMode("explora-login-visible");
      loginMsg(message);
      hideSplashSafely();
    }

    async function showDriverApp() {
      /* v4125: el dashboard se prepara detrás del splash, pero no se hace visible
         hasta que sincronización + aro de 360° hayan terminado por completo. */
      window.unlockAllPageScroll?.();
      authSessionState.authenticatedUser = exploraSession.authUser || auth.currentUser || null;
      authSessionState.profile = exploraSession.profile || null;
      authSessionState.role = "chofer";
      authSessionState.uiOpened = true;
      document.body.classList.remove("explora-shared-admin");
      renderDashboardByRole?.({ role: "chofer", profile: exploraSession.profile || {} });
      const weeklySnapshot = window.ExploraWeeklyEngine?.getState?.();
      if (weeklySnapshot?.loaded && !weeklySnapshot?.loading) window.ExploraFastCache?.renderWeeklySnapshot?.(weeklySnapshot);
      await finishSplashSync();
      setBodyMode("explora-authenticated");
      if (window.ExploraMainNav) window.ExploraMainNav.setActive("inicio");
      restoreLastDriverScreen();
      queueMicrotask(() => {
        window.ExploraDerivations?.startForCurrentSession?.().catch?.((error)=>console.warn("[EXPLORA derivaciones] start", error?.code || error?.message));
        if (typeof window.ExploraLoadWeeklySession === "function") {
          window.ExploraLoadWeeklySession().catch((error) => console.warn("[EXPLORA weekly session]", error?.code || error?.message));
        } else {
          window.ExploraWeeklyEngine?.loadOnce?.().catch((error) => console.warn("[EXPLORA weekly] start", error?.code || error?.message));
        }
      });
    }

    function showRoleBlocked() {
      setBodyMode("explora-role-blocked");
      finishSplashSync();
    }

    function saveVisualSession() {
      try {
        const data = {
          driverId: exploraSession.driverId,
          email: exploraSession.authUser && exploraSession.authUser.email,
          uid: exploraSession.authUser && exploraSession.authUser.uid,
          name: getProfileName(exploraSession.profile || {}),
          role: exploraSession.role,
          vehicle: resolveAssignedVehicle(exploraSession.profile || {}, exploraSession.vehicle).displayName,
          ts: Date.now()
        };
        localStorage.setItem(EXPLORA_SESSION_PREFIX + "last", JSON.stringify(data));
      } catch (_) {}
    }

    function readVisualSessionCache() {
      try {
        const cached = JSON.parse(localStorage.getItem(EXPLORA_SESSION_PREFIX + "last") || "{}");
        const age = Date.now() - Number(cached?.ts || 0);
        if (!cached?.uid || age < 0 || age > 1000 * 60 * 60 * 24 * 45) return null;
        return cached;
      } catch (_) {
        return null;
      }
    }

    function cachedSessionMatchesUser(cached, user) {
      return Boolean(cached?.uid && user?.uid && String(cached.uid) === String(user.uid));
    }

    function isCriticalAccessError(error) {
      const code = String(error && (error.message || error.code) || "").toUpperCase();
      return [
        "PROFILE_DISABLED",
        "PROFILE_ROLE_INVALID",
        "ACCESS_ADMIN_NOT_ALLOWED",
        "ACCESS_INVALID_ROLE",
        "ACCESS_NO_USER",
        "UID_MISMATCH",
        "PROFILE_DUPLICATE"
      ].some(token => code.includes(token));
    }

    function isRecoverableSessionError(error) {
      const code = String(error && (error.message || error.code) || "").toLowerCase();
      if (!code) return true;
      return !isCriticalAccessError(error) || [
        "profile_timeout",
        "login_timeout",
        "auth_timeout",
        "auth_session_timeout",
        "network",
        "unavailable",
        "deadline-exceeded",
        "internal",
        "offline",
        "failed-precondition"
      ].some(token => code.includes(token));
    }

    function openCachedAuthenticatedShell(user, reason = "") {
      const cached = readVisualSessionCache();
      if (!cachedSessionMatchesUser(cached, user)) return false;
      const role = String(cached.role || "chofer").toLowerCase().includes("admin") ? "admin" : "chofer";
      if (role === "admin" && !EXPLORA_ADMIN_UIDS.has(user.uid)) return false;
      const profile = {
        nombre: cached.name || (role === "admin" ? "David" : "Chofer"),
        displayName: cached.name || "",
        email: cached.email || user.email || "",
        role: role === "admin" ? "admin" : "driver",
        rol: role === "admin" ? "admin" : "chofer"
      };
      exploraSession.authUser = user;
      exploraSession.driverId = cached.driverId || user.uid || "";
      exploraSession.profileDocumentId = cached.driverId || user.uid || "";
      exploraSession.profileCollection = exploraSession.profileCollection || (role === "admin" ? "administradores" : "choferes");
      exploraSession.profile = profile;
      exploraSession.role = role;
      exploraSession.initialized = false;
      exploraSession.authReady = true;
      exploraSession.openedAt = Date.now();
      authSessionState.authenticatedUser = user;
      authSessionState.profile = profile;
      authSessionState.profileDocumentId = exploraSession.profileDocumentId;
      authSessionState.profileCollection = exploraSession.profileCollection;
      authSessionState.role = role;
      exploraAccessState.user = user;
      exploraAccessState.uid = user.uid;
      exploraAccessState.profile = profile;
      exploraAccessState.role = role;
      exploraAccessState.isAdmin = role === "admin";
      loginDevDiagnostic("SESSION_CACHED_SHELL_OPEN", { reason, role });
      try {
        if (role === "admin") showAdminApp();
        else showDriverApp();
        return true;
      } catch (error) {
        loginDevDiagnostic("SESSION_CACHED_SHELL_FAILED", { code: error && (error.message || error.code) || "unknown" });
        return false;
      }
    }

    function saveLastScreen(screen) {
      try {
        if (!EXPLORA_ALLOWED_SCREENS.has(screen)) return;
        localStorage.setItem(EXPLORA_SESSION_PREFIX + "last_screen", screen);
      } catch (_) {}
    }

    function restoreLastDriverScreen() {
      let screen = "dashboard";
      try {
        const cached = localStorage.getItem(EXPLORA_SESSION_PREFIX + "last_screen");
        if (cached && EXPLORA_ALLOWED_SCREENS.has(cached)) screen = cached;
      } catch (_) {}
      if (screen === "perfil" && window.ExploraActions && window.ExploraActions["abrir-perfil"]) window.ExploraActions["abrir-perfil"]();
      else if ((screen === "operaciones" || screen === "nuevo-servicio") && window.ExploraActions && window.ExploraActions["nuevo-servicio"]) window.ExploraActions["nuevo-servicio"]();
      else if (screen === "derivaciones" && window.ExploraActions && window.ExploraActions["derivar-servicio"]) window.ExploraActions["derivar-servicio"]();
      else if (screen === "cargar-gasto" && window.ExploraActions && window.ExploraActions["cargar-gastos"]) window.ExploraActions["cargar-gastos"]();
      else if (screen === "comprobantes" && window.ExploraReceipts && window.ExploraReceipts.open) window.ExploraReceipts.open();
      else if (window.ExploraMainNav) window.ExploraMainNav.setActive("inicio");
    }


    const EXPLORA_PERFORMANCE_COMPAT = {
      goals: [],
      validTripStates: new Set(["vendido","vendida","aceptado","aceptada","confirmado","confirmada","completado","completada","realizado","realizada","registrado","registrada","finalizado","finalizada","cerrado","cerrada"]),
      invalidStates: new Set(["cancelado","cancelada","rechazado","rechazada","eliminado","eliminada","borrador","prueba","test"]),
      current: null,
      loading: false
    };

    function getArgentinaParts(date = new Date()) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Argentina/Cordoba",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false
      }).formatToParts(date).reduce((acc, part) => {
        if (part.type !== "literal") acc[part.type] = Number(part.value);
        return acc;
      }, {});
      return parts;
    }

    function formatDateIdFromUTCDate(date) {
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}-${String(date.getUTCDate()).padStart(2,"0")}`;
    }

    function getWeeklyPeriodFromDate(date = new Date()) {
      const period = canonicalWeeklyPeriodFromDate(date, "America/Argentina/Cordoba");
      return {
        ...period,
        inicioTexto: period.startAt.toLocaleDateString("es-AR", { timeZone:"America/Argentina/Cordoba" }),
        finTexto: period.endAt.toLocaleDateString("es-AR", { timeZone:"America/Argentina/Cordoba" })
      };
    }

    function getActiveWeeklyPeriod(referenceDate = null) {
      if(!referenceDate){const central=window.ExploraOperationalClock?.getActiveWeeklyPeriod?.();if(central)return{...central,weeklyPeriodId:central.id,startAt:new Date(central.startMs),endAt:new Date(central.endMs),timezone:"America/Argentina/Cordoba"};}
      const period = getWeeklyPeriodFromDate(referenceDate||window.ExploraOperationalClock?.getNow?.()||new Date());
      return {...period,weeklyPeriodId:period.id,startAt:new Date(period.startMs),endAt:new Date(period.endMs),timezone:"America/Argentina/Cordoba"};
    }

    function getPreviousWeeklyPeriod(active = getActiveWeeklyPeriod()) {
      return canonicalPreviousWeeklyPeriod(active, "America/Argentina/Cordoba");
    }

    function normalizeStatus(value) {
      return String(value || "").trim().toLowerCase();
    }

    function isInvalidState(value) {
      const s = normalizeStatus(value);
      if (!s) return false;
      return EXPLORA_PERFORMANCE_COMPAT.invalidStates.has(s) || [...EXPLORA_PERFORMANCE_COMPAT.invalidStates].some(x => s.includes(x));
    }

    function isValidTripState(data = {}) {
      const s = normalizeStatus(data.estado || data.status || data.estadoViaje || data.estadoServicio);
      if (isInvalidState(s)) return false;
      if (!s) return true;
      return EXPLORA_PERFORMANCE_COMPAT.validTripStates.has(s) || [...EXPLORA_PERFORMANCE_COMPAT.validTripStates].some(x => s.includes(x));
    }

    function toNumberSafe(value) {
      if (typeof value === "number") return Number.isFinite(value) ? value : 0;
      if (typeof value === "string") {
        const n = Number(value.replace(/[^\d,-]/g, "").replace(/\./g, "").replace(",", "."));
        return Number.isFinite(n) ? n : 0;
      }
      return 0;
    }

    function getMoneyValue(data = {}) {
      return toNumberSafe(
        data.amount ?? data.valor ?? data.monto ?? data.finalAmount ?? data.montoFinal ?? data.precioFinal ??
        data.grossAmount ?? data.billingAmount ?? data.tarifaMinima ?? data.total ?? data.importe ?? data.precio ?? data.facturacion
      );
    }

    function resolveWeeklyExpenseTotals(source = {}) {
      const positive = value => Math.max(0, toNumberSafe(value));
      const explicitTotals = [source.totalExpenses, source.gastos, source.expenseTotal, source.totalGastos]
        .map(positive);
      const explicitDriver = Math.max(positive(source.driverPaidSharedExpenses), positive(source.driverPaidExpenses));
      const explicitAdmin = Math.max(positive(source.adminPaidSharedExpenses), positive(source.adminPaidExpenses));
      const splitTotal = explicitDriver + explicitAdmin;

      const sumRows = rows => {
        if (!Array.isArray(rows) || !rows.length) return { total:0, driver:0, admin:0 };
        const seen = new Set();
        let total = 0, driver = 0, admin = 0;
        rows.forEach((row, index) => {
          if (!row || typeof row !== "object") return;
          const id = String(row.operationId || row.operacionId || row.expenseId || row.gastoId || row.documentId || row.id || `row_${index}`).trim();
          if (seen.has(id)) return;
          seen.add(id);
          const amount = positive(getMoneyValue(row));
          if (!(amount > 0)) return;
          total += amount;
          if (normalizePayerRole(row, "driver") === "admin") admin += amount;
          else driver += amount;
        });
        return { total, driver, admin };
      };

      const rowCandidates = [source.expenses, source.expenseRows, source.gastosRows]
        .map(sumRows);
      const rowTotals = rowCandidates.reduce((best, current) => current.total > best.total ? current : best, { total:0, driver:0, admin:0 });
      const ledgerRows = Array.isArray(source.operationLedger)
        ? source.operationLedger.filter(row => String(row?.type || "").toLowerCase() === "expense")
        : [];
      const ledgerTotals = sumRows(ledgerRows);

      const total = Math.max(0, ...explicitTotals, splitTotal, rowTotals.total, ledgerTotals.total);
      let driverPaid = Math.max(explicitDriver, rowTotals.driver, ledgerTotals.driver);
      let adminPaid = Math.max(explicitAdmin, rowTotals.admin, ledgerTotals.admin);
      const knownSplit = driverPaid + adminPaid;
      if (total > knownSplit + 0.01) driverPaid += total - knownSplit;
      if (driverPaid + adminPaid > total + 0.01) {
        const scale = total > 0 ? total / (driverPaid + adminPaid) : 0;
        driverPaid *= scale;
        adminPaid *= scale;
      }
      return Object.freeze({ total:Math.round(total), driverPaid:Math.round(driverPaid), adminPaid:Math.round(adminPaid) });
    }
    window.ExploraResolveWeeklyExpenseTotals = resolveWeeklyExpenseTotals;

    function getDriverIdFromTrip(data = {}) {
      return String(data.choferId || data.chofer || data.driverId || data.driverUid || data.conductorId || data.choferUid || data.uid || data.usuario || "").trim();
    }

    function getServiceOperationId(data = {}, fallback = "") {
      return String(
        data.operationId || data.operacionId || data.billingId || data.registroId || data.viajeId ||
        data.documentId || fallback || data.id || ""
      ).trim();
    }

    function getDocTimeMs(data = {}) {
      const candidates = [
        data.paymentDate, data.expenseDate, data.serviceDate, data.simulatedAt, data.sourceCreatedAt,
        data.creadoEn, data.creado, data.createdAt, data.fechaTimestamp,
        data.fechaCreacion, data.fechaServidor, data.updatedAt, data.actualizadoEn
      ];
      for (const c of candidates) {
        if (!c) continue;
        if (typeof c.toDate === "function") return c.toDate().getTime();
        if (c instanceof Date) return c.getTime();
        if (typeof c === "number") return c;
      }
      const f = data.fechaISO || data.fecha || data.date;
      if (f) {
        const parsed = new Date(String(f).includes("T") ? f : `${f}T12:00:00-03:00`);
        if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
      }
      return 0;
    }

    function getRecordWeeklyPeriodId(data = {}) {
      return String(
        data.periodoSemanalId || data.weeklyPeriodId || data.periodoId ||
        data.periodId || data.semanaId || ""
      ).trim();
    }

    function docBelongsToPeriod(data = {}, period) {
      const pid = getRecordWeeklyPeriodId(data);
      if (pid) return pid === period.id;
      const ms = getDocTimeMs(data);
      return ms >= period.startMs && ms <= period.endMs;
    }

    function weeklyPeriodForRecord(data = {}, fallbackPeriod = null) {
      const explicitId = getRecordWeeklyPeriodId(data);
      const active = getActiveWeeklyPeriod();
      if (explicitId) {
        if (String(active.id || "") === explicitId) return active;
        const parsed = new Date(`${explicitId.slice(0,10)}T12:00:00-03:00`);
        if (Number.isFinite(parsed.getTime())) {
          const resolved = getWeeklyPeriodFromDate(parsed);
          if (String(resolved.id || "") === explicitId) return resolved;
        }
      }
      if (fallbackPeriod?.id && (!explicitId || String(fallbackPeriod.id) === explicitId)) return fallbackPeriod;
      return active;
    }

    async function getPeriodDocs(collectionName, period, options = {}) {
      const merged = new Map();
      const periodFields = options.periodFields || ["periodoSemanalId", "weeklyPeriodId", "periodoId"];
      const attempts = await Promise.allSettled(periodFields.map((field) =>
        getDocs(query(collection(db, collectionName), where(field, "==", period.id)))
      ));
      let lastError = null;
      let successfulQueries = 0;
      attempts.forEach((result) => {
        if (result.status !== "fulfilled") { lastError = lastError || result.reason; return; }
        successfulQueries += 1;
        result.value.forEach((d) => {
          const raw = d.data() || {};
          const row = { ...raw, id: raw.id || d.id, documentId: d.id };
          if (docBelongsToPeriod(row, period)) merged.set(d.id, row);
        });
      });
      if (merged.size || options.allowLegacyScan === false) {
        if (!successfulQueries && options.throwOnError && lastError) throw lastError;
        return Array.from(merged.values());
      }

      // Compatibilidad histórica excepcional. No se ejecuta cuando existe snapshot materializado.
      if (options.allowLegacyScan === true) {
        try {
          const snap = await getDocs(collection(db, collectionName));
          successfulQueries += 1;
          snap.forEach((d) => {
            const raw = d.data() || {};
            const row = { ...raw, id: raw.id || d.id, documentId: d.id };
            if (docBelongsToPeriod(row, period)) merged.set(d.id, row);
          });
        } catch (error) { if (!lastError) lastError = error; }
      }
      if (!successfulQueries && options.throwOnError && lastError) throw lastError;
      return Array.from(merged.values());
    }

    function weeklyScopedQueryRequests(collectionName = "", uid = "") {
      const name=String(collectionName||"").toLowerCase();
      const authUid=String(uid||"").trim();
      const profileIds=String(uid||"")===String(auth.currentUser?.uid||"")
        ? currentWeeklyProfileAliases()
        : [];
      const ids=[...new Set(profileIds.map(value=>String(value||"").trim()).filter(Boolean))];
      const requests=[];
      const add=(fields,values)=>fields.forEach(field=>values.forEach(value=>requests.push({field,value})));
      if(name==="derivaciones"){
        add(["emisorUid","receptorUid","senderUid","receiverUid","derivadorUid","choferReceptorUid"],[authUid]);
        add(["choferOrigenId","choferReceptorId","emisorId","receptorId"],ids);
      }else if(name==="gastos"){
        add(["driverUid","choferUid","uid","ownerUid"],[authUid]);
        add(["choferId","driverId"],ids);
      }else if(name===OPERATIONAL_LOAN_COLLECTION){
        add(["driverUid","choferUid","uid"],[authUid]);
        add(["choferId","driverId"],ids);
      }else{
        add(["driverUid","choferUid","uid","userId","usuarioUid"],[authUid]);
        add(["choferId","driverId","profileDocumentId","usuario","chofer","choferNombre","nombreChofer","driverName"],ids);
      }
      const unique=new Map();
      requests.filter(item=>item.value).forEach(item=>unique.set(`${item.field}|${item.value}`,item));
      return [...unique.values()];
    }

    async function getDriverPeriodDocs(collectionName, period, uid, options = {}) {
      const merged = new Map();
      const canonicalOnly = options.canonicalOnly === true;
      const name = String(collectionName || "").toLowerCase();
      const canonicalRequests = name === "derivaciones"
        ? [{field:"emisorUid", value:String(uid||"").trim()}, {field:"receptorUid", value:String(uid||"").trim()}]
        : [{field:"driverUid", value:String(uid||"").trim()}];
      const requests = canonicalOnly ? canonicalRequests.filter(item=>item.value) : weeklyScopedQueryRequests(collectionName,uid);
      const attempts = await Promise.allSettled(requests.map(({field,value}) =>
        getDocs(query(collection(db, collectionName), where(field, "==", value)))
      ));
      let lastError = null;
      let successfulQueries = 0;
      attempts.forEach((result,index) => {
        if (result.status !== "fulfilled") { lastError = lastError || result.reason; return; }
        successfulQueries += 1;
        result.value.forEach((d) => {
          const raw = d.data() || {};
          const row = { ...raw, id: raw.id || d.id, documentId:d.id };
          if (docBelongsToPeriod(row, period)) merged.set(d.id,row);
        });
      });
      if (!successfulQueries && options.throwOnError && lastError) throw lastError;
      return Array.from(merged.values());
    }

    function getDriverUidFromRecord(data = {}) {
      return String(data.driverUid || data.simulationDriverUid || data.choferUid || data.uid || data.userId || data.usuarioUid || "").trim();
    }

    function getRecordDriverAliases(data = {}) {
      return [
        data.choferId, data.driverId, data.driverUid, data.profileId, data.perfilId, data.conductorId,
        data.choferUid, data.simulationDriverUid, data.createdByUid, data.uid, data.userId, data.usuarioUid, data.usuario, data.chofer,
        data.choferNombre, data.nombreChofer, data.driverName, data.conductorNombre, data.nombreConductor, data.nombreUsuario,
        data.choferEmail, data.email
      ].map(value => String(value || "").trim()).filter(Boolean);
    }

    function getDriverNameFromRecord(data = {}, fallback = "") {
      return String(
        data.choferNombre || data.nombreChofer || data.driverName || data.conductorNombre ||
        data.nombreConductor || data.nombreUsuario || fallback || ""
      ).trim();
    }

    function getDriverAvatarFromRecord(data = {}) {
      return String(
        data.avatarUrl || data.avatar || data.fotoPerfil || data.foto || data.photoURL || ""
      ).trim();
    }

    function isServiceValidForWeeklyTotals(data = {}) {
      if (data.excludeFromWeeklyTotals === true || data.excludeFromBillingGross === true || data.affectsBillingSettlement === true) return false;
      const state = normalizeStatus(data.estado || data.status || data.estadoServicio || data.estadoViaje);
      if (isInvalidState(state)) return false;
      if (["pendiente", "en espera", "presupuesto", "cotizado"].some(value => state.includes(value))) return false;
      if (data.cancelado === true || data.cancelada === true || data.anulado === true || data.anulada === true || data.eliminado === true) return false;
      const amount = getMoneyValue(data);
      if (!(amount > 0)) return false;
      if (data.completado === true || data.completada === true || data.vendido === true || data.vendida === true) return true;
      if (!state) return true;
      return EXPLORA_PERFORMANCE_COMPAT.validTripStates.has(state) || [...EXPLORA_PERFORMANCE_COMPAT.validTripStates].some(value => state.includes(value));
    }

    function emptyAgg(id) {
      return {
        choferId: id,
        uid: "",
        aliases: [],
        nombre: "",
        avatar: "",
        facturacion: 0,
        viajes: 0,
        derivacionesValidas: 0,
        derivacionesEfectivas: 0,
        derivedAmountForEmitter: 0,
        collaborationAmount: 0,
        firstCompletedAt: Number.POSITIVE_INFINITY,
        scoreFacturacion: 0,
        scoreViajes: 0,
        scoreDerivaciones: 0,
        activo: false
      };
    }

    function addAggAlias(agg, value) {
      const alias = String(value || "").trim();
      if (!alias) return;
      if (!agg.aliases.some(item => item.toLowerCase() === alias.toLowerCase())) agg.aliases.push(alias);
    }

    function effectiveDerivations(count) {
      const n = Math.max(0, Number(count || 0));
      return Math.min(n, 5) + Math.max(n - 5, 0) * 0.35;
    }

    function getDerivationOrigin(data = {}) {
      return String(data.senderUid || data.sentByUid || data.derivadorUid || data.driverSenderUid || data.createdByUid || data.originDriverUid || data.fromUid || data.emisorUid || data.choferOrigenUid || data.choferOrigenId || data.origenChoferId || data.choferOrigen || data.derivadorId || data.fromChoferId || data.creadoPor || data.emisorId || "").trim();
    }

    function getDerivationReceiver(data = {}) {
      return String(data.receiverUid || data.receivedByUid || data.receptorUid || data.assignedDriverUid || data.acceptedByUid || data.toUid || data.choferReceptorUid || data.choferReceptorId || data.receptorChoferId || data.choferDestino || data.receptor || data.recibidoPor || data.toChoferId || data.destinoChoferId || "").trim();
    }

    function getDerivationServiceId(data = {}) {
      return String(
        data.billingServiceId || data.viajeRelacionadoId || data.viajeId || data.operationId || data.operacionId ||
        data.servicioRef || data.referenciaServicio || data.servicioId || data.derivationId || ""
      ).trim();
    }

    function getDerivationFinalAmount(data = {}) {
      const candidates = [data.linkedBillingGrossAmount,data.billingGrossAmount,data.confirmedBillingAmount,data.grossAmount,data.totalAmount,data.confirmedAmount,data.billedAmount,data.serviceAmount,data.valorServicio,data.total,data.importe,data.monto,data.amount,data.derivedAmountForEmitter,data.finalAmount,data.suggestedAmount,data.fixedPrice];
      for (const candidate of candidates) { const amount = toNumberSafe(candidate); if (Number.isFinite(amount) && amount > 0) return Math.round(amount); }
      return 0;
    }

    function getDerivationCollaborationAmount(data = {}) {
      const grossAmount = getDerivationFinalAmount(data); return grossAmount > 0 ? Math.round(grossAmount * 0.10) : 0;
    }

    function isCompletedDerivation(data = {}) {
      const norm = value => normalizeStatus(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s_-]+/g, " ").trim();
      const states=[data.status,data.estado,data.estadoDerivacion,data.acceptanceStatus,data.completionStatus,data.billingStatus,data.paymentStatus].map(norm).filter(Boolean), joined=states.join(" | ");
      if (["pendiente","sent pending response","rechazada","rejected","cancelada","canceled","cancelled","vencida","expired","eliminada","deleted"].some(token=>joined.includes(token)) || isInvalidState(joined)) return false;
      const accepted=data.accepted===true||data.aceptada===true||data.aceptado===true||Boolean(data.acceptedAt||data.fechaAceptacion||data.acceptedByUid)||states.some(state=>["aceptada","aceptado","accepted"].includes(state)||state.includes("accepted"));
      const completed=data.completed===true||data.completada===true||data.completado===true||data.realizada===true||data.realizado===true||Boolean(data.completedAt||data.finishedAt||data.fechaFinalizacion)||states.some(state=>["completed","completada","completado","realizada","realizado","confirmada","confirmado"].includes(state)||state.includes("complet")||state.includes("realiz"));
      const billed=data.billed===true||data.facturada===true||data.facturado===true||data.paid===true||data.cobrada===true||data.cobrado===true||data.paymentConfirmed===true||data.billingConfirmed===true||Boolean(data.billedAt||data.invoicedAt||data.paidAt||data.fechaFacturacion||data.billingRecordId||data.paymentId||data.cobroId)||states.some(state=>["facturada","facturado","paid","cobrada","cobrado"].includes(state)||state.includes("factur")||state.includes("paid")||state.includes("cobrad"));
      return accepted&&completed&&billed&&getDerivationFinalAmount(data)>0&&Boolean(getDerivationOrigin(data))&&Boolean(getDerivationReceiver(data));
    }

    const weeklyProfileCache = new Map();

    function cacheDriverProfileAliases(info, aliases = []) {
      aliases.filter(Boolean).forEach(alias => weeklyProfileCache.set(String(alias).toLowerCase(), info));
    }

    async function readDriverProfileForRanking(id) {
      const key = String(id || "").trim();
      if (!key) return null;
      try {
        const direct = await getDoc(doc(db, "choferes", key));
        if (direct.exists()) return { id: direct.id, ...(direct.data() || {}) };
      } catch (_) {}

      for (const field of ["uid", "usuario", "username"]) {
        try {
          const snap = await getDocs(query(collection(db, "choferes"), where(field, "==", key), limit(2)));
          if (snap.size === 1) return { id: snap.docs[0].id, ...(snap.docs[0].data() || {}) };
        } catch (_) {}
      }
      return null;
    }

    async function getDriverPublicMap(ids) {
      const result = {};
      const sessionAliases = [
        exploraSession.driverId,
        exploraSession.profileDocumentId,
        auth.currentUser?.uid
      ].map(value => String(value || "").toLowerCase()).filter(Boolean);

      await Promise.all(Array.from(new Set(ids.filter(Boolean))).map(async (id) => {
        const key = String(id).toLowerCase();
        if (sessionAliases.includes(key) && exploraSession.profile) {
          const info = {
            nombre: getProfileName(exploraSession.profile, exploraSession.authUser),
            avatar: getProfileAvatarUrl(exploraSession.profile, exploraSession.authUser),
            uid: auth.currentUser?.uid || "",
            documentId: exploraSession.profileDocumentId || exploraSession.driverId || ""
          };
          cacheDriverProfileAliases(info, [id, ...sessionAliases]);
          result[id] = info;
          return;
        }
        if (weeklyProfileCache.has(key)) {
          result[id] = weeklyProfileCache.get(key);
          return;
        }
        const profile = await readDriverProfileForRanking(id);
        if (!profile) return;
        const info = {
          nombre: getProfileName(profile, null),
          avatar: getProfileAvatarUrl(profile, null),
          uid: String(profile.uid || profile.authUid || ""),
          documentId: profile.id || ""
        };
        cacheDriverProfileAliases(info, [id, profile.id, profile.uid, profile.usuario, profile.username]);
        result[id] = info;
      }));
      return result;
    }

    function currentWeeklyIdentityKeys() {
      return new Set([
        auth.currentUser?.uid,
        exploraSession.driverId,
        exploraSession.profileDocumentId
      ].map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
    }

    function aliasesMatchCurrent(aliases = []) {
      const current = currentWeeklyIdentityKeys();
      return aliases.some(alias => current.has(String(alias || "").trim().toLowerCase()));
    }
    function currentWeeklyProfileAliases() {
      const profile = exploraSession.profile || {};
      return [
        auth.currentUser?.uid,
        auth.currentUser?.email,
        exploraSession.driverId,
        exploraSession.profileDocumentId,
        profile.id,
        profile.documentId,
        profile.uid,
        profile.authUid,
        profile.usuario,
        profile.username,
        profile.nombre,
        profile.name,
        profile.displayName,
        getProfileName(profile, exploraSession.authUser)
      ].map(value => String(value || "").trim()).filter(Boolean);
    }


    async function buildWeeklyPerformanceResult(period, viajesDocs = [], derivacionesDocs = []) {
      const aggs = new Map();
      const aliasToCanonical = new Map();
      const countedServices = new Set();
      const validServices = [];
      function ensure(id) {
        const key = String(id || "").trim();
        if (!key) return null;
        if (!aggs.has(key)) aggs.set(key, emptyAgg(key));
        return aggs.get(key);
      }
      for (const service of viajesDocs) {
        if (!docBelongsToPeriod(service, period) || !isServiceValidForWeeklyTotals(service)) continue;
        const driverId = getDriverIdFromTrip(service);
        const driverUid = getDriverUidFromRecord(service);
        const amount = getMoneyValue(service);
        const operationId = getServiceOperationId(service, service.documentId || service.id);
        if (!driverId || !(amount > 0) || !operationId) continue;
        const dedupKey = `${driverId.toLowerCase()}|${operationId.toLowerCase()}|${period.id}`;
        if (countedServices.has(dedupKey)) continue;
        countedServices.add(dedupKey);
        const agg = ensure(driverId);
        if (!agg) continue;
        agg.uid = agg.uid || driverUid;
        agg.nombre = agg.nombre || getDriverNameFromRecord(service, "");
        agg.avatar = agg.avatar || getDriverAvatarFromRecord(service);
        getRecordDriverAliases(service).forEach(alias => { addAggAlias(agg, alias); aliasToCanonical.set(alias.toLowerCase(), driverId); });
        addAggAlias(agg, driverId); if (driverUid) addAggAlias(agg, driverUid);
        agg.facturacion += amount; agg.viajes += 1; agg.activo = true;
        validServices.push({ ...service, _driverId:driverId, _driverUid:driverUid, _operationId:operationId, _amount:amount });
      }
      const countedDerivations = new Set();
      const validDerivations = [];
      for (const derivation of derivacionesDocs) {
        if (!docBelongsToPeriod(derivation, period) || !isCompletedDerivation(derivation)) continue;
        const rawOrigin = getDerivationOrigin(derivation);
        const rawReceiver = getDerivationReceiver(derivation);
        const origin = aliasToCanonical.get(rawOrigin.toLowerCase()) || rawOrigin;
        const receiver = aliasToCanonical.get(rawReceiver.toLowerCase()) || rawReceiver;
        const operationId = getDerivationServiceId(derivation) || String(derivation.documentId || derivation.id || "");
        const finalAmount = getDerivationFinalAmount(derivation);
        const collaborationAmount = getDerivationCollaborationAmount(derivation);
        if (!origin || !receiver || origin.toLowerCase() === receiver.toLowerCase() || !operationId || !(finalAmount > 0)) continue;
        const dedupKey = `${String(derivation.derivationId || operationId).toLowerCase()}|${period.id}`;
        if (countedDerivations.has(dedupKey)) continue;
        countedDerivations.add(dedupKey);
        const senderAgg = ensure(origin), receiverAgg = ensure(receiver);
        if (!senderAgg || !receiverAgg) continue;
        addAggAlias(senderAgg, rawOrigin); addAggAlias(receiverAgg, rawReceiver);
        senderAgg.derivacionesValidas += 1;
        senderAgg.derivacionesEfectivas = senderAgg.derivacionesValidas;
        senderAgg.derivedAmountForEmitter += finalAmount;
        senderAgg.activo = true;
        receiverAgg.collaborationAmount += collaborationAmount;
        receiverAgg.activo = true;
        validDerivations.push({ ...derivation, _origin:origin, _receiver:receiver, _operationId:operationId, _finalAmount:finalAmount, _collaborationAmount:collaborationAmount });
      }
      const profileIds = Array.from(aggs.values()).map(row => row.choferId);
      const driverMap = await getDriverPublicMap(profileIds);
      for (const [id, info] of Object.entries(driverMap)) {
        const row = aggs.get(id); if (!row) continue;
        row.nombre = info.nombre || row.nombre; row.avatar = info.avatar || row.avatar; row.uid = info.uid || row.uid;
        addAggAlias(row, info.documentId); addAggAlias(row, info.uid);
      }
      const rows = Array.from(aggs.values()).filter(row => row.activo);
      rows.forEach(row => { row.nombre = row.nombre || "Chofer"; row.scoreFacturacion = row.facturacion; row.scoreViajes = 0; row.scoreDerivaciones = 0; });
      rows.sort((a,b) => b.facturacion - a.facturacion || b.viajes - a.viajes || b.derivedAmountForEmitter - a.derivedAmountForEmitter || String(a.choferId).localeCompare(String(b.choferId)));
      rows.forEach((row,index) => row.posicion = index + 1);
      return { periodoId:period.id, period, rows, performanceWinner:rows[0] || null, maximos:{facturacion:Math.max(0,...rows.map(row=>row.facturacion))}, fuentes:{viajes:viajesDocs.length,serviciosValidos:validServices.length,derivaciones:derivacionesDocs.length}, services:validServices, derivations:validDerivations };
    }

    function normalizeExpenseDocument(data = {}) {
      const amount = Math.max(0, getMoneyValue(data));
      return {
        ...data,
        id: String(data.id || data.gastoId || data.documentId || ""),
        uid: String(data.driverUid || data.choferUid || data.uid || data.ownerUid || data.userId || data.usuarioUid || ""),
        weeklyPeriodId: getRecordWeeklyPeriodId(data),
        category: String(data.tipoLabel || data.expenseType || data.category || data.tipo || data.categoria || "Gasto"),
        amount,
        notes: String(data.observaciones || data.detalle || data.notes || ""),
        receiptUrl: String(data.comprobanteUrl || data.receiptUrl || data.archivoUrl || data.receiptDataUrl || ""),
        receiptPath: String(data.comprobantePath || data.receiptPath || ""),
        receiptMimeType: String(data.comprobanteMime || data.receiptMimeType || ""),
        status: normalizeStatus(data.estado || data.status || "registrado"),
        createdAtMs: getDocTimeMs(data),
        operationId: String(data.operationId || data.operacionId || data.gastoId || data.documentId || data.id || "")
      };
    }

    function isValidWeeklyExpense(data = {}) {
      const expense = normalizeExpenseDocument(data);
      if (!(expense.amount > 0)) return false;
      if (isInvalidState(expense.status)) return false;
      if (data.cancelado === true || data.anulado === true || data.eliminado === true || data.duplicado === true) return false;
      return true;
    }

    function deduplicateWeeklyRows(rows = [], kind = "record") {
      const seen = new Set();
      return rows.filter((row) => {
        const owner = getRecordDriverAliases(row).map(value => String(value).toLowerCase()).sort()[0] || "unknown";
        const operation = String(
          row.operationId || row.operacionId || row.serviceId || row.servicioId || row.gastoId ||
          row.viajeId || row.documentId || row.id || ""
        ).toLowerCase();
        const key = `${kind}|${owner}|${operation}`;
        if (!operation || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }


    const WEEKLY_SNAPSHOT_COLLECTION = "acumulados_semanales";
    const OPERATIONAL_LOAN_COLLECTION = "prestamos_operativos";
    const WEEKLY_ENGINE_SCHEMA_VERSION = 2440;
    const WEEKLY_CACHE_PREFIX = "explora_weekly_v2440_";

    function normalizePaymentMethod(data = {}) {
      const financialCategory = normalizeStatus(data.financialCategory || data.categoriaFinanciera || "");
      const raw = normalizeStatus(
        data.paymentMethod || data.paymentType || data.payment_type || data.metodoPago ||
        data.medioPago || data.medioDePago || data.medio_de_pago || data.formaPago || data.formaDePago ||
        data.pago || data.tipoPago || data.metodoCobro || data.metodo || data.method || data.payment?.method || ""
      );
      if (["cash","efectivo","contado","en_efectivo"].includes(raw)) return "cash";
      // v2.4.40: POSNET/tarjeta tiene prioridad sobre Mercado Pago cuando aparecen juntos
      // para mantener subtotales de tarjeta correctos. Ambos quedan del lado de David.
      if (raw.includes("tarjeta") || raw.includes("card") || raw.includes("debito") || raw.includes("débito") || raw.includes("credito") || raw.includes("crédito") || raw.includes("posnet")) return "card";
      if (raw.includes("qr") || raw.includes("mercado_pago") || raw.includes("mercadopago") || raw === "mp" || raw.includes("wallet") || raw.includes("billetera")) return "qr";
      if (raw.includes("alias")) return "alias";
      if (raw.includes("transfer") || raw === "cbu" || raw === "cvu" || raw.includes("banco")) return "transfer";
      if (financialCategory === "alias" || data.manualTransfer === true) return "alias";
      if (financialCategory === "card") return "card";
      if (financialCategory === "qr") return "qr";
      if (financialCategory === "cash") return "cash";
      return "unknown";
    }

    function normalizePayerRole(data = {}, fallback = "driver") {
      const raw = normalizeStatus(data.payerRole || data.pagadoPorRol || data.pagadoPor || data.payer || data.responsablePago || data.creadoPorRol || fallback);
      if (raw.includes("admin") || raw.includes("david")) return "admin";
      return "driver";
    }

    function normalizeSharedRate(data = {}, fallback = 0.5) {
      const raw = Number(data.sharedRate ?? data.porcentajeCompartido ?? data.tasaCompartida ?? fallback);
      if (!Number.isFinite(raw)) return fallback;
      if (raw > 1) return Math.min(1, Math.max(0, raw / 100));
      return Math.min(1, Math.max(0, raw));
    }

    function normalizeOperationalLoanDocument(data = {}) {
      return {
        ...data,
        id: String(data.id || data.loanId || data.prestamoId || data.operationId || data.documentId || ""),
        uid: String(data.driverUid || data.choferUid || data.uid || data.userId || ""),
        weeklyPeriodId: getRecordWeeklyPeriodId(data),
        amount: Math.max(0, getMoneyValue(data)),
        driverShare: Math.max(0, toNumberSafe(data.driverShare ?? data.parteChofer)),
        adminShare: Math.max(0, toNumberSafe(data.adminShare ?? data.parteAdmin ?? data.parteDavid)),
        sharedRate: normalizeSharedRate(data, 0.5),
        payerRole: normalizePayerRole(data, "admin"),
        linkedExpenseId: String(data.linkedExpenseId || data.gastoVinculadoId || ""),
        status: normalizeStatus(data.status || data.estado || "active"),
        notes: String(data.notes || data.observaciones || data.detalle || ""),
        createdAtMs: getDocTimeMs(data),
        operationId: String(data.operationId || data.loanId || data.prestamoId || data.documentId || data.id || "")
      };
    }

    function isValidOperationalLoan(data = {}) {
      const loan = normalizeOperationalLoanDocument(data);
      if (!(loan.amount > 0)) return false;
      if (isInvalidState(loan.status) || data.cancelado === true || data.anulado === true || data.eliminado === true) return false;
      return true;
    }

    const DIRECT_DEBT_COLLECTION = "deudas_choferes";
    const weeklyDebtCache = new Map();

    async function loadDriverDebtInstallments(uid, period, { force = false } = {}) {
      const key = `${String(uid || "").toLowerCase()}|${period.id}`;
      if (!force && weeklyDebtCache.has(key)) return weeklyDebtCache.get(key);
      const merged = new Map();
      const fields = ["driverUid", "choferUid", "uid"];
      const attempts = await Promise.allSettled(fields.map(field =>
        getDocs(query(collection(db, DIRECT_DEBT_COLLECTION), where(field, "==", uid)))
      ));
      attempts.forEach(result => {
        if (result.status !== "fulfilled") return;
        result.value.forEach(d => merged.set(d.id, { ...(d.data() || {}), id:d.id, documentId:d.id }));
      });
      const rows = [];
      merged.forEach(debt => {
        const status = normalizeStatus(debt.status || debt.estado || "active");
        if (isInvalidState(status) || status.includes("liquidada") || status.includes("paid")) return;
        const installments = Array.isArray(debt.installments) ? debt.installments : [];
        const installment = installments.find(item => String(item.weeklyPeriodId || item.periodoSemanalId || "") === period.id && !["paid","settled","cancelled","canceled","anulada"].includes(normalizeStatus(item.status || "pending")));
        if (!installment) return;
        const amount = Math.max(0, toNumberSafe(installment.amount ?? installment.monto));
        if (!(amount > 0)) return;
        rows.push({
          id:`${debt.id}_${installment.number || installment.numero || 1}`,
          debtId:debt.id,
          uid:String(debt.driverUid || debt.choferUid || debt.uid || uid),
          weeklyPeriodId:period.id,
          reason:String(debt.reason || debt.motivo || "other"),
          reasonLabel:String(debt.reasonLabel || debt.motivoLabel || debt.reason || debt.motivo || "Otro"),
          amount,
          installmentNumber:Number(installment.number || installment.numero || 1),
          installmentCount:Number(installment.total || debt.installmentCount || debt.cantidadCuotas || installments.length || 1),
          status:normalizeStatus(installment.status || "pending"),
          totalAmount:Math.max(0,toNumberSafe(debt.totalAmount ?? debt.montoTotal)),
          remainingAmount:Math.max(0,toNumberSafe(debt.remainingAmount ?? debt.saldoPendiente)),
          receiptUrl:String(debt.receiptUrl || debt.comprobanteUrl || "")
        });
      });
      weeklyDebtCache.set(key, rows);
      return rows;
    }

    function getLegacyPerformanceRewardFromSources() {
      return 0;
    }

    async function applyPerformanceRewardToSettlement(financial = {}, driverUid = "", weeklyPeriodId = "") {
      let incentive={derivationPercent:0,derivationBonusAmount:0,weeklyPeriodId};
      try { incentive=await window.ExploraPerformanceEngine?.prepareSettlementIncentive?.(driverUid,weeklyPeriodId)||incentive; } catch (_) {}
      const derivationBonusAmount=Math.max(0,toNumberSafe(incentive.derivationBonusAmount));
      const settlement=calculateWeeklySettlementFromAggregates({...financial,derivationBonusAmount,collaborationAmount:Number(financial.collaborationAmount||0),exploreLoanDiscount:Number(financial.exploreLoanDiscount||0)});
      return {...settlement,derivationBonusAmount,performanceDerivationPercent:Number(incentive.derivationPercent||0),performanceWeeklyPeriodId:incentive.weeklyPeriodId||weeklyPeriodId||"",performanceDerivationWinnerUid:incentive.derivationWinnerUid||""};
    }

    function calculateWeeklyFinancialSettlement({ services = [], expenses = [], operationalLoans = [], directDebtInstallments = [], derivationBonusAmount = 0, collaborationAmount = 0, exploreLoanDiscount = 0 } = {}) {
      const validServices=deduplicateWeeklyRows(services.filter(isServiceValidForWeeklyTotals),"service");
      let cashCollectedByDriver=0,transferCollectedByAdmin=0,cardCollectedByAdmin=0,aliasCollectedByAdmin=0,qrCollectedByAdmin=0,unknownPaymentMethodTotal=0;
      validServices.forEach(service=>{const amount=Math.max(0,getMoneyValue(service)),method=normalizePaymentMethod(service);if(method==="qr")qrCollectedByAdmin+=amount;else if(method==="alias")aliasCollectedByAdmin+=amount;else if(method==="transfer")transferCollectedByAdmin+=amount;else if(method==="card")cardCollectedByAdmin+=amount;else if(method==="cash")cashCollectedByDriver+=amount;else unknownPaymentMethodTotal+=amount;});
      const validLoans=deduplicateWeeklyRows(operationalLoans.filter(isValidOperationalLoan),"loan").map(normalizeOperationalLoanDocument),linkedExpenseIds=new Set(validLoans.map(loan=>loan.linkedExpenseId).filter(Boolean));
      let driverPaidSharedExpenses=0,adminPaidSharedExpenses=0;
      expenses.forEach(expense=>{const id=String(expense.id||expense.gastoId||expense.documentId||"");if(id&&linkedExpenseIds.has(id))return;const amount=Math.max(0,toNumberSafe(expense.amount??getMoneyValue(expense)));if(normalizePayerRole(expense,"driver")==="admin")adminPaidSharedExpenses+=amount;else driverPaidSharedExpenses+=amount;});
      const validDebts=deduplicateWeeklyRows(directDebtInstallments.filter(row=>Number(row.amount||0)>0),"debt"),directDebtInstallmentTotal=validDebts.reduce((sum,row)=>sum+Math.max(0,toNumberSafe(row.amount)),0);
      const operationalLoanTotal=validLoans.reduce((sum,loan)=>sum+loan.amount,0),operationalLoanDriverShare=validLoans.reduce((sum,loan)=>sum+(loan.driverShare>0?loan.driverShare:loan.amount*loan.sharedRate),0),operationalLoanAdminShare=validLoans.reduce((sum,loan)=>sum+(loan.adminShare>0?loan.adminShare:loan.amount-(loan.driverShare>0?loan.driverShare:loan.amount*loan.sharedRate)),0);
      const grossBilling=validServices.reduce((sum,service)=>sum+Math.max(0,getMoneyValue(service)),0),totalCollectedByAdmin=transferCollectedByAdmin+cardCollectedByAdmin+aliasCollectedByAdmin+qrCollectedByAdmin;
      const safeDerivationBonus=Math.max(0,toNumberSafe(derivationBonusAmount)),safeCollaboration=Math.max(0,toNumberSafe(collaborationAmount)),safeExploreLoanDiscount=Math.max(0,toNumberSafe(exploreLoanDiscount)),repairFundRate=.05,repairFundAmount=Math.round(grossBilling*repairFundRate),driverBaseShare=grossBilling*.5,adminBaseShare=grossBilling*.5;
      const driverFinalEntitlement=driverBaseShare+safeDerivationBonus-safeCollaboration,adminFinalEntitlement=adminBaseShare-safeDerivationBonus+safeCollaboration+repairFundAmount;
      const driverExpenseCredit=expenses.reduce((sum,expense)=>{const id=String(expense.id||expense.gastoId||expense.documentId||"");if(id&&linkedExpenseIds.has(id))return sum;if(normalizePayerRole(expense,"driver")!=="driver")return sum;return sum+Math.max(0,toNumberSafe(expense.amount??getMoneyValue(expense)))*normalizeSharedRate(expense,.5);},0);
      const adminExpenseCredit=expenses.reduce((sum,expense)=>{const id=String(expense.id||expense.gastoId||expense.documentId||"");if(id&&linkedExpenseIds.has(id))return sum;if(normalizePayerRole(expense,"driver")!=="admin")return sum;return sum+Math.max(0,toNumberSafe(expense.amount??getMoneyValue(expense)))*normalizeSharedRate(expense,.5);},0)+operationalLoanDriverShare;
      const canonicalSettlement=calculateCanonicalWeeklySettlement({grossBilling,cashCollectedByDriver,driverBasePercentage:50,driverBaseShare,derivationBonusAmount:safeDerivationBonus,collaborationAmount:safeCollaboration,repairFundRate,repairFundAmount,driverExpenseCredit,adminExpenseCredit,driverPaidSharedExpenses,adminPaidSharedExpenses,totalExpenses:driverPaidSharedExpenses+adminPaidSharedExpenses,operationalLoanDriverShare,directDebtInstallmentTotal,exploreLoanDiscount:safeExploreLoanDiscount});
      const paymentMethodReviewRequired = unknownPaymentMethodTotal > 0;
      return {grossBilling,cashCollectedByDriver,transferCollectedByAdmin,cardCollectedByAdmin,aliasCollectedByAdmin,qrCollectedByAdmin,unknownPaymentMethodTotal,paymentMethodReviewRequired,totalCollectedByAdmin,driverPaidSharedExpenses,adminPaidSharedExpenses,operationalLoans:validLoans,operationalLoanTotal,operationalLoanDriverShare,operationalLoanAdminShare,directDebtInstallments:validDebts,directDebtInstallmentTotal,exploreLoanDiscount:safeExploreLoanDiscount,derivationBonusAmount:safeDerivationBonus,collaborationAmount:safeCollaboration,repairFundRate,repairFundAmount,driverBaseShare,adminBaseShare,driverFinalEntitlement,adminFinalEntitlement,driverExpenseCredit,adminExpenseCredit,...canonicalSettlement};
    }

    function calculateWeeklySettlementFromAggregates(data = {}) {
      const grossBilling=Math.max(0,toNumberSafe(data.grossBilling??data.facturacion)),cashCollectedByDriver=Math.max(0,toNumberSafe(data.cashCollectedByDriver)),transferCollectedByAdmin=Math.max(0,toNumberSafe(data.transferCollectedByAdmin)),cardCollectedByAdmin=Math.max(0,toNumberSafe(data.cardCollectedByAdmin)),aliasCollectedByAdmin=Math.max(0,toNumberSafe(data.aliasCollectedByAdmin)),qrCollectedByAdmin=Math.max(0,toNumberSafe(data.qrCollectedByAdmin)),unknownPaymentMethodTotal=Math.max(0,toNumberSafe(data.unknownPaymentMethodTotal)),totalCollectedByAdmin=transferCollectedByAdmin+cardCollectedByAdmin+aliasCollectedByAdmin+qrCollectedByAdmin;
      const driverPaidSharedExpenses=Math.max(0,toNumberSafe(data.driverPaidSharedExpenses)),adminPaidSharedExpenses=Math.max(0,toNumberSafe(data.adminPaidSharedExpenses)),operationalLoanTotal=Math.max(0,toNumberSafe(data.operationalLoanTotal)),operationalLoanDriverShare=Math.max(0,toNumberSafe(data.operationalLoanDriverShare)),operationalLoanAdminShare=Math.max(0,toNumberSafe(data.operationalLoanAdminShare)),directDebtInstallmentTotal=Math.max(0,toNumberSafe(data.directDebtInstallmentTotal)),exploreLoanDiscount=Math.max(0,toNumberSafe(data.exploreLoanDiscount)),derivationBonusAmount=Math.max(0,toNumberSafe(data.derivationBonusAmount)),collaborationAmount=Math.max(0,toNumberSafe(data.collaborationAmount));
      const repairFundRate=.05,repairFundAmount=Object.prototype.hasOwnProperty.call(data,"repairFundAmount")?Math.max(0,toNumberSafe(data.repairFundAmount)):Math.round(grossBilling*repairFundRate),driverExpenseCredit=Object.prototype.hasOwnProperty.call(data,"driverExpenseCredit")?Math.max(0,toNumberSafe(data.driverExpenseCredit)):driverPaidSharedExpenses*.5,adminExpenseCredit=Object.prototype.hasOwnProperty.call(data,"adminExpenseCredit")?Math.max(0,toNumberSafe(data.adminExpenseCredit)):adminPaidSharedExpenses*.5+operationalLoanDriverShare,driverBaseShare=grossBilling*.5,adminBaseShare=grossBilling*.5,driverFinalEntitlement=driverBaseShare+derivationBonusAmount-collaborationAmount,adminFinalEntitlement=adminBaseShare-derivationBonusAmount+collaborationAmount+repairFundAmount;
      const canonicalSettlement=calculateCanonicalWeeklySettlement({grossBilling,cashCollectedByDriver,driverBasePercentage:50,driverBaseShare,derivationBonusAmount,collaborationAmount,repairFundRate,repairFundAmount,driverExpenseCredit,adminExpenseCredit,driverPaidSharedExpenses,adminPaidSharedExpenses,totalExpenses:driverPaidSharedExpenses+adminPaidSharedExpenses,operationalLoanDriverShare,directDebtInstallmentTotal,exploreLoanDiscount,dailyRankingBonusAmount:Math.max(0,toNumberSafe(data.dailyRankingBonusAmount))});
      return {grossBilling,cashCollectedByDriver,transferCollectedByAdmin,cardCollectedByAdmin,aliasCollectedByAdmin,qrCollectedByAdmin,unknownPaymentMethodTotal,paymentMethodReviewRequired:unknownPaymentMethodTotal>0,totalCollectedByAdmin,driverPaidSharedExpenses,adminPaidSharedExpenses,operationalLoanTotal,operationalLoanDriverShare,operationalLoanAdminShare,directDebtInstallmentTotal,exploreLoanDiscount,derivationBonusAmount,collaborationAmount,repairFundRate,repairFundAmount,driverExpenseCredit,adminExpenseCredit,driverBaseShare,adminBaseShare,driverFinalEntitlement,adminFinalEntitlement,...canonicalSettlement};
    }

    function weeklyOperationId(data = {}, kind = "operation") {
      return String(
        data.operationId || data.operacionId || data.serviceId || data.servicioId || data.expenseId || data.gastoId ||
        data.loanId || data.prestamoId || data.viajeId || data.documentId || data.id || `${kind}_${getDocTimeMs(data)}`
      ).trim();
    }

    function buildWeeklyOperationLedger(services = [], expenses = [], loans = [], debts = []) {
      const linkedExpenseIds = new Set(loans.map((loan) => String(loan.linkedExpenseId || "")).filter(Boolean));
      return [
        ...services.map((row) => ({ id:weeklyOperationId(row,"service"), type:"service", amount:getMoneyValue(row), paymentMethod:normalizePaymentMethod(row) })),
        ...expenses.map((row) => ({ id:weeklyOperationId(row,"expense"), type:"expense", amount:Math.max(0,toNumberSafe(row.amount ?? getMoneyValue(row))), payerRole:normalizePayerRole(row,"driver"), sharedRate:normalizeSharedRate(row,.5), sharedAdjustmentApplied:!linkedExpenseIds.has(weeklyOperationId(row,"expense")) })),
        ...loans.map((row) => ({ id:weeklyOperationId(row,"loan"), type:"loan", amount:Math.max(0,toNumberSafe(row.amount ?? getMoneyValue(row))), driverShare:Math.max(0,toNumberSafe(row.driverShare ?? row.parteChofer)) || Math.max(0,toNumberSafe(row.amount ?? getMoneyValue(row))) * normalizeSharedRate(row,.5), adminShare:Math.max(0,toNumberSafe(row.adminShare ?? row.parteAdmin ?? row.parteDavid)), linkedExpenseId:String(row.linkedExpenseId || row.gastoVinculadoId || "") })),
        ...debts.map((row) => ({ id:weeklyOperationId(row,"debt"), type:"debt", amount:Math.max(0,toNumberSafe(row.amount)), debtId:String(row.debtId || ""), reasonLabel:String(row.reasonLabel || row.reason || "Otro"), installmentNumber:Number(row.installmentNumber || 1), installmentCount:Number(row.installmentCount || 1) }))
      ].filter((row) => row.id).slice(-200);
    }

    function materializedSnapshotId(uid, periodId) {
      return `${periodId}_${uid}`;
    }

    function getWeeklySessionCacheKey(uid, periodId) {
      return `${WEEKLY_CACHE_PREFIX}${uid}_${periodId}`;
    }

    function snapshotForSessionStorage(snapshot = {}) {
      return {
        schemaVersion: WEEKLY_ENGINE_SCHEMA_VERSION,
        uid: snapshot.uid,
        weeklyPeriodId: snapshot.weeklyPeriodId,
        serviceCount: snapshot.serviceCount,
        grossBilling: snapshot.grossBilling,
        expenseCount: snapshot.expenseCount,
        totalExpenses: snapshot.totalExpenses,
        validDerivations: snapshot.validDerivations,
        derivedAmountForEmitter: snapshot.derivedAmountForEmitter,
        collaborationAmount: snapshot.collaborationAmount,
        dailyBilling: snapshot.dailyBilling,
        cashCollectedByDriver: snapshot.cashCollectedByDriver,
        transferCollectedByAdmin: snapshot.transferCollectedByAdmin,
        cardCollectedByAdmin: snapshot.cardCollectedByAdmin,
        aliasCollectedByAdmin: snapshot.aliasCollectedByAdmin,
        qrCollectedByAdmin: snapshot.qrCollectedByAdmin,
        unknownPaymentMethodTotal: snapshot.unknownPaymentMethodTotal,
        paymentMethodReviewRequired: snapshot.paymentMethodReviewRequired,
        totalCollectedByAdmin: snapshot.totalCollectedByAdmin,
        driverPaidSharedExpenses: snapshot.driverPaidSharedExpenses,
        adminPaidSharedExpenses: snapshot.adminPaidSharedExpenses,
        driverPaidExpenses: snapshot.driverPaidSharedExpenses,
        adminPaidExpenses: snapshot.adminPaidSharedExpenses,
        operationalLoanTotal: snapshot.operationalLoanTotal,
        operationalLoanDriverShare: snapshot.operationalLoanDriverShare,
        operationalLoanAdminShare: snapshot.operationalLoanAdminShare,
        directDebtInstallmentTotal: snapshot.directDebtInstallmentTotal,
        directDebtInstallments: Array.isArray(snapshot.directDebtInstallments) ? snapshot.directDebtInstallments : [],
        receivedValidDerivations: snapshot.receivedValidDerivations,
        exploreLoanDiscount: snapshot.exploreLoanDiscount,
        exploreLoanOriginalAmount: snapshot.exploreLoanOriginalAmount,
        exploreLoanBalance: snapshot.exploreLoanBalance,
        exploreLoanWeeklyDiscount: snapshot.exploreLoanWeeklyDiscount,
        exploraLoanLookbackId: snapshot.exploraLoanLookbackId,
        exploraLoanLookback: snapshot.exploraLoanLookback || null,
        exploraLoanLookbackBilling: snapshot.exploraLoanLookbackBilling,
        activeWeeks: snapshot.activeWeeks,
        requirements: snapshot.requirements || {},
        requirementList: Array.isArray(snapshot.requirementList) ? snapshot.requirementList : [],
        requirementsMet: snapshot.requirementsMet,
        activeLoan: snapshot.activeLoan || null,
        availableBenefit: snapshot.availableBenefit,
        benefitAvailable: snapshot.benefitAvailable,
        eligibility: snapshot.eligibility || null,
        kingOfDayAchieved: snapshot.kingOfDayAchieved === true,
        kingOfWeekAchieved: snapshot.kingOfWeekAchieved === true,
        kingOfLoanLookbackAchieved: snapshot.kingOfLoanLookbackAchieved === true,
        driverExpenseCredit: snapshot.driverExpenseCredit,
        adminExpenseCredit: snapshot.adminExpenseCredit,
        repairFundRate: Number(snapshot.repairFundRate || .05),
        repairFundAmount: Math.max(0, toNumberSafe(snapshot.repairFundAmount)),
        operationLedger: Array.isArray(snapshot.operationLedger) ? snapshot.operationLedger.slice(-160) : [],
        processedOperationIds: Array.isArray(snapshot.processedOperationIds) ? snapshot.processedOperationIds.slice(-160) : [],
                        derivationBonusAmount: snapshot.derivationBonusAmount,
                performanceDerivationPercent: snapshot.performanceDerivationPercent,
        driverBaseShare: snapshot.driverBaseShare,
        adminBaseShare: snapshot.adminBaseShare,
        driverFinalEntitlement: snapshot.driverFinalEntitlement,
        adminFinalEntitlement: snapshot.adminFinalEntitlement,
        settlementToDriver: snapshot.settlementToDriver,
        settlementToAdmin: snapshot.settlementToAdmin,
        payerRole: snapshot.payerRole,
        payeeRole: snapshot.payeeRole,
        settlementAmount: snapshot.settlementAmount,
        balanced: snapshot.balanced,
        closureId: snapshot.closureId || null,
        closureStatus: snapshot.closureStatus || "open",
        weeklyReceiptRequired: Boolean(snapshot.weeklyReceiptRequired),
        weeklyReceiptStatus: snapshot.weeklyReceiptStatus || "not_required",
        weeklyReceiptUrl: snapshot.weeklyReceiptUrl || null,
        receiptDeadline: snapshot.receiptDeadline || null,
        performanceEligible: snapshot.performanceEligible !== false,
        cachedAt: Date.now()
      };
    }

    function persistWeeklySessionCache(snapshot) {
      const compact=snapshotForSessionStorage(snapshot);
      try { sessionStorage.setItem(getWeeklySessionCacheKey(snapshot.uid, snapshot.weeklyPeriodId), JSON.stringify(compact)); } catch (_) {}
      try {
        const ctx={uid:snapshot.uid,role:"chofer",weeklyPeriodId:snapshot.weeklyPeriodId};
        window.ExploraFastCache?.set?.("dashboard_weekly_billing",compact,ctx,{ttl:300000});
        window.ExploraFastCache?.set?.("dashboard_weekly_expenses",compact,ctx,{ttl:300000});
      } catch (_) {}
    }

    function restoreWeeklySessionCache(uid, period) {
      try {
        const ctx={uid,role:"chofer",weeklyPeriodId:period.id};
        const fast=window.ExploraFastCache?.get?.("dashboard_weekly_billing",ctx,{allowStale:true})||window.ExploraFastCache?.get?.("dashboard_weekly_expenses",ctx,{allowStale:true});
        const raw=fast?.data?null:sessionStorage.getItem(getWeeklySessionCacheKey(uid, period.id));
        const data=fast?.data||(raw?JSON.parse(raw):null);
        if (!data || data.uid !== uid || data.weeklyPeriodId !== period.id) return null;
        return {
          ...data,
          startAt: new Date(period.startMs), endAt: new Date(period.endMs), timezone: "America/Argentina/Cordoba",
          services: [], expenses: [], operationalLoans: [], directDebtInstallments: data.directDebtInstallments || [], derivations: [], currentServices: [], expenseRows: [],
          performanceResult: null, loading: false, loaded:true, error: null, calculatedAt: new Date(data.cachedAt || fast?.savedAt || Date.now()), fromSessionCache: !fast, fromFastCache:Boolean(fast)
        };
      } catch (_) { return null; }
    }

    function materializedPayloadFromSnapshot(snapshot) {
      return {
        schemaVersion: WEEKLY_ENGINE_SCHEMA_VERSION,
        driverUid: snapshot.uid,
        uid: snapshot.uid,
        choferUid: snapshot.uid,
        choferId: exploraSession.profileDocumentId || exploraSession.driverId || snapshot.uid,
        driverName: getProfileName(exploraSession.profile || {}, auth.currentUser),
        avatar: getProfileAvatarUrl(exploraSession.profile || {}, auth.currentUser),
        weeklyPeriodId: snapshot.weeklyPeriodId,
        periodoSemanalId: snapshot.weeklyPeriodId,
        periodoId: snapshot.weeklyPeriodId,
        grossBilling: snapshot.grossBilling,
        facturacion: snapshot.grossBilling,
        serviceCount: snapshot.serviceCount,
        viajes: snapshot.serviceCount,
        totalExpenses: snapshot.totalExpenses,
        gastos: snapshot.totalExpenses,
        expenseCount: snapshot.expenseCount,
        cantidadGastos: snapshot.expenseCount,
        cashCollectedByDriver: snapshot.cashCollectedByDriver,
        transferCollectedByAdmin: snapshot.transferCollectedByAdmin,
        cardCollectedByAdmin: snapshot.cardCollectedByAdmin,
        aliasCollectedByAdmin: snapshot.aliasCollectedByAdmin,
        qrCollectedByAdmin: snapshot.qrCollectedByAdmin,
        unknownPaymentMethodTotal: snapshot.unknownPaymentMethodTotal,
        paymentMethodReviewRequired: snapshot.paymentMethodReviewRequired,
        totalCollectedByAdmin: snapshot.totalCollectedByAdmin,
        driverPaidSharedExpenses: snapshot.driverPaidSharedExpenses,
        adminPaidSharedExpenses: snapshot.adminPaidSharedExpenses,
        driverPaidExpenses: snapshot.driverPaidSharedExpenses,
        adminPaidExpenses: snapshot.adminPaidSharedExpenses,
        operationalLoanTotal: snapshot.operationalLoanTotal,
        operationalLoanDriverShare: snapshot.operationalLoanDriverShare,
        operationalLoanAdminShare: snapshot.operationalLoanAdminShare,
        directDebtInstallmentTotal: snapshot.directDebtInstallmentTotal,
        directDebtInstallments: Array.isArray(snapshot.directDebtInstallments) ? snapshot.directDebtInstallments : [],
        receivedValidDerivations: snapshot.receivedValidDerivations,
        derivacionesRecibidasValidas: snapshot.receivedValidDerivations,
        exploreLoanDiscount: snapshot.exploreLoanDiscount,
        exploreLoanOriginalAmount: snapshot.exploreLoanOriginalAmount,
        exploreLoanBalance: snapshot.exploreLoanBalance,
        exploreLoanWeeklyDiscount: snapshot.exploreLoanWeeklyDiscount,
        exploraLoanLookbackId: snapshot.exploraLoanLookbackId,
        exploraLoanLookback: snapshot.exploraLoanLookback || null,
        exploraLoanLookbackBilling: snapshot.exploraLoanLookbackBilling,
        activeWeeks: snapshot.activeWeeks,
        requirements: snapshot.requirements || {},
        requirementList: Array.isArray(snapshot.requirementList) ? snapshot.requirementList : [],
        requirementsMet: snapshot.requirementsMet,
        activeLoan: snapshot.activeLoan || null,
        availableBenefit: snapshot.availableBenefit,
        benefitAvailable: snapshot.benefitAvailable,
        eligibility: snapshot.eligibility || null,
        kingOfDayAchieved: snapshot.kingOfDayAchieved === true,
        kingOfWeekAchieved: snapshot.kingOfWeekAchieved === true,
        kingOfLoanLookbackAchieved: snapshot.kingOfLoanLookbackAchieved === true,
        driverExpenseCredit: snapshot.driverExpenseCredit,
        adminExpenseCredit: snapshot.adminExpenseCredit,
        operationLedger: Array.isArray(snapshot.operationLedger) ? snapshot.operationLedger.slice(-160) : [],
        processedOperationIds: Array.isArray(snapshot.processedOperationIds) ? snapshot.processedOperationIds.slice(-160) : [],
        operacionesProcesadas: Array.isArray(snapshot.processedOperationIds) ? snapshot.processedOperationIds.slice(-160) : [],
        validDerivations: snapshot.validDerivations,
        derivacionesValidas: snapshot.validDerivations,
        derivedAmountForEmitter: snapshot.derivedAmountForEmitter,
        collaborationAmount: snapshot.collaborationAmount,
        repairFundRate: Number(snapshot.repairFundRate || .05),
        repairFundAmount: Math.max(0, toNumberSafe(snapshot.repairFundAmount)),
                        derivationBonusAmount: snapshot.derivationBonusAmount,
                performanceDerivationPercent: snapshot.performanceDerivationPercent,
        driverBaseShare: snapshot.driverBaseShare,
        adminBaseShare: snapshot.adminBaseShare,
        driverFinalEntitlement: snapshot.driverFinalEntitlement,
        adminFinalEntitlement: snapshot.adminFinalEntitlement,
        settlementToDriver: snapshot.settlementToDriver,
        settlementToAdmin: snapshot.settlementToAdmin,
        payerRole: snapshot.payerRole,
        payeeRole: snapshot.payeeRole,
        settlementAmount: snapshot.settlementAmount,
        balanced: snapshot.balanced,
        dailyBilling: snapshot.dailyBilling || Array(7).fill(0),
        actualizadoEn: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
    }

    async function persistMaterializedWeeklySnapshot(snapshot) {
      if (!snapshot?.uid || !snapshot?.weeklyPeriodId) return;
      const ref = doc(db, WEEKLY_SNAPSHOT_COLLECTION, materializedSnapshotId(snapshot.uid, snapshot.weeklyPeriodId));
      await setDoc(ref, materializedPayloadFromSnapshot(snapshot), { merge: true });
    }

    function snapshotFromMaterialized(data = {}, uid, period, performanceResult = null) {
      const grossBilling = Math.max(0, toNumberSafe(data.grossBilling ?? data.facturacion));
      const serviceCount = Math.max(0, Number(data.serviceCount ?? data.viajes ?? 0));
      const resolvedExpenses = resolveWeeklyExpenseTotals(data);
      const totalExpenses = resolvedExpenses.total;
      const expenseCount = Math.max(0, Number(data.expenseCount ?? data.cantidadGastos ?? (totalExpenses > 0 ? 1 : 0)));
      const collaborationAmount = Math.max(0, toNumberSafe(data.collaborationAmount));
      const repairFundRate = .05;
      const repairFundAmount = Object.prototype.hasOwnProperty.call(data,"repairFundAmount")
        ? Math.max(0, toNumberSafe(data.repairFundAmount))
        : Math.round(grossBilling * repairFundRate);
      const derivationBonusAmount = Math.max(0, toNumberSafe(data.derivationBonusAmount));
      const base = {
        services: [], expenses: [], operationalLoans: [], derivations: [],
        cashCollectedByDriver: Math.max(0, toNumberSafe(data.cashCollectedByDriver)),
        transferCollectedByAdmin: Math.max(0, toNumberSafe(data.transferCollectedByAdmin)),
        cardCollectedByAdmin: Math.max(0, toNumberSafe(data.cardCollectedByAdmin)),
        aliasCollectedByAdmin: Math.max(0, toNumberSafe(data.aliasCollectedByAdmin)),
        qrCollectedByAdmin: Math.max(0, toNumberSafe(data.qrCollectedByAdmin)),
        totalCollectedByAdmin: Math.max(0, toNumberSafe(data.totalCollectedByAdmin)),
        driverPaidSharedExpenses: resolvedExpenses.driverPaid,
        adminPaidSharedExpenses: resolvedExpenses.adminPaid,
        driverPaidExpenses: resolvedExpenses.driverPaid,
        adminPaidExpenses: resolvedExpenses.adminPaid,
        operationalLoanTotal: Math.max(0, toNumberSafe(data.operationalLoanTotal)),
        operationalLoanDriverShare: Math.max(0, toNumberSafe(data.operationalLoanDriverShare)),
        operationalLoanAdminShare: Math.max(0, toNumberSafe(data.operationalLoanAdminShare)),
        directDebtInstallmentTotal: Math.max(0, toNumberSafe(data.directDebtInstallmentTotal)),
        directDebtInstallments: Array.isArray(data.directDebtInstallments) ? data.directDebtInstallments : [],
        exploreLoanDiscount: Math.max(0, toNumberSafe(data.exploreLoanDiscount)),
        driverExpenseCredit: Object.prototype.hasOwnProperty.call(data,"driverExpenseCredit") ? Math.max(0,toNumberSafe(data.driverExpenseCredit)) : Math.max(0,toNumberSafe(data.driverPaidSharedExpenses))*.5,
        adminExpenseCredit: Object.prototype.hasOwnProperty.call(data,"adminExpenseCredit") ? Math.max(0,toNumberSafe(data.adminExpenseCredit)) : Math.max(0,toNumberSafe(data.adminPaidSharedExpenses))*.5 + Math.max(0,toNumberSafe(data.operationalLoanDriverShare)),
        operationLedger: Array.isArray(data.operationLedger) ? data.operationLedger.slice(-160) : [],
        processedOperationIds: Array.isArray(data.processedOperationIds) ? data.processedOperationIds.slice(-160) : Array.isArray(data.operacionesProcesadas) ? data.operacionesProcesadas.slice(-160) : [],
                collaborationAmount,
        repairFundRate,
        repairFundAmount,
                derivationBonusAmount,
                performanceDerivationPercent: Math.max(0, Number(data.performanceDerivationPercent || 0)),
        driverBaseShare: grossBilling * .5,
        adminBaseShare: grossBilling * .5,
        driverFinalEntitlement: grossBilling * .5 + derivationBonusAmount - collaborationAmount,
        adminFinalEntitlement: grossBilling * .5 - derivationBonusAmount + collaborationAmount + repairFundAmount,
        settlementToDriver: Math.max(0, toNumberSafe(data.settlementToDriver)),
        settlementToAdmin: Math.max(0, toNumberSafe(data.settlementToAdmin)),
        payerRole: data.payerRole || null,
        payeeRole: data.payeeRole || null,
        settlementAmount: Math.max(0, toNumberSafe(data.settlementAmount)),
        balanced: data.balanced === true || Math.abs(toNumberSafe(data.settlementAmount)) <= 1
      };
      return {
        schemaVersion: Number(data.schemaVersion || 0),
        uid, weeklyPeriodId: period.id,
        startAt: new Date(period.startMs), endAt: new Date(period.endMs), timezone: "America/Argentina/Cordoba",
        services: [], expenses: [], operationalLoans: [], directDebtInstallments: base.directDebtInstallments || [], derivations: [],
        serviceCount, grossBilling, expenseCount, totalExpenses,
        validDerivations: Math.max(0, Number(data.validDerivations ?? data.derivacionesValidas ?? 0)),
        receivedValidDerivations: Math.max(0, Number(data.receivedValidDerivations ?? data.derivacionesRecibidasValidas ?? 0)),
        exploraLoanLookbackId: String(data.exploraLoanLookbackId || data.exploraLoanLookback?.id || ""), exploraLoanLookback: data.exploraLoanLookback || null,
        exploraLoanLookbackBilling: Math.max(0, toNumberSafe(data.exploraLoanLookbackBilling)), activeWeeks: Math.max(0, Number(data.activeWeeks || 0)),
        requirements: data.requirements || {}, requirementList: Array.isArray(data.requirementList) ? data.requirementList : [], requirementsMet: Math.max(0, Number(data.requirementsMet || 0)),
        activeLoan: data.activeLoan || null, availableBenefit: Math.max(0, toNumberSafe(data.availableBenefit ?? data.benefitAvailable)), benefitAvailable: Math.max(0, toNumberSafe(data.availableBenefit ?? data.benefitAvailable)), eligibility: data.eligibility || null,
        exploreLoanOriginalAmount: Math.max(0, toNumberSafe(data.exploreLoanOriginalAmount)), exploreLoanBalance: Math.max(0, toNumberSafe(data.exploreLoanBalance)), exploreLoanWeeklyDiscount: Math.max(0, toNumberSafe(data.exploreLoanWeeklyDiscount)), exploreLoanDiscount: Math.max(0, toNumberSafe(data.exploreLoanDiscount)),
        kingOfDayAchieved: data.kingOfDayAchieved === true, kingOfWeekAchieved: data.kingOfWeekAchieved === true, kingOfLoanLookbackAchieved: data.kingOfLoanLookbackAchieved === true,
        derivedAmountForEmitter: Math.max(0, toNumberSafe(data.derivedAmountForEmitter)),
        collaborationAmount,
        dailyBilling: Array.isArray(data.dailyBilling) ? data.dailyBilling.slice(0,7) : Array(7).fill(0),
        performanceResult,
        closureId: data.closureId || null,
        closureStatus: data.closureStatus || "open",
        weeklyReceiptRequired: Boolean(data.weeklyReceiptRequired),
        weeklyReceiptStatus: data.weeklyReceiptStatus || "not_required",
        weeklyReceiptUrl: data.weeklyReceiptUrl || null,
        receiptDeadline: data.receiptDeadline || null,
        performanceEligible: data.performanceEligible !== false,
        ...base,
        loading:false, error:null, calculatedAt:new Date(), fromMaterializedSnapshot:true
      };
    }

    const weeklySnapshotCache = new Map();
    const weeklyState = {
      uid:null, weeklyPeriodId:null, period:null, snapshot:null,
      services:[], currentServices:[], serviceCount:0, grossBilling:0,
      validDerivations:0, derivedAmountForEmitter:0, collaborationAmount:0, repairFundRate:.05, repairFundAmount:0, expenses:0, totalExpenses:0, expenseCount:0, expenseRows:[],
      operationalLoans:[], operationalLoanTotal:0, directDebtInstallments:[], directDebtInstallmentTotal:0,
      receivedValidDerivations:0, exploreLoanDiscount:0, exploreLoanOriginalAmount:0, exploreLoanBalance:0, exploreLoanWeeklyDiscount:0, exploraLoanLookbackId:"", exploraLoanLookback:null, exploraLoanLookbackBilling:0, activeWeeks:0, requirements:{}, requirementList:[], requirementsMet:0, activeLoan:null, availableBenefit:0, benefitAvailable:0, eligibility:null, kingOfDayAchieved:false, kingOfWeekAchieved:false, kingOfLoanLookbackAchieved:false,
      cashCollectedByDriver:0, transferCollectedByAdmin:0, cardCollectedByAdmin:0, aliasCollectedByAdmin:0, qrCollectedByAdmin:0, totalCollectedByAdmin:0,
      driverPaidSharedExpenses:0, adminPaidSharedExpenses:0,
      operationalLoanDriverShare:0, operationalLoanAdminShare:0,
      derivationBonusAmount:0, performanceDerivationPercent:0, driverBaseShare:0, adminBaseShare:0,
      driverFinalEntitlement:0, adminFinalEntitlement:0,
      settlementToDriver:0, settlementToAdmin:0, payerRole:null, payeeRole:null, settlementAmount:0, balanced:false,
      dailyBilling:Array(7).fill(0), performancePercent:0, performanceResult:null, closure:null,
      loading:true, loaded:false, error:null, sourceErrors:{},
      raw:{ viajes:[], derivaciones:[], gastos:[], prestamos:[] },
      subscribers:new Set(), waiters:[], loadPromise:null, loadedAt:null,
      dirty:true, dirtyReason:"initial", loadSequence:0, refreshTimer:0, reconcilePromise:null
    };

    function buildSnapshotCacheKey(uid, periodId) {
      return `v2440|${String(uid || "").toLowerCase()}|${String(exploraSession.role || "unknown").toLowerCase()}|${String(periodId || "")}|open`;
    }

    function getIdentitySetForDriver(uid, performanceResult) {
      const key = String(uid || "").toLowerCase();
      const identities = new Set([key]);
      const currentUid = String(auth.currentUser?.uid || "").toLowerCase();
      if (key && key === currentUid) {
        currentWeeklyProfileAliases()
          .map(value => String(value || "").toLowerCase())
          .filter(Boolean)
          .forEach(value => identities.add(value));
      }
      const row = performanceResult?.rows?.find(item =>
        [item.uid, item.choferId, ...(item.aliases || [])]
          .some(value => String(value || "").toLowerCase() === key)
      );
      if (row) [row.uid, row.choferId, ...(row.aliases || [])]
        .map(value => String(value || "").toLowerCase())
        .filter(Boolean)
        .forEach(value => identities.add(value));
      return { identities, row };
    }

    function recordMatchesIdentitySet(data = {}, identities = new Set()) {
      return getRecordDriverAliases(data).some(alias => identities.has(String(alias || "").toLowerCase()));
    }



    const EXPLORE_LOAN_MOVEMENT_DAYS_REQUIRED = 52;
    const EXPLORE_LOAN_MOVEMENT_DAYS_WINDOW = 56;
    const EXPLORE_LOAN_INSTALLMENTS = EXPLORE_LOAN_MAX_INSTALLMENTS;
    const EXPLORE_LOAN_RATE = EXPLORE_LOAN_MAX_AMOUNT_RATE;
    const EXPLORE_LOAN_COLLECTION = "prestamos_explora";
    const EXPLORE_LOAN_HISTORY_COLLECTION = "prestamos_explora_historial";
    const EXPLORE_LOAN_LOOKBACK_HISTORY_COLLECTION = "prestamos_explora_ventanas_8s";
    const EXPLORE_LOAN_PUBLIC_LOOKBACK_COLLECTION = "prestamos_explora_ventanas_publicas_8s";
    const exploreLoanSourceCache = new Map();
    const exploreLoanLookbackRankingCache = new Map();
    const EXPLORE_LOAN_DRIVER_PRIMARY_FIELD = "driverUid";
    const EXPLORE_LOAN_DRIVER_LEGACY_FIELDS = ["choferUid", "uid", "driverId", "choferId"];
    const EXPLORE_LOAN_DRIVER_ALIAS_FIELDS = [EXPLORE_LOAN_DRIVER_PRIMARY_FIELD, ...EXPLORE_LOAN_DRIVER_LEGACY_FIELDS];
    const exploreLoanDiagnosticSeen = new Set();
    const EXPLORE_LOAN_DIAGNOSTIC_STAGES = Object.freeze([
      "REQUIREMENT_RENDER",
      "REQUIREMENT_UNLOCK",
      "REQUIREMENT_PROGRESS",
      "LOAN_CALCULATION",
      "LOAN_RENDER",
      "LOAN_REQUEST",
      "LOAN_ACTIVE_STATE",
      "LOAN_PENDING_LIST",
      "LOAN_ADMIN_ACTION"
    ]);
    const EXPLORE_LOAN_DIAGNOSTIC_CODES = Object.freeze([
      "REQUIREMENT_RENDER_FAILED",
      "REQUIREMENT_PROGRESS_FAILED",
      "LOAN_ENGINE_FAILED",
      "FIRESTORE_DOC_NOT_AVAILABLE",
      "LOAN_SNAPSHOT_FAILED",
      "LOAN_ACTIVE_STATE_FAILED",
      "LOAN_RENDER_FAILED",
      "LOAN_AMOUNT_INVALID",
      "LOAN_AMOUNT_EXCEEDS_MAX",
      "LOAN_ADMIN_REQUIRED",
      "LOAN_DRIVER_REQUIRED",
      "LOAN_PENDING_LIST_FAILED",
      "LOAN_PENDING_QUERY_PARTIAL",
      "LOAN_PENDING_NOT_FOUND",
      "LOAN_NOT_PENDING",
      "LOAN_BILLING_8W_INCOMPLETE",
      "LOAN_RHYTHM_REAL_INCOMPLETE",
      "LOAN_CLOSURES_PENDING",
      "LOAN_COLLABORATION_REQUIRED",
      "LOAN_REQUEST_REJECTED"
    ]);

    function exploreLoanPeriodKey(periodId = "") {
      const match = String(periodId || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
    }

    function exploreLoanLookbackForPeriod(period = getActiveWeeklyPeriod()) {
      const base = typeof canonicalPreviousWeeklyPeriod === "function" ? canonicalPreviousWeeklyPeriod(period, "America/Argentina/Cordoba") : period;
      return exploreLoanLookbackFromPeriod(base, "America/Argentina/Cordoba");
    }

    function normalizeExploreLoanRequirement(raw = {}, fallback = {}) {
      return {
        id: String(raw.id || fallback.id || ""),
        name: String(raw.name || fallback.name || ""),
        icon: String(raw.icon || fallback.icon || "🏅"),
        progress: Math.max(0, Number(raw.progress ?? fallback.progress ?? 0) || 0),
        target: Math.max(1, Number(raw.target ?? fallback.target ?? 1) || 1),
        unlocked: raw.unlocked === true || fallback.unlocked === true,
        statusText: String(raw.statusText || fallback.statusText || "PENDIENTE")
      };
    }

    function exploreLoanRole() {
      return String(exploraSession.role || exploraSession.profile?.role || exploraSession.profile?.rol || "chofer").toLowerCase();
    }

    function reportExploreLoanError(stage, code, error, context = {}) {
      const signature = [stage, code, context.operation || "", context.weeklyPeriodId || "", auth.currentUser?.uid || ""].join("|");
      if (exploreLoanDiagnosticSeen.has(signature)) return;
      exploreLoanDiagnosticSeen.add(signature);
      const loan = context.activeLoan || {};
      const payload = {
        module: "EXPLORE_LOAN_REQUIREMENTS",
        stage,
        code,
        firebaseCode: String(error?.code || error?.cause?.code || "—"),
        firebaseMessage: String(error?.cause?.message || (error?.code ? error?.message : "—") || "—"),
        javascriptMessage: String(error?.message || code || "Error sin mensaje"),
        stack: String(error?.stack || "—"),
        functionName: String(context.functionName || "ExploreLoan"),
        uid: String(auth.currentUser?.uid || "—"),
        role: exploreLoanRole(),
        weeklyPeriodId: String(context.weeklyPeriodId || getActiveWeeklyPeriod().id || "—"),
        exploraLoanLookbackId: String(context.exploraLoanLookbackId || "—"),
        activeLoan: Boolean(loan.active || context.loanActive),
        activeWeeks: Number(context.activeWeeks || 0),
        requirementsMet: Number(context.requirementsMet || 0),
        calculatedAmount: Number(context.calculatedAmount || 0),
        firestorePath: String(context.firestorePath || "—"),
        operation: String(context.operation || "—"),
        timestamp: new Date().toISOString()
      };
      window.dispatchEvent(new CustomEvent("explora:loan-diagnostic", { detail: payload }));
    }


    async function readExploreLoanLookbackLeaderboard(lookback, { force = false } = {}) {
      const key = String(lookback?.id || "");
      const cached = exploreLoanLookbackRankingCache.get(key);
      if (!force && cached && Date.now() - cached.savedAt < 60000) return cached.data;
      const totals = new Map();
      try {
        const periodIds = Array.isArray(lookback?.periods) ? lookback.periods : [];
        const results = await Promise.all(periodIds.map(periodId =>
          getDocs(query(collection(db, WEEKLY_SNAPSHOT_COLLECTION), where("weeklyPeriodId", "==", periodId))).catch(() => ({ docs:[] }))
        ));
        results.forEach(result => {
          result.docs.forEach(item => {
            const row = item.data() || {};
            const driverUid = String(row.driverUid || row.uid || row.choferUid || row.driverId || row.choferId || "").trim();
            if (!driverUid) return;
            totals.set(driverUid, (totals.get(driverUid) || 0) + Math.max(0, toNumberSafe(row.grossBilling ?? row.facturacion)));
          });
        });
      } catch (error) {
        reportExploreLoanError("LOAN_CALCULATION", "LOAN_SNAPSHOT_FAILED", error, { functionName:"readExploreLoanLookbackLeaderboard", exploraLoanLookbackId:lookback?.id, firestorePath:WEEKLY_SNAPSHOT_COLLECTION, operation:"read 8-week lookback ranking from weekly snapshots by period" });
      }
      const data = { totals:Object.fromEntries(totals), leaderUid:[...totals.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0] || "" };
      exploreLoanLookbackRankingCache.set(key, { savedAt:Date.now(), data });
      return data;
    }

    async function readScopedRowsByDriver(collectionName, uid, lookback, aliases = EXPLORE_LOAN_DRIVER_ALIAS_FIELDS) {
      const periodSet = new Set(lookback.periods || []);
      const seen = new Set(), rows = [], failures = [];
      const fields = Array.from(new Set(aliases)).filter(Boolean);
      const collect = (result) => {
        (result?.docs || []).forEach(item => {
          if (seen.has(item.id)) return;
          const row = { id:item.id, ...(item.data() || {}) };
          const periodId = String(row.weeklyPeriodId || row.periodoSemanalId || row.periodId || "");
          const recordMs = getDocTimeMs(row);
          const inRangeByDate = Number.isFinite(recordMs) && recordMs >= lookback.startMs && recordMs <= lookback.endMs;
          if (!periodSet.has(periodId) && !inRangeByDate) return;
          seen.add(item.id); rows.push(row);
        });
      };
      const results = await Promise.allSettled(fields.map(field =>
        getDocs(query(collection(db, collectionName), where(field, "==", uid))).then(result => ({ field, result }))
      ));
      results.forEach(item => {
        if (item.status === "fulfilled") collect(item.value.result);
        else failures.push(item.reason);
      });
      if (!rows.length && failures.length === fields.length) throw failures[0] || new Error(`No se pudo leer ${collectionName}`);
      return rows;
    }

    async function readExploreLoanSources(uid, lookback, { force = false } = {}) {
      const key = `${uid}|${lookback.id}`;
      const cached = exploreLoanSourceCache.get(key);
      if (!force && cached && Date.now() - cached.savedAt < 60000) return cached.data;
      const snapshotsPromise = readScopedRowsByDriver(WEEKLY_SNAPSHOT_COLLECTION, uid, lookback)
        .catch(error => { if (!String(error?.code || "").includes("permission-denied")) reportExploreLoanError("LOAN_CALCULATION", "LOAN_SNAPSHOT_FAILED", error, { functionName:"readExploreLoanSources", exploraLoanLookbackId:lookback.id, firestorePath:WEEKLY_SNAPSHOT_COLLECTION, operation:"read 8-week lookback snapshots by driver aliases" }); return []; });
      const loanPromise = getDoc(doc(db, EXPLORE_LOAN_COLLECTION, uid))
        .then(result => result.exists() ? ({ id:result.id, ...(result.data() || {}) }) : null)
        .catch(error => { reportExploreLoanError("LOAN_ACTIVE_STATE", "LOAN_ACTIVE_STATE_FAILED", error, { functionName:"readExploreLoanSources", exploraLoanLookbackId:lookback.id, firestorePath:`${EXPLORE_LOAN_COLLECTION}/${uid}`, operation:"read active loan" }); return null; });
      const closuresPromise = readScopedRowsByDriver("cierres_semanales", uid, lookback)
        .catch(() => []);
      const billingRecordsPromise = readScopedRowsByDriver("billing_records", uid, lookback)
        .catch(() => []);
      const lookbackLeaderboardPromise = readExploreLoanLookbackLeaderboard(lookback, { force });
      const [snapshots, activeLoan, closures, billingRecords, lookbackLeaderboard] = await Promise.all([snapshotsPromise, loanPromise, closuresPromise, billingRecordsPromise, lookbackLeaderboardPromise]);
      const data = { snapshots, activeLoan, closures, billingRecords, lookbackLeaderboard };
      exploreLoanSourceCache.set(key, { savedAt:Date.now(), data });
      return data;
    }

    function calculateDailyLeadership(performanceResult = null, identities = new Set(), period = getActiveWeeklyPeriod()) {
      const byDate = new Map();
      for (const service of performanceResult?.services || []) {
        if (!isServiceValidForWeeklyTotals(service)) continue;
        const ms = getDocTimeMs(service);
        if (ms < period.startMs || ms > period.endMs) continue;
        const date = new Date(ms - 10800000);
        const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}-${String(date.getUTCDate()).padStart(2,"0")}`;
        const driverKey = String(getDriverUidFromRecord(service) || getDriverIdFromTrip(service) || "").toLowerCase();
        if (!driverKey) continue;
        if (!byDate.has(key)) byDate.set(key, new Map());
        const totals = byDate.get(key);
        totals.set(driverKey, (totals.get(driverKey) || 0) + Math.max(0, getMoneyValue(service)));
      }
      for (const totals of byDate.values()) {
        const leader = [...totals.entries()].sort((a,b) => b[1] - a[1])[0];
        if (leader && identities.has(String(leader[0] || "").toLowerCase()) && leader[1] > 0) return true;
      }
      return false;
    }

    function calculateWeeklyLeadership(performanceResult = null, identities = new Set()) {
      const leader = [...(performanceResult?.rows || [])].sort((a,b) => Number(b.facturacion || b.grossBilling || 0) - Number(a.facturacion || a.grossBilling || 0))[0];
      if (!leader || Number(leader.facturacion || leader.grossBilling || 0) <= 0) return false;
      return [leader.uid, leader.choferId, ...(leader.aliases || [])].some(value => identities.has(String(value || "").toLowerCase()));
    }

    function normalizeExploreLoanDocument(data = null) {
      if (!data) return null;
      const status = String(data.status || data.estado || "").toLowerCase();
      const originalAmount = Math.max(0, toNumberSafe(data.originalAmount ?? data.montoOriginal ?? data.amount ?? data.montoSolicitado ?? data.totalToReturn));
      const balance = Math.max(0, toNumberSafe(data.balance ?? data.saldoPendiente ?? data.remainingAmount ?? originalAmount));
      const approvedByDavid = data.approvedByDavid === true || data.approved === true || status === "active" || status === "activo";
      const active = (status === "active" || status === "activo" || data.active === true) && balance > 0;
      const pendingApproval = !active && (["pending_approval","pendiente_aprobacion","pending","pendiente"].includes(status) || data.pendingApproval === true || (data.approvalRequired === true && approvedByDavid !== true));
      return {
        id: String(data.loanId || data.id || ""),
        active,
        pendingApproval,
        status: active ? "active" : pendingApproval ? "pending_approval" : status || "closed",
        originalAmount,
        balance,
        weeklyDiscount: Math.max(0, toNumberSafe(data.weeklyDiscount ?? data.descuentoSemanal ?? data.installmentAmount ?? (originalAmount ? Math.ceil(originalAmount / EXPLORE_LOAN_MAX_INSTALLMENTS) : 0))),
        installments: Math.min(EXPLORE_LOAN_MAX_INSTALLMENTS, Math.max(1, Number(data.installments || data.cuotas || EXPLORE_LOAN_MAX_INSTALLMENTS))),
        requestedAt: data.requestedAt || null,
        cancelledAt: data.cancelledAt || null,
        approvedByDavid, approvedAt:data.approvedAt || null, approvedBy:String(data.approvedBy || ""),
        rejectedAt:data.rejectedAt || null, rejectionReason:String(data.rejectionReason || ""),
        exploraLoanLookbackId: String(data.exploraLoanLookbackId || data.loanLookbackId || data.cycleId || ""),
        weeklyPeriodId: String(data.weeklyPeriodId || data.startWeeklyPeriodId || ""),
        paidWeeklyPeriodIds: Array.isArray(data.paidWeeklyPeriodIds) ? data.paidWeeklyPeriodIds : []
      };
    }

    function resolveExploreLoanDriverIdentity(uid = "") {
      const profile = exploraSession.profile || {};
      const user = auth.currentUser || exploraSession.authUser || {};
      const driverName = String(getProfileName(profile, user) || profile.driverName || profile.choferNombre || "Chofer").trim() || "Chofer";
      const username = String(profile.usuario || profile.username || exploraSession.driverId || normalizedEmailUser(user) || "").trim();
      const vehicle = String(resolveAssignedVehicle(profile, exploraSession.vehicle || {}).displayName || "").trim();
      return {
        driverUid:String(uid || user.uid || "").trim(),
        driverName,
        choferNombre:driverName,
        nombre:driverName,
        driverUsername:username,
        usuario:username,
        driverVehicle:vehicle,
        vehiculo:vehicle
      };
    }

    function exploreLoanMovementDaysFromRow(row = {}) {
      const rawDaily = Array.isArray(row.dailyBilling) ? row.dailyBilling : Array.isArray(row.facturacionDiaria) ? row.facturacionDiaria : [];
      if (rawDaily.length) {
        const byIndex = new Map();
        rawDaily.forEach((entry, index) => {
          if (entry && typeof entry === "object") {
            const dayIndex = Number(entry.dayIndex ?? entry.index ?? index);
            const amount = toNumberSafe(entry.amount ?? entry.total ?? entry.billing ?? entry.facturacion ?? 0);
            if (Number.isFinite(dayIndex) && dayIndex >= 0 && dayIndex <= 6) byIndex.set(dayIndex, Math.max(byIndex.get(dayIndex) || 0, amount));
          } else if (index < 7) {
            byIndex.set(index, Math.max(byIndex.get(index) || 0, toNumberSafe(entry)));
          }
        });
        return Array.from({ length:7 }, (_, index) => Math.max(0, byIndex.get(index) || 0) > 0).filter(Boolean).length;
      }
      const movementDates = new Set();
      const rawDates = Array.isArray(row.movementDateIds) ? row.movementDateIds : Array.isArray(row.dateIds) ? row.dateIds : [];
      rawDates.map(String).filter(Boolean).forEach(value => movementDates.add(value));
      if (movementDates.size) return Math.min(7, movementDates.size);
      return 0;
    }


    function exploreLoanMovementDaysFromBillingRecords(records = [], lookback) {
      const days = new Set();
      (Array.isArray(records) ? records : []).forEach(row => {
        if (!isServiceValidForWeeklyTotals(row)) return;
        const amount = Math.max(0, getMoneyValue(row) || toNumberSafe(row.amount ?? row.monto ?? row.total ?? row.facturacion));
        if (!(amount > 0)) return;
        const ms = getDocTimeMs(row);
        if (!Number.isFinite(ms) || ms < lookback.startMs || ms > lookback.endMs) return;
        const parts = new Intl.DateTimeFormat("en-CA", { timeZone:"America/Argentina/Cordoba", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date(ms)).reduce((acc, part) => { if (part.type !== "literal") acc[part.type] = part.value; return acc; }, {});
        days.add(`${parts.year}-${parts.month}-${parts.day}`);
      });
      return Math.min(EXPLORE_LOAN_MOVEMENT_DAYS_WINDOW, days.size);
    }

    function exploreLoanBillingByPeriodFromRecords(records = [], lookback) {
      const totals = Object.fromEntries((lookback.periods || []).map(id => [id, 0]));
      (Array.isArray(records) ? records : []).forEach(row => {
        if (!isServiceValidForWeeklyTotals(row)) return;
        const amount = Math.max(0, getMoneyValue(row) || toNumberSafe(row.amount ?? row.monto ?? row.total ?? row.facturacion));
        if (!(amount > 0)) return;
        let periodId = String(row.weeklyPeriodId || row.periodoSemanalId || row.periodId || "");
        const ms = getDocTimeMs(row);
        if (!periodId && Number.isFinite(ms)) periodId = canonicalWeeklyPeriodFromDate(new Date(ms), "America/Argentina/Cordoba").id;
        if (Object.prototype.hasOwnProperty.call(totals, periodId)) totals[periodId] += amount;
      });
      return totals;
    }

    function exploreLoanClosureIsUpToDate(closures = [], requiredPeriods = []) {
      const required = requiredPeriods.map(String).filter(Boolean);
      if (required.length !== EXPLORE_LOAN_LOOKBACK_WEEKS) return false;
      const pendingTokens = ["pending","pendiente","overdue","vencido","proof_required","receipt_pending","driver_pending","under_review"];
      const paidTokens = ["paid","pagado","balanced","equilibrado","closed","cerrado","approved","aprobado","confirmado","liquidado"];
      const byPeriod = new Map();
      (closures || []).forEach(row => {
        const periodId = String(row.weeklyPeriodId || row.periodoSemanalId || row.periodId || "");
        if (!required.includes(periodId)) return;
        const state = String(row.status || row.estado || row.receiptStatus || row.paymentStatus || "").toLowerCase();
        const pending = pendingTokens.some(token => state.includes(token));
        const paid = paidTokens.some(token => state.includes(token)) || row.confirmed === true || row.adminConfirmed === true || row.approvedByDavid === true || row.paymentConfirmed === true;
        byPeriod.set(periodId, { pending, paid, state });
      });
      if ([...byPeriod.values()].some(row => row.pending)) return false;
      return required.every(periodId => byPeriod.get(periodId)?.paid === true);
    }

    async function buildExploreLoanState(uid, period, current = {}) {
      const lookback = exploreLoanLookbackForPeriod(period);
      const sources = await readExploreLoanSources(uid, lookback);
      const historical = new Map();
      (sources.snapshots || []).forEach(row => historical.set(String(row.weeklyPeriodId || row.periodoSemanalId || row.periodId || ""), row));
      const lookbackRows = lookback.periods.map(id => historical.get(id)).filter(Boolean);
      const billingFromRecords = exploreLoanBillingByPeriodFromRecords(sources.billingRecords || [], lookback);
      const billingByPeriod = Object.fromEntries(lookback.periods.map(id => {
        const row = historical.get(id) || {};
        const snapshotBilling = Math.max(0, toNumberSafe(row.grossBilling ?? row.facturacion));
        return [id, Math.max(snapshotBilling, Math.max(0, toNumberSafe(billingFromRecords[id])))];
      }));
      const validBilling8Weeks = Math.round(Object.values(billingByPeriod).reduce((sum, value) => sum + Math.max(0, toNumberSafe(value)), 0));
      const movementFromSnapshots = lookback.periods.reduce((sum, id) => sum + exploreLoanMovementDaysFromRow(historical.get(id) || {}), 0);
      const movementDays = Math.max(movementFromSnapshots, exploreLoanMovementDaysFromBillingRecords(sources.billingRecords || [], lookback));
      const activeWeeks = lookbackRows.filter(row => Math.max(0, Number(row.serviceCount || row.billingCount || 0)) > 0 || Math.max(0, toNumberSafe(row.grossBilling ?? row.facturacion)) > 0 || Math.max(0, Number(row.expenseCount || 0)) > 0 || Math.max(0, Number(row.validDerivations || 0)) > 0).length;
      const closureUpToDate = exploreLoanClosureIsUpToDate(sources.closures || [], lookback.periods);
      const collaborationAmount = lookbackRows.reduce((sum,row) => sum + Math.max(0, toNumberSafe(row.collaborationAmount ?? row.colaboracionExplora ?? row.derivationCollaborationAmount)), 0);
      const sentCount = lookbackRows.reduce((sum,row) => sum + Math.max(0, Number(row.validDerivations || row.derivacionesValidas || 0)), 0);
      const receivedCount = lookbackRows.reduce((sum,row) => sum + Math.max(0, Number(row.receivedValidDerivations || row.derivacionesRecibidasValidas || 0)), 0);
      const collaborationOk = collaborationAmount > 0 || sentCount > 0;
      const activeLoan = normalizeExploreLoanDocument(sources.activeLoan);
      const hasPendingApproval = activeLoan?.pendingApproval === true;
      const noActiveLoan = !activeLoan?.active && !hasPendingApproval;
      const availableBenefit = Math.max(0, Math.round(validBilling8Weeks * EXPLORE_LOAN_RATE));
      const movementOk = movementDays >= EXPLORE_LOAN_MOVEMENT_DAYS_REQUIRED;
      const validBillingOk = lookbackRows.length === EXPLORE_LOAN_LOOKBACK_WEEKS && validBilling8Weeks > 0 && lookback.periods.every(id => Math.max(0, toNumberSafe(billingByPeriod[id])) > 0);
      const davidApproval = Boolean(activeLoan?.approvedByDavid);
      const eligibility = {
        validBilling8Weeks: validBillingOk,
        rhythmReal: movementOk,
        movementDays,
        movementDaysRequired: EXPLORE_LOAN_MOVEMENT_DAYS_REQUIRED,
        movementDaysWindow: EXPLORE_LOAN_MOVEMENT_DAYS_WINDOW,
        closureUpToDate,
        collaborationOk,
        noActiveLoan,
        noPendingApproval: !hasPendingApproval,
        davidApproval,
        approvalRequired: true,
        eligible: validBillingOk && movementOk && closureUpToDate && collaborationOk && noActiveLoan
      };
      const requirementDefinitions = [
        normalizeExploreLoanRequirement({ id:"validBilling8Weeks", name:"FACTURACIÓN VÁLIDA 8 SEMANAS", icon:"💰", progress:validBillingOk ? 1 : 0, target:1, unlocked:validBillingOk, statusText:validBillingOk ? "✓ ACTIVA" : "PENDIENTE" }),
        normalizeExploreLoanRequirement({ id:"rhythmReal", name:"RITMO REAL", icon:"📆", progress:movementDays, target:EXPLORE_LOAN_MOVEMENT_DAYS_REQUIRED, unlocked:movementOk, statusText:`${Math.min(movementDays, EXPLORE_LOAN_MOVEMENT_DAYS_WINDOW)} / ${EXPLORE_LOAN_MOVEMENT_DAYS_WINDOW} días` }),
        normalizeExploreLoanRequirement({ id:"closureUpToDate", name:"CIERRES AL DÍA", icon:"✅", progress:closureUpToDate ? 1 : 0, target:1, unlocked:closureUpToDate, statusText:closureUpToDate ? "✓ AL DÍA" : "PENDIENTE" }),
        normalizeExploreLoanRequirement({ id:"collaborationOk", name:"COLABORACIÓN EXPLORA", icon:"🤝", progress:collaborationOk ? 1 : 0, target:1, unlocked:collaborationOk, statusText:collaborationOk ? "✓ ACTIVA" : "PENDIENTE" }),
        normalizeExploreLoanRequirement({ id:"noActiveLoan", name:"SIN PRÉSTAMO ACTIVO", icon:"🔓", progress:noActiveLoan ? 1 : 0, target:1, unlocked:noActiveLoan, statusText:noActiveLoan ? "✓ LIBRE" : hasPendingApproval ? "PENDIENTE DAVID" : "ACTIVO" }),
        normalizeExploreLoanRequirement({ id:"davidApproval", name:"APROBACIÓN DE DAVID", icon:"✍️", progress:davidApproval ? 1 : 0, target:1, unlocked:davidApproval, statusText:davidApproval ? "✓ APROBADA" : hasPendingApproval ? "SOLICITADA" : "REQUERIDA" })
      ];
      const requirements = Object.fromEntries(requirementDefinitions.map(item => [item.id, item]));
      const requirementsMet = requirementDefinitions.filter(item => item.unlocked).length;
      return {
        exploraLoanLookbackId:lookback.id,
        exploraLoanLookback:lookback,
        exploraLoanLookbackBilling:validBilling8Weeks,
        validBilling8Weeks,
        billingByPeriod,
        activeWeeks,
        movementDays,
        collaborationAmount,
        requirements,
        requirementList:requirementDefinitions,
        requirementsMet,
        activeLoan,
        availableBenefit,
        benefitAvailable:availableBenefit,
        eligibility,
        loanMaxInstallments:EXPLORE_LOAN_INSTALLMENTS,
        loanInterestRate:0
      };
    }

    async function archivePreviousExploreLoanLookback(uid, currentLookback) {
      if (!currentLookback?.startPeriodId) return;
      const currentStart = exploreLoanPeriodKey(currentLookback.startPeriodId);
      if (!Number.isFinite(currentStart)) return;
      const previousEndKey = currentStart - 604800000;
      const previousPeriod = { id:formatDateIdFromUTCDate(new Date(previousEndKey)) };
      const previousLookback = exploreLoanLookbackFromPeriod(previousPeriod, "America/Argentina/Cordoba");
      const historyRef = doc(db, EXPLORE_LOAN_LOOKBACK_HISTORY_COLLECTION, `${uid}_${previousLookback.id}`);
      const existing = await getDoc(historyRef).catch(() => null);
      if (existing?.exists()) return;
      const sources = await readExploreLoanSources(uid, previousLookback, { force:true });
      if (!(sources.snapshots || []).length) return;
      const exploraLoanLookbackBilling = Math.round((sources.snapshots || []).reduce((sum,row) => sum + Math.max(0,toNumberSafe(row.grossBilling ?? row.facturacion)),0));
      const last = [...(sources.snapshots || [])].sort((a,b) => String(a.weeklyPeriodId || "").localeCompare(String(b.weeklyPeriodId || ""))).at(-1) || {};
      await setDoc(historyRef, {
        driverUid:uid, exploraLoanLookbackId:previousLookback.id, startPeriodId:previousLookback.startPeriodId, endPeriodId:previousLookback.endPeriodId,
        requirements:last.requirements || {}, requirementsMet:Number(last.requirementsMet || 0), loanGranted:Boolean(last.activeLoan || last.exploreLoanOriginalAmount),
        loanCancelled:Boolean(last.activeLoan?.status === "cancelled" || last.exploreLoanBalance === 0), exploraLoanLookbackBilling,
        startedAt:new Date(previousLookback.startMs), endedAt:new Date(previousLookback.endMs), archivedAt:serverTimestamp(), updatedAt:serverTimestamp()
      }, { merge:true });
    }

    async function requestExploreLoan(driverUid, options = {}) {
      if (typeof doc !== "function") {
        const error = Object.assign(new Error("La referencia de Firestore no está disponible en el módulo principal."), { code:"FIRESTORE_DOC_NOT_AVAILABLE" });
        reportExploreLoanError("LOAN_REQUEST", "FIRESTORE_DOC_NOT_AVAILABLE", error, { functionName:"requestExploreLoan", firestorePath:EXPLORE_LOAN_COLLECTION, operation:"request loan" });
        throw error;
      }
      const uid = String(driverUid || auth.currentUser?.uid || "").trim();
      if (!uid || uid !== auth.currentUser?.uid) throw Object.assign(new Error("El beneficio no corresponde al usuario autenticado."), { code:"LOAN_SNAPSHOT_FAILED" });
      const snapshot = await getExploreLoanSnapshot(uid, { force:true });
      if (!snapshot?.eligibility?.noActiveLoan) throw Object.assign(new Error("Ya tenés un Préstamo EXPLORA activo o pendiente de aprobación."), { code:"LOAN_ACTIVE_STATE_FAILED" });
      if (!snapshot?.eligibility?.validBilling8Weeks) throw Object.assign(new Error("Todavía no tenés facturación válida en las últimas 8 semanas."), { code:"LOAN_BILLING_8W_INCOMPLETE" });
      if (!snapshot?.eligibility?.rhythmReal) throw Object.assign(new Error("Todavía no cumplís Ritmo Real: 52 de 56 días con movimiento."), { code:"LOAN_RHYTHM_REAL_INCOMPLETE" });
      if (!snapshot?.eligibility?.closureUpToDate) throw Object.assign(new Error("Tenés cierres abiertos."), { code:"LOAN_CLOSURES_PENDING" });
      if (!snapshot?.eligibility?.collaborationOk) throw Object.assign(new Error("Todavía falta colaboración EXPLORA."), { code:"LOAN_COLLABORATION_REQUIRED" });
      const maxAmount = Math.round(Number(snapshot.availableBenefit || 0));
      const requestedAmount = Math.round(Number(options.amount || options.monto || maxAmount));
      const amount = requestedAmount;
      const installments = Math.min(EXPLORE_LOAN_MAX_INSTALLMENTS, Math.max(1, Math.round(Number(options.installments || options.cuotas || EXPLORE_LOAN_MAX_INSTALLMENTS))));
      if (!(amount > 0)) throw Object.assign(new Error("El monto solicitado debe ser mayor a cero."), { code:"LOAN_AMOUNT_INVALID" });
      if (amount > maxAmount) throw Object.assign(new Error("El monto solicitado supera tu máximo disponible."), { code:"LOAN_AMOUNT_EXCEEDS_MAX" });
      const weeklyDiscount = Math.max(1, Math.ceil(amount / installments));
      const driverIdentity = resolveExploreLoanDriverIdentity(uid);
      const loanId = `explore_${uid}_${Date.now()}`;
      const loanRef = doc(db, EXPLORE_LOAN_COLLECTION, uid);
      const historyRef = doc(db, EXPLORE_LOAN_HISTORY_COLLECTION, loanId);
      await runTransaction(db, async transaction => {
        const current = await transaction.get(loanRef);
        const existing = current.exists() ? normalizeExploreLoanDocument({ id:current.id, ...(current.data() || {}) }) : null;
        if (existing?.active || existing?.pendingApproval) throw Object.assign(new Error("Ya existe un préstamo Explora activo o pendiente de aprobación."), { code:"LOAN_ACTIVE_STATE_FAILED" });
        const payload = {
          loanId, driverUid:uid, uid, ...driverIdentity, exploraLoanLookbackId:snapshot.exploraLoanLookbackId, weeklyPeriodId:snapshot.weeklyPeriodId,
          originalAmount:amount, montoOriginal:amount, requestedAmount:amount, montoSolicitado:amount, balance:amount, saldoPendiente:amount,
          weeklyDiscount, descuentoSemanal:weeklyDiscount, installments, cuotas:installments, interestRate:0, tasaInteres:0, interestAmount:0, montoInteres:0, totalToReturn:amount, totalADevolver:amount,
          status:"pending_approval", estado:"pendiente_aprobacion", active:false, pendingApproval:true, approvalRequired:true, approvedByDavid:false,
          requirementCount:snapshot.requirementsMet, activeWeeks:snapshot.activeWeeks, movementDays:snapshot.eligibility?.movementDays || snapshot.movementDays || 0, validBilling8Weeks:snapshot.validBilling8Weeks || snapshot.exploraLoanLookbackBilling, exploraLoanLookbackBilling:snapshot.exploraLoanLookbackBilling,
          requestedAt:serverTimestamp(), createdAt:serverTimestamp(), updatedAt:serverTimestamp(), paidWeeklyPeriodIds:[]
        };
        transaction.set(loanRef, payload, { merge:false });
        transaction.set(historyRef, { ...payload, event:"requested" }, { merge:false });
      });
      exploreLoanSourceCache.clear(); exploreLoanLookbackRankingCache.clear();
      invalidateWeeklyEngine("explore-loan-request", { refresh:false });
      window.ExploraFastCache?.clearOperational?.();
      window.dispatchEvent(new CustomEvent("explora:loan-requested", { detail:{ uid, loanId, amount, weeklyDiscount, status:"pending_approval" } }));
      await refreshWeeklyEngine({ force:true, reason:"explore-loan-request" });
      return { loanId, amount, weeklyDiscount };
    }

    function assertExploreLoanAdmin() {
      if (!EXPLORA_ADMIN_UIDS.has(auth.currentUser?.uid || "")) throw Object.assign(new Error("Sólo David puede aprobar o rechazar Préstamo EXPLORA."), { code:"LOAN_ADMIN_REQUIRED" });
    }

    async function approveExploreLoan(driverUid) {
      assertExploreLoanAdmin();
      const uid = String(driverUid || "").trim();
      if (!uid) throw Object.assign(new Error("Chofer requerido para aprobar Préstamo EXPLORA."), { code:"LOAN_DRIVER_REQUIRED" });
      const currentSnapshot = await getExploreLoanSnapshot(uid, { force:true });
      const currentEligibility = currentSnapshot?.eligibility || {};
      if (!currentEligibility.validBilling8Weeks) throw Object.assign(new Error("No se puede aprobar: el chofer ya no cumple facturación válida 8 semanas."), { code:"LOAN_BILLING_8W_INCOMPLETE" });
      if (!currentEligibility.rhythmReal) throw Object.assign(new Error("No se puede aprobar: el chofer ya no cumple Ritmo Real."), { code:"LOAN_RHYTHM_REAL_INCOMPLETE" });
      if (!currentEligibility.closureUpToDate) throw Object.assign(new Error("No se puede aprobar: el chofer tiene cierres abiertos."), { code:"LOAN_CLOSURES_PENDING" });
      if (!currentEligibility.collaborationOk) throw Object.assign(new Error("No se puede aprobar: falta colaboración EXPLORA."), { code:"LOAN_COLLABORATION_REQUIRED" });
      const loanRef = doc(db, EXPLORE_LOAN_COLLECTION, uid);
      return runTransaction(db, async transaction => {
        const snap = await transaction.get(loanRef);
        if (!snap.exists()) throw Object.assign(new Error("No existe solicitud pendiente para aprobar."), { code:"LOAN_PENDING_NOT_FOUND" });
        const data = { id:snap.id, ...(snap.data() || {}) };
        const loan = normalizeExploreLoanDocument(data);
        if (!loan.pendingApproval || loan.active) throw Object.assign(new Error("La solicitud no está pendiente de aprobación."), { code:"LOAN_NOT_PENDING" });
        const originalAmount = Math.round(Math.max(0, toNumberSafe(data.originalAmount ?? data.montoOriginal ?? data.amount ?? data.balance)));
        if (!(originalAmount > 0)) throw Object.assign(new Error("No se puede aprobar una solicitud con monto cero."), { code:"LOAN_AMOUNT_INVALID" });
        const maxAmount = Math.round(Number(currentSnapshot.availableBenefit || 0));
        if (originalAmount > maxAmount) throw Object.assign(new Error("No se puede aprobar: el monto solicitado supera el máximo actual del chofer."), { code:"LOAN_AMOUNT_EXCEEDS_MAX" });
        const installments = Math.min(EXPLORE_LOAN_MAX_INSTALLMENTS, Math.max(1, Number(data.installments || data.cuotas || EXPLORE_LOAN_MAX_INSTALLMENTS)));
        const weeklyDiscount = Math.max(1, Math.ceil(originalAmount / installments));
        const balance = Math.max(0, toNumberSafe(data.balance ?? data.saldoPendiente ?? originalAmount)) || originalAmount;
        const payload = {
          status:"active", estado:"activo", active:true, pendingApproval:false, approvalRequired:false, approvedByDavid:true,
          originalAmount, montoOriginal:originalAmount, balance, saldoPendiente:balance,
          installments, cuotas:installments, totalToReturn:originalAmount, totalADevolver:originalAmount, interestRate:0, tasaInteres:0, interestAmount:0, montoInteres:0,
          approvedBy:auth.currentUser.uid, approvedAt:serverTimestamp(), weeklyDiscount, descuentoSemanal:weeklyDiscount, updatedAt:serverTimestamp()
        };
        transaction.set(loanRef, payload, { merge:true });
        transaction.set(doc(db, EXPLORE_LOAN_HISTORY_COLLECTION, `${data.loanId || uid}_approved_${Date.now()}`), { ...data, ...payload, event:"approved", driverUid:uid, createdAt:serverTimestamp() }, { merge:false });
        return { approved:true, driverUid:uid, weeklyDiscount };
      }).then(result => { exploreLoanSourceCache.clear(); exploreLoanLookbackRankingCache.clear(); window.dispatchEvent(new CustomEvent("explora:loan-approved", { detail:result })); return result; });
    }

    async function rejectExploreLoan(driverUid, reason = "") {
      assertExploreLoanAdmin();
      const uid = String(driverUid || "").trim();
      if (!uid) throw Object.assign(new Error("Chofer requerido para rechazar Préstamo EXPLORA."), { code:"LOAN_DRIVER_REQUIRED" });
      const loanRef = doc(db, EXPLORE_LOAN_COLLECTION, uid);
      return runTransaction(db, async transaction => {
        const snap = await transaction.get(loanRef);
        if (!snap.exists()) throw Object.assign(new Error("No existe solicitud pendiente para rechazar."), { code:"LOAN_PENDING_NOT_FOUND" });
        const data = { id:snap.id, ...(snap.data() || {}) };
        const loan = normalizeExploreLoanDocument(data);
        if (!loan.pendingApproval || loan.active) throw Object.assign(new Error("La solicitud no está pendiente de aprobación."), { code:"LOAN_NOT_PENDING" });
        const payload = { status:"rejected", estado:"rechazado", active:false, pendingApproval:false, approvalRequired:false, approvedByDavid:false, rejectedBy:auth.currentUser.uid, rejectionReason:String(reason || ""), rejectedAt:serverTimestamp(), updatedAt:serverTimestamp() };
        transaction.set(loanRef, payload, { merge:true });
        transaction.set(doc(db, EXPLORE_LOAN_HISTORY_COLLECTION, `${data.loanId || uid}_rejected`), { ...data, ...payload, event:"rejected", driverUid:uid, createdAt:serverTimestamp() }, { merge:false });
        return { rejected:true, driverUid:uid };
      }).then(result => { exploreLoanSourceCache.clear(); exploreLoanLookbackRankingCache.clear(); window.dispatchEvent(new CustomEvent("explora:loan-rejected", { detail:result })); return result; });
    }

    async function listPendingExploreLoans() {
      assertExploreLoanAdmin();
      const seen = new Map();
      const querySpecs = [
        { label:"status:pending_approval", queryRef:query(collection(db, EXPLORE_LOAN_COLLECTION), where("status", "==", "pending_approval")) },
        { label:"estado:pendiente_aprobacion", queryRef:query(collection(db, EXPLORE_LOAN_COLLECTION), where("estado", "==", "pendiente_aprobacion")) },
        { label:"pendingApproval:true", queryRef:query(collection(db, EXPLORE_LOAN_COLLECTION), where("pendingApproval", "==", true)) },
        { label:"status:pending", queryRef:query(collection(db, EXPLORE_LOAN_COLLECTION), where("status", "==", "pending")) },
        { label:"estado:pendiente", queryRef:query(collection(db, EXPLORE_LOAN_COLLECTION), where("estado", "==", "pendiente")) },
        { label:"approvalRequired:true", queryRef:query(collection(db, EXPLORE_LOAN_COLLECTION), where("approvalRequired", "==", true)) }
      ];
      const settled = await Promise.allSettled(querySpecs.map(spec => getDocs(spec.queryRef).then(result => ({ spec, result }))));
      const failures = [];
      settled.forEach(item => {
        if (item.status === "rejected") { failures.push(item.reason); return; }
        item.value.result.docs.forEach(docSnap => {
          const data = { id:docSnap.id, ...(docSnap.data() || {}) };
          const normalized = normalizeExploreLoanDocument(data);
          if (!normalized?.pendingApproval) return;
          const driverUid = String(data.driverUid || data.uid || docSnap.id);
          const driverName = String(data.driverName || data.choferNombre || data.nombre || data.nombreChofer || data.conductorNombre || "Chofer").trim() || "Chofer";
          seen.set(docSnap.id, {
            ...normalized,
            driverUid,
            driverName,
            driverUsername:String(data.driverUsername || data.usuario || data.username || ""),
            driverVehicle:String(data.driverVehicle || data.vehiculo || data.vehicle || ""),
            amount:Math.max(0, toNumberSafe(data.originalAmount ?? data.montoOriginal ?? data.amount ?? data.requestedAmount ?? data.montoSolicitado)),
            installments:Number(data.installments || data.cuotas || normalized.installments || EXPLORE_LOAN_MAX_INSTALLMENTS),
            requestedAt:data.requestedAt || null,
            requestedLabel:"Pendiente de aprobación"
          });
        });
      });
      if (!seen.size && failures.length === settled.length) {
        const error = failures[0] || new Error("No se pudieron cargar las solicitudes pendientes.");
        throw Object.assign(error, { code:error.code || "LOAN_PENDING_LIST_FAILED" });
      }
      const rows = [...seen.values()].sort((a,b) => String(b.requestedAt?.seconds || b.requestedAt || "").localeCompare(String(a.requestedAt?.seconds || a.requestedAt || "")));
      if (failures.length) {
        Object.defineProperty(rows, "partialWarnings", { value:failures.map(error => String(error?.code || error?.message || error || "consulta fallida")), enumerable:false });
      }
      return rows;
    }

    async function applyExploreLoanClosurePayment(driverUid, weeklyPeriodId, requestedDiscount = 0, closureId = "") {
      const uid = String(driverUid || "").trim();
      const periodId = String(weeklyPeriodId || "").trim();
      if (!uid || !periodId) return { applied:false, amount:0 };
      const loanRef = doc(db, EXPLORE_LOAN_COLLECTION, uid);
      return runTransaction(db, async transaction => {
        const snap = await transaction.get(loanRef);
        if (!snap.exists()) return { applied:false, amount:0 };
        const data = { id:snap.id, ...(snap.data() || {}) };
        const loan = normalizeExploreLoanDocument(data);
        if (!loan?.active) return { applied:false, amount:0 };
        const installment = previewLoanInstallment({ balance:loan.balance, weeklyDiscount:requestedDiscount || loan.weeklyDiscount, paidWeeklyPeriodIds:loan.paidWeeklyPeriodIds }, periodId);
        if (installment.duplicate) return { applied:false, amount:0, duplicate:true, weeklyPeriodId:periodId };
        const discount = installment.amount;
        if (!(discount > 0)) return { applied:false, amount:0, weeklyPeriodId:periodId };
        const newBalance = installment.newBalance;
        const cancelled = newBalance === 0;
        const paidWeeklyPeriodIds = [...loan.paidWeeklyPeriodIds, periodId].slice(-40);
        transaction.set(loanRef, {
          balance:newBalance, saldoPendiente:newBalance, status:cancelled?"cancelled":"active", estado:cancelled?"cancelado":"activo", active:!cancelled,
          paidWeeklyPeriodIds, exploraLoanLookbackId:loan.exploraLoanLookbackId || exploreLoanLookbackForPeriod({id:periodId}).id, lastDiscountAmount:discount, lastPaidWeeklyPeriodId:periodId, lastClosureId:closureId || null,
          cancelledAt:cancelled?serverTimestamp():data.cancelledAt || null, updatedAt:serverTimestamp()
        }, { merge:true });
        const paymentId = `${loan.id || uid}_${periodId}`;
        transaction.set(doc(db, EXPLORE_LOAN_HISTORY_COLLECTION, paymentId), {
          event:"weekly_discount", loanId:loan.id || data.loanId || uid, driverUid:uid, weeklyPeriodId:periodId, exploraLoanLookbackId:loan.exploraLoanLookbackId || exploreLoanLookbackForPeriod({id:periodId}).id, closureId:closureId || null,
          previousBalance:loan.balance, discountAmount:discount, newBalance, status:cancelled?"cancelled":"active", createdAt:serverTimestamp()
        }, { merge:false });
        return { applied:true, amount:discount, previousBalance:loan.balance, newBalance, cancelled };
      }).then(result => { exploreLoanSourceCache.clear(); exploreLoanLookbackRankingCache.clear(); window.dispatchEvent(new CustomEvent("explora:loan-payment", { detail:{ uid, weeklyPeriodId:periodId, ...result } })); return result; });
    }

    async function getExploreLoanSnapshot(driverUid = auth.currentUser?.uid, options = {}) {
      const uid = String(driverUid || "").trim();
      if (!uid) return null;
      const active = getActiveWeeklyPeriod();
      const weekly = await getDriverWeeklySnapshot(uid, active.id, { force:Boolean(options.force), reason:"explore-loan-snapshot" });
      return {
        driverUid:uid, weeklyPeriodId:weekly.weeklyPeriodId, exploraLoanLookbackId:weekly.exploraLoanLookbackId || weekly.exploraLoanLookback?.id || "",
        exploraLoanLookbackBilling:Number(weekly.exploraLoanLookbackBilling || weekly.validBilling8Weeks || 0), validBilling8Weeks:Number(weekly.validBilling8Weeks || weekly.exploraLoanLookbackBilling || 0), movementDays:Number(weekly.movementDays || weekly.eligibility?.movementDays || 0), loanMaxInstallments:Number(weekly.loanMaxInstallments || 8), loanInterestRate:Number(weekly.loanInterestRate || 0), activeWeeks:Number(weekly.activeWeeks || 0), requirements:weekly.requirements || {}, requirementList:weekly.requirementList || [],
        requirementsMet:Number(weekly.requirementsMet || 0), activeLoan:weekly.activeLoan || null,
        availableBenefit:Number(weekly.availableBenefit || weekly.benefitAvailable || 0), benefitAvailable:Number(weekly.availableBenefit || weekly.benefitAvailable || 0),
        eligibility:weekly.eligibility || { validBilling8Weeks:false, rhythmReal:false, closureUpToDate:false, collaborationOk:false, noActiveLoan:true, approvalRequired:true, eligible:false }
      };
    }

    async function buildDriverWeeklySnapshot(uid, period, sources) {
      try {
        const performanceResult=await buildWeeklyPerformanceResult(period,sources.viajes||[],sources.derivaciones||[]);
        const {identities,row}=getIdentitySetForDriver(uid,performanceResult);
        const currentServices=deduplicateWeeklyRows(performanceResult.services.filter(service=>recordMatchesIdentitySet(service,identities)),"service");
        const expenseRows=deduplicateWeeklyRows((sources.gastos||[]).filter(expense=>docBelongsToPeriod(expense,period)&&isValidWeeklyExpense(expense)&&recordMatchesIdentitySet(expense,identities)),"expense").map(expense=>({...normalizeExpenseDocument(expense),payerRole:normalizePayerRole(expense,"driver"),sharedRate:normalizeSharedRate(expense,.5)}));
        const operationalLoans=deduplicateWeeklyRows((sources.prestamos||[]).filter(loan=>docBelongsToPeriod(loan,period)&&isValidOperationalLoan(loan)&&recordMatchesIdentitySet(loan,identities)),"loan").map(normalizeOperationalLoanDocument);
        const directDebtInstallments=await loadDriverDebtInstallments(uid,period).catch(error=>{if(window.__exploraStrictWeeklyClosureBuild===true)throw error;console.warn("[EXPLORA deuda semanal]",error?.code||error?.message);return[];});
        const dailyBilling=Array(7).fill(0);currentServices.forEach(service=>{const timestamp=getDocTimeMs(service);if(timestamp<period.startMs||timestamp>period.endMs)return;const dayIndex=Math.min(6,Math.max(0,Math.floor((timestamp-period.startMs)/86400000)));dailyBilling[dayIndex]+=getMoneyValue(service);});
        const grossBilling=currentServices.reduce((sum,service)=>sum+Math.max(0,getMoneyValue(service)),0);
        const totalExpenses=expenseRows.reduce((sum,expense)=>sum+expense.amount,0);
        const emittedDerivations=performanceResult.derivations.filter(item=>identities.has(String(item._origin||"").toLowerCase()));
        const receivedDerivations=performanceResult.derivations.filter(item=>identities.has(String(item._receiver||"").toLowerCase()));
        const derivedAmountForEmitter=emittedDerivations.reduce((sum,item)=>sum+Math.max(0,Number(item._finalAmount||getDerivationFinalAmount(item))),0);
        const collaborationAmount=receivedDerivations.reduce((sum,item)=>sum+Math.max(0,Number(item._collaborationAmount||getDerivationCollaborationAmount(item))),0);
        const kingOfDayAchieved=calculateDailyLeadership(performanceResult,identities,period);
        const kingOfWeekAchieved=calculateWeeklyLeadership(performanceResult,identities);
        const weeklyLeader=performanceResult.rows?.[0]||null;
        const kingOfLoanLookbackAchieved=Boolean(weeklyLeader&&[weeklyLeader.uid,weeklyLeader.choferId,...(weeklyLeader.aliases||[])].some(value=>identities.has(String(value||"").toLowerCase())));
        const loanState=await buildExploreLoanState(uid,period,{grossBilling,serviceCount:currentServices.length,expenseCount:expenseRows.length,validDerivations:emittedDerivations.length,receivedValidDerivations:receivedDerivations.length,collaborationAmount,dailyBilling,kingOfDayAchieved,kingOfWeekAchieved,kingOfLoanLookbackAchieved,closureStatus:"open"});
        const loanAppliesToPeriod=loanState.activeLoan?.active&&(!loanState.activeLoan.weeklyPeriodId||String(period.id)>=String(loanState.activeLoan.weeklyPeriodId));
        const exploreLoanDiscount=loanAppliesToPeriod?Math.min(Number(loanState.activeLoan.balance||0),Number(loanState.activeLoan.weeklyDiscount||0)):0;
        const financialBase=calculateWeeklyFinancialSettlement({services:currentServices,expenses:expenseRows,operationalLoans,directDebtInstallments,derivationBonusAmount:0,collaborationAmount,exploreLoanDiscount});
        try{await window.ExploraPerformanceEngine?.prepareSettlementIncentive?.(uid,period.id);}catch(error){window.ExploraPerformanceEngine?.showDiagnostic?.("INTEGRATE_WEEKLY_CLOSURE","WEEKLY_BENEFIT_PREPARE_FAILED",error,{weeklyPeriodId:period.id,functionName:"buildDriverWeeklySnapshot",collaborationAmount,derivedAmount:derivedAmountForEmitter});if(window.__exploraStrictWeeklyClosureBuild===true)throw error;}
        const financial=applyPerformanceRewardToSettlement(financialBase,uid,period.id);
        const operationLedger=buildWeeklyOperationLedger(currentServices,expenseRows,operationalLoans,directDebtInstallments);
        const snapshot={uid:uid||auth.currentUser?.uid||"",driverUid:uid||auth.currentUser?.uid||"",rol:exploreLoanRole(),weeklyPeriodId:period.id,startAt:new Date(period.startMs),endAt:new Date(period.endMs),timezone:"America/Argentina/Cordoba",services:currentServices,expenses:expenseRows,operationalLoans,directDebtInstallments,derivations:emittedDerivations,receivedDerivations,billingRecords:currentServices,billingCount:currentServices.length,serviceCount:currentServices.length,grossBilling,expenseCount:expenseRows.length,totalExpenses,validDerivations:emittedDerivations.length,receivedValidDerivations:receivedDerivations.length,derivedAmountForEmitter,collaborationAmount,performancePercent:0,dailyBilling,performanceResult,operationLedger,processedOperationIds:operationLedger.map(item=>item.id),sourceQueriesComplete:sources?.sourceQueriesComplete===true,driverScoped:sources?.driverScoped===true,kingOfDayAchieved,kingOfWeekAchieved,kingOfLoanLookbackAchieved,exploraLoanLookbackId:loanState.exploraLoanLookbackId,exploraLoanLookback:loanState.exploraLoanLookback,exploraLoanLookbackBilling:loanState.exploraLoanLookbackBilling,validBilling8Weeks:loanState.validBilling8Weeks,movementDays:loanState.movementDays,loanMaxInstallments:loanState.loanMaxInstallments,loanInterestRate:loanState.loanInterestRate,activeWeeks:loanState.activeWeeks,requirements:loanState.requirements,requirementList:loanState.requirementList,requirementsMet:loanState.requirementsMet,activeLoan:loanState.activeLoan,availableBenefit:loanState.availableBenefit,benefitAvailable:loanState.availableBenefit,eligibility:loanState.eligibility,exploreLoanOriginalAmount:Number(loanState.activeLoan?.originalAmount||0),exploreLoanBalance:Number(loanState.activeLoan?.balance||0),exploreLoanWeeklyDiscount:Number(loanState.activeLoan?.weeklyDiscount||0),exploreLoanDiscount,...financial,closureId:null,closureStatus:"open",weeklyReceiptRequired:false,weeklyReceiptStatus:"not_required",weeklyReceiptUrl:null,weeklyReceiptPath:null,receiptDeadline:null,performanceEligible:true,loading:false,error:null,calculatedAt:new Date()};
        archivePreviousExploreLoanLookback(uid,loanState.exploraLoanLookback).catch(error=>reportExploreLoanError("LOAN_CALCULATION","LOAN_SNAPSHOT_FAILED",error,{functionName:"archivePreviousExploreLoanLookback",weeklyPeriodId:period.id,exploraLoanLookbackId:loanState.exploraLoanLookbackId,firestorePath:EXPLORE_LOAN_LOOKBACK_HISTORY_COLLECTION,operation:"archive completed 8-week lookback"}));
        return snapshot;
      } catch (error) {
        reportExploreLoanError("LOAN_CALCULATION","LOAN_ENGINE_FAILED",error,{functionName:"buildDriverWeeklySnapshot",weeklyPeriodId:period?.id,exploraLoanLookbackId:exploreLoanLookbackForPeriod(period).id,firestorePath:WEEKLY_SNAPSHOT_COLLECTION,operation:"build weekly snapshot"});
        throw error;
      }
    }

    function weeklySnapshotOperationIds(snapshot = {}) {
      const protectedTypes=new Set(["service","billing","expense","loan","debt"]);
      const ledger=Array.isArray(snapshot.operationLedger)?snapshot.operationLedger:[];
      const ledgerIds=ledger.filter(row=>protectedTypes.has(String(row?.type||"").toLowerCase())).map(row=>row?.id);
      const ids=ledgerIds.length?ledgerIds
        : Array.isArray(snapshot.processedOperationIds)?snapshot.processedOperationIds
        : Array.isArray(snapshot.operacionesProcesadas)?snapshot.operacionesProcesadas
        : [];
      return new Set(ids.map(value => String(value || "").trim()).filter(Boolean));
    }

    function weeklySnapshotRegression(candidate = {}, current = {}) {
      const candidatePeriod=String(candidate.weeklyPeriodId||candidate.periodId||candidate.periodoSemanalId||"").slice(0,10);
      const currentPeriod=String(current.weeklyPeriodId||current.periodId||current.periodoSemanalId||"").slice(0,10);
      const candidateUid=String(candidate.driverUid||candidate.uid||candidate.choferUid||"").trim();
      const currentUid=String(current.driverUid||current.uid||current.choferUid||"").trim();
      if(!current||!Object.keys(current).length||!candidatePeriod||candidatePeriod!==currentPeriod)return null;
      if(candidateUid&&currentUid&&candidateUid!==currentUid)return null;
      const candidateIds=weeklySnapshotOperationIds(candidate),currentIds=weeklySnapshotOperationIds(current);
      const missingIds=[...currentIds].filter(id=>!candidateIds.has(id));
      const metrics=[
        ["serviceCount",Number(candidate.serviceCount??candidate.billingCount??0),Number(current.serviceCount??current.billingCount??0)],
        ["grossBilling",Number(candidate.grossBilling??candidate.facturacion??0),Number(current.grossBilling??current.facturacion??0)],
        ["expenseCount",Number(candidate.expenseCount??candidate.cantidadGastos??0),Number(current.expenseCount??current.cantidadGastos??0)],
        ["totalExpenses",resolveWeeklyExpenseTotals(candidate).total,resolveWeeklyExpenseTotals(current).total]
      ];
      const regressiveMetrics=metrics.filter(([,next,prev])=>Number.isFinite(next)&&Number.isFinite(prev)&&next+0.01<prev).map(([name,next,prev])=>({name,next,prev}));
      if(!missingIds.length&&!regressiveMetrics.length)return null;
      return {missingIds:missingIds.slice(0,12),regressiveMetrics,candidatePeriod,currentPeriod,candidateUid,currentUid};
    }
    window.ExploraWeeklySnapshotRegression=weeklySnapshotRegression;

    function reportIgnoredWeeklyRegression(regression, candidate = {}, current = {}, source = "weekly-state") {
      const error=Object.assign(new Error("Se ignoró una respuesta semanal antigua para evitar que reemplace gastos o cobros más nuevos."),{code:"WEEKLY_STALE_SNAPSHOT_IGNORED",regression});
      weeklyState.sourceErrors.staleSnapshot={code:error.code,message:error.message,source,at:Date.now(),regression};
      try{showWeeklyClosureSummaryDiagnostic("SYNC_WEEKLY_SNAPSHOT","WEEKLY_STALE_SNAPSHOT_IGNORED",error,{functionName:"applySnapshotToWeeklyState",weeklyPeriodId:current.weeklyPeriodId||candidate.weeklyPeriodId,snapshot:candidate,currentSnapshot:current,firestorePath:WEEKLY_SNAPSHOT_COLLECTION,query:source});}catch(_){}
    }

    function applySnapshotToWeeklyState(snapshot, sources = null) {
      const regression=weeklySnapshotRegression(snapshot,weeklyState.snapshot||{});
      if(regression){reportIgnoredWeeklyRegression(regression,snapshot,weeklyState.snapshot||{},sources?.reason||weeklyState.dirtyReason||"weekly-state");return false;}
      weeklyState.snapshot = snapshot;
      weeklyState.uid = snapshot.uid;
      weeklyState.weeklyPeriodId = snapshot.weeklyPeriodId;
      weeklyState.services = snapshot.performanceResult?.services || snapshot.services || [];
      weeklyState.currentServices = snapshot.services || [];
      weeklyState.serviceCount = Number(snapshot.serviceCount || 0);
      weeklyState.grossBilling = Number(snapshot.grossBilling || 0);
      weeklyState.validDerivations = Number(snapshot.validDerivations || 0);
      weeklyState.derivedAmountForEmitter = Number(snapshot.derivedAmountForEmitter || 0);
      weeklyState.collaborationAmount = Number(snapshot.collaborationAmount || 0);
      weeklyState.repairFundRate = Number(snapshot.repairFundRate || .05);
      weeklyState.repairFundAmount = Number(snapshot.repairFundAmount || 0);
      const resolvedExpenses = resolveWeeklyExpenseTotals(snapshot);
      weeklyState.expenses = resolvedExpenses.total;
      weeklyState.totalExpenses = resolvedExpenses.total;
      weeklyState.expenseCount = Number(snapshot.expenseCount || 0);
      weeklyState.expenseRows = snapshot.expenses || [];
      weeklyState.operationalLoans = snapshot.operationalLoans || [];
      weeklyState.operationalLoanTotal = Number(snapshot.operationalLoanTotal || 0);
      weeklyState.directDebtInstallments = snapshot.directDebtInstallments || [];
      weeklyState.directDebtInstallmentTotal = Number(snapshot.directDebtInstallmentTotal || 0);
      ["cashCollectedByDriver","transferCollectedByAdmin","cardCollectedByAdmin","aliasCollectedByAdmin","qrCollectedByAdmin","unknownPaymentMethodTotal","totalCollectedByAdmin","driverPaidSharedExpenses","adminPaidSharedExpenses","operationalLoanDriverShare","operationalLoanAdminShare","receivedValidDerivations","exploreLoanDiscount","exploreLoanOriginalAmount","exploreLoanBalance","exploreLoanWeeklyDiscount","exploraLoanLookbackBilling","activeWeeks","requirementsMet","availableBenefit","benefitAvailable","derivationBonusAmount","performanceDerivationPercent","repairFundRate","repairFundAmount","driverBaseShare","adminBaseShare","driverFinalEntitlement","adminFinalEntitlement","settlementToDriver","settlementToAdmin","settlementAmount"].forEach(key => weeklyState[key] = Number(snapshot[key] || 0));
      weeklyState.exploraLoanLookbackId = snapshot.exploraLoanLookbackId || ""; weeklyState.exploraLoanLookback = snapshot.exploraLoanLookback || null; weeklyState.requirements = snapshot.requirements || {}; weeklyState.requirementList = snapshot.requirementList || []; weeklyState.activeLoan = snapshot.activeLoan || null; weeklyState.eligibility = snapshot.eligibility || null; weeklyState.kingOfDayAchieved = snapshot.kingOfDayAchieved === true; weeklyState.kingOfWeekAchieved = snapshot.kingOfWeekAchieved === true; weeklyState.kingOfLoanLookbackAchieved = snapshot.kingOfLoanLookbackAchieved === true;
      weeklyState.payerRole = snapshot.payerRole || null;
      weeklyState.payeeRole = snapshot.payeeRole || null;
      weeklyState.balanced = snapshot.balanced === true;
      weeklyState.dailyBilling = snapshot.dailyBilling || Array(7).fill(0);
      weeklyState.performancePercent = Number(snapshot.performancePercent || 0);
      weeklyState.performanceResult = snapshot.performanceResult || null;
      weeklyState.loading = false; weeklyState.loaded = true; weeklyState.error = null;
      weeklyState.loadedAt = Date.now(); weeklyState.dirty = false;
      if (sources) weeklyState.raw = sources;
      weeklySnapshotCache.set(buildSnapshotCacheKey(snapshot.uid, snapshot.weeklyPeriodId), snapshot);
      persistWeeklySessionCache(snapshot);
      return true;
    }

    function weeklyStatePublicSnapshot() {
      return {
        ...(weeklyState.snapshot || {}),
        uid:weeklyState.uid, weeklyPeriodId:weeklyState.weeklyPeriodId, period:weeklyState.period,
        snapshot:weeklyState.snapshot, services:weeklyState.services, currentServices:weeklyState.currentServices,
        billingCount:weeklyState.serviceCount, serviceCount:weeklyState.serviceCount, grossBilling:weeklyState.grossBilling,
        validDerivations:weeklyState.validDerivations, derivedAmountForEmitter:weeklyState.derivedAmountForEmitter, collaborationAmount:weeklyState.collaborationAmount, repairFundRate:weeklyState.repairFundRate, repairFundAmount:weeklyState.repairFundAmount, expenses:weeklyState.expenses,
        totalExpenses:weeklyState.totalExpenses, expenseCount:weeklyState.expenseCount,
        expenseRows:weeklyState.expenseRows, operationalLoans:weeklyState.operationalLoans,
        operationalLoanTotal:weeklyState.operationalLoanTotal,
        directDebtInstallments:weeklyState.directDebtInstallments,
        directDebtInstallmentTotal:weeklyState.directDebtInstallmentTotal,
        receivedValidDerivations:weeklyState.receivedValidDerivations, exploreLoanDiscount:weeklyState.exploreLoanDiscount, exploreLoanOriginalAmount:weeklyState.exploreLoanOriginalAmount, exploreLoanBalance:weeklyState.exploreLoanBalance, exploreLoanWeeklyDiscount:weeklyState.exploreLoanWeeklyDiscount, exploraLoanLookbackId:weeklyState.exploraLoanLookbackId, exploraLoanLookback:weeklyState.exploraLoanLookback, exploraLoanLookbackBilling:weeklyState.exploraLoanLookbackBilling, activeWeeks:weeklyState.activeWeeks, requirements:weeklyState.requirements, requirementList:weeklyState.requirementList, requirementsMet:weeklyState.requirementsMet, activeLoan:weeklyState.activeLoan, availableBenefit:weeklyState.availableBenefit, benefitAvailable:weeklyState.benefitAvailable, eligibility:weeklyState.eligibility, kingOfDayAchieved:weeklyState.kingOfDayAchieved, kingOfWeekAchieved:weeklyState.kingOfWeekAchieved, kingOfLoanLookbackAchieved:weeklyState.kingOfLoanLookbackAchieved,
        cashCollectedByDriver:weeklyState.cashCollectedByDriver,
        transferCollectedByAdmin:weeklyState.transferCollectedByAdmin,
        cardCollectedByAdmin:weeklyState.cardCollectedByAdmin,
        aliasCollectedByAdmin:weeklyState.aliasCollectedByAdmin,
        qrCollectedByAdmin:weeklyState.qrCollectedByAdmin,
        totalCollectedByAdmin:weeklyState.totalCollectedByAdmin,
        driverPaidSharedExpenses:weeklyState.driverPaidSharedExpenses,
        adminPaidSharedExpenses:weeklyState.adminPaidSharedExpenses,
        operationalLoanDriverShare:weeklyState.operationalLoanDriverShare,
        operationalLoanAdminShare:weeklyState.operationalLoanAdminShare,
        derivationBonusAmount:weeklyState.derivationBonusAmount, performanceDerivationPercent:weeklyState.performanceDerivationPercent, driverBaseShare:weeklyState.driverBaseShare,
        adminBaseShare:weeklyState.adminBaseShare, driverFinalEntitlement:weeklyState.driverFinalEntitlement,
        adminFinalEntitlement:weeklyState.adminFinalEntitlement,
        settlementToDriver:weeklyState.settlementToDriver, settlementToAdmin:weeklyState.settlementToAdmin,
        payerRole:weeklyState.payerRole, payeeRole:weeklyState.payeeRole,
        settlementAmount:weeklyState.settlementAmount, balanced:weeklyState.balanced,
        dailyBilling:weeklyState.dailyBilling, performancePercent:weeklyState.performancePercent,
        performanceResult:weeklyState.performanceResult, loading:weeklyState.loading, loaded:weeklyState.loaded,
        error:weeklyState.error, loadedAt:weeklyState.loadedAt, dirty:weeklyState.dirty,
        sourceErrors:{...weeklyState.sourceErrors}
      };
    }

    function notifyWeeklyState() {
      const snapshot = weeklyStatePublicSnapshot();
      if(snapshot.uid&&snapshot.weeklyPeriodId&&!snapshot.loading){
        persistWeeklySessionCache(snapshot);
        window.ExploraFastCache?.renderWeeklySnapshot?.(snapshot);
      }
      weeklyState.subscribers.forEach(callback => {
        try { callback(snapshot); } catch (error) { console.warn("[EXPLORA weekly subscriber]", error?.message || error); }
      });
      window.dispatchEvent(new CustomEvent("explora:weekly-summary", { detail: snapshot }));
      if (!snapshot.loading) {
        const waiters = weeklyState.waiters.splice(0);
        waiters.forEach(({ resolve, timer }) => { clearTimeout(timer); resolve(snapshot); });
      }
    }

    async function loadWeeklySources(period, options = {}) {
      const allowLegacyScan = options.allowLegacyScan === true;
      const driverUid = String(options.driverUid || auth.currentUser?.uid || "").trim();
      const ownDriverScope = Boolean(driverUid && driverUid === String(auth.currentUser?.uid || "").trim() && !isAdminRole(exploraSession.profile?.role || exploraSession.role || ""));
      const names = ["viajes","derivaciones","gastos","prestamos"];
      const collections = ["billing_records","derivaciones","gastos",OPERATIONAL_LOAN_COLLECTION];
      const startupCanonical = options.canonicalOnly === true;
      const settled = await Promise.allSettled(collections.map(name => ownDriverScope
        ? getDriverPeriodDocs(name, period, driverUid, { throwOnError:true, canonicalOnly:startupCanonical })
        : getPeriodDocs(name, period, { allowLegacyScan, throwOnError:true })
      ));
      const sources = { viajes:[], derivaciones:[], gastos:[], prestamos:[], sourceQueriesComplete:true, driverScoped:ownDriverScope };
      const errors = {};
      settled.forEach((result,index)=>{
        const name=names[index];
        if(result.status==="fulfilled") sources[name]=result.value;
        else { errors[name]=result.reason; sources.sourceQueriesComplete=false; }
      });
      if ((options.strict === true && Object.keys(errors).length) || (errors.viajes && errors.gastos && errors.prestamos)) {
        const firstError = Object.values(errors)[0] || new Error("WEEKLY_SOURCES_UNAVAILABLE");
        throw Object.assign(firstError, { code:firstError?.code || "WEEKLY_CLOSURE_SOURCE_QUERY_FAILED", sourceErrors:errors });
      }
      weeklyState.sourceErrors = errors;
      return sources;
    }

    async function loadOwnMaterializedSnapshot(uid, period) {
      const ownSnap = await getDoc(doc(db, WEEKLY_SNAPSHOT_COLLECTION, materializedSnapshotId(uid, period.id))).catch(() => null);
      if (!ownSnap?.exists()) return null;
      // La ruta crítica del Chofer no espera el Ranking global.
      return snapshotFromMaterialized(ownSnap.data() || {}, uid, period, null);
    }

    async function rebuildWeeklyEngineFromSources(uid, period, reason = "rebuild") {
      if (weeklyState.reconcilePromise) return weeklyState.reconcilePromise;
      weeklyState.reconcilePromise = (async () => {
        const strictReason=/canonical|closure|expense-created|gasto|billing-created|cobro/i.test(String(reason||""));
        const startupCanonical = /session-preopen-sync|session-open|startup|initial-load/i.test(String(reason || ""));
        const sources = await loadWeeklySources(period, { driverUid:uid, allowLegacyScan: reason === "manual-refresh" || strictReason, strict:strictReason || window.__exploraStrictWeeklyClosureBuild === true, canonicalOnly:startupCanonical && !strictReason });
        const snapshot = await buildDriverWeeklySnapshot(uid, period, sources);
        const applied=applySnapshotToWeeklyState(snapshot, { ...sources, reason });
        if(!applied)return weeklyState.snapshot || snapshot;
        notifyWeeklyState();
        persistMaterializedWeeklySnapshot(snapshot).catch(error => console.warn("[EXPLORA snapshot] persist", error?.code || error?.message));
        return snapshot;
      })().finally(() => { weeklyState.reconcilePromise = null; });
      return weeklyState.reconcilePromise;
    }

    function restoreWeeklyEngineCacheForCurrentUser() {
      const user = auth.currentUser;
      if (!user?.uid) return null;
      const period = getActiveWeeklyPeriod();
      const cached = restoreWeeklySessionCache(user.uid, period);
      if (!cached) return null;
      weeklyState.period = period;
      if(applySnapshotToWeeklyState(cached,{reason:"session-cache-restore"}))notifyWeeklyState();
      return cached;
    }

    async function performWeeklyEngineLoad({ force = false, reason = "load", restoreCachedVisual = false } = {}) {
      const user = auth.currentUser;
      if (!user?.uid) throw new Error("WEEKLY_AUTH_REQUIRED");
      const period = getActiveWeeklyPeriod();
      const cacheKey = buildSnapshotCacheKey(user.uid, period.id);
      weeklyState.uid=user.uid; weeklyState.period=period; weeklyState.weeklyPeriodId=period.id;

      if (!force && restoreCachedVisual === true && !weeklyState.loaded) restoreWeeklyEngineCacheForCurrentUser();
      if (!force && !weeklyState.dirty && weeklyState.loaded && weeklyState.weeklyPeriodId===period.id) return weeklyStatePublicSnapshot();
      if (!force && weeklySnapshotCache.has(cacheKey) && !weeklyState.dirty) {
        if(applySnapshotToWeeklyState(weeklySnapshotCache.get(cacheKey),{reason:"memory-cache"}))notifyWeeklyState(); return weeklyStatePublicSnapshot();
      }

      const sequence=++weeklyState.loadSequence;
      if (!weeklyState.loaded) { weeklyState.loading=true; weeklyState.error=null; notifyWeeklyState(); }
      try {
        if (!force) {
          const materialized = await loadOwnMaterializedSnapshot(user.uid, period);
          if (materialized && sequence===weeklyState.loadSequence) {
            const materializedSchema = Number(materialized.schemaVersion || 0);
            // v2.4.40: un snapshot semanal anterior al hardening no puede cerrar en $0 ni pisar efectivo real.
            // Si el schema es viejo, se reconstruye antes de mostrar el cierre para recuperar ventas en efectivo.
            if (materializedSchema >= WEEKLY_ENGINE_SCHEMA_VERSION) {
              const materializedApplied=applySnapshotToWeeklyState(materialized,{reason:"materialized-snapshot"}); if(materializedApplied)notifyWeeklyState();
              return weeklyStatePublicSnapshot();
            }
            weeklyState.sourceErrors.materializedSchemaUpgrade={code:"WEEKLY_MATERIALIZED_SCHEMA_UPGRADE",from:materializedSchema,to:WEEKLY_ENGINE_SCHEMA_VERSION,at:Date.now()};
          }
        }
        const snapshot = await rebuildWeeklyEngineFromSources(user.uid, period, force ? (reason || "manual-refresh") : reason);
        return snapshot;
      } catch (error) {
        if (sequence !== weeklyState.loadSequence) return weeklyStatePublicSnapshot();
        weeklyState.loading=false; weeklyState.error=error; weeklyState.dirty=true; notifyWeeklyState();
        if (weeklyState.loaded && weeklyState.snapshot) return weeklyStatePublicSnapshot();
        throw error;
      }
    }

    async function loadWeeklyEngine(options = {}) {
      if (weeklyState.loadPromise) return weeklyState.loadPromise;
      weeklyState.loadPromise = performWeeklyEngineLoad(options).finally(()=>{ weeklyState.loadPromise=null; });
      return weeklyState.loadPromise;
    }
    async function loadWeeklyFinancialEngineOnce(options = {}) { return loadWeeklyEngine(options); }
    async function refreshWeeklyEngine(options = {}) {
      weeklyState.dirty=true;
      const inFlight=weeklyState.loadPromise;
      if(inFlight){try{await inFlight;}catch(_){}}
      return loadWeeklyEngine({ ...options, force:true, reason:options.reason || "manual-refresh" });
    }
    function invalidateWeeklyEngine(reason="data-changed", { refresh=false }={}) {
      if (/loan|prestamo|requirement|insignia|cierre|closure|derivacion|cobro|gasto|meta|goal/i.test(String(reason || ""))) { exploreLoanSourceCache.clear(); exploreLoanLookbackRankingCache.clear(); }
      weeklyState.dirty=true; weeklyState.dirtyReason=reason;
      weeklySnapshotCache.delete(buildSnapshotCacheKey(weeklyState.uid,weeklyState.weeklyPeriodId));
      if(refresh && auth.currentUser?.uid){
        clearTimeout(weeklyState.refreshTimer);
        weeklyState.refreshTimer=setTimeout(()=>refreshWeeklyEngine({reason}).catch(()=>{}),120);
      }
    }
    function stopWeeklyEngine({reset=true}={}) {
      clearTimeout(weeklyState.refreshTimer); weeklyState.loadSequence+=1; weeklyState.loadPromise=null; weeklyState.reconcilePromise=null;
      if(!reset) return;
      Object.assign(weeklyState,{
        uid:null,weeklyPeriodId:null,period:null,snapshot:null,services:[],currentServices:[],serviceCount:0,grossBilling:0,
        validDerivations:0,repairFundRate:.05,repairFundAmount:0,expenses:0,totalExpenses:0,expenseCount:0,expenseRows:[],operationalLoans:[],operationalLoanTotal:0,
        cashCollectedByDriver:0,transferCollectedByAdmin:0,cardCollectedByAdmin:0,totalCollectedByAdmin:0,
        driverPaidSharedExpenses:0,adminPaidSharedExpenses:0,operationalLoanDriverShare:0,operationalLoanAdminShare:0,
        driverBaseShare:0,adminBaseShare:0,driverFinalEntitlement:0,adminFinalEntitlement:0,
        settlementToDriver:0,settlementToAdmin:0,payerRole:null,payeeRole:null,settlementAmount:0,balanced:false,
        dailyBilling:Array(7).fill(0),performancePercent:0,performanceResult:null,closure:null,loading:true,loaded:false,error:null,
        raw:{viajes:[],derivaciones:[],gastos:[],prestamos:[]},directDebtInstallments:[],directDebtInstallmentTotal:0,aliasCollectedByAdmin:0,qrCollectedByAdmin:0,dirty:true,dirtyReason:"cleared"
      });
      notifyWeeklyState();
    }
    function ensureWeeklyEngineReady(timeoutMs=6000){
      if(!weeklyState.loading&&weeklyState.loaded&&weeklyState.snapshot) return Promise.resolve(weeklyStatePublicSnapshot());
      loadWeeklyEngine().catch(()=>{});
      return new Promise(resolve=>{
        const timer=setTimeout(()=>{ const i=weeklyState.waiters.findIndex(w=>w.resolve===resolve); if(i>=0)weeklyState.waiters.splice(i,1); resolve(weeklyStatePublicSnapshot()); },timeoutMs);
        weeklyState.waiters.push({resolve,timer});
      });
    }

    async function getDriverWeeklySnapshot(uid, weeklyPeriodId, options = {}) {
      const active=getActiveWeeklyPeriod();
      const targetPeriodId=weeklyPeriodId||active.id;
      const key=buildSnapshotCacheKey(uid,targetPeriodId);
      if(!options.force&&weeklySnapshotCache.has(key)) return weeklySnapshotCache.get(key);
      if(targetPeriodId===active.id&&String(uid||"")===String(auth.currentUser?.uid||"")){
        await loadWeeklyEngine({force:Boolean(options.force),reason:options.reason||"snapshot"});
        return weeklyState.snapshot;
      }
      const period=targetPeriodId===active.id?active:getWeeklyPeriodFromDate(new Date(`${targetPeriodId}T12:00:00-03:00`));
      if(!options.force){
        const materialized=await getDoc(doc(db,WEEKLY_SNAPSHOT_COLLECTION,materializedSnapshotId(uid,targetPeriodId))).catch(()=>null);
        if(materialized?.exists()){
          const snap=snapshotFromMaterialized(materialized.data()||{},uid,period,null);
          weeklySnapshotCache.set(key,snap); return snap;
        }
      }
      const sources=await loadWeeklySources(period,{driverUid:uid,allowLegacyScan:Boolean(options.allowLegacyScan),strict:Boolean(options.strictSources)||/canonical|closure|expense-created|gasto|billing-created|cobro/i.test(String(options.reason||""))});
      const snapshot=await buildDriverWeeklySnapshot(uid,period,sources);
      weeklySnapshotCache.set(key,snapshot);
      persistMaterializedWeeklySnapshot(snapshot).catch(()=>{});
      return snapshot;
    }

    function attachClosureToWeeklySnapshot(statusData = {}) {
      if (!weeklyState.snapshot) return;
      if (statusData.weeklyPeriodId && statusData.weeklyPeriodId !== weeklyState.weeklyPeriodId) return;
      Object.assign(weeklyState.snapshot, {
        closureId:statusData.closureId||null,
        closureStatus:statusData.status||"open",
        closureBalance:Number(statusData.amount||weeklyState.snapshot.settlementAmount||0),
        payer:statusData.payer||weeklyState.snapshot.payerRole||null,
        payee:statusData.payee||weeklyState.snapshot.payeeRole||null,
        weeklyReceiptRequired:Boolean(statusData.payer === "driver" && !statusData.receiptUrl),
        weeklyReceiptStatus:statusData.receiptStatus||"not_required",
        weeklyReceiptUrl:statusData.receiptUrl||null,
        weeklyReceiptPath:statusData.receiptPath||null,
        receiptDeadline:statusData.receiptDeadline||null,
        performanceEligible:statusData.performanceEligibility!==false
      });
      weeklyState.closure=statusData;
      persistWeeklySessionCache(weeklyState.snapshot);
      notifyWeeklyState();
    }

    async function applyWeeklyOperationIncrementally(kind, record, explicitUid = "") {
      const userUid = String(explicitUid || record?.driverUid || record?.choferUid || record?.uid || auth.currentUser?.uid || "").trim();
      const period = weeklyPeriodForRecord(record, weeklyState.period || getActiveWeeklyPeriod());
      if (!userUid || !record || !docBelongsToPeriod(record, period)) return null;
      const operationId = weeklyOperationId(record, kind);
      if (!operationId) return null;
      // Antes de incrementar, asegurar una base semanal completa. Evita reemplazar una semana histórica por una sola operación nueva.
      const cacheKey = buildSnapshotCacheKey(userUid, period.id);
      if (userUid === auth.currentUser?.uid && !weeklyState.loaded) {
        await loadWeeklyEngine({ reason:"operation-preflight" }).catch(()=>null);
      } else if (userUid !== auth.currentUser?.uid && !weeklySnapshotCache.has(cacheKey)) {
        await getDriverWeeklySnapshot(userUid, period.id, { force:false, reason:"operation-preflight" }).catch(()=>null);
      }
      const ref = doc(db, WEEKLY_SNAPSHOT_COLLECTION, materializedSnapshotId(userUid, period.id));
      const nextData = await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists() ? (snap.data() || {}) : {};
        const processed = Array.isArray(data.processedOperationIds) ? [...data.processedOperationIds]
          : Array.isArray(data.operacionesProcesadas) ? [...data.operacionesProcesadas] : [];
        let ledger = Array.isArray(data.operationLedger) ? data.operationLedger.map((row)=>({...row})) : [];
        if (processed.includes(operationId) || ledger.some((row)=>row.id===operationId && ((["service","billing"].includes(row.type)&&["service","billing"].includes(kind))||row.type===kind))) return { ...data, _duplicate:true };

        const current = snapshotFromMaterialized(data, userUid, period, weeklyState.performanceResult || null);
        let dailyBilling = Array.isArray(current.dailyBilling) ? [...current.dailyBilling] : Array(7).fill(0);
        let serviceCount = Number(current.serviceCount || 0);
        let grossBilling = Number(current.grossBilling || 0);
        let expenseCount = Number(current.expenseCount || 0);
        let totalExpenses = Number(current.totalExpenses || 0);
        let cashCollectedByDriver = Number(current.cashCollectedByDriver || 0);
        let unknownPaymentMethodTotal = Number(current.unknownPaymentMethodTotal || 0);
        let transferCollectedByAdmin = Number(current.transferCollectedByAdmin || 0);
        let cardCollectedByAdmin = Number(current.cardCollectedByAdmin || 0);
        let aliasCollectedByAdmin = Number(current.aliasCollectedByAdmin || 0);
        let qrCollectedByAdmin = Number(current.qrCollectedByAdmin || 0);
        let driverPaidSharedExpenses = Number(current.driverPaidSharedExpenses || 0);
        let adminPaidSharedExpenses = Number(current.adminPaidSharedExpenses || 0);
        let driverExpenseCredit = Number(current.driverExpenseCredit || 0);
        let adminExpenseCredit = Number(current.adminExpenseCredit || 0);
        let operationalLoanTotal = Number(current.operationalLoanTotal || 0);
        let operationalLoanDriverShare = Number(current.operationalLoanDriverShare || 0);
        let operationalLoanAdminShare = Number(current.operationalLoanAdminShare || 0);
        let validDerivations = Math.max(0, Number(current.validDerivations || current.derivacionesValidas || 0));

        if (kind === "service" || kind === "billing") {
          const amount = Math.max(0, getMoneyValue(record));
          if (!(amount > 0) || !isServiceValidForWeeklyTotals(record)) return { ...data, _ignored:true };
          serviceCount += 1; grossBilling += amount;
          const method = normalizePaymentMethod(record);
          if (method === "qr") qrCollectedByAdmin += amount;
          else if (method === "alias") aliasCollectedByAdmin += amount;
          else if (method === "transfer") transferCollectedByAdmin += amount;
          else if (method === "card") cardCollectedByAdmin += amount;
          else if (method === "cash") cashCollectedByDriver += amount;
          else unknownPaymentMethodTotal += amount;
          const timestamp = getDocTimeMs(record) || Date.now();
          const dayIndex = Math.min(6, Math.max(0, Math.floor((timestamp - period.startMs) / 86400000)));
          dailyBilling[dayIndex] = Number(dailyBilling[dayIndex] || 0) + amount;
          ledger.push({ id:operationId, type:"billing", amount, paymentMethod:method });
        } else if (kind === "expense") {
          const amount = Math.max(0, toNumberSafe(record.amount ?? getMoneyValue(record)));
          if (!(amount > 0) || !isValidWeeklyExpense(record)) return { ...data, _ignored:true };
          expenseCount += 1; totalExpenses += amount;
          const payerRole = normalizePayerRole(record,"driver");
          const sharedRate = normalizeSharedRate(record,.5);
          const linkedLoan = ledger.find((row)=>row.type==="loan" && row.linkedExpenseId===operationId);
          const applyShared = !linkedLoan;
          if (applyShared) {
            if (payerRole === "admin") { adminPaidSharedExpenses += amount; adminExpenseCredit += amount * sharedRate; }
            else { driverPaidSharedExpenses += amount; driverExpenseCredit += amount * sharedRate; }
          }
          ledger.push({ id:operationId, type:"expense", amount, payerRole, sharedRate, sharedAdjustmentApplied:applyShared });
        } else if (kind === "loan") {
          const loan = normalizeOperationalLoanDocument(record);
          if (!isValidOperationalLoan(loan)) return { ...data, _ignored:true };
          const driverShare = loan.driverShare > 0 ? loan.driverShare : loan.amount * loan.sharedRate;
          const adminShare = loan.adminShare > 0 ? loan.adminShare : loan.amount - driverShare;
          if (loan.linkedExpenseId) {
            const expenseEntry = ledger.find((row)=>row.type==="expense" && row.id===loan.linkedExpenseId);
            if (expenseEntry?.sharedAdjustmentApplied) {
              const expenseCredit = Number(expenseEntry.amount || 0) * Number(expenseEntry.sharedRate || .5);
              if (expenseEntry.payerRole === "admin") {
                adminPaidSharedExpenses = Math.max(0, adminPaidSharedExpenses - Number(expenseEntry.amount || 0));
                adminExpenseCredit = Math.max(0, adminExpenseCredit - expenseCredit);
              } else {
                driverPaidSharedExpenses = Math.max(0, driverPaidSharedExpenses - Number(expenseEntry.amount || 0));
                driverExpenseCredit = Math.max(0, driverExpenseCredit - expenseCredit);
              }
              expenseEntry.sharedAdjustmentApplied = false;
            }
          }
          operationalLoanTotal += loan.amount;
          operationalLoanDriverShare += driverShare;
          operationalLoanAdminShare += adminShare;
          adminExpenseCredit += driverShare;
          ledger.push({ id:operationId, type:"loan", amount:loan.amount, driverShare, adminShare, linkedExpenseId:loan.linkedExpenseId || "" });
        } else if (kind === "derivation") {
          const units = Math.max(0, Number(record.derivationUnits ?? record.performanceUnits ?? 1)) || 1;
          validDerivations += units;
          ledger.push({ id:operationId, type:"derivation", units, derivationId:String(record.derivationId || record.id || ""), participantRole:String(record.participantRole || "") });
        } else return { ...data, _ignored:true };

        ledger = ledger.slice(-160);
        const nextProcessed = [...processed.filter(Boolean), operationId].slice(-160);
        const settlement = calculateWeeklySettlementFromAggregates({
          grossBilling, cashCollectedByDriver, transferCollectedByAdmin, cardCollectedByAdmin, aliasCollectedByAdmin, qrCollectedByAdmin, unknownPaymentMethodTotal,
          driverPaidSharedExpenses, adminPaidSharedExpenses,
          driverPaidExpenses:driverPaidSharedExpenses, adminPaidExpenses:adminPaidSharedExpenses,
          driverExpenseCredit, adminExpenseCredit,
          operationalLoanTotal, operationalLoanDriverShare, operationalLoanAdminShare,
          directDebtInstallmentTotal:Number(current.directDebtInstallmentTotal || 0),
          exploreLoanDiscount:Number(current.exploreLoanDiscount || 0),
          collaborationAmount:Number(current.collaborationAmount || 0),
          repairFundAmount:Number(current.repairFundAmount || Math.round(grossBilling * .05)),
          derivationBonusAmount:Number(current.derivationBonusAmount ?? 0)
        });
        const payload = {
          schemaVersion:WEEKLY_ENGINE_SCHEMA_VERSION, driverUid:userUid, uid:userUid, choferUid:userUid,
          choferId:userUid===auth.currentUser?.uid ? (exploraSession.profileDocumentId || exploraSession.driverId || userUid) : (data.choferId || userUid),
          driverName:userUid===auth.currentUser?.uid ? getProfileName(exploraSession.profile || {},auth.currentUser) : (data.driverName || data.choferNombre || "Chofer"),
          weeklyPeriodId:period.id, periodoSemanalId:period.id, periodoId:period.id,
          billingCount:serviceCount, serviceCount, viajes:serviceCount, grossBilling, facturacion:grossBilling,
          expenseCount, cantidadGastos:expenseCount, totalExpenses, gastos:totalExpenses,
          validDerivations, derivacionesValidas:validDerivations,
          cashCollectedByDriver, transferCollectedByAdmin, cardCollectedByAdmin, aliasCollectedByAdmin, qrCollectedByAdmin, unknownPaymentMethodTotal, paymentMethodReviewRequired:unknownPaymentMethodTotal>0,
          totalCollectedByAdmin:transferCollectedByAdmin+cardCollectedByAdmin+aliasCollectedByAdmin+qrCollectedByAdmin,
          driverPaidSharedExpenses, adminPaidSharedExpenses,
          driverPaidExpenses:driverPaidSharedExpenses, adminPaidExpenses:adminPaidSharedExpenses,
          driverExpenseCredit, adminExpenseCredit,
          operationalLoanTotal, operationalLoanDriverShare, operationalLoanAdminShare,
          dailyBilling, operationLedger:ledger, processedOperationIds:nextProcessed, operacionesProcesadas:nextProcessed,
          ...settlement, actualizadoEn:serverTimestamp(), updatedAt:serverTimestamp()
        };
        tx.set(ref,payload,{merge:true});
        return { ...data, ...payload, actualizadoEn:Date.now(), updatedAt:Date.now() };
      });
      if (nextData?._ignored) return null;
      const snapshot = snapshotFromMaterialized(nextData,userUid,period,weeklyState.performanceResult || null);
      weeklySnapshotCache.set(buildSnapshotCacheKey(userUid,period.id),snapshot);
      if (userUid === auth.currentUser?.uid) {
        if(applySnapshotToWeeklyState(snapshot,{reason:`incremental-${kind}`}))notifyWeeklyState();
      }
      return snapshot;
    }

    function currentSnapshotForOperation(userUid, period) {
      const current = weeklyState.snapshot;
      if (current && String(current.driverUid || current.uid || "") === String(userUid || "") && String(current.weeklyPeriodId || "") === String(period?.id || "")) return current;
      return weeklySnapshotCache.get(buildSnapshotCacheKey(userUid, period?.id)) || null;
    }

    function recalculateExpenseSettlement(base = {}, fields = {}) {
      return calculateWeeklySettlementFromAggregates({
        grossBilling:Number(base.grossBilling || 0),
        cashCollectedByDriver:Number(base.cashCollectedByDriver || 0),
        transferCollectedByAdmin:Number(base.transferCollectedByAdmin || 0),
        cardCollectedByAdmin:Number(base.cardCollectedByAdmin || 0),
        aliasCollectedByAdmin:Number(base.aliasCollectedByAdmin || 0),
        qrCollectedByAdmin:Number(base.qrCollectedByAdmin || 0),
        driverPaidSharedExpenses:Number(fields.driverPaidSharedExpenses ?? base.driverPaidSharedExpenses ?? 0),
        adminPaidSharedExpenses:Number(fields.adminPaidSharedExpenses ?? base.adminPaidSharedExpenses ?? 0),
        driverExpenseCredit:Number(fields.driverExpenseCredit ?? base.driverExpenseCredit ?? 0),
        adminExpenseCredit:Number(fields.adminExpenseCredit ?? base.adminExpenseCredit ?? 0),
        operationalLoanTotal:Number(base.operationalLoanTotal || 0),
        operationalLoanDriverShare:Number(base.operationalLoanDriverShare || 0),
        operationalLoanAdminShare:Number(base.operationalLoanAdminShare || 0),
        directDebtInstallmentTotal:Number(base.directDebtInstallmentTotal || 0),
        exploreLoanDiscount:Number(base.exploreLoanDiscount || 0),
        collaborationAmount:Number(base.collaborationAmount || 0),
        repairFundAmount:Number(base.repairFundAmount || Math.round(Number(base.grossBilling || 0) * .05)),
        derivationBonusAmount:Number(base.derivationBonusAmount ?? 0)
      });
    }

    function publishExpenseSnapshot(snapshot, userUid, period, reason = "expense-local") {
      if (!snapshot) return null;
      weeklySnapshotCache.set(buildSnapshotCacheKey(userUid, period.id), snapshot);
      if (String(userUid || "") === String(auth.currentUser?.uid || "") && String(period.id || "") === String(getActiveWeeklyPeriod().id || "")) {
        if (applySnapshotToWeeklyState(snapshot,{ reason })) notifyWeeklyState();
      }
      window.dispatchEvent(new CustomEvent("explora:operational-snapshot-updated", { detail:snapshot }));
      return snapshot;
    }

    function applyExpenseOptimistically(expense = {}, explicitUid = "") {
      const userUid=String(explicitUid || expense.driverUid || expense.choferUid || expense.uid || auth.currentUser?.uid || "").trim();
      const period=weeklyPeriodForRecord(expense,weeklyState.period || getActiveWeeklyPeriod());
      const base=currentSnapshotForOperation(userUid,period);
      if(!base || !userUid || !docBelongsToPeriod(expense,period) || !isValidWeeklyExpense(expense))return null;
      const operationId=weeklyOperationId(expense,"expense");
      if(!operationId)return null;
      const ledger=Array.isArray(base.operationLedger)?base.operationLedger.map(row=>({...row})):[];
      const alreadyInLedger=ledger.some(row=>String(row?.id||"")===operationId&&String(row?.type||"")==="expense");
      if(alreadyInLedger){
        const ledgerExpenseRows=ledger.filter(row=>String(row?.type||"")==="expense").map(row=>({
          ...row,id:String(row?.id||""),expenseId:String(row?.id||""),driverUid:userUid,weeklyPeriodId:period.id,status:"active"
        }));
        const ledgerTotal=ledgerExpenseRows.reduce((sum,row)=>sum+Math.max(0,Number(row?.amount||0)),0);
        if(Number(base.totalExpenses||0)+.01>=ledgerTotal)return base;
        return syncExpenseRowsToWeeklyEngine(ledgerExpenseRows,userUid,period.id)||base;
      }
      const amount=Math.max(0,toNumberSafe(expense.amount??getMoneyValue(expense)));
      const payerRole=normalizePayerRole(expense,"driver"),sharedRate=normalizeSharedRate(expense,.5);
      const linkedLoan=ledger.some(row=>String(row?.type||"")==="loan"&&String(row?.linkedExpenseId||"")===operationId);
      let driverPaidSharedExpenses=Number(base.driverPaidSharedExpenses||0),adminPaidSharedExpenses=Number(base.adminPaidSharedExpenses||0);
      let driverExpenseCredit=Number(base.driverExpenseCredit||0),adminExpenseCredit=Number(base.adminExpenseCredit||0);
      if(!linkedLoan){
        if(payerRole==="admin"){adminPaidSharedExpenses+=amount;adminExpenseCredit+=amount*sharedRate;}
        else{driverPaidSharedExpenses+=amount;driverExpenseCredit+=amount*sharedRate;}
      }
      const nextLedger=[...ledger,{id:operationId,type:"expense",amount,payerRole,sharedRate,sharedAdjustmentApplied:!linkedLoan}].slice(-160);
      const processed=[...(Array.isArray(base.processedOperationIds)?base.processedOperationIds:Array.isArray(base.operacionesProcesadas)?base.operacionesProcesadas:[]),operationId].filter(Boolean).slice(-160);
      const settlement=recalculateExpenseSettlement(base,{driverPaidSharedExpenses,adminPaidSharedExpenses,driverExpenseCredit,adminExpenseCredit});
      const normalized=normalizeExpenseDocument({...expense,id:operationId,documentId:expense.documentId||operationId});
      const expenseRows=Array.isArray(base.expenses)?[...base.expenses.filter(row=>weeklyOperationId(row,"expense")!==operationId),normalized]:[normalized];
      const next={
        ...base,
        schemaVersion:WEEKLY_ENGINE_SCHEMA_VERSION,
        driverUid:userUid,uid:userUid,choferUid:userUid,
        weeklyPeriodId:period.id,periodoSemanalId:period.id,periodoId:period.id,
        expenses:expenseRows,
        expenseCount:Number(base.expenseCount||0)+1,cantidadGastos:Number(base.expenseCount||0)+1,
        totalExpenses:Number(base.totalExpenses||0)+amount,gastos:Number(base.totalExpenses||0)+amount,
        driverPaidSharedExpenses,adminPaidSharedExpenses,
        driverPaidExpenses:driverPaidSharedExpenses,adminPaidExpenses:adminPaidSharedExpenses,
        driverExpenseCredit,adminExpenseCredit,
        operationLedger:nextLedger,processedOperationIds:processed,operacionesProcesadas:processed,
        ...settlement,updatedAt:Date.now(),actualizadoEn:Date.now(),optimisticExpensePending:true
      };
      return publishExpenseSnapshot(next,userUid,period,"expense-optimistic");
    }

    function syncExpenseRowsToWeeklyEngine(rows = [], explicitUid = "", explicitPeriodId = "") {
      const userUid=String(explicitUid || auth.currentUser?.uid || "").trim();
      const period=weeklyPeriodForRecord({weeklyPeriodId:explicitPeriodId},weeklyState.period || getActiveWeeklyPeriod());
      const base=currentSnapshotForOperation(userUid,period);
      if(!base || !userUid)return null;
      const identities=getIdentitySetForDriver(userUid,base.performanceResult||null).identities;
      const normalized=deduplicateWeeklyRows(rows.filter(row=>docBelongsToPeriod(row,period)&&isValidWeeklyExpense(row)&&recordMatchesIdentitySet(row,identities)),"expense")
        .map(row=>({...normalizeExpenseDocument(row),payerRole:normalizePayerRole(row,"driver"),sharedRate:normalizeSharedRate(row,.5)}));
      const linkedExpenseIds=new Set([
        ...(Array.isArray(base.operationalLoans)?base.operationalLoans:[]).map(row=>String(row?.linkedExpenseId||"")),
        ...(Array.isArray(base.operationLedger)?base.operationLedger:[]).filter(row=>String(row?.type||"")==="loan").map(row=>String(row?.linkedExpenseId||""))
      ].filter(Boolean));
      let driverPaidSharedExpenses=0,adminPaidSharedExpenses=0,driverExpenseCredit=0,adminExpenseCredit=Number(base.operationalLoanDriverShare||0);
      normalized.forEach(row=>{
        const id=weeklyOperationId(row,"expense"),amount=Math.max(0,Number(row.amount||0));
        if(linkedExpenseIds.has(id))return;
        if(row.payerRole==="admin"){adminPaidSharedExpenses+=amount;adminExpenseCredit+=amount*row.sharedRate;}
        else{driverPaidSharedExpenses+=amount;driverExpenseCredit+=amount*row.sharedRate;}
      });
      const oldLedger=Array.isArray(base.operationLedger)?base.operationLedger:[];
      const nonExpenseLedger=oldLedger.filter(row=>String(row?.type||"")!=="expense");
      const expenseLedger=normalized.map(row=>({id:weeklyOperationId(row,"expense"),type:"expense",amount:Number(row.amount||0),payerRole:row.payerRole,sharedRate:row.sharedRate,sharedAdjustmentApplied:!linkedExpenseIds.has(weeklyOperationId(row,"expense"))}));
      const oldExpenseIds=new Set(oldLedger.filter(row=>String(row?.type||"")==="expense").map(row=>String(row?.id||"")));
      const preservedProcessed=(Array.isArray(base.processedOperationIds)?base.processedOperationIds:Array.isArray(base.operacionesProcesadas)?base.operacionesProcesadas:[]).filter(id=>!oldExpenseIds.has(String(id||"")));
      const expenseIds=expenseLedger.map(row=>row.id).filter(Boolean);
      const processed=[...preservedProcessed,...expenseIds].slice(-160);
      const totalExpenses=normalized.reduce((sum,row)=>sum+Math.max(0,Number(row.amount||0)),0);
      const settlement=recalculateExpenseSettlement(base,{driverPaidSharedExpenses,adminPaidSharedExpenses,driverExpenseCredit,adminExpenseCredit});
      const next={
        ...base,
        expenses:normalized,expenseCount:normalized.length,cantidadGastos:normalized.length,totalExpenses,gastos:totalExpenses,
        driverPaidSharedExpenses,adminPaidSharedExpenses,
        driverPaidExpenses:driverPaidSharedExpenses,adminPaidExpenses:adminPaidSharedExpenses,
        driverExpenseCredit,adminExpenseCredit,
        operationLedger:[...nonExpenseLedger,...expenseLedger].slice(-160),processedOperationIds:processed,operacionesProcesadas:processed,
        ...settlement,updatedAt:Date.now(),actualizadoEn:Date.now(),optimisticExpensePending:false
      };
      return publishExpenseSnapshot(next,userUid,period,"expense-source-listener");
    }

    async function applyExpenseToWeeklyEngine(expense) {
      const optimistic=applyExpenseOptimistically(expense);
      try{
        const authoritative=await applyWeeklyOperationIncrementally("expense",expense);
        return authoritative||optimistic;
      }catch(error){
        try{showWeeklyClosureSummaryDiagnostic("SYNC_EXPENSE_REALTIME",error?.code||"EXPENSE_AGGREGATE_WRITE_FAILED",error,{functionName:"applyExpenseToWeeklyEngine",weeklyPeriodId:getRecordWeeklyPeriodId(expense),snapshot:optimistic,firestorePath:`${WEEKLY_SNAPSHOT_COLLECTION}/${materializedSnapshotId(String(expense?.driverUid||auth.currentUser?.uid||""),getRecordWeeklyPeriodId(expense))}`,query:"optimistic expense + materialized aggregate transaction"});}catch(_){}
        if(optimistic)return optimistic;
        throw error;
      }
    }
    function applyServiceToWeeklyEngine(service) { return applyWeeklyOperationIncrementally("billing",service); }
    function applyBillingToWeeklyEngine(record) { return applyWeeklyOperationIncrementally("billing",record); }
    function applyOperationalLoanToWeeklyEngine(loan, explicitUid = "") {
      return applyWeeklyOperationIncrementally("loan",loan,explicitUid);
    }
    function applyDerivationToWeeklyEngine(derivation, explicitUid = "") {
      return applyWeeklyOperationIncrementally("derivation",derivation,explicitUid);
    }
    async function applyDerivationMoneyForUid(uid, derivation = {}) {
      const targetUid=String(uid||"").trim();
      if(!targetUid)throw new Error("DERIVATION_UID_REQUIRED");
      const period=getActiveWeeklyPeriod();
      adminWeeklySnapshotCache?.delete?.(adminCacheKey?.(targetUid,period.id));
      const snapshot=await getDriverWeeklySnapshot(targetUid,period.id,{force:true,allowLegacyScan:false});
      await persistMaterializedWeeklySnapshot(snapshot).catch(()=>{});
      if(targetUid===auth.currentUser?.uid&&applySnapshotToWeeklyState(snapshot,{reason:"derivation-reconcile"}))notifyWeeklyState();
      return snapshot;
    }

    window.ExploraWeeklyState=weeklyState;
    window.ExploraWeeklyFinancialState=weeklyState;
    window.ExploraWeeklyEngine={
      getActiveWeeklyPeriod,start:loadWeeklyEngine,load:loadWeeklyEngine,loadOnce:loadWeeklyFinancialEngineOnce,
      restoreCache:restoreWeeklyEngineCacheForCurrentUser,stop:stopWeeklyEngine,clear:stopWeeklyEngine,
      refresh:refreshWeeklyEngine,invalidate:invalidateWeeklyEngine,ensureReady:ensureWeeklyEngineReady,
      getState:weeklyStatePublicSnapshot,getSnapshot:()=>weeklyState.snapshot,getRankingResult:()=>weeklyState.performanceResult,
      getCurrentDriverServices:()=>[...weeklyState.currentServices],getCurrentExpenseRows:()=>[...weeklyState.expenseRows],
      getDriverWeeklySummary:getDriverWeeklySnapshot,getDriverWeeklySnapshot,getDriverWeeklyFinancialSnapshot:getDriverWeeklySnapshot,
      attachClosure:attachClosureToWeeklySnapshot,applyExpense:applyExpenseToWeeklyEngine,syncExpenses:syncExpenseRowsToWeeklyEngine,applyService:applyServiceToWeeklyEngine,applyBilling:applyBillingToWeeklyEngine,
      applyOperationalLoan:applyOperationalLoanToWeeklyEngine,applyOperationalLoanForUid:(uid,loan)=>applyOperationalLoanToWeeklyEngine(loan,uid),
      applyDerivation:applyDerivationToWeeklyEngine,applyDerivationForUid:(uid,derivation)=>applyDerivationToWeeklyEngine(derivation,uid),
      applyDerivationMoneyForUid,
      persistCurrent:()=>weeklyState.snapshot?persistMaterializedWeeklySnapshot(weeklyState.snapshot):Promise.resolve(),
      calculateFinancialSettlement:calculateWeeklyFinancialSettlement,
      showDiagnostic:(stage,code,error,context={})=>showWeeklyClosureSummaryDiagnostic(stage,code,error,context),
      subscribe(callback){if(typeof callback!=="function")return()=>{};weeklyState.subscribers.add(callback);try{callback(weeklyStatePublicSnapshot());}catch(_){}return()=>weeklyState.subscribers.delete(callback);}
    };
    window.ExploraWeeklyFinancialEngine=window.ExploraWeeklyEngine;
    window.addEventListener("explora:simulation-updated",event=>{invalidateWeeklyEngine(event.detail?.reason||"simulation-updated",{refresh:true});});
    if(!window.__exploraWeeklyFastRefreshRegistered){
      window.__exploraWeeklyFastRefreshRegistered=true;
      const scheduledWeeklyRefresh=()=>window.ExploraFastCache?.run?.("weekly_finance_refresh",()=>loadWeeklyEngine({force:true,reason:"scheduled-cache-refresh"}),{uid:auth.currentUser?.uid||"",role:"chofer",weeklyPeriodId:getActiveWeeklyPeriod().id},{lockKey:"weekly-finance-refresh",ttl:300000,query:"getDoc(acumulados_semanales/{uid_period})",firestorePath:WEEKLY_SNAPSHOT_COLLECTION,listenersActive:0});
      window.ExploraFastCache?.registerRefresher?.("dashboard_weekly_billing",scheduledWeeklyRefresh,{ttl:300000,lockKey:"weekly-finance-refresh",context:()=>({uid:auth.currentUser?.uid||"",role:"chofer",weeklyPeriodId:getActiveWeeklyPeriod().id})});
      window.ExploraFastCache?.registerRefresher?.("dashboard_weekly_expenses",scheduledWeeklyRefresh,{ttl:300000,lockKey:"weekly-finance-refresh",context:()=>({uid:auth.currentUser?.uid||"",role:"chofer",weeklyPeriodId:getActiveWeeklyPeriod().id})});
    }
    window.loadWeeklyFinancialEngine=loadWeeklyEngine;
    window.loadWeeklyFinancialEngineOnce=loadWeeklyFinancialEngineOnce;
    window.refreshWeeklyFinancialEngine=refreshWeeklyEngine;
    window.invalidateWeeklyFinancialEngine=invalidateWeeklyEngine;
    window.renderWeeklyFinancialEngine=notifyWeeklyState;
    window.clearWeeklyFinancialEngine=stopWeeklyEngine;

    window.addEventListener("explora:avatar-updated", (event) => {
      const detail = event.detail || {};
      const uid = String(detail.uid || "");
      const avatar = String(detail.avatarUrl || detail.avatarValue || "");
      if (!uid || !avatar) return;
      const info = {
        nombre: getProfileName(exploraSession.profile || {}, auth.currentUser),
        avatar,
        uid,
        documentId: exploraSession.profileDocumentId || exploraSession.driverId || ""
      };
      cacheDriverProfileAliases(info, [uid, exploraSession.driverId, exploraSession.profileDocumentId]);
      if (weeklyState.performanceResult?.rows) {
        weeklyState.performanceResult.rows.forEach(row => {
          if ([row.uid, row.choferId, ...(row.aliases || [])].some(value => String(value || "").toLowerCase() === uid.toLowerCase())) row.avatar = avatar;
        });
        notifyWeeklyState();
      }
    });

    async function calculateWeeklyPerformance(period) {
      return window.ExploraPerformanceEngine?.calculateForPeriod?.(period) || null;
    }

    function openPerformanceScreen() {
      window.ExploraPerformanceEngine?.open?.("ranking");
    }

    function closePerformanceScreen() {
      window.ExploraPerformanceEngine?.close?.();
    }

    window.ExploraRanking = {
      refresh: () => window.ExploraPerformanceEngine?.refresh?.({ force:true }),
      calculate: calculateWeeklyPerformance,
      open: openPerformanceScreen,
      close: closePerformanceScreen
    };

    window.ExploraActions = window.ExploraActions || {};
    window.ExploraActions["ver-ranking"] = openPerformanceScreen;
    window.ExploraActions["ranking-actual"] = openPerformanceScreen;

    function normalizeEmail(value) {
      return String(value || "").trim().toLowerCase();
    }

    function getProfileUid(profile) {
      return String(
        profile?.uid ||
        profile?.authUid ||
        profile?.firebaseUid ||
        profile?.userId ||
        profile?.usuarioUid ||
        profile?.uidAuth ||
        ""
      ).trim();
    }

    function getProfileRole(profile) {
      return String(
        profile?.rol ||
        profile?.role ||
        profile?.tipoUsuario ||
        profile?.tipo ||
        profile?.perfil ||
        ""
      ).trim().toLowerCase();
    }

    function getProfileUsernameValue(profile) {
      return normalizeUsername(
        profile?.usuario ||
        profile?.username ||
        profile?.usuarioNormalizado ||
        profile?.login ||
        profile?.alias ||
        profile?.nombreUsuario ||
        ""
      );
    }

    function getProfileEmailValue(profile) {
      return normalizeEmail(
        profile?.email ||
        profile?.correo ||
        profile?.authEmail ||
        profile?.firebaseEmail ||
        profile?.mail ||
        ""
      );
    }

    function getProfileActiveState(profile) {
      if (!profile) return false;
      if (profile.activo === false || profile.active === false || profile.habilitado === false) return false;
      const state = String(profile.estado || profile.status || "").trim().toLowerCase();
      if (["inactivo", "bloqueado", "suspendido", "disabled", "deshabilitado"].includes(state)) return false;
      return true;
    }

    function getAliasProfileId(aliasData) {
      return String(
        aliasData?.profileId ||
        aliasData?.driverId ||
        aliasData?.choferId ||
        aliasData?.userDocId ||
        aliasData?.documentId ||
        aliasData?.perfilId ||
        ""
      ).trim();
    }

    function pushProfileCandidate(candidates, candidate) {
      if (!candidate || !candidate.snap || !candidate.snap.exists()) return;
      const key = `${candidate.collectionName}/${candidate.snap.id}`;
      if (candidates.some((item) => item.key === key)) return;
      const data = candidate.snap.data() || {};
      candidates.push({
        key,
        id: candidate.snap.id,
        ref: candidate.ref || candidate.snap.ref,
        collectionName: candidate.collectionName,
        data
      });
    }

    function profileMatchesUser(candidate, authUser, aliasData) {
      const data = candidate?.data || {};
      const profileUid = getProfileUid(data);
      const profileEmail = getProfileEmailValue(data);
      const profileUsername = getProfileUsernameValue(data);
      const aliasUsername = normalizeUsername(aliasData?.username || "");
      const aliasEmail = normalizeEmail(aliasData?.email || aliasData?.authEmail || "");
      const userEmail = normalizeEmail(authUser?.email || "");

      if (profileUid && profileUid !== authUser.uid) return false;
      if (profileEmail && userEmail && profileEmail !== userEmail && profileEmail !== aliasEmail) return false;
      if (profileUsername && aliasUsername && profileUsername !== aliasUsername) return false;

      return true;
    }

    function candidateHasStrongIdentity(candidate, authUser, aliasData) {
      const data = candidate?.data || {};
      const aliasUsername = normalizeUsername(aliasData?.username || "");
      const aliasEmail = normalizeEmail(aliasData?.email || aliasData?.authEmail || "");
      const userEmail = normalizeEmail(authUser?.email || "");
      return (
        getProfileUid(data) === authUser.uid ||
        (!!getProfileEmailValue(data) && (getProfileEmailValue(data) === userEmail || getProfileEmailValue(data) === aliasEmail)) ||
        (!!getProfileUsernameValue(data) && !!aliasUsername && getProfileUsernameValue(data) === aliasUsername)
      );
    }

    async function getDocIfAllowed(collectionName, docId) {
      if (!docId) return null;
      try {
        const ref = doc(db, collectionName, docId);
        const snap = await getDoc(ref);
        if (!snap.exists()) return null;
        return { ref, snap, collectionName };
      } catch (error) {
        if (String(error?.code || "").includes("permission-denied")) throw new Error("PROFILE_PERMISSION_DENIED");
        return null;
      }
    }

    async function queryProfileCandidates(collectionName, fieldName, value) {
      if (!value) return [];
      try {
        const q = query(collection(db, collectionName), where(fieldName, "==", value), limit(2));
        const result = await getDocs(q);
        return result.docs.map((snap) => ({
          ref: snap.ref,
          snap,
          collectionName
        }));
      } catch (error) {
        const code = String(error?.code || "");
        if (code.includes("permission-denied")) throw new Error("PROFILE_PERMISSION_DENIED");
        return [];
      }
    }

    async function findAuthenticatedProfileRobust(authUser, aliasData = {}) {
      if (!authUser?.uid) throw new Error("AUTH_USER_MISSING");

      const candidates = [];
      const collectionsByRole = EXPLORA_ADMIN_UIDS.has(authUser.uid)
        ? ["administradores", "admins", "usuarios", "choferes"]
        : ["choferes", "usuarios", "perfiles"];

      const directIds = [
        authUser.uid,
        getAliasProfileId(aliasData),
        normalizeUsername(aliasData.username || ""),
        normalizeEmail(aliasData.email || aliasData.authEmail || ""),
        normalizeEmail(authUser.email || "")
      ].filter(Boolean);

      for (const collectionName of collectionsByRole) {
        for (const docId of [...new Set(directIds)]) {
          const found = await getDocIfAllowed(collectionName, docId);
          if (found) pushProfileCandidate(candidates, found);
        }
      }

      const queryFields = [
        ["uid", authUser.uid],
        ["authUid", authUser.uid],
        ["firebaseUid", authUser.uid],
        ["userId", authUser.uid],
        ["email", normalizeEmail(authUser.email || aliasData.email || aliasData.authEmail || "")],
        ["correo", normalizeEmail(authUser.email || aliasData.email || aliasData.authEmail || "")],
        ["authEmail", normalizeEmail(aliasData.email || aliasData.authEmail || authUser.email || "")],
        ["usuario", normalizeUsername(aliasData.username || "")],
        ["username", normalizeUsername(aliasData.username || "")],
        ["usuarioNormalizado", normalizeUsername(aliasData.username || "")]
      ].filter(([, value]) => Boolean(value));

      for (const collectionName of collectionsByRole) {
        for (const [fieldName, value] of queryFields) {
          const found = await queryProfileCandidates(collectionName, fieldName, value);
          found.forEach((candidate) => pushProfileCandidate(candidates, candidate));
        }
      }

      const valid = candidates.filter((candidate) =>
        profileMatchesUser(candidate, authUser, aliasData) && candidateHasStrongIdentity(candidate, authUser, aliasData)
      );

      if (!valid.length) {
        throw new Error("PROFILE_QUERY_NOT_FOUND");
      }

      const uniqueKeys = new Set(valid.map((candidate) => candidate.key));
      if (uniqueKeys.size > 1) {
        const adminCandidate = valid.find((candidate) =>
          EXPLORA_ADMIN_UIDS.has(authUser.uid) && ["administradores", "admins"].includes(candidate.collectionName)
        );
        if (adminCandidate) return adminCandidate;

        const driverCandidates = valid.filter((candidate) => getProfileRole(candidate.data) === "chofer" || getProfileRole(candidate.data) === "driver");
        if (driverCandidates.length === 1) return driverCandidates[0];

        throw new Error("PROFILE_DUPLICATE");
      }

      return valid[0];
    }

    async function loadAuthenticatedAccessProfile(authUser, aliasData = {}) {
      const claims = await getTokenClaimsSafe(authUser);
      const profileCandidate = await withTimeout(
        findAuthenticatedProfileRobust(authUser, aliasData),
        10000,
        "PROFILE_TIMEOUT"
      );

      const profile = profileCandidate.data || {};
      const role = resolveProfileRole(profile, claims, authUser);
      const active = getProfileActiveState(profile);

      if (!active) throw new Error("PROFILE_DISABLED");

      return {
        documentId: profileCandidate.id,
        collectionName: profileCandidate.collectionName,
        ref: profileCandidate.ref,
        profile,
        role,
        active,
        isAdmin: role === "admin"
      };
    }

    function resolveProfileRole(profile, authClaims, authUser) {
      const role = getProfileRole(profile);
      const uidIsDavid = EXPLORA_ADMIN_UIDS.has(authUser?.uid || "");
      const claimAdmin = authClaims?.admin === true;

      if (uidIsDavid && (claimAdmin || ["admin", "administrador", "owner"].includes(role))) return "admin";

      if (claimAdmin && !uidIsDavid) throw new Error("PROFILE_ROLE_INVALID");

      if (role === "chofer" || role === "driver") return "chofer";

      throw new Error("PROFILE_ROLE_INVALID");
    }

    function profileErrorMessage(error) {
      const code = String(error?.message || error?.code || "");
      if (code.includes("PROFILE_PERMISSION_DENIED") || code.includes("permission-denied")) return "No se pudo acceder a tu perfil. Contacta al administrador.";
      if (code.includes("PROFILE_TIMEOUT")) return "No se pudo cargar tu perfil por un problema de conexión. Inténtalo nuevamente.";
      if (code.includes("PROFILE_DUPLICATE")) return "No se pudo identificar un perfil único. Contacta al administrador.";
      if (code.includes("PROFILE_DISABLED")) return "Tu cuenta está desactivada.";
      if (code.includes("PROFILE_ROLE_INVALID")) return "La cuenta no tiene un rol válido. Contacta al administrador.";
      if (code.includes("PROFILE_QUERY_NOT_FOUND")) return "No se encontró un perfil válido para esta cuenta.";
      return "No se pudo cargar tu perfil.";
    }



    // ===== EXPLORA LEGACY AUTH RESTAURADO =====
    // Fuente técnica: index anterior. Auth usa usuario -> usuario@explora.local,
    // y el perfil real se lee en la colección histórica "choferes".
    const EXPLORA_LEGACY_PROFILE_COLLECTION = "choferes";

    function normalizarUsuarioExplora(value) {
      return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "");
    }

    function legacyEmailFromLogin(value) {
      const raw = String(value || "").trim().toLowerCase();
      if (!raw) return "";
      if (raw.includes("@")) return raw;
      const user = normalizarUsuarioExplora(raw);
      return user ? `${user}@explora.local` : "";
    }

    function legacyUsernameFromAuthUser(authUser) {
      const email = String(authUser && authUser.email || "").trim().toLowerCase();
      return normalizarUsuarioExplora(email.split("@")[0] || "");
    }

    function legacyProfileRole(profile = {}) {
      return String(profile.rol || profile.role || "").trim().toLowerCase();
    }

    function legacyProfileIsActive(profile = {}) {
      if (profile.activo === false || profile.active === false || profile.habilitado === false) return false;
      const estado = String(profile.estado || "").trim().toLowerCase();
      if (["inactivo", "bloqueado", "suspendido", "disabled"].includes(estado)) return false;
      return true;
    }

    const LEGACY_ADMIN_ROLES = new Set(["admin", "administrador", "owner", "superadmin"]);
    const LEGACY_DRIVER_ROLES = new Set(["chofer", "driver", "conductor"]);

    function normalizeLegacyIdentity(value) {
      return String(value || "").trim().toLowerCase();
    }

    function legacyProfileIdentityMatchesAuth(profile = {}, docId = "", authUser = null, username = "", email = "") {
      const uid = normalizeLegacyIdentity(authUser?.uid || "");
      const normalizedUsername = normalizeLegacyIdentity(username);
      const normalizedEmail = normalizeLegacyIdentity(email || authUser?.email || "");
      const docIdentity = normalizeLegacyIdentity(docId);
      const uidFields = [profile.uid, profile.authUid, profile.firebaseUid, profile.userId, profile.driverUid, profile.choferUid].map(normalizeLegacyIdentity).filter(Boolean);
      const usernameFields = [profile.usuario, profile.username, profile.usuarioNormalizado, profile.userName, profile.login, profile.choferId].map(normalizeLegacyIdentity).filter(Boolean);
      const emailFields = [profile.email, profile.authEmail, profile.correo, profile.firebaseEmail].map(normalizeLegacyIdentity).filter(Boolean);

      if (uidFields.length && uid) return uidFields.includes(uid);
      if (emailFields.length && normalizedEmail) return emailFields.includes(normalizedEmail);
      if (usernameFields.length && normalizedUsername) return usernameFields.includes(normalizedUsername);
      return Boolean(docIdentity && [uid, normalizedUsername, normalizedEmail].filter(Boolean).includes(docIdentity));
    }

    function secureLegacyRoleForAuth(profile = {}, authUser = null, fallbackRole = "") {
      const rawRole = String(legacyProfileRole(profile) || fallbackRole || "chofer").trim().toLowerCase();
      const uidIsAdmin = EXPLORA_ADMIN_UIDS.has(authUser?.uid || "");
      if (LEGACY_ADMIN_ROLES.has(rawRole)) return uidIsAdmin ? "admin" : "chofer";
      if (LEGACY_DRIVER_ROLES.has(rawRole)) return "chofer";
      return rawRole || "chofer";
    }

    function buildLegacyProfileResultFromSnap(snap, authUser, fallbackRole = "") {
      const profile = snap.data() || {};
      return {
        profileDocumentId: snap.id,
        profileRef: doc(db, EXPLORA_LEGACY_PROFILE_COLLECTION, snap.id),
        collectionName: EXPLORA_LEGACY_PROFILE_COLLECTION,
        profile,
        role: secureLegacyRoleForAuth(profile, authUser, fallbackRole || legacyProfileRole(profile)),
        active: legacyProfileIsActive(profile)
      };
    }

    const PROFILE_REF_CACHE_PREFIX = "explora_profile_ref_v4064_persistent_";
    const PROFILE_REF_LEGACY_CACHE_PREFIX = "explora_profile_ref_v4015_driver_admin_";
    const PROFILE_REF_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 45;

    function cacheResolvedProfileReference(authUser, result) {
      try {
        if (!authUser?.uid || !result?.profileDocumentId) return;
        const payload = JSON.stringify({
          uid: authUser.uid,
          collectionName: result.collectionName || EXPLORA_LEGACY_PROFILE_COLLECTION,
          profileDocumentId: result.profileDocumentId,
          savedAt: Date.now()
        });
        localStorage.setItem(PROFILE_REF_CACHE_PREFIX + authUser.uid, payload);
        sessionStorage.setItem(PROFILE_REF_CACHE_PREFIX + authUser.uid, payload);
      } catch (_) {}
    }

    function readCachedProfileReferencePayload(authUser) {
      if (!authUser?.uid) return null;
      const keys = [PROFILE_REF_CACHE_PREFIX + authUser.uid, PROFILE_REF_LEGACY_CACHE_PREFIX + authUser.uid];
      for (const key of keys) {
        for (const store of [localStorage, sessionStorage]) {
          try {
            const raw = store.getItem(key);
            if (!raw) continue;
            const cached = JSON.parse(raw);
            const age = Date.now() - Number(cached?.savedAt || 0);
            if (!cached?.profileDocumentId || !cached?.collectionName || age < 0 || age > PROFILE_REF_CACHE_TTL_MS) continue;
            if (cached.uid && String(cached.uid) !== String(authUser.uid)) continue;
            return cached;
          } catch (_) {}
        }
      }
      return null;
    }

    async function readCachedProfileReference(authUser) {
      try {
        const cached = readCachedProfileReferencePayload(authUser);
        if (!cached) return null;
        const ref = doc(db, cached.collectionName, cached.profileDocumentId);
        const snap = await getDoc(ref);
        if (!snap.exists()) return null;
        const profile = snap.data() || {};
        const username = legacyUsernameFromAuthUser(authUser);
        const email = String(authUser?.email || "").trim().toLowerCase();
        if (!legacyProfileIdentityMatchesAuth(profile, snap.id, authUser, username, email)) return null;
        return {
          profileDocumentId: snap.id,
          profileRef: ref,
          collectionName: cached.collectionName,
          profile,
          role: secureLegacyRoleForAuth(profile, authUser, legacyProfileRole(profile)),
          active: legacyProfileIsActive(profile)
        };
      } catch (_) { return null; }
    }

    async function loadLegacyExploraProfile(authUser) {
      if (!authUser) throw new Error("AUTH_USER_MISSING");
      const username = legacyUsernameFromAuthUser(authUser);
      const email = String(authUser.email || "").trim().toLowerCase();
      if (!username) throw new Error("PROFILE_USERNAME_MISSING");
      loginDevDiagnostic("LEGACY_PROFILE_LOOKUP_START", { uid: Boolean(authUser.uid), username });

      const aliasInfo = await getAuthenticatedLoginAlias(authUser).catch(() => null);
      const aliasProfileId = String(aliasInfo?.profileId || aliasInfo?.driverId || aliasInfo?.choferId || aliasInfo?.uid || "").trim();

      const cached = await readCachedProfileReference(authUser);
      if (cached) {
        loginDevDiagnostic("LEGACY_PROFILE_LOOKUP_METHOD", { method: "session_cached_ref", docId: cached.profileDocumentId, role: cached.role });
        return cached;
      }

      // Seguridad: primero buscar el perfil por UID/AuthUID/ProfileID real.
      // Antes se probaba choferes/{username} primero; si quedaba un documento viejo
      // con id david7 y rol admin, podía abrir una UI equivocada. Ahora el UID manda.
      const directIdentityIds = Array.from(new Set([authUser.uid, aliasProfileId].filter(Boolean)));
      for (const profileId of directIdentityIds) {
        const directIdentityRef = doc(db, EXPLORA_LEGACY_PROFILE_COLLECTION, profileId);
        const directIdentitySnap = await getDoc(directIdentityRef).catch(() => null);
        if (!directIdentitySnap?.exists()) continue;
        const result = buildLegacyProfileResultFromSnap(directIdentitySnap, authUser, aliasInfo?.role || "chofer");
        if (!legacyProfileIdentityMatchesAuth(result.profile, result.profileDocumentId, authUser, username, email)) continue;
        cacheResolvedProfileReference(authUser, result);
        loginDevDiagnostic("LEGACY_PROFILE_LOOKUP_METHOD", { method: "direct_doc_uid", docId: result.profileDocumentId, role: result.role });
        return result;
      }

      const targeted = await Promise.allSettled([
        getDocs(query(collection(db, EXPLORA_LEGACY_PROFILE_COLLECTION), where("uid", "==", authUser.uid), limit(2))),
        getDocs(query(collection(db, EXPLORA_LEGACY_PROFILE_COLLECTION), where("authUid", "==", authUser.uid), limit(2))),
        getDocs(query(collection(db, EXPLORA_LEGACY_PROFILE_COLLECTION), where("firebaseUid", "==", authUser.uid), limit(2))).catch(() => ({ docs: [] })),
        getDocs(query(collection(db, EXPLORA_LEGACY_PROFILE_COLLECTION), where("usuario", "==", username), limit(2))),
        getDocs(query(collection(db, EXPLORA_LEGACY_PROFILE_COLLECTION), where("username", "==", username), limit(2))),
        getDocs(query(collection(db, EXPLORA_LEGACY_PROFILE_COLLECTION), where("usuarioNormalizado", "==", username), limit(2))).catch(() => ({ docs: [] })),
        email ? getDocs(query(collection(db, EXPLORA_LEGACY_PROFILE_COLLECTION), where("email", "==", email), limit(2))) : Promise.resolve({ docs: [] }),
        email ? getDocs(query(collection(db, EXPLORA_LEGACY_PROFILE_COLLECTION), where("authEmail", "==", email), limit(2))).catch(() => ({ docs: [] })) : Promise.resolve({ docs: [] })
      ]);
      const candidates = new Map();
      targeted.forEach((result) => {
        if (result.status !== "fulfilled") return;
        (result.value.docs || []).forEach((snap) => {
          const profile = snap.data() || {};
          if (!legacyProfileIdentityMatchesAuth(profile, snap.id, authUser, username, email)) return;
          candidates.set(snap.id, snap);
        });
      });
      if (candidates.size === 1) {
        const snap = Array.from(candidates.values())[0];
        const result = buildLegacyProfileResultFromSnap(snap, authUser, aliasInfo?.role || "chofer");
        cacheResolvedProfileReference(authUser, result);
        loginDevDiagnostic("LEGACY_PROFILE_LOOKUP_METHOD", { method: "targeted_query", docId: snap.id, role: result.role });
        return result;
      }
      if (candidates.size > 1) {
        const uidSnap = Array.from(candidates.values()).find((snap) => snap.id === authUser.uid);
        if (uidSnap) {
          const result = buildLegacyProfileResultFromSnap(uidSnap, authUser, aliasInfo?.role || "chofer");
          cacheResolvedProfileReference(authUser, result);
          loginDevDiagnostic("LEGACY_PROFILE_LOOKUP_METHOD", { method: "targeted_query_uid_preferred", docId: uidSnap.id, role: result.role });
          return result;
        }
        const driverSnaps = Array.from(candidates.values()).filter((snap) => secureLegacyRoleForAuth(snap.data() || {}, authUser, aliasInfo?.role || "chofer") === "chofer");
        if (driverSnaps.length === 1) {
          const result = buildLegacyProfileResultFromSnap(driverSnaps[0], authUser, aliasInfo?.role || "chofer");
          cacheResolvedProfileReference(authUser, result);
          loginDevDiagnostic("LEGACY_PROFILE_LOOKUP_METHOD", { method: "targeted_query_driver_preferred", docId: driverSnaps[0].id, role: result.role });
          return result;
        }
        throw new Error("PROFILE_DUPLICATE");
      }

      const directRef = doc(db, EXPLORA_LEGACY_PROFILE_COLLECTION, username);
      const directSnap = await getDoc(directRef).catch(() => null);
      if (directSnap?.exists()) {
        const profile = directSnap.data() || {};
        if (legacyProfileIdentityMatchesAuth(profile, directSnap.id, authUser, username, email)) {
          const result = buildLegacyProfileResultFromSnap(directSnap, authUser, aliasInfo?.role || "chofer");
          cacheResolvedProfileReference(authUser, result);
          loginDevDiagnostic("LEGACY_PROFILE_LOOKUP_METHOD", { method: "direct_doc_username", docId: directSnap.id, role: result.role });
          return result;
        }
      }

      // Último recurso exclusivamente para documentos históricos sin UID/usuario normalizado.
      const all = await getDocs(collection(db, EXPLORA_LEGACY_PROFILE_COLLECTION));
      let found = null;
      all.forEach((docSnap) => {
        if (found) return;
        const data = docSnap.data() || {};
        if (legacyProfileIdentityMatchesAuth(data, docSnap.id, authUser, username, email)) {
          found = { snap: docSnap, data };
        }
      });
      if (!found) throw new Error("PROFILE_NOT_FOUND");
      const result = buildLegacyProfileResultFromSnap(found.snap, authUser, aliasInfo?.role || "chofer");
      cacheResolvedProfileReference(authUser, result);
      loginDevDiagnostic("LEGACY_PROFILE_LOOKUP_METHOD", { method: "legacy_collection_scan", docId: found.snap.id, role: result.role });
      return result;
    }

    async function preloadFreshDashboardDataBeforeOpen(role, authUser, profile, loaded) {
      if (!authUser?.uid) return;
      if (role === "chofer") {
        updateSplashSync(58, "Sincronizando datos de EXPLORA…");

        // v4126: toda la ruta crítica arranca en paralelo. Antes el vehículo se
        // esperaba primero, luego semana/cierre y recién después el módulo financiero.
        // Eso sumaba latencias de red. Ahora pagamos solo la consulta más lenta.
        const vehicleTask = (async () => {
          try {
            const vehicle = await profileWithTimeout(loadDriverVehicle(profile, loaded.profileDocumentId), 4200, "VEHICLE_PREFLIGHT_TIMEOUT");
            if (auth.currentUser?.uid === authUser.uid) {
              exploraSession.vehicle = vehicle;
              exploraSession.vehicleId = vehicle?.id || "";
              exploraAccessState.vehicle = vehicle;
              renderDriverHeader(profile, vehicle);
              renderProfileVehicleAssignment(profile, vehicle);
            }
            return vehicle;
          } catch (vehicleError) {
            loginDevDiagnostic("VEHICLE_PREFLIGHT_SKIPPED", { code: vehicleError && (vehicleError.message || vehicleError.code) || "unknown" });
            return null;
          }
        })();

        try { window.ExploraFastCache?.invalidate?.("dashboard_weekly_billing", { uid:authUser.uid, role:"chofer", weeklyPeriodId:getActiveWeeklyPeriod().id }); } catch (_) {}
        try { window.ExploraFastCache?.invalidate?.("dashboard_weekly_expenses", { uid:authUser.uid, role:"chofer", weeklyPeriodId:getActiveWeeklyPeriod().id }); } catch (_) {}

        const weeklyTask = (async () => {
          try {
            const weeklyPromise = window.ExploraWeeklyEngine?.loadOnce?.({ force:true, reason:"session-preopen-sync" }) || loadWeeklyEngine({ force:true, reason:"session-preopen-sync" });
            const closurePromise = Promise.resolve(refreshDriverPaymentStatus({ force:true })).catch(() => null);
            await profileWithTimeout(Promise.allSettled([weeklyPromise, closurePromise]), 7200, "DASHBOARD_PREFLIGHT_TIMEOUT");
            return true;
          } catch (weeklyError) {
            loginDevDiagnostic("DASHBOARD_PREFLIGHT_SKIPPED", { code: weeklyError && (weeklyError.message || weeklyError.code) || "unknown" });
            return false;
          }
        })();

        const financialTask = (async () => {
          const started = Date.now();
          while (!window.ExploraPagoHome?.waitUntilReady && Date.now() - started < 6000) await delay(30);
          if (!window.ExploraPagoHome?.waitUntilReady) throw new Error("PAGO_HOME_MODULE_NOT_READY");
          return window.ExploraPagoHome.waitUntilReady({ uid:authUser.uid, timeout:12000 });
        })();

        updateSplashSync(76, "Actualizando saldos, actividad, gastos y cierres…");
        const results = await Promise.allSettled([vehicleTask, weeklyTask, financialTask]);
        if (results[2].status === "rejected") {
          throw Object.assign(new Error("FINANCIAL_PREFLIGHT_NOT_READY"), { cause:results[2].reason });
        }
        updateSplashSync(96, "Información sincronizada. Abriendo EXPLORA…");
        return;
      }

      if (role === "admin") {
        updateSplashSync(66, "Actualizando panel administrativo…");
        try {
          const overview = await profileWithTimeout(getAdminWeeklyOverview("", { force:true }), 9000, "ADMIN_PREFLIGHT_TIMEOUT");
          if (overview) adminSharedState.overview = overview;
        } catch (adminError) {
          loginDevDiagnostic("ADMIN_PREFLIGHT_SKIPPED", { code: adminError && (adminError.message || adminError.code) || "unknown" });
        }
        updateSplashSync(94, "Panel administrativo listo. Preparando menú…");
      }
    }

    async function performAuthenticatedExploraSessionOpen(authUser, options = {}) {
      const preserveOpenUI = Boolean(
        options.preserveOpenUI &&
        authSessionState.uiOpened &&
        authSessionState.authenticatedUser?.uid === authUser?.uid
      );
      if (!preserveOpenUI) {
        beginSplashSync("Restaurando sesión y verificando datos actuales…");
        resetCurrentSessionUI();
      } else {
        loginDevDiagnostic("SESSION_REFRESH_IN_BACKGROUND", { uid: authUser.uid });
      }
      const sessionGeneration = Number(exploraSession.generation || 0) + 1;
      exploraSession.generation = sessionGeneration;
      exploraSession.closing = false;
      exploraSession.authReady = false;
      authSessionState.profileLoading = true;
      updateSplashSync(18, "Verificando usuario autenticado…");

      const loaded = await withTimeout(loadLegacyExploraProfile(authUser), 10000, "PROFILE_TIMEOUT");
      updateSplashSync(44, "Perfil actualizado desde EXPLORA…");
      const rawProfile = loaded.profile || {};
      const role = secureLegacyRoleForAuth(rawProfile, authUser, loaded.role || "");
      if (!loaded.active) throw new Error("PROFILE_DISABLED");
      if (!role) throw new Error("PROFILE_ROLE_INVALID");
      if (role === "admin" && !EXPLORA_ADMIN_UIDS.has(authUser.uid)) throw new Error("PROFILE_ROLE_INVALID");
      const profile = { ...rawProfile, role: role === "admin" ? "admin" : "driver", rol: role === "admin" ? "admin" : "chofer" };

      exploraSession.authUser = authUser;
      exploraSession.driverId = loaded.profileDocumentId;
      exploraSession.profileDocumentId = loaded.profileDocumentId;
      exploraSession.profileCollection = loaded.collectionName || loaded.profileRef?.parent?.id || EXPLORA_LEGACY_PROFILE_COLLECTION;
      exploraSession.profileRef = loaded.profileRef;
      exploraSession.profile = profile;
      exploraSession.role = role;
      exploraSession.initialized = Boolean(exploraSession.profileRef && exploraSession.profileDocumentId && exploraSession.profileCollection);
      exploraSession.openedAt = Date.now();
      exploraSession.vehicle = null;
      exploraSession.vehicleId = "";

      authSessionState.authenticatedUser = authUser;
      authSessionState.profile = profile;
      authSessionState.profileDocumentId = loaded.profileDocumentId;
      authSessionState.profileCollection = exploraSession.profileCollection;
      authSessionState.role = role;

      exploraAccessState.user = authUser;
      exploraAccessState.uid = authUser.uid;
      exploraAccessState.profile = profile;
      exploraAccessState.role = role;
      exploraAccessState.isAdmin = role === "admin";
      exploraAccessState.vehicle = null;

      loginDevDiagnostic("LEGACY_ROLE_RESOLVED", { role });
      applyDriverDataToUI();
      saveVisualSession();
      await preloadFreshDashboardDataBeforeOpen(role, authUser, profile, loaded);

      if (auth.currentUser?.uid !== authUser.uid || exploraSession.generation !== sessionGeneration || exploraSession.closing) {
        throw new Error("SESSION_OPEN_REPLACED");
      }

      if (role === "admin") {
        loginDevDiagnostic("ACCESS_ADMIN", {});
        await showAdminApp();
      } else {
        loginDevDiagnostic("ACCESS_DRIVER", {});
        await showDriverApp();
      }
      exploraSession.authReady = true;
      const sessionDetail = { uid: authUser.uid, role, generation: sessionGeneration, profileResolved: true, sessionInitialized: true };
      window.dispatchEvent(new CustomEvent("explora:auth-ready", { detail: sessionDetail }));
      window.dispatchEvent(new CustomEvent("explora:session-opened", { detail: sessionDetail }));
      return { user: authUser, profile, role, profileDocumentId: loaded.profileDocumentId, generation: sessionGeneration };
    }

    async function openAuthenticatedExploraSession(authUser, options = {}) {
      if (!authUser || !authUser.uid) throw new Error("AUTH_USER_MISSING");
      if (activeSessionOpenPromise && activeSessionUid === authUser.uid) {
        return activeSessionOpenPromise;
      }

      activeSessionUid = authUser.uid;
      activeSessionOpenPromise = performAuthenticatedExploraSessionOpen(authUser, options)
        .finally(() => {
          authSessionState.profileLoading = false;
          activeSessionOpenPromise = null;
          activeSessionUid = "";
        });
      return activeSessionOpenPromise;
    }

    function resetCurrentSessionUI() {
      exploraSession.closing = true;
      exploraSession.generation = Number(exploraSession.generation || 0) + 1;
      exploraSession.authReady = false;
      exploraSession.initialized = false;
      window.ExploraWeeklyEngine?.stop();
      window.ExploraStopWeeklyBilling?.();
      authSessionState.profile = null;
      authSessionState.profileDocumentId = "";
      authSessionState.profileCollection = "";
      authSessionState.role = null;
      authSessionState.uiOpened = false;
      resetExploraAccessState();
      clearAuthenticatedUI();
      document.body.classList.remove("explora-authenticated", "explora-admin-authenticated", "explora-role-blocked", "explora-shared-admin");
      closeAdminCreateDriverModal?.();
    }

    function legacyAccessErrorMessage(error) {
      const code = String(error && (error.message || error.code) || "");
      if (code.includes("PROFILE_TIMEOUT")) return "No se pudo cargar tu perfil por un problema de conexión.";
      if (code.includes("PROFILE_NOT_FOUND") || code.includes("PROFILE_USERNAME_MISSING")) return "No se encontró un perfil válido para esta cuenta.";
      if (code.includes("PROFILE_DISABLED")) return "Tu cuenta está desactivada.";
      if (code.includes("PROFILE_ROLE_INVALID")) return "La cuenta no tiene un rol válido. Contacta al administrador.";
      if (code.includes("permission-denied")) return "No se pudo acceder a tu perfil. Contacta al administrador.";
      return "No se pudo cargar tu perfil.";
    }


    async function getAuthenticatedLoginAlias(user) {
      if (!user) return null;

      let username = "";
      try {
        username = normalizeUsername(localStorage.getItem(EXPLORA_SESSION_PREFIX + "last_username") || "");
      } catch (_) {}

      if (!username && user.email) {
        username = normalizeUsername(String(user.email).split("@")[0] || "");
      }

      if (!username) return null;

      try {
        const snap = await getDoc(doc(db, "login_aliases", username));
        if (!snap.exists()) return null;

        const data = snap.data() || {};
        const expectedUid = getAliasExpectedUid(data);
        const email = getAliasEmail(data);
        const uidOk = !expectedUid || expectedUid === user.uid;
        const emailOk = !email || String(email).toLowerCase() === String(user.email || "").toLowerCase();

        if (!uidOk || !emailOk || isAliasInactive(data)) return null;

        return {
          username,
          role: getAliasRole(data),
          uid: expectedUid || user.uid,
          email
        };
      } catch (_) {
        return null;
      }
    }

    function isAdminRole(role) {
      return role === "admin" || role === "administrador" || role === "owner";
    }

    async function findAuthenticatedProfile(user) {
      if (!user) throw new Error("No hay usuario autenticado.");
      const email = String(user.email || "").trim().toLowerCase();
      const username = normalizedEmailUser(user);
      const collectionsToCheck = ["choferes", "administradores", "admins", "usuarios"];
      const ids = Array.from(new Set([user.uid, username, email].filter(Boolean)));

      for (const collectionName of collectionsToCheck) {
        for (const id of ids) {
          const ref = doc(db, collectionName, id);
          const snap = await getDoc(ref).catch(() => null);
          if (snap && snap.exists()) return { id: snap.id, ref, data: snap.data() || {}, collectionName };
        }
      }

      for (const collectionName of collectionsToCheck) {
        const qUid = await getDocs(query(collection(db, collectionName), where("uid", "==", user.uid))).catch(() => null);
        if (qUid && !qUid.empty) {
          const snap = qUid.docs[0];
          return { id: snap.id, ref: doc(db, collectionName, snap.id), data: snap.data() || {}, collectionName };
        }
        if (email) {
          const qEmail = await getDocs(query(collection(db, collectionName), where("email", "==", email))).catch(() => null);
          if (qEmail && !qEmail.empty) {
            const snap = qEmail.docs[0];
            return { id: snap.id, ref: doc(db, collectionName, snap.id), data: snap.data() || {}, collectionName };
          }
        }
      }

      throw new Error("Tu usuario no tiene perfil creado en EXPLORA.");
    }

    const adminDriverProfileCache = new Map();
    const adminWeeklySnapshotCache = new Map();
    const adminClosureCache = new Map();

    const adminSharedState = {
      mode: "home",
      previousMode: "home",
      periodMode: "week",
      receiptTab: "payments",
      overview: null,
      selectedDriverKey: "",
      loading: false,
      loadPromise: null,
      previousScrollY: 0,
      receiptFile: null,
      receiptPreviewUrl: "",
      fixedFinancialRules: null
    };
    let loanSaveInProgress=false;
    let operationalLoanDiagnosticState=null;
    let adminClosureReceiptInProgress=false;

    function escapeAdminHtml(value = "") {
      return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
    }

    function adminMoney(value) {
      return new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Number(value || 0));
    }

    function adminDateTime(value) {
      const ms = firestoreDateMs(value);
      if (!ms) return "—";
      return new Intl.DateTimeFormat("es-AR", {
        timeZone:"America/Argentina/Cordoba", day:"2-digit", month:"2-digit", year:"numeric",
        hour:"2-digit", minute:"2-digit", hour12:false
      }).format(new Date(ms));
    }

    function normalizeAdminUsername(value) {
      return normalizeUsername(value);
    }

    function adminMsg(message = "", type = "") {
      const box = $("adminCreateMsg");
      if (!box) return;
      box.textContent = message;
      box.className = "admin-create-msg" + (type ? ` ${type}` : "");
    }

    function isDriverActive(data = {}) {
      const estado = String(data.estado || data.status || data.state || "").trim().toLowerCase();
      const deletionStatus = String(data.deletionStatus || "").trim().toLowerCase();
      if (data.activo === false || data.active === false || data.habilitado === false) return false;
      if (data.isDeleted === true || data.deleted === true || data.eliminado === true) return false;
      if (["inactivo","bloqueado","suspendido","deleted","deleting","deletion_failed","borrado","eliminado"].includes(estado)) return false;
      if (["running","completed","failed"].includes(deletionStatus)) return false;
      return true;
    }

    function adminVehicleLabel(vehicle = {}) {
      const brand = vehicle.marca || vehicle.brand || "";
      const model = vehicle.model || vehicle.modelo || vehicle.marcaModelo || vehicle.nombre || vehicle.tipo || "Vehículo";
      const plate = vehicle.plate || vehicle.plateNormalized || vehicle.patente || vehicle.matricula || vehicle.dominio || "";
      const label = [brand, model].filter(Boolean).join(" ").trim() || "Vehículo";
      return plate ? `${label} · ${String(plate).toUpperCase()}` : label;
    }

    function adminDriverRole(data = {}) {
      const raw = String(data.rol || data.role || data.tipo || "").trim().toLowerCase();
      if (["admin","administrador","owner","superadmin"].includes(raw)) return "admin";
      if (["chofer","driver","conductor"].includes(raw)) return "chofer";
      return raw || "chofer";
    }

    function profileHasRequiredDriverName(data = {}) {
      return Boolean(String(data.nombre || data.nombreCompleto || data.displayName || data.name || "").trim());
    }

    function isVisibleDriverProfile(data = {}, { includeInactive = false, includeDeleted = false, includeOrphans = false } = {}) {
      const role = adminDriverRole(data);
      const uid = adminDriverKey(data);
      if (role !== "chofer") return false;
      if (EXPLORA_ADMIN_UIDS.has(uid) || EXPLORA_ADMIN_UIDS.has(String(data.id || ""))) return false;
      if (!includeDeleted && (data.isDeleted === true || data.deleted === true || ["deleted","deleting","deletion_failed","borrado","eliminado"].includes(String(data.status || data.estado || "").toLowerCase()))) return false;
      if (!includeInactive && !isDriverActive(data)) return false;
      if (!includeOrphans && !profileHasRequiredDriverName(data)) return false;
      return true;
    }

    function adminDriverKey(driver = {}) {
      return String(driver.uid || driver.authUid || driver.firebaseUid || driver.userId || driver.id || "").trim();
    }

    function adminDriverIdentities(driver = {}) {
      return new Set([
        driver.id, driver.uid, driver.authUid, driver.firebaseUid, driver.userId,
        driver.usuario, driver.username, driver.usuarioNormalizado, driver.email, driver.correo
      ].map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
    }

    function adminRecordMatchesDriver(data = {}, driver = {}) {
      const identities = adminDriverIdentities(driver);
      return getRecordDriverAliases(data).some(value => identities.has(String(value || "").trim().toLowerCase()));
    }

    async function loadAdminVehicles({ includeDeleted = false } = {}) {
      try {
        const snap = await getDocs(collection(db, "vehiculos"));
        const vehicles = [];
        snap.forEach((docSnap) => {
          const data = { id:docSnap.id, ...docSnap.data() };
          const deleted = data.isDeleted === true || String(data.status || "").toLowerCase() === "deleted";
          if (!includeDeleted && deleted) return;
          vehicles.push(data);
        });
        return vehicles.sort((a,b) => String(a.plate || a.plateNormalized || a.patente || a.id).localeCompare(String(b.plate || b.plateNormalized || b.patente || b.id), "es"));
      } catch (error) {
        showVehicleDiagnostic("READ_VEHICLES", "VEHICLE_READ_FAILED", error, { functionName:"loadAdminVehicles", firestorePath:"vehiculos", queryUsed:"getDocs(collection(vehiculos))" });
        throw error;
      }
    }

    const vehicleDiagnosticSeen = new Set();

    function normalizeVehiclePlate(value) {
      return String(value || "").toUpperCase().trim().replace(/\s+/g, "").replace(/[^A-Z0-9-]/g, "");
    }

    function normalizeVehicleModel(value) {
      return String(value || "").trim().replace(/\s+/g, " ");
    }

    function vehicleInternalError(stage, code, message, cause = null, context = {}) {
      const error = new Error(message || code);
      error.code = code;
      error.internalCode = code;
      error.vehicleStage = stage;
      error.vehicleContext = context;
      if (cause) {
        error.cause = cause;
        error.firebaseCode = String(cause.code || "");
        error.firebaseMessage = String(cause.message || cause || "");
        error.stack = cause.stack || error.stack;
      }
      return error;
    }

    function vehicleFormMessage(message = "", type = "") {
      const element = $("vehicleFormMessage");
      if (!element) return;
      element.textContent = message;
      element.className = `admin-create-msg${type ? ` ${type}` : ""}`;
    }

    function vehicleAdminSession() {
      const user = auth.currentUser;
      const role = secureLegacyRoleForAuth(exploraSession.profile || {}, user, exploraSession.role || "");
      return { user, uid:user?.uid || "", role, isAdmin:Boolean(user?.uid && EXPLORA_ADMIN_UIDS.has(user.uid) && role === "admin") };
    }

    const adminManagementState = { drivers:[], vehicles:[], confirmResolve:null, busy:false, deletingVehicleId:null };

    function showVehicleDiagnostic(stage, code, error, context = {}) {
      const session = vehicleAdminSession();
      const vehicleId = String(context.vehicleId || context.plateNormalized || context.plate || "—");
      const driverUid = String(context.driverUid || "—");
      const signature = ["ADMIN_DRIVER_VEHICLE_MANAGEMENT", stage || "—", code || "—", vehicleId, driverUid].join("|");
      let alreadySeen = vehicleDiagnosticSeen.has(signature);
      try { alreadySeen = alreadySeen || sessionStorage.getItem(`explora_admin_management_diag_${signature}`) === "1"; } catch (_) {}
      if (alreadySeen) return;
      vehicleDiagnosticSeen.add(signature);
      try { sessionStorage.setItem(`explora_admin_management_diag_${signature}`, "1"); } catch (_) {}
      const firebaseError = error?.cause || error;
      const payload = [
        "EXPLORA - ERROR ADMIN_DRIVER_VEHICLE_MANAGEMENT",
        "MÓDULO: ADMIN_DRIVER_VEHICLE_MANAGEMENT",
        `ETAPA: ${stage || "—"}`,
        "TIPO_EVENTO: ERROR",
        `CÓDIGO INTERNO: ${code || error?.internalCode || error?.code || "—"}`,
        `MENSAJE REAL FIREBASE: ${firebaseError?.code ? `${firebaseError.code} · ` : ""}${firebaseError?.message || "—"}`,
        `MENSAJE REAL JAVASCRIPT: ${error?.message || String(error || "—")}`,
        `STACK: ${error?.stack || "—"}`,
        `FUNCIÓN: ${context.functionName || "—"}`,
        `UID AUTH: ${session.uid || "—"}`,
        `ROL: ${session.role || "—"}`,
        `DRIVER UID: ${driverUid}`,
        `DRIVER EMAIL: ${context.driverEmail || "—"}`,
        `DRIVER NAME: ${context.driverName || "—"}`,
        `VEHICLE ID: ${vehicleId}`,
        `PATENTE: ${context.plate || "—"}`,
        `MODELO: ${context.model || "—"}`,
        `RUTA FIRESTORE: ${context.firestorePath || "—"}`,
        `QUERY USADA: ${context.queryUsed || "—"}`,
        `DOCUMENTOS AFECTADOS: ${context.documentsAffected ?? "—"}`,
        `TIMESTAMP: ${new Date().toISOString()}`
      ].join("\n");
      const panel = $("vehicleDiagnosticBackdrop");
      const output = $("vehicleDiagnosticText");
      if (output) output.textContent = payload;
      panel?.classList.add("is-open");
      panel?.setAttribute("aria-hidden", "false");
      window.lockPageScroll?.("vehicle-diagnostic");
    }

    function closeVehicleDiagnostic() {
      const panel = $("vehicleDiagnosticBackdrop");
      panel?.classList.remove("is-open");
      panel?.setAttribute("aria-hidden", "true");
      window.unlockPageScroll?.("vehicle-diagnostic");
    }

    async function copyVehicleDiagnostic() {
      const value = $("vehicleDiagnosticText")?.textContent || "";
      try { await navigator.clipboard.writeText(value); }
      catch (_) {
        const area = document.createElement("textarea");
        area.value = value;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
    }

    function assertVehicleAdmin(stage = "ADMIN_ONLY_CHECK") {
      const session = vehicleAdminSession();
      if (!session.isAdmin) {
        const error = vehicleInternalError(stage, "VEHICLE_ADMIN_ONLY", "Sólo Administrador puede gestionar choferes y vehículos.");
        showVehicleDiagnostic(stage, "VEHICLE_ADMIN_ONLY", error, { functionName:"assertVehicleAdmin", firestorePath:"choferes / vehiculos" });
        throw error;
      }
      return session;
    }

    function openAdminManagementConfirm({ title = "CONFIRMAR", message = "¿Deseás continuar?", confirmLabel = "CONFIRMAR", tone = "danger" } = {}) {
      const backdrop = $("adminManagementConfirmBackdrop");
      const accept = $("adminManagementConfirmAccept");
      if (!backdrop || !accept) return Promise.resolve(false);
      if (adminManagementState.confirmResolve) adminManagementState.confirmResolve(false);
      $("adminManagementConfirmTitle").textContent = title;
      $("adminManagementConfirmMessage").textContent = message;
      accept.textContent = confirmLabel;
      accept.classList.toggle("is-gold", tone === "gold");
      backdrop.classList.add("is-open");
      backdrop.setAttribute("aria-hidden", "false");
      window.lockPageScroll?.("admin-management-confirm");
      return new Promise(resolve => { adminManagementState.confirmResolve = resolve; requestAnimationFrame(() => accept.focus()); });
    }

    function closeAdminManagementConfirm(result = false) {
      const backdrop = $("adminManagementConfirmBackdrop");
      backdrop?.classList.remove("is-open");
      backdrop?.setAttribute("aria-hidden", "true");
      window.unlockPageScroll?.("admin-management-confirm");
      const resolve = adminManagementState.confirmResolve;
      adminManagementState.confirmResolve = null;
      if (resolve) resolve(Boolean(result));
    }

    function vehicleAssignmentState(data = {}) {
      const currentDriverUid = String(data.currentDriverUid || data.choferId || data.conductorId || data.driverId || data.asignadoA || data.uidChofer || data.chofer || "").trim();
      return { currentDriverUid, assigned:Boolean(data.isAssigned === true || currentDriverUid) };
    }

    function vehicleSelectLabel(vehicle = {}) {
      const plate = normalizeVehiclePlate(vehicle.plate || vehicle.plateNormalized || vehicle.patente || vehicle.matricula || vehicle.dominio || vehicle.id);
      const model = normalizeVehicleModel(vehicle.model || vehicle.modelo || vehicle.marcaModelo || vehicle.nombre || vehicle.tipo || "Vehículo");
      return `${plate || vehicle.id} — ${model}`;
    }

    async function resolveDriverDocumentByIdentity(identity = "", driverName = "") {
      const cleanIdentity = String(identity || "").trim().toLowerCase();
      const cleanName = normalizeVehicleModel(driverName).toLowerCase();
      if (!cleanIdentity && !cleanName) return null;
      const cached = adminManagementState.drivers.find(driver => {
        const identities = adminDriverIdentities(driver);
        return (cleanIdentity && identities.has(cleanIdentity)) || (cleanName && getProfileName(driver).toLowerCase() === cleanName);
      });
      if (cached) return cached;
      if (cleanIdentity) {
        const direct = await getDoc(doc(db, "choferes", identity)).catch(() => null);
        if (direct?.exists()) return { id:direct.id, ...direct.data() };
      }
      const snapshot = await getDocs(collection(db, "choferes"));
      let found = null;
      snapshot.forEach(item => {
        if (found) return;
        const driver = { id:item.id, ...(item.data() || {}) };
        const identities = adminDriverIdentities(driver);
        if ((cleanIdentity && identities.has(cleanIdentity)) || (cleanName && getProfileName(driver).toLowerCase() === cleanName)) found = driver;
      });
      return found;
    }

    async function validateVehicleAvailability(vehicleId, { driverUid = "", driverDocumentId = "", driverName = "", allowReassign = false } = {}) {
      if (!vehicleId) return null;
      assertVehicleAdmin("ADMIN_ONLY_CHECK");
      try {
        const snap = await getDoc(doc(db, "vehiculos", vehicleId));
        if (!snap.exists()) throw vehicleInternalError("READ_VEHICLES", "VEHICLE_READ_FAILED", "El vehículo seleccionado no existe.", null, { vehicleId });
        const data = snap.data() || {};
        if (data.isDeleted === true || String(data.status || "").toLowerCase() === "deleted") throw vehicleInternalError("ASSIGN_VEHICLE_TO_DRIVER", "VEHICLE_ASSIGNMENT_FAILED", "El vehículo seleccionado está eliminado.", null, { vehicleId });
        const assignment = vehicleAssignmentState(data);
        const allowed = new Set([driverUid, driverDocumentId, driverName].map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
        const conflict = assignment.assigned && !allowed.has(assignment.currentDriverUid.toLowerCase());
        if (conflict && !allowReassign) {
          const error = vehicleInternalError("ASSIGN_VEHICLE_TO_DRIVER", "VEHICLE_ASSIGNMENT_FAILED", `Ese vehículo está asignado a ${data.currentDriverName || "otro chofer"}.`, null, { vehicleId });
          error.assignmentConflict = true;
          error.currentDriverUid = assignment.currentDriverUid;
          error.currentDriverName = data.currentDriverName || "";
          throw error;
        }
        return { id:snap.id, ...data, assignmentConflict:conflict };
      } catch (error) {
        if (error?.assignmentConflict) throw error;
        const internal = error?.internalCode ? error : vehicleInternalError("READ_VEHICLES", "VEHICLE_READ_FAILED", "No se pudo verificar el vehículo seleccionado.", error, { vehicleId });
        showVehicleDiagnostic(internal.vehicleStage || "READ_VEHICLES", internal.internalCode || "VEHICLE_READ_FAILED", internal, { functionName:"validateVehicleAvailability", vehicleId, driverUid, driverName, firestorePath:`vehiculos/${vehicleId}`, queryUsed:"getDoc" });
        throw internal;
      }
    }

    const emptyDriverVehiclePatch = Object.freeze({
      assignedVehicleId:null, assignedVehiclePlate:null, assignedVehicleModel:null,
      vehicleId:null, vehiculoId:null, vehiculo:"", modeloVehiculo:null, patenteVehiculo:null
    });

    async function assignVehicleToDriver({ driverDocumentId, driverUid, driverName, vehicleId = "", driverPatch = {}, allowReassign = false } = {}) {
      const session = assertVehicleAdmin("ADMIN_ONLY_CHECK");
      const cleanDriverDocumentId = String(driverDocumentId || "").trim();
      const cleanDriverUid = String(driverUid || "").trim();
      const cleanDriverName = normalizeVehicleModel(driverName);
      const cleanVehicleId = String(vehicleId || "").trim();
      if (!cleanDriverDocumentId) throw vehicleInternalError("UPDATE_DRIVER_VEHICLE", "DRIVER_VEHICLE_UPDATE_FAILED", "Falta el documento del chofer.");
      let reassignedDriver = null;
      try {
        let preloadedVehicle = null;
        if (cleanVehicleId) {
          preloadedVehicle = await validateVehicleAvailability(cleanVehicleId, { driverUid:cleanDriverUid, driverDocumentId:cleanDriverDocumentId, driverName:cleanDriverName, allowReassign });
          const assignment = vehicleAssignmentState(preloadedVehicle || {});
          const permitted = new Set([cleanDriverUid, cleanDriverDocumentId, cleanDriverName].map(v => String(v || "").trim().toLowerCase()).filter(Boolean));
          if (assignment.assigned && !permitted.has(assignment.currentDriverUid.toLowerCase())) {
            reassignedDriver = await resolveDriverDocumentByIdentity(preloadedVehicle.currentDriverDocumentId || assignment.currentDriverUid, preloadedVehicle.currentDriverName || "");
          }
        }
        await runTransaction(db, async transaction => {
          const driverRef = doc(db, "choferes", cleanDriverDocumentId);
          const driverSnap = await transaction.get(driverRef);
          const currentDriver = driverSnap.exists() ? (driverSnap.data() || {}) : {};
          const previousVehicleId = String(currentDriver.assignedVehicleId || currentDriver.vehicleId || currentDriver.vehiculoId || currentDriver.vehiculo || currentDriver.autoId || "").trim();
          const previousRef = previousVehicleId && previousVehicleId !== cleanVehicleId ? doc(db, "vehiculos", previousVehicleId) : null;
          const nextRef = cleanVehicleId ? doc(db, "vehiculos", cleanVehicleId) : null;
          const reassignedDriverRef = reassignedDriver?.id && reassignedDriver.id !== cleanDriverDocumentId ? doc(db, "choferes", reassignedDriver.id) : null;
          const previousSnap = previousRef ? await transaction.get(previousRef) : null;
          const nextSnap = nextRef ? await transaction.get(nextRef) : null;
          const reassignedDriverSnap = reassignedDriverRef ? await transaction.get(reassignedDriverRef) : null;

          let nextVehicle = null;
          if (nextRef) {
            if (!nextSnap?.exists()) throw vehicleInternalError("ASSIGN_VEHICLE_TO_DRIVER", "VEHICLE_READ_FAILED", "El vehículo seleccionado no existe.", null, { vehicleId:cleanVehicleId });
            nextVehicle = nextSnap.data() || {};
            if (nextVehicle.isDeleted === true || String(nextVehicle.status || "").toLowerCase() === "deleted") throw vehicleInternalError("ASSIGN_VEHICLE_TO_DRIVER", "VEHICLE_ASSIGNMENT_FAILED", "El vehículo seleccionado está eliminado.", null, { vehicleId:cleanVehicleId });
            const assignment = vehicleAssignmentState(nextVehicle);
            const permitted = new Set([cleanDriverUid, cleanDriverDocumentId, cleanDriverName].map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
            if (assignment.assigned && !permitted.has(assignment.currentDriverUid.toLowerCase()) && !allowReassign) {
              throw vehicleInternalError("ASSIGN_VEHICLE_TO_DRIVER", "VEHICLE_ASSIGNMENT_FAILED", "Ese vehículo ya está asignado a otro chofer.", null, { vehicleId:cleanVehicleId });
            }
          }

          if (previousRef && previousSnap?.exists()) {
            const previousData = previousSnap.data() || {};
            const previousAssignment = vehicleAssignmentState(previousData);
            const identities = new Set([cleanDriverUid, cleanDriverDocumentId, cleanDriverName].map(value => String(value || "").trim().toLowerCase()).filter(Boolean));
            if (!previousAssignment.currentDriverUid || identities.has(previousAssignment.currentDriverUid.toLowerCase())) {
              transaction.set(previousRef, { currentDriverUid:null, currentDriverDocumentId:null, currentDriverName:null, isAssigned:false, chofer:null, choferId:null, conductorId:null, driverId:null, asignadoA:null, uidChofer:null, updatedAt:serverTimestamp(), updatedByUid:session.uid }, { merge:true });
            }
          }

          if (reassignedDriverRef && reassignedDriverSnap?.exists()) {
            transaction.set(reassignedDriverRef, { ...emptyDriverVehiclePatch, updatedAt:serverTimestamp(), actualizado:serverTimestamp() }, { merge:true });
          }

          const plate = nextVehicle ? normalizeVehiclePlate(nextVehicle.plate || nextVehicle.plateNormalized || nextVehicle.patente || cleanVehicleId) : "";
          const model = nextVehicle ? normalizeVehicleModel(nextVehicle.model || nextVehicle.modelo || nextVehicle.marcaModelo || nextVehicle.nombre || "") : "";
          const assignmentPatch = cleanVehicleId ? { assignedVehicleId:cleanVehicleId, assignedVehiclePlate:plate, assignedVehicleModel:model, vehicleId:cleanVehicleId, vehiculoId:cleanVehicleId, vehiculo:cleanVehicleId, modeloVehiculo:model, patenteVehiculo:plate } : { ...emptyDriverVehiclePatch };
          transaction.set(driverRef, { ...driverPatch, ...assignmentPatch, updatedAt:serverTimestamp(), actualizado:serverTimestamp() }, { merge:true });

          if (nextRef) {
            transaction.set(nextRef, { vehicleId:cleanVehicleId, currentDriverUid:cleanDriverUid || cleanDriverDocumentId, currentDriverDocumentId:cleanDriverDocumentId, currentDriverName:cleanDriverName, isAssigned:true, chofer:cleanDriverDocumentId, choferId:cleanDriverUid || cleanDriverDocumentId, driverId:cleanDriverUid || cleanDriverDocumentId, updatedAt:serverTimestamp(), updatedByUid:session.uid, status:"active", isDeleted:false }, { merge:true });
          }
        });
        return true;
      } catch (error) {
        const internal = error?.internalCode ? error : vehicleInternalError("UPDATE_VEHICLE_ASSIGNMENT", cleanVehicleId ? "VEHICLE_ASSIGNMENT_FAILED" : "VEHICLE_RELEASE_FAILED", "No se pudo actualizar la asignación del vehículo.", error, { vehicleId:cleanVehicleId });
        showVehicleDiagnostic(internal.vehicleStage || "UPDATE_VEHICLE_ASSIGNMENT", internal.internalCode || "VEHICLE_ASSIGNMENT_FAILED", internal, { functionName:"assignVehicleToDriver", driverUid:cleanDriverUid, driverName:cleanDriverName, vehicleId:cleanVehicleId, firestorePath:`choferes/${cleanDriverDocumentId} + vehiculos/${cleanVehicleId || "anterior"}`, queryUsed:"getDoc + runTransaction", documentsAffected:reassignedDriver ? 3 : 2 });
        throw internal;
      }
    }

    function vehicleCardMarkup(vehicle = {}) {
      const plate = normalizeVehiclePlate(vehicle.plate || vehicle.plateNormalized || vehicle.patente || vehicle.id);
      const model = normalizeVehicleModel(vehicle.model || vehicle.modelo || vehicle.marcaModelo || vehicle.nombre || "Vehículo");
      const assignment = vehicleAssignmentState(vehicle);
      const stateText = assignment.assigned ? `Asignado a ${vehicle.currentDriverName || assignment.currentDriverUid || "chofer"}` : "Disponible";
      return `<article class="admin-vehicle-card" data-vehicle-card="${escapeAdminHtml(vehicle.id)}"><div class="admin-vehicle-card-head"><div><strong>${escapeAdminHtml(plate)}</strong><span>${escapeAdminHtml(model)}</span><small>${escapeAdminHtml(stateText)}</small></div><button class="admin-vehicle-delete" type="button" data-admin-delete-vehicle="${escapeAdminHtml(vehicle.id)}">BORRAR VEHÍCULO</button></div></article>`;
    }

    async function renderAdminVehicleList() {
      const list = $("adminVehicleList"), status = $("adminVehicleListStatus");
      if (!list) return;
      if (status) status.textContent = "Cargando…";
      try {
        const vehicles = await loadAdminVehicles();
        adminManagementState.vehicles = vehicles;
        list.innerHTML = vehicles.length ? vehicles.map(vehicleCardMarkup).join("") : '<div class="admin-management-empty">No hay vehículos creados.</div>';
        if (status) status.textContent = `${vehicles.length} vehículo${vehicles.length === 1 ? "" : "s"}`;
        fillAdminVehicleSelect(vehicles);
      } catch (error) {
        list.innerHTML = '<div class="admin-management-empty">No se pudo cargar la lista de vehículos.</div>';
        if (status) status.textContent = "Error";
      }
    }

    async function createVehicleRecord(event) {
      event?.preventDefault?.();
      const button = $("vehicleFormSaveBtn");
      const plate = normalizeVehiclePlate($("vehiclePlateInput")?.value || "");
      const model = normalizeVehicleModel($("vehicleModelInput")?.value || "");
      const vehicleId = plate;
      let stage = "VALIDATE_VEHICLE_FORM";
      try {
        const session = assertVehicleAdmin("OPEN_CREATE_VEHICLE");
        if (!plate) throw vehicleInternalError(stage, "VEHICLE_REQUIRED_PLATE", "La patente es obligatoria.");
        if (!model) throw vehicleInternalError(stage, "VEHICLE_REQUIRED_MODEL", "El modelo es obligatorio.");
        if (button) { button.disabled = true; button.textContent = "GUARDANDO…"; }
        vehicleFormMessage("Verificando patente…");
        stage = "CHECK_DUPLICATE_PLATE";
        const ref = doc(db, "vehiculos", vehicleId);
        const existing = await getDoc(ref);
        if (existing.exists()) throw vehicleInternalError(stage, "VEHICLE_DUPLICATE_PLATE", "Ya existe un vehículo con esa patente.");
        stage = "SAVE_VEHICLE";
        await setDoc(ref, { vehicleId, plate, plateNormalized:plate, model, currentDriverUid:null, currentDriverDocumentId:null, currentDriverName:null, isAssigned:false, createdAt:serverTimestamp(), createdByUid:session.uid, updatedAt:serverTimestamp(), updatedByUid:session.uid, status:"active", isDeleted:false, schemaVersion:2 }, { merge:false });
        vehicleFormMessage("Vehículo creado correctamente.", "ok");
        if ($("vehiclePlateInput")) $("vehiclePlateInput").value = "";
        if ($("vehicleModelInput")) $("vehicleModelInput").value = "";
        await renderAdminVehicleList();
        invalidateAdminWeeklyData("vehicle-created");
        window.showExploraSuccess?.({ title:"VEHÍCULO CREADO", message:`${plate} — ${model}` });
      } catch (error) {
        const code = error?.internalCode || error?.code || "VEHICLE_SAVE_FAILED";
        const internal = error?.internalCode ? error : vehicleInternalError(stage, "VEHICLE_SAVE_FAILED", "No se pudo guardar el vehículo.", error, { vehicleId });
        vehicleFormMessage(internal.message || "No se pudo guardar el vehículo.", "err");
        showVehicleDiagnostic(stage, code, internal, { functionName:"createVehicleRecord", vehicleId, plate, model, firestorePath:`vehiculos/${vehicleId || "—"}`, queryUsed:stage === "CHECK_DUPLICATE_PLATE" ? "getDoc" : "setDoc", documentsAffected:stage === "SAVE_VEHICLE" ? 1 : 0 });
      } finally {
        if (button) { button.disabled = false; button.textContent = "GUARDAR VEHÍCULO"; }
      }
    }

    async function softDeleteVehicle(vehicleId) {
      const session = assertVehicleAdmin("DELETE_VEHICLE");
      const cleanVehicleId = String(vehicleId || "").trim();
      try {
        const vehicleRef = doc(db, "vehiculos", cleanVehicleId);
        const preload = await getDoc(vehicleRef);
        if (!preload.exists()) throw vehicleInternalError("DELETE_VEHICLE", "VEHICLE_DELETE_FAILED", "El vehículo no existe.");
        const vehicle = preload.data() || {};
        const driver = await resolveDriverDocumentByIdentity(vehicle.currentDriverDocumentId || vehicle.currentDriverUid || "", vehicle.currentDriverName || "");
        await runTransaction(db, async transaction => {
          const vehicleSnap = await transaction.get(vehicleRef);
          const driverRef = driver?.id ? doc(db, "choferes", driver.id) : null;
          const driverSnap = driverRef ? await transaction.get(driverRef) : null;
          if (!vehicleSnap.exists()) throw vehicleInternalError("SOFT_DELETE_VEHICLE", "VEHICLE_DELETE_FAILED", "El vehículo no existe.");
          if (driverRef && driverSnap?.exists()) transaction.set(driverRef, { ...emptyDriverVehiclePatch, updatedAt:serverTimestamp(), actualizado:serverTimestamp() }, { merge:true });
          transaction.set(vehicleRef, { status:"deleted", isDeleted:true, deletedAt:serverTimestamp(), deletedByUid:session.uid, currentDriverUid:null, currentDriverDocumentId:null, currentDriverName:null, isAssigned:false, updatedAt:serverTimestamp(), updatedByUid:session.uid }, { merge:true });
        });
        await renderAdminVehicleList();
        invalidateAdminWeeklyData("vehicle-deleted");
        return true;
      } catch (error) {
        const internal = error?.internalCode ? error : vehicleInternalError("SOFT_DELETE_VEHICLE", "VEHICLE_DELETE_FAILED", "No se pudo borrar el vehículo.", error, { vehicleId:cleanVehicleId });
        showVehicleDiagnostic("SOFT_DELETE_VEHICLE", internal.internalCode || "VEHICLE_DELETE_FAILED", internal, { functionName:"softDeleteVehicle", vehicleId:cleanVehicleId, firestorePath:`vehiculos/${cleanVehicleId}`, queryUsed:"getDoc + runTransaction", documentsAffected:2 });
        throw internal;
      }
    }

    async function openAdminCreateVehicleModal() {
      try { assertVehicleAdmin("OPEN_CREATE_VEHICLE"); } catch (_) { return; }
      const modal = $("adminCreateVehicleModal");
      modal?.classList.add("is-open");
      modal?.setAttribute("aria-hidden", "false");
      vehicleFormMessage("");
      window.lockPageScroll?.("admin-create-vehicle");
      await renderAdminVehicleList();
      requestAnimationFrame(() => $("vehiclePlateInput")?.focus({ preventScroll:true }));
    }

    function closeAdminCreateVehicleModal() {
      const modal = $("adminCreateVehicleModal");
      modal?.classList.remove("is-open");
      modal?.setAttribute("aria-hidden", "true");
      vehicleFormMessage("");
      window.unlockPageScroll?.("admin-create-vehicle");
    }

    function reportProfileVehicleRenderFailure(error, context = {}) {
      showVehicleDiagnostic("RENDER_DRIVER_PROFILE_VEHICLE", "PROFILE_VEHICLE_RENDER_FAILED", error, { ...context, functionName:"renderProfileVehicleAssignment", firestorePath:`choferes/${context.driverUid || "—"}` });
    }

    window.ExploraVehicleManagement = { openCreateVehicle:openAdminCreateVehicleModal, closeCreateVehicle:closeAdminCreateVehicleModal, createVehicle:createVehicleRecord, loadVehicles:loadAdminVehicles, validateVehicleAvailability, assignVehicleToDriver, releaseVehicleFromDriver:(payload = {}) => assignVehicleToDriver({ ...payload, vehicleId:"" }), reportProfileRenderFailure:reportProfileVehicleRenderFailure, diagnostic:showVehicleDiagnostic };
    window.ExploraAdminManagement = { diagnostic:showVehicleDiagnostic, softDeleteVehicle, openDrivers:() => openAdminSharedModule("drivers-management"), openVehicles:openAdminCreateVehicleModal };

    async function loadAdminDrivers({ includeInactive = false, includeDeleted = false, includeOrphans = false } = {}) {
      try {
        const snap = await getDocs(collection(db, "choferes"));
        const drivers = [];
        snap.forEach((docSnap) => {
          const data = { id: docSnap.id, ...docSnap.data() };
          if (!isVisibleDriverProfile(data, { includeInactive, includeDeleted, includeOrphans })) return;
          const uid = adminDriverKey(data);
          drivers.push(data);
          adminDriverProfileCache.set(uid || data.id, data);
        });
        return drivers.sort((a,b) => getProfileName(a).localeCompare(getProfileName(b), "es"));
      } catch (error) {
        showVehicleDiagnostic("READ_DRIVERS", "DRIVER_READ_FAILED", error, { functionName:"loadAdminDrivers", firestorePath:"choferes", queryUsed:"getDocs(collection(choferes))" });
        throw error;
      }
    }

    function adminResolveVehicle(driver, vehiclesMap) {
      const vehicleId = String(driver.assignedVehicleId || driver.vehicleId || driver.vehiculoId || driver.vehiculo || driver.autoId || driver.vehiculoAsignado || "").trim();
      const vehicle = vehiclesMap.get(vehicleId) || null;
      if (vehicle) return { id: vehicleId, data: vehicle, displayName: adminVehicleLabel(vehicle) };
      const model = driver.assignedVehicleModel || driver.modeloVehiculo || driver.vehiculoModelo || driver.auto || "";
      const plate = driver.assignedVehiclePlate || driver.patenteVehiculo || driver.patente || driver.matricula || driver.dominio || "";
      return { id: vehicleId, data: null, displayName: model || plate ? `${model || "Vehículo"}${plate ? ` · ${plate}` : ""}` : "Vehículo no asignado" };
    }

    async function loadAdminClosureDocuments() {
      const [closureResult, paymentResult] = await Promise.allSettled([
        getDocs(collection(db, "cierres_semanales")),
        getDocs(collection(db, "pagos_semanales"))
      ]);
      const closures = [];
      const payments = [];
      if (closureResult.status === "fulfilled") closureResult.value.forEach(snap => closures.push({ id:snap.id, collection:"cierres_semanales", data:snap.data() || {} }));
      if (paymentResult.status === "fulfilled") paymentResult.value.forEach(snap => payments.push({ id:snap.id, collection:"pagos_semanales", data:snap.data() || {} }));
      return { closures, payments };
    }

    function adminFindClosure(driver, closureDocs, activePeriod) {
      const previous = getPreviousWeeklyPeriod(activePeriod);
      const allowedPeriods = new Set([
        ...closurePeriodAliases(activePeriod),
        ...closurePeriodAliases(previous),
        activePeriod.id,
        previous.id
      ].filter(Boolean));
      const matches = closureDocs.closures.filter(record => {
        const pid = closurePeriodId(record.data);
        return adminRecordMatchesDriver(record.data, driver) && (!pid || allowedPeriods.has(pid));
      }).sort((a,b) => closureRecordTime(b.data) - closureRecordTime(a.data));
      const closureRecord = matches[0] || null;
      const closurePid = closureRecord ? closurePeriodId(closureRecord.data) : "";
      const payments = closureDocs.payments.filter(record => {
        const pid = closurePeriodId(record.data);
        if (!adminRecordMatchesDriver(record.data, driver)) return false;
        if (closurePid) return !pid || pid === closurePid;
        return !pid || allowedPeriods.has(pid);
      }).sort((a,b) => closureRecordTime(b.data) - closureRecordTime(a.data));
      const paymentRecord = payments[0] || null;
      const closure = closureRecord?.data || {};
      const payment = paymentRecord?.data || {};
      const direction = closureDirection(closure, payment);
      const amount = closureAmount(closure, payment, direction);
      const receiptUrl = closureReceiptUrl(closure, payment);
      const receiptPath = closureReceiptPath(closure, payment);
      const receiptStatus = closureReceiptStatus(closure, payment);
      const eligibility = resolvePerformanceEligibility(closure, payment, Date.now());
      const closedAtMs = closureClosedAtMs(closure, payment);
      const periodId = closurePid || closurePeriodId(payment) || previous.id || activePeriod.id;
      const exists = Boolean(closureRecord || paymentRecord);
      return {
        exists,
        closureRecord,
        paymentRecord,
        closure,
        payment,
        closureId: closureRecord?.id || paymentRecord?.id || `${driver.id}_${periodId}`,
        weeklyPeriodId: periodId,
        direction,
        amount,
        receiptUrl,
        receiptPath,
        receiptStatus,
        performanceEligible: eligibility.eligible !== false,
        receiptDeadline: eligibility.deadline || 0,
        receiptUploadedAt: eligibility.receiptAt || receiptUploadedAtMs(payment) || receiptUploadedAtMs(closure),
        closedAtMs
      };
    }

    function adminClosureSummary(item = {}) {
      const closureInfo = item.closureInfo || {};
      const storedSnapshot = closureInfo.closure?.weeklySnapshot || closureInfo.closure?.snapshot || closureInfo.payment?.weeklySnapshot || closureInfo.payment?.snapshot || null;
      const snapshot = storedSnapshot && typeof storedSnapshot === "object" ? { ...(item.snapshot || {}), ...storedSnapshot } : (item.snapshot || {});
      const periodId = String(closureInfo.weeklyPeriodId || snapshot.weeklyPeriodId || adminSharedState.overview?.weeklyPeriodId || getActiveWeeklyPeriod().id || "");
      const payerHint = closureInfo.direction === "chofer_a_david" ? "driver" : closureInfo.direction === "david_a_chofer" ? "admin" : null;
      try {
        return normalizeWeeklySummaryForRender(calculateFinalBalance({ snapshot, uid:item.uid, periodId, amount:Number(closureInfo.amount || 0), payer:payerHint, isPeriodClosed:Boolean(closureInfo.exists), weeklySnapshot:snapshot }));
      } catch (_) {
        const grossBilling = safeClosureAmount(snapshot.grossBilling ?? snapshot.facturacion);
        const cash = safeClosureAmount(snapshot.cashCollectedByDriver);
        const transfers = safeClosureAmount(snapshot.transferCollectedByAdmin) + safeClosureAmount(snapshot.aliasCollectedByAdmin);
        const cards = safeClosureAmount(snapshot.cardCollectedByAdmin);
        const qr = safeClosureAmount(snapshot.qrCollectedByAdmin);
        const currentDriverPercent = 50;
        const derivationBonus = safeClosureAmount(snapshot.derivationBonusAmount);
        const baseShare = Math.round(grossBilling * .5);
        const driverShareBeforeDiscounts = baseShare + derivationBonus;
        const loans = safeClosureAmount(snapshot.operationalLoanDriverShare);
        const exploreLoanDiscount = safeClosureAmount(snapshot.exploreLoanDiscount ?? snapshot.prestamoExplora);
        const collaboration = safeClosureAmount(snapshot.collaborationAmount);
        const repairFundAmount = Object.prototype.hasOwnProperty.call(snapshot,"repairFundAmount") ? safeClosureAmount(snapshot.repairFundAmount) : Math.round(grossBilling * .05);
        const directDebtTotal = safeClosureAmount(snapshot.directDebtInstallmentTotal);
        const fines = safeClosureArray(snapshot.directDebtInstallments).reduce((sum,row)=>/multa|fine/i.test(`${row?.reason||""} ${row?.reasonLabel||""}`)?sum+safeClosureAmount(row?.amount):sum,0);
        const otherDiscounts = Math.max(0,directDebtTotal-fines)+safeClosureAmount(snapshot.otherDiscounts ?? snapshot.otrosDescuentos);
        const totalDiscounts = Math.round(loans+exploreLoanDiscount+fines+repairFundAmount+collaboration+otherDiscounts);
        const expenseTotals = resolveWeeklyExpenseTotals(snapshot);
        const driverExpenseShare = Math.round(expenseTotals.total*.5);
        const driverPaidExpenses = expenseTotals.driverPaid;
        const driverFundsAfterExpenses = Math.round(cash-driverPaidExpenses);
        const driverNetShareBeforeDiscounts = Math.round(driverShareBeforeDiscounts-driverExpenseShare);
        const driverExpenseCredit = Math.round(driverPaidExpenses*.5);
        const balanceBeforeDailyBonuses = Math.round(driverNetShareBeforeDiscounts-totalDiscounts-driverFundsAfterExpenses);
        const dailyBonuses = safeClosureArray(snapshot.dailyRankingBonuses);
        const dailyBonusTotal = safeClosureAmount(snapshot.dailyRankingBonusAmount ?? dailyBonuses.reduce((sum,row)=>sum+safeClosureAmount(row?.bonusAmount),0));
        const netSettlementToDriver = balanceBeforeDailyBonuses + dailyBonusTotal;
        const balanced = Math.abs(netSettlementToDriver) < WEEKLY_CLOSURE_BALANCE_TOLERANCE;
        const payer = balanced ? null : netSettlementToDriver > 0 ? "admin" : "driver";
        return normalizeWeeklySummaryForRender({ snapshot, uid:item.uid, periodId, isPeriodClosed:Boolean(closureInfo.exists), grossBilling, expenses:expenseTotals.total, cash, transfers, cards, qr, totalCollectedByAdmin:transfers+cards+qr, currentDriverPercent, baseShare, driverShareBeforeDiscounts, driverNetShareBeforeDiscounts, driverExpenseShare, driverPaidExpenses, driverFundsAfterExpenses, driverExpenseCredit, loans, exploreLoanDiscount, fines, repairFundRate:.05, repairFundAmount, collaboration, otherDiscounts, totalDiscounts, dailyBonuses, dailyBonusTotal, balanceBeforeDailyBonuses, netSettlementToDriver, balanced, payer, amount:balanced?0:Math.abs(Math.round(netSettlementToDriver)), resultLabel:balanced?"CUENTA EQUILIBRADA":payer==="driver"?"SALDO A FAVOR DE DAVID":"SALDO A FAVOR DEL CHOFER", actionText:balanced?"No hay saldo pendiente entre el chofer y David.":payer==="driver"?"Chofer paga a David":"David paga al chofer", derivationBonus });
      }
    }

    function adminClosurePresentation(item, summary = adminClosureSummary(item)) {
      const closure = item.closureInfo || {};
      const currentPeriod = String(adminSharedState.overview?.weeklyPeriodId || getActiveWeeklyPeriod().id || "");
      const samePeriod = closure.exists && String(closure.weeklyPeriodId || "") === currentPeriod;
      const joined = [closure.receiptStatus,closure.closure?.receiptStatus,closure.payment?.receiptStatus,closure.closure?.status,closure.payment?.status].map(v=>String(v||"").toLowerCase()).join(" ");
      const projected = summary.balanced ? "Cuenta equilibrada" : summary.payer === "driver" ? `Chofer pagaría a David ${adminMoney(summary.amount)}` : `David pagaría al chofer ${adminMoney(summary.amount)}`;
      if (!samePeriod) return { key:"live", label:"SEMANA EN CURSO", detail:`Resultado provisional · ${projected}`, tone:"gold", payer:summary.balanced?"Equilibrado":summary.payer==="driver"?"Chofer":"David", receiptLabel:closure.exists?"Último cierre disponible":"Sin cierre anterior" };
      if (summary.balanced || closure.direction === "sin_diferencia") return { key:"balanced", label:"CUENTA EQUILIBRADA", detail:"No requiere comprobante", tone:"ok", payer:"Nadie", receiptLabel:"CUENTA EQUILIBRADA" };
      if (/rechaz|reject/.test(joined)) return { key:"rejected", label:"COMPROBANTE RECHAZADO", detail:"Debe cargarse un comprobante nuevo", tone:"danger", payer:summary.payer==="driver"?"Chofer":"David", receiptLabel:"COMPROBANTE RECHAZADO" };
      if (/aprob|accept|confirm|pagado|paid|completed|completado/.test(joined)) return { key:"confirmed", label:"PAGO CONFIRMADO", detail:"El comprobante fue confirmado", tone:"ok", payer:summary.payer==="driver"?"Chofer":"David", receiptLabel:"PAGO CONFIRMADO" };
      if (closure.receiptUrl || /uploaded|subido|review|revision|revisión|recibido/.test(joined)) return { key:"received", label:"COMPROBANTE RECIBIDO", detail:"Pendiente de confirmación", tone:"info", payer:summary.payer==="driver"?"Chofer":"David", receiptLabel:"COMPROBANTE RECIBIDO" };
      return { key:"missing", label:"FALTA COMPROBANTE", detail:summary.payer==="driver"?"Debe cargarlo el chofer":"Debe cargarlo David", tone:"danger", payer:summary.payer==="driver"?"Chofer":"David", receiptLabel:"FALTA COMPROBANTE" };
    }

    function adminCacheKey(uid, periodId) { return `${String(uid || "").toLowerCase()}_${periodId}`; }

    async function getAdminWeeklyOverview(periodId = "", { force = false } = {}) {
      await assertCurrentAdminAccess();
      const activePeriod=getActiveWeeklyPeriod(),targetPeriodId=periodId||activePeriod.id,targetPeriod=closurePeriodObject(targetPeriodId),overviewKey=`overview_${targetPeriodId}`;
      const fastCtx={uid:auth.currentUser?.uid||"",role:"admin",weeklyPeriodId:targetPeriodId};
      const fastEntry=window.ExploraFastCache?.get?.("admin_summary",fastCtx,{allowStale:true});
      if(!force&&adminWeeklySnapshotCache.has(overviewKey))return adminWeeklySnapshotCache.get(overviewKey);
      if(!force&&fastEntry&&!fastEntry.expired){adminWeeklySnapshotCache.set(overviewKey,fastEntry.data);return fastEntry.data;}
      return window.ExploraFastCache?.run?.("admin_summary",async()=>{
        const [drivers,vehicles,closureDocs]=await Promise.all([loadAdminDrivers(),loadAdminVehicles(),loadAdminClosureDocuments()]);
        const vehicleMap=new Map(vehicles.map(v=>[String(v.id),v]));
        const rows=await Promise.all(drivers.map(async driver=>{
          const driverKey=adminDriverKey(driver)||driver.id,cacheKey=adminCacheKey(driverKey,targetPeriodId);let snapshot=!force?adminWeeklySnapshotCache.get(cacheKey):null;
          if(!snapshot){const materialized=await getDoc(doc(db,WEEKLY_SNAPSHOT_COLLECTION,materializedSnapshotId(driverKey,targetPeriodId))).catch(()=>null);if(materialized?.exists()&&Number(materialized.data()?.schemaVersion||0)>=WEEKLY_ENGINE_SCHEMA_VERSION){const candidate=snapshotFromMaterialized(materialized.data()||{},driverKey,targetPeriod,null);snapshot=weeklyPaymentMethodsState(candidate).valid?candidate:await getDriverWeeklySnapshot(driverKey,targetPeriodId,{force:true,allowLegacyScan:true,strictSources:true});}else snapshot=await getDriverWeeklySnapshot(driverKey,targetPeriodId,{force:true,allowLegacyScan:true,strictSources:true});adminWeeklySnapshotCache.set(cacheKey,snapshot);}
          const closureInfo=adminFindClosure(driver,closureDocs,targetPeriod);adminClosureCache.set(cacheKey,closureInfo);return{uid:driverKey,driver,vehicle:adminResolveVehicle(driver,vehicleMap),snapshot,closureInfo};
        }));
        let derivationPerformance={derivations:[],weekScope:null};
        try{
          const period={...targetPeriod,id:targetPeriodId,weeklyPeriodId:targetPeriodId};
          derivationPerformance=await window.ExploraDerivationMoneyRankingEngine?.calculateForPeriod?.(period)||derivationPerformance;
        }catch(error){
          window.ExploraPerformanceEngine?.showDiagnostic?.("UPDATE_ADMIN_WEEKLY_BILLING","ADMIN_DERIVATION_SUMMARY_FAILED",error,{weeklyPeriodId:targetPeriodId,functionName:"getAdminWeeklyOverview",firestorePath:"derivaciones",queryUsed:`calculateForPeriod(${targetPeriodId})`});
        }
        const ranking=derivationPerformance.derivations||[],leader=ranking[0]||null;
        const totalCollaborations=rows.reduce((sum,row)=>sum+Number(row.snapshot.collaborationAmount||0),0),totalInvoicedDerivations=rows.reduce((sum,row)=>sum+Number(row.snapshot.validDerivations||0),0),estimatedLeaderBonus=leader?Math.round(Number(leader.derivedAmount||0)*.10):0;
        const overview={weeklyPeriodId:targetPeriodId,period:targetPeriod,drivers:rows,totalBilling:rows.reduce((sum,row)=>sum+Number(row.snapshot.grossBilling||0),0),totalServices:rows.reduce((sum,row)=>sum+Number(row.snapshot.serviceCount||0),0),totalExpenses:rows.reduce((sum,row)=>sum+Number(row.snapshot.totalExpenses||0),0),totalExpenseCount:rows.reduce((sum,row)=>sum+Number(row.snapshot.expenseCount||0),0),totalOperationalLoans:rows.reduce((sum,row)=>sum+Number(row.snapshot.operationalLoanTotal||0),0),driversWithActivity:rows.filter(row=>row.snapshot.serviceCount>0).length,driversWithExpenses:rows.filter(row=>row.snapshot.expenseCount>0).length,pendingDriverReceipts:rows.filter(row=>row.closureInfo.exists&&row.closureInfo.direction==="chofer_a_david"&&!row.closureInfo.receiptUrl).length,pendingAdminReceipts:rows.filter(row=>row.closureInfo.exists&&row.closureInfo.direction==="david_a_chofer"&&!row.closureInfo.receiptUrl).length,balancedClosures:rows.filter(row=>row.closureInfo.exists&&row.closureInfo.direction==="sin_diferencia").length,totalCollaborations,totalInvoicedDerivations,estimatedLeaderBonus,totalAdminWeeklyIncome:rows.reduce((sum,row)=>sum+Number(row.snapshot.grossBilling||0),0)+totalCollaborations,exploraCollaborationBalance:totalCollaborations-estimatedLeaderBonus,derivationLeader:leader,derivationRanking:ranking,derivationWeek:derivationPerformance.weekScope||null,calculatedAt:Date.now(),driverCount:rows.length};
        adminWeeklySnapshotCache.set(overviewKey,overview);window.ExploraFastCache?.set?.("admin_summary",overview,fastCtx,{ttl:300000});return overview;
      },fastCtx,{ttl:300000,lockKey:`admin-summary-${targetPeriodId}`,query:"acumulados_semanales por chofer",firestorePath:WEEKLY_SNAPSHOT_COLLECTION,documentsRead:"múltiples",listenersActive:0})||Promise.resolve(fastEntry?.data||null);
    }

    function fillAdminVehicleSelect(vehicles = []) {
      const select = $("newDriverVehicle");
      if (!select) return;
      const current = select.value;
      select.innerHTML = `<option value="">Sin vehículo asignado</option>`;
      vehicles
        .filter(vehicle => String(vehicle.status || "active").toLowerCase() === "active" && vehicle.isDeleted !== true)
        .forEach(vehicle => {
          const option = document.createElement("option");
          const assignment = vehicleAssignmentState(vehicle);
          option.value = vehicle.id;
          option.textContent = vehicleSelectLabel(vehicle) + (assignment.assigned ? ` · Asignado a ${vehicle.currentDriverName || assignment.currentDriverUid}` : "");
          option.dataset.assigned = assignment.assigned ? "true" : "false";
          option.dataset.currentDriverUid = assignment.currentDriverUid || "";
          option.dataset.currentDriverName = vehicle.currentDriverName || "";
          select.appendChild(option);
        });
      if (current && [...select.options].some(option => option.value === current)) select.value = current;
    }

    function dashboardOperationCards() { return Array.from(document.querySelectorAll(".operations-grid-real .operation-card-real")); }
    function dashboardFinanceCards() { return Array.from(document.querySelectorAll(".finance-grid-real .finance-card-real")); }
    function dashboardSummaryCards() { return Array.from(document.querySelectorAll(".summary-grid-real:not(.vehicle-management-grid) .summary-card-real")); }
    function removeDriverCollaborationButton(){ document.getElementById("dashboardCollaborationCard")?.remove(); }
    function setFinanceCardOrder(adminMode=false){
      const grid=document.querySelector(".finance-grid-real");if(!grid)return;
      const billing=$("dashboardWeeklyBillingCard"),expenses=$("dashboardWeeklyExpensesCard"),receipts=$("dashboardReceiptsCard"),collaboration=$("dashboardCollaborationCard");
      [billing,adminMode?receipts:expenses,adminMode?expenses:receipts,collaboration].filter(Boolean).forEach(card=>grid.appendChild(card));
    }
    const adminUiDiagnosticSeen=new Set();
    function adminUiDiagnosticSignature(stage,code,path){return ["DRIVER_ADMIN_EXPERIENCE",stage||"—",code||"—",path||"—"].join("|");}
    function showAdminUiDiagnostic(stage,code,error,context={}){
      const path=String(context.firestorePath||"—"),signature=adminUiDiagnosticSignature(stage,code,path),storageKey=`explora_admin_ui_diag_${signature}`;
      try{if(adminUiDiagnosticSeen.has(signature)||sessionStorage.getItem(storageKey)==="1")return;adminUiDiagnosticSeen.add(signature);sessionStorage.setItem(storageKey,"1");}catch(_){if(adminUiDiagnosticSeen.has(signature))return;adminUiDiagnosticSeen.add(signature);}
      const active=window.ExploraWeeklyEngine?.getActiveWeeklyPeriod?.()||{},weekScope=window.ExploraPerformanceEngine?.getState?.().weekScope||{};
      const month=new Intl.DateTimeFormat("es-AR",{timeZone:"America/Argentina/Cordoba",year:"numeric",month:"2-digit"}).format(new Date());
      const payload=[
        "EXPLORA - ERROR DRIVER_ADMIN_EXPERIENCE",
        "MÓDULO: DRIVER_ADMIN_EXPERIENCE",
        `ETAPA: ${stage||"—"}`,
        `CÓDIGO INTERNO: ${code||"—"}`,
        `MENSAJE REAL FIREBASE: ${error?.code||"—"} · ${context.firebaseMessage||error?.message||"—"}`,
        `MENSAJE REAL JAVASCRIPT: ${error?.message||context.message||"—"}`,
        `STACK: ${error?.stack||"—"}`,
        `FUNCIÓN: ${context.functionName||"—"}`,
        `UID: ${context.uid||auth?.currentUser?.uid||state.uid||"—"}`,
        `ROL: ${exploraSession.role||"—"}`,
        `RUTA FIRESTORE: ${path}`,
        `QUERY USADA: ${context.queryUsed||context.query||"—"}`,
        `SEMANA ACTIVA: ${active.id||"—"}`,
        `MES ACTIVO: ${month}`,
        `SEMANA FINANCIERA: ${active.id||weekScope.id||"—"}`,
        `ADMIN MODE: ${document.body.classList.contains("explora-shared-admin")?"SÍ":"NO"}`,
        `TIMESTAMP: ${new Date().toISOString()}`
      ].join("\n");
      $("adminUiDiagnosticText")&&($("adminUiDiagnosticText").textContent=payload);
      const backdrop=$("adminUiDiagnosticBackdrop");backdrop?.classList.add("is-open");backdrop?.setAttribute("aria-hidden","false");window.lockPageScroll?.("admin-ui-diagnostic");
    }
    function closeAdminUiDiagnostic(){const backdrop=$("adminUiDiagnosticBackdrop");backdrop?.classList.remove("is-open");backdrop?.setAttribute("aria-hidden","true");window.unlockPageScroll?.("admin-ui-diagnostic");}
    async function copyAdminUiDiagnostic(){const text=$("adminUiDiagnosticText")?.textContent||"";try{await navigator.clipboard.writeText(text);const button=$("adminUiDiagnosticCopy");if(button){button.textContent="COPIADO";setTimeout(()=>button.textContent="COPIAR ERROR",1200);}}catch(error){console.warn("ADMIN_DIAGNOSTIC_COPY",error);}}
    function ensureAdminCollaborationCard(){
      let card=document.getElementById("dashboardCollaborationCard");
      if(card)return card;
      const grid=document.querySelector(".finance-grid-real");if(!grid)return null;
      card=document.createElement("button");
      card.id="dashboardCollaborationCard";card.type="button";card.className="finance-card-real finance-purple";card.dataset.action="admin-colaboracion-bono";card.setAttribute("aria-label","Abrir colaboración para bono");
      card.innerHTML='<span class="finance-label-real"><svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M7 7.5c0-1.7 1.8-3 5-3s5 1.3 5 3-1.8 3-5 3-5 1.3-5 3 1.8 3 5 3 5-1.3 5-3"/></svg>APORTE AL BONO</span><strong id="dashboardCollaborationTotal">$0</strong><small id="dashboardCollaborationMeta">0 derivaciones facturadas</small><svg class="sparkline-real" viewBox="0 0 120 34" aria-hidden="true"><path d="M2 27 C18 22 29 27 44 17 S72 20 88 11 103 12 118 5"/></svg>';
      grid.appendChild(card);return card;
    }

    function setCardCopy(card, title, subtitle, action, aria) {
      if (!card) return;
      const strong = card.querySelector(":scope > strong");
      const small = card.querySelector(":scope > small");
      if (strong) strong.textContent = title;
      if (small) small.textContent = subtitle;
      if (action) card.dataset.action = action; else card.removeAttribute("data-action");
      if (aria) card.setAttribute("aria-label", aria);
    }

    function renderDriverDashboardRole() {
      document.body.classList.remove("explora-shared-admin");
      const operationsTitle = $("operationsTitle");
      const financeTitle = $("financeTitle");
      const summaryTitle = $("summaryTitle");
      if (operationsTitle) operationsTitle.textContent = "OPERACIONES";
      if (financeTitle) financeTitle.textContent = "FINANZAS";
      if (summaryTitle) summaryTitle.textContent = "GESTIÓN DEL VEHÍCULO";
      removeDriverCollaborationButton();
      const profileButton = $("dashboardProfileButton");
      profileButton?.classList.remove("is-admin-identity");
      profileButton?.setAttribute("data-action", "abrir-perfil");
      profileButton?.setAttribute("aria-label", "Abrir mi perfil");
      const ranking = $("weeklyRankingLive");
      if (ranking) {
        ranking.hidden=false;ranking.setAttribute("aria-hidden","false");
        ranking.dataset.adminReserved = "false";
        ranking.querySelector(".section-header-real h2").textContent = "RANKING DIARIO";
      }
      const goalViewport=$("performanceGoalViewport"),adminTray=$("adminActionTray");
      if(goalViewport)goalViewport.hidden=false;if(adminTray)adminTray.hidden=true;
      setFinanceCardOrder(false);
      const ops = dashboardOperationCards();
      setCardCopy(ops[0], "REGISTRAR COBRO", "QR, efectivo, tarjeta o transferencia", "nuevo-servicio", "Registrar cobro");
      setCardCopy(ops[1], "CARGAR GASTO", "Combustible, peajes y más", "cargar-gastos", "Cargar gasto");
      setCardCopy(ops[2], "DERIVAR SERVICIO", "Pasar a otro chofer", "derivar-servicio", "Derivar servicio");
      const billingCard=$("dashboardWeeklyBillingCard"),expensesCard=$("dashboardWeeklyExpensesCard"),receiptsCard=$("dashboardReceiptsCard");
      if(billingCard)billingCard.dataset.action="facturacion-semanal";
      if(expensesCard)expensesCard.dataset.action="gastos-semanales";
      if(receiptsCard)receiptsCard.dataset.action="comprobantes";
      const detailLink = document.querySelector('.finance-real [data-action]');
      if (detailLink) { detailLink.dataset.action = "detalle-financiero"; detailLink.textContent = "Ver detalle financiero ›"; }
      const summary = dashboardSummaryCards();
      summary.forEach(card=>{
        const keep=card.querySelector("#dashboardTripsCount")||card.classList.contains("summary-card-benefit");
        if(!keep)card.remove();
      });
      const tripsCard=$("dashboardTripsCount")?.closest(".summary-card-real");
      if(tripsCard){const label=tripsCard.querySelector("span");if(label)label.textContent="Cobros registrados";tripsCard.dataset.action="resumen-servicios";}
      const goalsCard=document.querySelector(".summary-grid-real .summary-card-benefit");
      if(goalsCard)goalsCard.remove();
      document.querySelector("#mainBottomNav")?.classList.remove("admin-bottom-nav");
      const weeklyCtx={uid:auth.currentUser?.uid||"",role:"chofer",weeklyPeriodId:getActiveWeeklyPeriod().id};
      const weeklyFresh=Boolean(window.ExploraFastCache?.isFresh?.("dashboard_weekly_billing",weeklyCtx)||window.ExploraFastCache?.isFresh?.("dashboard_weekly_expenses",weeklyCtx));
      const hydratedWeekly=weeklyFresh&&window.ExploraFastCache?.hydrateDashboard?.(weeklyCtx);
      if(!hydratedWeekly){
        $("dashboardWeeklyRevenue") && ($("dashboardWeeklyRevenue").textContent = "—");
        $("dashboardWeeklyRevenueMeta") && ($("dashboardWeeklyRevenueMeta").textContent = "Datos en preparación");
        $("dashboardWeeklyExpenses") && ($("dashboardWeeklyExpenses").textContent = "—");
        $("dashboardWeeklyExpensesMeta") && ($("dashboardWeeklyExpensesMeta").textContent = "Datos en preparación");
      }
      $("dashboardReceiptsMeta") && ($("dashboardReceiptsMeta").textContent = "Ver y gestionar comprobantes");
      $("dashboardTripsCount") && ($("dashboardTripsCount").textContent = hydratedWeekly ? $("dashboardTripsCount").textContent : "…");
      $("dashboardReceiptsCount") && ($("dashboardReceiptsCount").textContent = hydratedWeekly ? $("dashboardReceiptsCount").textContent : "…");
      $("dashboardExpenseCount") && ($("dashboardExpenseCount").textContent = hydratedWeekly ? $("dashboardExpenseCount").textContent : "…");
      $("dashboardWeeklyGoal") && ($("dashboardWeeklyGoal").textContent = "—");
      renderDriverHeader(exploraSession.profile || {}, exploraSession.vehicle);
    }

    function renderAdminReservedCards() {
      const section=$("weeklyRankingLive");
      if(section){section.hidden=true;section.setAttribute("aria-hidden","true");section.dataset.adminReserved="true";}
      window.ExploraPerformanceEngine?.close?.();
    }

    function renderAdminHeader(profile = {}) {
      const name = getProfileName(profile, auth.currentUser) || "David";
      const profileButton = $("dashboardProfileButton");
      profileButton?.classList.add("is-admin-identity");
      profileButton?.removeAttribute("data-action");
      profileButton?.setAttribute("aria-label", "Identidad del administrador");
      setHeaderExploraLogo();
      $("dashboardProfileName") && ($("dashboardProfileName").textContent = name);
      $("dashboardProfileRole") && ($("dashboardProfileRole").textContent = "Administrador EXPLORA");
      $("driverGreetingName") && ($("driverGreetingName").textContent = `¡${greetingByHour()}, ${firstNameOf(name)}!`);
      $("driverGreetingDate") && ($("driverGreetingDate").textContent = formatArgentinaLongDate());
      $("driverGreetingVehicle") && ($("driverGreetingVehicle").textContent = "Panel administrativo EXPLORA");
    }

    function renderAdminStatusCard(overview) {
      const card = $("driverStatusCard");
      if (!card) return;
      let status = "ok";
      let title = "COMPROBANTES SEMANALES";
      let message = "Todo al día";
      let detail = `${overview.balancedClosures} cierres equilibrados`;
      let actionTitle = "CIERRES POR CHOFER";
      let actionMessage = "Consultar resultados semanales";
      if (overview.pendingDriverReceipts > 0) {
        status = "pending";
        message = "Comprobantes pendientes de choferes";
        detail = `${overview.pendingDriverReceipts} ${overview.pendingDriverReceipts === 1 ? "pendiente" : "pendientes"}`;
        actionMessage = "Revisar cierres y archivos";
      } else if (overview.pendingAdminReceipts > 0) {
        status = "admin-david-pending";
        message = "Pagos de David pendientes";
        detail = `${overview.pendingAdminReceipts} ${overview.pendingAdminReceipts === 1 ? "comprobante por cargar" : "comprobantes por cargar"}`;
        actionMessage = "Adjuntar comprobantes";
      }
      card.dataset.status = status;
      card.dataset.layout = "split";
      card.disabled = false;
      card.tabIndex = 0;
      card.dataset.action = "admin-cierres";
      card.setAttribute("aria-disabled", "false");
      card.setAttribute("aria-label", `${title}. ${message}. Abrir cierres por chofer.`);
      $("driverStatusIcon").innerHTML = statusIconMarkup(status === "pending" ? "pending" : "ok");
      $("driverStatusActionIcon").innerHTML = statusIconMarkup("ok");
      $("driverStatusTitle").textContent = title;
      $("driverStatusMessage").textContent = message;
      $("driverStatusDetail").textContent = detail;
      $("driverStatusActionTitle").textContent = actionTitle;
      $("driverStatusActionMessage").textContent = actionMessage;
    }

    function renderAdminDashboardMetrics(overview) {
      $("dashboardWeeklyRevenue")&&($("dashboardWeeklyRevenue").textContent=adminMoney(overview.totalAdminWeeklyIncome??overview.totalBilling));
      $("dashboardWeeklyRevenueMeta")&&($("dashboardWeeklyRevenueMeta").textContent=`Servicios ${adminMoney(overview.totalBilling)} + colaboración para bono ${adminMoney(overview.totalCollaborations||0)}`);
      $("dashboardWeeklyExpenses")&&($("dashboardWeeklyExpenses").textContent=adminMoney(overview.totalExpenses));
      $("dashboardWeeklyExpensesMeta")&&($("dashboardWeeklyExpensesMeta").textContent=`${overview.driversWithExpenses} choferes con gastos`);
      $("dashboardReceiptsMeta")&&($("dashboardReceiptsMeta").textContent=`${overview.pendingDriverReceipts+overview.pendingAdminReceipts} pendientes · Pagos y gastos`);
      $("dashboardCollaborationTotal")&&($("dashboardCollaborationTotal").textContent=`+${adminMoney(overview.totalCollaborations)}`);
      $("dashboardCollaborationMeta")&&($("dashboardCollaborationMeta").textContent=`${overview.totalInvoicedDerivations} derivaciones · saldo ${overview.exploraCollaborationBalance>=0?"+":"−"}${adminMoney(Math.abs(overview.exploraCollaborationBalance))}`);
      $("dashboardTripsCount")&&($("dashboardTripsCount").textContent=overview.drivers.length);$("dashboardReceiptsCount")&&($("dashboardReceiptsCount").textContent=overview.pendingDriverReceipts+overview.pendingAdminReceipts);$("dashboardExpenseCount")&&($("dashboardExpenseCount").textContent=overview.totalExpenseCount);$("dashboardWeeklyGoal")&&($("dashboardWeeklyGoal").textContent=overview.balancedClosures);
    }

    async function renderAdminDashboardRole() {
      document.body.classList.add("explora-shared-admin");
      const operationsTitle = $("operationsTitle");
      const financeTitle = $("financeTitle");
      const summaryTitle = $("summaryTitle");
      if (operationsTitle) operationsTitle.textContent = "ACCIONES RÁPIDAS";
      if (financeTitle) financeTitle.textContent = "RESUMEN SEMANAL";
      if (summaryTitle) summaryTitle.textContent = "VEHÍCULOS Y DEUDAS";
      renderAdminHeader(exploraSession.profile || {});
      renderAdminReservedCards();
      const ops = dashboardOperationCards();
      setCardCopy(ops[0], "GESTIONAR CHOFERES", "Crear, resetear o eliminar", "admin-choferes", "Gestionar choferes");
      setCardCopy(ops[1], "PRÉSTAMO OPERATIVO", "Adelanto compartido 50 % / 50 %", "admin-prestamo", "Préstamo operativo");
      setCardCopy(ops[2], "MI AUTO", "Gestión del vehículo", "admin-mi-auto", "Mi auto");
      ensureAdminCollaborationCard();
      setFinanceCardOrder(true);
      const billingCard=$("dashboardWeeklyBillingCard"),expensesCard=$("dashboardWeeklyExpensesCard"),receiptsCard=$("dashboardReceiptsCard"),collaborationCard=$("dashboardCollaborationCard");
      if(billingCard)billingCard.dataset.action="admin-facturacion";
      if(receiptsCard)receiptsCard.dataset.action="admin-comprobantes";
      if(expensesCard)expensesCard.dataset.action="admin-gastos";
      if(collaborationCard)collaborationCard.dataset.action="admin-colaboracion-bono";
      const detailLink = document.querySelector('.finance-real .section-link-real');
      if (detailLink) { detailLink.dataset.action = "admin-facturacion"; detailLink.textContent = "Ver detalle por chofer ›"; }
      const summary = dashboardSummaryCards();
      if (summary[0]) { summary[0].querySelector("span").textContent = "Choferes activos"; summary[0].dataset.action = "admin-facturacion"; }
      if (summary[1]) { summary[1].querySelector("span").textContent = "Cierres pendientes"; summary[1].dataset.action = "admin-cierres"; }
      if (summary[2]) { summary[2].querySelector("span").textContent = "Gastos registrados"; summary[2].dataset.action = "admin-gastos"; }
      if (summary[3]) { summary[3].querySelector("span").textContent = "Cierres equilibrados"; summary[3].dataset.action = "admin-cierres"; }
      const goalViewport=$("performanceGoalViewport"),adminTray=$("adminActionTray");
      if(goalViewport)goalViewport.hidden=true;if(adminTray)adminTray.hidden=false;
      document.querySelector("#mainBottomNav")?.classList.add("admin-bottom-nav");
      renderAdminStatusCard({ pendingDriverReceipts:0, pendingAdminReceipts:0, balancedClosures:0 });
      const adminCtx={uid:auth.currentUser?.uid||"",role:"admin",weeklyPeriodId:getActiveWeeklyPeriod().id};
      const cachedAdmin=window.ExploraFastCache?.get?.("admin_summary",adminCtx,{allowStale:false});
      if(cachedAdmin?.data){adminSharedState.overview=cachedAdmin.data;renderAdminStatusCard(cachedAdmin.data);renderAdminDashboardMetrics(cachedAdmin.data);}
      else{
        $("dashboardWeeklyRevenue") && ($("dashboardWeeklyRevenue").textContent = "$0");
        $("dashboardWeeklyRevenueMeta") && ($("dashboardWeeklyRevenueMeta").textContent = "Sin datos cargados todavía");
        $("dashboardWeeklyExpenses") && ($("dashboardWeeklyExpenses").textContent = "$0");
        $("dashboardWeeklyExpensesMeta") && ($("dashboardWeeklyExpensesMeta").textContent = "Sin datos cargados todavía");
      }
      try {
        const overview = cachedAdmin&&!cachedAdmin.expired?cachedAdmin.data:await getAdminWeeklyOverview("", { force:Boolean(cachedAdmin?.expired) });
        adminSharedState.overview = overview;
        renderAdminStatusCard(overview);
        renderAdminDashboardMetrics(overview);
        const vehicles = await loadAdminVehicles().catch(() => []);
        fillAdminVehicleSelect(vehicles);
      } catch (error) {
        console.warn("[EXPLORA admin] dashboard", error?.code || error?.message);
        if(!cachedAdmin?.data){
          $("dashboardWeeklyRevenue") && ($("dashboardWeeklyRevenue").textContent = "$0");
          $("dashboardWeeklyRevenueMeta") && ($("dashboardWeeklyRevenueMeta").textContent = "Sin datos cargados todavía");
          $("dashboardWeeklyExpenses") && ($("dashboardWeeklyExpenses").textContent = "$0");
          $("dashboardWeeklyExpensesMeta") && ($("dashboardWeeklyExpensesMeta").textContent = "Sin datos cargados todavía");
        }
        renderAdminStatusCard({ pendingDriverReceipts:0, pendingAdminReceipts:0, balancedClosures:0 });
        showAdminUiDiagnostic("RENDER_ADMIN_DASHBOARD","ADMIN_VISUAL_UNIFICATION_FAILED",error,{functionName:"renderAdminDashboardRole",firestorePath:"dashboard administrativo",queryUsed:"getAdminWeeklyOverview"});
      }
    }

    function renderDashboardByRole(session = {}) {
      const role = String(session.role || exploraSession.role || "").toLowerCase();
      if (role === "admin") return renderAdminDashboardRole();
      return renderDriverDashboardRole();
    }

    async function showAdminApp() {
      window.unlockAllPageScroll?.();
      window.ExploraDerivations?.stopSession?.();
      const user = auth.currentUser;
      if (!user || !EXPLORA_ADMIN_UIDS.has(user.uid) || secureLegacyRoleForAuth(exploraSession.profile || {}, user, exploraSession.role || "") !== "admin") {
        throw new Error("PROFILE_ROLE_INVALID");
      }
      authSessionState.authenticatedUser = exploraSession.authUser || user;
      authSessionState.profile = exploraSession.profile || null;
      authSessionState.role = "admin";
      authSessionState.uiOpened = true;
      document.body.classList.add("explora-shared-admin");
      renderDashboardByRole({ role:"admin", profile:exploraSession.profile || {} });
      await finishSplashSync();
      setBodyMode("explora-authenticated");
      window.ExploraMainNav?.setActive("inicio");
    }

    async function refreshAdminDashboard() {
      if (!auth.currentUser || !exploraAccessState.isAdmin || !EXPLORA_ADMIN_UIDS.has(auth.currentUser.uid)) return null;
      adminWeeklySnapshotCache.clear();
      adminClosureCache.clear();
      const [overview, vehicles] = await Promise.all([
        getAdminWeeklyOverview("", { force:true }),
        loadAdminVehicles().catch(() => [])
      ]);
      adminSharedState.overview = overview;
      fillAdminVehicleSelect(vehicles);
      if (document.body.classList.contains("explora-shared-admin")) {
        renderAdminStatusCard(overview);
        renderAdminDashboardMetrics(overview);
      }
      return overview;
    }
    if(!window.__exploraAdminFastRefreshRegistered){
      window.__exploraAdminFastRefreshRegistered=true;
      window.ExploraFastCache?.registerRefresher?.("admin_summary",()=>refreshAdminDashboard(),{ttl:300000,lockKey:"admin-summary-refresh",context:()=>({uid:auth.currentUser?.uid||"",role:"admin",weeklyPeriodId:getActiveWeeklyPeriod().id})});
    }

    function adminPeriodRange(mode = "week") {
      const now = new Date();
      if (mode === "week") {
        const p = getActiveWeeklyPeriod(now);
        return { ...p, label:`${formatIsoDateInArgentina(p.startMs)} – ${formatIsoDateInArgentina(p.endMs)}` };
      }
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone:"America/Argentina/Cordoba", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(now).reduce((acc,p) => (acc[p.type]=p.value,acc),{});
      const year = Number(parts.year), month = Number(parts.month);
      if (mode === "month") {
        const startMs = new Date(`${year}-${String(month).padStart(2,"0")}-01T00:00:00-03:00`).getTime();
        const nextYear = month === 12 ? year + 1 : year;
        const nextMonth = month === 12 ? 1 : month + 1;
        const endMs = new Date(`${nextYear}-${String(nextMonth).padStart(2,"0")}-01T00:00:00-03:00`).getTime()-1;
        return { id:`${year}-${String(month).padStart(2,"0")}`, startMs, endMs, label:new Intl.DateTimeFormat("es-AR",{timeZone:"America/Argentina/Cordoba",month:"long",year:"numeric"}).format(now) };
      }
      const startMs = new Date(`${year}-01-01T00:00:00-03:00`).getTime();
      const endMs = new Date(`${year+1}-01-01T00:00:00-03:00`).getTime()-1;
      return { id:String(year), startMs, endMs, label:String(year) };
    }

    async function loadAdminHistoricalRows(type, mode) {
      const range = adminPeriodRange(mode);
      const collectionName = type === "expenses" ? "gastos" : "billing_records";
      const snap = await getDocs(collection(db, collectionName));
      const rows = [];
      snap.forEach(docSnap => {
        const raw = { id:docSnap.id, documentId:docSnap.id, ...(docSnap.data() || {}) };
        const ms = getDocTimeMs(raw);
        if (ms < range.startMs || ms > range.endMs) return;
        if (type === "expenses") {
          if (!isValidWeeklyExpense(raw)) return;
        } else {
          if (isInvalidState(raw.estado || raw.status) || getMoneyValue(raw) <= 0 || raw.cancelado === true || raw.anulado === true || raw.eliminado === true) return;
        }
        rows.push(raw);
      });
      return { rows, range };
    }

    function adminRowsForDriver(rows, driver) {
      return rows.filter(row => adminRecordMatchesDriver(row, driver));
    }

    function adminReceiptUrl(data = {}) {
      return String(window.ExploraReceiptEngine?.resolveReceiptSource?.(data)?.url || "").trim();
    }

    function adminReceiptMime(data = {}) {
      return String(window.ExploraReceiptEngine?.resolveReceiptSource?.(data)?.mimeType || "").toLowerCase();
    }

    function adminDriverCardHeader(item, metric, meta, stateText = "") {
      const avatar = getProfileAvatarUrl(item.driver) || DEFAULT_AVATAR_SVG;
      return `<summary><img class="admin-driver-avatar" src="${escapeAdminHtml(avatar)}" alt="Avatar de ${escapeAdminHtml(getProfileName(item.driver))}" loading="lazy"><span class="admin-driver-copy"><strong>${escapeAdminHtml(getProfileName(item.driver))}</strong><span>${escapeAdminHtml(item.vehicle.displayName)}</span>${stateText ? `<small>${escapeAdminHtml(stateText)}</small>` : ""}</span><span class="admin-driver-metric"><strong>${escapeAdminHtml(metric)}</strong><small>${escapeAdminHtml(meta)}</small></span></summary>`;
    }

    function renderAdminClosures(overview) {
      if (!overview.drivers.length) return `<div class="admin-shared-empty">No hay choferes activos.</div>`;
      const order={missing:0,rejected:1,received:2,live:3,confirmed:4,balanced:5};
      const rows=overview.drivers.map(item=>{const summary=adminClosureSummary(item);const presentation=adminClosurePresentation(item,summary);return{item,summary,presentation};}).sort((a,b)=>(order[a.presentation.key]??9)-(order[b.presentation.key]??9)||getProfileName(a.item.driver).localeCompare(getProfileName(b.item.driver),"es"));
      const counters={missing:0,received:0,confirmed:0,rejected:0,live:0,balanced:0};rows.forEach(row=>{counters[row.presentation.key]=(counters[row.presentation.key]||0)+1;});
      const overviewHtml=`<section class="admin-closure-overview-v247"><div><span>SEMANA ACTUAL</span><strong>${escapeAdminHtml(closurePeriodLabel({},overview.weeklyPeriodId))}</strong><small>Resultados provisionales y comprobantes definitivos en un solo lugar.</small></div><div class="admin-closure-counter-grid"><article class="is-missing"><span>Por liquidar</span><b>${counters.missing}</b></article><article class="is-received"><span>Comprobante recibido</span><b>${counters.received}</b></article><article class="is-confirmed"><span>Pago confirmado</span><b>${counters.confirmed}</b></article><article class="is-live"><span>Semana en curso</span><b>${counters.live}</b></article></div></section>`;
      const groups=[["missing","FALTA COMPROBANTE"],["rejected","COMPROBANTE RECHAZADO"],["received","COMPROBANTE RECIBIDO"],["live","SEMANA EN CURSO"],["confirmed","PAGO CONFIRMADO"],["balanced","CUENTA EQUILIBRADA"]].map(([key,label])=>{
        const group=rows.filter(row=>row.presentation.key===key);if(!group.length)return"";
        const cards=group.map(({item,summary,presentation})=>{
          const tone=presentation.tone==="danger"?"is-danger":presentation.tone==="gold"?"is-gold":presentation.tone==="info"?"is-info":"is-ok";
          const result=summary.balanced?"Cuenta equilibrada":summary.payer==="driver"?"Chofer paga a David":"David paga al chofer";
          return `<details class="admin-driver-card admin-closure-driver-card is-${escapeAdminHtml(presentation.key)}" data-admin-driver-card="${escapeAdminHtml(item.uid)}">${adminDriverCardHeader(item,adminMoney(summary.amount),result,presentation.detail)}<div class="admin-driver-detail"><div class="admin-detail-row"><span>Estado</span><strong><span class="admin-state-pill ${tone}">${escapeAdminHtml(presentation.label)}</span></strong></div><div class="admin-detail-row"><span>Período mostrado</span><strong>${escapeAdminHtml(summary.periodId||overview.weeklyPeriodId)}</strong></div><div class="admin-detail-row"><span>Resultado</span><strong>${escapeAdminHtml(summary.balanced?"Cuenta equilibrada":`${result} ${adminMoney(summary.amount)}`)}</strong></div><button class="admin-card-action" type="button" data-admin-open-closure="${escapeAdminHtml(item.uid)}">VER CIERRE COMPLETO</button></div></details>`;
        }).join("");
        return `<section class="admin-closure-status-v247 is-${key}"><header><span>${label}</span><b>${group.length}</b></header>${cards}</section>`;
      }).join("");
      return `${overviewHtml}${groups}`;
    }

    function serviceRowMarkup(row) {
      const title = row.nombreServicio || row.servicioNombre || row.categoria || row.destino || "Servicio";
      const origin = row.origen || row.inicio || "Origen no informado";
      const destination = row.destino || row.final || "Destino no informado";
      return `<div class="admin-detail-row"><span><b>${escapeAdminHtml(title)}</b><br>${escapeAdminHtml(origin)} → ${escapeAdminHtml(destination)}<br>${escapeAdminHtml(adminDateTime(row.creadoEn || row.createdAt || row.fechaTimestamp || row.fecha))}</span><strong>${adminMoney(getMoneyValue(row))}</strong></div>`;
    }

    function expenseRowMarkup(row) {
      const expense = normalizeExpenseDocument(row);
      const receipt = expense.receiptUrl || adminReceiptUrl(row);
      const mime = expense.receiptMimeType || adminReceiptMime(row);
      return `<div class="admin-detail-row"><span><b>${escapeAdminHtml(expense.category)}</b><br>${escapeAdminHtml(expense.notes || "Sin observación")}<br>${escapeAdminHtml(adminDateTime(row.creadoEn || row.createdAt || row.fechaTimestamp || row.fecha))}${receipt ? `<br><button type="button" class="admin-secondary-action" data-admin-view-receipt="${escapeAdminHtml(receipt)}" data-admin-receipt-mime="${escapeAdminHtml(mime)}" data-admin-receipt-title="Comprobante de gasto">VER ${mime.includes("pdf") ? "ARCHIVO" : "FOTO"}</button>` : "<br>Sin comprobante"}</span><strong>${adminMoney(expense.amount)}</strong></div>`;
    }

    async function renderAdminBillingOrExpenses(type, mode) {
      const overview=adminSharedState.overview||await getAdminWeeklyOverview();let range=adminPeriodRange(mode),driverRows=[];
      if(mode==="week"){
        driverRows=overview.drivers.map(item=>{const rows=type==="expenses"?item.snapshot.expenses:item.snapshot.services,baseTotal=type==="expenses"?Number(item.snapshot.totalExpenses||0):Number(item.snapshot.grossBilling||0),collaboration=type==="services"?Number(item.snapshot.collaborationAmount||0):0;return{item,rows,total:baseTotal+collaboration,baseTotal,collaboration,count:type==="expenses"?item.snapshot.expenseCount:item.snapshot.serviceCount};});
      }else{
        const historical=await loadAdminHistoricalRows(type,mode);range=historical.range;driverRows=overview.drivers.map(item=>{const rows=adminRowsForDriver(historical.rows,item.driver),total=rows.reduce((sum,row)=>sum+(type==="expenses"?normalizeExpenseDocument(row).amount:getMoneyValue(row)),0);return{item,rows,total,baseTotal:total,collaboration:0,count:rows.length};});
      }
      const total=driverRows.reduce((sum,row)=>sum+row.total,0),baseTotal=driverRows.reduce((sum,row)=>sum+row.baseTotal,0),collaborationTotal=driverRows.reduce((sum,row)=>sum+row.collaboration,0),active=driverRows.filter(row=>row.count>0||row.collaboration>0).length;
      const summary=type==="services"&&mode==="week"?`<section class="admin-shared-summary"><article><span>Servicios facturados</span><strong>${adminMoney(baseTotal)}</strong></article><article><span>Aporte al bono</span><strong>+${adminMoney(collaborationTotal)}</strong></article><article><span>Facturación semanal Admin</span><strong>${adminMoney(total)}</strong></article></section>`:`<section class="admin-shared-summary"><article><span>Total del período</span><strong>${adminMoney(total)}</strong></article><article><span>Choferes con ${type==="expenses"?"gastos":"actividad"}</span><strong>${active}</strong></article></section>`;
      const list=driverRows.map(({item,rows,total,baseTotal,collaboration,count})=>{const records=rows.length?rows.sort((a,b)=>getDocTimeMs(b)-getDocTimeMs(a)).map(type==="expenses"?expenseRowMarkup:serviceRowMarkup).join(""):`<div class="admin-shared-empty">${type==="expenses"?"Sin gastos":"Sin servicios facturados"} en este período.</div>`;const collaborationRow=type==="services"&&mode==="week"&&collaboration>0?`<div class="admin-detail-row"><span>Aporte al bono</span><strong>+${adminMoney(collaboration)}</strong></div>`:"";return `<details class="admin-driver-card">${adminDriverCardHeader(item,adminMoney(total),`${count} ${count===1?"servicio":"servicios"}${collaboration?` · colaboración para bono ${adminMoney(collaboration)}`:""}`,range.label)}<div class="admin-driver-detail">${collaborationRow}${records}</div></details>`;}).join("");
      return summary+(list||`<div class="admin-shared-empty">Sin datos en este período.</div>`);
    }

    function renderAdminPaymentReceipts(overview) {
      return overview.drivers.map(item => {
        const closure = item.closureInfo;
        const p = adminClosurePresentation(item);
        const receipt = closure.receiptUrl;
        const mime = adminReceiptMime({ receiptUrl:receipt, receiptMimeType:closure.payment?.davidReceiptMimeType || closure.payment?.receiptMimeType || closure.closure?.receiptMimeType || "" });
        const button = receipt ? `<button type="button" class="admin-secondary-action" data-admin-view-receipt="${escapeAdminHtml(receipt)}" data-admin-receipt-mime="${escapeAdminHtml(mime)}" data-admin-receipt-title="Comprobante semanal">VER ${mime.includes("pdf") ? "ARCHIVO" : "FOTO"}</button>` : "";
        return `<details class="admin-driver-card">${adminDriverCardHeader(item, closure.amount ? adminMoney(closure.amount) : "$0", p.payer, p.label)}<div class="admin-driver-detail"><div class="admin-detail-row"><span>Quién debía pagar</span><strong>${escapeAdminHtml(p.payer)}</strong></div><div class="admin-detail-row"><span>Estado</span><strong>${escapeAdminHtml(p.detail)}</strong></div><div class="admin-detail-row"><span>Elegibilidad</span><strong>${closure.performanceEligible === false ? "No elegible" : "Elegible"}</strong></div>${button || (closure.direction === "sin_diferencia" ? `<div class="admin-shared-empty">Cierre equilibrado · No se requiere comprobante.</div>` : `<div class="admin-shared-empty">Sin comprobante cargado.</div>`)}</div></details>`;
      }).join("") || `<div class="admin-shared-empty">Sin comprobantes en este período.</div>`;
    }

    async function renderAdminHistoricalPayments(overview, mode) {
      if (mode === "week") return renderAdminPaymentReceipts(overview);
      const range = adminPeriodRange(mode);
      const docs = await loadAdminClosureDocuments();
      const cards = [];
      for (const item of overview.drivers) {
        const closures = docs.closures.filter(record => adminRecordMatchesDriver(record.data, item.driver) && closureRecordTime(record.data) >= range.startMs && closureRecordTime(record.data) <= range.endMs);
        for (const closureRecord of closures) {
          const pid = closurePeriodId(closureRecord.data);
          const paymentRecord = docs.payments.find(record => adminRecordMatchesDriver(record.data, item.driver) && (!pid || closurePeriodId(record.data) === pid)) || null;
          const closure = closureRecord.data || {};
          const payment = paymentRecord?.data || {};
          const direction = closureDirection(closure, payment);
          const amount = closureAmount(closure, payment, direction);
          const receipt = closureReceiptUrl(closure, payment);
          const status = closureReceiptStatus(closure, payment);
          const payer = direction === "chofer_a_david" ? "Chofer" : direction === "david_a_chofer" ? "David" : "Nadie";
          const label = direction === "sin_diferencia" ? "CIERRE EQUILIBRADO" : receipt ? (payer === "David" ? "PAGADO POR DAVID" : "PAGADO POR CHOFER") : "PAGO PENDIENTE";
          const mime = adminReceiptMime(payment);
          cards.push(`<details class="admin-driver-card">${adminDriverCardHeader(item, amount ? adminMoney(amount) : "$0", payer, `${pid || range.label} · ${label}`)}<div class="admin-driver-detail"><div class="admin-detail-row"><span>Estado</span><strong>${escapeAdminHtml(status === "missing" ? label : status)}</strong></div><div class="admin-detail-row"><span>Fecha de cierre</span><strong>${escapeAdminHtml(adminDateTime(closureRecordTime(closure)))}</strong></div>${receipt ? `<button type="button" class="admin-secondary-action" data-admin-view-receipt="${escapeAdminHtml(receipt)}" data-admin-receipt-mime="${escapeAdminHtml(mime)}" data-admin-receipt-title="Comprobante semanal">VER ${mime.includes("pdf") ? "ARCHIVO" : "FOTO"}</button>` : `<div class="admin-shared-empty">${direction === "sin_diferencia" ? "No se requiere comprobante." : "Sin comprobante cargado."}</div>`}</div></details>`);
        }
      }
      return cards.join("") || `<div class="admin-shared-empty">Sin comprobantes en este período.</div>`;
    }

    async function renderAdminReceipts() {
      const overview = adminSharedState.overview || await getAdminWeeklyOverview();
      if (adminSharedState.receiptTab === "payments") return renderAdminHistoricalPayments(overview, adminSharedState.periodMode);
      return renderAdminBillingOrExpenses("expenses", adminSharedState.periodMode);
    }

    function adminSelectedItem(uid) {
      return adminSharedState.overview?.drivers?.find(item => String(item.uid) === String(uid)) || null;
    }

    function renderAdminClosureDetail(item) {
      if(!item)return `<div class="admin-shared-empty">No se encontró el cierre seleccionado.</div>`;
      const c=item.closureInfo||{},summary=adminClosureSummary(item),presentation=adminClosurePresentation(item,summary),isDefinitive=Boolean(c.exists&&String(c.weeklyPeriodId||"")===String(summary.periodId||"")),receipt=isDefinitive?c.receiptUrl:"",mime=adminReceiptMime({receiptMimeType:c.payment?.davidReceiptMimeType||c.payment?.receiptMimeType||c.closure?.receiptMimeType||""}),canUploadDavid=isDefinitive&&c.direction==="david_a_chofer"&&!receipt;
      const moneyRow=(label,value,{tone="",note=""}={})=>`<div class="admin-closure-line-v247 ${tone?`is-${tone}`:""}"><span>${escapeAdminHtml(label)}${note?`<small>${escapeAdminHtml(note)}</small>`:""}</span><strong>${escapeAdminHtml(value)}</strong></div>`;
      const settlement=(signed)=>{const value=Number(signed)||0;if(Math.abs(value)<WEEKLY_CLOSURE_BALANCE_TOLERANCE)return{label:"CUENTA EQUILIBRADA",amount:"$0",tone:"info"};return value<0?{label:"Chofer paga a David",amount:adminMoney(Math.abs(value)),tone:"negative"}:{label:"David paga al chofer",amount:adminMoney(Math.abs(value)),tone:"positive"};};
      const adjustments=weeklyAdjustmentSummary(summary);
      const adminSettlement=adjustments.settlementToDriver;
      const after=settlement(adminSettlement);
      const otherAdjustments=adjustments.otherAdjustments;
      const weekSection=`<section class="admin-closure-section-v247"><header><span>1</span><div><small>CIERRE DE SEMANA</small><h3>MOVIMIENTO DE LA SEMANA</h3></div></header>${moneyRow("Facturación total",adminMoney(summary.grossBilling))}${moneyRow("Efectivo",adminMoney(summary.cash))}${moneyRow("Transferencias",adminMoney(summary.transfers))}${moneyRow("Tarjetas",adminMoney(summary.cards))}${moneyRow("QR",adminMoney(summary.qr))}${moneyRow("Gastos pagados",summary.expenses?`−${adminMoney(summary.expenses)}`:"$0",{tone:summary.expenses?"negative":""})}</section>`;
      const resultSection=`<section class="admin-closure-section-v247"><header><span>2</span><div><small>DISTRIBUCIÓN 50/50</small><h3>RESULTADO PARA REPARTIR</h3></div></header>${moneyRow("Ganancia después de gastos",adminMoney(summary.profitAfterExpenses),{tone:"positive"})}${moneyRow("Parte del chofer · 50%",adminMoney(summary.driverProfitShare),{tone:"positive"})}${moneyRow("Parte de EXPLORA · 50%",adminMoney(summary.exploraProfitShare),{tone:"info"})}</section>`;
      const adjustmentsSection=`<section class="admin-closure-section-v247"><header><span>3</span><div><small>BONOS Y DESCUENTOS</small><h3>AJUSTES DEL CHOFER</h3></div></header>${moneyRow("Bono diario",adjustments.dailyBonus?`+${adminMoney(adjustments.dailyBonus)}`:"$0",{tone:adjustments.dailyBonus?"positive":""})}${moneyRow("Caja chica · 5%",summary.repairFundAmount?`−${adminMoney(summary.repairFundAmount)}`:"$0",{tone:summary.repairFundAmount?"negative":""})}${moneyRow("Otros ajustes",otherAdjustments>0?`+${adminMoney(otherAdjustments)}`:otherAdjustments<0?`−${adminMoney(Math.abs(otherAdjustments))}`:"$0",{tone:otherAdjustments>0?"positive":otherAdjustments<0?"negative":""})}<div class="admin-closure-total-v247">${moneyRow("PARTE FINAL DEL CHOFER",adminMoney(adjustments.finalDriverShare),{tone:adjustments.finalDriverShare>=0?"positive":"negative"})}</div></section>`;
      const liquidationSection=`<section class="admin-closure-section-v247"><header><span>4</span><div><small>DINERO REAL</small><h3>LIQUIDACIÓN</h3></div></header>${moneyRow("Dinero en poder del chofer",adminMoney(summary.driverFundsAfterExpenses))}${moneyRow("Parte que conserva",adminMoney(adjustments.finalDriverShare),{tone:"positive"})}<div class="admin-closure-total-v247">${moneyRow(after.label,after.amount,{tone:after.tone})}</div></section>`;
      const finalSection=`<section class="admin-closure-final-v247 is-${after.tone}"><span>RESULTADO FINAL</span><strong>${escapeAdminHtml(after.label)}</strong><b>${escapeAdminHtml(after.amount)}</b><small>${escapeAdminHtml(isDefinitive?"Resultado definitivo del cierre":"Resultado provisional de la semana en curso")}</small></section>`;
      const receiptSection=`<section class="admin-closure-section-v247 admin-closure-receipt-v247"><header><span>6</span><div><small>RESPALDO</small><h3>COMPROBANTE DE CIERRE</h3></div></header>${moneyRow("Estado",presentation.receiptLabel||presentation.label,{tone:presentation.key==="rejected"||presentation.key==="missing"?"negative":presentation.key==="confirmed"||presentation.key==="balanced"?"positive":"info"})}${isDefinitive&&c.closedAtMs?moneyRow("Fecha de cierre",adminDateTime(c.closedAtMs)):""}${receipt?`<button type="button" class="admin-card-action" data-admin-view-receipt="${escapeAdminHtml(receipt)}" data-admin-receipt-mime="${escapeAdminHtml(mime)}" data-admin-receipt-title="Comprobante de ${escapeAdminHtml(getProfileName(item.driver))}">VER ${mime.includes("pdf")?"ARCHIVO":"FOTO"}</button>`:""}${canUploadDavid?`<div class="admin-upload-box">${window.ExploraReceiptUI.markup({triggerId:"adminDavidReceiptPicker",previewId:"adminDavidReceiptPreview",thumbId:"adminDavidReceiptPreviewThumb",nameId:"adminDavidReceiptPreviewName",metaId:"adminDavidReceiptPreviewMeta",removeId:"adminDavidReceiptPreviewRemove",heading:"Comprobante"})}<button type="button" class="admin-primary-action" data-admin-upload-david-receipt="${escapeAdminHtml(item.uid)}" disabled>SUBIR COMPROBANTE</button><div id="adminDavidReceiptMsg" class="admin-shared-status"></div></div>`:(!isDefinitive?`<div class="admin-closure-empty-v247">La semana está en curso. Todavía no corresponde cargar comprobante.</div>`:(!receipt&&summary.balanced?`<div class="admin-closure-empty-v247">Cuenta equilibrada. No se requiere comprobante.</div>`:(!receipt?`<div class="admin-closure-empty-v247">Todavía no se cargó el comprobante.</div>`:"")))}</section>`;
      return `<section class="admin-closure-detail-v247"><div class="admin-closure-driver-v247"><img src="${escapeAdminHtml(getProfileAvatarUrl(item.driver)||DEFAULT_AVATAR_SVG)}" alt="Avatar de ${escapeAdminHtml(getProfileName(item.driver))}"><div><span>${escapeAdminHtml(isDefinitive?"CIERRE SEMANAL":"SEMANA EN CURSO")}</span><h2>${escapeAdminHtml(getProfileName(item.driver))}</h2><p>${escapeAdminHtml(item.vehicle.displayName)} · ${escapeAdminHtml(summary.periodId||adminSharedState.overview?.weeklyPeriodId||"")}</p></div><b class="is-${escapeAdminHtml(presentation.key)}">${escapeAdminHtml(presentation.label)}</b></div>${weekSection}${resultSection}${adjustmentsSection}${liquidationSection}${finalSection}${receiptSection}</section>`;
    }

    function setAdminSharedHeader(title, subtitle) {
      $("adminSharedTitle").textContent = title;
      $("adminSharedSubtitle").textContent = subtitle;
    }

    function setAdminSharedLoading(text = "Cargando…") {
      $("adminSharedStatus").textContent = text;
      $("adminSharedStatus").className = "admin-shared-status";
      $("adminSharedContent").innerHTML = `<div class="admin-shared-empty">${escapeAdminHtml(text)}</div>`;
    }


    function operationalLoanFormatBytes(value) {
      const bytes=Number(value||0);
      if(!(bytes>0))return "—";
      if(bytes<1024)return `${bytes} B`;
      if(bytes<1024*1024)return `${Math.round(bytes/1024)} KB`;
      return `${(bytes/(1024*1024)).toFixed(2)} MB`;
    }

    function operationalLoanBucketName() {
      return String(window.ExploraFirebase?.storage?.app?.options?.storageBucket || window.ExploraFirebase?.app?.options?.storageBucket || "—").replace(/^gs:\/\//,"");
    }

    function operationalLoanDiagnosticMarkup() {
      return `<section id="adminLoanDiagnostic" class="operational-loan-diagnostic" role="alert" aria-live="assertive" hidden><div class="operational-loan-diagnostic-head"><strong>EXPLORA - ERROR PRÉSTAMO OPERATIVO</strong><button id="adminLoanDiagnosticClose" type="button" class="operational-loan-diagnostic-close" aria-label="Cerrar diagnóstico">×</button></div><div class="operational-loan-diagnostic-grid"><span>MÓDULO</span><b id="adminLoanDiagModule">—</b><span>ETAPA</span><b id="adminLoanDiagStage">—</b><span>CÓDIGO INTERNO</span><b id="adminLoanDiagInternalCode">—</b><span>CÓDIGO FIREBASE</span><b id="adminLoanDiagFirebaseCode">—</b><span>MENSAJE REAL FIREBASE</span><b id="adminLoanDiagFirebaseMessage">—</b><span>MENSAJE REAL JAVASCRIPT</span><b id="adminLoanDiagJsMessage">—</b><span>UID AUTH</span><b id="adminLoanDiagUid">—</b><span>EMAIL AUTH</span><b id="adminLoanDiagEmail">—</b><span>ROL</span><b id="adminLoanDiagRole">—</b><span>WEEKLYPERIODID</span><b id="adminLoanDiagPeriod">—</b><span>LOANID</span><b id="adminLoanDiagLoanId">—</b><span>ARCHIVO</span><b id="adminLoanDiagFile">—</b><span>MIME ORIGINAL</span><b id="adminLoanDiagOriginalMime">—</b><span>MIME PROCESADO</span><b id="adminLoanDiagProcessedMime">—</b><span>PESO ORIGINAL</span><b id="adminLoanDiagOriginalSize">—</b><span>PESO PROCESADO</span><b id="adminLoanDiagProcessedSize">—</b><span>RUTA STORAGE</span><b id="adminLoanDiagPath">—</b><span>BUCKET</span><b id="adminLoanDiagBucket">—</b><span>PORCENTAJE</span><b id="adminLoanDiagPercent">—</b><span>ESTADO TAREA</span><b id="adminLoanDiagTaskState">—</b><span>STORAGE CONFIRMADO</span><b id="adminLoanDiagStorageConfirmed">—</b><span>URL OBTENIDA</span><b id="adminLoanDiagUrlObtained">—</b><span>FIRESTORE CONFIRMADO</span><b id="adminLoanDiagFirestoreConfirmed">—</b><span>TIMESTAMP</span><b id="adminLoanDiagTimestamp">—</b><span>STACK</span><b id="adminLoanDiagStack" class="operational-loan-diagnostic-stack">—</b></div><button id="adminLoanDiagnosticCopy" type="button" class="operational-loan-diagnostic-copy">COPIAR ERROR</button></section>`;
    }

    function renderOperationalLoanDiagnostic(data=operationalLoanDiagnosticState) {
      const panel=$("adminLoanDiagnostic");
      if(!panel||!data)return;
      const values={
        adminLoanDiagModule:data.module,adminLoanDiagStage:data.stage,adminLoanDiagInternalCode:data.internalCode,
        adminLoanDiagFirebaseCode:data.firebaseCode,adminLoanDiagFirebaseMessage:data.firebaseMessage,
        adminLoanDiagJsMessage:data.javascriptMessage,adminLoanDiagUid:data.uidAuth,adminLoanDiagEmail:data.emailAuth,
        adminLoanDiagRole:data.role,adminLoanDiagPeriod:data.weeklyPeriodId,adminLoanDiagLoanId:data.loanId,
        adminLoanDiagFile:data.fileName,adminLoanDiagOriginalMime:data.originalMime,adminLoanDiagProcessedMime:data.processedMime,
        adminLoanDiagOriginalSize:data.originalSize,adminLoanDiagProcessedSize:data.processedSize,
        adminLoanDiagPath:data.storagePath,adminLoanDiagBucket:data.bucket,adminLoanDiagPercent:data.percent,
        adminLoanDiagTaskState:data.taskState,adminLoanDiagStorageConfirmed:data.storageConfirmed,
        adminLoanDiagUrlObtained:data.urlObtained,adminLoanDiagFirestoreConfirmed:data.firestoreConfirmed,
        adminLoanDiagTimestamp:data.timestamp,adminLoanDiagStack:data.stack
      };
      Object.entries(values).forEach(([id,value])=>{const node=$(id);if(node)node.textContent=String(value??"—");});
      panel.hidden=false;
    }

    function operationalLoanDiagnosticText(data=operationalLoanDiagnosticState) {
      if(!data)return "";
      return [
        ["EXPLORA - ERROR PRÉSTAMO OPERATIVO",""],["MÓDULO",data.module],["ETAPA",data.stage],
        ["CÓDIGO INTERNO",data.internalCode],["CÓDIGO FIREBASE",data.firebaseCode],
        ["MENSAJE REAL FIREBASE",data.firebaseMessage],["MENSAJE REAL JAVASCRIPT",data.javascriptMessage],
        ["UID AUTH",data.uidAuth],["EMAIL AUTH",data.emailAuth],["ROL",data.role],
        ["WEEKLYPERIODID",data.weeklyPeriodId],["LOANID",data.loanId],["ARCHIVO",data.fileName],
        ["MIME ORIGINAL",data.originalMime],["MIME PROCESADO",data.processedMime],
        ["PESO ORIGINAL",data.originalSize],["PESO PROCESADO",data.processedSize],
        ["RUTA STORAGE",data.storagePath],["BUCKET",data.bucket],["PORCENTAJE",data.percent],
        ["ESTADO TAREA",data.taskState],["STORAGE CONFIRMADO",data.storageConfirmed],
        ["URL OBTENIDA",data.urlObtained],["FIRESTORE CONFIRMADO",data.firestoreConfirmed],
        ["TIMESTAMP",data.timestamp],["STACK",data.stack]
      ].map(([label,value])=>value===""?label:`${label}: ${value??"—"}`).join("\n");
    }

    async function copyOperationalLoanDiagnostic() {
      const value=operationalLoanDiagnosticText();
      if(!value)return;
      try{await navigator.clipboard.writeText(value);}
      catch(_){const area=document.createElement("textarea");area.value=value;area.setAttribute("readonly","");area.style.position="fixed";area.style.left="-9999px";document.body.appendChild(area);area.select();try{document.execCommand("copy");}catch(__){}area.remove();}
      window.showToast?.("Diagnóstico copiado.");
    }

    function closeOperationalLoanDiagnostic() {
      operationalLoanDiagnosticState=null;
      const panel=$("adminLoanDiagnostic");if(panel)panel.hidden=true;
      const message=$("adminLoanMsg");if(message){message.textContent="";message.className="admin-shared-status operational-loan-status";}
    }

    function createOperationalLoanRuntime() {
      const state=window.ExploraReceiptEngine?.getState?.("operationalLoan")||{};
      const user=window.ExploraFirebase?.auth?.currentUser||null;
      return {stage:"VALIDATING_FORM",startedAt:Date.now(),uidAuth:String(user?.uid||""),emailAuth:String(user?.email||""),role:String(window.ExploraSession?.role||""),weeklyPeriodId:String(getActiveWeeklyPeriod?.()?.id||adminSharedState.overview?.weeklyPeriodId||""),loanId:"",file:state.file||null,processed:state.processedFile||null,storagePath:"",percent:0,taskState:"idle",storageConfirmed:false,urlObtained:false,firestoreConfirmed:false};
    }

    function createOperationalLoanId(driverUid) {
      const suffix=globalThis.crypto?.randomUUID?.().slice(0,8)||Math.random().toString(36).slice(2,10);
      return `loan_${String(driverUid||"driver").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,20)}_${Date.now()}_${suffix}`.slice(0,110);
    }

    function classifyOperationalLoanError(error,runtime) {
      const cause=error?.cause||error;
      const firebaseCode=String(cause?.code||error?.code||"");
      const rawMessage=String(cause?.message||error?.message||"No se pudo registrar el préstamo.");
      const normalized=`${firebaseCode} ${rawMessage}`.toLowerCase();
      let stage=String(error?.loanStage||runtime.stage||"ERROR");
      let internalCode=String(error?.internalCode||"");
      let userMessage="No se pudo registrar el préstamo operativo.";
      if(normalized.includes("receipt_required")){stage="VALIDATING_FORM";internalCode="INVALID_RECEIPT_FILE";userMessage="Selecciona un comprobante válido.";}
      else if(normalized.includes("loan_driver_required")){stage="VALIDATING_FORM";internalCode="DRIVER_REQUIRED";userMessage="Selecciona un chofer.";}
      else if(normalized.includes("loan_amount_invalid")){stage="VALIDATING_FORM";internalCode="AMOUNT_REQUIRED";userMessage="Ingresa un monto válido.";}
      else if(normalized.includes("retry-limit-exceeded")||normalized.includes("timeout")){stage="STORAGE_UPLOAD";internalCode="STORAGE_UPLOAD_TIMEOUT";userMessage="Firebase Storage no respondió dentro del tiempo esperado.";}
      else if(firebaseCode.startsWith("storage/")||stage==="STORAGE_UPLOAD"||normalized.includes("storage")){stage="STORAGE_UPLOAD";internalCode=internalCode||"STORAGE_UPLOAD_FAILED";userMessage="Firebase Storage rechazó la subida del comprobante.";}
      else if(stage==="GET_DOWNLOAD_URL"||normalized.includes("download_url")){stage="GET_DOWNLOAD_URL";internalCode=internalCode||"GET_DOWNLOAD_URL_FAILED";userMessage="El archivo se subió, pero Firebase no devolvió una URL válida.";}
      else if(stage==="FIRESTORE_WRITE"||firebaseCode.includes("permission-denied")||normalized.includes("firestore")){stage="FIRESTORE_WRITE";internalCode=internalCode||"FIRESTORE_WRITE_FAILED";userMessage="No se pudo guardar el préstamo en Firestore.";}
      else if(normalized.includes("admin_access_denied")||normalized.includes("auth_required")){stage="VALIDATING_FORM";internalCode=internalCode||"ADMIN_ACCESS_DENIED";userMessage="La sesión actual no tiene permisos para registrar préstamos.";}
      else{internalCode=internalCode||"OPERATIONAL_LOAN_FAILED";}
      return {stage,internalCode,firebaseCode:firebaseCode||"—",firebaseMessage:rawMessage,javascriptMessage:String(error?.message||rawMessage),userMessage,cause};
    }

    function showOperationalLoanFailure(error,runtime) {
      const normalized=classifyOperationalLoanError(error,runtime);
      const uploadState=window.ExploraReceiptEngine?.getState?.("operationalLoan")||{};
      const file=runtime.file||uploadState.file;
      const processed=runtime.processed||uploadState.processedFile||{};
      operationalLoanDiagnosticState={
        module:"PRESTAMO_OPERATIVO",stage:normalized.stage,internalCode:normalized.internalCode,
        firebaseCode:normalized.firebaseCode,firebaseMessage:normalized.firebaseMessage,
        javascriptMessage:normalized.javascriptMessage,uidAuth:runtime.uidAuth||"—",emailAuth:runtime.emailAuth||"—",
        role:runtime.role||"—",weeklyPeriodId:runtime.weeklyPeriodId||"—",loanId:runtime.loanId||"—",
        fileName:String(file?.name||"—"),originalMime:String(file?.type||"—"),processedMime:String(processed?.mimeType||processed?.file?.type||"—"),
        originalSize:operationalLoanFormatBytes(file?.size),processedSize:operationalLoanFormatBytes(processed?.size||processed?.file?.size),
        storagePath:runtime.storagePath||String(error?.storagePath||"—"),bucket:operationalLoanBucketName(),
        percent:`${Number(runtime.percent||0)} %`,taskState:runtime.taskState||"failed",
        storageConfirmed:runtime.storageConfirmed?"Sí":"No",urlObtained:runtime.urlObtained?"Sí":"No",
        firestoreConfirmed:runtime.firestoreConfirmed?"Sí":"No",timestamp:new Date().toISOString(),
        stack:String(normalized.cause?.stack||error?.stack||"—")
      };
      const message=$("adminLoanMsg");if(message){message.textContent=normalized.userMessage;message.className="admin-shared-status operational-loan-status is-error";}
      renderOperationalLoanDiagnostic(operationalLoanDiagnosticState);
      return normalized;
    }

    function handleOperationalLoanStage(stage,detail,runtime,button) {
      if(stage==="VALIDATING_FORM"){runtime.stage="VALIDATING_FORM";button.textContent="VALIDANDO DATOS…";return;}
      if(stage==="PROCESS_FILE"){runtime.stage="PROCESSING_IMAGE";button.textContent="PREPARANDO COMPROBANTE…";return;}
      if(stage==="STORAGE_PATH"){runtime.stage="STORAGE_PATH";runtime.storagePath=String(detail?.path||runtime.storagePath||"");return;}
      if(stage==="UPLOAD_START"){runtime.stage="STORAGE_UPLOAD";runtime.storagePath=String(detail?.path||runtime.storagePath||"");runtime.processed={mimeType:detail?.mimeType,size:detail?.size};runtime.percent=0;runtime.taskState=String(detail?.taskState||"starting");button.textContent="SUBIENDO COMPROBANTE 0 %";return;}
      if(stage==="UPLOAD_PROGRESS"){runtime.stage="STORAGE_UPLOAD";runtime.percent=Number(detail?.percent||0);runtime.taskState=String(detail?.taskState||"running");runtime.storagePath=String(detail?.path||runtime.storagePath||"");runtime.processed={mimeType:detail?.mimeType,size:detail?.size};button.textContent=`SUBIENDO COMPROBANTE ${runtime.percent} %`;return;}
      if(stage==="UPLOAD_STATE"){runtime.taskState=String(detail?.taskState||runtime.taskState||"running");return;}
      if(stage==="UPLOAD_COMPLETE"){runtime.stage="GET_DOWNLOAD_URL";runtime.percent=100;runtime.taskState="success";runtime.storageConfirmed=true;runtime.urlObtained=true;button.textContent="OBTENIENDO URL…";return;}
      if(stage==="GET_DOWNLOAD_URL"){runtime.stage="GET_DOWNLOAD_URL";runtime.storageConfirmed=true;runtime.urlObtained=Boolean(detail?.urlObtained);button.textContent="OBTENIENDO URL…";return;}
      if(stage==="FIRESTORE_WRITE"){runtime.stage="FIRESTORE_WRITE";button.textContent="REGISTRANDO PRÉSTAMO…";return;}
      if(stage==="ROLLBACK"){runtime.stage="ROLLBACK";button.textContent="REVERTIENDO ARCHIVO…";return;}
      if(stage==="COMPLETED"){runtime.stage="COMPLETED";runtime.firestoreConfirmed=true;runtime.storageConfirmed=true;runtime.urlObtained=true;runtime.percent=100;runtime.taskState="success";}
    }

    function renderOperationalLoanModule(overview) {
      const options=(overview?.drivers||[]).map(item=>`<option value="${escapeAdminHtml(item.uid)}">${escapeAdminHtml(getProfileName(item.driver))} · ${escapeAdminHtml(item.vehicle.displayName)}</option>`).join("");
      const loans=(overview?.drivers||[]).flatMap(item=>(item.snapshot?.operationalLoans||[]).map(loan=>({item,loan})));
      const list=loans.length?loans.sort((a,b)=>(b.loan.createdAtMs||0)-(a.loan.createdAtMs||0)).map(({item,loan})=>`<article class="admin-detail-row"><span><b>${escapeAdminHtml(getProfileName(item.driver))}</b><br>${escapeAdminHtml(loan.notes||"Préstamo operativo")}<br>Parte Chofer ${adminMoney(loan.driverShare||loan.amount*.5)} · Parte David ${adminMoney(loan.adminShare||loan.amount*.5)}</span><strong>${adminMoney(loan.amount)}</strong></article>`).join(""):`<div class="admin-shared-empty">Sin préstamos operativos en la semana activa.</div>`;
      return `<section class="admin-detail-card"><h2 class="admin-loan-title">Registrar préstamo operativo</h2><p class="admin-loan-copy">David adelanta el dinero. El cierre asigna 50 % al Chofer y 50 % a Admin.</p><form id="adminOperationalLoanForm" class="admin-loan-form operational-loan-screen" novalidate><label>Chofer<select id="adminLoanDriver" required><option value="">Seleccionar chofer</option>${options}</select></label><label>Monto<input id="adminLoanAmount" inputmode="numeric" autocomplete="off" placeholder="$ 0" required></label><label>Observación<textarea id="adminLoanNotes" maxlength="180" placeholder="Motivo operativo"></textarea></label><label>Gasto vinculado (opcional)<input id="adminLoanLinkedExpense" placeholder="ID del gasto, si corresponde"></label>${window.ExploraReceiptUI.markup({triggerId:"adminLoanReceiptBtn",previewId:"adminLoanPreview",thumbId:"adminLoanPreviewThumb",nameId:"adminLoanPreviewName",metaId:"adminLoanPreviewMeta",removeId:"adminLoanPreviewRemove",heading:"Comprobante"})}<button id="adminLoanSubmit" class="admin-primary-action" type="submit">REGISTRAR PRÉSTAMO</button><div id="adminLoanMsg" class="admin-shared-status operational-loan-status" role="status" aria-live="assertive"></div>${operationalLoanDiagnosticMarkup()}</form></section><section class="admin-detail-card"><h2 class="admin-loan-title">Préstamos de la semana</h2>${list}</section>`;
    }

    async function submitOperationalLoan(event) {
      event.preventDefault();
      if(loanSaveInProgress)return;
      const button=$("adminLoanSubmit");
      const message=$("adminLoanMsg");
      const runtime=createOperationalLoanRuntime();
      loanSaveInProgress=true;
      if(button){button.disabled=true;button.setAttribute("aria-busy","true");button.textContent="VALIDANDO DATOS…";}
      try{
        runtime.stage="VALIDATING_FORM";
        const user=window.ExploraFirebase?.auth?.currentUser||null;
        if(!user?.uid)throw Object.assign(new Error("No hay usuario autenticado en Firebase Auth."),{code:"AUTH_REQUIRED",internalCode:"AUTH_USER_MISSING",loanStage:"VALIDATING_FORM"});
        runtime.uidAuth=String(user.uid);runtime.emailAuth=String(user.email||"");runtime.role=String(window.ExploraSession?.role||"");
        await assertCurrentAdminAccess();
        const driverUid=String($("adminLoanDriver")?.value||"").trim();
        const amount=toNumberSafe($("adminLoanAmount")?.value||"");
        const notes=String($("adminLoanNotes")?.value||"").trim();
        const linkedExpenseId=String($("adminLoanLinkedExpense")?.value||"").trim();
        const file=window.ExploraReceiptEngine?.getState?.("operationalLoan")?.file||null;
        runtime.file=file;
        if(!driverUid)throw Object.assign(new Error("Selecciona un chofer."),{code:"LOAN_DRIVER_REQUIRED",internalCode:"DRIVER_REQUIRED",loanStage:"VALIDATING_FORM"});
        if(!(amount>0))throw Object.assign(new Error("Ingresa un monto válido."),{code:"LOAN_AMOUNT_INVALID",internalCode:"AMOUNT_REQUIRED",loanStage:"VALIDATING_FORM"});
        if(!(file instanceof File))throw Object.assign(new Error("Selecciona un comprobante válido."),{code:"LOAN_RECEIPT_REQUIRED",internalCode:"INVALID_RECEIPT_FILE",loanStage:"VALIDATING_FORM"});
        const item=adminSelectedItem(driverUid);
        if(!item)throw Object.assign(new Error("No se encontró el chofer seleccionado."),{code:"LOAN_DRIVER_REQUIRED",internalCode:"DRIVER_REQUIRED",loanStage:"VALIDATING_FORM"});
        runtime.loanId=createOperationalLoanId(driverUid);
        if(!runtime.weeklyPeriodId)throw Object.assign(new Error("No se pudo identificar la semana activa."),{code:"WEEKLY_PERIOD_REQUIRED",internalCode:"WEEKLY_PERIOD_REQUIRED",loanStage:"VALIDATING_FORM"});
        await window.ExploraCreateOperationalLoan({
          loanId:runtime.loanId,
          weeklyPeriodId:runtime.weeklyPeriodId,
          driverUid,
          driverName:getProfileName(item.driver),
          amount,
          notes,
          linkedExpenseId,
          receiptFile:file,
          onStage:(stage,detail)=>handleOperationalLoanStage(stage,detail,runtime,button)
        });
        runtime.firestoreConfirmed=true;runtime.stage="COMPLETED";
        if(message&&!operationalLoanDiagnosticState){message.textContent="";message.className="admin-shared-status operational-loan-status";}
        invalidateAdminWeeklyData("operational-loan-created",driverUid,runtime.weeklyPeriodId);
        window.ExploraReceiptEngine?.resetUploadState?.("operationalLoan");
        const loanInput=$("operationalLoanReceiptInput");if(loanInput)loanInput.value="";
        window.ExploraReceiptUI?.clear?.({previewId:"adminLoanPreview",thumbId:"adminLoanPreviewThumb",nameId:"adminLoanPreviewName",metaId:"adminLoanPreviewMeta"});
        window.showExploraSuccess?.({title:"¡EXITOSO!",message:"Préstamo y comprobante registrados correctamente.",onAccept:()=>openAdminSharedModule("loan")});
      }catch(error){
        console.error("ADMIN_LOAN_SAVE",error);
        showOperationalLoanFailure(error,runtime);
      }finally{
        loanSaveInProgress=false;
        if(button){button.disabled=false;button.removeAttribute("aria-busy");button.textContent="REGISTRAR PRÉSTAMO";}
        window.unlockPageScroll?.("loan-upload");
      }
    }

    function renderAdminCollaboration(overview){
      const leader=overview.derivationLeader||{},balance=Number(overview.exploraCollaborationBalance||0);
      const summary=`<section class="admin-detail-card"><div class="admin-detail-grid"><article><span>Aporte al bono</span><strong>+${adminMoney(overview.totalCollaborations||0)}</strong></article><article><span>Derivaciones facturadas</span><strong>${Number(overview.totalInvoicedDerivations||0)}</strong></article><article><span>Bono por derivación proyectado</span><strong>−${adminMoney(overview.estimatedLeaderBonus||0)}</strong></article><article><span>Saldo a favor de Explora</span><strong>${balance>=0?"+":"−"}${adminMoney(Math.abs(balance))}</strong></article></div>${leader.uid?`<div class="admin-detail-row"><span>Líder actual</span><strong>${escapeAdminHtml(leader.name||"Chofer")} · ${adminMoney(leader.derivedAmount||0)} derivados · +10%</strong></div>`:'<div class="admin-shared-empty">Todavía no hay líder en la semana activa.</div>' }</section>`;
      const rows=(overview.drivers||[]).filter(item=>Number(item.snapshot.collaborationAmount||0)>0||Number(item.snapshot.derivedAmountForEmitter||0)>0).map(item=>`<article class="admin-driver-row"><div class="admin-driver-main"><img src="${escapeAdminHtml(getProfileAvatarUrl(item.driver)||DEFAULT_AVATAR_SVG)}" alt=""><span><strong>${escapeAdminHtml(getProfileName(item.driver))}</strong><small>${Number(item.snapshot.validDerivations||0)} derivaciones facturadas</small></span></div><div class="admin-driver-values"><span>Dinero derivado <b>${adminMoney(item.snapshot.derivedAmountForEmitter||0)}</b></span><span>Aporte al bono <b>+${adminMoney(item.snapshot.collaborationAmount||0)}</b></span></div></article>`).join("")||'<div class="admin-shared-empty">No hay colaboración para bono registrada en esta semana.</div>';
      return summary+`<section class="admin-driver-list">${rows}</section>`;
    }

    function renderAdminDerivationsAudit(overview){
      const rows=(overview.derivationRanking||[]).map(item=>`<article class="admin-derivation-audit-row"><div><strong>${escapeAdminHtml(item.name||item.uid||"Chofer")}</strong><small>${Number(item.count||0)} derivaciones facturadas · colaboración ${adminMoney(item.collaborationGenerated||0)}</small></div><b>${adminMoney(item.derivedAmount||0)} derivados</b></article>`).join("")||'<div class="admin-shared-empty">No hay derivaciones facturadas en la semana activa.</div>';
      return `<section class="admin-detail-card"><div class="admin-detail-grid"><article><span>Derivaciones facturadas</span><strong>${Number(overview.totalInvoicedDerivations||0)}</strong></article><article><span>Dinero derivado auditado</span><strong>${adminMoney((overview.derivationRanking||[]).reduce((sum,row)=>sum+Number(row.derivedAmount||0),0))}</strong></article><article><span>Colaboración semanal</span><strong>${adminMoney(overview.totalCollaborations||0)}</strong></article><article><span>Semana</span><strong>${escapeAdminHtml(overview.derivationWeek?.id||overview.weeklyPeriodId||"Activa")}</strong></article></div></section><section class="admin-derivation-audit-list">${rows}</section>`;
    }
    async function loadAdminPerformancePercentages(){
      return Object.freeze({derivationBonusPercent:10,collaborationPercent:10,driverBasePercent:50,repairFundPercent:5,sharedExpensePercent:50});
    }
    function renderAdminPercentages(){
      return `<section class="admin-detail-card"><h3>REGLAS FINANCIERAS FIJAS</h3><div class="admin-detail-grid"><article><span>Participación base</span><strong>50% / 50%</strong></article><article><span>Bono por derivaciones</span><strong>+10%</strong></article><article><span>Colaboración por derivaciones</span><strong>−10%</strong></article><article><span>Caja chica</span><strong>−5%</strong></article><article><span>Gastos compartidos</span><strong>50 / 50</strong></article><article><span>Bono diario</span><strong>+$20.000</strong></article></div><p class="admin-shared-empty">Estas reglas son fijas y no admiten edición.</p></section>`;
    }
    async function saveAdminPerformancePercentages(event){
      event?.preventDefault?.();
      throw Object.assign(new Error("Las reglas financieras son fijas y no admiten edición."),{code:"FIXED_FINANCIAL_RULES"});
    }

    function shortAdminUid(value = "") { const clean = String(value || "").trim(); return clean ? (clean.length > 12 ? `${clean.slice(0,8)}…${clean.slice(-3)}` : clean) : "—"; }

    function driverVehicleId(driver = {}) { return String(driver.assignedVehicleId || driver.vehicleId || driver.vehiculoId || driver.vehiculo || "").trim(); }

    function managementVehicleOptions(currentVehicleId = "", driver = {}) {
      const options = ['<option value="">Sin vehículo asignado</option>'];
      adminManagementState.vehicles.forEach(vehicle => {
        const assignment = vehicleAssignmentState(vehicle);
        const current = vehicle.id === currentVehicleId;
        const assignedElsewhere = assignment.assigned && !adminDriverIdentities(driver).has(String(assignment.currentDriverUid || "").toLowerCase());
        const suffix = assignedElsewhere ? ` · Asignado a ${vehicle.currentDriverName || assignment.currentDriverUid}` : "";
        options.push(`<option value="${escapeAdminHtml(vehicle.id)}"${current ? " selected" : ""}>${escapeAdminHtml(vehicleSelectLabel(vehicle) + suffix)}</option>`);
      });
      return options.join("");
    }

    async function renderAdminDriversManagement() {
      const drivers = await loadAdminDrivers({ includeInactive:false, includeDeleted:false, includeOrphans:false });
      adminManagementState.drivers = drivers;
      adminManagementState.vehicles = [];
      const rows = drivers.map(driver => {
        const uid = adminDriverKey(driver) || driver.id;
        const username = String(driver.usuario || driver.username || driver.usuarioNormalizado || "").trim();
        return `<article class="admin-management-card admin-driver-only-card" data-admin-driver-card="${escapeAdminHtml(driver.id)}"><div class="admin-management-card-head"><div class="admin-management-card-title"><strong>${escapeAdminHtml(getProfileName(driver))}</strong><span>ID ${escapeAdminHtml(username || shortAdminUid(uid))} · Rol chofer</span><small>${escapeAdminHtml(driver.telefono || driver.phone || "Teléfono opcional pendiente")}</small></div><span class="admin-management-status is-driver-only">Chofer</span></div><div class="admin-management-actions admin-driver-only-actions"><button class="admin-management-reset" type="button" data-admin-reset-driver="${escapeAdminHtml(driver.id)}">RESETEAR DATOS</button><button class="admin-management-hard-delete" type="button" data-admin-hard-delete-driver="${escapeAdminHtml(driver.id)}">ELIMINAR CHOFER</button></div></article>`;
      }).join("");
      return `<section class="admin-management-toolbar admin-driver-only-toolbar"><div class="admin-management-toolbar-copy"><strong>Choferes</strong><small>Crear accesos, resetear datos operativos o eliminar choferes. Resetear conserva la cuenta y el vehículo.</small></div><button class="admin-management-add" type="button" data-admin-add-driver>CREAR CHOFER</button></section><section class="admin-management-list admin-driver-only-list">${rows || '<div class="admin-management-empty">No hay choferes activos.</div>'}</section>`;
    }

    async function refreshDriversManagement() {
      if (adminSharedState.mode !== "drivers-management") return;
      const content = $("adminSharedContent");
      if (!content) return;
      setAdminSharedLoading("Actualizando choferes…");
      try { content.innerHTML = await renderAdminDriversManagement(); $("adminSharedStatus").textContent = ""; }
      catch (error) { $("adminSharedStatus").textContent = "No se pudo actualizar la lista de choferes."; }
    }

    async function hardDeleteDriverFirebaseData(driverDocumentId, confirmation) {
      const session = assertVehicleAdmin("HARD_DELETE_DRIVER_DATA");
      const cleanId = String(driverDocumentId || "").trim();
      if (!cleanId) throw vehicleInternalError("HARD_DELETE_DRIVER_DATA", "DRIVER_REQUIRED", "Falta identificar al chofer.");
      const callable = httpsCallable(functions, "adminDeleteDriverCompletely", { timeout: 540000 });
      try {
        const response = await callable({ driverId: cleanId, confirmation:String(confirmation || "") });
        const result = response?.data || {};
        if (result.ok !== true) throw vehicleInternalError("HARD_DELETE_DRIVER_DATA", "HARD_DELETE_INCOMPLETE", "Firebase no confirmó la eliminación completa.");
        invalidateAdminWeeklyData("driver-hard-deleted");
        await refreshDriversManagement();
        return { ...result, deletedByUid:session.uid };
      } catch (error) {
        const message = String(error?.message || "");
        if (String(error?.code || "").includes("not-found") || message.includes("not found")) {
          throw vehicleInternalError("HARD_DELETE_DRIVER_DATA", "ADMIN_FUNCTION_NOT_DEPLOYED", "La función administrativa todavía no está desplegada en Firebase.", error);
        }
        throw error;
      }
    }

    async function resetDriverOperationalData(driverDocumentId, confirmation) {
      const session = assertVehicleAdmin("RESET_DRIVER_OPERATIONAL_DATA");
      const cleanId = String(driverDocumentId || "").trim();
      if (!cleanId) throw vehicleInternalError("RESET_DRIVER_OPERATIONAL_DATA", "DRIVER_REQUIRED", "Falta identificar al chofer.");
      const callable = httpsCallable(functions, "adminResetDriverOperationalData", { timeout: 540000 });
      try {
        const response = await callable({ driverId:cleanId, confirmation:String(confirmation || "") });
        const result = response?.data || {};
        if (result.ok !== true || result.accountPreserved !== true) throw vehicleInternalError("RESET_DRIVER_OPERATIONAL_DATA", "DRIVER_RESET_INCOMPLETE", "Firebase no confirmó el reseteo seguro del chofer.");
        invalidateAdminWeeklyData("driver-operational-reset");
        window.dispatchEvent(new CustomEvent("explora:driver-data-reset", { detail:{ driverUid:cleanId, result } }));
        await refreshDriversManagement();
        return { ...result, resetByUid:session.uid };
      } catch (error) {
        const message = String(error?.message || "");
        if (String(error?.code || "").includes("not-found") || message.includes("not found")) {
          throw vehicleInternalError("RESET_DRIVER_OPERATIONAL_DATA", "ADMIN_RESET_FUNCTION_NOT_DEPLOYED", "La función para resetear datos todavía no está desplegada en Firebase.", error);
        }
        throw error;
      }
    }

    async function softDeleteDriver(driverDocumentId) {
      const session = assertVehicleAdmin("DELETE_DRIVER");
      const cleanId = String(driverDocumentId || "").trim();
      try {
        const driverRef = doc(db, "choferes", cleanId);
        const preload = await getDoc(driverRef);
        if (!preload.exists()) throw vehicleInternalError("DELETE_DRIVER", "DRIVER_DELETE_FAILED", "El chofer no existe.");
        const driver = { id:preload.id, ...(preload.data() || {}) };
        const uid = adminDriverKey(driver);
        if (adminDriverRole(driver).includes("admin") || EXPLORA_ADMIN_UIDS.has(uid)) throw vehicleInternalError("DELETE_DRIVER", "DRIVER_DELETE_FAILED", "El usuario Admin no puede eliminarse.");
        const vehicleId = driverVehicleId(driver);
        await runTransaction(db, async transaction => {
          const driverSnap = await transaction.get(driverRef);
          const vehicleRef = vehicleId ? doc(db, "vehiculos", vehicleId) : null;
          const vehicleSnap = vehicleRef ? await transaction.get(vehicleRef) : null;
          if (!driverSnap.exists()) throw vehicleInternalError("SOFT_DELETE_DRIVER", "DRIVER_DELETE_FAILED", "El chofer no existe.");
          if (vehicleRef && vehicleSnap?.exists()) transaction.set(vehicleRef, { currentDriverUid:null, currentDriverDocumentId:null, currentDriverName:null, isAssigned:false, updatedAt:serverTimestamp(), updatedByUid:session.uid }, { merge:true });
          transaction.set(driverRef, { status:"deleted", isDeleted:true, deletedAt:serverTimestamp(), deletedByUid:session.uid, activo:false, active:false, ...emptyDriverVehiclePatch, updatedAt:serverTimestamp(), actualizado:serverTimestamp() }, { merge:true });
        });
        invalidateAdminWeeklyData("driver-deleted");
        await refreshDriversManagement();
        return true;
      } catch (error) {
        const internal = error?.internalCode ? error : vehicleInternalError("SOFT_DELETE_DRIVER", "DRIVER_SOFT_DELETE_FAILED", "No se pudo borrar el chofer.", error, { driverUid:cleanId });
        showVehicleDiagnostic("SOFT_DELETE_DRIVER", internal.internalCode || "DRIVER_SOFT_DELETE_FAILED", internal, { functionName:"softDeleteDriver", driverUid:cleanId, firestorePath:`choferes/${cleanId}`, queryUsed:"getDoc + runTransaction", documentsAffected:2 });
        throw internal;
      }
    }

    async function saveDriverVehicleAssignment(driverDocumentId) {
      const driver = adminManagementState.drivers.find(item => item.id === driverDocumentId);
      const select = document.querySelector(`[data-admin-driver-vehicle="${CSS.escape(driverDocumentId)}"]`);
      if (!driver || !select) return;
      const vehicleId = String(select.value || "").trim();
      const vehicle = adminManagementState.vehicles.find(item => item.id === vehicleId);
      let allowReassign = false;
      if (vehicle) {
        const assignment = vehicleAssignmentState(vehicle);
        const owns = adminDriverIdentities(driver).has(String(assignment.currentDriverUid || "").toLowerCase());
        if (assignment.assigned && !owns) {
          allowReassign = await openAdminManagementConfirm({ title:"REASIGNAR VEHÍCULO", message:`${vehicleSelectLabel(vehicle)} está asignado a ${vehicle.currentDriverName || "otro chofer"}.\n\nSe liberará del chofer actual y se asignará a ${getProfileName(driver)}.`, confirmLabel:"CONFIRMAR REASIGNACIÓN", tone:"gold" });
          if (!allowReassign) return;
        }
      }
      await assignVehicleToDriver({ driverDocumentId:driver.id, driverUid:adminDriverKey(driver) || driver.id, driverName:getProfileName(driver), vehicleId, allowReassign });
      invalidateAdminWeeklyData("driver-vehicle-updated");
      await refreshDriversManagement();
    }

    async function renderAdminSharedModule() {
      const content = $("adminSharedContent");
      const periodTabs = $("adminSharedPeriodTabs");
      const receiptTabs = $("adminSharedReceiptTabs");
      if (!content) return;
      const mode = adminSharedState.mode;
      document.body.classList.toggle("explora-admin-drivers-white", mode === "drivers-management");
      // v4036: los selectores Semana / Mes / Año y Pagos / Gastos se retiran visualmente.
      // Se conserva el estado interno para compatibilidad con módulos viejos, pero ya no se muestran tabs.
      if (periodTabs) periodTabs.hidden = true;
      if (receiptTabs) receiptTabs.hidden = true;
      const refreshButton = $("adminSharedRefreshBtn");
      if (refreshButton) refreshButton.hidden = mode === "drivers-management";
      document.querySelectorAll("[data-admin-period]").forEach(btn => btn.classList.toggle("is-active", btn.dataset.adminPeriod === adminSharedState.periodMode));
      document.querySelectorAll("[data-admin-receipt-tab]").forEach(btn => btn.classList.toggle("is-active", btn.dataset.adminReceiptTab === adminSharedState.receiptTab));
      setAdminSharedLoading("Cargando datos…");
      try {
        const needsOverview = !["drivers-management","car"].includes(mode);
        if (needsOverview && !adminSharedState.overview) adminSharedState.overview = await getAdminWeeklyOverview();
        let html = "";
        if (mode === "drivers-management") {
          setAdminSharedHeader("CHOFERES", "Crear, resetear datos o eliminar choferes.");
          html = await renderAdminDriversManagement();
        } else
        if (mode === "closures") {
          setAdminSharedHeader("CIERRES POR CHOFER", "Consulta el resultado semanal y los comprobantes.");
          html = renderAdminClosures(adminSharedState.overview);
        } else if (mode === "closure-detail") {
          setAdminSharedHeader("CIERRE SEMANAL", "Detalle financiero del chofer.");
          html = renderAdminClosureDetail(adminSelectedItem(adminSharedState.selectedDriverKey));
        } else if (mode === "collaboration") {
          setAdminSharedHeader("APORTE AL BONO", "Ingreso operativo semanal de Explora y bono del líder.");
          html = renderAdminCollaboration(adminSharedState.overview);
        } else if (mode === "derivations") {
          setAdminSharedHeader("DERIVACIONES", "Auditar derivaciones de la semana activa sin mostrar rankings.");
          html = renderAdminDerivationsAudit(adminSharedState.overview);
        } else if (mode === "percentages") {
          setAdminSharedHeader("REGLAS FIJAS", "La participación base permanece siempre en 50/50.");
          const values=adminSharedState.fixedFinancialRules||await loadAdminPerformancePercentages();
          html = renderAdminPercentages(values);
        } else if (mode === "billing") {
          setAdminSharedHeader("FACTURASTE POR CHOFER", "Servicios reales agrupados por período.");
          html = await renderAdminBillingOrExpenses("services", adminSharedState.periodMode);
        } else if (mode === "expenses") {
          setAdminSharedHeader("GASTASTE POR CHOFER", "Gastos y comprobantes agrupados por período.");
          html = await renderAdminBillingOrExpenses("expenses", adminSharedState.periodMode);
        } else if (mode === "receipts") {
          setAdminSharedHeader("COMPROBANTES", "Pagos semanales y gastos por chofer.");
          html = await renderAdminReceipts();
        } else if (mode === "loan") {
          setAdminSharedHeader("PRÉSTAMO OPERATIVO", "Adelantos compartidos 50 % Chofer y 50 % Admin.");
          html = renderOperationalLoanModule(adminSharedState.overview);
        } else if (mode === "car") {
          setAdminSharedHeader("MI AUTO", "Editar vehículo y documentación del chofer seleccionado.");
          html = `<section class="admin-mi-auto-mount" id="adminMiAutoMount"><div class="vehicle-detail-status">Cargando editor de Mi auto…</div></section>`;
        }
        content.innerHTML = html;
        if (mode === "car") {
          const mount = document.getElementById("adminMiAutoMount");
          if (!window.ExploraVehicleDashboard?.mountAdminEditor) throw new Error("MI_AUTO_EDITOR_NOT_READY");
          await window.ExploraVehicleDashboard.mountAdminEditor(mount);
        }
        $("adminSharedStatus").textContent = "";
        if(mode === "loan" && operationalLoanDiagnosticState) renderOperationalLoanDiagnostic(operationalLoanDiagnosticState);
      } catch (error) {
        console.warn("[EXPLORA admin] module", error?.code || error?.message);
        $("adminSharedStatus").textContent = "No se pudieron cargar los datos. Revisa el diagnóstico visible.";
        $("adminSharedStatus").className = "admin-shared-status is-error";
        content.innerHTML = `<div class="admin-shared-empty">No se pudieron cargar los datos administrativos.</div>`;
        const code=mode==="derivations"?"ADMIN_DERIVATIONS_BUTTON_FAILED":mode==="percentages"?"ADMIN_PERCENT_CONFIG_FAILED":"ADMIN_VISUAL_UNIFICATION_FAILED";
        showAdminUiDiagnostic("OPEN_ADMIN_MODULE",code,error,{functionName:"renderAdminSharedModule",firestorePath:"colecciones administrativas",queryUsed:`modo ${mode}`});
      }
    }

    function openAdminSharedModule(mode) {
      if (!document.body.classList.contains("explora-shared-admin")) return;
      adminSharedState.previousMode = adminSharedState.mode;
      adminSharedState.mode = mode;
      if (mode === "loan") {
        window.ExploraReceiptEngine?.resetUploadState?.("operationalLoan");
        const loanInput = document.getElementById("operationalLoanReceiptInput");
        if (loanInput) loanInput.value = "";
      }
      adminSharedState.previousScrollY = window.scrollY || 0;
      const screen = $("adminSharedScreen");
      screen.classList.add("is-open");
      screen.setAttribute("aria-hidden", "false");
      screen.scrollTop = 0;
      window.lockPageScroll?.("admin-shared");
      renderAdminSharedModule();
    }

    function closeAdminSharedModule() {
      const screen = $("adminSharedScreen");
      if (!screen) return;
      screen.classList.remove("is-open");
      screen.setAttribute("aria-hidden", "true");
      window.unlockPageScroll?.("admin-shared");
      window.unlockPageScroll?.("admin-debt");
      document.body.classList.remove("explora-admin-drivers-white", "explora-admin-debts-white");
      adminSharedState.mode = "home";
      adminSharedState.selectedDriverKey = "";
      clearAdminReceiptSelection();
      if (document.body.classList.contains("explora-shared-admin")) window.ExploraMainNav?.setActive("inicio");
      window.scrollTo(0, adminSharedState.previousScrollY || 0);
    }

    function openAdminReceiptViewer(url, mime = "", title = "Comprobante", meta = "") { window.ExploraReceiptEngine?.openReceiptViewer?.({ receiptUrl:url, receiptMimeType:mime, title, subtitle:meta }); }

    function closeAdminReceiptViewer() { window.ExploraReceiptEngine?.closeReceiptViewer?.(); }

    function clearAdminReceiptSelection({ clearInput = true } = {}) {
      adminSharedState.receiptFile = null;
      window.ExploraReceiptEngine?.resetUploadState?.("weeklyClosureAdmin");
      if (clearInput) {
        const persistentInput = document.getElementById("weeklyAdminReceiptInput");
        if (persistentInput) persistentInput.value = "";
      }
      if (adminSharedState.receiptPreviewUrl) URL.revokeObjectURL(adminSharedState.receiptPreviewUrl);
      adminSharedState.receiptPreviewUrl = "";
      window.ExploraReceiptUI?.clear?.({previewId:"adminDavidReceiptPreview",thumbId:"adminDavidReceiptPreviewThumb",nameId:"adminDavidReceiptPreviewName",metaId:"adminDavidReceiptPreviewMeta"});
    }

    async function submitAdminWeeklyReceipt(item, file, onProgress) {
      await assertCurrentAdminAccess();
      if(!item?.closureInfo?.exists || item.closureInfo.direction !== "david_a_chofer") throw new Error("ADMIN_RECEIPT_NOT_ALLOWED");
      if(!(file instanceof File)) throw new Error("RECEIPT_REQUIRED");
      const periodId=item.closureInfo.weeklyPeriodId||adminSharedState.overview.weeklyPeriodId;
      const canonical=window.ExploraCanonicalWeeklyClosure;
      if(!canonical?.materializeWeeklyClosure) throw new Error("CLOSURE_ENGINE_UNAVAILABLE");
      const closureResult=await canonical.materializeWeeklyClosure(item.uid,periodId,{createdByOperationId:`admin_receipt_${item.uid}_${periodId}`});
      if(closureResult?.localOnly) throw new Error("CLOSURE_OFFLINE_PENDING");
      const closureId=closureResult.closureId;
      const closureCollection=closureResult.collection||canonical.closureCollectionName?.()||"cierres_semanales";
      await canonical.markProofUploading?.(closureId);
      let uploaded;
      try {
        uploaded=await window.motorCargaComprobanteGasto({
        file,
        context:"weeklyClosureAdmin",
        ownerUid:item.uid,
        driverUid:item.uid,
        recordId:closureId,
        weeklyPeriodId:periodId,
        destinationPath:`${window.ExploraCanonicalWeeklyClosure?.storageBasePath?.()||"cierres_semanales"}/${periodId}/${item.uid}/${closureId}/comprobante.{extension}`,
        allowPdf:false,
        uploadedByUid:auth.currentUser.uid,
        uploadedByRole:"admin",
        category:"weekly_closure",
        metadata:{ type:"weekly_closure", receiptCategory:"cierre", closureWeek:periodId, closureYear:Number(String(periodId||"").slice(0,4))||new Date().getFullYear(), payerRole:"admin", payeeRole:"driver", settlementAmount:Number(item.closureInfo.amount||0) },
        onStage:()=>{}
        });
      } catch (error) {
        await window.ExploraCanonicalWeeklyClosure?.markProofError?.(closureId,error).catch?.(()=>{});
        throw error;
      }
      const closureYear=Number(String(periodId||"").slice(0,4))||new Date().getFullYear();
      const driverName=String(item.profile?.nombre||item.profile?.name||item.name||item.driverName||"Chofer");
      const resultLabel=`David debe pagarte ${adminMoney(item.closureInfo.amount||0)}`;
      const payload={
        type:"weekly_closure", category:"weekly_closure", categoryLabel:"CIERRE SEMANAL",
        closureId, weeklyPeriodId:periodId, driverUid:item.uid, driverName,
        closureWeek:periodId,
        closureYear,
        receiptCategory:"cierre",
        uploadedByUid:auth.currentUser.uid, uploadedByRole:"admin",
        receiptUrl:uploaded.receiptUrl, receiptPath:uploaded.receiptPath, receiptMimeType:uploaded.receiptMimeType, receiptFileName:uploaded.receiptFileName, receiptSize:uploaded.receiptSize,
        receiptUploadedAt:uploaded.receiptUploadedAt, receiptStatus:"uploaded", payerRole:"admin", payeeRole:"driver", settlementAmount:Number(item.closureInfo.amount||0), resultLabel,
        adminReceiptUrl:uploaded.receiptUrl,
        adminReceiptPath:uploaded.receiptPath,
        adminReceiptMimeType:uploaded.receiptMimeType,
        adminReceiptFileName:uploaded.receiptFileName,
        adminReceiptSize:uploaded.receiptSize,
        adminReceiptUploadedAt:uploaded.receiptUploadedAt,
        adminReceiptUploadedByUid:auth.currentUser.uid,
        adminReceiptUploadedByRole:"admin",
        adminReceiptStatus:"uploaded",
        adminPaymentCompleted:true,
        adminPaymentCompletedAt:serverTimestamp(),
        proofUploadedAt:serverTimestamp(),
        isResolved:true,
        paid:true,
        pagado:true,
        paymentStatus:"paid",
        closureStatus:"paid",
        status:"paid",
        driverAcknowledged:true,
        driverAcknowledgedAt:serverTimestamp(),
        driverAcknowledgedBy:"admin_payment",
        driverAcknowledgedPeriodId:periodId,
        acknowledgementStatus:"confirmed_by_admin_payment",
        statusSchemaVersion:255,
        actualizadoEn:serverTimestamp(),
        updatedAt:serverTimestamp()
      };
      try {
        const batch=writeBatch(db);
        batch.set(doc(db,closureCollection,closureId),payload,{merge:true});
        const indexPayload=window.ExploraReceiptEngine.buildReceiptIndexPayload({category:"weekly_closure",recordId:closureId,suffix:"admin",driverUid:item.uid,ownerUid:item.uid,uploadedByUid:auth.currentUser.uid,uploadedByRole:"admin",weeklyPeriodId:periodId,amount:Number(item.closureInfo.amount||0),receipt:uploaded,status:"uploaded"});Object.assign(indexPayload,{type:"weekly_closure",categoryLabel:"CIERRE SEMANAL",closureId,weeklyPeriodId:periodId,driverUid:item.uid,driverName,closureWeek:periodId,closureYear,receiptCategory:"cierre",payerRole:"admin",payeeRole:"driver",settlementAmount:Number(item.closureInfo.amount||0),resultLabel,detail:`Semana ${periodId} · Subido por David · ${resultLabel}`,updatedAt:serverTimestamp()});
        batch.set(doc(db,window.ExploraCanonicalWeeklyClosure?.receiptIndexCollectionName?.()||"receipt_index",indexPayload.receiptId),indexPayload,{merge:false});
        await batch.commit();
      } catch(error) {
        window.ExploraReceiptEngine?.deleteUploadedFile?.(uploaded.receiptPath).catch(()=>{});
        throw error;
      }
      window.ExploraReceiptEngine.resetUploadState("weeklyClosureAdmin");
      window.invalidateReceiptCache?.("cierres");
      window.invalidateWeeklyFinancialEngine?.("weekly-receipt-uploaded");
      return uploaded;
    }

    function invalidateAdminWeeklyData(reason = "changed", uid = "", weeklyPeriodId = "") {
      if (uid && weeklyPeriodId) {
        adminWeeklySnapshotCache.delete(adminCacheKey(uid, weeklyPeriodId));
        adminClosureCache.delete(adminCacheKey(uid, weeklyPeriodId));
      } else {
        adminWeeklySnapshotCache.clear();
        adminClosureCache.clear();
      }
      adminWeeklySnapshotCache.delete(`overview_${weeklyPeriodId || getActiveWeeklyPeriod().id}`);
      adminSharedState.overview = null;
      console.info("[EXPLORA admin] invalidate", reason);
    }

    function clearAdminSharedData() {
      adminDriverProfileCache.clear();
      adminWeeklySnapshotCache.clear();
      adminClosureCache.clear();
      adminSharedState.overview = null;
      adminSharedState.mode = "home";
      adminSharedState.periodMode = "week";
      adminSharedState.receiptTab = "payments";
      clearAdminReceiptSelection();
    }

    window.ExploraAdminShared = {
      open:openAdminSharedModule,
      close:closeAdminSharedModule,
      invalidate: () => { invalidateAdminWeeklyData("derivation-update"); adminSharedState.overview=null; },
      refresh:async () => {
        if (adminSharedState.mode === "drivers-management") { await refreshDriversManagement(); return; }
        invalidateAdminWeeklyData("manual-refresh");
        adminSharedState.overview = await getAdminWeeklyOverview("", { force:true });
        renderAdminStatusCard(adminSharedState.overview);
        renderAdminDashboardMetrics(adminSharedState.overview);
        if ($("adminSharedScreen")?.classList.contains("is-open")) await renderAdminSharedModule();
      },
      async openClosure(uid, weeklyPeriodId = "") {
        window.ExploraReceipts?.close?.();
        if (weeklyPeriodId) adminSharedState.overview = await getAdminWeeklyOverview(weeklyPeriodId, { force:true });
        else if (!adminSharedState.overview) adminSharedState.overview = await getAdminWeeklyOverview();
        adminSharedState.selectedDriverKey = String(uid || "");
        openAdminSharedModule("closure-detail");
      },
      openSection(section) {
        if (section === "inicio") { closeAdminSharedModule(); window.scrollTo({top:0,behavior:"smooth"}); return; }
        if (section === "operaciones") { closeAdminSharedModule(); document.querySelector(".operations-real")?.scrollIntoView({behavior:"smooth",block:"start"}); return; }
        if (section === "finanzas") { closeAdminSharedModule(); document.querySelector(".finance-real")?.scrollIntoView({behavior:"smooth",block:"start"}); return; }
        if (section === "comprobantes") { window.ExploraReceipts?.open?.(); return; }
        if (section === "lanzar") { closeAdminSharedModule(); window.ExploraAdminTools?.openLaunch?.(); }
      }
    };

    $("adminUiDiagnosticClose")?.addEventListener("click",closeAdminUiDiagnostic);
    $("adminUiDiagnosticCloseBottom")?.addEventListener("click",closeAdminUiDiagnostic);
    $("adminUiDiagnosticCopy")?.addEventListener("click",copyAdminUiDiagnostic);
    $("adminUiDiagnosticBackdrop")?.addEventListener("click",event=>{if(event.target?.id==="adminUiDiagnosticBackdrop")closeAdminUiDiagnostic();});

    async function openAdminCreateDriverModal() {
      try { assertVehicleAdmin("OPEN_DRIVERS_MENU"); } catch (_) { return; }
      const modal = $("adminCreateDriverModal");
      if (!modal) return;
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
      window.lockPageScroll?.("admin-create-driver");
      adminMsg("");
      try {
        const vehicles = await loadAdminVehicles();
        adminManagementState.vehicles = vehicles;
        fillAdminVehicleSelect(vehicles);
      } catch (error) {
        showVehicleDiagnostic("LOAD_VEHICLE_SELECT", "VEHICLE_READ_FAILED", error, { functionName:"openAdminCreateDriverModal", firestorePath:"vehiculos", queryUsed:"getDocs" });
      }
      requestAnimationFrame(() => $("newDriverName")?.focus({ preventScroll:true }));
    }

    function closeAdminCreateDriverModal() {
      const modal = $("adminCreateDriverModal");
      if (!modal) return;
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      window.unlockPageScroll?.("admin-create-driver");
      adminMsg("");
    }

    function validDriverEmail(value = "") { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(value || "").trim()); }
    function validDriverUsername(value = "") { return /^[a-z0-9._-]{3,32}$/.test(normalizeUsername(value)); }
    function validDriverPassword(value = "") { return String(value || "").length >= 6; }

    async function submitCreateDriver(event) {
      event.preventDefault();
      const btn = $("adminCreateSubmitBtn");
      const nombre = normalizeVehicleModel($("newDriverName")?.value || "");
      const username = normalizeUsername($("newDriverUsername")?.value || "");
      const password = String($("newDriverPassword")?.value || "");
      const emailInput = String($("newDriverEmail")?.value || "").trim().toLowerCase();
      const email = emailInput || legacyEmailFromLogin(username);
      const phone = String($("newDriverPhone")?.value || "").trim().replace(/\s+/g, " ");
      const cuit = String($("newDriverCuit")?.value || "").trim().replace(/[^0-9-]/g, "");
      const alias = String($("newDriverAlias")?.value || "").trim().toLowerCase();
      const role = "chofer";
      const vehicleId = "";
      let stage = "VALIDATE_DRIVER_FORM";
      try {
        assertVehicleAdmin("OPEN_DRIVERS_MENU");
        if (!nombre) throw vehicleInternalError(stage, "DRIVER_REQUIRED_NAME", "El nombre es obligatorio.");
        if (!validDriverUsername(username)) throw vehicleInternalError(stage, "DRIVER_REQUIRED_USERNAME", "El ID debe tener entre 3 y 32 caracteres: letras minúsculas, números, punto, guion o guion bajo.");
        if (!validDriverPassword(password)) throw vehicleInternalError(stage, "DRIVER_REQUIRED_PASSWORD", "La contraseña debe tener al menos 6 caracteres.");
        if (!validDriverEmail(email)) throw vehicleInternalError(stage, "DRIVER_REQUIRED_EMAIL", "Ingresá un email válido.");
        let allowReassign = false;
        if (vehicleId) {
          const vehicle = (await loadAdminVehicles()).find(item => item.id === vehicleId);
          const assignment = vehicleAssignmentState(vehicle || {});
          if (assignment.assigned) {
            allowReassign = await openAdminManagementConfirm({ title:"REASIGNAR VEHÍCULO", message:`${vehicleSelectLabel(vehicle)} está asignado a ${vehicle.currentDriverName || "otro chofer"}.\n\nSe liberará del chofer actual y se asignará a ${nombre}.`, confirmLabel:"CONFIRMAR REASIGNACIÓN", tone:"gold" });
            if (!allowReassign) { adminMsg("Asignación cancelada."); return; }
          }
        }
        if (btn) { btn.disabled = true; btn.textContent = "CREANDO…"; btn.setAttribute("aria-busy", "true"); }
        stage = "CREATE_DRIVER_BACKEND";
        adminMsg("Creando usuario, perfil y acceso de forma segura…");
        const callable = httpsCallable(functions, "adminCreateDriver", { timeout: 120000 });
        const response = await callable({ nombre, username, password, email, phone, cuit, alias, role, vehicleId, allowReassign });
        const result = response?.data || {};
        if (result.ok !== true || !result.uid) throw vehicleInternalError(stage, "DRIVER_CREATE_INCOMPLETE", "Firebase no confirmó la creación completa del chofer.");
        adminMsg("Chofer creado correctamente.", "ok");
        ["newDriverName","newDriverUsername","newDriverPassword","newDriverEmail","newDriverPhone","newDriverCuit","newDriverAlias"].forEach(id => { const element = $(id); if (element) element.value = ""; });
        invalidateAdminWeeklyData("driver-created");
        await refreshDriversManagement();
        window.showExploraSuccess?.({ title:"CHOFER CREADO", message:`${nombre} ya puede ingresar con su ID y contraseña.`, onAccept:async()=>{ closeAdminCreateDriverModal(); if(adminSharedState.mode!=="drivers-management") openAdminSharedModule("drivers-management"); else await refreshDriversManagement(); } });
      } catch (error) {
        const code = error?.internalCode || error?.code || "DRIVER_SAVE_FAILED";
        const internal = error?.internalCode ? error : vehicleInternalError(stage, "DRIVER_SAVE_FAILED", error?.message || "No se pudo crear el chofer.", error);
        adminMsg(internal.message || "No se pudo crear el chofer.", "err");
        showVehicleDiagnostic(stage, code, internal, { functionName:"adminCreateDriver", driverEmail:email, driverName:nombre, vehicleId, firestorePath:"Cloud Function adminCreateDriver", queryUsed:"Firebase Admin SDK transaction" });
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "CREAR CHOFER"; btn.removeAttribute("aria-busy"); }
      }
    }

    let sessionRecoveryRetryTimer = null;
    let sessionRecoveryRetryCount = 0;

    function clearSessionRecoveryRetry() {
      if (sessionRecoveryRetryTimer) clearTimeout(sessionRecoveryRetryTimer);
      sessionRecoveryRetryTimer = null;
      sessionRecoveryRetryCount = 0;
    }

    function scheduleSessionProfileRecovery(user, error) {
      if (!user?.uid || authSessionState.logoutInProgress) return;
      if (auth.currentUser?.uid && auth.currentUser.uid !== user.uid) return;
      if (sessionRecoveryRetryTimer) return;
      authSessionState.authenticatedUser = user;
      exploraSession.authUser = user;
      exploraSession.authReady = true;
      const cachedShellOpened = authSessionState.uiOpened;
      if (!cachedShellOpened) {
        beginSplashSync("Reintentando sincronizar tu perfil. No abrimos el menú hasta tener datos actuales.");
        setBodyMode("explora-auth-checking");
      }
      const delayMs = Math.min(15000, 1800 + (sessionRecoveryRetryCount * 1700));
      sessionRecoveryRetryCount += 1;
      loginDevDiagnostic("SESSION_PROFILE_RECOVERY_SCHEDULED", {
        attempt: sessionRecoveryRetryCount,
        delayMs,
        cachedShellOpened,
        code: error && (error.message || error.code) || "unknown"
      });
      sessionRecoveryRetryTimer = setTimeout(async () => {
        sessionRecoveryRetryTimer = null;
        if (!auth.currentUser?.uid || auth.currentUser.uid !== user.uid || authSessionState.logoutInProgress) return;
        try {
          await openAuthenticatedExploraSession(user, { preserveOpenUI: authSessionState.uiOpened });
          clearSessionRecoveryRetry();
        } catch (retryError) {
          if (isCriticalAccessError(retryError)) {
            resetCurrentSessionUI();
            await signOut(auth).catch(() => {});
            showLogin(legacyAccessErrorMessage(retryError), "SESSION_RECOVERY_CRITICAL");
            return;
          }
          scheduleSessionProfileRecovery(user, retryError);
        }
      }, delayMs);
    }

    async function handleAuthStateChanged(user) {
      authHandledOnce = true;
      loginDevDiagnostic("AUTH_STATE_USER", { hasUser: Boolean(user) });

      if (authSessionState.loginInProgress || loginInProgress) {
        exploraSession.authReady = true;
        return;
      }

      if (!user) {
        clearSessionRecoveryRetry();
        authSessionState.authenticatedUser = null;
        authSessionState.profile = null;
        authSessionState.role = null;
        authSessionState.uiOpened = false;
        resetCurrentSessionUI();
        exploraSession.authReady = true;
        authSessionState.bootCompleted = true;
        if (!authSessionState.logoutInProgress) showLogin("", "AUTH_NULL_CONFIRMED");
        finishSplash();
        return;
      }

      if (
        authSessionState.authenticatedUser?.uid === user.uid &&
        authSessionState.uiOpened &&
        !authSessionState.profileLoading
      ) {
        exploraSession.authReady = true;
        authSessionState.bootCompleted = true;
        finishSplash();
        return;
      }

      // EXPLORA v4122: en una sesión persistente nunca se abre un dashboard parcial.
      // Si la interfaz ya estaba viva en memoria puede conservarse; en un arranque nuevo
      // se bloquea la primera pintura con el splash hasta terminar la sincronización real.
      const preserveCurrentUI = Boolean(
        authSessionState.bootCompleted &&
        authSessionState.uiOpened &&
        authSessionState.authenticatedUser?.uid === user.uid
      );
      if (!preserveCurrentUI) {
        setBodyMode("explora-auth-checking");
        beginSplashSync("Restaurando sesión y cargando toda la información…");
      }

      let keepSyncVisible = false;
      try {
        await openAuthenticatedExploraSession(user, {
          preserveOpenUI: preserveCurrentUI
        });
        clearSessionRecoveryRetry();
        authSessionState.authenticatedUser = user;
      } catch (error) {
        console.warn("[EXPLORA legacy] ACCESS_ERROR", error);
        loginDevDiagnostic("ACCESS_ERROR", { code: error && (error.message || error.code) || "unknown" });
        if (isCriticalAccessError(error) || !isRecoverableSessionError(error)) {
          resetCurrentSessionUI();
          await signOut(auth).catch(() => {});
          showLogin(legacyAccessErrorMessage(error), "SESSION_RESTORE_CRITICAL");
        } else {
          // Ante una falla temporal se conserva solamente una interfaz que ya
          // estaba abierta. En arranque frío permanece el loader; nunca se muestra
          // información persistida de una ejecución anterior.
          const fallbackOpened = Boolean(authSessionState.uiOpened);
          keepSyncVisible = !fallbackOpened;
          scheduleSessionProfileRecovery(user, error);
        }
      } finally {
        loginDevDiagnostic("PROFILE_LOAD_FINALLY", {});
        exploraSession.authReady = true;
        authSessionState.bootCompleted = true;
        if (!keepSyncVisible) finishSplash();
      }
    }

    let unsubscribeAuth = null;
    let authObserverStarted = false;

    async function startPersistentAuthObserver() {
      if (authObserverStarted) return;
      await persistenceReadyPromise;
      authObserverStarted = true;
      unsubscribeAuth = onAuthStateChanged(auth, handleAuthStateChanged);

      // Protección extrema para navegadores WebKit que no entreguen el primer
      // callback: se procesa una sola vez el estado ya resuelto, sin recargar la página.
      setTimeout(() => {
        if (!authHandledOnce && !authSessionState.logoutInProgress) {
          loginDevDiagnostic("AUTH_INITIAL_CALLBACK_FALLBACK", { hasUser: Boolean(auth.currentUser) });
          handleAuthStateChanged(auth.currentUser).catch((error) => {
            console.warn("[EXPLORA login] initial auth fallback", error?.code || error?.message || error);
          });
        }
      }, Math.min(AUTH_RESTORE_GRACE_MS, 2500));
    }

    startPersistentAuthObserver().catch((error) => {
      console.warn("[EXPLORA login] observer:start", error?.code || error?.message || error);
      showLogin("No se pudo restaurar la sesión. Intentá ingresar nuevamente.", "AUTH_OBSERVER_START_FAILED");
    });


    let loginInProgress = false;
    let activeSessionOpenPromise = null;
    let activeSessionUid = "";
    const authSessionState = {
      bootCompleted: false,
      loginInProgress: false,
      profileLoading: false,
      authenticatedUser: null,
      profile: null,
      profileDocumentId: "",
      profileCollection: "",
      role: null,
      uiOpened: false,
      logoutInProgress: false
    };
    window.ExploraDataSyncGate = Object.freeze({
      begin(detail = "Actualizando información antes de continuar…") {
        const user = auth.currentUser || authSessionState.authenticatedUser;
        if (!user?.uid || !authSessionState.uiOpened || authSessionState.logoutInProgress) return false;
        beginSplashSync(detail);
        return true;
      },
      update(progress, detail = "Actualizando información…") {
        updateSplashSync(progress, detail);
      },
      finish() {
        return finishSplashSync();
      },
      isActive() {
        return Boolean(splashSyncState.active && !splashHidden);
      }
    });

    const LOGIN_ALIAS_COLLECTION = "login_aliases";
    const LOGIN_ALIAS_EMAIL_FIELDS = ["authEmail", "email", "correo", "firebaseEmail"];
    const LOGIN_ALIAS_UID_FIELDS = ["uid", "authUid", "firebaseUid", "userId"];

    function normalizeUsername(value) {
      const normalized = String(value || "").trim().toLowerCase();
      if (!normalized || normalized.includes("/") || normalized.includes("\\") || /\s/.test(normalized)) return "";
      return normalized;
    }

    function maskAliasDebugValue(value) {
      const text = String(value || "");
      if (!text) return "";
      return text.length <= 2 ? "**" : `${text.slice(0, 1)}***${text.slice(-1)}`;
    }

    function loginDevDiagnostic(step, data = {}) {
      const safeData = {};
      Object.entries(data || {}).forEach(([key, value]) => {
        if (key.toLowerCase().includes("password") || key.toLowerCase().includes("token")) return;
        if (key.toLowerCase().includes("email") || key.toLowerCase().includes("correo")) {
          safeData[key] = Boolean(value);
          return;
        }
        if (key.toLowerCase().includes("uid")) {
          safeData[key] = value ? "present" : "";
          return;
        }
        safeData[key] = value;
      });
      try {
        console.info("[EXPLORA login]", step, safeData);
      } catch (_) {}
    }

    function getAliasEmail(aliasData = {}) {
      for (const field of LOGIN_ALIAS_EMAIL_FIELDS) {
        const value = String(aliasData[field] || "").trim().toLowerCase();
        if (value && value.includes("@")) return value;
      }
      return "";
    }

    function getAliasExpectedUid(aliasData = {}) {
      for (const field of LOGIN_ALIAS_UID_FIELDS) {
        const value = String(aliasData[field] || "").trim();
        if (value) return value;
      }
      return "";
    }

    function getAliasRole(aliasData = {}) {
      return String(aliasData.rol || aliasData.role || aliasData.tipo || "").trim().toLowerCase();
    }

    function isAliasInactive(aliasData = {}) {
      return aliasData.activo === false || aliasData.active === false || aliasData.estado === "inactivo" || aliasData.disabled === true;
    }

    async function resolveLoginAlias(usernameInput) {
      const username = normalizeUsername(usernameInput);
      if (!username) throw new Error("ALIAS_INVALID");

      const aliasRef = doc(db, LOGIN_ALIAS_COLLECTION, username);
      loginDevDiagnostic("alias:get:start", { alias: maskAliasDebugValue(username) });

      let aliasSnap;
      try {
        aliasSnap = await getDoc(aliasRef);
      } catch (error) {
        loginDevDiagnostic("alias:get:error", {
          alias: maskAliasDebugValue(username),
          code: error && error.code ? error.code : "unknown"
        });
        if (error && error.code === "permission-denied") throw new Error("ALIAS_PERMISSION_DENIED");
        if (!navigator.onLine) throw new Error("NETWORK_ERROR");
        throw new Error("ALIAS_READ_FAILED");
      }

      const exists = Boolean(aliasSnap && aliasSnap.exists());
      loginDevDiagnostic("alias:get:result", { alias: maskAliasDebugValue(username), exists });

      if (!exists) {
        loginDevDiagnostic("alias:missing", { expectedPath: `${LOGIN_ALIAS_COLLECTION}/${username}` });
        throw new Error("ALIAS_NOT_FOUND");
      }

      const data = aliasSnap.data() || {};
      const email = getAliasEmail(data);
      const expectedUid = getAliasExpectedUid(data);
      const role = getAliasRole(data);
      const active = !isAliasInactive(data);

      loginDevDiagnostic("alias:validate", {
        alias: maskAliasDebugValue(username),
        collection: LOGIN_ALIAS_COLLECTION,
        docIdMatchesUsername: true,
        hasAuthEmail: Boolean(data.authEmail),
        hasCompatibleEmail: Boolean(email),
        hasUid: Boolean(expectedUid),
        role: role || "not-set",
        active
      });

      if (!active) throw new Error("ACCOUNT_DISABLED");
      if (role && !["chofer", "driver", "admin", "administrador", "owner"].includes(role)) throw new Error("ROLE_INVALID");
      if (!email) throw new Error("ALIAS_EMAIL_MISSING");

      return { username, email, expectedUid, role, active, profileId: getAliasProfileId(data), driverId: data.driverId || data.choferId || "", choferId: data.choferId || "" };
    }

    function withTimeout(promise, milliseconds, errorCode) {
      let timer;
      return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(errorCode || "LOGIN_TIMEOUT")), milliseconds);
        })
      ]);
    }

    function mapLoginErrorMessage(error) {
      const code = String((error && (error.message || error.code)) || "");
      if (code === "ACCOUNT_DISABLED" || code.includes("user-disabled")) return "Tu cuenta está desactivada. Contacta al administrador.";
      if (code === "NETWORK_ERROR" || code.includes("network") || !navigator.onLine) return "No hay conexión. Revisa Internet e inténtalo nuevamente.";
      if (code === "LOGIN_TIMEOUT" || code === "ALIAS_TIMEOUT" || code === "AUTH_TIMEOUT" || code === "PROFILE_TIMEOUT" || code === "VEHICLE_TIMEOUT") return "El acceso está demorando demasiado. Revisa tu conexión e inténtalo nuevamente.";
      if (code === "ALIAS_PERMISSION_DENIED" || code === "ALIAS_EMAIL_MISSING" || code === "ALIAS_READ_FAILED" || code.includes("permission-denied")) return "No se pudo completar el acceso. Contacta al administrador.";
      if (code === "PROFILE_NOT_FOUND" || code === "PROFILE_QUERY_NOT_FOUND" || code === "SESSION_OPEN_FAILED") return "No se encontró un perfil válido para esta cuenta.";
      if (code === "AUTH_INVALID_CREDENTIAL" || code.includes("invalid-credential") || code.includes("wrong-password")) return "No se pudo ingresar. Verifica tu usuario y contraseña.";
      if (code === "ROLE_INVALID") return "La cuenta no tiene un rol válido.";
      if (code === "UID_MISMATCH") return "No se pudo completar el acceso. Contacta al administrador.";
      return "No se pudo ingresar. Verifica tu usuario y contraseña.";
    }

    function showLoginErrorForCode(error) {
      return loginMsg(mapLoginErrorMessage(error));
    }

    function setLoginLoading(isLoading) {
      const btn = $("exploraLoginSubmit");
      const form = $("exploraLoginForm");
      const toggle = $("exploraPasswordToggle");
      loginInProgress = Boolean(isLoading);
      authSessionState.loginInProgress = Boolean(isLoading);
      if (btn) {
        btn.disabled = Boolean(isLoading);
        btn.textContent = isLoading ? "Ingresando…" : "Ingresar";
        if (isLoading) btn.setAttribute("aria-busy", "true");
        else btn.removeAttribute("aria-busy");
      }
      if (form) form.style.pointerEvents = isLoading ? "none" : "";
      if (toggle) toggle.disabled = Boolean(isLoading);
      document.documentElement.classList.toggle("auth-loading", Boolean(isLoading));
      document.body.classList.toggle("auth-loading", Boolean(isLoading));
    }

    function resetLoginState() {
      setLoginLoading(false);
    }

    function hardenManualAccessFields() {
      const stamp = Date.now().toString(36);
      const fields = [
        { el: $("exploraLoginAccessId"), name: "explora_id_manual_" + stamp, mask: false },
        { el: $("exploraLoginKey"), name: "explora_key_manual_" + stamp, mask: true },
        { el: $("newDriverPassword"), name: "explora_new_key_manual_" + stamp, mask: true }
      ];
      const card = $("exploraLoginForm");
      if (card) {
        card.setAttribute("autocomplete", "off");
        card.setAttribute("data-form-type", "other");
      }
      fields.forEach(({ el, name, mask }) => {
        if (!el) return;
        try {
          el.setAttribute("type", "text");
          el.setAttribute("autocomplete", "off");
          el.setAttribute("autocorrect", "off");
          el.setAttribute("autocapitalize", "none");
          el.setAttribute("spellcheck", "false");
          el.setAttribute("data-lpignore", "true");
          el.setAttribute("data-1p-ignore", "true");
          el.setAttribute("data-bwignore", "true");
          el.setAttribute("data-form-type", "other");
          el.setAttribute("aria-autocomplete", "none");
          if (!el.dataset.exploraManualName) el.dataset.exploraManualName = name;
          el.setAttribute("name", el.dataset.exploraManualName);
          if (mask) el.classList.add("explora-password-masked");
        } catch (_) {}
      });
    }

    hardenManualAccessFields();
    ["focusin", "pointerdown", "touchstart"].forEach((eventName) => {
      document.addEventListener(eventName, (event) => {
        if (event?.target?.id === "exploraLoginAccessId" || event?.target?.id === "exploraLoginKey" || event?.target?.id === "newDriverPassword") {
          hardenManualAccessFields();
        }
      }, { passive: true });
    });
    window.addEventListener("pageshow", hardenManualAccessFields);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) hardenManualAccessFields(); });

    async function loginWithUsernameAndPassword(username, password) {
      loginDevDiagnostic("LOGIN_START", { alias: maskAliasDebugValue(username) });
      await withTimeout(persistenceReadyPromise, 2000, "PERSISTENCE_TIMEOUT").catch(() => {});

      const normalizedUser = normalizeUsername(username);
      const raw = String(username || "").trim();
      const directEmail = raw.includes("@") ? raw.toLowerCase() : legacyEmailFromLogin(normalizedUser);
      let credential = null;
      let firstError = null;

      try {
        loginDevDiagnostic("AUTH_START", { mode: "direct_legacy" });
        credential = await withTimeout(signInWithEmailAndPassword(auth, directEmail, password), 10000, "AUTH_TIMEOUT");
      } catch (error) {
        firstError = error;
      }

      // Solo consultar login_aliases cuando el correo histórico no autentica.
      if (!credential && !raw.includes("@")) {
        try {
          const aliasData = await withTimeout(resolveLoginAlias(normalizedUser), 3500, "ALIAS_TIMEOUT");
          const aliasEmail = String(aliasData?.email || "").trim().toLowerCase();
          if (aliasEmail && aliasEmail !== directEmail) {
            loginDevDiagnostic("AUTH_START", { mode: "resolved_alias" });
            credential = await withTimeout(signInWithEmailAndPassword(auth, aliasEmail, password), 10000, "AUTH_TIMEOUT");
            if (aliasData.expectedUid && credential.user?.uid !== aliasData.expectedUid) {
              await signOut(auth).catch(() => {});
              throw new Error("UID_MISMATCH");
            }
          }
        } catch (aliasError) {
          if (!firstError) firstError = aliasError;
        }
      }

      if (!credential?.user) {
        const error = firstError || new Error("AUTH_INVALID_CREDENTIAL");
        loginDevDiagnostic("AUTH_ERROR", { code: error?.code || error?.message || "unknown" });
        if (!navigator.onLine) throw new Error("NETWORK_ERROR");
        if (String(error?.message || "") === "AUTH_TIMEOUT") throw error;
        throw new Error("AUTH_INVALID_CREDENTIAL");
      }

      const user = credential.user;
      loginDevDiagnostic("AUTH_SUCCESS", { hasUser: true });
      try { localStorage.setItem(EXPLORA_SESSION_PREFIX + "last_username", normalizedUser); } catch (_) {}
      beginSplashSync("Validando perfil y actualizando datos de EXPLORA…");
      setBodyMode("explora-auth-checking");

      await withTimeout(openAuthenticatedExploraSession(user), 28000, "LOGIN_TIMEOUT");
      authSessionState.authenticatedUser = user;
      authSessionState.profile = exploraSession.profile || null;
      authSessionState.role = exploraSession.role || null;
      loginDevDiagnostic("UI_OPENED", { role: exploraSession.role || "" });
      try { const passwordInput = $("exploraLoginKey"); if (passwordInput) passwordInput.value = ""; hardenManualAccessFields(); } catch (_) {}
      return credential;
    }

    const loginForm = $("exploraLoginForm");
    const passwordToggle = $("exploraPasswordToggle");
    passwordToggle?.addEventListener("click", () => {
      const input = $("exploraLoginKey");
      if (!input) return;
      const hidden = input.classList.contains("explora-password-masked");
      input.classList.toggle("explora-password-masked", !hidden);
      passwordToggle.textContent = hidden ? "Ocultar" : "Ver";
    });

    try {
      const lastUser = localStorage.getItem(EXPLORA_SESSION_PREFIX + "last_username");
      if (lastUser && $("exploraLoginAccessId")) $("exploraLoginAccessId").value = lastUser;
      const pass = $("exploraLoginKey");
      if (pass) pass.value = "";
      hardenManualAccessFields();
    } catch (_) {}

    async function submitExploraManualLogin(event = null) {
      event?.preventDefault?.();
      loginDevDiagnostic("LOGIN_SUBMIT", {});
      if (authSessionState.loginInProgress || loginInProgress) return;

      const usernameInput = $("exploraLoginAccessId");
      const passwordInput = $("exploraLoginKey");
      const rawUsername = String(usernameInput?.value || "").trim();
      const normalizedUser = rawUsername.includes("@") ? rawUsername.toLowerCase() : normalizeUsername(rawUsername);
      const password = String(passwordInput?.value || "");

      if (!normalizedUser || !password) {
        loginMsg("Ingresá usuario y clave.");
        return;
      }

      setLoginLoading(true);
      loginMsg("");

      try {
        await withTimeout(loginWithUsernameAndPassword(normalizedUser, password), 40000, "LOGIN_TIMEOUT");
        if (!authSessionState.uiOpened) throw new Error("SESSION_OPEN_FAILED");
        loginMsg("");
        if (usernameInput) usernameInput.value = "";
        if (passwordInput) passwordInput.value = "";
        hardenManualAccessFields();
      } catch (error) {
        loginDevDiagnostic("LOGIN_ERROR", { code: error && (error.message || error.code) || "unknown" });
        showLoginErrorForCode(error);
        const code = String(error && (error.message || error.code) || "");
        if ((code.includes("AUTH_INVALID_CREDENTIAL") || code.includes("invalid-credential") || code.includes("wrong-password")) && passwordInput) {
          passwordInput.value = "";
          passwordInput.focus();
        }
        if (auth.currentUser && !authSessionState.uiOpened) {
          if (isCriticalAccessError(error) || !isRecoverableSessionError(error)) {
            await signOut(auth).catch(() => {});
          } else {
            scheduleSessionProfileRecovery(auth.currentUser, error);
          }
        }
      } finally {
        loginDevDiagnostic("LOGIN_FINALLY", {});
        resetLoginState();
      }
    }

    const loginSubmitBtn = $("exploraLoginSubmit");
    loginSubmitBtn?.addEventListener("click", submitExploraManualLogin, { passive:false });
    loginForm?.addEventListener("submit", submitExploraManualLogin, { passive:false });
    loginForm?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submitExploraManualLogin(event);
    }, { passive:false });

    async function logoutExplora() {
      if (authSessionState.logoutInProgress) return;
      window.unlockAllPageScroll?.();
      authSessionState.logoutInProgress = true;
      loginDevDiagnostic("SIGN_OUT_CALLED", { reason: "USER_ACTION" });
      const signOutPromise = signOut(auth).catch((error) => {
        console.warn("[EXPLORA logout]", error?.code || error?.message);
      });
      try {
        closeWeeklyClosureModal();
        renderPendingClosureCard(null);
        resetWeeklyClosureState();
        window.ExploraWeeklyEngine?.stop?.({ reset: true });
        weeklyProfileCache.clear();
        closeAdminCreateDriverModal();
        closeAdminCreateVehicleModal();
        closeVehicleDiagnostic();
        closeAdminSharedModule?.();
        closeAdminReceiptViewer?.();
        clearAdminSharedData?.();
        document.body.classList.remove("explora-shared-admin");
        try {
          const remembered = localStorage.getItem(EXPLORA_SESSION_PREFIX + "last_username");
          Object.keys(localStorage).forEach((key) => {
            if (key.startsWith(EXPLORA_SESSION_PREFIX) && !key.endsWith("last_username")) localStorage.removeItem(key);
            if (key.startsWith(PROFILE_REF_CACHE_PREFIX) || key.startsWith(PROFILE_REF_LEGACY_CACHE_PREFIX)) localStorage.removeItem(key);
          });
          Object.keys(sessionStorage).forEach((key) => {
            if (key.startsWith("explora_") || key.startsWith(PROFILE_REF_CACHE_PREFIX) || key.startsWith(PROFILE_REF_LEGACY_CACHE_PREFIX)) sessionStorage.removeItem(key);
          });
          if (remembered) localStorage.setItem(EXPLORA_SESSION_PREFIX + "last_username", remembered);
        } catch (_) {}
        resetCurrentSessionUI();
        authSessionState.authenticatedUser = null;
        authSessionState.profile = null;
        authSessionState.role = null;
        authSessionState.uiOpened = false;
        const passwordInput = $("exploraLoginKey");
        if (passwordInput) passwordInput.value = "";
        hardenManualAccessFields();
        showLogin("", "USER_LOGOUT");
        await Promise.race([signOutPromise, delay(2500)]);
      } finally {
        window.unlockAllPageScroll?.();
        authSessionState.logoutInProgress = false;
      }
    }

    $("exploraRoleLogout")?.addEventListener("click", logoutExplora);
    $("adminCreateCloseBtn")?.addEventListener("click", closeAdminCreateDriverModal);
    $("adminCreateDriverCancelBtn")?.addEventListener("click", closeAdminCreateDriverModal);
    $("adminCreateDriverForm")?.addEventListener("submit", submitCreateDriver);
    $("adminCreateVehicleCloseBtn")?.addEventListener("click", closeAdminCreateVehicleModal);
    $("vehicleFormCancelBtn")?.addEventListener("click", closeAdminCreateVehicleModal);
    $("adminCreateVehicleForm")?.addEventListener("submit", createVehicleRecord);
    $("vehicleDiagnosticClose")?.addEventListener("click", closeVehicleDiagnostic);
    $("vehicleDiagnosticCloseBottom")?.addEventListener("click", closeVehicleDiagnostic);
    $("vehicleDiagnosticCopy")?.addEventListener("click", copyVehicleDiagnostic);
    $("vehicleDiagnosticBackdrop")?.addEventListener("click", event => { if (event.target?.id === "vehicleDiagnosticBackdrop") closeVehicleDiagnostic(); });
    $("adminManagementConfirmCancel")?.addEventListener("click", () => closeAdminManagementConfirm(false));
    $("adminManagementConfirmAccept")?.addEventListener("click", () => closeAdminManagementConfirm(true));
    $("adminManagementConfirmBackdrop")?.addEventListener("click", event => { if (event.target?.id === "adminManagementConfirmBackdrop") closeAdminManagementConfirm(false); });
    $("adminVehicleList")?.addEventListener("click", async event => {
      const button = event.target.closest?.("[data-admin-delete-vehicle]");
      if (!button) return;

      event.preventDefault();
      event.stopPropagation();

      const vehicleId = String(button.dataset.adminDeleteVehicle || "").trim();
      if (!vehicleId) return;
      if (adminManagementState.deletingVehicleId) {
        vehicleFormMessage("Ya se está borrando un vehículo. Esperá un momento.", "err");
        return;
      }

      // Limpiar inmediatamente cualquier error viejo del formulario (por ejemplo,
      // “Ya existe un vehículo con esa patente”) antes de abrir la confirmación.
      vehicleFormMessage("");
      button.setAttribute("aria-pressed", "true");

      const vehicle = adminManagementState.vehicles.find(item => item.id === vehicleId);
      const confirmed = await openAdminManagementConfirm({ title:"BORRAR VEHÍCULO", message:`Se eliminará este vehículo del sistema.\n\n${vehicle ? vehicleSelectLabel(vehicle) : vehicleId}\n\nSi está asignado a un chofer, ese chofer quedará sin vehículo asignado.\n\n¿Deseás continuar?`, confirmLabel:"BORRAR VEHÍCULO" });
      button.removeAttribute("aria-pressed");
      if (!confirmed) return;

      adminManagementState.deletingVehicleId = vehicleId;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "BORRANDO…";
      vehicleFormMessage("Borrando vehículo…");

      try {
        await softDeleteVehicle(vehicleId);
        if ($("vehiclePlateInput")) $("vehiclePlateInput").value = "";
        if ($("vehicleModelInput")) $("vehicleModelInput").value = "";
        vehicleFormMessage("Vehículo borrado correctamente.", "ok");
      } catch (error) {
        vehicleFormMessage(error?.message || "No se pudo borrar el vehículo.", "err");
      } finally {
        adminManagementState.deletingVehicleId = null;
        if (button.isConnected) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
          button.removeAttribute("aria-pressed");
          button.textContent = "BORRAR VEHÍCULO";
        }
      }
    });

    // Conectar botón Salir existente del dashboard.
    window.ExploraActions = window.ExploraActions || {};
    window.ExploraActions["salir"] = logoutExplora;


    // Dashboard HTML real: métricas dinámicas y acciones de tarjetas.
    function formatMoneyAR(value) {
      const n = Number(value || 0);
      return "$" + Math.round(n).toLocaleString("es-AR");
    }

    function setText(id, value) {
      const el = $(id);
      if (el) el.textContent = value;
    }

    async function refreshRealDashboardMetrics() {
      if (!auth.currentUser) return;
      await window.ExploraWeeklyEngine?.start().catch(() => null);
      await window.ExploraRefreshDashboardMetrics?.();
    }

    window.ExploraActions = window.ExploraActions || {};
    window.ExploraActions["driver-status"] = async () => {
      if (closureState.status===CLOSURE_STATUS.CLOSURE_ERROR || closureState.statusData?.calculationError) {
        await refreshDriverPaymentStatus({force:true}).catch(error=>{
          closureState.error=error;closureState.clickable=true;
          renderDriverStatusCard({...(closureState.statusData||{}),status:CLOSURE_STATUS.CLOSURE_ERROR,clickable:true,error,calculationError:true});
        });
      }
      if (!closureState.clickable) return;
      await openWeeklyClosureModal();
    };
    window.ExploraActions["detalle-financiero"] = () => {
      if (window.ExploraActions["gastos-semanales"]) window.ExploraActions["gastos-semanales"]();
    };
    window.ExploraActions["facturacion-semanal"] = () => showMainToast?.("Facturación semanal actualizada desde servicios vendidos.");
    window.ExploraActions["resumen-servicios"] = () => showMainToast?.("Cobros registrados: ver detalle en facturación o ranking.");
    window.ExploraActions["resumen-comprobantes"] = () => {
      if (window.ExploraActions["comprobantes"]) window.ExploraActions["comprobantes"]();
    };
    window.ExploraActions["resumen-gastos"] = () => {
      if (window.ExploraActions["gastos-semanales"]) window.ExploraActions["gastos-semanales"]();
    };
    

    window.ExploraActions["admin-cierres"] = () => window.ExploraReceipts?.openCategory?.("cierres") || openAdminSharedModule("closures");
    window.ExploraActions["admin-launch"] = () => window.ExploraAdminTools?.openLaunch?.();
    window.ExploraActions["admin-derivaciones"] = () => openAdminSharedModule("derivations");
    window.ExploraActions["admin-multas"] = () => window.ExploraAdminTools?.openDebt?.();
        window.ExploraActions["admin-choferes"] = () => openAdminSharedModule("drivers-management");
    window.ExploraActions["admin-agregar-chofer"] = () => openAdminSharedModule("drivers-management");
    window.ExploraActions["admin-create-vehicle"] = openAdminCreateVehicleModal;
    window.ExploraActions["admin-deuda"] = () => window.ExploraAdminTools?.openDebt?.();
    window.ExploraActions["admin-prestamo"] = () => openAdminSharedModule("loan");
    window.ExploraActions["admin-mi-auto"] = () => openAdminSharedModule("car");
    window.ExploraActions["admin-facturacion"] = () => openAdminSharedModule("billing");
    window.ExploraActions["admin-colaboracion-bono"] = () => openAdminSharedModule("collaboration");
    window.ExploraActions["admin-gastos"] = () => openAdminSharedModule("expenses");
    window.ExploraActions["admin-comprobantes"] = () => window.ExploraReceipts?.openAdminPayments?.() || window.ExploraReceipts?.openCategory?.("explora") || window.ExploraReceipts?.open?.({adminMode:true});

    $("adminSharedBackBtn")?.addEventListener("click", () => {
      if (adminSharedState.mode === "closure-detail") {
        adminSharedState.mode = "closures";
        adminSharedState.selectedDriverKey = "";
        renderAdminSharedModule();
      } else closeAdminSharedModule();
    });
    $("adminSharedRefreshBtn")?.addEventListener("click", async () => {
      const button = $("adminSharedRefreshBtn");
      if (button) button.disabled = true;
      try { await window.ExploraAdminShared.refresh(); }
      finally { if (button) button.disabled = false; }
    });
    document.querySelectorAll("[data-admin-period]").forEach(button => button.addEventListener("click", () => {
      adminSharedState.periodMode = button.dataset.adminPeriod;
      renderAdminSharedModule();
    }));
    document.querySelectorAll("[data-admin-receipt-tab]").forEach(button => button.addEventListener("click", () => {
      adminSharedState.receiptTab = button.dataset.adminReceiptTab;
      renderAdminSharedModule();
    }));
    $("adminSharedContent")?.addEventListener("click", async (event) => {
      const addDriverButton = event.target.closest?.("[data-admin-add-driver]");
      if (addDriverButton) { await openAdminCreateDriverModal(); return; }
      const saveDriverVehicleButton = event.target.closest?.("[data-admin-save-driver-vehicle]");
      if (saveDriverVehicleButton) {
        if (adminManagementState.busy) return;
        adminManagementState.busy = true; saveDriverVehicleButton.disabled = true; saveDriverVehicleButton.textContent = "GUARDANDO…";
        try { await saveDriverVehicleAssignment(saveDriverVehicleButton.dataset.adminSaveDriverVehicle); }
        catch (_) {}
        finally { adminManagementState.busy = false; }
        return;
      }
      const resetDriverButton = event.target.closest?.("[data-admin-reset-driver]");
      if (resetDriverButton) {
        if (adminManagementState.busy) return;
        const driver = adminManagementState.drivers.find(item => item.id === resetDriverButton.dataset.adminResetDriver);
        if (!driver) return;
        const driverName = getProfileName(driver);
        const first = await openAdminManagementConfirm({
          title:"RESETEAR DATOS DEL CHOFER",
          message:`Se borrarán todos los datos operativos de este chofer: cobros, gastos, caja chica, deudas, cierres, préstamos, comprobantes, actividad y acumulados.\n\n${driverName}\n${driver.email || driver.contactEmail || ""}\n\nLa cuenta, contraseña, perfil, teléfono, alias y vehículo asignado se conservarán. No se puede deshacer.`,
          confirmLabel:"CONTINUAR"
        });
        if (!first) return;
        const typed = window.prompt(`Confirmación final: escribí exactamente RESETEAR ${driverName}`) || "";
        if (typed.trim() !== `RESETEAR ${driverName}`) { window.showToast?.("Confirmación incorrecta. No se reseteó ningún dato."); return; }
        adminManagementState.busy = true; resetDriverButton.disabled = true; resetDriverButton.textContent = "RESETEANDO…";
        try {
          const result = await resetDriverOperationalData(driver.id, typed.trim());
          window.showExploraSuccess?.({ title:"DATOS RESETEADOS", message:`${driverName} conserva su cuenta y vehículo. Documentos eliminados: ${result.deletedDocuments || 0}. Archivos eliminados: ${result.deletedFiles || 0}.` });
        } catch (error) {
          showVehicleDiagnostic("RESET_DRIVER_OPERATIONAL_DATA", error?.internalCode || error?.code || "DRIVER_RESET_FAILED", error, { functionName:"adminResetDriverOperationalData", driverUid:driver.id, firestorePath:"Cloud Function Admin SDK", queryUsed:"recursive scan + preserve profile/auth/vehicle" });
        } finally { adminManagementState.busy = false; }
        return;
      }
      const hardDeleteDriverButton = event.target.closest?.("[data-admin-hard-delete-driver]");
      if (hardDeleteDriverButton) {
        if (adminManagementState.busy) return;
        const driver = adminManagementState.drivers.find(item => item.id === hardDeleteDriverButton.dataset.adminHardDeleteDriver);
        if (!driver) return;
        const driverName = getProfileName(driver);
        const first = await openAdminManagementConfirm({ title:"ELIMINAR DATOS FIREBASE", message:`Esta acción eliminará los datos operativos del chofer en Firestore y los archivos relacionados que sean accesibles.\n\n${driverName}\n${driver.email || driver.contactEmail || ""}\n\nNo se puede deshacer.`, confirmLabel:"CONTINUAR" });
        if (!first) return;
        const typed = window.prompt(`Confirmación final: escribí exactamente ELIMINAR ${driverName}`) || "";
        if (typed.trim() !== `ELIMINAR ${driverName}`) { window.showToast?.("Confirmación incorrecta. No se eliminó nada."); return; }
        adminManagementState.busy = true; hardDeleteDriverButton.disabled = true; hardDeleteDriverButton.textContent = "ELIMINANDO…";
        try {
          const result = await hardDeleteDriverFirebaseData(driver.id, typed.trim());
          window.showExploraSuccess?.({ title:"CHOFER ELIMINADO", message:`${driverName} fue eliminado de Firebase. Documentos eliminados: ${result.deletedDocuments || 0}. Archivos eliminados: ${result.deletedFiles || 0}.` });
        } catch (error) {
          showVehicleDiagnostic("HARD_DELETE_DRIVER_DATA", error?.internalCode || error?.code || "HARD_DELETE_FAILED", error, { functionName:"adminDeleteDriverCompletely", driverUid:driver.id, firestorePath:"Cloud Function Admin SDK", queryUsed:"recursive scan + preserve shared records" });
        } finally { adminManagementState.busy = false; }
        return;
      }
      const deleteDriverButton = event.target.closest?.("[data-admin-delete-driver]");
      if (deleteDriverButton) {
        if (adminManagementState.busy) return;
        const driver = adminManagementState.drivers.find(item => item.id === deleteDriverButton.dataset.adminDeleteDriver);
        if (!driver) return;
        const confirmed = await openAdminManagementConfirm({ title:"BORRAR CHOFER", message:`Se eliminará este chofer del sistema operativo de EXPLORA.\n\n${getProfileName(driver)}\n${driver.email || driver.contactEmail || ""}\n\nNo se eliminará el usuario Admin ni Firebase Authentication. También se liberará el vehículo asignado si corresponde.\n\n¿Deseás continuar?`, confirmLabel:"BORRAR CHOFER" });
        if (!confirmed) return;
        adminManagementState.busy = true; deleteDriverButton.disabled = true; deleteDriverButton.textContent = "BORRANDO…";
        try { await softDeleteDriver(driver.id); }
        catch (_) {}
        finally { adminManagementState.busy = false; }
        return;
      }
      if(event.target.closest("#adminLoanDiagnosticClose")){closeOperationalLoanDiagnostic();return;}
      if(event.target.closest("#adminLoanDiagnosticCopy")){await copyOperationalLoanDiagnostic();return;}
      if(event.target.closest("#adminLoanReceiptBtn")){$("operationalLoanReceiptInput")?.click();return;}
      if(event.target.closest("#adminLoanPreviewRemove")){window.ExploraReceiptEngine?.resetUploadState?.("operationalLoan");const input=$("operationalLoanReceiptInput");if(input)input.value="";window.ExploraReceiptUI?.clear?.({previewId:"adminLoanPreview",thumbId:"adminLoanPreviewThumb",nameId:"adminLoanPreviewName",metaId:"adminLoanPreviewMeta"});return;}
      const closureButton = event.target.closest("[data-admin-open-closure]");
      if (closureButton) {
        adminSharedState.selectedDriverKey = closureButton.dataset.adminOpenClosure;
        adminSharedState.mode = "closure-detail";
        await renderAdminSharedModule();
        return;
      }
      const viewButton = event.target.closest("[data-admin-view-receipt]");
      if (viewButton) {
        openAdminReceiptViewer(viewButton.dataset.adminViewReceipt, viewButton.dataset.adminReceiptMime || "", viewButton.dataset.adminReceiptTitle || "Comprobante", "Archivo cargado bajo demanda");
        return;
      }
      const pickerButton = event.target.closest("#adminDavidReceiptPicker");
      if(pickerButton){$("weeklyAdminReceiptInput")?.click();return;}
      if(event.target.closest("#adminDavidReceiptPreviewRemove")){clearAdminReceiptSelection();window.ExploraReceiptUI?.clear?.({previewId:"adminDavidReceiptPreview",thumbId:"adminDavidReceiptPreviewThumb",nameId:"adminDavidReceiptPreviewName",metaId:"adminDavidReceiptPreviewMeta"});const button=document.querySelector("[data-admin-upload-david-receipt]");if(button)button.disabled=true;return;}
            const uploadButton = event.target.closest("[data-admin-upload-david-receipt]");
      if (uploadButton) {
        if(adminClosureReceiptInProgress)return;
        const item = adminSelectedItem(uploadButton.dataset.adminUploadDavidReceipt);
        const input = $("weeklyAdminReceiptInput");
        const message = $("adminDavidReceiptMsg");
        const file=window.ExploraReceiptEngine?.getState?.("weeklyClosureAdmin")?.file||null;
        if (!(file instanceof File)) { if (message) message.textContent = "Selecciona un comprobante."; return; }
        adminClosureReceiptInProgress=true;
        uploadButton.disabled = true;
        uploadButton.textContent = "SUBIENDO…";
        if (message) message.textContent = "Procesando comprobante…";
        try {
          uploadButton.textContent="SUBIENDO COMPROBANTE…";
          await submitAdminWeeklyReceipt(item, file);
          if(message)message.textContent="";
          if(input)input.value="";
          clearAdminReceiptSelection({clearInput:false});
          adminSharedState.overview = await getAdminWeeklyOverview("", { force:true });
          renderAdminStatusCard(adminSharedState.overview);
          renderAdminDashboardMetrics(adminSharedState.overview);
          window.showExploraSuccess?.({title:"¡EXITOSO!",message:"Comprobante registrado correctamente.",onAccept:()=>renderAdminSharedModule()});
        } catch (error) {
          console.warn("[EXPLORA admin] receipt", error?.code || error?.message);
          if (message) message.textContent = String(error?.code || "").includes("unauthorized") ? "No tienes permisos para subir este comprobante." : "No se pudo cargar el comprobante.";
        } finally {
          adminClosureReceiptInProgress=false;
          uploadButton.disabled = false;
          uploadButton.textContent = "SUBIR COMPROBANTE";
          window.unlockPageScroll?.("admin-closure-upload");
        }
      }
    });
    $("weeklyAdminReceiptInput")?.addEventListener("change", event => {
      const file=event.target.files?.[0]||null;
      clearAdminReceiptSelection({clearInput:false});
      if(!file)return;
      try{const selected=window.ExploraReceiptEngine.selectUploadFile(file,"weeklyClosureAdmin",{allowPdf:false});adminSharedState.receiptFile=selected.file;adminSharedState.receiptPreviewUrl=selected.previewUrl||"";}catch(error){console.warn("ADMIN_WEEKLY_FILE_SELECT",error);event.target.value="";if($("adminDavidReceiptMsg"))$("adminDavidReceiptMsg").textContent="Selecciona una imagen JPG, PNG o WebP compatible.";return;}
      const rendered=window.ExploraReceiptUI?.render?.({previewId:"adminDavidReceiptPreview",thumbId:"adminDavidReceiptPreviewThumb",nameId:"adminDavidReceiptPreviewName",metaId:"adminDavidReceiptPreviewMeta",file,previewUrl:adminSharedState.receiptPreviewUrl});
      const button=document.querySelector("[data-admin-upload-david-receipt]");if(button)button.disabled=!rendered;
      if($("adminDavidReceiptMsg"))$("adminDavidReceiptMsg").textContent="";
      if(rendered)window.scrollToReceiptSubmitButton?.(button);
    });
    $("adminSharedContent")?.addEventListener("submit", event => {
      if (event.target?.id === "adminOperationalLoanForm") submitOperationalLoan(event);
      if (event.target?.id === "adminPerformancePercentagesForm") saveAdminPerformancePercentages(event);
    });
    $("operationalLoanReceiptInput")?.addEventListener("change", event => {
      const input=event.target;
      const file=input.files?.[0]||null;
      try{
        if(!file)return;
        const selected=window.ExploraReceiptEngine?.selectUploadFile?.(file,"operationalLoan",{allowPdf:false});
        window.ExploraReceiptUI?.render?.({previewId:"adminLoanPreview",thumbId:"adminLoanPreviewThumb",nameId:"adminLoanPreviewName",metaId:"adminLoanPreviewMeta",file,previewUrl:selected.previewUrl});
        const message=$("adminLoanMsg");if(message&&!operationalLoanDiagnosticState){message.textContent="";message.className="admin-shared-status operational-loan-status";}
      }catch(error){
        input.value="";
        const runtime=createOperationalLoanRuntime();runtime.stage="VALIDATING_FORM";runtime.file=file;
        showOperationalLoanFailure(Object.assign(error||new Error("Comprobante inválido."),{internalCode:"INVALID_RECEIPT_FILE",loanStage:"VALIDATING_FORM"}),runtime);
      }finally{
        try{input.blur();}catch(_){}
        requestAnimationFrame(()=>{const active=document.activeElement;if(active&&typeof active.blur==="function")try{active.blur();}catch(_){}});
      }
    });
    $("adminReceiptViewerClose")?.addEventListener("click", closeAdminReceiptViewer);
    $("adminReceiptViewer")?.addEventListener("click", event => { if (event.target?.id === "adminReceiptViewer") closeAdminReceiptViewer(); });

    document.addEventListener("click", (event) => {
      const actionEl = event.target.closest && event.target.closest("[data-action]");
      if (!actionEl) return;
      const action = actionEl.getAttribute("data-action");
      const fn = window.ExploraActions && window.ExploraActions[action];
      if (typeof fn === "function") {
        event.preventDefault();
        fn();
      }
    }, true);


    // Perfil limpio + motor único de cierre semanal, comprobantes y elegibilidad.
    const CLOSURE_STATUS = Object.freeze({
      NO_CLOSURE: "NO_CLOSURE",
      DRIVER_UP_TO_DATE: "DRIVER_UP_TO_DATE",
      DRIVER_MUST_PAY_PENDING: "DRIVER_MUST_PAY_PENDING",
      DRIVER_MUST_PAY_OVERDUE: "DRIVER_MUST_PAY_OVERDUE",
      DRIVER_RECEIPT_UPLOADED: "DRIVER_RECEIPT_UPLOADED",
      BALANCED_CLOSURE: "BALANCED_CLOSURE",
      BALANCED_RECEIPT_UPLOADED: "BALANCED_RECEIPT_UPLOADED",
      DAVID_MUST_PAY_PENDING: "DAVID_MUST_PAY_PENDING",
      DAVID_RECEIPT_UPLOADED: "DAVID_RECEIPT_UPLOADED",
      CLOSURE_LOADING: "CLOSURE_LOADING",
      CLOSURE_ERROR: "CLOSURE_ERROR"
    });

    const DRIVER_WEEKLY_CLOSURE_STATUS = Object.freeze({
      UP_TO_DATE:"UP_TO_DATE",
      NEW_CLOSURE_UNSEEN:"NEW_CLOSURE_UNSEEN",
      BALANCED_AWAITING_ACKNOWLEDGEMENT:"BALANCED_AWAITING_ACKNOWLEDGEMENT",
      DRIVER_PAYMENT_PENDING:"DRIVER_PAYMENT_PENDING",
      DRIVER_RECEIPT_SUBMITTED:"DRIVER_RECEIPT_SUBMITTED",
      DRIVER_RECEIPT_REJECTED:"DRIVER_RECEIPT_REJECTED",
      ADMIN_PAYMENT_PENDING:"ADMIN_PAYMENT_PENDING",
      ADMIN_PAYMENT_COMPLETED:"ADMIN_PAYMENT_COMPLETED",
      CLOSURE_COMPLETED:"CLOSURE_COMPLETED",
      REVIEW_REQUIRED:"REVIEW_REQUIRED"
    });

    function getDriverWeeklyClosureStatus(closureInput = {}, currentUser = {}, receiptData = {}) {
      const statusData = closureInput?.statusData || closureInput || {};
      const closure = { ...(statusData.closureRecord?.data || {}), ...(statusData.closure || {}), ...(receiptData || {}) };
      const payment = { ...(statusData.paymentRecord?.data || {}), ...(statusData.payment || {}) };
      const periodId = String(statusData.weeklyPeriodId || closure.weeklyPeriodId || closure.periodoSemanalId || closure.periodoId || "").trim();
      const activePeriodId = String(getActiveWeeklyPeriod?.().id || "").trim();
      const isPeriodClosed = statusData.isPeriodClosed === true || Boolean(periodId && activePeriodId && periodId !== activePeriodId);
      const amount = Math.max(0, Number(statusData.amount ?? closure.settlementAmount ?? closure.saldoFinal ?? payment.amount ?? 0) || 0);
      const payer = statusData.payer || (closureDirection(closure,payment)==="chofer_a_david"?"driver":closureDirection(closure,payment)==="david_a_chofer"?"admin":null);
      const receiptStatus = String(statusData.receiptStatus || closure.driverReceiptStatus || closure.adminReceiptStatus || closure.receiptStatus || closure.estadoComprobante || payment.receiptStatus || "").toLowerCase();
      const rejected = receiptStatus.includes("reject") || receiptStatus.includes("rechaz");
      const driverReceiptUrl = String(statusData.driverReceiptUrl || closure.driverReceiptUrl || (payer==="driver" ? statusData.receiptUrl || closure.receiptUrl || "" : "")).trim();
      const adminReceiptUrl = String(statusData.adminReceiptUrl || closure.adminReceiptUrl || closure.davidReceiptUrl || (payer==="admin" ? statusData.receiptUrl || closure.receiptUrl || "" : "")).trim();
      const driverReceiptSubmitted = Boolean(driverReceiptUrl || ["uploaded","accepted","review","approved","aprobado"].some(v=>receiptStatus.includes(v)) && payer==="driver");
      const adminPaymentCompleted = Boolean(closure.adminPaymentCompleted===true || closure.pagoDavidCompletado===true || adminReceiptUrl || (payer==="admin" && ["uploaded","accepted","approved","aprobado","paid","pagado"].some(v=>receiptStatus.includes(v))));
      const acknowledged = Boolean(closure.driverAcknowledged===true || closure.driverAcknowledgedPeriodId===periodId || driverReceiptSubmitted || adminPaymentCompleted);
      const explicitBalance = statusData.normalizedBalance ?? closure.finalBalance ?? closure.saldoFinal;
      const parsedBalance = (typeof explicitBalance === "number" && Number.isFinite(explicitBalance)) ? explicitBalance : (typeof explicitBalance === "string" && explicitBalance.trim() !== "" && Number.isFinite(Number(explicitBalance)) ? Number(explicitBalance) : null);
      const snapshotComplete = statusData.snapshotComplete === true || closure.snapshotComplete === true || statusData.weeklySnapshot?.snapshotComplete === true;
      const balanced = snapshotComplete === true && parsedBalance !== null && Math.abs(parsedBalance) < 0.01 && !payer;
      const periodLabel = closurePeriodLabel(closure, periodId || "Último cierre");
      const base = {periodId,periodLabel,amount,payer,isPeriodClosed,requiresDriverAcknowledgement:false,requiresDriverReceipt:false,requiresAdminPayment:false,requiresAdminReceipt:false,isUpToDate:false,canDriverResolve:false,canAdminResolve:false};
      const calculationFailed = statusData.status===CLOSURE_STATUS.CLOSURE_ERROR || statusData.calculationError===true || statusData.error || closure.snapshotConflict===true || statusData.weeklySnapshot?.snapshotConflict===true;
      if(calculationFailed) return {...base,code:CLOSURE_STATUS.CLOSURE_ERROR,label:"NO SE PUDO CALCULAR",detail:"No mostramos AL DÍA hasta validar todos los movimientos. Tocá para reintentar.",colorState:"error",canDriverResolve:true};
      const done = (code,detail)=>({...base,code,label:"AL DÍA",detail,colorState:"ok",isUpToDate:true});
      if(!isPeriodClosed) return done(DRIVER_WEEKLY_CLOSURE_STATUS.UP_TO_DATE,"No tenés acciones pendientes de cierre.");
      if(rejected) return {...base,code:DRIVER_WEEKLY_CLOSURE_STATUS.DRIVER_RECEIPT_REJECTED,label:"COMPROBANTE RECHAZADO",detail:closure.receiptRejectionReason || closure.motivoRechazo || "Tu comprobante fue rechazado. Subí uno nuevo.",colorState:"pending",requiresDriverReceipt:true,canDriverResolve:true};
      if(payer==="driver" && !driverReceiptSubmitted) return {...base,code:DRIVER_WEEKLY_CLOSURE_STATUS.DRIVER_PAYMENT_PENDING,label:"PAGO PENDIENTE",detail:`Debés pagarle a David ${formatClosureMoney(amount)} y subir el comprobante.`,colorState:"pending",requiresDriverReceipt:true,requiresDriverAcknowledgement:true,canDriverResolve:true};
      if(payer==="admin" && !adminPaymentCompleted) return {...base,code:DRIVER_WEEKLY_CLOSURE_STATUS.ADMIN_PAYMENT_PENDING,label:"PAGO DE DAVID PENDIENTE",detail:`David debe pagarte ${formatClosureMoney(amount)}. Te avisaremos cuando registre el pago.`,colorState:"david-pending",requiresAdminPayment:true,requiresAdminReceipt:true,canAdminResolve:true};
      if(balanced && !acknowledged) return {...base,code:DRIVER_WEEKLY_CLOSURE_STATUS.BALANCED_AWAITING_ACKNOWLEDGEMENT,label:"REVISÁ TU CIERRE",detail:"La cuenta está equilibrada. Entrá para revisar y confirmar que lo viste.",colorState:"upcoming",requiresDriverAcknowledgement:true,canDriverResolve:true};
      if(!balanced && !payer) return {...base,code:DRIVER_WEEKLY_CLOSURE_STATUS.REVIEW_REQUIRED,label:"REVISIÓN NECESARIA",detail:"No pudimos determinar correctamente quién debe pagar. David revisará este cierre.",colorState:"error",canAdminResolve:true};
      if(driverReceiptSubmitted) return done(DRIVER_WEEKLY_CLOSURE_STATUS.DRIVER_RECEIPT_SUBMITTED,"Comprobante enviado. Tu cierre está al día.");
      if(adminPaymentCompleted) return done(DRIVER_WEEKLY_CLOSURE_STATUS.ADMIN_PAYMENT_COMPLETED,"David registró el pago. Tu cierre está al día.");
      if(balanced && acknowledged) return done(DRIVER_WEEKLY_CLOSURE_STATUS.CLOSURE_COMPLETED,"Cierre equilibrado confirmado.");
      return done(DRIVER_WEEKLY_CLOSURE_STATUS.UP_TO_DATE,"Tu último cierre ya está resuelto.");
    }
    window.getDriverWeeklyClosureStatus = getDriverWeeklyClosureStatus;

    const closureState = {
      uid: null,
      weeklyPeriodId: null,
      closureId: null,
      closureCollection: "cierres_semanales",
      closure: null,
      paymentId: null,
      payment: null,
      status: CLOSURE_STATUS.CLOSURE_LOADING,
      clickable: false,
      performanceEligible: true,
      receiptDeadline: null,
      amount: 0,
      saving: false,
      refreshing: false,
      listenerKey: "",
      unsubscribers: [],
      error: null
    };
    const weeklyClosureState = closureState;
    const weeklyDriverReceiptState = {
      file: null,
      previewUrl: null,
      processedFile: null,
      uploading: false
    };
    let driverClosureReceiptInProgress=false;
    const weeklyClosureCache = {
      uid: null,
      activeWeeklyPeriodId: null,
      data: null,
      loadedAt: null,
      dirty: true,
      dirtyReason: "initial",
      loadPromise: null
    };

    const CLOSURE_SESSION_CACHE_PREFIX = "explora_closure_v2440_";
    function closureSessionCacheKey(uid, periodId){ return `${CLOSURE_SESSION_CACHE_PREFIX}${uid}_${periodId}`; }
    function storeWeeklyClosureSessionCache(data){
      try{
        if(!data?.weeklyPeriodId||!auth.currentUser?.uid)return;
        const safe={...data,closureRecord:null,paymentRecord:null,weeklySnapshot:data.weeklySnapshot?snapshotForSessionStorage(data.weeklySnapshot):null,cachedAt:Date.now()};
        sessionStorage.setItem(closureSessionCacheKey(auth.currentUser.uid,data.weeklyPeriodId),JSON.stringify(safe));
      }catch(_){}
    }
    function restoreWeeklyClosureSessionCache(){
      const user=auth.currentUser;if(!user?.uid)return null;
      const active=getActiveWeeklyPeriod();const previous=getPreviousWeeklyPeriod(active);
      for(const period of [previous,active]){
        try{
          const raw=sessionStorage.getItem(closureSessionCacheKey(user.uid,period.id));
          if(!raw)continue;
          const data=JSON.parse(raw);if(!data?.status)continue;
          weeklyClosureCache.uid=user.uid;weeklyClosureCache.activeWeeklyPeriodId=active.id;weeklyClosureCache.data=data;weeklyClosureCache.loadedAt=Date.now();weeklyClosureCache.dirty=false;
          applyClosureState(data);renderPendingClosureCard([CLOSURE_STATUS.DRIVER_MUST_PAY_PENDING,CLOSURE_STATUS.DRIVER_MUST_PAY_OVERDUE].includes(data.status)?data:null);renderDriverStatusCard(data);return data;
        }catch(_){}
      }
      return null;
    }
    window.ExploraRestoreWeeklyClosureCache=restoreWeeklyClosureSessionCache;
    window.ExploraClosureState = closureState;
    window.ExploraWeeklyClosureCache = weeklyClosureCache;

    function isClosureLikeElement(el) {
      if (!el || el.id === "profilePendingClosureCard") return false;
      const id = String(el.id || "").toLowerCase();
      const cls = String(el.className || "").toLowerCase();
      const text = String(el.textContent || "").toLowerCase();
      return (
        id.includes("closure") || id.includes("cierre") || cls.includes("closure") || cls.includes("cierre") ||
        text.includes("premio semanal") || text.includes("comprobante obligatorio") ||
        text.includes("el chofer debe depositar") || text.includes("cerrar y dejar pago pendiente") ||
        text.includes("beneficio configurado") || text.includes("saldo final")
      );
    }

    function sanitizeProfileScreen() {
      const screen = $("profileScreen");
      if (!screen) return;
      Array.from(screen.children).forEach((child) => {
        if (child.classList && (child.classList.contains("profile-shell") || child.id === "profilePendingClosureCard")) return;
        if (isClosureLikeElement(child)) child.remove();
      });
      screen.querySelectorAll(".profile-shell > *").forEach((el) => {
        if (el.closest("#profilePendingClosureCard")) return;
        if (isClosureLikeElement(el) && !el.classList.contains("profile-card") && !el.classList.contains("profile-header")) el.remove();
      });
    }

    function statusIconMarkup(kind) {
      if (["ok","balanced","paid","review","david-pending"].includes(kind)) return '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
      if (kind === "derivation-pending") return '<svg viewBox="0 0 24 24"><path d="M7 7h10"/><path d="m14 4 3 3-3 3"/><path d="M17 17H7"/><path d="m10 14-3 3 3 3"/></svg>';
      if (["pending","overdue"].includes(kind)) return '<svg viewBox="0 0 24 24"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.6 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/></svg>';
      return '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/></svg>';
    }

    function configureWeeklyStatusInteraction(statusData = {}) {
      const card = $("driverStatusCard");
      if (!card) return;
      const clickable = Boolean(statusData.clickable);
      closureState.clickable = clickable;
      if (statusData.closureId) closureState.closureId = statusData.closureId;
      if (statusData.weeklyPeriodId) closureState.weeklyPeriodId = statusData.weeklyPeriodId;
      closureState.statusData = statusData;
      card.disabled = !clickable;
      card.setAttribute("aria-disabled", clickable ? "false" : "true");
      card.tabIndex = clickable ? 0 : -1;
      if (clickable) {
        card.dataset.action = "driver-status";
        card.setAttribute("role", "button");
      } else {
        card.removeAttribute("data-action");
        card.removeAttribute("role");
      }
    }

    const DASHBOARD_NOTICE_VERSION = 3;
    const dashboardNoticeMemory = new Map();
    let dashboardNoticeSeenTimer = 0;
    let dashboardNoticeStorageFailed = false;
    let lastDashboardWeeklyStatusResult = null;
    let dashboardDerivationPendingRows = [];

    function dashboardNoticeUid() {
      return auth.currentUser?.uid || exploraSession.authUser?.uid || "anonymous";
    }

    function dashboardNoticeStorageKey(uid = dashboardNoticeUid()) {
      return `explora.dashboard.notice.v${DASHBOARD_NOTICE_VERSION}.${uid}`;
    }

    function isPaymentStatusTimeout(error) {
      const value = String(error?.code || error?.message || error || "").toUpperCase();
      return value.includes("PAYMENT_STATUS_TIMEOUT");
    }

    function reportDashboardNoticeError(stage, code, error, context = {}) {
      const timeout = isPaymentStatusTimeout(error) || String(code || "").toUpperCase() === "PAYMENT_STATUS_TIMEOUT";
      const payload = {
        stage,
        code: timeout ? "PAYMENT_STATUS_TIMEOUT" : code,
        error,
        context:{
          ...context,
          silent: timeout ? true : context.silent,
          fallbackUsed: timeout ? true : context.fallbackUsed,
          functionName:context.functionName || "dashboardNotice",
          noticeId:window.ExploraDashboardNoticeState?.lastDashboardNoticeId || "—",
          noticeType:window.ExploraDashboardNoticeState?.dashboardNoticeType || "—",
          noticeSeen:Boolean(window.ExploraDashboardNoticeState?.lastDashboardNoticeSeenAt)
        }
      };
      if (typeof window.ExploraPerformanceEngine?.showDiagnostic === "function") {
        window.ExploraPerformanceEngine.showDiagnostic(payload.stage, payload.code, payload.error, payload.context);
      } else if (!timeout) {
        window.__exploraPendingGoalDiagnostic = payload;
      } else {
        console.warn("[EXPLORA aviso interno] PAYMENT_STATUS_TIMEOUT · se conserva el último estado conocido");
      }
    }

    function stableDashboardNoticeFallback(activePeriod, error, { allowStored = true } = {}) {
      if (allowStored) {
        const cached = weeklyClosureCache.data;
        if (cached && ![CLOSURE_STATUS.CLOSURE_LOADING, CLOSURE_STATUS.CLOSURE_ERROR].includes(cached.status)) {
          return { result:cached, rendered:false, source:"weekly-cache" };
        }

        if (lastDashboardWeeklyStatusResult && ![CLOSURE_STATUS.CLOSURE_LOADING, CLOSURE_STATUS.CLOSURE_ERROR].includes(lastDashboardWeeklyStatusResult.status)) {
          return { result:lastDashboardWeeklyStatusResult, rendered:false, source:"last-known" };
        }

        const frozen = readDashboardNoticeSnapshot();
        if (frozen) {
          const interaction = frozen.interaction && frozen.interaction.status
            ? frozen.interaction
            : { status:CLOSURE_STATUS.NO_CLOSURE, clickable:false, weeklyPeriodId:activePeriod.id, amount:0, reason:"payment_status_timeout_snapshot" };
          applyDashboardNoticeSnapshot(frozen, interaction);
          return { result:interaction, rendered:true, source:"notice-snapshot" };
        }
      }

      return {
        result:{
          status:CLOSURE_STATUS.CLOSURE_ERROR,
          clickable:true,
          closureId:null,
          weeklyPeriodId:activePeriod.id,
          payer:null,
          payee:null,
          amount:0,
          receiptStatus:null,
          performanceEligibility:false,
          reason:"payment_status_calculation_failed",
          timeoutFallback:true,
          calculationError:true,
          error:error || new Error("No se pudo calcular el cierre semanal")
        },
        rendered:false,
        source:"safe-calculation-error"
      };
    }

    function readDashboardNoticeSnapshot() {
      const key = dashboardNoticeStorageKey();
      const fast=window.ExploraFastCache?.get?.("dashboard_notice",{uid:dashboardNoticeUid(),role:"chofer"},{allowStale:true});
      if(fast?.data){dashboardNoticeMemory.set(key,fast.data);window.ExploraDashboardNoticeState=fast.data;return fast.data;}
      if (dashboardNoticeMemory.has(key)) return dashboardNoticeMemory.get(key);
      if (dashboardNoticeStorageFailed) return null;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || Number(parsed.dashboardNoticeVersion) !== DASHBOARD_NOTICE_VERSION) return null;
        dashboardNoticeMemory.set(key, parsed);
        window.ExploraDashboardNoticeState = parsed;
        return parsed;
      } catch (error) {
        dashboardNoticeStorageFailed = true;
        reportDashboardNoticeError("READ_DASHBOARD_NOTICE", "DASHBOARD_NOTICE_READ_FAILED", error, { functionName:"readDashboardNoticeSnapshot" });
        return null;
      }
    }

    function writeDashboardNoticeSnapshot(snapshot) {
      const key = dashboardNoticeStorageKey();
      dashboardNoticeMemory.set(key, snapshot);
      window.ExploraDashboardNoticeState = snapshot;
      window.ExploraFastCache?.set?.("dashboard_notice",snapshot,{uid:dashboardNoticeUid(),role:"chofer"},{ttl:120000});
      if (dashboardNoticeStorageFailed) return snapshot;
      try {
        localStorage.setItem(key, JSON.stringify(snapshot));
      } catch (error) {
        dashboardNoticeStorageFailed = true;
        reportDashboardNoticeError("RENDER_DASHBOARD_NOTICE", "DASHBOARD_NOTICE_WRITE_FAILED", error, { functionName:"writeDashboardNoticeSnapshot", noticeId:snapshot.lastDashboardNoticeId, noticeType:snapshot.dashboardNoticeType, noticeSeen:Boolean(snapshot.lastDashboardNoticeSeenAt) });
      }
      return snapshot;
    }

    function buildDashboardNoticeId(result, rawStatus) {
      const direct = result.lastDashboardNoticeId || result.dashboardNoticeId || result.noticeId;
      if (direct) return String(direct);
      if ([CLOSURE_STATUS.NO_CLOSURE, CLOSURE_STATUS.DRIVER_UP_TO_DATE, "CLOSURE_DAY"].includes(rawStatus)) {
        const timing = weeklyClosureTiming();
        return `weekly-status|${timing.todayKey}|${rawStatus}|${timing.daysRemaining}`;
      }
      const eventId = result.receiptId || result.paymentId || result.closureId || result.weeklyPeriodId || "general";
      const receiptStatus = String(result.receiptStatus || result.paymentStatus || "");
      const amount = Math.round(Number(result.amount || 0));
      return `${eventId}|${rawStatus}|${receiptStatus}|${amount}`;
    }

    function markDashboardNoticeAsSeen(noticeId) {
      try {
        const snapshot = readDashboardNoticeSnapshot();
        if (!snapshot || snapshot.lastDashboardNoticeId !== noticeId || snapshot.lastDashboardNoticeSeenAt) return;
        const updated = { ...snapshot, lastDashboardNoticeSeenAt:new Date().toISOString() };
        writeDashboardNoticeSnapshot(updated);
        const card = $("driverStatusCard");
        if (card) card.dataset.noticeSeen = "true";
      } catch (error) {
        reportDashboardNoticeError("MARK_NOTICE_AS_SEEN", "DASHBOARD_NOTICE_MARK_SEEN_FAILED", error, { functionName:"markDashboardNoticeAsSeen", noticeId });
      }
    }

    function scheduleDashboardNoticeSeen(noticeId) {
      clearTimeout(dashboardNoticeSeenTimer);
      dashboardNoticeSeenTimer = setTimeout(() => {
        if (document.visibilityState === "visible") markDashboardNoticeAsSeen(noticeId);
      }, 900);
    }

    function applyDashboardNoticeSnapshot(snapshot, interactionResult = {}) {
      try {
        const card = $("driverStatusCard");
        if (!card || !snapshot) return;
        card.dataset.status = snapshot.visual;
        card.dataset.closureStatus = snapshot.dashboardNoticeType;
        card.dataset.layout = snapshot.layout;
        card.dataset.noticeId = snapshot.lastDashboardNoticeId;
        card.dataset.noticeType = snapshot.dashboardNoticeType;
        card.dataset.noticeSeen = snapshot.lastDashboardNoticeSeenAt ? "true" : "false";
        $("driverStatusIcon").innerHTML = statusIconMarkup(snapshot.visual);
        $("driverStatusActionIcon").innerHTML = statusIconMarkup(snapshot.visual === "ok" ? "ok" : "loading");
        $("driverStatusTitle").textContent = snapshot.title;
        $("driverStatusMessage").textContent = snapshot.message;
        $("driverStatusDetail").textContent = snapshot.detail;
        $("driverStatusActionTitle").textContent = snapshot.actionTitle;
        $("driverStatusActionMessage").textContent = snapshot.actionMessage;
        card.setAttribute("aria-label", snapshot.aria);
        configureWeeklyStatusInteraction(interactionResult?.status ? interactionResult : (snapshot.interaction || {}));
        window.ExploraDashboardNoticeState = snapshot;
        if (!snapshot.lastDashboardNoticeSeenAt) scheduleDashboardNoticeSeen(snapshot.lastDashboardNoticeId);
      } catch (error) {
        reportDashboardNoticeError("RENDER_DASHBOARD_NOTICE", "DASHBOARD_NOTICE_RENDER_FAILED", error, { functionName:"applyDashboardNoticeSnapshot", noticeId:snapshot?.lastDashboardNoticeId, noticeType:snapshot?.dashboardNoticeType, noticeSeen:Boolean(snapshot?.lastDashboardNoticeSeenAt) });
      }
    }

    function applyDerivationPendingDashboardNotice(){ return; }
    function setDashboardDerivationPending(){ dashboardDerivationPendingRows=[]; }
    function clearDashboardDerivationPending(){ dashboardDerivationPendingRows=[]; }
    window.ExploraDashboardNoticeController={setDerivationPending:setDashboardDerivationPending,clearDerivationPending:clearDashboardDerivationPending,getPending:()=>[]};

    function weeklyClosureTiming(referenceDate = (window.ExploraFirestoreClock?.isTrusted?.()?window.ExploraFirestoreClock.getNow():new Date())) {
      try {
        const parts = getArgentinaParts(referenceDate);
        const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
        const weekday = localDate.getUTCDay();
        const activePeriod = getActiveWeeklyPeriod(referenceDate);
        const saturdayAfterAutomaticClose = weekday === 6 && (parts.hour > 0 || parts.minute >= 5);
        const daysRemaining = saturdayAfterAutomaticClose ? 7 : (6 - weekday + 7) % 7;
        const closurePeriod = weekday === 6 ? getPreviousWeeklyPeriod(activePeriod) : activePeriod;
        return {
          daysRemaining,
          closesToday:weekday === 6 && !saturdayAfterAutomaticClose,
          todayKey:formatDateIdFromUTCDate(localDate),
          activePeriod,
          closurePeriod,
          safeArea:getComputedStyle(document.documentElement).getPropertyValue("--safe-area-bottom").trim() || "env(safe-area-inset-bottom)"
        };
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic("CALCULATE_DAYS_TO_CLOSE", "DAYS_TO_CLOSE_FAILED", error, { functionName:"weeklyClosureTiming" });
        const activePeriod = getActiveWeeklyPeriod(referenceDate);
        return { daysRemaining:0, closesToday:true, todayKey:activePeriod.id, activePeriod, closurePeriod:getPreviousWeeklyPeriod(activePeriod) };
      }
    }

    function weeklyClosureCountdownTitle(daysRemaining) {
      const days = Math.max(0, Math.round(Number(daysRemaining || 0)));
      if (days === 0) return "LA SEMANA CIERRA HOY";
      if (days === 1) return "FALTA 1 DÍA PARA EL CIERRE";
      return `FALTAN ${days} DÍAS PARA EL CIERRE`;
    }

    function prepareClosureDayPreview(result, timing) {
      if (!timing.closesToday) return result;
      const period = timing.closurePeriod || getPreviousWeeklyPeriod(timing.activePeriod);
      const preview = {
        ...result,
        status:"CLOSURE_DAY",
        clickable:true,
        isPreview:true,
        closureId:result.closureId || `weekly-preview-${period.id}`,
        weeklyPeriodId:result.weeklyPeriodId && result.weeklyPeriodId !== timing.activePeriod.id ? result.weeklyPeriodId : period.id,
        payer:null,
        payee:null,
        amount:0
      };
      Object.assign(closureState, {
        weeklyPeriodId:preview.weeklyPeriodId,
        closureId:preview.closureId,
        status:preview.status,
        clickable:true,
        statusData:preview
      });
      return preview;
    }

    function renderDriverStatusCard(inputResult = {}) {
      const card = $("driverStatusCard");
      if (!card) return;
      try {
        let result = { ...inputResult };
        const timing = weeklyClosureTiming();
        if ([CLOSURE_STATUS.NO_CLOSURE, CLOSURE_STATUS.DRIVER_UP_TO_DATE].includes(result.status)) {
          result = prepareClosureDayPreview(result, timing);
        }
        lastDashboardWeeklyStatusResult = result;
        const rawStatus = result.status || CLOSURE_STATUS.CLOSURE_LOADING;
        const frozenNotice = readDashboardNoticeSnapshot();
        if (![CLOSURE_STATUS.CLOSURE_LOADING,CLOSURE_STATUS.CLOSURE_ERROR,"CLOSURE_DAY"].includes(rawStatus)) {
          const canonical=getDriverWeeklyClosureStatus(result,auth.currentUser||{},result);
          card.dataset.status=canonical.colorState;card.dataset.closureStatus=canonical.code;card.dataset.layout="detail";
          $("driverStatusIcon").innerHTML=statusIconMarkup(canonical.colorState);
          $("driverStatusActionIcon").innerHTML=statusIconMarkup(canonical.colorState==="ok"?"ok":"loading");
          $("driverStatusTitle").textContent=canonical.label;$("driverStatusMessage").textContent=canonical.detail;$("driverStatusDetail").textContent=canonical.periodLabel||"";
          $("driverStatusActionTitle").textContent="";$("driverStatusActionMessage").textContent="";
          card.setAttribute("aria-label",`${canonical.label}. ${canonical.detail}`);configureWeeklyStatusInteraction(result);
          window.ExploraDriverWeeklyClosureCanonicalStatus=canonical;renderPendingClosureCard(canonical.isUpToDate?null:result);return;
        }

        if (rawStatus === CLOSURE_STATUS.CLOSURE_LOADING && frozenNotice) {
          applyDashboardNoticeSnapshot(frozenNotice, result);
          return;
        }

        let visual = "loading";
        const layout = "detail";
        let title = "COMPROBANDO CIERRE";
        let message = "Espera un momento…";
        let detail = "";
        const actionTitle = "";
        const actionMessage = "";
        let aria = "Comprobando estado del cierre semanal";

        if ([CLOSURE_STATUS.NO_CLOSURE, CLOSURE_STATUS.DRIVER_UP_TO_DATE].includes(rawStatus)) {
          visual = "upcoming";
          title = weeklyClosureCountdownTitle(timing.daysRemaining);
          message = "El cierre semanal se hace todos los sábados.";
          detail = timing.daysRemaining > 1 ? "Seguí registrando tus movimientos con normalidad." : "Mañana podrás ver quién debe pagar.";
          aria = `${title}. ${message}`;
        } else if (rawStatus === "CLOSURE_DAY") {
          visual = "upcoming";
          title = "LA SEMANA CIERRA HOY";
          message = "Tocá para ver quién debe pagar.";
          detail = "";
          aria = "La semana cierra hoy. Abrir cierre semanal.";
        } else if (rawStatus === CLOSURE_STATUS.DRIVER_MUST_PAY_PENDING) {
          visual = "pending";
          title = "DEBÉS PAGARLE A DAVID";
          message = "Tocá para subir el comprobante.";
          detail = result.amount > 0 ? formatClosureMoney(result.amount) : "";
          aria = "Debés resolver tu cierre semanal. Abrir detalle.";
        } else if (rawStatus === CLOSURE_STATUS.DRIVER_MUST_PAY_OVERDUE) {
          visual = "overdue";
          title = "DEBÉS PAGARLE A DAVID";
          message = "Tocá para subir el comprobante.";
          detail = result.amount > 0 ? formatClosureMoney(result.amount) : "";
          aria = "Cierre abierto. Abrir detalle.";
        } else if (rawStatus === CLOSURE_STATUS.DRIVER_RECEIPT_UPLOADED) {
          visual = result.receiptStatus === "review" ? "review" : "paid";
          title = "CIERRE COMPLETADO";
          message = "Pago comprobado.";
          detail = "Tocá para ver el cierre y el comprobante.";
          aria = `${title}. Abrir cierre semanal.`;
        } else if (rawStatus === CLOSURE_STATUS.BALANCED_CLOSURE) {
          visual = "balanced";
          title = "CUENTA EQUILIBRADA";
          message = "Cierre confirmado.";
          detail = "No se necesita comprobante.";
          aria = "Cuenta equilibrada. Cierre confirmado. No se necesita comprobante.";
        } else if (rawStatus === CLOSURE_STATUS.BALANCED_RECEIPT_UPLOADED) {
          visual = "paid";
          title = "CIERRE COMPLETADO";
          message = "Comprobante recibido.";
          detail = "Cuenta equilibrada.";
          aria = "Cierre completado. Comprobante recibido.";
        } else if (rawStatus === CLOSURE_STATUS.DAVID_MUST_PAY_PENDING) {
          visual = "david-pending";
          title = "DAVID DEBE PAGARTE";
          message = "Tocá para ver el detalle.";
          detail = result.amount > 0 ? formatClosureMoney(result.amount) : "Pago pendiente de David.";
          aria = "David debe pagarte. Abrir detalle del cierre.";
        } else if (rawStatus === CLOSURE_STATUS.DAVID_RECEIPT_UPLOADED) {
          visual = "paid";
          title = "CIERRE COMPLETADO";
          message = "Pago comprobado.";
          detail = "Tocá para ver el resumen y el comprobante.";
          aria = "Pago de David registrado. Abrir detalle.";
        } else if (rawStatus === CLOSURE_STATUS.CLOSURE_ERROR) {
          /* No reutilizar un aviso congelado de AL DÍA cuando el cálculo actual falló. */
          visual = "error";
          title = "NO SE PUDO CALCULAR EL CIERRE";
          message = "No mostramos AL DÍA hasta validar todos los movimientos.";
          detail = "Tocá para reintentar y abrir el detalle.";
          aria = "No se pudo calcular el cierre semanal. Tocá para reintentar.";
          result.clickable = true;
          showWeeklyClosureSummaryDiagnostic("RENDER_STATUS_CARD", "STATUS_CARD_RENDER_FAILED", result.error || new Error("No se pudo calcular el cierre"), { functionName:"renderDriverStatusCard", weeklyPeriodId:result.weeklyPeriodId, firestorePath:"cierres_semanales", query:"resolveWeeklyClosureStatus(uid, weeklyPeriodId)" });
        }

        if (rawStatus === CLOSURE_STATUS.CLOSURE_LOADING) {
          card.dataset.status = visual;
          card.dataset.closureStatus = rawStatus;
          card.dataset.layout = layout;
          $("driverStatusIcon").innerHTML = statusIconMarkup(visual);
          $("driverStatusActionIcon").innerHTML = statusIconMarkup("loading");
          $("driverStatusTitle").textContent = title;
          $("driverStatusMessage").textContent = message;
          $("driverStatusDetail").textContent = detail;
          $("driverStatusActionTitle").textContent = actionTitle;
          $("driverStatusActionMessage").textContent = actionMessage;
          card.setAttribute("aria-label", aria);
          configureWeeklyStatusInteraction(result);
          return;
        }

        const noticeId = buildDashboardNoticeId(result, rawStatus);
        const interaction = { status:rawStatus, clickable:Boolean(result.clickable), closureId:result.closureId || "", weeklyPeriodId:result.weeklyPeriodId || "", amount:Number(result.amount||0), isPreview:Boolean(result.isPreview) };
        if (frozenNotice && frozenNotice.lastDashboardNoticeId === noticeId) {
          applyDashboardNoticeSnapshot({ ...frozenNotice, interaction }, result);
          return;
        }
        const snapshot = {
          lastDashboardNoticeId:noticeId,lastDashboardNoticeSeenAt:null,dashboardNoticeVersion:DASHBOARD_NOTICE_VERSION,
          dashboardNoticeType:rawStatus,visual,layout,title,message,detail,actionTitle,actionMessage,aria,interaction,createdAt:new Date().toISOString()
        };
        writeDashboardNoticeSnapshot(snapshot);
        applyDashboardNoticeSnapshot(snapshot, result);
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic("RENDER_STATUS_CARD", "STATUS_CARD_RENDER_FAILED", error, { functionName:"renderDriverStatusCard", weeklyPeriodId:inputResult.weeklyPeriodId, firestorePath:"DOM#driverStatusCard", query:"render weekly closure status" });
      }
    }

    function normalizeClosureText(value) { return String(value || "").trim().toLowerCase(); }
    function closureNumber(data, keys) {
      for (const key of keys) {
        const value = data && data[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string" && value.trim()) {
          const numeric = Number(value.replace(/[^\d,-]/g, "").replace(/\./g, "").replace(",", "."));
          if (Number.isFinite(numeric)) return numeric;
        }
      }
      return 0;
    }
    function firestoreDateMs(value) {
      if (!value) return 0;
      if (typeof value.toDate === "function") return value.toDate().getTime();
      if (value instanceof Date) return value.getTime();
      if (typeof value === "number") return value;
      const parsed = Date.parse(String(value));
      return Number.isFinite(parsed) ? parsed : 0;
    }
    function parseArgentinaDateTime(dateText, timeText = "00:00") {
      const date = String(dateText || "").slice(0,10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
      const time = /^\d{1,2}:\d{2}/.test(String(timeText || "")) ? String(timeText).slice(0,5) : "00:00";
      const parsed = Date.parse(`${date}T${time}:00-03:00`);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    function formatArgentinaDateTime(ms) {
      if (!ms) return "—";
      return new Intl.DateTimeFormat("es-AR", {
        timeZone: "America/Argentina/Cordoba",
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
      }).format(new Date(ms));
    }
    function formatIsoDateInArgentina(ms) {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Cordoba", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
    }
    function closurePeriodAliases(period) {
      if (!period) return [];
      const start = formatIsoDateInArgentina(period.startMs);
      const end = formatIsoDateInArgentina(period.endMs);
      return Array.from(new Set([period.id, start, `${start}_${end}`].filter(Boolean)));
    }
    function closureClosedAtMs(data = {}, payment = {}) {
      for (const key of ["cerradoEn","closedAt","fechaCierreTimestamp","actualizado","actualizadoEn","creadoEn"]) {
        const ms = firestoreDateMs(data[key]);
        if (ms) return ms;
      }
      const paymentMs = firestoreDateMs(payment.creadoEn || payment.actualizado || payment.updatedAt);
      if (paymentMs) return paymentMs;
      const confirmed = parseArgentinaDateTime(data.fechaConfirmacion, data.horaConfirmacion);
      if (confirmed) return confirmed;
      const required = parseArgentinaDateTime(data.cierreObligatorio, "00:00");
      if (required) return required;
      const periodEnd = String(data.periodoFin || "").slice(0,10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
        const end = parseArgentinaDateTime(periodEnd, "00:00");
        return end ? end + 24 * 60 * 60 * 1000 : 0;
      }
      return 0;
    }
    function receiptUploadedAtMs(data = {}) {
      for (const key of ["uploadedAt","comprobanteCargadoEn","davidReceiptUploadedAt","actualizado","actualizadoEn","fechaPagoTimestamp"]) {
        const ms = firestoreDateMs(data[key]);
        if (ms) return ms;
      }
      return parseArgentinaDateTime(data.fechaPago, data.horaPago);
    }
    function closureDirection(closure = {}, payment = {}) {
      const canonical = window.ExploraCanonicalWeeklyClosure?.resolveDirection?.(closure, payment);
      if (canonical === "driver_to_admin") return "chofer_a_david";
      if (canonical === "admin_to_driver") return "david_a_chofer";
      if (canonical === "balanced") return "sin_diferencia";
      if (canonical === "requires_rebuild" || canonical === "invalid_snapshot") return canonical;
      const merged = { ...closure, ...payment };
      const signed = Number(merged.netSettlementToDriver ?? closure.netSettlementToDriver ?? payment.netSettlementToDriver);
      if (Number.isFinite(signed)) return signed > 0 ? "david_a_chofer" : signed < 0 ? "chofer_a_david" : "sin_diferencia";
      const payer = normalizeClosureText(merged.payerRole || merged.payer);
      const payee = normalizeClosureText(merged.payeeRole || merged.payee);
      if ((payer === "admin" || payer === "david") && (payee === "driver" || payee === "chofer")) return "david_a_chofer";
      if ((payer === "driver" || payer === "chofer") && (payee === "admin" || payee === "david")) return "chofer_a_david";
      const raw = normalizeClosureText(merged.direction || merged.sentido || merged.direccionPago || merged.closureDirection).replace(/[\s-]+/g,"_");
      if (["chofer_a_david","driver_to_david","driver_to_admin","chofer_paga"].includes(raw)) return "chofer_a_david";
      if (["david_a_chofer","david_to_driver","admin_to_driver","david_paga"].includes(raw)) return "david_a_chofer";
      if (["balanced","sin_diferencia","equilibrado","cuenta_equilibrada"].includes(raw)) return "sin_diferencia";
      const driverDebt = closureNumber(merged, ["choferDebe","driverOwes","deudaChofer"]);
      const davidDebt = closureNumber(merged, ["davidDebe","davidOwes","deudaDavid"]);
      if (driverDebt > 0 && davidDebt > 0) return "invalid_snapshot";
      if (driverDebt > 0) return "chofer_a_david";
      if (davidDebt > 0) return "david_a_chofer";
      return "requires_rebuild";
    }
    function closureAmount(closure = {}, payment = {}, direction = closureDirection(closure, payment)) {
      const signed = Number(payment.netSettlementToDriver ?? closure.netSettlementToDriver ?? closure.weeklySnapshot?.netSettlementToDriver);
      if (Number.isFinite(signed)) return Math.abs(Math.round(signed));
      if (direction === "chofer_a_david") return Math.abs(closureNumber(closure, ["choferDebe","settlementAmount"]) || closureNumber(payment, ["monto","importe","amount","settlementAmount"]));
      if (direction === "david_a_chofer") return Math.abs(closureNumber(closure, ["davidDebe","settlementAmount"]) || closureNumber(payment, ["monto","importe","amount","settlementAmount"]));
      if (direction === "sin_diferencia") return 0;
      return NaN;
    }
    function closureReceiptUrl(closure = {}, payment = {}) {
      const direction = closureDirection(closure, payment);
      const merged = { ...closure, ...payment, payerRole: direction === "david_a_chofer" ? "admin" : direction === "chofer_a_david" ? "driver" : (payment.payerRole || closure.payerRole) };
      return String(window.ExploraReceiptEngine?.resolveReceiptSource?.(merged)?.url || "").trim();
    }
    function closureReceiptPath(closure = {}, payment = {}) {
      const direction = closureDirection(closure, payment);
      const merged = { ...closure, ...payment, payerRole: direction === "david_a_chofer" ? "admin" : direction === "chofer_a_david" ? "driver" : (payment.payerRole || closure.payerRole) };
      return String(window.ExploraReceiptEngine?.resolveReceiptSource?.(merged)?.path || "").trim();
    }
    function closureReceiptStatus(closure = {}, payment = {}) {
      const raw = normalizeClosureText(payment.estadoComprobante || payment.comprobanteEstado || payment.receiptStatus || closure.estadoComprobante || closure.receiptStatus);
      if (raw.includes("revision") || raw.includes("revisión") || raw.includes("pendiente_aprobacion")) return "review";
      if (raw.includes("rechaz")) return "rejected";
      if (payment.pagado === true || payment.pagoConfirmado === true || raw.includes("aprob") || raw.includes("confirm")) return "accepted";
      return closureReceiptUrl(closure, payment) ? "uploaded" : "missing";
    }
    function resolvePerformanceEligibility(closure = {}, payment = {}, nowMs = (window.ExploraFirestoreClock?.isTrusted?.() ? window.ExploraFirestoreClock.getNowMs() : NaN)) {
      const direction = closureDirection(closure, payment);
      const closedAt = closureClosedAtMs(closure, payment);
      const deadline = firestoreDateMs(payment.receiptDeadline || closure.receiptDeadline) || (closedAt ? closedAt + 24 * 60 * 60 * 1000 : 0);
      const receiptAt = receiptUploadedAtMs(payment) || receiptUploadedAtMs(closure);
      const receiptUrl = closureReceiptUrl(closure, payment);
      const explicit = payment.performanceEligible ?? payment.legacyPerformanceEligibility ?? closure.performanceEligible ?? closure.legacyPerformanceEligibility;
      if (direction !== "chofer_a_david") return { eligible: true, deadline, receiptAt, reason: "payer_is_not_driver" };
      if (explicit === false) return { eligible: false, deadline, receiptAt, reason: payment.performanceIneligibilityReason || closure.performanceIneligibilityReason || "receipt_not_uploaded_within_24h" };
      if (receiptUrl || payment.pagado === true || payment.pagoConfirmado === true) {
        const within = !deadline || !receiptAt || receiptAt <= deadline;
        return { eligible: explicit === true ? true : within, deadline, receiptAt, reason: within ? "receipt_uploaded_on_time" : "receipt_uploaded_late" };
      }
      if (deadline && nowMs > deadline) return { eligible: false, deadline, receiptAt: 0, reason: "receipt_not_uploaded_within_24h" };
      return { eligible: true, provisional: true, deadline, receiptAt: 0, reason: "receipt_pending_within_deadline" };
    }

    function closureBelongsToSession(data = {}, session = {}) {
      const values = [data.choferUid,data.uid,data.userUid,data.choferId,data.chofer,data.usuario,data.driverId,data.conductorId,data.email,data.correo]
        .map(value => normalizeClosureText(value));
      const identities = [session.uid, session.profileDocumentId, exploraSession.driverId, session.user?.email]
        .map(value => normalizeClosureText(value)).filter(Boolean);
      return identities.some(identity => values.includes(identity));
    }
    function closurePeriodId(data = {}) { return String(data.periodoSemanalId || data.weeklyPeriodId || data.periodoId || data.semanaId || data.periodo || data.semana || "").trim(); }
    function closureRecordTime(data = {}) { return closureClosedAtMs(data, data.pagoSemanal || {}) || firestoreDateMs(data.actualizadoEn || data.actualizado || data.creadoEn); }

    async function readDirectDocument(collectionName, id) {
      if (!id) return null;
      try {
        const snap = await getDoc(doc(db, collectionName, id));
        return snap.exists() ? { id: snap.id, collection: collectionName, data: snap.data() || {} } : null;
      } catch (_) { return null; }
    }
    async function readOwnedDocuments(collectionName, session, fields = []) {
      const merged = new Map();
      const probes = fields.map((field) => [
        field,
        field.toLowerCase().includes("uid") ? session.uid : session.profileDocumentId || exploraSession.driverId
      ]).filter(([, value]) => Boolean(value));
      const settled = await Promise.allSettled(probes.map(([field, value]) =>
        getDocs(query(collection(db, collectionName), where(field, "==", value), limit(25)))
      ));
      settled.forEach((result) => {
        if (result.status !== "fulfilled") return;
        result.value.forEach(item => merged.set(item.id, { id: item.id, collection: collectionName, data: item.data() || {} }));
      });
      return Array.from(merged.values());
    }

    async function loadClosureAndPaymentForProfile(currentWeeklyPeriodId = "") {
      const session=await getAuthenticatedSession({timeoutMs:4500});
      const active=getActiveWeeklyPeriod();const previous=getPreviousWeeklyPeriod(active);
      const periods=[previous,active];
      const driverId=session.profileDocumentId||exploraSession.driverId||"";
      const directIds=[];
      periods.forEach(period=>{ if(driverId)directIds.push(`${driverId}_${period.id}`); if(session.uid)directIds.push(`${session.uid}_${period.id}`); });
      const directReads=[];
      directIds.forEach(id=>{
        directReads.push(readDirectDocument("cierres_semanales",id));
        directReads.push(readDirectDocument("pagos_semanales",id));
      });
      const direct=await Promise.all(directReads);
      const closureMap=new Map(),paymentMap=new Map();
      direct.filter(Boolean).forEach(record=>(record.collection==="cierres_semanales"?closureMap:paymentMap).set(record.id,record));

      if(!closureMap.size&&!paymentMap.size){
        const [ownedClosures,ownedPayments]=await Promise.all([
          readOwnedDocuments("cierres_semanales",session,["choferUid","uid","choferId"]),
          readOwnedDocuments("pagos_semanales",session,["choferUid","uid","choferId"])
        ]);
        ownedClosures.forEach(record=>closureMap.set(record.id,record));
        ownedPayments.forEach(record=>paymentMap.set(record.id,record));
      }
      const allowed=new Set(periods.flatMap(closurePeriodAliases).concat(periods.map(p=>p.id),currentWeeklyPeriodId).filter(Boolean));
      const closures=Array.from(closureMap.values()).filter(r=>closureBelongsToSession(r.data,session)&&(!closurePeriodId(r.data)||allowed.has(closurePeriodId(r.data))));
      const payments=Array.from(paymentMap.values()).filter(r=>closureBelongsToSession(r.data,session)&&(!closurePeriodId(r.data)||allowed.has(closurePeriodId(r.data))));
      /* El sábado y durante toda la semana nueva, el cierre accionable pertenece a la semana anterior.
         Nunca permitir que un documento vacío de la semana activa oculte el cierre anterior. */
      const periodPriority = record => {
        const recordPeriod = closurePeriodId(record?.data || {});
        if (recordPeriod === previous.id) return 0;
        if (recordPeriod === active.id) return 1;
        return 2;
      };
      closures.sort((a,b)=>periodPriority(a)-periodPriority(b)||closureRecordTime(b.data)-closureRecordTime(a.data));
      payments.sort((a,b)=>periodPriority(a)-periodPriority(b)||closureRecordTime(b.data)-closureRecordTime(a.data));
      const previousClosure=closures.find(r=>closurePeriodId(r.data)===previous.id)||null;
      const previousPayment=payments.find(r=>closurePeriodId(r.data)===previous.id)||null;
      const closureRecord=previousClosure||closures[0]||null;
      const targetPeriod=closureRecord?closurePeriodId(closureRecord.data):(previousPayment?previous.id:(payments[0]?closurePeriodId(payments[0].data):""));
      const paymentRecord=payments.find(r=>!targetPeriod||closurePeriodId(r.data)===targetPeriod)||previousPayment||payments[0]||null;
      return{session,closureRecord,paymentRecord,periodAliases:Array.from(allowed),targetPeriod};
    }

    async function resolveWeeklyClosureStatus(uid, currentWeeklyPeriodId = "") {
      if (!uid) throw new Error("AUTH_SESSION_MISSING");
      const loaded=await loadClosureAndPaymentForProfile(currentWeeklyPeriodId),closureRecord=loaded.closureRecord,paymentRecord=loaded.paymentRecord;
      if(!closureRecord&&!paymentRecord){
        /* No declarar AL DÍA por ausencia de un documento guardado. Reconstruir la semana anterior
           desde billing_records y todas las fuentes financieras autoritativas. */
        const active=getActiveWeeklyPeriod();
        const previous=getPreviousWeeklyPeriod(active);
        try{
          const snapshot=await window.ExploraCanonicalWeeklyClosure?.buildCanonicalWeeklyClosureSnapshot?.(uid,previous.id,{closedAt:getNow?.().toISOString?.()});
          if(snapshot&&snapshot.snapshotComplete===true){
            const signed=Number(snapshot.netSettlementToDriver);
            if(!Number.isFinite(signed))throw new Error("WEEKLY_CLOSURE_SIGNED_BALANCE_MISSING");
            const amount=Math.abs(Math.round(signed));
            const payer=signed<0?"driver":signed>0?"admin":null;
            const status=signed<0?CLOSURE_STATUS.DRIVER_MUST_PAY_PENDING:signed>0?CLOSURE_STATUS.DAVID_MUST_PAY_PENDING:CLOSURE_STATUS.BALANCED_CLOSURE;
            return{status,clickable:true,closureId:`${uid}_${previous.id}`,closureCollection:"cierres_semanales",closureRecord:null,paymentId:null,paymentRecord:null,closure:{...snapshot,weeklyPeriodId:previous.id,periodId:previous.id},payment:{},weeklyPeriodId:previous.id,payer,payee:payer==="driver"?"admin":payer==="admin"?"driver":null,amount,closedAt:snapshot.closedAt||null,receiptDeadline:null,receiptStatus:"missing",receiptUrl:"",receiptPath:"",performanceEligibility:true,reason:"rebuilt_authoritatively",weeklySnapshot:snapshot,snapshotComplete:true,normalizedBalance:signed};
          }
        }catch(error){
          console.warn("[EXPLORA closure] authoritative rebuild failed",error?.code||error?.message||error);
          return{status:CLOSURE_STATUS.CLOSURE_ERROR,clickable:true,closureId:null,weeklyPeriodId:previous.id,payer:null,payee:null,amount:0,closedAt:null,receiptDeadline:null,receiptStatus:null,receiptUrl:null,receiptPath:null,performanceEligibility:true,reason:"authoritative_rebuild_failed",calculationError:true,error,weeklySnapshot:null};
        }
        return{status:CLOSURE_STATUS.CLOSURE_ERROR,clickable:true,closureId:null,weeklyPeriodId:previous.id,payer:null,payee:null,amount:0,closedAt:null,receiptDeadline:null,receiptStatus:null,receiptUrl:null,receiptPath:null,performanceEligibility:true,reason:"closed_period_snapshot_missing",calculationError:true,weeklySnapshot:null};
      }
      const closure=closureRecord?.data||{},payment={...(closure.pagoSemanal||{}),...(paymentRecord?.data||{})},storedDirection=closureDirection(closure,payment),storedAmount=closureAmount(closure,payment,storedDirection),closedAt=closureClosedAtMs(closure,payment),eligibility=resolvePerformanceEligibility(closure,payment,(window.ExploraFirestoreClock?.isTrusted?.()?window.ExploraFirestoreClock.getNowMs():NaN)),receiptStatus=closureReceiptStatus(closure,payment),receiptUrl=closureReceiptUrl(closure,payment),receiptPresent=Boolean(receiptUrl||["accepted","review","uploaded"].includes(receiptStatus)),paymentResolved=receiptPresent,periodId=closurePeriodId(closure)||closurePeriodId(payment)||loaded.targetPeriod||currentWeeklyPeriodId;
      const engineState=window.ExploraWeeklyEngine?.getState?.()||{},weeklySnapshot=engineState.weeklyPeriodId===periodId?(engineState.snapshot||engineState):null;
      const preferredSnapshot=weeklySnapshot||closure.weeklySnapshot||closure;
      const normalizedStored=window.ExploraCanonicalWeeklyClosure?.normalizeLegacyWeeklyClosure?.({...closure,...payment,weeklySnapshot:preferredSnapshot})||null;
      function firstFinite(...values){for(const value of values){const n=Number(value);if(Number.isFinite(n))return n}return NaN}
      function deriveStoredSignedBalance(){
        const direct=firstFinite(
          preferredSnapshot?.netSettlementToDriver,closure.netSettlementToDriver,payment.netSettlementToDriver,
          closure.saldoNetoChofer,payment.saldoNetoChofer,closure.balanceToDriver,payment.balanceToDriver
        );
        if(Number.isFinite(direct))return Math.round(direct);
        const driverDebt=firstFinite(closure.choferDebe,payment.choferDebe,closure.driverOwes,payment.driverOwes);
        const adminDebt=firstFinite(closure.davidDebe,payment.davidDebe,closure.adminOwes,payment.adminOwes);
        if(Number.isFinite(driverDebt)&&driverDebt>0)return-Math.round(driverDebt);
        if(Number.isFinite(adminDebt)&&adminDebt>0)return Math.round(adminDebt);
        const payerToken=String(closure.payerRole||closure.payer||payment.payerRole||payment.payer||"").toLowerCase();
        const declaredAmount=firstFinite(closure.settlementAmount,payment.settlementAmount,closure.amount,payment.amount,storedAmount);
        if(Number.isFinite(declaredAmount)&&declaredAmount>0){if(/driver|chofer/.test(payerToken))return-Math.round(declaredAmount);if(/admin|david/.test(payerToken))return Math.round(declaredAmount)}
        const gross=firstFinite(
          preferredSnapshot?.grossBilling,closure.grossBilling,closure.totalBilling,closure.facturacionTotal,closure.totalFacturado,
          payment.grossBilling,payment.facturacionTotal,payment.totalFacturado
        );
        const cash=firstFinite(
          preferredSnapshot?.cashCollectedByDriver,closure.cashCollectedByDriver,closure.efectivo,closure.totalEfectivo,
          closure.cashTotal,payment.cashCollectedByDriver,payment.efectivo,payment.totalEfectivo
        );
        if(!(Number.isFinite(gross)&&gross>=0&&Number.isFinite(cash)&&cash>=0))return NaN;
        const driverShare=gross*.5;
        const driverCredits=[preferredSnapshot?.driverExpenseCredit,closure.driverExpenseCredit,closure.gastosPagadosChofer,payment.driverExpenseCredit,preferredSnapshot?.derivationBonusAmount,closure.derivationBonusAmount].reduce((sum,v)=>sum+(Number.isFinite(Number(v))?Number(v):0),0);
        const driverDebits=[preferredSnapshot?.directDebtInstallmentTotal,closure.directDebtInstallmentTotal,closure.cuotaDeudaChofer,payment.directDebtInstallmentTotal,preferredSnapshot?.exploreLoanDiscount,closure.exploreLoanDiscount,closure.descuentoPrestamoExplora,payment.exploreLoanDiscount,preferredSnapshot?.collaborationAmount,closure.collaborationAmount].reduce((sum,v)=>sum+(Number.isFinite(Number(v))?Number(v):0),0);
        return Math.round(driverShare+driverCredits-driverDebits-cash);
      }
      let signedCandidate=Number(preferredSnapshot?.netSettlementToDriver ?? normalizedStored?.netSettlementToDriver);
      if(!Number.isFinite(signedCandidate))signedCandidate=deriveStoredSignedBalance();
      const snapshotHasSigned=Number.isFinite(signedCandidate);
      const snapshotBalanced=snapshotHasSigned&&signedCandidate===0&&preferredSnapshot?.snapshotComplete!==false;
      const effectiveDirection=snapshotHasSigned?(signedCandidate>0?"david_a_chofer":signedCandidate<0?"chofer_a_david":"sin_diferencia"):(normalizedStored?.requiresRebuild?"requires_rebuild":storedDirection);
      const amount=snapshotHasSigned?Math.abs(Math.round(signedCandidate)):(Number.isFinite(storedAmount)?storedAmount:0);
      /* Una dirección desconocida es un error de cálculo, nunca una cuenta equilibrada. */
      let status=CLOSURE_STATUS.CLOSURE_ERROR;
      if(effectiveDirection==="sin_diferencia") status=receiptPresent?CLOSURE_STATUS.BALANCED_RECEIPT_UPLOADED:CLOSURE_STATUS.BALANCED_CLOSURE;
      else if(effectiveDirection==="chofer_a_david"){if(paymentResolved)status=CLOSURE_STATUS.DRIVER_RECEIPT_UPLOADED;else if(eligibility.eligible===false)status=CLOSURE_STATUS.DRIVER_MUST_PAY_OVERDUE;else status=CLOSURE_STATUS.DRIVER_MUST_PAY_PENDING;}
      else if(effectiveDirection==="david_a_chofer")status=paymentResolved?CLOSURE_STATUS.DAVID_RECEIPT_UPLOADED:CLOSURE_STATUS.DAVID_MUST_PAY_PENDING;
      const resolvedSnapshot=snapshotHasSigned?{...(weeklySnapshot||preferredSnapshot||{}),netSettlementToDriver:Math.round(signedCandidate),settlementAmount:amount,payerRole:effectiveDirection==="chofer_a_david"?"driver":effectiveDirection==="david_a_chofer"?"admin":null,payeeRole:effectiveDirection==="chofer_a_david"?"admin":effectiveDirection==="david_a_chofer"?"driver":null,balanced:effectiveDirection==="sin_diferencia",snapshotComplete:true,snapshotValidated:true,periodId,weeklyPeriodId:periodId}:weeklySnapshot;
      return{status,clickable:true,closureId:closureRecord?.id||paymentRecord?.id||null,closureCollection:closureRecord?.collection||"cierres_semanales",closureRecord,paymentId:paymentRecord?.id||null,paymentRecord,closure:{...closure,...(snapshotHasSigned?{netSettlementToDriver:Math.round(signedCandidate),settlementAmount:amount,payerRole:effectiveDirection==="chofer_a_david"?"driver":effectiveDirection==="david_a_chofer"?"admin":null,payeeRole:effectiveDirection==="chofer_a_david"?"admin":effectiveDirection==="david_a_chofer"?"driver":null,balanced:effectiveDirection==="sin_diferencia"}:{})},payment,weeklyPeriodId:periodId,payer:effectiveDirection==="chofer_a_david"?"driver":effectiveDirection==="david_a_chofer"?"admin":null,payee:effectiveDirection==="chofer_a_david"?"admin":effectiveDirection==="david_a_chofer"?"driver":null,amount,closedAt,receiptDeadline:eligibility.deadline||null,receiptStatus:receiptStatus==="review"?"review":receiptPresent?"uploaded":"missing",receiptUrl,receiptPath:closureReceiptPath(closure,payment),performanceEligibility:eligibility.eligible,reason:snapshotHasSigned?"stored_snapshot_recovered":eligibility.reason,weeklySnapshot:resolvedSnapshot,snapshotComplete:snapshotHasSigned,normalizedBalance:snapshotHasSigned?Math.round(signedCandidate):null};
    }

    async function persistOverdueEligibility(statusData) {
      if (!statusData || statusData.status !== CLOSURE_STATUS.DRIVER_MUST_PAY_OVERDUE) return;
      const payload = {
        performanceEligible: false,
        legacyPerformanceEligibility: false,
        performanceIneligibilityReason: "receipt_not_uploaded_within_24h",
        receiptDeadline: statusData.receiptDeadline ? new Date(statusData.receiptDeadline).toISOString() : null,
        eligibilityUpdatedAt: serverTimestamp(),
        closureId: statusData.closureId || null,
        weeklyPeriodId: statusData.weeklyPeriodId || null
      };
      const writes = [];
      if (statusData.closureRecord?.id) writes.push(setDoc(doc(db, statusData.closureRecord.collection, statusData.closureRecord.id), payload, { merge: true }));
      if (statusData.paymentRecord?.id) writes.push(setDoc(doc(db, statusData.paymentRecord.collection, statusData.paymentRecord.id), payload, { merge: true }));
      await Promise.allSettled(writes);
    }

    async function reconcileExpiredClosureReceipts() {
      const user = auth.currentUser;
      if (!user?.uid) return null;
      const active = getActiveWeeklyPeriod();
      const result = await resolveWeeklyClosureStatus(user.uid, active.id);
      if (result.status === CLOSURE_STATUS.DRIVER_MUST_PAY_OVERDUE) {
        await persistOverdueEligibility(result);
      }
      return result;
    }
    window.ExploraReconcileExpiredClosureReceipts = reconcileExpiredClosureReceipts;

    function applyClosureState(result) {
      Object.assign(closureState, {
        uid: auth.currentUser?.uid || null,
        weeklyPeriodId: result.weeklyPeriodId || null,
        closureId: result.closureId || null,
        closureCollection: result.closureCollection || "cierres_semanales",
        closure: result.closure || null,
        paymentId: result.paymentId || null,
        payment: result.payment || null,
        status: result.status || CLOSURE_STATUS.CLOSURE_LOADING,
        clickable: Boolean(result.clickable),
        performanceEligible: result.performanceEligibility !== false,
        receiptDeadline: result.receiptDeadline || null,
        amount: Number(result.amount || 0),
        error: result.error || null,
        statusData: result
      });
      window.ExploraWeeklyEngine?.attachClosure?.(result);
    }

    function clearWeeklyClosureCache() {
      weeklyClosureCache.uid = null;
      weeklyClosureCache.activeWeeklyPeriodId = null;
      weeklyClosureCache.data = null;
      weeklyClosureCache.loadedAt = null;
      weeklyClosureCache.dirty = true;
      weeklyClosureCache.dirtyReason = "cleared";
      weeklyClosureCache.loadPromise = null;
    }

    function invalidateWeeklyClosureCache(reason = "data-changed", { refresh = false } = {}) {
      weeklyClosureCache.dirty = true;
      weeklyClosureCache.dirtyReason = reason;
      if (refresh && auth.currentUser?.uid) refreshDriverPaymentStatus({ force: true }).catch(() => {});
    }
    window.ExploraInvalidateWeeklyClosure = invalidateWeeklyClosureCache;

    async function refreshDriverPaymentStatus({ force = false } = {}) {
      const session = await getAuthenticatedSession({ timeoutMs: 6000 });
      const active = getActiveWeeklyPeriod();
      const cacheMatches = weeklyClosureCache.uid === session.uid && weeklyClosureCache.activeWeeklyPeriodId === active.id;
      if (!force && cacheMatches && weeklyClosureCache.data && !weeklyClosureCache.dirty) {
        applyClosureState(weeklyClosureCache.data);
        renderPendingClosureCard([CLOSURE_STATUS.DRIVER_MUST_PAY_PENDING,CLOSURE_STATUS.DRIVER_MUST_PAY_OVERDUE].includes(weeklyClosureCache.data.status) ? weeklyClosureCache.data : null);
        renderDriverStatusCard(weeklyClosureCache.data);
        return weeklyClosureCache.data;
      }
      if (weeklyClosureCache.loadPromise) return weeklyClosureCache.loadPromise;
      if (!weeklyClosureCache.data) renderDriverStatusCard({ status: CLOSURE_STATUS.CLOSURE_LOADING, clickable: false });

      weeklyClosureCache.loadPromise = (async () => {
        try {
          const result = await profileWithTimeout(resolveWeeklyClosureStatus(session.uid, active.id), 12000, "PAYMENT_STATUS_TIMEOUT");
          weeklyClosureCache.uid = session.uid;
          weeklyClosureCache.activeWeeklyPeriodId = active.id;
          weeklyClosureCache.data = result;
          weeklyClosureCache.loadedAt = Date.now();
          weeklyClosureCache.dirty = false;
          storeWeeklyClosureSessionCache(result);
          applyClosureState(result);
          renderPendingClosureCard([CLOSURE_STATUS.DRIVER_MUST_PAY_PENDING,CLOSURE_STATUS.DRIVER_MUST_PAY_OVERDUE].includes(result.status) ? result : null);
          renderDriverStatusCard(result);
          if (result.status === CLOSURE_STATUS.DRIVER_MUST_PAY_OVERDUE) {
            persistOverdueEligibility(result).catch(() => {});
          }
          return result;
        } catch (error) {
          console.warn("[EXPLORA cierre] carga", error?.code || error?.message);

          if (isPaymentStatusTimeout(error)) {
            const fallback = stableDashboardNoticeFallback(active, error, { allowStored: !force });
            const safeResult = fallback.result;

            reportDashboardNoticeError(
              "READ_DASHBOARD_NOTICE",
              "PAYMENT_STATUS_TIMEOUT",
              error,
              {
                functionName:"refreshDriverPaymentStatus",
                weeklyPeriodId:active.id,
                firestorePath:"cierres_semanales",
                query:"resolveWeeklyClosureStatus(uid, weeklyPeriodId)",
                fallbackUsed:true,
                result:`Último estado conservado: ${fallback.source}`,
                silent:true
              }
            );

            weeklyClosureCache.uid = session.uid;
            weeklyClosureCache.activeWeeklyPeriodId = active.id;
            weeklyClosureCache.data = safeResult;
            weeklyClosureCache.loadedAt = Date.now();
            weeklyClosureCache.dirty = false;
            storeWeeklyClosureSessionCache(safeResult);
            applyClosureState(safeResult);
            renderPendingClosureCard([CLOSURE_STATUS.DRIVER_MUST_PAY_PENDING,CLOSURE_STATUS.DRIVER_MUST_PAY_OVERDUE].includes(safeResult.status) ? safeResult : null);
            if (!fallback.rendered) renderDriverStatusCard(safeResult);
            return safeResult;
          }

          if (!force && weeklyClosureCache.data && cacheMatches) {
            applyClosureState(weeklyClosureCache.data);
            renderDriverStatusCard(weeklyClosureCache.data);
            return weeklyClosureCache.data;
          }
          const failure = { status: CLOSURE_STATUS.CLOSURE_ERROR, clickable: false, error, weeklyPeriodId: active.id };
          applyClosureState(failure);
          renderPendingClosureCard(null);
          renderDriverStatusCard(failure);
          return failure;
        } finally {
          weeklyClosureCache.loadPromise = null;
        }
      })();
      return weeklyClosureCache.loadPromise;
    }
    window.ExploraRefreshDriverPaymentStatus = refreshDriverPaymentStatus;


    window.ExploraLoadWeeklySession = async function({ force = false, restoreCachedVisual = false } = {}) {
      // La caché de cierre queda disponible sólo para una recuperación manual
      // explícita. Durante login y reanudación se espera el estado autoritativo.
      if (restoreCachedVisual === true && !force) restoreWeeklyClosureSessionCache();
      const closurePromise=refreshDriverPaymentStatus({force}).catch(()=>null);
      const enginePromise=window.ExploraWeeklyEngine?.loadOnce?.({force,reason:"login"}) || window.ExploraWeeklyEngine?.start?.({force,reason:"login"});
      const [closureResult,engineResult]=await Promise.allSettled([closurePromise,enginePromise]);
      queueMicrotask(()=>{
        // Facturación y Gastos ya se renderizan desde el único snapshot compartido.
        window.ExploraRanking?.refresh?.();
        window.ExploraRecoverPendingWeeklyClose?.().catch?.(()=>{});
      });
      return {closure:closureResult.status==="fulfilled"?closureResult.value:null,engine:engineResult.status==="fulfilled"?engineResult.value:null};
    };

    function stopWeeklyClosureListeners() {
      closureState.unsubscribers.splice(0).forEach(unsubscribe => { try { unsubscribe(); } catch (_) {} });
      closureState.listenerKey = "";
      clearTimeout(closureState.listenerTimer);
    }
    function startWeeklyClosureListeners() {
      // El cierre se conserva en caché durante la sesión y se invalida solo por acciones relevantes.
      stopWeeklyClosureListeners();
    }



    let weeklyClosureReceiptDiagnosticVisible = false;
    let weeklyClosureReceiptDiagnosticPayload = null;
    const weeklyClosureReceiptDiagnosticSeen = new Set();

    function createClosureReceiptError(stage, code, message, cause = null, details = {}) {
      const error = new Error(String(message || code || "CLOSURE_RECEIPT_ERROR"));
      error.name = "ClosureReceiptError";
      error.closureStage = String(stage || "CLOSURE_DATA");
      error.closureCode = String(code || "CLOSURE_RECEIPT_ERROR");
      error.code = error.closureCode;
      error.cause = cause || null;
      error.closureDetails = details || {};
      return error;
    }

    function closureReceiptShortUid(value) {
      const text = String(value || "").trim();
      return text ? text.slice(0, 8) : "—";
    }

    function closureReceiptFileSize(value) {
      const bytes = Math.max(0, Number(value || 0));
      if (!bytes) return "—";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function closureReceiptBucketName() {
      const configured = String(storage?.app?.options?.storageBucket || "").trim();
      if (configured) return configured;
      const internal = String(storage?._bucket?.bucket || storage?._bucket || "").replace(/^gs:\/\//, "").trim();
      return internal || "—";
    }

    function sanitizeClosureReceiptPath(value) {
      const text = String(value || "").replace(/[\r\n\t]/g, " ").trim();
      if (!text) return "—";
      return text.length > 260 ? `${text.slice(0, 257)}…` : text;
    }

    function closureReceiptErrorChain(error) {
      const chain = [];
      let current = error || null;
      const visited = new Set();
      for (let index = 0; current && index < 5 && !visited.has(current); index += 1) {
        visited.add(current);
        chain.push(current);
        current = current.cause || current.originalError || null;
      }
      return chain;
    }

    function closureReceiptFirebaseCode(error) {
      const chain = closureReceiptErrorChain(error);
      for (const item of chain) {
        const code = String(item?.firebaseCode || item?.code || "").trim();
        if (/^(storage|firestore|auth)\//i.test(code) || /^(permission-denied|unauthenticated)$/i.test(code)) return code;
      }
      return "—";
    }

    function closureReceiptFirebaseMessage(error) {
      const chain = closureReceiptErrorChain(error);
      const firebaseItem = chain.find(item => /^(storage|firestore|auth)\//i.test(String(item?.code || "")) || /^(permission-denied|unauthenticated)$/i.test(String(item?.code || "")));
      return String(firebaseItem?.serverResponse || firebaseItem?.message || "—");
    }

    function clearWeeklyClosureReceiptError({ force = false } = {}) {
      if (weeklyClosureReceiptDiagnosticVisible && !force) return false;
      const message = $("weeklyClosureMsg");
      const diagnostic = $("weeklyClosureDiagnostic");
      if (message) {
        message.textContent = "";
        message.className = "weekly-closure-msg closure-receipt-error";
        message.hidden = true;
      }
      if (diagnostic) diagnostic.hidden = true;
      [
        "weeklyClosureDiagModule","weeklyClosureDiagStage","weeklyClosureDiagCode","weeklyClosureDiagFunction","weeklyClosureDiagFirebaseCode",
        "weeklyClosureDiagFirebaseMessage","weeklyClosureDiagJsMessage","weeklyClosureDiagSession",
        "weeklyClosureDiagAuthUid","weeklyClosureDiagRole","weeklyClosureDiagDriverUid","weeklyClosureDiagUidMatch",
        "weeklyClosureDiagPeriod","weeklyClosureDiagCycle","weeklyClosureDiagClosureId","weeklyClosureDiagFile",
        "weeklyClosureDiagMime","weeklyClosureDiagSize","weeklyClosureDiagCash","weeklyClosureDiagTransfers",
        "weeklyClosureDiagCards","weeklyClosureDiagExpenses",
        "weeklyClosureDiagBonus","weeklyClosureDiagCollaboration","weeklyClosureDiagDebts","weeklyClosureDiagLoans","weeklyClosureDiagOtherAdjustments",
        "weeklyClosureDiagFinal","weeklyClosureDiagPayer","weeklyClosureDiagPath","weeklyClosureDiagFirestorePath",
        "weeklyClosureDiagBucket","weeklyClosureDiagPercentage","weeklyClosureDiagTaskState",
        "weeklyClosureDiagElapsed","weeklyClosureDiagTimestamp","weeklyClosureDiagStack"
      ].forEach(id => {
        const element = $(id);
        if (element) element.textContent = "—";
      });
      weeklyClosureReceiptDiagnosticVisible = false;
      weeklyClosureReceiptDiagnosticPayload = null;
      return true;
    }

    async function resolveWeeklyClosureAuthUser(timeoutMs = 6000) {
      if (auth.currentUser?.uid) return auth.currentUser;
      if (typeof auth.authStateReady === "function") {
        try {
          await Promise.race([
            auth.authStateReady(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("AUTH_STATE_READY_TIMEOUT")), Math.max(1200, timeoutMs)))
          ]);
        } catch (_) {}
      }
      if (auth.currentUser?.uid) return auth.currentUser;
      try { return await waitForAuthenticatedUser(timeoutMs); }
      catch (_) { return auth.currentUser?.uid ? auth.currentUser : null; }
    }

    function normalizeWeeklyClosureReceiptError(error, context = {}) {
      const firebaseCode = closureReceiptFirebaseCode(error);
      const firebaseMessage = closureReceiptFirebaseMessage(error);
      const jsMessage = String(error?.message || error?.cause?.message || "CLOSURE_RECEIPT_ERROR");
      const rawCode = String(error?.closureCode || error?.code || "CLOSURE_RECEIPT_UPLOAD_FAILED");
      const rawStage = String(error?.closureStage || context.stage || "RENDER_RECEIPT_UPLOAD");
      const aggregate = [firebaseCode, rawCode, jsMessage, firebaseMessage].join(" ").toLowerCase();
      const stack = String(error?.stack || error?.cause?.stack || "—");
      const permissionDenied = aggregate.includes("permission-denied") || aggregate.includes("unauthorized") || aggregate.includes("insufficient permissions");
      const stage = rawStage.includes("SYNC") || rawStage.includes("SAVE") || aggregate.includes("firestore")
        ? "SYNC_CLOSURE_RECEIPT"
        : rawStage.includes("UPLOAD") || rawStage.includes("URL") || aggregate.includes("storage/")
          ? "UPLOAD_CLOSURE_RECEIPT"
          : "RENDER_RECEIPT_UPLOAD";
      if (permissionDenied) return { stage, internalCode:stage === "SYNC_CLOSURE_RECEIPT" ? "CLOSURE_RECEIPT_SYNC_FAILED" : "CLOSURE_RECEIPT_UPLOAD_FAILED", firebaseCode, firebaseMessage, jsMessage, userMessage:"Firebase rechazó la operación por permisos. Revisá la ruta y las reglas del comprobante de cierre.", stack };
      if (stage === "UPLOAD_CLOSURE_RECEIPT") return { stage, internalCode:"CLOSURE_RECEIPT_UPLOAD_FAILED", firebaseCode, firebaseMessage, jsMessage, userMessage:"No se pudo subir el comprobante a Firebase Storage.", stack };
      if (stage === "SYNC_CLOSURE_RECEIPT") return { stage, internalCode:"CLOSURE_RECEIPT_SYNC_FAILED", firebaseCode, firebaseMessage, jsMessage, userMessage:"No se pudo guardar o sincronizar el comprobante con Comprobantes → Cierre semanal.", stack };
      if (aggregate.includes("required") || aggregate.includes("missing") || aggregate.includes("file_required")) return { stage:"RENDER_RECEIPT_UPLOAD", internalCode:"CLOSURE_RECEIPT_FILE_REQUIRED", firebaseCode, firebaseMessage, jsMessage, userMessage:"Seleccioná un comprobante antes de continuar.", stack };
      if (aggregate.includes("mime") || aggregate.includes("format") || aggregate.includes("pdf_not") || aggregate.includes("unsupported")) return { stage:"RENDER_RECEIPT_UPLOAD", internalCode:"CLOSURE_RECEIPT_INVALID_MIME", firebaseCode, firebaseMessage, jsMessage, userMessage:"Formato no permitido. Usá JPG, PNG o WebP.", stack };
      return { stage, internalCode:rawCode, firebaseCode, firebaseMessage, jsMessage, userMessage:String(error?.message || rawCode), stack };
    }

    function showWeeklyClosureReceiptError(error, context = {}) {
      const normalized = normalizeWeeklyClosureReceiptError(error, context);
      if (window.ExploraProductionPolicy && !window.ExploraProductionPolicy.handle("comprobante", error, { message:"No pudimos subir el comprobante. Revisa tu conexión e intenta nuevamente.", context })) {
        const message=$("weeklyClosureMsg");if(message){message.textContent="No pudimos subir el comprobante. Revisa tu conexión e intenta nuevamente.";message.className="weekly-closure-msg closure-receipt-error";message.hidden=false;}
        return normalized;
      }
      const authUid = String(context.authUid || auth.currentUser?.uid || "").trim();
      const driverUid = String(context.driverUid || closureState.uid || authUid || "").trim();
      const snapshot = context.snapshot || closureState.statusData?.weeklySnapshot || window.ExploraWeeklyEngine?.getSnapshot?.() || {};
      const diagnosticWeeklyPeriodId = String(context.weeklyPeriodId || closureState.weeklyPeriodId || snapshot.weeklyPeriodId || "—");
      const dedupeKey = [normalized.stage, normalized.internalCode, context.closureId || closureState.closureId || "—"].join("|");
      if (weeklyClosureReceiptDiagnosticSeen.has(dedupeKey)) return normalized;
      weeklyClosureReceiptDiagnosticSeen.add(dedupeKey);
      const percentage = Math.max(0, Math.min(100, Math.round(Number(context.percentage || 0))));
      const taskState = String(context.taskState || (normalized.stage === "UPLOAD_CLOSURE_RECEIPT" ? "failed" : "not-started"));
      const timestamp = String(context.timestamp || new Date().toISOString());
      const startedAt = Number(context.startedAt || 0);
      const elapsedMs = Math.max(0, Number(context.elapsedMs || (startedAt ? Date.now() - startedAt : 0)));
      const transfers = Math.max(0,Number(snapshot.transferCollectedByAdmin||0)+Number(snapshot.aliasCollectedByAdmin||0)+Number(snapshot.qrCollectedByAdmin||0));
      const debts = Math.max(0,Number(snapshot.directDebtInstallmentTotal||0));
      const payer = context.payerRole || closureState.statusData?.payer || snapshot.payerRole || null;
      const values = {
        weeklyClosureDiagModule: "WEEKLY_CLOSURE_STATUS_AND_SUMMARY",
        weeklyClosureDiagStage: normalized.stage,
        weeklyClosureDiagCode: normalized.internalCode,
        weeklyClosureDiagFunction: String(context.functionName || "—"),
        weeklyClosureDiagFirebaseCode: normalized.firebaseCode,
        weeklyClosureDiagFirebaseMessage: normalized.firebaseMessage,
        weeklyClosureDiagJsMessage: normalized.jsMessage,
        weeklyClosureDiagSession: auth.currentUser?.uid || authUid ? "Sí" : "No",
        weeklyClosureDiagAuthUid: closureReceiptShortUid(authUid),
        weeklyClosureDiagRole: String(exploraSession.role || context.role || "—"),
        weeklyClosureDiagDriverUid: closureReceiptShortUid(driverUid),
        weeklyClosureDiagUidMatch: authUid && driverUid ? (authUid === driverUid ? "Sí" : "No") : "No aplica",
        weeklyClosureDiagPeriod: String(context.weeklyPeriodId || closureState.weeklyPeriodId || "—"),
        weeklyClosureDiagCycle: diagnosticWeeklyPeriodId,
        weeklyClosureDiagClosureId: String(context.closureId || closureState.closureId || "—"),
        weeklyClosureDiagFile: String(context.fileName || context.file?.name || "—"),
        weeklyClosureDiagMime: String(context.mimeType || context.file?.type || "—"),
        weeklyClosureDiagSize: closureReceiptFileSize(context.fileSize || context.file?.size || 0),
        weeklyClosureDiagCash: formatClosureMoney(snapshot.cashCollectedByDriver || 0),
        weeklyClosureDiagTransfers: formatClosureMoney(transfers),
        weeklyClosureDiagCards: formatClosureMoney(snapshot.cardCollectedByAdmin || 0),
        weeklyClosureDiagExpenses: formatClosureMoney(snapshot.totalExpenses || 0),
                        weeklyClosureDiagBonus: formatClosureMoney(snapshot.derivationBonusAmount || 0),
        weeklyClosureDiagCollaboration: formatClosureMoney(snapshot.collaborationAmount || 0),
        weeklyClosureDiagDebts: formatClosureMoney(debts),
        weeklyClosureDiagLoans: formatClosureMoney(snapshot.operationalLoanDriverShare || 0),
        weeklyClosureDiagOtherAdjustments: formatClosureMoney(context.otherAdjustments || closureState.statusData?.normalizedSummary?.otherAdjustments || 0),
        weeklyClosureDiagFinal: formatClosureMoney(context.finalAmount ?? closureState.statusData?.amount ?? snapshot.settlementAmount ?? 0),
        weeklyClosureDiagPayer: payer === "driver" ? "CHOFER A DAVID" : payer === "admin" || payer === "david" ? "DAVID AL CHOFER" : "EQUILIBRADO",
        weeklyClosureDiagPath: sanitizeClosureReceiptPath(context.path),
        weeklyClosureDiagFirestorePath: sanitizeClosureReceiptPath(context.firestorePath || "cierres_semanales + receipt_index"),
        weeklyClosureDiagBucket: closureReceiptBucketName(),
        weeklyClosureDiagPercentage: `${percentage} %`,
        weeklyClosureDiagTaskState: taskState,
        weeklyClosureDiagElapsed: elapsedMs ? `${(elapsedMs / 1000).toFixed(1)} s` : "—",
        weeklyClosureDiagTimestamp: timestamp,
        weeklyClosureDiagStack: normalized.stack || "—"
      };
      Object.entries(values).forEach(([id, value]) => { const element = $(id); if (element) element.textContent = value; });
      const message = $("weeklyClosureMsg");
      if (message) { message.textContent = normalized.userMessage; message.className = "weekly-closure-msg closure-receipt-error"; message.hidden = false; }
      const diagnostic = $("weeklyClosureDiagnostic"); if (diagnostic) diagnostic.hidden = false;
      weeklyClosureReceiptDiagnosticVisible = true;
      weeklyClosureReceiptDiagnosticPayload = { normalized, context:{...context}, values };
      window.requestAnimationFrame(() => { try { (message || diagnostic)?.scrollIntoView?.({ behavior:"smooth", block:"nearest" }); } catch (_) {} });
      return normalized;
    }

    async function copyWeeklyClosureReceiptError() {
      const ids = [
        ["MÓDULO", "weeklyClosureDiagModule"],["ETAPA", "weeklyClosureDiagStage"],["CÓDIGO INTERNO", "weeklyClosureDiagCode"],["FUNCIÓN", "weeklyClosureDiagFunction"],
        ["CÓDIGO FIREBASE", "weeklyClosureDiagFirebaseCode"],["MENSAJE REAL FIREBASE", "weeklyClosureDiagFirebaseMessage"],
        ["MENSAJE REAL JAVASCRIPT", "weeklyClosureDiagJsMessage"],["SESIÓN FIREBASE", "weeklyClosureDiagSession"],
        ["UID AUTH", "weeklyClosureDiagAuthUid"],["ROL", "weeklyClosureDiagRole"],["DRIVER UID", "weeklyClosureDiagDriverUid"],
        ["COINCIDEN", "weeklyClosureDiagUidMatch"],["SEMANA ACTIVA", "weeklyClosureDiagPeriod"],["SEMANA FINANCIERA", "weeklyClosureDiagCycle"],
        ["CLOSURE ID", "weeklyClosureDiagClosureId"],["EFECTIVO", "weeklyClosureDiagCash"],["TRANSFERENCIAS", "weeklyClosureDiagTransfers"],
        ["TARJETAS", "weeklyClosureDiagCards"],["GASTOS", "weeklyClosureDiagExpenses"],
        ["BONO DERIVADOR", "weeklyClosureDiagBonus"],["COLABORACIÓN PARA BONO", "weeklyClosureDiagCollaboration"],
        ["DEUDAS", "weeklyClosureDiagDebts"],["PRÉSTAMOS", "weeklyClosureDiagLoans"],["OTROS MOVIMIENTOS", "weeklyClosureDiagOtherAdjustments"],["RESULTADO FINAL", "weeklyClosureDiagFinal"],
        ["QUIÉN PAGA", "weeklyClosureDiagPayer"],["ARCHIVO", "weeklyClosureDiagFile"],["MIME", "weeklyClosureDiagMime"],
        ["PESO", "weeklyClosureDiagSize"],["RUTA STORAGE", "weeklyClosureDiagPath"],["RUTA FIRESTORE", "weeklyClosureDiagFirestorePath"],
        ["BUCKET", "weeklyClosureDiagBucket"],["PORCENTAJE", "weeklyClosureDiagPercentage"],["ESTADO DE LA TAREA", "weeklyClosureDiagTaskState"],
        ["TIEMPO TRANSCURRIDO", "weeklyClosureDiagElapsed"],["TIMESTAMP", "weeklyClosureDiagTimestamp"],["STACK", "weeklyClosureDiagStack"]
      ];
      const report = ["EXPLORA - ERROR SUBIR COMPROBANTE DE CIERRE", ...ids.map(([label,id]) => `${label}: ${$(id)?.textContent || "—"}`)].join("\n");
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(report);
        else {
          const textarea = document.createElement("textarea");
          textarea.value = report;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        const button = $("weeklyClosureDiagnosticCopyBtn");
        if (button) {
          const original = button.textContent;
          button.textContent = "ERROR COPIADO";
          setTimeout(() => { button.textContent = original; }, 1400);
        }
      } catch (copyError) {
        console.error("WEEKLY_CLOSURE_COPY_ERROR", copyError);
      }
    }

    function resetWeeklyDriverReceiptSelection({ clearInput = true, clearMessage = false } = {}) {
      if (weeklyDriverReceiptState.previewUrl) {
        try { URL.revokeObjectURL(weeklyDriverReceiptState.previewUrl); } catch (_) {}
      }
      weeklyDriverReceiptState.file = null;
      weeklyDriverReceiptState.previewUrl = null;
      weeklyDriverReceiptState.processedFile = null;
      weeklyDriverReceiptState.uploading = false;
      try { window.ExploraReceiptEngine?.resetUploadState?.("weeklyClosureDriver"); } catch (_) {}
      if (clearInput) {
        const input = $("weeklyDriverReceiptInput");
        if (input) input.value = "";
      }
      window.ExploraReceiptUI?.clear?.({ previewId:"weeklyClosurePreview", thumbId:"weeklyClosurePreviewThumb", nameId:"weeklyClosurePreviewName", metaId:"weeklyClosurePreviewMeta" });
      const button = $("weeklyClosureSubmitBtn");
      if (button) button.disabled = true;
      if (clearMessage) clearWeeklyClosureReceiptError();
    }

    function handleWeeklyDriverReceiptChange(event) {
      const file = event.target.files?.[0] || null;
      if (!file) return;
      clearWeeklyClosureReceiptError();
      resetWeeklyDriverReceiptSelection({ clearInput:false, clearMessage:false });
      try {
        const mime = String(file.type || "").toLowerCase();
        if (!(file instanceof File) || !(file.size > 0)) throw createClosureReceiptError("RENDER_RECEIPT_UPLOAD","CLOSURE_RECEIPT_FILE_REQUIRED","Seleccioná un archivo real y no vacío.");
        if (!["image/jpeg","image/png","image/webp"].includes(mime)) throw createClosureReceiptError("RENDER_RECEIPT_UPLOAD","CLOSURE_RECEIPT_INVALID_MIME","Formato no permitido. Usá JPG, PNG o WebP.");
        const selected = window.ExploraReceiptEngine?.selectUploadFile?.(file,"weeklyClosureDriver",{allowPdf:false,maxSourceBytes:15*1024*1024});
        if (!selected?.file) throw createClosureReceiptError("RENDER_RECEIPT_UPLOAD","CLOSURE_RECEIPT_FILE_REQUIRED","No se pudo validar el comprobante seleccionado.");
        weeklyDriverReceiptState.file = selected.file;
        weeklyDriverReceiptState.previewUrl = selected.previewUrl || URL.createObjectURL(selected.file);
        weeklyDriverReceiptState.processedFile = null;
        const rendered = window.ExploraReceiptUI?.render?.({previewId:"weeklyClosurePreview",thumbId:"weeklyClosurePreviewThumb",nameId:"weeklyClosurePreviewName",metaId:"weeklyClosurePreviewMeta",file:selected.file,previewUrl:weeklyDriverReceiptState.previewUrl});
        if (!rendered) throw createClosureReceiptError("RENDER_RECEIPT_UPLOAD","WEEKLY_CLOSURE_RENDER_BROKEN","No se pudo mostrar la vista previa del comprobante.");
        const button = $("weeklyClosureSubmitBtn"); if (button) button.disabled = false;
        window.scrollToReceiptSubmitButton?.(button);
      } catch (error) {
        resetWeeklyDriverReceiptSelection({ clearInput:true, clearMessage:false });
        showWeeklyClosureReceiptError(error, {
          stage:error?.closureStage || "RENDER_RECEIPT_UPLOAD", functionName:"handleWeeklyDriverReceiptChange", authUid:auth.currentUser?.uid || "", driverUid:closureState.uid || auth.currentUser?.uid || "",
          weeklyPeriodId:closureState.weeklyPeriodId || "", closureId:closureState.closureId || "", file,
          snapshot:closureState.statusData?.weeklySnapshot, firestorePath:"DOM#weeklyClosurePreview"
        });
        showWeeklyClosureSummaryDiagnostic("RENDER_RECEIPT_UPLOAD", error?.closureCode || "WEEKLY_CLOSURE_RENDER_BROKEN", error, {
          functionName:"handleWeeklyDriverReceiptChange", driverUid:closureState.uid, weeklyPeriodId:closureState.weeklyPeriodId,
          snapshot:closureState.statusData?.weeklySnapshot, firestorePath:"DOM#weeklyClosurePreview", query:"validate image + render preview"
        });
      }
    }

    function resetWeeklyClosureUIState() {
      closureState.saving = false;
      const submit = $("weeklyClosureSubmitBtn");
      if (submit) {
        const activeSummary=closureState.statusData?.normalizedSummary||{};const mayUpload=activeSummary.payer==="driver"&&Number(activeSummary.amount||0)>WEEKLY_CLOSURE_BALANCE_TOLERANCE;submit.disabled=!(weeklyDriverReceiptState.file instanceof File)||!mayUpload;
        submit.textContent = "CONFIRMAR COMPROBANTE";
        submit.removeAttribute("aria-busy");
      }
      document.body.classList.remove("modal-open","no-scroll","is-loading","weekly-closure-saving");
      document.documentElement.classList.remove("modal-open","no-scroll","is-loading");
      document.body.style.pointerEvents = "";
      window.unlockPageScroll?.("weekly-closure");
      window.unlockPageScroll?.("weekly-closure-saving");
    }

    function resetWeeklyClosureState() {
      stopWeeklyClosureListeners();
      clearWeeklyClosureCache();
      resetWeeklyDriverReceiptSelection({ clearInput:true, clearMessage:true });
      Object.assign(closureState, {
        uid:null, weeklyPeriodId:null, closureId:null, closure:null, paymentId:null, payment:null,
        status:CLOSURE_STATUS.CLOSURE_LOADING, clickable:false, performanceEligible:true, receiptDeadline:null,
        amount:0, saving:false, refreshing:false, error:null, statusData:null
      });
      renderDriverStatusCard({ status:CLOSURE_STATUS.CLOSURE_LOADING, clickable:false });
    }
    window.ExploraResetWeeklyClosureState = resetWeeklyClosureState;

    function closeWeeklyClosureModal() {
      weeklyClosureViewRequestId += 1;
      stopWeeklyClosureLiveBinding();
      const overlay = $("weeklyClosureOverlay");
      if (overlay) { overlay.hidden = true; overlay.setAttribute("aria-hidden","true"); }
      const loading = $("weeklyClosureLoading"); if (loading) loading.hidden = true;
      resetWeeklyDriverReceiptSelection({ clearInput:true, clearMessage:true });
      resetWeeklyClosureUIState();
      document.body.classList.remove("weekly-closure-open");
      document.body.style.overflow="";
      document.body.style.touchAction="";
      weeklyClosureViewState.active="current";
      weeklyClosureViewState.switching=false;
      clearPreviousWeeklyClosureEmptyState();
      updateWeeklyClosureViewControls("current",false);
      window.unlockPageScroll?.("weekly-closure");
    }

    function formatClosureMoney(value) {
      return "$" + Math.round(Number(value || 0)).toLocaleString("es-AR");
    }

    const WEEKLY_CLOSURE_BALANCE_TOLERANCE = 0.01;
    function normalizeWeeklyClosureBalance(value) {
      const number = finiteClosureNumber(value, 0);
      if (!Number.isFinite(number)) return 0;
      const rounded = Math.round(number);
      return Math.abs(rounded) <= WEEKLY_CLOSURE_BALANCE_TOLERANCE ? 0 : rounded;
    }
    function isWeeklyClosureBalanced(value) {
      return normalizeWeeklyClosureBalance(value) === 0;
    }

    const WEEKLY_CLOSURE_RECEIPT_STATE = Object.freeze({
      DRIVER_RECEIPT_REQUIRED:"DRIVER_RECEIPT_REQUIRED",
      ADMIN_PAYMENT_PENDING:"ADMIN_PAYMENT_PENDING",
      BALANCED_NO_RECEIPT:"BALANCED_NO_RECEIPT",
      ALREADY_CONFIRMED:"ALREADY_CONFIRMED",
      INVALID_STATE:"INVALID_STATE"
    });

    const WEEKLY_LIVE_SUMMARY_SCHEMA_VERSION = 257;
    let weeklyClosureLiveUnsubscribe = null;
    let weeklyClosureLiveRequestId = 0;
    let weeklyClosureViewRequestId = 0;
    let weeklyClosureLiveSignature = "";
    const weeklyClosureViewState = { active:"current", currentStatusData:null, previousStatusData:null, switching:false };

    function weeklyClosurePeriodState(periodId = "", statusData = {}) {
      const active = getActiveWeeklyPeriod();
      const normalized = String(periodId || active.id || "").slice(0,10);
      const currentId = String(active.id || "").slice(0,10);
      const closure = statusData.closureRecord?.data || statusData.closure || {};
      const rawStatus = String(closure.status || closure.closureStatus || statusData.status || "").toLowerCase();
      const explicitClosed = ["closed","completed","confirmed","confirmed_balanced","closed_balanced","paid","frozen"].includes(rawStatus) || closure.isFrozen === true || closure.frozen === true;
      const belongsToPastPeriod = Boolean(normalized && currentId && normalized !== currentId);
      return { periodId:normalized, currentId, isClosed:belongsToPastPeriod || (explicitClosed && belongsToPastPeriod), period:closurePeriodObject(normalized || currentId) };
    }

    function buildLiveWeeklyFinancialSummary(snapshot = {}, session = {}, periodState = {}, statusData = {}) {
      if (window.ExploraCanonicalWeeklyClosure?.canonicalizeSnapshot && window.ExploraCanonicalWeeklyClosure?.displaySummary) {
        try {
          const periodId=String(periodState.periodId||snapshot.periodId||snapshot.weeklyPeriodId||statusData.weeklyPeriodId||"").trim();
          const expenseTotals=resolveWeeklyExpenseTotals(snapshot);
          const canonicalSource={...snapshot,totalExpenses:expenseTotals.total,gastos:expenseTotals.total,driverPaidSharedExpenses:expenseTotals.driverPaid,adminPaidSharedExpenses:expenseTotals.adminPaid,driverPaidExpenses:expenseTotals.driverPaid,adminPaidExpenses:expenseTotals.adminPaid};
          const canonical=canonicalSource.snapshotValidated===true&&canonicalSource.schemaVersion===window.ExploraCanonicalWeeklyClosure.schemaVersion?canonicalSource:window.ExploraCanonicalWeeklyClosure.canonicalizeSnapshot(canonicalSource,{driverUid:canonicalSource.driverUid||canonicalSource.uid||session.uid||auth.currentUser?.uid,periodId,sourceQueriesComplete:true});
          const validation=window.ExploraCanonicalWeeklyClosure.validateWeeklyClosureSnapshot(canonical);
          if(!validation.valid)throw Object.assign(new Error("WEEKLY_CLOSURE_INVALID_SNAPSHOT"),{code:"WEEKLY_CLOSURE_INVALID_SNAPSHOT",validationErrors:validation.errors});
          return window.ExploraCanonicalWeeklyClosure.displaySummary(validation.snapshot,{periodStart:periodState.period?.startMs||null,periodEnd:periodState.period?.endMs||null,isPeriodClosed:Boolean(periodState.isClosed),closureStatus:periodState.isClosed?"closed":"open"});
        } catch(error) {
          if(periodState.isClosed) throw error;
        }
      }
      const normalizedData = normalizeWeeklyClosureData({ ...statusData, weeklySnapshot:snapshot }, statusData.weeklyScope || weeklySummaryPeriodInfo(periodState.periodId));
      const summary = calculateFinalBalance(normalizedData);
      const lastUpdatedAt = snapshot.updatedAt?.toDate?.() || snapshot.actualizadoEn?.toDate?.() || snapshot.calculatedAt || new Date();
      return Object.freeze({
        ...summary, uid:String(snapshot.uid || snapshot.driverUid || session.uid || auth.currentUser?.uid || ""),
        periodId:periodState.periodId || summary.periodId, periodStart:periodState.period?.startMs || null, periodEnd:periodState.period?.endMs || null,
        isPeriodClosed:Boolean(periodState.isClosed), lastUpdatedAt, billedTotal:summary.grossBilling, expensesTotal:summary.expenses,
        cashTotal:summary.cash, transferTotal:summary.transfers, cardTotal:summary.cards, qrTotal:summary.qr,
        otherPaymentTotal:Math.max(0, Number(snapshot.aliasCollectedByAdmin || 0)), basePercentage:50, totalDriverPercentage:50, referralBonus:summary.derivationBonus,
        driverShare:summary.driverShareBeforeDiscounts, adminShare:Math.max(0, Number(summary.grossBilling || 0) - Number(summary.driverShareBeforeDiscounts || 0)),
        driverHeldCash:summary.cash, adminReceivedFunds:summary.totalCollectedByAdmin, adjustments:summary.otherDiscounts, debts:summary.fines, loans:summary.loans + summary.exploreLoanDiscount,
        normalizedBalance:normalizeWeeklyClosureBalance(summary.netSettlementToDriver), projectedResultType:summary.balanced ? "balanced" : summary.payer === "driver" ? "driver-pays" : "admin-pays",
        closureStatus:periodState.isClosed ? "closed" : "open", schemaVersion:WEEKLY_LIVE_SUMMARY_SCHEMA_VERSION
      });
    }
    window.buildLiveWeeklyFinancialSummary = buildLiveWeeklyFinancialSummary;

    function renderWeeklyClosureLiveState(summary = {}, statusDataOverride = null) {
      const box=$("weeklyClosureLiveState"), requirement=$("weeklyClosureLiveRequirement"), title=$("weeklyClosureLiveTitle"), detail=$("weeklyClosureLiveDetail"), updated=$("weeklyClosureLiveUpdated");
      if(!box)return;
      const statusData=statusDataOverride||closureState.statusData||{};
      const canonical=getDriverWeeklyClosureStatus({...statusData,isPeriodClosed:summary.isPeriodClosed,balanced:summary.balanced,normalizedBalance:summary.normalizedBalance,amount:summary.amount,payer:summary.payer},auth.currentUser||{},statusData);
      box.dataset.state=summary.isPeriodClosed?canonical.colorState:"open";
      if(requirement)requirement.textContent=summary.isPeriodClosed?"ÚLTIMO CIERRE SEMANAL":"SEMANA EN CURSO";
      if(title)title.textContent=summary.isPeriodClosed?"Este fue tu último cierre de semana.":"RESUMEN EN TIEMPO REAL";
      if(detail)detail.textContent=summary.isPeriodClosed?`Del ${closurePeriodLabel(summary.closure||{},summary.periodId||"").replace(/\s+al\s+/i," al ")}`:"Estos valores se actualizan durante la semana. El resultado será definitivo al momento del cierre semanal.";
      if(updated) updated.textContent=summary.isPeriodClosed?canonical.label:`Actualizado: ${(summary.lastUpdatedAt instanceof Date?summary.lastUpdatedAt:new Date(summary.lastUpdatedAt||Date.now())).toLocaleString("es-AR",{dateStyle:"short",timeStyle:"short"})}`;
      let statusRequirement=$("weeklyClosureHumanStatusRequirement");
      if(!statusRequirement){statusRequirement=document.createElement("div");statusRequirement.id="weeklyClosureHumanStatusRequirement";statusRequirement.className="weekly-closure-human-status";box.appendChild(statusRequirement);}
      statusRequirement.dataset.state=canonical.colorState;statusRequirement.textContent=canonical.label;statusRequirement.hidden=!summary.isPeriodClosed;
      const finalKicker=$("weeklyFinalTitle"); if(finalKicker)finalKicker.textContent=summary.isPeriodClosed?"SALDO FINAL":"SALDO PARCIAL ACTUAL";
      renderWeeklyClosureAcknowledgement(statusData,summary,canonical);
    }

    const weeklyClosureAcknowledgementInFlight=new Map();
    function ensureWeeklyClosureAcknowledgementUI(){
      let section=$("weeklyClosureAcknowledgementSection");
      if(section)return section;
      const content=$("weeklyClosureContent");if(!content)return null;
      section=document.createElement("section");section.id="weeklyClosureAcknowledgementSection";section.className="weekly-closure-acknowledgement";section.hidden=true;
      section.innerHTML='<strong id="weeklyClosureAcknowledgementTitle">REVISÁ TU CIERRE</strong><p id="weeklyClosureAcknowledgementDetail"></p><button id="weeklyClosureAcknowledgementBtn" type="button">CONFIRMAR QUE VI MI CIERRE</button>';
      const live=$("weeklyClosureLiveState");if(live?.nextSibling)content.insertBefore(section,live.nextSibling);else content.prepend(section);
      $("weeklyClosureAcknowledgementBtn")?.addEventListener("click",confirmDriverWeeklyClosureAcknowledgement);
      return section;
    }
    function renderWeeklyClosureAcknowledgement(statusData={},summary={},canonical=null){
      const section=ensureWeeklyClosureAcknowledgementUI();if(!section)return;
      const state=canonical||getDriverWeeklyClosureStatus({...statusData,isPeriodClosed:summary.isPeriodClosed,balanced:summary.balanced,normalizedBalance:summary.normalizedBalance,amount:summary.amount,payer:summary.payer},auth.currentUser||{},statusData);
      const show=Boolean(summary.isPeriodClosed&&state.requiresDriverAcknowledgement&&!state.requiresDriverReceipt&&state.code===DRIVER_WEEKLY_CLOSURE_STATUS.BALANCED_AWAITING_ACKNOWLEDGEMENT);
      section.hidden=!show;section.dataset.state=state.colorState;
      if(show){$("weeklyClosureAcknowledgementTitle").textContent="REVISÁ TU CIERRE";$("weeklyClosureAcknowledgementDetail").textContent="La cuenta está equilibrada. Confirmá que viste este cierre para volver a estar al día.";const btn=$("weeklyClosureAcknowledgementBtn");if(btn){btn.disabled=false;btn.textContent="CONFIRMAR QUE VI MI CIERRE";}}
    }
    async function confirmDriverWeeklyClosureAcknowledgement(){
      const statusData=closureState.statusData||{};
      const uid=String(auth.currentUser?.uid||"").trim();
      const periodId=String(statusData.weeklyPeriodId||statusData.normalizedSummary?.periodId||closureState.weeklyPeriodId||"").trim();
      const btn=$("weeklyClosureAcknowledgementBtn");
      if(!uid||!periodId){
        const error=new Error("WEEKLY_CLOSURE_ACK_CONTEXT_MISSING");
        showWeeklyClosureSummaryDiagnostic("ACKNOWLEDGE_WEEKLY_CLOSURE","WEEKLY_CLOSURE_ACK_FAILED",error,{functionName:"confirmDriverWeeklyClosureAcknowledgement",weeklyPeriodId:periodId,firestorePath:"cierres_semanales"});
        return false;
      }
      const key=`${uid}:${periodId}`;
      if(weeklyClosureAcknowledgementInFlight.has(key))return weeklyClosureAcknowledgementInFlight.get(key);
      const existing={...(statusData.closureRecord?.data||{}),...(statusData.closure||{})};
      const ownerUid=String(existing.driverUid||existing.choferUid||existing.uid||uid).trim();
      if(ownerUid&&ownerUid!==uid){
        const error=new Error("WEEKLY_CLOSURE_ACK_OWNER_MISMATCH");
        showWeeklyClosureSummaryDiagnostic("ACKNOWLEDGE_WEEKLY_CLOSURE","WEEKLY_CLOSURE_PERMISSION_DENIED",error,{functionName:"confirmDriverWeeklyClosureAcknowledgement",weeklyPeriodId:periodId,firestorePath:"cierres_semanales"});
        return false;
      }
      if(btn){btn.disabled=true;btn.textContent="CONFIRMANDO…";btn.setAttribute("aria-busy","true");}
      const task=(async()=>{
        const closureId=String(statusData.closureRecord?.id||statusData.closureId||`${uid}_${periodId}`);
        const collectionName=statusData.closureCollection||statusData.closureRecord?.collection||window.ExploraCanonicalWeeklyClosure?.closureCollectionName?.()||"cierres_semanales";
        const ref=doc(db,collectionName,closureId);
        await runTransaction(db,async transaction=>{
          const snap=await transaction.get(ref);
          const current=snap.exists()?snap.data()||{}:{};
          const currentOwner=String(current.driverUid||current.choferUid||current.uid||uid).trim();
          if(currentOwner&&currentOwner!==uid)throw new Error("WEEKLY_CLOSURE_ACK_OWNER_MISMATCH");
          transaction.set(ref,{
            closureId,driverUid:uid,choferUid:uid,uid,
            weeklyPeriodId:periodId,periodoSemanalId:periodId,periodoId:periodId,semanaId:periodId,
            driverAcknowledged:true,
            driverAcknowledgedAt:serverTimestamp(),
            driverAcknowledgedBy:uid,
            driverAcknowledgedPeriodId:periodId,
            acknowledgementStatus:"confirmed",
            acknowledgementState:"DRIVER_ACKNOWLEDGED",
            closureStatus:"balanced",
            paymentStatus:"balanced",
            status:"balanced",
            balanced:true,
            completed:true,
            completedAt:current.completedAt||serverTimestamp(),
            statusSchemaVersion:256,
            updatedAt:serverTimestamp(),
            actualizadoEn:serverTimestamp()
          },{merge:true});
        });
        const localPayload={driverAcknowledged:true,driverAcknowledgedBy:uid,driverAcknowledgedPeriodId:periodId,acknowledgementStatus:"confirmed",acknowledgementState:"DRIVER_ACKNOWLEDGED",closureStatus:"balanced",paymentStatus:"balanced",status:"balanced",balanced:true,completed:true};
        statusData.closureId=closureId;
        statusData.closure={...existing,...localPayload};
        statusData.status=CLOSURE_STATUS.BALANCED_CLOSURE;
        if(statusData.closureRecord)statusData.closureRecord.data=statusData.closure;
        weeklyClosureCache.data={...statusData,closure:statusData.closure,status:CLOSURE_STATUS.BALANCED_CLOSURE};
        weeklyClosureCache.dirty=false;
        renderPendingClosureCard(null);
        const pendingCard=$("profilePendingClosureCard");if(pendingCard)pendingCard.hidden=true;
        renderDriverStatusCard({...statusData,status:CLOSURE_STATUS.BALANCED_CLOSURE,clickable:true});
        window.invalidateWeeklyFinancialEngine?.("weekly-closure-acknowledged");
        window.ExploraInvalidateWeeklyClosure?.("weekly-closure-acknowledged");
        closeWeeklyClosureModal();
        window.showToast?.("Cierre confirmado correctamente.");
        window.dispatchEvent(new CustomEvent("explora:weekly-closure-acknowledged",{detail:{closureId,weeklyPeriodId:periodId,driverUid:uid}}));
        return true;
      })().catch(error=>{
        if(btn){btn.disabled=false;btn.textContent="CONFIRMAR QUE VI MI CIERRE";btn.removeAttribute("aria-busy");}
        showWeeklyClosureSummaryDiagnostic("ACKNOWLEDGE_WEEKLY_CLOSURE",error?.message==="WEEKLY_CLOSURE_ACK_OWNER_MISMATCH"?"WEEKLY_CLOSURE_PERMISSION_DENIED":"WEEKLY_CLOSURE_ACK_FAILED",error,{functionName:"confirmDriverWeeklyClosureAcknowledgement",weeklyPeriodId:periodId,firestorePath:`cierres_semanales/${statusData.closureId||`${uid}_${periodId}`}`});
        return false;
      }).finally(()=>weeklyClosureAcknowledgementInFlight.delete(key));
      weeklyClosureAcknowledgementInFlight.set(key,task);
      return task;
    }
    window.confirmDriverWeeklyClosureAcknowledgement=confirmDriverWeeklyClosureAcknowledgement;

    function stopWeeklyClosureLiveBinding(){
      try{weeklyClosureLiveUnsubscribe?.();}catch(_){}
      weeklyClosureLiveUnsubscribe=null; weeklyClosureLiveRequestId+=1; weeklyClosureLiveSignature="";
    }

        function getWeeklyClosureReceiptRequirement(summary = {}, statusData = {}) {
      if (summary.isPeriodClosed === false) return { state:WEEKLY_CLOSURE_RECEIPT_STATE.INVALID_STATE, normalizedBalance:normalizeWeeklyClosureBalance(summary.netSettlementToDriver), payer:summary.payer || null, receiptRequired:false, receiptOwner:null, hasReceipt:false, provisional:true };
      const merged = { ...(statusData.closure || {}), ...(statusData.payment || {}), ...statusData };
      const receiptSource = window.ExploraReceiptEngine?.resolveReceiptSource?.(merged) || {};
      const hasReceipt = Boolean(statusData.receiptUrl || receiptSource.url);
      const normalizedBalance = summary.balanced ? 0 : normalizeWeeklyClosureBalance(summary.payer === "admin" ? summary.amount : summary.payer === "driver" ? -summary.amount : summary.netSettlementToDriver);
      const rawStatus = String(merged.status || merged.closureStatus || merged.estado || "").toLowerCase();
      const alreadyConfirmed = hasReceipt || ["balanced","confirmed_balanced","closed_balanced","completed","closed","paid","confirmed"].includes(rawStatus);
      if (summary.balanced || normalizedBalance === 0) return { state:alreadyConfirmed ? WEEKLY_CLOSURE_RECEIPT_STATE.ALREADY_CONFIRMED : WEEKLY_CLOSURE_RECEIPT_STATE.BALANCED_NO_RECEIPT, normalizedBalance:0, payer:null, receiptRequired:false, receiptOwner:null, hasReceipt };
      if (hasReceipt) return { state:WEEKLY_CLOSURE_RECEIPT_STATE.ALREADY_CONFIRMED, normalizedBalance, payer:summary.payer || null, receiptRequired:false, receiptOwner:null, hasReceipt };
      if (summary.payer === "driver" && Math.abs(normalizedBalance) > WEEKLY_CLOSURE_BALANCE_TOLERANCE) return { state:WEEKLY_CLOSURE_RECEIPT_STATE.DRIVER_RECEIPT_REQUIRED, normalizedBalance, payer:"driver", receiptRequired:true, receiptOwner:"driver", hasReceipt:false };
      if (summary.payer === "admin" && Math.abs(normalizedBalance) > WEEKLY_CLOSURE_BALANCE_TOLERANCE) return { state:WEEKLY_CLOSURE_RECEIPT_STATE.ADMIN_PAYMENT_PENDING, normalizedBalance, payer:"admin", receiptRequired:false, receiptOwner:"admin", hasReceipt:false };
      return { state:WEEKLY_CLOSURE_RECEIPT_STATE.INVALID_STATE, normalizedBalance, payer:summary.payer || null, receiptRequired:false, receiptOwner:null, hasReceipt:false };
    }
    window.getWeeklyClosureReceiptRequirement = getWeeklyClosureReceiptRequirement;

    const balancedClosureConfirmationInFlight = new Map();
    async function ensureBalancedClosureConfirmed(statusData = {}, summary = {}) {
      const requirement = getWeeklyClosureReceiptRequirement(summary, statusData);
      if (requirement.state !== WEEKLY_CLOSURE_RECEIPT_STATE.BALANCED_NO_RECEIPT) return false;
      const driverUid = String(auth.currentUser?.uid || closureState.uid || "").trim();
      const weeklyPeriodId = String(statusData.weeklyPeriodId || summary.periodId || closureState.weeklyPeriodId || "").trim();
      if (!driverUid || !weeklyPeriodId) return false;
      const key = `${driverUid}:${weeklyPeriodId}`;
      if (balancedClosureConfirmationInFlight.has(key)) return balancedClosureConfirmationInFlight.get(key);
      const existing = statusData.closureRecord?.data || statusData.closure || {};
      const existingStatus = String(existing.status || existing.closureStatus || existing.estado || "").toLowerCase();
      if (["balanced","confirmed_balanced","closed_balanced"].includes(existingStatus) && existing.receiptRequired === false) return true;
      const promise = (async()=>{
        const closureId = String(statusData.closureRecord?.id || statusData.closureId || `${driverUid}_${weeklyPeriodId}`);
        const collectionName=statusData.closureCollection||statusData.closureRecord?.collection||window.ExploraCanonicalWeeklyClosure?.closureCollectionName?.()||"cierres_semanales";
        const ref = doc(db,collectionName,closureId);
        const payload = {
          closureId,choferUid:driverUid,uid:driverUid,driverUid,weeklyPeriodId,periodoSemanalId:weeklyPeriodId,periodoId:weeklyPeriodId,semanaId:weeklyPeriodId,
          payerRole:null,payeeRole:null,payer:null,sentido:"sin_diferencia",direccionPago:"sin_diferencia",choferDebe:0,davidDebe:0,settlementAmount:0,saldoFinal:0,balanced:true,
          receiptRequired:false,receiptOwner:null,receiptStatus:"not_required",estadoComprobante:"no_requerido",status:"balanced",closureStatus:"balanced",paymentStatus:"balanced",isConfirmed:true,
          confirmedAutomatically:true,confirmedReason:"balanced_no_receipt",actualizadoEn:serverTimestamp(),updatedAt:serverTimestamp()
        };
        await setDoc(ref,payload,{merge:true});
        statusData.closureId=closureId;
        statusData.closureCollection=collectionName;
        statusData.closureRecord={id:closureId,collection:collectionName,data:{...existing,...payload}};
        statusData.closure={...existing,...payload};
        statusData.status=CLOSURE_STATUS.BALANCED_CLOSURE;
        return true;
      })().finally(()=>balancedClosureConfirmationInFlight.delete(key));
      balancedClosureConfirmationInFlight.set(key,promise);
      return promise;
    }

    function renderPendingClosureCard(statusData) {
      const card = $("profilePendingClosureCard");
      if (!card) return;
      if (!statusData) { card.hidden=true; return; }
      const canonical=getDriverWeeklyClosureStatus(statusData,auth.currentUser||{},statusData);
      if(canonical.isUpToDate){card.hidden=true;return;}
      card.hidden=false;card.dataset.status=canonical.colorState;
      const title = $("profilePendingClosureTitle");
      const text = $("profilePendingClosureText");
      if (title) title.textContent = canonical.label;
      if (text) text.textContent = `${canonical.detail}${canonical.periodLabel?` · ${canonical.periodLabel}`:""}`;
      card.hidden = false;
    }

    async function refreshProfilePendingClosure() {
      sanitizeProfileScreen();
      return await refreshDriverPaymentStatus();
    }

    function setClosureDetail(id, value) { const el = $(id); if (el) el.textContent = value; }
    function setClosureTone(id, tone = "neutral") {
      const el = $(id); if (!el) return;
      el.classList.remove("is-positive","is-negative","is-info","is-neutral");
      el.classList.add(`is-${tone}`);
    }
    function closurePeriodObject(periodId) {
      const id = String(periodId || "").slice(0,10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) return getActiveWeeklyPeriod();
      return getWeeklyPeriodFromDate(new Date(`${id}T12:00:00-03:00`));
    }
    function closurePeriodLabel(data = {}, fallback = "") {
      const rawStart = String(data.periodoInicio || data.inicio || fallback || data.periodoId || data.periodoSemanalId || "").slice(0,10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
        const period = closurePeriodObject(rawStart);
        const start = formatIsoDateInArgentina(period.startMs);
        const end = formatIsoDateInArgentina(period.startMs + 6 * 86400000);
        return `${start} al ${end}`;
      }
      const start = String(data.periodoInicio || data.inicio || "").slice(0,10);
      const end = String(data.periodoFin || data.fin || "").slice(0,10);
      if (start && end) return `${start} al ${end}`;
      return fallback || "Período semanal";
    }

    const weeklyClosureSummaryDiagnosticSeen = new Set();
    const weeklyPeriodResolutionCache = new Map();
    let weeklyClosureSummaryDiagnosticText = "";

    function normalizeClosureWeeklyPeriodId(value) {
      const id = String(value || "").trim().slice(0,10);
      return /^\d{4}-\d{2}-\d{2}$/.test(id) ? id : "";
    }

    function weeklyPeriodDateId(ms) {
      const date = new Date(Number(ms));
      if (!Number.isFinite(date.getTime())) return "";
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}-${String(date.getUTCDate()).padStart(2,"0")}`;
    }

    function deriveWeeklyScopeForPeriod(weeklyPeriodId) {
      const periodId = normalizeClosureWeeklyPeriodId(weeklyPeriodId);
      if (!periodId) return null;
      const period = closurePeriodObject(periodId);
      return {id:periodId,weeklyPeriodId:periodId,startPeriodId:periodId,endPeriodId:periodId,startMs:period.startMs,endMs:period.endMs,source:"weeklyPeriodId",scope:"weekly",resolved:true};
    }

    async function getWeeklyScopeForPeriod(weeklyPeriodId) {
      const periodId = normalizeClosureWeeklyPeriodId(weeklyPeriodId) || normalizeClosureWeeklyPeriodId(getActiveWeeklyPeriod()?.id);
      if (weeklyPeriodResolutionCache.has(periodId)) return weeklyPeriodResolutionCache.get(periodId);
      const weekly = deriveWeeklyScopeForPeriod(periodId);
      weeklyPeriodResolutionCache.set(periodId, weekly);
      return weekly;
    }
    window.getWeeklyScopeForPeriod = getWeeklyScopeForPeriod;

    function weeklySummaryPeriodInfo(periodId) {
      const normalized = normalizeClosureWeeklyPeriodId(periodId);
      return weeklyPeriodResolutionCache.get(normalized) || deriveWeeklyScopeForPeriod(normalized) || {id:normalized,weeklyPeriodId:normalized,startPeriodId:normalized,endPeriodId:normalized,source:"weekly_safe_fallback",scope:"weekly",resolved:Boolean(normalized)};
    }

    function showWeeklyClosureSummaryDiagnostic(stage, code, error, context = {}) {
      const driverUid = String(context.driverUid || auth.currentUser?.uid || closureState.uid || "—");
      const periodId = String(context.weeklyPeriodId || closureState.weeklyPeriodId || getActiveWeeklyPeriod().id || "—");
      const eventType = String(context.eventType || (["WEEKLY_PERIOD_REFERENCE_FIXED","WEEKLY_PERIOD_NOT_FOUND","WEEKLY_PERIOD_FALLBACK_USED"].includes(String(code)) ? "WARNING" : "ERROR")).toUpperCase();
      if (window.ExploraProductionPolicy && !window.ExploraProductionPolicy.handle("cierre", error, { eventType, silent:eventType==="WARNING", message:"No pudimos completar el cierre semanal. Intenta nuevamente.", context:{stage,code,...context} })) {
        const message=$("weeklyClosureMsg");if(message&&eventType!=="WARNING"){message.textContent="No pudimos completar el cierre semanal. Intenta nuevamente.";message.className="weekly-closure-msg closure-receipt-error";message.hidden=false;}
        return false;
      }
      const key = [stage,code,driverUid,periodId].join("|");
      if (weeklyClosureSummaryDiagnosticSeen.has(key)) return false;
      weeklyClosureSummaryDiagnosticSeen.add(key);
      const snapshot = context.snapshot || closureState.statusData?.weeklySnapshot || window.ExploraWeeklyEngine?.getSnapshot?.() || {};
      const weeklyScope = context.weeklyScope || weeklySummaryPeriodInfo(periodId);
      let daysRemaining = "—";
      try {
        const parts = getArgentinaParts(new Date());
        const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
        daysRemaining = (6 - weekday + 7) % 7;
      } catch (_) {}
      const firebaseCode = String(context.firebaseCode || error?.code || "—");
      const jsMessage = String(error?.message || context.message || code || "Error sin mensaje");
      const firebaseMessage = String(context.firebaseMessage || (firebaseCode !== "—" ? jsMessage : "—"));
      const payerRole = context.payerRole || snapshot.payerRole || closureState.statusData?.payer || null;
      const whoPays = payerRole === "driver" ? "CHOFER A DAVID" : payerRole === "admin" || payerRole === "david" ? "DAVID AL CHOFER" : "EQUILIBRADO";
      const knownWeek = Boolean(periodId && weeklyScope?.weeklyPeriodId !== "");
      weeklyClosureSummaryDiagnosticText = [
        `EXPLORA - ${eventType} WEEKLY_CLOSURE_STATUS_AND_SUMMARY`,
        "MÓDULO: WEEKLY_CLOSURE_STATUS_AND_SUMMARY",
        `ETAPA: ${stage}`,
        `TIPO_EVENTO: ${eventType}`,
        `CÓDIGO INTERNO: ${code}`,
        `MENSAJE REAL FIREBASE: ${firebaseCode}${firebaseMessage !== "—" ? ` · ${firebaseMessage}` : ""}`,
        `MENSAJE REAL JAVASCRIPT: ${jsMessage}`,
        `STACK: ${String(error?.stack || "—")}`,
        `FUNCIÓN: ${context.functionName || "—"}`,
        `UID AUTH: ${auth.currentUser?.uid || "—"}`,
        `ROL: ${exploraSession.role || "—"}`,
        `DRIVER UID: ${driverUid}`,
        `SEMANA ACTIVA: ${periodId}`,
        `PERÍODO SEMANAL: ${weeklyScope.weeklyPeriodId || periodId || "—"}`,
        `FUENTE DEL PERÍODO: ${weeklyScope.source || "—"}`,
        `CIERRE DE LA SEMANA: ${weeklyScope.endMs ? new Date(weeklyScope.endMs).toISOString() : "—"}`,
        `DÍAS RESTANTES: ${daysRemaining}`,
        `EFECTIVO: ${formatClosureMoney(snapshot.cashCollectedByDriver || 0)}`,
        `TRANSFERENCIAS: ${formatClosureMoney(Number(snapshot.transferCollectedByAdmin||0)+Number(snapshot.aliasCollectedByAdmin||0))}`,
        `TARJETAS: ${formatClosureMoney(snapshot.cardCollectedByAdmin || 0)}`,
        `QR: ${formatClosureMoney(snapshot.qrCollectedByAdmin || 0)}`,
        `PARTICIPACIÓN DEL CHOFER: 50%`,
        `GASTOS: ${formatClosureMoney(snapshot.totalExpenses || 0)}`,
        `DINERO DERIVADO: ${formatClosureMoney(snapshot.derivedAmountForEmitter || 0)}`,
        `COLABORACIÓN PARA BONO: ${formatClosureMoney(snapshot.collaborationAmount || 0)}`,
        `DEUDAS: ${formatClosureMoney(snapshot.directDebtInstallmentTotal || 0)}`,
        `PRÉSTAMOS: ${formatClosureMoney(snapshot.operationalLoanDriverShare || 0)}`,
        `OTROS MOVIMIENTOS: ${formatClosureMoney(context.otherAdjustments || 0)}`,
        `BONO DERIVADOR: ${formatClosureMoney(snapshot.derivationBonusAmount || 0)}`,
        `SALDO FINAL: ${formatClosureMoney(context.finalAmount ?? snapshot.settlementAmount ?? 0)}`,
        `QUIÉN PAGA: ${whoPays}`,
        `RUTA STORAGE: ${context.storagePath || "—"}`,
        `RUTA FIRESTORE: ${context.firestorePath || "acumulados_semanales + cierres_semanales"}`,
        `QUERY USADA: ${context.query || "getDriverWeeklySnapshot(uid, weeklyPeriodId)"}`,
        `TIMESTAMP: ${new Date().toISOString()}`
      ].join("\n");
      const textEl = $("weeklySummaryDiagnosticText"); if (textEl) textEl.textContent = weeklyClosureSummaryDiagnosticText;
      const titleEl = $("weeklySummaryDiagnosticTitle"); if (titleEl) titleEl.textContent = `EXPLORA - ${eventType} CIERRE SEMANAL`;
      const backdrop = $("weeklySummaryDiagnosticBackdrop");
      if (backdrop) backdrop.dataset.eventType = eventType;
      backdrop?.classList.add("is-open"); backdrop?.setAttribute("aria-hidden","false");
      window.lockPageScroll?.("weekly-summary-diagnostic");
      return true;
    }
    function closeWeeklyClosureSummaryDiagnostic() {
      const backdrop = $("weeklySummaryDiagnosticBackdrop");
      backdrop?.classList.remove("is-open"); backdrop?.setAttribute("aria-hidden","true");
      window.unlockPageScroll?.("weekly-summary-diagnostic");
    }
    async function copyWeeklyClosureSummaryDiagnostic() {
      const value = weeklyClosureSummaryDiagnosticText || "EXPLORA - ERROR WEEKLY_CLOSURE_STATUS_AND_SUMMARY";
      try { await navigator.clipboard.writeText(value); }
      catch (_) { const area=document.createElement("textarea");area.value=value;area.style.cssText="position:fixed;left:-10000px;top:0";document.body.appendChild(area);area.select();document.execCommand("copy");area.remove(); }
    }
    window.ExploraWeeklyClosureSummaryDiagnostic = showWeeklyClosureSummaryDiagnostic;

    function escapeWeeklyClosureHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
      }[character]));
    }

    function renderExistingClosureReceipt(statusData = {}) {
      const box = $("weeklyClosureExistingReceipt");
      if (!box) return;
      const merged = { ...(statusData.closure || {}), ...(statusData.payment || {}), ...statusData };
      const source = window.ExploraReceiptEngine?.resolveReceiptSource?.(merged) || {};
      const url = String(statusData.receiptUrl || source.url || "").trim();
      if (!url) { box.hidden = true; box.innerHTML = ""; return; }
      const mime = String(source.mimeType || merged.receiptMimeType || "").toLowerCase();
      const uploaderRole = String(merged.receiptUploadedByRole || merged.driverReceiptUploadedByRole || merged.adminReceiptUploadedByRole || merged.davidReceiptUploadedByRole || "").toLowerCase();
      const uploader = uploaderRole === "admin" || uploaderRole === "administrador" ? "David" : (merged.driverName || getProfileName(exploraSession.profile || {}, auth.currentUser) || "Chofer");
      const fileName = String(source.fileName || merged.receiptFileName || "Comprobante de cierre");
      const fileSize = closureReceiptFileSize(source.fileSize || merged.receiptSize || 0);
      const periodId = String(statusData.weeklyPeriodId || merged.closureWeek || merged.weeklyPeriodId || "—");
      box.hidden = false;
      box.innerHTML = `<div class="weekly-closure-existing-receipt-head"><div><span>COMPROBANTE CARGADO</span><strong>Subido por ${escapeWeeklyClosureHtml(uploader)}</strong></div><b class="weekly-closure-existing-receipt-requirement">REGISTRADO</b></div><div class="weekly-closure-existing-receipt-meta"><div><span>Semana</span><strong>${escapeWeeklyClosureHtml(periodId)}</strong></div><div><span>Archivo</span><strong>${escapeWeeklyClosureHtml(fileName)} · ${escapeWeeklyClosureHtml(fileSize)}</strong></div></div>${mime.includes("pdf") || url.toLowerCase().includes(".pdf") ? "" : `<img src="${escapeWeeklyClosureHtml(url)}" alt="Comprobante del cierre semanal">`}<a href="${escapeWeeklyClosureHtml(url)}" target="_blank" rel="noopener">${mime.includes("pdf") ? "VER ARCHIVO" : "VER FOTO"}</a>`;
    }

    function finiteClosureNumber(value, fallback = 0) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const compact = value.trim().replace(/\s/g, "").replace(/[^\d,.-]/g, "");
        const normalized = compact.includes(",")
          ? compact.replace(/\./g, "").replace(",", ".")
          : compact;
        const parsed = Number(normalized);
        if (Number.isFinite(parsed)) return parsed;
      }
      return Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
    }

    function safeClosureAmount(value) {
      return Math.max(0, finiteClosureNumber(value, 0));
    }

    function strictClosureMoney(value,{required=false}={}) {
      if(value===null||value===undefined||value==="")return required?null:null;
      const parsed=typeof value==="number"?value:Number(String(value).trim().replace(/\s/g,"").replace(/\./g,"").replace(",","."));
      return Number.isFinite(parsed)?parsed:null;
    }

    function safeClosureText(value, fallback = "No aplica") {
      const text = String(value ?? "").trim();
      return text && text !== "undefined" && text !== "null" ? text : fallback;
    }

    function safeClosureArray(value) {
      return Array.isArray(value) ? value.filter(Boolean) : [];
    }

    function normalizeWeeklyClosureData(statusData = {}, weeklyScope = {}) {
      try {
        const rawSnapshot = statusData?.weeklySnapshot && typeof statusData.weeklySnapshot === "object" ? statusData.weeklySnapshot : {};
        const resolvedExpenseTotals = resolveWeeklyExpenseTotals(rawSnapshot);
        const snapshot = {
          ...rawSnapshot,
          grossBilling:safeClosureAmount(rawSnapshot.totalFacturado ?? rawSnapshot.grossBilling ?? rawSnapshot.facturacion),
          transferCollectedByAdmin:safeClosureAmount(rawSnapshot.transferencias ?? rawSnapshot.transferCollectedByAdmin),
          aliasCollectedByAdmin:safeClosureAmount(rawSnapshot.aliasCollectedByAdmin),
          qrCollectedByAdmin:safeClosureAmount(rawSnapshot.qr ?? rawSnapshot.qrCollectedByAdmin),
          cardCollectedByAdmin:safeClosureAmount(rawSnapshot.tarjetas ?? rawSnapshot.cardCollectedByAdmin),
          totalCollectedByAdmin:safeClosureAmount(rawSnapshot.totalCollectedByAdmin),
          cashCollectedByDriver:safeClosureAmount(rawSnapshot.efectivo ?? rawSnapshot.cashCollectedByDriver),
          totalExpenses:resolvedExpenseTotals.total,
                    performanceDerivationPercent:Math.max(0, finiteClosureNumber(rawSnapshot.performanceDerivationPercent ?? rawSnapshot.derivationPercent, 0)),
                    derivationBonusAmount:safeClosureAmount(rawSnapshot.derivationBonusAmount),
          collaborationAmount:safeClosureAmount(rawSnapshot.aporteAlBono ?? rawSnapshot.collaborationAmount),
          repairFundRate:.05,
          repairFundAmount:Object.prototype.hasOwnProperty.call(rawSnapshot,"repairFundAmount")
            ? safeClosureAmount(rawSnapshot.repairFundAmount)
            : Math.round(safeClosureAmount(rawSnapshot.totalFacturado ?? rawSnapshot.grossBilling ?? rawSnapshot.facturacion) * .05),
          operationalLoanTotal:safeClosureAmount(rawSnapshot.operationalLoanTotal),
          operationalLoanDriverShare:safeClosureAmount(rawSnapshot.prestamos ?? rawSnapshot.operationalLoanDriverShare),
          directDebtInstallmentTotal:safeClosureAmount(rawSnapshot.directDebtInstallmentTotal),
          directDebtInstallments:safeClosureArray(rawSnapshot.directDebtInstallments),
          driverPaidSharedExpenses:resolvedExpenseTotals.driverPaid,
          adminPaidSharedExpenses:resolvedExpenseTotals.adminPaid,
          driverPaidExpenses:resolvedExpenseTotals.driverPaid,
          adminPaidExpenses:resolvedExpenseTotals.adminPaid,
          driverExpenseCredit:safeClosureAmount(rawSnapshot.driverExpenseCredit),
          adminExpenseCredit:safeClosureAmount(rawSnapshot.adminExpenseCredit),
          adminBaseShare:safeClosureAmount(rawSnapshot.adminBaseShare),
          dailyRankingBonuses:safeClosureArray(rawSnapshot.dailyRankingBonuses),
          dailyRankingWeeklyWinners:safeClosureArray(rawSnapshot.dailyRankingWeeklyWinners),
          dailyRankingBonusAmount:safeClosureAmount(rawSnapshot.dailyRankingBonusAmount ?? rawSnapshot.dailyBonusAmount ?? rawSnapshot.bonosDiarios),
          netSettlementBeforeDailyBonuses:finiteClosureNumber(rawSnapshot.netSettlementBeforeDailyBonuses,0),
          settlementAmount:safeClosureAmount(rawSnapshot.saldoFinal ?? rawSnapshot.settlementAmount)
        };
        const periodId = safeClosureText(statusData.weeklyPeriodId || snapshot.weeklyPeriodId || getActiveWeeklyPeriod()?.id, "Período semanal");
        const closure = statusData.closure && typeof statusData.closure === "object" ? statusData.closure : {};
        const payment = statusData.payment && typeof statusData.payment === "object" ? statusData.payment : {};
        let payer = String(statusData.payer || snapshot.payerRole || "").toLowerCase();
        if (payer === "david") payer = "admin";
        if (!["driver","admin"].includes(payer)) payer = "";
        let amount = safeClosureAmount(statusData.amount);
        if (statusData.isPreview || amount <= 0) amount = snapshot.settlementAmount;
        const strictSignedBalance = strictClosureMoney(snapshot.finalBalance ?? snapshot.netBalance ?? snapshot.settlementBalance ?? snapshot.saldoFinal, { required:false });
        const snapshotComplete = snapshot.snapshotComplete === true || statusData.snapshotComplete === true;
        if (!payer && strictSignedBalance !== null && Math.abs(strictSignedBalance) >= 0.01) {
          payer = strictSignedBalance < 0 ? "driver" : "admin";
          if (!(amount > 0)) amount = Math.abs(strictSignedBalance);
        }
        let balanced = snapshotComplete === true && strictSignedBalance !== null && Math.abs(strictSignedBalance) < 0.01;
        if (balanced) { payer = ""; amount = 0; }
        if (!balanced && !payer && strictSignedBalance !== null && Math.abs(strictSignedBalance) >= 0.01) payer = strictSignedBalance < 0 ? "driver" : "admin";
        const knownWeeklyPeriod = Boolean(periodId);
        const normalized = {
          statusData:{ ...statusData, closure, payment },
          snapshot,
          closure,
          payment,
          periodId,
          driverName:safeClosureText(statusData.driverName || snapshot.driverName || getProfileName(exploraSession.profile || {}, auth.currentUser), "Chofer"),
          weeklyScope:weeklyScope && typeof weeklyScope === "object" ? weeklyScope : {},
          weeklyPeriodId:periodId,
          knownWeeklyPeriod,
          payer:payer || null,
          amount,
          balanced,
          receiptUrl:safeClosureText(statusData.receiptUrl, ""),
          receiptPath:safeClosureText(statusData.receiptPath, ""),
          closureRecord:statusData.closureRecord || null,
          paymentRecord:statusData.paymentRecord || null,
          isPreview:Boolean(statusData.isPreview)
        };
        return normalized;
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic("NORMALIZE_WEEKLY_CLOSURE_DATA", "WEEKLY_CLOSURE_MISSING_REQUIRED_DATA", error, {
          functionName:"normalizeWeeklyClosureData",
          weeklyPeriodId:statusData?.weeklyPeriodId,
          snapshot:statusData?.weeklySnapshot,
          finalAmount:statusData?.amount,
          payerRole:statusData?.payer,
          firestorePath:"acumulados_semanales + cierres_semanales",
          query:"normalize numbers/text/arrays before render"
        });
        throw error;
      }
    }

    function closurePercent(value) {
      const number = finiteClosureNumber(value, 0);
      if (!Number.isFinite(number)) return 0;
      return Math.round(number * 100) / 100;
    }

    function formatClosurePercent(value, { sign = false } = {}) {
      const number = closurePercent(value);
      const text = Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
      return `${sign && number > 0 ? "+" : ""}${text}%`;
    }

    function calculateDriverPercent() { return { basePercent:50, currentPercent:50 }; }

    function calculateDriverShare(data = {}) {
      const grossBilling=safeClosureAmount(data.snapshot?.grossBilling),derivationBonus=safeClosureAmount(data.snapshot?.derivationBonusAmount ?? data.snapshot?.bonoDerivacionEstimado);
      return Math.max(0,Math.round(grossBilling*.5+derivationBonus));
    }

    function calculateWeeklyDiscounts(data = {}) {
      try {
        const snapshot = data.snapshot || {};
        const loans = safeClosureAmount(snapshot.operationalLoanDriverShare);
        const exploreLoanDiscount = safeClosureAmount(snapshot.exploreLoanDiscount ?? snapshot.prestamoExplora);
        const collaboration = safeClosureAmount(snapshot.collaborationAmount);
        const grossBilling = safeClosureAmount(snapshot.grossBilling);
        const repairFundRate = .05;
        const repairFundAmount = Object.prototype.hasOwnProperty.call(snapshot,"repairFundAmount")
          ? safeClosureAmount(snapshot.repairFundAmount)
          : Math.round(grossBilling * repairFundRate);
        const debtRows = safeClosureArray(snapshot.directDebtInstallments);
        let fines = 0;
        let otherDebtDiscounts = 0;
        debtRows.forEach(row => {
          const amount = safeClosureAmount(row?.amount);
          const reason = `${row?.reason || ""} ${row?.reasonLabel || ""}`.toLowerCase();
          if (/fine|multa/.test(reason)) fines += amount;
          else otherDebtDiscounts += amount;
        });
        const debtTotal = safeClosureAmount(snapshot.directDebtInstallmentTotal);
        const classifiedDebtTotal = fines + otherDebtDiscounts;
        if (debtTotal > classifiedDebtTotal) otherDebtDiscounts += debtTotal - classifiedDebtTotal;
        const adminExpenseCredit = Object.prototype.hasOwnProperty.call(snapshot,"adminExpenseCredit")
          ? safeClosureAmount(snapshot.adminExpenseCredit)
          : safeClosureAmount(snapshot.adminPaidSharedExpenses) * .5 + loans;
        const sharedExpenseDiscounts = Math.max(0, Math.round(adminExpenseCredit - loans));
        const explicitOtherDiscounts = safeClosureAmount(snapshot.otherDiscounts ?? snapshot.otrosDescuentos ?? snapshot.negativeAdjustments);
        const otherDiscounts = Math.max(0, Math.round(otherDebtDiscounts + sharedExpenseDiscounts + explicitOtherDiscounts));
        const totalDiscounts = Math.max(0, Math.round(loans + exploreLoanDiscount + fines + repairFundAmount + collaboration + otherDiscounts));
        return {
          loans:Math.round(loans), exploreLoanDiscount:Math.round(exploreLoanDiscount), fines:Math.round(fines),
          repairFundRate, repairFundAmount:Math.round(repairFundAmount),
          collaboration:Math.round(collaboration), otherDiscounts, totalDiscounts
        };
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic("CALCULATE_DISCOUNTS", "DISCOUNT_CALC_FAILED", error, {
          functionName:"calculateWeeklyDiscounts", weeklyPeriodId:data.periodId, snapshot:data.snapshot,
          finalAmount:data.amount, payerRole:data.payer, firestorePath:"prestamos_operativos + deudas_choferes + weeklySnapshot",
          query:"loans + fines + collaboration + other discounts"
        });
        throw error;
      }
    }

    function calculateFinalBalance(data = {}) {
      try {
        const snapshot = data.snapshot || {};
        const grossBilling = safeClosureAmount(snapshot.grossBilling);
        const transfers = safeClosureAmount(snapshot.transferCollectedByAdmin) + safeClosureAmount(snapshot.aliasCollectedByAdmin);
        const cards = safeClosureAmount(snapshot.cardCollectedByAdmin);
        const qr = safeClosureAmount(snapshot.qrCollectedByAdmin);
        const totalCollectedByAdmin = safeClosureAmount(snapshot.totalCollectedByAdmin) || transfers + cards + qr;
        const cash = safeClosureAmount(snapshot.cashCollectedByDriver);
        const percentInfo = calculateDriverPercent(data);
        const driverShareBeforeDiscounts = calculateDriverShare(data, percentInfo);
        const discounts = calculateWeeklyDiscounts(data);
        const expenseTotals = resolveWeeklyExpenseTotals(snapshot);
        const driverExpenseShare = Math.round(expenseTotals.total * .5);
        const driverPaidExpenses = expenseTotals.driverPaid;
        const repairFundAmount = Math.round(grossBilling * .05);
        const repairFundDriverShare = Math.floor(repairFundAmount / 2);
        const repairFundAdminShare = repairFundAmount - repairFundDriverShare;
        const driverFundsAfterExpenses = Math.round(cash - driverPaidExpenses - repairFundDriverShare);
        const profitAfterExpenses = Math.round(grossBilling - expenseTotals.total - repairFundAmount);
        const driverProfitShare = Math.round(profitAfterExpenses / 2);
        const exploraProfitShare = profitAfterExpenses - driverProfitShare;
        const derivationBonus = safeClosureAmount(snapshot.derivationBonusAmount);
        const driverNetShareBeforeDiscounts = Math.round(driverProfitShare + derivationBonus);
        const driverDiscountsWithoutRepairFund = Math.round(discounts.loans + discounts.exploreLoanDiscount + discounts.fines + discounts.collaboration + discounts.otherDiscounts);
        const driverShareAfterDiscounts = Math.round(driverNetShareBeforeDiscounts - driverDiscountsWithoutRepairFund);
        const driverExpenseCredit = Math.round(driverPaidExpenses * .5);
        const calculatedBalanceBeforeDailyBonuses = Math.round(driverShareAfterDiscounts - driverFundsAfterExpenses);
        const dailyBonuses = safeClosureArray(snapshot.dailyRankingBonuses);
        const dailyWeeklyWinners = safeClosureArray(snapshot.dailyRankingWeeklyWinners);
        const dailyBonusTotal = safeClosureAmount(snapshot.dailyRankingBonusAmount ?? dailyBonuses.reduce((sum,row)=>sum+safeClosureAmount(row?.bonusAmount),0));
        const personalRecordBonuses = safeClosureArray(snapshot.personalRecordBonuses);
        const personalRecordBonusTotal = safeClosureAmount(snapshot.personalRecordBonusAmount ?? personalRecordBonuses.reduce((sum,row)=>sum+safeClosureAmount(row?.bonusAmount),0));
        const strictMoney = strictClosureMoney;
        const balanceBeforeDailyBonuses = calculatedBalanceBeforeDailyBonuses;
        const explicitFinal = strictMoney(snapshot.netSettlementToDriver ?? snapshot.finalBalance ?? snapshot.saldoFinal ?? snapshot.settlementBalance ?? snapshot.netBalance, { required:false, field:"finalBalance" });
        const snapshotComplete = snapshot.snapshotComplete === true;
        const authoritativePayerRaw = String(snapshot.payerRole || snapshot.quienPaga || "").trim().toLowerCase();
        const authoritativePayer = authoritativePayerRaw === "driver" || authoritativePayerRaw === "chofer" ? "driver" : authoritativePayerRaw === "admin" || authoritativePayerRaw === "david" ? "admin" : null;
        const computedSigned = Number.isFinite(balanceBeforeDailyBonuses) ? Math.round(balanceBeforeDailyBonuses + dailyBonusTotal + personalRecordBonusTotal) : null;
        const canonicalSigned = computedSigned;
        if (canonicalSigned === null) throw Object.assign(new Error("No se pudo determinar un saldo final válido."), { code:"WEEKLY_CLOSURE_INVALID_AMOUNT" });
        const balanced = Math.abs(canonicalSigned) < WEEKLY_CLOSURE_BALANCE_TOLERANCE;
        const payer = balanced ? null : canonicalSigned > 0 ? "admin" : "driver";
        if (!balanced && authoritativePayer && authoritativePayer !== payer) throw Object.assign(new Error("payerRole no coincide con el signo de finalBalance."), { code:"WEEKLY_CLOSURE_INVALID_PAYER" });
        const amount = balanced ? 0 : Math.abs(canonicalSigned);
        const netSettlementToDriver = balanced ? 0 : canonicalSigned;
        const resultLabel = balanced ? "CUENTA EQUILIBRADA" : payer === "driver" ? "SALDO A FAVOR DE DAVID" : "SALDO A FAVOR DEL CHOFER";
        const actionText = balanced ? "No hay saldo pendiente entre el chofer y David." : payer === "driver" ? "Debés pagarle a David" : "David debe pagarte";
        const resultText = balanced ? "Cuenta equilibrada · $0" : `${resultLabel} · ${actionText} ${formatClosureMoney(amount)}`;
        return {
          ...data,grossBilling,cash,transfers,cards,qr,totalCollectedByAdmin,
          basePercent:50,currentDriverPercent:50,baseShare:Math.round(grossBilling*.5),driverShareBeforeDiscounts,driverNetShareBeforeDiscounts,driverShareAfterDiscounts,
          profitAfterExpenses,driverProfitShare,exploraProfitShare,
          driverExpenseShare,driverPaidExpenses,driverFundsAfterExpenses,driverExpenseCredit,netSettlementToDriver,
          balanceBeforeDailyBonuses,dailyBonusTotal,dailyBonuses,dailyWeeklyWinners,personalRecordBonuses,personalRecordBonusTotal,
          loans:discounts.loans,exploreLoanDiscount:discounts.exploreLoanDiscount,fines:discounts.fines,
          repairFundRate:discounts.repairFundRate,repairFundAmount,repairFundDriverShare,repairFundAdminShare,collaboration:discounts.collaboration,
          otherDiscounts:discounts.otherDiscounts,totalDiscounts:driverDiscountsWithoutRepairFund,
          payer,amount,balanced,actionText,resultLabel,resultText,
          expenses:expenseTotals.total,
          derivationBonus
        };
      } catch (error) {
        if (!["DRIVER_PERCENT_INVALID","DRIVER_SHARE_CALC_FAILED","DISCOUNT_CALC_FAILED"].includes(String(error?.code || ""))) {
          showWeeklyClosureSummaryDiagnostic("CALCULATE_FINAL_BALANCE", "FINAL_BALANCE_CALC_FAILED", error, {
            functionName:"calculateFinalBalance", weeklyPeriodId:data.periodId, snapshot:data.snapshot,
            finalAmount:data.amount, payerRole:data.payer, firestorePath:"weeklySnapshot + calculated driver share",
            query:"driver share after discounts compared with cash in driver hands"
          });
        }
        throw error;
      }
    }


    function normalizeWeeklySummaryForRender(input = {}) {
      const summary = input && typeof input === "object" ? input : {};
      const snapshot = summary.snapshot && typeof summary.snapshot === "object" ? summary.snapshot : {};
      const maxMoney = (...values) => Math.max(0, ...values.map(value => safeClosureAmount(value)));

      const grossBilling = maxMoney(summary.grossBilling, snapshot.grossBilling, snapshot.totalFacturado, snapshot.facturacion);
      const cash = maxMoney(summary.cash, snapshot.cashCollectedByDriver, snapshot.efectivo, snapshot.totalEfectivo);
      const transfersFromSnapshot = safeClosureAmount(snapshot.transferCollectedByAdmin ?? snapshot.transferencias ?? snapshot.totalTransferencias)
        + safeClosureAmount(snapshot.aliasCollectedByAdmin ?? snapshot.alias ?? snapshot.totalAlias);
      const transfers = maxMoney(summary.transfers, transfersFromSnapshot);
      const cards = maxMoney(summary.cards, snapshot.cardCollectedByAdmin, snapshot.tarjetas, snapshot.totalTarjetas);
      const qr = maxMoney(summary.qr, snapshot.qrCollectedByAdmin, snapshot.qr, snapshot.totalQr);
      const totalCollectedByAdmin = Math.round(transfers + cards + qr);

      const expenseTotals = resolveWeeklyExpenseTotals({
        ...snapshot,
        totalExpenses:maxMoney(summary.expenses, snapshot.totalExpenses, snapshot.gastos, snapshot.expenseTotal, snapshot.totalGastos),
        driverPaidSharedExpenses:maxMoney(summary.driverPaidExpenses, snapshot.driverPaidSharedExpenses, snapshot.driverPaidExpenses),
        adminPaidSharedExpenses:maxMoney(summary.adminPaidExpenses, snapshot.adminPaidSharedExpenses, snapshot.adminPaidExpenses)
      });
      const expenses = Math.max(expenseTotals.total, safeClosureAmount(summary.expenses));
      let driverPaidExpenses = Math.max(expenseTotals.driverPaid, safeClosureAmount(summary.driverPaidExpenses));
      let adminPaidExpenses = Math.max(expenseTotals.adminPaid, safeClosureAmount(summary.adminPaidExpenses));
      const knownPaid = driverPaidExpenses + adminPaidExpenses;
      if (expenses > knownPaid + 0.01) driverPaidExpenses += expenses - knownPaid;
      if (driverPaidExpenses + adminPaidExpenses > expenses + 0.01 && expenses > 0) {
        const scale = expenses / (driverPaidExpenses + adminPaidExpenses);
        driverPaidExpenses *= scale;
        adminPaidExpenses *= scale;
      }
      driverPaidExpenses = Math.round(driverPaidExpenses);
      adminPaidExpenses = Math.round(adminPaidExpenses);
      const normalizedExpenseRows = mergeWeeklyClosureExpenseRows(
        summary.expenseRows, summary.gastosRows, summary.currentExpenses,
        snapshot.expenseRows, Array.isArray(snapshot.expenses) ? snapshot.expenses : [], snapshot.gastosRows, snapshot.currentExpenses
      );

      const baseShare = Math.round(grossBilling * .5);
      const derivationBonus = maxMoney(summary.derivationBonus, snapshot.derivationBonusAmount, snapshot.bonoDerivacionEstimado);
      const driverExpenseShare = Math.round(expenses * .5);
      const loans = maxMoney(summary.loans, snapshot.operationalLoanDriverShare, snapshot.prestamos);
      const exploreLoanDiscount = maxMoney(summary.exploreLoanDiscount, snapshot.exploreLoanDiscount, snapshot.prestamoExplora);
      const fines = maxMoney(summary.fines, snapshot.directDebtInstallmentTotal, snapshot.multas);
      const repairFundRate = .05;
      const repairFundAmount = Math.round(grossBilling * repairFundRate);
      const repairFundDriverShare = Math.floor(repairFundAmount / 2);
      const repairFundAdminShare = repairFundAmount - repairFundDriverShare;
      const profitAfterExpenses = Math.round(grossBilling - expenses - repairFundAmount);
      const driverProfitShare = Math.round(profitAfterExpenses / 2);
      const exploraProfitShare = profitAfterExpenses - driverProfitShare;
      const driverShareBeforeDiscounts = Math.round(baseShare + derivationBonus);
      const driverNetShareBeforeDiscounts = Math.round(driverProfitShare + derivationBonus);

      const collaboration = maxMoney(summary.collaboration, snapshot.collaborationAmount, snapshot.aporteAlBono);
      const otherDiscounts = maxMoney(summary.otherDiscounts, snapshot.otherDiscounts, snapshot.otrosDescuentos, snapshot.negativeAdjustments);
      const totalDiscounts = Math.round(loans + exploreLoanDiscount + fines + collaboration + otherDiscounts);

      const driverFundsAfterExpenses = Math.round(cash - driverPaidExpenses - repairFundDriverShare);
      const driverShareAfterDiscounts = Math.round(driverNetShareBeforeDiscounts - totalDiscounts);
      const balanceBeforeDailyBonuses = Math.round(driverShareAfterDiscounts - driverFundsAfterExpenses);
      const dailyBonuses = safeClosureArray(summary.dailyBonuses ?? snapshot.dailyRankingBonuses);
      const dailyWeeklyWinners = safeClosureArray(summary.dailyWeeklyWinners ?? snapshot.dailyRankingWeeklyWinners);
      const dailyBonusTotal = maxMoney(
        summary.dailyBonusTotal,
        snapshot.dailyRankingBonusAmount,
        snapshot.dailyBonusAmount,
        snapshot.bonosDiarios,
        dailyBonuses.reduce((sum, row) => sum + safeClosureAmount(row?.bonusAmount), 0)
      );
      const personalRecordBonuses = safeClosureArray(summary.personalRecordBonuses ?? snapshot.personalRecordBonuses);
      const personalRecordBonusTotal = maxMoney(
        summary.personalRecordBonusTotal,
        snapshot.personalRecordBonusAmount,
        personalRecordBonuses.reduce((sum, row) => sum + safeClosureAmount(row?.bonusAmount), 0)
      );
      const netSettlementToDriver = Math.round(balanceBeforeDailyBonuses + dailyBonusTotal + personalRecordBonusTotal);
      const balanced = Math.abs(netSettlementToDriver) < WEEKLY_CLOSURE_BALANCE_TOLERANCE;
      const payer = balanced ? null : netSettlementToDriver > 0 ? "admin" : "driver";
      const amount = balanced ? 0 : Math.abs(netSettlementToDriver);
      const resultLabel = balanced ? "CUENTA EQUILIBRADA" : payer === "driver" ? "SALDO A FAVOR DE DAVID" : "SALDO A FAVOR DEL CHOFER";
      const actionText = balanced ? "No hay saldo pendiente entre el chofer y David." : payer === "driver" ? "Debés pagarle a David" : "David debe pagarte";

      const normalizedSnapshot = {
        ...snapshot,
        grossBilling,
        cashCollectedByDriver:cash,
        transferCollectedByAdmin:safeClosureAmount(snapshot.transferCollectedByAdmin ?? snapshot.transferencias),
        aliasCollectedByAdmin:safeClosureAmount(snapshot.aliasCollectedByAdmin ?? snapshot.alias),
        cardCollectedByAdmin:cards,
        qrCollectedByAdmin:qr,
        totalCollectedByAdmin,
        totalExpenses:expenses,
        gastos:expenses,
        expenseRows:normalizedExpenseRows,
        gastosRows:normalizedExpenseRows,
        currentExpenses:normalizedExpenseRows,
        driverPaidSharedExpenses:driverPaidExpenses,
        adminPaidSharedExpenses:adminPaidExpenses,
        driverPaidExpenses,
        adminPaidExpenses,
        driverBasePercentage:50,
        driverBaseShare:baseShare,
        profitAfterExpenses,
        driverProfitShare,
        exploraProfitShare,
        derivationBonusAmount:derivationBonus,
        totalSharedExpenses:expenses,
        driverSharedExpenseShare:driverExpenseShare,
        driverFundsAfterExpenses,
        repairFundRate,
        repairFundAmount,
        repairFundDriverShare,
        repairFundAdminShare,
        collaborationAmount:collaboration,
        dailyRankingBonusAmount:dailyBonusTotal,
        personalRecordBonuses,
        personalRecordBonusAmount:personalRecordBonusTotal,
        netSettlementBeforeDailyBonuses:balanceBeforeDailyBonuses,
        netSettlementToDriver,
        settlementAmount:amount,
        payerRole:payer,
        balanced
      };

      return {
        ...summary,
        snapshot:normalizedSnapshot,
        grossBilling,
        expenses,
        cash,
        transfers,
        cards,
        qr,
        totalCollectedByAdmin,
        basePercent:50,
        currentDriverPercent:50,
        baseShare,
        profitAfterExpenses,
        driverProfitShare,
        exploraProfitShare,
        derivationBonus,
        driverShareBeforeDiscounts,
        driverExpenseShare,
        driverPaidExpenses,
        adminPaidExpenses,
        driverFundsAfterExpenses,
        driverNetShareBeforeDiscounts,
        driverShareAfterDiscounts,
        loans,
        exploreLoanDiscount,
        fines,
        repairFundRate,
        repairFundAmount,
        repairFundDriverShare,
        repairFundAdminShare,
        collaboration,
        otherDiscounts,
        totalDiscounts,
        dailyBonuses,
        dailyWeeklyWinners,
        dailyBonusTotal,
        personalRecordBonuses,
        personalRecordBonusTotal,
        balanceBeforeDailyBonuses,
        netSettlementToDriver,
        balanced,
        payer,
        amount,
        resultLabel,
        actionText,
        resultText:balanced ? "Cuenta equilibrada · $0" : `${resultLabel} · ${actionText} ${formatClosureMoney(amount)}`
      };
    }

    function renderClosureSection(sectionKey, rows = [], context = {}) {
      const stage = `RENDER_SECTION_${sectionKey}`;
      try {
        const section = document.querySelector(`#weeklyClosureContent [data-weekly-section="${sectionKey}"]`);
        if (!section) throw Object.assign(new Error(`No existe la sección ${sectionKey} del cierre semanal.`), { code:"WEEKLY_CLOSURE_EMPTY_SECTION" });
        const validRows = safeClosureArray(rows);
        if (!validRows.length) throw Object.assign(new Error(`La sección ${sectionKey} no tiene filas para renderizar.`), { code:"WEEKLY_CLOSURE_EMPTY_SECTION" });
        section.hidden = false;
        section.removeAttribute("aria-hidden");
        section.style.removeProperty("display");
        validRows.forEach(row => {
          const id = safeClosureText(row?.id, "");
          if (!id || !$(id)) throw Object.assign(new Error(`Falta el campo obligatorio ${id || "sin id"} en la sección ${sectionKey}.`), { code:"WEEKLY_CLOSURE_MISSING_REQUIRED_DATA" });
          const fallback = row?.fallback === "text" ? "No aplica" : "$0";
          const renderedValue = safeClosureText(row?.value, fallback);
          setClosureDetail(id, renderedValue);
          setClosureTone(id, safeClosureText(row?.tone, "neutral"));
          const rowElement = $(id)?.closest?.(".closure-simple-row");
          if (rowElement) {
            rowElement.hidden = false;
            rowElement.style.removeProperty("display");
            const label = rowElement.querySelector("span");
            if (label && !String(label.textContent || "").trim()) label.textContent = "No aplica";
          }
        });
        section.dataset.renderState = "complete";
        return true;
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic(stage, error?.code || "WEEKLY_CLOSURE_EMPTY_SECTION", error, {
          functionName:"renderClosureSection",
          weeklyPeriodId:context.periodId,
          snapshot:context.snapshot,
          finalAmount:context.amount,
          payerRole:context.payer,
          firestorePath:`DOM#weeklyClosureContent[data-weekly-section=${sectionKey}]`,
          query:`render required section ${sectionKey}`
        });
        throw error;
      }
    }

    function dailyBonusWeekday(dayId = "") {
      const date = new Date(`${String(dayId).slice(0,10)}T12:00:00-03:00`);
      if (!Number.isFinite(date.getTime())) return "Día";
      const label = date.toLocaleDateString("es-AR",{weekday:"long",timeZone:"America/Argentina/Cordoba"});
      return label ? label.charAt(0).toUpperCase()+label.slice(1) : "Día";
    }

    function signedBalanceLabel(value = 0) {
      const signed = Number(value) || 0;
      const amount = Math.round(Math.abs(signed));
      if (amount < WEEKLY_CLOSURE_BALANCE_TOLERANCE) return { label:"CUENTA EQUILIBRADA", amount:"$0", tone:"info" };
      return signed < 0
        ? { label:"Chofer paga", amount:formatClosureMoney(amount), tone:"negative" }
        : { label:"A favor del chofer", amount:formatClosureMoney(amount), tone:"positive" };
    }

    function weeklyClosureDateLabel(value) {
      try {
        let raw = value;
        if (value?.toDate && typeof value.toDate === "function") raw = value.toDate();
        else if (value && typeof value === "object" && Number.isFinite(Number(value.seconds))) raw = new Date(Number(value.seconds) * 1000);
        const date = raw instanceof Date ? raw : raw ? new Date(raw) : null;
        if (!date || !Number.isFinite(date.getTime())) return "Sin fecha";
        return date.toLocaleDateString("es-AR", { day:"2-digit", month:"2-digit", timeZone:"America/Argentina/Cordoba" });
      } catch (_) { return "Sin fecha"; }
    }

    function weeklyClosureExpenseLabel(row = {}) {
      const raw = safeClosureText(row.category || row.categoria || row.type || row.tipo || row.concept || row.concepto || row.description || row.descripcion || row.detalle || row.name || row.nombre, "Gasto");
      const normalized = normalizeStatus(raw);
      if (normalized.includes("combust") || normalized.includes("nafta") || normalized.includes("fuel")) return "Nafta / Combustible";
      if (normalized.includes("lav")) return "Lavadero";
      if (normalized.includes("peaje")) return "Peaje";
      if (normalized.includes("estacion")) return "Estacionamiento";
      if (normalized.includes("aceite")) return "Aceite";
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    }

    function weeklyClosureExpenseDate(row = {}) {
      return weeklyClosureDateLabel(row.date || row.fecha || row.createdAt || row.creadoEn || row.timestamp || row.paidAt || row.pagadoEn || row.updatedAt || row.actualizadoEn);
    }

    function weeklyClosureExpenseAmount(row = {}) {
      return safeClosureAmount(row.amount ?? row.monto ?? row.valor ?? row.total ?? row.price ?? getMoneyValue(row));
    }

    function weeklyClosureExpenseRowId(row = {}, index = 0) {
      return String(
        row.__weeklyClosureExpenseId || row.operationId || row.operacionId || row.expenseId || row.gastoId ||
        row.documentId || row.id || `${weeklyClosureExpenseLabel(row)}_${weeklyClosureExpenseDate(row)}_${weeklyClosureExpenseAmount(row)}_${index}`
      ).trim();
    }

    function weeklyClosureNormalizeExpenseRow(row = {}, index = 0) {
      const normalized = normalizeExpenseDocument(row || {});
      const amount = weeklyClosureExpenseAmount({ ...row, ...normalized, amount: normalized.amount || row.__weeklyClosureAmount });
      const id = weeklyClosureExpenseRowId({ ...row, ...normalized, __weeklyClosureAmount: amount }, index);
      return {
        ...row,
        ...normalized,
        id: normalized.id || row.id || row.documentId || id,
        documentId: row.documentId || normalized.documentId || row.id || id,
        __weeklyClosureExpenseId: id,
        __weeklyClosureAmount: amount,
        payerRole: normalizePayerRole({ ...row, ...normalized }, row.payerRole || row.pagadoPorRol || row.pagadoPor || "driver"),
        sharedRate: normalizeSharedRate({ ...row, ...normalized }, row.sharedRate ?? .5),
        __fallback: row.__fallback === true
      };
    }

    function weeklyClosureExpenseRowsSignature(rows = []) {
      return safeClosureArray(rows).map((row, index) => `${weeklyClosureExpenseRowId(row,index)}:${Math.round(weeklyClosureExpenseAmount(row))}:${normalizePayerRole(row,"driver")}`).join("|");
    }

    function mergeWeeklyClosureExpenseRows(...lists) {
      const merged = new Map();
      lists.forEach(list => {
        if (!Array.isArray(list)) return;
        list.forEach((row, index) => {
          if (!row || typeof row !== "object") return;
          const normalized = weeklyClosureNormalizeExpenseRow(row, index);
          if (!(normalized.__weeklyClosureAmount > 0)) return;
          const key = weeklyClosureExpenseRowId(normalized, index);
          if (!merged.has(key) || merged.get(key).__fallback === true) merged.set(key, normalized);
        });
      });
      return [...merged.values()].sort((a,b) => getDocTimeMs(a) - getDocTimeMs(b));
    }

    function summarizeWeeklyClosureExpenseRows(rows = []) {
      return safeClosureArray(rows).reduce((acc,row)=>{
        const amount = Math.round(weeklyClosureExpenseAmount(row));
        if (!(amount > 0)) return acc;
        acc.total += amount;
        if (normalizePayerRole(row,"driver") === "admin") acc.adminPaid += amount;
        else acc.driverPaid += amount;
        return acc;
      },{total:0,driverPaid:0,adminPaid:0});
    }

    function applyWeeklyClosureExpenseRowsToSnapshot(snapshot = {}, rows = []) {
      const cleanRows = mergeWeeklyClosureExpenseRows(rows);
      if (!cleanRows.length) return snapshot && typeof snapshot === "object" ? snapshot : {};
      const totals = summarizeWeeklyClosureExpenseRows(cleanRows);
      const existingTotals = resolveWeeklyExpenseTotals(snapshot || {});
      return {
        ...(snapshot || {}),
        expenseRows: cleanRows,
        gastosRows: cleanRows,
        currentExpenses: cleanRows,
        totalExpenses: Math.max(existingTotals.total, totals.total),
        gastos: Math.max(existingTotals.total, totals.total),
        expenseTotal: Math.max(existingTotals.total, totals.total),
        totalGastos: Math.max(existingTotals.total, totals.total),
        driverPaidSharedExpenses: Math.max(existingTotals.driverPaid, totals.driverPaid),
        driverPaidExpenses: Math.max(existingTotals.driverPaid, totals.driverPaid),
        adminPaidSharedExpenses: Math.max(existingTotals.adminPaid, totals.adminPaid),
        adminPaidExpenses: Math.max(existingTotals.adminPaid, totals.adminPaid),
        expenseCount: Math.max(Number(snapshot?.expenseCount || 0), cleanRows.length),
        cantidadGastos: Math.max(Number(snapshot?.cantidadGastos || 0), cleanRows.length)
      };
    }

    async function loadWeeklyClosureExpenseRowsForRender(statusData = {}, periodId = "", uid = "") {
      const snapshot = statusData.weeklySnapshot && typeof statusData.weeklySnapshot === "object" ? statusData.weeklySnapshot : {};
      const period = { ...closurePeriodObject(periodId), id:String(periodId || snapshot.weeklyPeriodId || snapshot.periodId || getActiveWeeklyPeriod().id).slice(0,10) };
      const existingRows = mergeWeeklyClosureExpenseRows(
        snapshot.expenseRows, snapshot.gastosRows, snapshot.currentExpenses,
        Array.isArray(snapshot.expenses) ? snapshot.expenses : [],
        weeklyState?.expenseRows,
        weeklyState?.raw?.gastos
      ).filter(row => row.__fallback !== true && docBelongsToPeriod(row, period));
      let firestoreRows = [];
      const driverUid = String(uid || snapshot.driverUid || snapshot.uid || auth.currentUser?.uid || "").trim();
      if (driverUid) {
        try {
          const docs = await getDriverPeriodDocs("gastos", period, driverUid, { throwOnError:false });
          firestoreRows = docs
            .filter(row => docBelongsToPeriod(row, period) && isValidWeeklyExpense(row))
            .map((row,index) => weeklyClosureNormalizeExpenseRow({ ...row, __sourceCollection:"gastos" }, index));
        } catch (error) {
          console.warn("[EXPLORA cierre] no se pudieron cargar gastos individuales", error?.code || error?.message || error);
        }
      }
      return mergeWeeklyClosureExpenseRows(existingRows, firestoreRows);
    }

    function getWeeklyClosureExpenseRows(summary = {}) {
      const snapshot = summary.snapshot && typeof summary.snapshot === "object" ? summary.snapshot : {};
      const rows = mergeWeeklyClosureExpenseRows(
        summary.expenseRows,
        summary.gastosRows,
        summary.currentExpenses,
        snapshot.expenseRows,
        Array.isArray(snapshot.expenses) ? snapshot.expenses : [],
        snapshot.gastosRows,
        snapshot.currentExpenses,
        weeklyState?.expenseRows,
        weeklyState?.raw?.gastos
      );
      const detailTotal = rows.reduce((sum,row)=>sum+weeklyClosureExpenseAmount(row),0);
      const expectedTotal = Math.max(
        safeClosureAmount(summary.expenses),
        safeClosureAmount(snapshot.totalExpenses),
        safeClosureAmount(snapshot.gastos),
        safeClosureAmount(snapshot.expenseTotal),
        safeClosureAmount(snapshot.totalGastos)
      );
      if (expectedTotal > detailTotal + 0.01) {
        rows.push(weeklyClosureNormalizeExpenseRow({
          __weeklyClosureExpenseId:"aggregated-expense-fallback",
          __weeklyClosureAmount:expectedTotal - detailTotal,
          amount:expectedTotal - detailTotal,
          category:rows.length ? "Gasto sin detalle individual" : "Gastos de la semana sin detalle",
          description:"El total existe en el cierre, pero no se encontró el comprobante individual en la colección gastos.",
          payerRole:summary.driverPaidExpenses >= summary.adminPaidExpenses ? "driver" : "admin",
          __fallback:true
        }, rows.length));
      }
      return rows.sort((a,b) => getDocTimeMs(a) - getDocTimeMs(b));
    }

    function weeklyFlowMoneyRow(label, value, tone = "neutral", note = "") {
      return `<div class="weekly-liquidation-row${tone ? ` is-${escapeWeeklyClosureHtml(tone)}` : ""}"><span>${escapeWeeklyClosureHtml(label)}${note ? `<small>${escapeWeeklyClosureHtml(note)}</small>` : ""}</span><strong>${escapeWeeklyClosureHtml(value)}</strong></div>`;
    }

    function weeklyFlowFormula(label, formula, result, tone = "neutral") {
      return `<div class="weekly-liquidation-formula${tone ? ` is-${escapeWeeklyClosureHtml(tone)}` : ""}"><span>${escapeWeeklyClosureHtml(label)}</span><code>${escapeWeeklyClosureHtml(formula)}</code><strong>${escapeWeeklyClosureHtml(result)}</strong></div>`;
    }

    function renderWeeklyLiquidationFlow(summary = {}, adjustments = weeklyAdjustmentSummary(summary)) {
      const content = $("weeklyClosureContent");
      if (!content) return false;
      let flow = $("weeklyClosureReceiptFlow");
      if (!flow) {
        flow = document.createElement("section");
        flow.id = "weeklyClosureReceiptFlow";
        flow.className = "weekly-liquidation-flow";
        flow.setAttribute("aria-label", "Liquidación semanal detallada");
        const firstOldSection = content.querySelector('[data-weekly-section="A"]');
        content.insertBefore(flow, firstOldSection || content.firstChild);
      }

      const gross = Math.round(Number(summary.grossBilling || 0));
      const cash = Math.round(Number(summary.cash || 0));
      const transfers = Math.round(Number(summary.transfers || 0));
      const cards = Math.round(Number(summary.cards || 0));
      const qr = Math.round(Number(summary.qr || 0));
      const adminReceived = Math.round(Number(summary.totalCollectedByAdmin || transfers + cards + qr));
      const repairFund = Math.round(Number(summary.repairFundAmount || gross * .05 || 0));
      const repairDriverShare = Math.round(Number(summary.repairFundDriverShare ?? Math.floor(repairFund / 2)));
      const repairAdminShare = Math.round(Number(summary.repairFundAdminShare ?? (repairFund - repairDriverShare)));
      const expenseRows = getWeeklyClosureExpenseRows(summary);
      const rowTotals = summarizeWeeklyClosureExpenseRows(expenseRows);
      const expenses = Math.round(Math.max(Number(summary.expenses || 0), rowTotals.total));
      const cleanToDivide = Math.round(gross - repairFund - expenses);
      const driverTarget = Math.round(Number(adjustments.finalDriverShare || summary.driverShareAfterDiscounts || 0));
      const exploraTarget = Math.round(cleanToDivide - driverTarget);
      const driverPaidExpenses = Math.round(Math.max(rowTotals.driverPaid, Number(summary.driverPaidExpenses || 0)));
      const adminPaidExpenses = Math.round(Math.max(rowTotals.adminPaid, Number(summary.adminPaidExpenses || 0)));
      const cashAfterPhysicalExpenses = Math.round(cash - driverPaidExpenses);
      const adminAfterPhysicalExpenses = Math.round(adminReceived - adminPaidExpenses);
      const driverReal = Math.round(cashAfterPhysicalExpenses - repairDriverShare);
      const exploraReal = Math.round(adminAfterPhysicalExpenses - repairAdminShare);
      const driverExpenseShareTotal = Math.round(expenses * .5);
      const exploraExpenseShareTotal = expenses - driverExpenseShareTotal;
      const recognitionToDriver = Math.round(expenseRows.reduce((sum,row)=>{
        const amount = weeklyClosureExpenseAmount(row), payer = normalizePayerRole(row,"driver"), rate = normalizeSharedRate(row,.5);
        if (payer !== "driver") return sum;
        return sum + amount * (1 - rate);
      },0));
      const recognitionToExplora = Math.round(expenseRows.reduce((sum,row)=>{
        const amount = weeklyClosureExpenseAmount(row), payer = normalizePayerRole(row,"driver"), rate = normalizeSharedRate(row,.5);
        if (payer !== "admin") return sum;
        return sum + amount * rate;
      },0));
      const netSettlement = Math.round(Number(summary.netSettlementToDriver || adjustments.settlementToDriver || 0));
      const amount = Math.abs(netSettlement);
      const resultText = Math.abs(netSettlement) < WEEKLY_CLOSURE_BALANCE_TOLERANCE ? "CUENTA EQUILIBRADA" : netSettlement > 0 ? "DAVID / EXPLORA PAGA AL CHOFER" : "CHOFER PAGA A DAVID / EXPLORA";
      const driverAfter = Math.round(driverReal + netSettlement);
      const exploraAfter = Math.round(exploraReal - netSettlement);
      const totalControlled = driverAfter + exploraAfter + repairFund;
      const totalAvailable = gross - expenses;
      const dailyBonus = Math.round(Number(adjustments.dailyBonus || 0));
      const personalRecordBonus = Math.round(Number(adjustments.personalRecordBonus || 0));
      const driverPaidExpenseLines = expenseRows.filter(row=>normalizePayerRole(row,"driver")!=="admin");
      const adminPaidExpenseLines = expenseRows.filter(row=>normalizePayerRole(row,"driver")==="admin");

      let runningDriverCash = cash;
      const driverCashMovementRows = driverPaidExpenseLines.map(row => {
        const amount = Math.round(weeklyClosureExpenseAmount(row));
        runningDriverCash -= amount;
        const note = [weeklyClosureExpenseDate(row), safeClosureText(row.description || row.descripcion || row.notes || row.detalle || row.observaciones, "")].filter(Boolean).join(" · ");
        return weeklyFlowMoneyRow(`${weeklyClosureExpenseLabel(row)}${row.__fallback ? " · sin detalle" : ""}`, `−${formatClosureMoney(amount)}`, "negative", `${note || "Pagado físicamente por el chofer"} · queda ${formatClosureMoney(runningDriverCash)}`);
      }).join("") || `<div class="weekly-liquidation-empty">No hay gastos pagados físicamente por el chofer en esta semana.</div>`;

      const expenseDetailRows = expenseRows.map((row) => {
        const amount = Math.round(weeklyClosureExpenseAmount(row));
        const payer = normalizePayerRole(row, "driver");
        const sharedRate = normalizeSharedRate(row, .5);
        const driverShare = Math.round(amount * sharedRate);
        const exploraShare = amount - driverShare;
        const recognitionLabel = payer === "admin" ? "Chofer reconoce a Explora" : "Explora reconoce al chofer";
        const recognitionAmount = payer === "admin" ? driverShare : exploraShare;
        const detail = [weeklyClosureExpenseDate(row), safeClosureText(row.description || row.descripcion || row.notes || row.detalle || row.observaciones, "")].filter(Boolean).join(" · ");
        return `<div class="weekly-liquidation-expense${row.__fallback ? " is-fallback" : ""}">
          <div class="weekly-liquidation-expense-head"><span>${escapeWeeklyClosureHtml(weeklyClosureExpenseLabel(row))}${row.__fallback ? " · sin detalle" : ""}</span><strong>${formatClosureMoney(amount)}</strong></div>
          ${detail ? `<p class="weekly-liquidation-expense-note">${escapeWeeklyClosureHtml(detail)}</p>` : ""}
          ${weeklyFlowMoneyRow("Pagó físicamente", payer === "admin" ? "Explora" : "Chofer")}
          ${weeklyFlowMoneyRow("Parte chofer 50%", formatClosureMoney(driverShare))}
          ${weeklyFlowMoneyRow("Parte Explora 50%", formatClosureMoney(exploraShare))}
          ${weeklyFlowMoneyRow(recognitionLabel, formatClosureMoney(recognitionAmount), "positive")}
        </div>`;
      }).join("") || `<div class="weekly-liquidation-empty">No se encontraron gastos individuales para esta semana.</div>`;

      const adminPaidExpenseRows = adminPaidExpenseLines.map(row=>weeklyFlowMoneyRow(weeklyClosureExpenseLabel(row), `−${formatClosureMoney(weeklyClosureExpenseAmount(row))}`, "negative", `${weeklyClosureExpenseDate(row) || "Pagado físicamente por Explora"}`)).join("");
      const adjustmentRows = [
        summary.derivationBonus > 0 ? weeklyFlowMoneyRow("Bono derivaciones", `+${formatClosureMoney(summary.derivationBonus)}`, "positive") : "",
        dailyBonus > 0 ? weeklyFlowMoneyRow("Bono diario", `+${formatClosureMoney(dailyBonus)}`, "positive") : weeklyFlowMoneyRow("Bono diario", "$0"),
        personalRecordBonus > 0 ? weeklyFlowMoneyRow("Bono récord personal", `+${formatClosureMoney(personalRecordBonus)}`, "positive") : "",
        summary.loans > 0 ? weeklyFlowMoneyRow("Préstamos operativos", `−${formatClosureMoney(summary.loans)}`, "negative") : "",
        summary.exploreLoanDiscount > 0 ? weeklyFlowMoneyRow("Préstamo Explora", `−${formatClosureMoney(summary.exploreLoanDiscount)}`, "negative") : "",
        summary.fines > 0 ? weeklyFlowMoneyRow("Multas / choques", `−${formatClosureMoney(summary.fines)}`, "negative") : "",
        summary.collaboration > 0 ? weeklyFlowMoneyRow("Colaboración derivaciones", `−${formatClosureMoney(summary.collaboration)}`, "negative") : "",
        summary.otherDiscounts > 0 ? weeklyFlowMoneyRow("Otros descuentos", `−${formatClosureMoney(summary.otherDiscounts)}`, "negative") : ""
      ].filter(Boolean).join("");

      flow.innerHTML = `
        <div class="weekly-liquidation-title"><span>LIQUIDACIÓN CORRIDA</span><strong>Cierre claro, de corrido y sin tarjetas</strong><small>Primero se muestra la plata real, después los gastos cargados, caja chica, reparto 50/50 y diferencia final.</small></div>

        <div class="weekly-liquidation-step">
          <h3>1 · Plata que ingresó</h3>
          ${weeklyFlowMoneyRow("Chofer cobró en efectivo", formatClosureMoney(cash), "neutral", "Plata que quedó inicialmente en mano del chofer")}
          ${weeklyFlowMoneyRow("Explora cobró por cuenta", formatClosureMoney(adminReceived), "neutral", "Transferencias, tarjetas y QR antes de liquidar")}
          <div class="weekly-liquidation-subrows">
            ${weeklyFlowMoneyRow("Transferencias / Alias", formatClosureMoney(transfers))}
            ${weeklyFlowMoneyRow("Tarjetas", formatClosureMoney(cards))}
            ${weeklyFlowMoneyRow("QR", formatClosureMoney(qr))}
          </div>
          ${weeklyFlowMoneyRow("Total facturado", formatClosureMoney(gross), "info")}
        </div>

        <div class="weekly-liquidation-step">
          <h3>2 · Efectivo real del chofer</h3>
          ${weeklyFlowMoneyRow("Chofer cobró en efectivo", formatClosureMoney(cash))}
          <p class="weekly-liquidation-note">Pero de ese efectivo el chofer pagó estos gastos cargados en el módulo Gastos:</p>
          ${driverCashMovementRows}
          ${weeklyFlowMoneyRow("Total pagado físicamente por el chofer", `−${formatClosureMoney(driverPaidExpenses)}`, driverPaidExpenses > 0 ? "negative" : "neutral")}
          ${weeklyFlowMoneyRow("Efectivo que le quedó al chofer", formatClosureMoney(cashAfterPhysicalExpenses), cashAfterPhysicalExpenses < 0 ? "negative" : "positive")}
        </div>

        <div class="weekly-liquidation-step">
          <h3>3 · Caja chica · fondo tercero</h3>
          ${weeklyFlowMoneyRow("Caja chica 5%", formatClosureMoney(repairFund), "neutral")}
          ${weeklyFlowMoneyRow("Aporte chofer 2,5%", `−${formatClosureMoney(repairDriverShare)}`, "negative")}
          ${weeklyFlowMoneyRow("Aporte Explora 2,5%", `−${formatClosureMoney(repairAdminShare)}`, "negative")}
          ${weeklyFlowMoneyRow("Chofer después de gastos y caja chica", formatClosureMoney(driverReal), driverReal < 0 ? "negative" : "positive")}
          ${weeklyFlowMoneyRow("Explora después de caja chica", formatClosureMoney(exploraReal), exploraReal < 0 ? "negative" : "info")}
          ${weeklyFlowMoneyRow("Caja chica separada", formatClosureMoney(repairFund), "neutral")}
          <p class="weekly-liquidation-note">La caja chica no queda como ganancia de Explora ni como plata del chofer. Sale del cierre como fondo separado.</p>
        </div>

        <div class="weekly-liquidation-step">
          <h3>4 · Gastos 50/50 detallados</h3>
          ${expenseDetailRows}
          ${weeklyFlowMoneyRow("Total gastos detallados", formatClosureMoney(expenses), "negative")}
          ${weeklyFlowMoneyRow("Parte total chofer 50%", formatClosureMoney(driverExpenseShareTotal))}
          ${weeklyFlowMoneyRow("Parte total Explora 50%", formatClosureMoney(exploraExpenseShareTotal))}
          ${recognitionToDriver > 0 ? weeklyFlowMoneyRow("Total que Explora reconoce al chofer", formatClosureMoney(recognitionToDriver), "positive") : ""}
          ${recognitionToExplora > 0 ? weeklyFlowMoneyRow("Total que el chofer reconoce a Explora", formatClosureMoney(recognitionToExplora), "negative") : ""}
        </div>

        <div class="weekly-liquidation-step">
          <h3>5 · Total limpio para dividir</h3>
          ${weeklyFlowFormula("Cuenta", `${formatClosureMoney(gross)} − ${formatClosureMoney(repairFund)} − ${formatClosureMoney(expenses)}`, formatClosureMoney(cleanToDivide), "info")}
          ${weeklyFlowMoneyRow("Parte chofer 50%", formatClosureMoney(summary.driverProfitShare), "positive")}
          ${weeklyFlowMoneyRow("Parte Explora 50%", formatClosureMoney(summary.exploraProfitShare), "info")}
        </div>

        <div class="weekly-liquidation-step">
          <h3>6 · Bonos / multas / ajustes</h3>
          ${weeklyFlowMoneyRow("Base del chofer", formatClosureMoney(summary.driverProfitShare))}
          ${adjustmentRows || weeklyFlowMoneyRow("Ajustes", "$0")}
          ${weeklyFlowMoneyRow("Chofer debe terminar con", formatClosureMoney(driverTarget), "positive")}
          ${weeklyFlowMoneyRow("Explora debe terminar con", formatClosureMoney(exploraTarget), "info")}
          ${weeklyFlowMoneyRow("Caja chica separada", formatClosureMoney(repairFund), "neutral")}
        </div>

        <div class="weekly-liquidation-step">
          <h3>7 · Dinero real antes de liquidar</h3>
          ${weeklyFlowMoneyRow("Chofer cobró efectivo", formatClosureMoney(cash))}
          ${weeklyFlowMoneyRow("Menos gastos pagados por el chofer", `−${formatClosureMoney(driverPaidExpenses)}`, driverPaidExpenses > 0 ? "negative" : "neutral")}
          ${weeklyFlowMoneyRow("Menos aporte chofer a caja chica", `−${formatClosureMoney(repairDriverShare)}`, "negative")}
          ${weeklyFlowMoneyRow("Chofer tiene realmente", formatClosureMoney(driverReal), driverReal < 0 ? "negative" : "positive")}
          ${weeklyFlowMoneyRow("Explora recibió por cuenta", formatClosureMoney(adminReceived))}
          ${adminPaidExpenseRows}
          ${weeklyFlowMoneyRow("Menos aporte Explora a caja chica", `−${formatClosureMoney(repairAdminShare)}`, "negative")}
          ${weeklyFlowMoneyRow("Explora tiene realmente", formatClosureMoney(exploraReal), exploraReal < 0 ? "negative" : "info")}
        </div>

        <div class="weekly-liquidation-step weekly-liquidation-final-step">
          <h3>8 · Diferencia final</h3>
          ${weeklyFlowMoneyRow("Chofer debe terminar con", formatClosureMoney(driverTarget), "positive")}
          ${weeklyFlowMoneyRow("Chofer ya tiene realmente", formatClosureMoney(driverReal), driverReal < 0 ? "negative" : "neutral")}
          ${weeklyFlowFormula("Diferencia", `${formatClosureMoney(driverTarget)} − ${formatClosureMoney(driverReal)}`, formatClosureMoney(amount), netSettlement >= 0 ? "positive" : "negative")}
          <div class="weekly-liquidation-result" data-result="${netSettlement === 0 ? "balanced" : netSettlement > 0 ? "admin-pays" : "driver-pays"}">
            <span>RESULTADO FINAL</span>
            <b>${escapeWeeklyClosureHtml(resultText)}</b>
            <strong>${formatClosureMoney(amount)}</strong>
          </div>
        </div>

        <div class="weekly-liquidation-step">
          <h3>9 · Cómo queda después de liquidar</h3>
          ${weeklyFlowMoneyRow("Chofer termina con", formatClosureMoney(driverAfter), "positive")}
          ${weeklyFlowMoneyRow("Explora termina con", formatClosureMoney(exploraAfter), "info")}
          ${weeklyFlowMoneyRow("Caja chica separada", formatClosureMoney(repairFund))}
          ${weeklyFlowMoneyRow("Total controlado", formatClosureMoney(totalControlled), "neutral")}
          <p class="weekly-liquidation-note">Control: ${escapeWeeklyClosureHtml(formatClosureMoney(totalControlled))} coincide con el total disponible real después de gastos: ${escapeWeeklyClosureHtml(formatClosureMoney(totalAvailable))}.</p>
        </div>`;

      content.classList.add("weekly-liquidation-flow-active");
      return true;
    }

    function weeklyAdjustmentSummary(summary = {}) {
      const dailyBonus = safeClosureAmount(summary.dailyBonusTotal);
      const personalRecordBonus = safeClosureAmount(summary.personalRecordBonusTotal);
      const otherAdjustments = Math.round(
        safeClosureAmount(summary.derivationBonus)
        - safeClosureAmount(summary.loans)
        - safeClosureAmount(summary.exploreLoanDiscount)
        - safeClosureAmount(summary.fines)
        - safeClosureAmount(summary.collaboration)
        - safeClosureAmount(summary.otherDiscounts)
      );
      const finalDriverShare = Math.round(
        (Number(summary.driverProfitShare) || 0)
        + otherAdjustments
        + dailyBonus
        + personalRecordBonus
      );
      const settlementToDriver = Math.round(finalDriverShare - Number(summary.driverFundsAfterExpenses || 0));
      return { dailyBonus, personalRecordBonus, otherAdjustments, finalDriverShare, settlementToDriver };
    }

    function signedClosureMoney(value = 0, { plus = true } = {}) {
      const amount = Math.round(Number(value) || 0);
      if (amount === 0) return "$0";
      if (amount < 0) return `−${formatClosureMoney(Math.abs(amount))}`;
      return plus ? `+${formatClosureMoney(amount)}` : formatClosureMoney(amount);
    }

    function renderWeeklySummary(summary = {}) {
      try {
        summary = normalizeWeeklySummaryForRender(summary);
        const adjustments = weeklyAdjustmentSummary(summary);
        summary.driverShareAfterDiscounts = adjustments.finalDriverShare - adjustments.dailyBonus;
        summary.netSettlementToDriver = adjustments.settlementToDriver;
        summary.balanced = Math.abs(adjustments.settlementToDriver) < WEEKLY_CLOSURE_BALANCE_TOLERANCE;
        summary.payer = summary.balanced ? null : adjustments.settlementToDriver > 0 ? "admin" : "driver";
        summary.amount = summary.balanced ? 0 : Math.abs(adjustments.settlementToDriver);
        summary.resultLabel = summary.balanced ? "CUENTA EQUILIBRADA" : summary.payer === "driver" ? "CHOFER PAGA A DAVID" : "DAVID PAGA AL CHOFER";
        summary.actionText = summary.balanced
          ? "No hay saldo pendiente entre el chofer y David."
          : summary.payer === "driver"
            ? `El chofer conserva ${formatClosureMoney(adjustments.finalDriverShare)} y entrega el excedente a David.`
            : `David completa la diferencia para que el chofer conserve ${formatClosureMoney(adjustments.finalDriverShare)}.`;
        const resultTone = summary.balanced ? "positive" : summary.payer === "driver" ? "negative" : "info";
        renderWeeklyLiquidationFlow(summary, adjustments);

        renderClosureSection("A", [
          {id:"weeklyClosureBilling",value:formatClosureMoney(summary.grossBilling),tone:"neutral"},
          {id:"weeklyClosureCash",value:formatClosureMoney(summary.cash),tone:"neutral"},
          {id:"weeklyClosureTransfers",value:formatClosureMoney(summary.transfers),tone:"neutral"},
          {id:"weeklyClosureCards",value:formatClosureMoney(summary.cards),tone:"neutral"},
          {id:"weeklyClosureQr",value:formatClosureMoney(summary.qr),tone:"neutral"},
          {id:"weeklyClosureExpenses",value:summary.expenses > 0 ? `−${formatClosureMoney(summary.expenses)}` : "$0",tone:summary.expenses > 0 ? "negative" : "neutral"}
        ], summary);
        renderClosureSection("B", [
          {id:"weeklyClosureNetProfit",value:signedClosureMoney(summary.profitAfterExpenses,{plus:false}),tone:summary.profitAfterExpenses >= 0 ? "positive" : "negative"},
          {id:"weeklyClosureDriverProfitShare",value:signedClosureMoney(summary.driverProfitShare,{plus:false}),tone:summary.driverProfitShare >= 0 ? "positive" : "negative"},
          {id:"weeklyClosureExploraProfitShare",value:signedClosureMoney(summary.exploraProfitShare,{plus:false}),tone:summary.exploraProfitShare >= 0 ? "info" : "negative"}
        ], summary);
        renderClosureSection("C", [
          {id:"weeklyClosureDailyBonusAggregate",value:signedClosureMoney(adjustments.dailyBonus),tone:adjustments.dailyBonus > 0 ? "positive" : "neutral"},
          {id:"weeklyClosurePersonalRecordBonus",value:signedClosureMoney(adjustments.personalRecordBonus),tone:adjustments.personalRecordBonus > 0 ? "positive" : "neutral"},
          {id:"weeklyClosureRepairFund",value:summary.repairFundAmount > 0 ? formatClosureMoney(summary.repairFundAmount) : "$0",tone:summary.repairFundAmount > 0 ? "neutral" : "neutral"},
          {id:"weeklyClosureOtherAdjustments",value:signedClosureMoney(adjustments.otherAdjustments),tone:adjustments.otherAdjustments > 0 ? "positive" : adjustments.otherAdjustments < 0 ? "negative" : "neutral"},
          {id:"weeklyClosureDriverFinalShare",value:signedClosureMoney(adjustments.finalDriverShare,{plus:false}),tone:adjustments.finalDriverShare >= 0 ? "positive" : "negative"}
        ], summary);
        renderClosureSection("D", [
          {id:"weeklyClosureDriverFundsAfterExpenses",value:signedClosureMoney(summary.driverFundsAfterExpenses,{plus:false}),tone:summary.driverFundsAfterExpenses < 0 ? "negative" : "neutral"},
          {id:"weeklyClosureDriverKeeps",value:signedClosureMoney(adjustments.finalDriverShare,{plus:false}),tone:adjustments.finalDriverShare >= 0 ? "positive" : "negative"},
          {id:"weeklyClosureStatusLabel",value:summary.resultLabel,tone:resultTone,fallback:"text"},
          {id:"weeklyClosureAmount",value:formatClosureMoney(summary.amount),tone:resultTone},
          {id:"weeklyClosurePayer",value:summary.actionText,tone:resultTone,fallback:"text"}
        ], summary);
        return summary;
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic("RENDER_WEEKLY_SUMMARY", "WEEKLY_SUMMARY_RENDER_FAILED", error, {functionName:"renderWeeklySummary",weeklyPeriodId:summary.periodId,snapshot:summary.snapshot,finalAmount:summary.amount,payerRole:summary.payer,firestorePath:"DOM#weeklyClosureContent",query:"render weekly financial result"});
        throw error;
      }
    }

    function renderClosureReceiptBlock(statusData = {}, summary = {}) {
      try {
        const requirement = getWeeklyClosureReceiptRequirement(summary, statusData);
        if (summary.isPeriodClosed === false) {
          const form=$("weeklyReceiptForm"),input=$("weeklyDriverReceiptInput"),trigger=$("weeklyDriverReceiptBtn"),submit=$("weeklyClosureSubmitBtn"),uploadSection=$("weeklyClosureUploadSection"),existing=$("weeklyClosureExistingReceipt"),panel=$("weeklyReceiptPanelTitle")?.closest?.(".closure-receipt-panel");
          if(form)form.hidden=true;if(uploadSection)uploadSection.hidden=true;if(existing)existing.hidden=true;if(input)input.disabled=true;if(trigger)trigger.disabled=true;if(submit)submit.disabled=true;
          if(panel)panel.hidden=false;
          setClosureDetail("weeklyClosureAdministrativeTitle","Resumen provisional");
          setClosureDetail("weeklyClosureAdministrativeDetail","No se solicita comprobante mientras la semana está en curso.");
          const note=$("weeklyClosureNote");if(note){note.textContent=summary.balanced?"Saldo parcial equilibrado. El cierre todavía no es definitivo.":summary.payer==="driver"?`Si la semana cerrara ahora, deberías pagarle a David ${formatClosureMoney(summary.amount)}.`:`Si la semana cerrara ahora, David debería pagarte ${formatClosureMoney(summary.amount)}.`;note.className="weekly-closure-note is-info";note.hidden=false;}
          clearWeeklyClosureReceiptError();
          return requirement;
        }
        const form=$("weeklyReceiptForm"),input=$("weeklyDriverReceiptInput"),trigger=$("weeklyDriverReceiptBtn"),submit=$("weeklyClosureSubmitBtn"),uploadSection=$("weeklyClosureUploadSection");
        const panel = $("weeklyReceiptPanelTitle")?.closest?.(".closure-receipt-panel");
        if (!form || !input || !trigger || !submit || !uploadSection || !panel) throw Object.assign(new Error("Falta el motor visible del comprobante de cierre."), { code:"WEEKLY_CLOSURE_RECEIPT_DISABLED_INCORRECTLY" });

        const canDriverUpload = requirement.state === WEEKLY_CLOSURE_RECEIPT_STATE.DRIVER_RECEIPT_REQUIRED;
        form.hidden=!canDriverUpload;
        uploadSection.hidden=!canDriverUpload;
        input.disabled=!canDriverUpload;
        trigger.disabled=!canDriverUpload;
        trigger.setAttribute("aria-disabled",canDriverUpload?"false":"true");
        submit.disabled=!canDriverUpload||!(weeklyDriverReceiptState.file instanceof File);

        const adminStatus=$("weeklyClosureAdministrativeStatus"),adminTitle=$("weeklyClosureAdministrativeTitle"),adminDetail=$("weeklyClosureAdministrativeDetail");
        const note=$("weeklyClosureNote"), message=$("weeklyClosureMsg");
        if (message) { message.hidden = true; message.textContent = ""; message.className = "weekly-closure-msg closure-receipt-error"; }
        panel.dataset.requirement = requirement.state;
        panel.hidden = false;

        if (adminStatus) adminStatus.dataset.state = requirement.state === WEEKLY_CLOSURE_RECEIPT_STATE.DRIVER_RECEIPT_REQUIRED ? "pending" : "completed";
        if (note) note.className="weekly-closure-note";

        if (requirement.state === WEEKLY_CLOSURE_RECEIPT_STATE.BALANCED_NO_RECEIPT || (requirement.state === WEEKLY_CLOSURE_RECEIPT_STATE.ALREADY_CONFIRMED && summary.balanced)) {
          if(adminTitle) adminTitle.textContent="CIERRE CONFIRMADO";
          if(adminDetail) adminDetail.textContent="La cuenta está equilibrada. No hay saldo pendiente y no es necesario subir comprobante.";
          if(note){note.textContent="CIERRE EQUILIBRADO · No se necesita comprobante.";note.classList.add("is-ok");}
          $("weeklyClosureExistingReceipt")?.setAttribute("hidden","");
          const existingBox=$("weeklyClosureExistingReceipt"); if(existingBox) existingBox.innerHTML="";
        } else if (requirement.state === WEEKLY_CLOSURE_RECEIPT_STATE.DRIVER_RECEIPT_REQUIRED) {
          if(adminTitle) adminTitle.textContent="PAGO PENDIENTE";
          if(adminDetail) adminDetail.textContent="Subí el comprobante cuando realices el pago a David.";
          if(note){note.textContent="Pago pendiente. El comprobante es obligatorio para confirmar el cierre.";note.classList.add("is-danger");}
          renderExistingClosureReceipt(statusData);
        } else if (requirement.state === WEEKLY_CLOSURE_RECEIPT_STATE.ADMIN_PAYMENT_PENDING) {
          if(adminTitle) adminTitle.textContent="PAGO PENDIENTE DE DAVID";
          if(adminDetail) adminDetail.textContent="David debe registrar el comprobante desde el flujo administrativo.";
          if(note){note.textContent="No tenés que subir comprobante. El pago corresponde a David.";note.classList.add("is-info");}
          renderExistingClosureReceipt(statusData);
        } else if (requirement.state === WEEKLY_CLOSURE_RECEIPT_STATE.ALREADY_CONFIRMED) {
          if(adminTitle) adminTitle.textContent="CIERRE COMPLETADO";
          if(adminDetail) adminDetail.textContent="El comprobante ya fue registrado.";
          if(note){note.textContent="CIERRE COMPLETADO · Pago comprobado";note.classList.add("is-ok");}
          renderExistingClosureReceipt(statusData);
        } else {
          if(adminTitle) adminTitle.textContent="NO SE PUDO DETERMINAR EL ESTADO";
          if(adminDetail) adminDetail.textContent="No pudimos cargar el cierre. Intentá nuevamente.";
          if(note){note.textContent="No pudimos cargar el cierre. Intentá nuevamente.";note.classList.add("is-danger");}
          renderExistingClosureReceipt(statusData);
        }
        return canDriverUpload;
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic("RENDER_RECEIPT_UPLOAD", error?.code || "WEEKLY_CLOSURE_RECEIPT_DISABLED_INCORRECTLY", error, {functionName:"renderClosureReceiptBlock",weeklyPeriodId:summary.periodId || statusData.weeklyPeriodId,snapshot:summary.snapshot || statusData.weeklySnapshot,finalAmount:summary.amount,payerRole:summary.payer,firestorePath:"DOM#weeklyReceiptForm",query:"normalized closure state + payer + receipt ownership"});
        throw error;
      }
    }

    function auditWeeklyClosureLayout(summary = {}) {
      const modal = $("weeklyClosureOverlay")?.querySelector?.(".weekly-closure-modal");
      const content = $("weeklyClosureContent");
      if (!modal || !content) return;
      const modalOverflow = getComputedStyle(modal).overflowY;
      const contentOverflow = getComputedStyle(content).overflowY;
      if (["auto","scroll"].includes(modalOverflow) && ["auto","scroll"].includes(contentOverflow)) {
        const error = Object.assign(new Error("Se detectaron dos contenedores con scroll vertical en el cierre semanal."), { code:"WEEKLY_CLOSURE_DOUBLE_SCROLL" });
        showWeeklyClosureSummaryDiagnostic("RENDER_WEEKLY_CLOSURE_MODAL", "WEEKLY_CLOSURE_DOUBLE_SCROLL", error, {
          eventType:"ERROR", functionName:"auditWeeklyClosureLayout", weeklyPeriodId:summary.periodId,
          snapshot:summary.snapshot, finalAmount:summary.amount, payerRole:summary.payer, firestorePath:"DOM#weeklyClosureOverlay", query:"computed overflowY modal/content"
        });
        return false;
      }
      return true;
    }

    function renderWeeklyClosureModal(statusData = {}, summary = {}) {
      try {
        summary = normalizeWeeklySummaryForRender(summary);
        statusData.normalizedSummary = summary;
        statusData.weeklySnapshot = summary.snapshot;
        statusData.amount = summary.amount;
        statusData.payer = summary.payer;
        setClosureDetail("weeklyClosureDriver", summary.driverName || "Chofer");
        setClosureDetail("weeklyClosurePeriod", closurePeriodLabel(summary.closure || {}, summary.periodId || "Período semanal"));
        summary = renderWeeklySummary(summary) || summary;
        statusData.normalizedSummary = summary;
        statusData.amount = summary.amount;
        statusData.payer = summary.payer;
        renderWeeklyClosureLiveState(summary, statusData);
        const resultCard = $("weeklyClosureResultCard");
        if (resultCard) resultCard.dataset.result = summary.balanced ? "balanced" : summary.payer === "driver" ? "driver-pays" : "admin-pays";
        renderClosureReceiptBlock(statusData, summary);
        requestAnimationFrame(() => auditWeeklyClosureLayout(summary));
        return true;
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic("RENDER_WEEKLY_CLOSURE_MODAL", error?.code || "WEEKLY_CLOSURE_RENDER_BROKEN", error, {
          functionName:"renderWeeklyClosureModal", weeklyPeriodId:summary.periodId || statusData.weeklyPeriodId,
          snapshot:summary.snapshot || statusData.weeklySnapshot, finalAmount:summary.amount || statusData.amount,
          payerRole:summary.payer || statusData.payer, firestorePath:"DOM#weeklyClosureContent", query:"render TU SEMANA + TE CORRESPONDE + DESCUENTOS + SALDO FINAL + receipt block"
        });
        throw error;
      }
    }

    function weeklyPaymentMethodsState(snapshot = {}) {
      const gross=safeClosureAmount(snapshot.grossBilling ?? snapshot.totalFacturado ?? snapshot.facturacion);
      const cash=safeClosureAmount(snapshot.cashCollectedByDriver ?? snapshot.efectivo);
      const transfers=safeClosureAmount(snapshot.transferCollectedByAdmin ?? snapshot.transferencias)+safeClosureAmount(snapshot.aliasCollectedByAdmin ?? snapshot.alias);
      const cards=safeClosureAmount(snapshot.cardCollectedByAdmin ?? snapshot.tarjetas);
      const qr=safeClosureAmount(snapshot.qrCollectedByAdmin ?? snapshot.qr);
      const other=safeClosureAmount(snapshot.otherCollectedByDriver)+safeClosureAmount(snapshot.otherCollectedByAdmin);
      const unknown=safeClosureAmount(snapshot.unknownPaymentMethodTotal);
      const methods=Math.round((cash+transfers+cards+qr+other+unknown)*100)/100;
      return {gross,methods,unknown,valid:Math.abs(gross-methods)<=.01&&unknown===0,unknownPaymentMethod:unknown>0,emptyWithBilling:gross>0&&methods===0};
    }

    function weeklySnapshotHasFinancialActivity(snapshot = {}) {
      const source = snapshot?.snapshot || snapshot || {};
      const numericFields = [
        "grossBilling","totalBilling","facturacionTotal","totalFacturado",
        "cashCollectedByDriver","efectivo","totalEfectivo",
        "transferCollectedByAdmin","transferencias","cardCollectedByAdmin","tarjetas",
        "qrCollectedByAdmin","qr","totalExpenses","expenses","gastos",
        "serviceCount","billingCount","expenseCount"
      ];
      return numericFields.some(field => Math.abs(Number(source?.[field] || 0)) > 0)
        || (Array.isArray(source?.services) && source.services.length > 0)
        || (Array.isArray(source?.currentServices) && source.currentServices.length > 0)
        || (Array.isArray(source?.expenseRows) && source.expenseRows.length > 0);
    }

    async function refreshCurrentWeeklyClosureInBackground(statusData, uid, periodId) {
      if (!window.ExploraCanonicalWeeklyClosure?.buildCanonicalWeeklyClosureSnapshot) return;
      try {
        const rebuilt = await profileWithTimeout(
          window.ExploraCanonicalWeeklyClosure.buildCanonicalWeeklyClosureSnapshot(uid,periodId,{reason:"weekly-live-background-refresh"}),
          30000,
          "WEEKLY_SUMMARY_BACKGROUND_TIMEOUT"
        );
        if (!rebuilt || weeklyClosureViewState.active !== "current" || $("weeklyClosureOverlay")?.hidden) return;
        const paymentState = weeklyPaymentMethodsState(rebuilt);
        if (!paymentState.valid) return;
        const current = statusData.weeklySnapshot || {};
        if (weeklySnapshotRegression(rebuilt,current)) return;
        statusData.weeklySnapshot = rebuilt;
        const requestId = ++weeklyClosureLiveRequestId;
        await populateWeeklyClosureDetail(statusData,{requestId,persistClosureState:false});
      } catch (error) {
        console.warn("[EXPLORA cierre] actualización en segundo plano",error?.code||error?.message||error);
      }
    }

    async function loadWeeklyClosureSummarySnapshot(statusData, options = {}) {
      const uid = String(auth.currentUser?.uid || closureState.uid || "").trim();
      const periodId = String(statusData.weeklyPeriodId || closureState.weeklyPeriodId || getActiveWeeklyPeriod().id).trim();
      const periodState = weeklyClosurePeriodState(periodId,statusData);
      const existing = statusData.weeklySnapshot;
      try {
        if (!uid) throw Object.assign(new Error("No se pudo identificar al chofer."), { code:"AUTH_USER_MISSING" });
        if (!periodState.isClosed && existing && String(existing.weeklyPeriodId || existing.periodId || periodId).slice(0,10) === periodId.slice(0,10) && weeklyPaymentMethodsState(existing).valid && weeklySnapshotHasFinancialActivity(existing)) {
          refreshCurrentWeeklyClosureInBackground(statusData,uid,periodId);
          return existing;
        }
        const currentSnapshot = window.ExploraWeeklyEngine?.getSnapshot?.();
        if (!periodState.isClosed && currentSnapshot && String(currentSnapshot.weeklyPeriodId || currentSnapshot.periodId || "").slice(0,10) === periodId.slice(0,10) && weeklyPaymentMethodsState(currentSnapshot).valid && weeklySnapshotHasFinancialActivity(currentSnapshot)) {
          statusData.weeklySnapshot = currentSnapshot;
          refreshCurrentWeeklyClosureInBackground(statusData,uid,periodId);
          return currentSnapshot;
        }
        if (window.ExploraCanonicalWeeklyClosure?.buildCanonicalWeeklyClosureSnapshot) {
          try {
            return await profileWithTimeout(window.ExploraCanonicalWeeklyClosure.buildCanonicalWeeklyClosureSnapshot(uid,periodId,{reason:periodState.isClosed?"weekly-closure-modal":"weekly-live-payment-rebuild"}),30000,"WEEKLY_SUMMARY_TIMEOUT");
          } catch (canonicalError) {
            if (periodState.isClosed) throw canonicalError;
          }
        }
        const loader = window.ExploraWeeklyEngine?.getDriverWeeklyFinancialSnapshot || window.ExploraWeeklyEngine?.getDriverWeeklySnapshot;
        if (typeof loader !== "function") throw Object.assign(new Error("El motor de cierre semanal no está disponible."), { code:"WEEKLY_ENGINE_UNAVAILABLE" });
        const snapshot = await profileWithTimeout(loader(uid, periodId, { force:options.force !== false, allowLegacyScan:true, strictSources:true, reason:"weekly-closure-live-summary", refreshInBackground:false }), 20000, "WEEKLY_SUMMARY_TIMEOUT");
        if (!snapshot) throw Object.assign(new Error("El cierre semanal no devolvió datos."), { code:"WEEKLY_SNAPSHOT_EMPTY" });
        const paymentState=weeklyPaymentMethodsState(snapshot);
        if(!paymentState.valid)throw Object.assign(new Error(paymentState.unknownPaymentMethod?"Hay cobros con medio de pago desconocido. Revisar antes de cerrar.":"La suma de efectivo, transferencias, tarjetas y QR no coincide con la facturación."),{code:"WEEKLY_PAYMENT_METHOD_MISMATCH",paymentState});
        return snapshot;
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic("NORMALIZE_WEEKLY_CLOSURE_DATA", error?.code || "WEEKLY_CLOSURE_MISSING_REQUIRED_DATA", error, { functionName:"loadWeeklyClosureSummarySnapshot", driverUid:uid, weeklyPeriodId:periodId, snapshot:existing, firestorePath:"acumulados_semanales", query:"canonical Firestore rebuild for closed period" });
        if (periodState.isClosed) { window.ExploraCanonicalWeeklyClosure?.showDiagnostic?.(error,{stage:"LOAD_CLOSED_SUMMARY",driverUid:uid,periodId,firestorePath:"acumulados_semanales"}); throw error; }
        if (existing && String(existing.weeklyPeriodId || periodId) === periodId && weeklyPaymentMethodsState(existing).valid) return existing;
        const current = window.ExploraWeeklyEngine?.getSnapshot?.();
        if (current && String(current.weeklyPeriodId || "") === periodId && weeklyPaymentMethodsState(current).valid) return current;
        throw error;
      }
    }

    async function loadPersonalRecordBonusesForPeriod(driverAliases = [], weeklyPeriodId = "") {
      const aliases = new Set((Array.isArray(driverAliases) ? driverAliases : [driverAliases]).map(value=>String(value||"").trim()).filter(Boolean));
      const periodId = String(weeklyPeriodId || "").trim();
      if (!aliases.size || !periodId) return [];
      try {
        const snapshot = await getDocs(query(collection(db,"personalRecordEvents"),where("weeklyPeriodId","==",periodId)));
        const unique = new Map();
        snapshot.docs.forEach(item=>{
          const row={id:item.id,...(item.data()||{})};
          const rowAliases=[row.driverKey,row.driverUid,row.driverId,...(Array.isArray(row.driverAliases)?row.driverAliases:[])].map(value=>String(value||"").trim()).filter(Boolean);
          if(String(row.status||"confirmed").toLowerCase()==="void"||safeClosureAmount(row.bonusAmount)<=0||!rowAliases.some(value=>aliases.has(value)))return;
          unique.set(row.id,row);
        });
        return [...unique.values()];
      } catch (error) {
        console.warn("[EXPLORA cierre] bonos de récord personal no disponibles",error?.code||error?.message||error);
        return [];
      }
    }

    async function populateWeeklyClosureDetail(statusData, options = {}) {
      const requestId = options.requestId || ++weeklyClosureLiveRequestId;
      try {
        const periodId = String(statusData.weeklyPeriodId || statusData.weeklySnapshot?.weeklyPeriodId || getActiveWeeklyPeriod().id);
        const periodState = weeklyClosurePeriodState(periodId,statusData);
        const weeklyScope = await getWeeklyScopeForPeriod(periodId);
        if (requestId !== weeklyClosureLiveRequestId && !options.allowStale) return null;
        statusData.weeklyScope = weeklyScope;
        const snapshotUid=String(statusData.weeklySnapshot?.driverUid || statusData.weeklySnapshot?.uid || statusData.driverUid || auth.currentUser?.uid || "").trim();
        const storedDailyWinners=safeClosureArray(statusData.weeklySnapshot?.dailyRankingWeeklyWinners);
        const storedDailyBonuses=safeClosureArray(statusData.weeklySnapshot?.dailyRankingBonuses);
        if(window.ExploraCanonicalWeeklyClosure?.loadDailyRankingBonusesForPeriod && (!periodState.isClosed || (!storedDailyWinners.length && !storedDailyBonuses.length))){
          const dailyWeeklyWinners=await window.ExploraCanonicalWeeklyClosure.loadDailyRankingBonusesForPeriod(periodId,{finalize:true,required:false});
          const dailyBonuses=dailyWeeklyWinners.filter(row=>String(row?.winnerDriverId||"").trim()===snapshotUid);
          statusData.weeklySnapshot={...(statusData.weeklySnapshot||{}),dailyRankingWeeklyWinners:dailyWeeklyWinners,dailyRankingBonuses:dailyBonuses,dailyRankingBonusAmount:dailyBonuses.reduce((sum,row)=>sum+safeClosureAmount(row?.bonusAmount),0)};
        }
        const storedPersonalRecordBonuses=safeClosureArray(statusData.weeklySnapshot?.personalRecordBonuses);
        if(!periodState.isClosed || !storedPersonalRecordBonuses.length){
          const personalRecordAliases=[snapshotUid,auth.currentUser?.uid,exploraSession.driverId,exploraSession.profileDocumentId,statusData.driverUid,statusData.driverId,statusData.weeklySnapshot?.driverId].filter(Boolean);
          const personalRecordBonuses=await loadPersonalRecordBonusesForPeriod(personalRecordAliases,periodId);
          statusData.weeklySnapshot={...(statusData.weeklySnapshot||{}),personalRecordBonuses,personalRecordBonusAmount:personalRecordBonuses.reduce((sum,row)=>sum+safeClosureAmount(row?.bonusAmount),0)};
        }
        const loadedExpenseRows = await loadWeeklyClosureExpenseRowsForRender(statusData, periodId, snapshotUid || auth.currentUser?.uid || "");
        if (loadedExpenseRows.length) {
          statusData.weeklySnapshot = applyWeeklyClosureExpenseRowsToSnapshot(statusData.weeklySnapshot || {}, loadedExpenseRows);
        }
        let summary = buildLiveWeeklyFinancialSummary(statusData.weeklySnapshot || {}, {uid:snapshotUid||auth.currentUser?.uid,role:exploraSession.role}, periodState, statusData);
        if (loadedExpenseRows.length) {
          summary = {
            ...summary,
            expenseRows:loadedExpenseRows,
            gastosRows:loadedExpenseRows,
            snapshot:applyWeeklyClosureExpenseRowsToSnapshot(summary.snapshot || statusData.weeklySnapshot || {}, loadedExpenseRows)
          };
        }
        statusData.weeklySnapshot = summary.snapshot; statusData.amount = summary.amount; statusData.payer = summary.payer;
        statusData.driverName = summary.driverName; statusData.normalizedSummary = summary;
        if(options.persistClosureState !== false){ closureState.statusData = statusData; closureState.amount = summary.amount; }
        const expenseRowsSignature = weeklyClosureExpenseRowsSignature(summary.expenseRows || summary.snapshot?.expenseRows || []);
        const signature=[summary.uid,summary.periodId,summary.isPeriodClosed,summary.grossBilling,summary.expenses,summary.driverExpenseCredit,summary.cash,summary.transfers,summary.cards,summary.qr,summary.currentDriverPercent,summary.derivationBonus,summary.repairFundAmount,summary.totalDiscounts,summary.dailyBonusTotal,summary.personalRecordBonusTotal,summary.balanceBeforeDailyBonuses,summary.amount,summary.payer,summary.balanced,expenseRowsSignature].join("|");
        if(signature!==weeklyClosureLiveSignature){weeklyClosureLiveSignature=signature;renderWeeklyClosureModal(statusData,summary);}
        const content=$("weeklyClosureContent"); if(content)content.dataset.liveLoading="false";
        if (summary.isPeriodClosed && summary.balanced) ensureBalancedClosureConfirmed(statusData, summary).catch(error=>{ if (isAdminRole(exploraSession.profile?.role || exploraSession.role || "")) showWeeklyClosureSummaryDiagnostic("SYNC_BALANCED_CLOSURE", "BALANCED_CLOSURE_CONFIRM_FAILED", error, { functionName:"ensureBalancedClosureConfirmed", weeklyPeriodId:summary.periodId, snapshot:summary.snapshot }); });
        return summary;
      } catch (error) {
        showWeeklyClosureSummaryDiagnostic("RENDER_WEEKLY_CLOSURE_MODAL", error?.code || "WEEKLY_CLOSURE_RENDER_BROKEN", error, { functionName:"populateWeeklyClosureDetail", weeklyPeriodId:statusData?.weeklyPeriodId, snapshot:statusData?.weeklySnapshot });
        throw error;
      }
    }

    window.normalizeWeeklyClosureData = normalizeWeeklyClosureData;
    window.calculateDriverPercent = calculateDriverPercent;
    window.calculateDriverShare = calculateDriverShare;
    window.calculateWeeklyDiscounts = calculateWeeklyDiscounts;
    window.calculateFinalBalance = calculateFinalBalance;
    window.normalizeWeeklySummaryForRender = normalizeWeeklySummaryForRender;
    window.renderClosureSection = renderClosureSection;
    window.renderWeeklySummary = renderWeeklySummary;
    window.renderClosureReceiptBlock = renderClosureReceiptBlock;
    window.renderWeeklyClosureModal = renderWeeklyClosureModal;

    function updateWeeklyClosureViewControls(view = "current", busy = false) {
      const currentBtn=$("weeklyClosureCurrentViewBtn"), previousBtn=$("weeklyClosurePreviousViewBtn"), content=$("weeklyClosureContent"), subtitle=$("weeklyClosureSubtitle");
      const isCurrent=view!=="previous";
      [currentBtn,previousBtn].forEach(btn=>{if(btn)btn.disabled=Boolean(busy);});
      if(currentBtn){currentBtn.classList.toggle("is-active",isCurrent);currentBtn.setAttribute("aria-selected",isCurrent?"true":"false");}
      if(previousBtn){previousBtn.classList.toggle("is-active",!isCurrent);previousBtn.setAttribute("aria-selected",isCurrent?"false":"true");}
      if(content)content.dataset.closureView=isCurrent?"current":"previous";
      if(subtitle)subtitle.textContent=isCurrent?"Resumen provisional actualizado en tiempo real.":"Último cierre definitivo guardado.";
    }

    function scrollWeeklyClosureViewToTop() {
      const content=$("weeklyClosureContent");
      if(!content)return;
      try{content.scrollTo({top:0,behavior:"auto"});}catch(_){content.scrollTop=0;}
    }

    function buildCurrentWeeklyClosureStatusData() {
      const active=getActiveWeeklyPeriod();
      const engineState=window.ExploraWeeklyEngine?.getState?.()||{};
      const directSnapshot=window.ExploraWeeklyEngine?.getSnapshot?.()||engineState.snapshot||engineState;
      const matchingSnapshot=String(directSnapshot?.weeklyPeriodId||directSnapshot?.periodId||"").slice(0,10)===String(active.id||"").slice(0,10)?directSnapshot:{};
      const profile=exploraSession.profile||{};
      const driverName=typeof getProfileName==="function"?getProfileName(profile):String(profile.nombreCompleto||profile.nombre||profile.name||"Chofer");
      return {
        status:CLOSURE_STATUS.CLOSURE_LOADING,clickable:true,closureId:null,closureCollection:"cierres_semanales",closureRecord:null,paymentId:null,paymentRecord:null,
        closure:{weeklyPeriodId:active.id,periodId:active.id},payment:{},weeklyPeriodId:active.id,payer:null,payee:null,amount:0,closedAt:null,
        receiptDeadline:null,receiptStatus:"not_required",receiptUrl:"",receiptPath:"",performanceEligibility:true,reason:"current_week_live_view",
        driverName,driverUid:auth.currentUser?.uid||closureState.uid||"",weeklySnapshot:{...matchingSnapshot,weeklyPeriodId:active.id,periodId:active.id,driverUid:matchingSnapshot?.driverUid||matchingSnapshot?.uid||auth.currentUser?.uid||closureState.uid||""},snapshotComplete:false
      };
    }

    function buildEmptyPreviousWeeklyClosureStatusData(previousPeriod = getPreviousWeeklyPeriod(getActiveWeeklyPeriod())) {
      return {
        emptyPreviousClosure:true,
        weeklyPeriodId:String(previousPeriod?.id||""),
        periodId:String(previousPeriod?.id||""),
        driverUid:String(auth.currentUser?.uid||closureState.uid||""),
        reason:"no_previous_weekly_closure",
        status:"empty"
      };
    }

    function clearPreviousWeeklyClosureEmptyState() {
      const content=$("weeklyClosureContent"), empty=$("weeklyClosurePreviousEmpty");
      if(content)delete content.dataset.previousEmpty;
      if(empty)empty.hidden=true;
    }

    function renderPreviousWeeklyClosureEmptyState(statusData = {}) {
      const content=$("weeklyClosureContent"),empty=$("weeklyClosurePreviousEmpty"),subtitle=$("weeklyClosureSubtitle");
      if(content){content.dataset.previousEmpty="true";content.dataset.liveLoading="false";}
      if(empty)empty.hidden=false;
      if(subtitle)subtitle.textContent="Todavía no hay un cierre semanal anterior guardado.";
      weeklyClosureViewState.previousStatusData=statusData;
    }

    async function loadPreviousClosureRecords(previousPeriod) {
      const expected=String(previousPeriod?.id||"").slice(0,10);
      const session=await getAuthenticatedSession({timeoutMs:3500});
      const identities=[session.uid,session.profileDocumentId,exploraSession.driverId].map(value=>String(value||"").trim()).filter(Boolean);
      const directIds=[...new Set(identities.map(identity=>`${identity}_${expected}`))];
      const canonicalClosureCollection=String(window.ExploraCanonicalWeeklyClosure?.closureCollectionName?.()||"cierres_semanales");
      const closureCollections=[...new Set([canonicalClosureCollection,"cierres_semanales"])];
      const paymentCollections=[...new Set([canonicalClosureCollection.includes("_prueba")?"pagos_semanales_prueba":"pagos_semanales","pagos_semanales"])];
      const directTasks=[];
      directIds.forEach(id=>{
        closureCollections.forEach(collectionName=>directTasks.push(readDirectDocument(collectionName,id)));
        paymentCollections.forEach(collectionName=>directTasks.push(readDirectDocument(collectionName,id)));
      });
      const direct=await profileWithTimeout(Promise.allSettled(directTasks),4500,"WEEKLY_PREVIOUS_DIRECT_LOOKUP_TIMEOUT");
      const directIdSet=new Set(directIds);
      const records=direct.filter(result=>result.status==="fulfilled"&&result.value).map(result=>result.value)
        .filter(record=>String(closurePeriodId(record.data)||expected).slice(0,10)===expected&&(directIdSet.has(String(record.id||""))||closureBelongsToSession(record.data,session)));
      let closureRecord=records.find(record=>String(record.collection||"").startsWith("cierres_semanales"))||null;
      let paymentRecord=records.find(record=>String(record.collection||"").startsWith("pagos_semanales"))||null;
      if(closureRecord||paymentRecord)return{session,closureRecord,paymentRecord};

      const queryTasks=[];
      [...closureCollections,...paymentCollections].forEach(collectionName=>{
        ["weeklyPeriodId","periodoSemanalId","periodId"].forEach(field=>{
          queryTasks.push((async()=>{
            const snap=await getDocs(query(collection(db,collectionName),where(field,"==",expected),limit(12)));
            return Array.from(snap.docs).map(item=>({id:item.id,collection:collectionName,data:item.data()||{}}));
          })());
        });
      });
      const queried=await profileWithTimeout(Promise.allSettled(queryTasks),5000,"WEEKLY_PREVIOUS_QUERY_TIMEOUT");
      const successfulQueryCount=queried.filter(result=>result.status==="fulfilled").length;
      if(!successfulQueryCount&&queried.length){
        const cause=queried.find(result=>result.status==="rejected")?.reason||new Error("WEEKLY_PREVIOUS_QUERY_FAILED");
        throw Object.assign(new Error(cause?.message||"No se pudo consultar el cierre anterior."),{code:cause?.code||"WEEKLY_PREVIOUS_QUERY_FAILED",cause});
      }
      const merged=new Map();
      queried.forEach(result=>{
        if(result.status!=="fulfilled")return;
        result.value.forEach(record=>{
          if(closureBelongsToSession(record.data,session)&&String(closurePeriodId(record.data)||"").slice(0,10)===expected)merged.set(`${record.collection}/${record.id}`,record);
        });
      });
      const rows=[...merged.values()];
      closureRecord=rows.filter(record=>String(record.collection||"").startsWith("cierres_semanales")).sort((a,b)=>closureRecordTime(b.data)-closureRecordTime(a.data))[0]||null;
      paymentRecord=rows.filter(record=>String(record.collection||"").startsWith("pagos_semanales")).sort((a,b)=>closureRecordTime(b.data)-closureRecordTime(a.data))[0]||null;
      return{session,closureRecord,paymentRecord};
    }

    function previousStatusFromStoredRecords(records = {}, previousPeriod = {}) {
      const closureRecord=records.closureRecord||null,paymentRecord=records.paymentRecord||null;
      if(!closureRecord&&!paymentRecord)return buildEmptyPreviousWeeklyClosureStatusData(previousPeriod);
      const closure=closureRecord?.data||{};
      const payment={...(closure.pagoSemanal||{}),...(paymentRecord?.data||{})};
      const storedSnapshot=closure.weeklySnapshot||payment.weeklySnapshot||closure.financialSnapshot||payment.financialSnapshot||closure.snapshot||payment.snapshot||{};
      const snapshot={...closure,...payment,...storedSnapshot};
      const direction=closureDirection(closure,payment);
      const storedAmount=Math.max(0,Number(closureAmount(closure,payment,direction)||0));
      const signedCandidate=[
        snapshot.netSettlementToDriver,snapshot.finalBalance,snapshot.saldoFinal,snapshot.settlementBalance,snapshot.netBalance,
        closure.netSettlementToDriver,closure.finalBalance,closure.saldoFinal,payment.netSettlementToDriver,payment.finalBalance
      ].map(value=>Number(value)).find(value=>Number.isFinite(value));
      const signed=Number.isFinite(signedCandidate)?Math.round(signedCandidate):direction==="chofer_a_david"?-storedAmount:direction==="david_a_chofer"?storedAmount:0;
      const amount=Math.abs(signed);
      const payer=signed<0?"driver":signed>0?"admin":null;
      const receiptUrl=closureReceiptUrl(closure,payment);
      return{
        status:String(closure.status||closure.closureStatus||payment.status||payment.paymentStatus||CLOSURE_STATUS.BALANCED_CLOSURE),
        clickable:true,
        closureId:closureRecord?.id||paymentRecord?.id||null,
        closureCollection:closureRecord?.collection||"cierres_semanales",
        closureRecord,paymentId:paymentRecord?.id||null,paymentRecord,
        closure:{...closure,netSettlementToDriver:signed,weeklyPeriodId:previousPeriod.id,periodId:previousPeriod.id},payment,
        weeklyPeriodId:previousPeriod.id,payer,payee:payer==="driver"?"admin":payer==="admin"?"driver":null,amount,
        closedAt:closure.closedAt||payment.closedAt||null,receiptDeadline:payment.receiptDeadline||closure.receiptDeadline||null,
        receiptStatus:receiptUrl?"uploaded":"missing",receiptUrl,receiptPath:closureReceiptPath(closure,payment),
        performanceEligibility:true,reason:"stored_previous_closure",weeklySnapshot:{...snapshot,netSettlementToDriver:signed,weeklyPeriodId:previousPeriod.id,periodId:previousPeriod.id},
        snapshotComplete:closure.snapshotComplete===true||snapshot.snapshotComplete===true||snapshot.snapshotValidated===true,normalizedBalance:signed
      };
    }

    async function loadPreviousWeeklyClosureStatusData({force=false}={}) {
      const active=getActiveWeeklyPeriod(),previous=getPreviousWeeklyPeriod(active);
      const cached=weeklyClosureViewState.previousStatusData;
      if(!force&&cached&&String(cached.weeklyPeriodId||"").slice(0,10)===String(previous.id||"").slice(0,10)&&weeklySnapshotHasFinancialActivity(cached.weeklySnapshot||cached.closure||{}))return cached;
      const uid=String(auth.currentUser?.uid||closureState.uid||"").trim();
      if(!uid)throw Object.assign(new Error("No se pudo identificar al chofer para cargar el cierre anterior."),{code:"AUTH_USER_MISSING"});
      try{
        const [recordsResult,canonicalResult]=await Promise.allSettled([
          loadPreviousClosureRecords(previous),
          window.ExploraCanonicalWeeklyClosure?.buildCanonicalWeeklyClosureSnapshot
            ? profileWithTimeout(window.ExploraCanonicalWeeklyClosure.buildCanonicalWeeklyClosureSnapshot(uid,previous.id,{reason:"weekly-previous-authoritative-rebuild",closedAt:previous.end?.toISOString?.()||null}),30000,"WEEKLY_PREVIOUS_REBUILD_TIMEOUT")
            : Promise.resolve(null)
        ]);
        if(recordsResult.status==="rejected"&&canonicalResult.status==="rejected")throw recordsResult.reason||canonicalResult.reason;
        const stored=recordsResult.status==="fulfilled"?previousStatusFromStoredRecords(recordsResult.value,previous):buildEmptyPreviousWeeklyClosureStatusData(previous);
        const canonical=canonicalResult.status==="fulfilled"?canonicalResult.value:null;
        const canonicalValid=canonical&&weeklyPaymentMethodsState(canonical).valid&&(weeklySnapshotHasFinancialActivity(canonical)||canonical.snapshotComplete===true);
        let result=stored;
        if(canonicalValid){
          const signed=Number(canonical.netSettlementToDriver);
          if(!Number.isFinite(signed))throw Object.assign(new Error("El cierre anterior reconstruido no contiene un saldo final válido."),{code:"WEEKLY_PREVIOUS_SIGNED_BALANCE_MISSING"});
          const amount=Math.abs(Math.round(signed));
          const payer=signed<0?"driver":signed>0?"admin":null;
          result={...stored,emptyPreviousClosure:false,clickable:true,weeklyPeriodId:previous.id,periodId:previous.id,driverUid:uid,
            closure:{...(stored.closure||{}),...canonical,weeklyPeriodId:previous.id,periodId:previous.id,netSettlementToDriver:Math.round(signed)},
            weeklySnapshot:{...canonical,weeklyPeriodId:previous.id,periodId:previous.id,driverUid:canonical.driverUid||canonical.uid||uid,netSettlementToDriver:Math.round(signed)},
            payer,payee:payer==="driver"?"admin":payer==="admin"?"driver":null,amount,normalizedBalance:Math.round(signed),
            status:signed<0?CLOSURE_STATUS.DRIVER_MUST_PAY_PENDING:signed>0?CLOSURE_STATUS.DAVID_MUST_PAY_PENDING:CLOSURE_STATUS.BALANCED_CLOSURE,
            reason:"previous_week_authoritative_rebuild",snapshotComplete:true};
        }
        weeklyClosureViewState.previousStatusData=result;
        return result;
      }catch(error){
        if(["WEEKLY_PREVIOUS_DIRECT_LOOKUP_TIMEOUT","WEEKLY_PREVIOUS_QUERY_TIMEOUT"].includes(String(error?.message||error?.code||""))){
          const timeout=Object.assign(new Error("La consulta del cierre anterior tardó demasiado y fue detenida."),{code:"WEEKLY_PREVIOUS_LOOKUP_TIMEOUT",cause:error});
          showWeeklyClosureSummaryDiagnostic("LOAD_PREVIOUS_CLOSURE_VIEW","WEEKLY_PREVIOUS_LOOKUP_TIMEOUT",timeout,{functionName:"loadPreviousWeeklyClosureStatusData",weeklyPeriodId:previous.id,firestorePath:"cierres_semanales + pagos_semanales",query:"direct previous closure lookup"});
          throw timeout;
        }
        throw error;
      }
    }

    function bindCurrentWeeklyClosureRealtime(statusData) {
      stopWeeklyClosureLiveBinding();
      const cleanups=[];
      let renderTimer=0;
      let refreshTimer=0;
      const consumeLiveSnapshot=(candidate,reason="realtime")=>{
        if($("weeklyClosureOverlay")?.hidden||weeklyClosureViewState.active!=="current")return;
        const next=candidate?.snapshot||candidate;
        if(!next||String(next.weeklyPeriodId||next.periodoSemanalId||next.periodId||"").slice(0,10)!==String(statusData.weeklyPeriodId||"").slice(0,10))return;
        const expectedUid=String(auth.currentUser?.uid||closureState.uid||"").trim();
        const receivedUid=String(next.driverUid||next.uid||next.choferUid||expectedUid).trim();
        if(expectedUid&&receivedUid&&expectedUid!==receivedUid)return;
        const paymentState=weeklyPaymentMethodsState(next);
        if(!paymentState.valid){reportIgnoredWeeklyRegression("payment-method-mismatch",next,statusData.weeklySnapshot||{},reason);return;}
        const regression=weeklySnapshotRegression(next,statusData.weeklySnapshot||{});
        if(regression){reportIgnoredWeeklyRegression(regression,next,statusData.weeklySnapshot||{},reason);return;}
        clearTimeout(renderTimer);
        renderTimer=setTimeout(async()=>{
          if(weeklyClosureViewState.active!=="current")return;
          const liveRequest=++weeklyClosureLiveRequestId;
          statusData.weeklySnapshot={...(statusData.weeklySnapshot||{}),...next,realtimeReason:reason,realtimeReceivedAt:new Date().toISOString()};
          try{await populateWeeklyClosureDetail(statusData,{requestId:liveRequest,persistClosureState:false});}
          catch(error){showWeeklyClosureSummaryDiagnostic("REALTIME_WEEKLY_CLOSURE","WEEKLY_CLOSURE_REALTIME_RENDER_FAILED",error,{functionName:"consumeLiveSnapshot",weeklyPeriodId:statusData.weeklyPeriodId,snapshot:statusData.weeklySnapshot});}
        },45);
      };
      if(window.ExploraWeeklyEngine?.subscribe){cleanups.push(window.ExploraWeeklyEngine.subscribe(state=>consumeLiveSnapshot(state?.snapshot||window.ExploraWeeklyEngine.getSnapshot?.(),"weekly-engine")));}
      ["explora:unified-weekly-snapshot","explora:weekly-summary","explora:operational-snapshot-updated"].forEach(name=>{
        const handler=event=>consumeLiveSnapshot(event?.detail||null,name);window.addEventListener(name,handler);cleanups.push(()=>window.removeEventListener(name,handler));
      });
      const liveUid=String(auth.currentUser?.uid||closureState.uid||"").trim();
      const livePeriodId=String(statusData.weeklyPeriodId||"").slice(0,10);
      if(liveUid&&livePeriodId){
        const activePeriod=getActiveWeeklyPeriod();
        const livePeriod=String(activePeriod.id||"").slice(0,10)===livePeriodId?activePeriod:getWeeklyPeriodFromDate(new Date(`${livePeriodId}T12:00:00-03:00`));
        const aggregateRef=doc(db,WEEKLY_SNAPSHOT_COLLECTION,materializedSnapshotId(liveUid,livePeriodId));
        const unsubscribeAggregate=onSnapshot(aggregateRef,snap=>{
          if(!snap.exists()||weeklyClosureViewState.active!=="current")return;
          try{
            const liveSnapshot=snapshotFromMaterialized(snap.data()||{},liveUid,livePeriod,weeklyState.performanceResult||null);
            const source=Number(liveSnapshot.totalExpenses||0)!==Number(statusData.weeklySnapshot?.totalExpenses||0)?"expense":"firestore-aggregate";
            const liveState=$("weeklyClosureLiveState");if(liveState)liveState.dataset.realtimeSource=source;
            consumeLiveSnapshot(liveSnapshot,source);
          }catch(error){
            showWeeklyClosureSummaryDiagnostic("REALTIME_WEEKLY_CLOSURE","WEEKLY_CLOSURE_AGGREGATE_RENDER_FAILED",error,{functionName:"weeklyAggregateSnapshot",weeklyPeriodId:livePeriodId,firestorePath:`${WEEKLY_SNAPSHOT_COLLECTION}/${materializedSnapshotId(liveUid,livePeriodId)}`});
          }
        },error=>{
          showWeeklyClosureSummaryDiagnostic("REALTIME_WEEKLY_CLOSURE",error?.code||"WEEKLY_CLOSURE_AGGREGATE_LISTENER_FAILED",error,{functionName:"bindCurrentWeeklyClosureRealtime",weeklyPeriodId:livePeriodId,firestorePath:`${WEEKLY_SNAPSHOT_COLLECTION}/${materializedSnapshotId(liveUid,livePeriodId)}`});
        });
        cleanups.push(unsubscribeAggregate);

        let expenseSyncTimer=0;
        const expenseRequests=weeklyScopedQueryRequests("gastos",liveUid);
        const expenseBuckets=new Map();
        const expenseInitialPending=new Set(expenseRequests.map((_,index)=>index));
        let expenseSuccessfulQueries=0;
        let expenseInitialSettled=false;
        const syncMergedExpenseBuckets=(reason="expense-source-listener")=>{
          if(weeklyClosureViewState.active!=="current")return;
          if(!expenseInitialSettled&&expenseInitialPending.size)return;
          const merged=new Map();
          expenseBuckets.forEach(bucket=>bucket.forEach((row,id)=>merged.set(id,row)));
          const rows=[...merged.values()].filter(row=>docBelongsToPeriod(row,livePeriod)&&isValidWeeklyExpense(row));
          clearTimeout(expenseSyncTimer);
          expenseSyncTimer=setTimeout(()=>{
            try{
              const synced=window.ExploraWeeklyEngine?.syncExpenses?.(rows,liveUid,livePeriodId);
              if(synced)consumeLiveSnapshot(synced,reason);
            }catch(error){
              showWeeklyClosureSummaryDiagnostic("REALTIME_WEEKLY_EXPENSES","WEEKLY_EXPENSE_SOURCE_SYNC_FAILED",error,{functionName:"syncExpenses",weeklyPeriodId:livePeriodId,firestorePath:"gastos",query:"merged driverUid/choferUid/uid/ownerUid/driverId/choferId listeners"});
            }
          },25);
        };
        expenseRequests.forEach(({field,value},index)=>{
          const expenseQuery=query(collection(db,"gastos"),where(field,"==",value));
          const unsubscribeExpenseSource=onSnapshot(expenseQuery,snap=>{
            const bucket=new Map();
            snap.forEach(item=>{const raw=item.data()||{};const row={...raw,id:raw.id||item.id,documentId:item.id};bucket.set(item.id,row);});
            expenseBuckets.set(index,bucket);
            expenseSuccessfulQueries+=expenseInitialPending.has(index)?1:0;
            expenseInitialPending.delete(index);
            if(!expenseInitialPending.size)expenseInitialSettled=true;
            syncMergedExpenseBuckets("expense-source-listener");
          },error=>{
            expenseInitialPending.delete(index);
            if(!expenseInitialPending.size){
              expenseInitialSettled=true;
              if(!expenseSuccessfulQueries){
                showWeeklyClosureSummaryDiagnostic("REALTIME_WEEKLY_EXPENSES",error?.code||"WEEKLY_EXPENSE_LISTENER_FAILED",error,{functionName:"bindCurrentWeeklyClosureRealtime",weeklyPeriodId:livePeriodId,firestorePath:"gastos",query:"all expense identity listeners failed"});
              }
              syncMergedExpenseBuckets("expense-source-listener-partial");
            }
          });
          cleanups.push(unsubscribeExpenseSource);
        });
        cleanups.push(()=>{clearTimeout(expenseSyncTimer);expenseBuckets.clear();expenseInitialPending.clear();});
      }
      const forceRefresh=(event)=>{
        if($("weeklyClosureOverlay")?.hidden||weeklyClosureViewState.active!=="current")return;
        const eventName=String(event?.type||"mutation");
        if(eventName==="explora:gasto-registrado"&&event?.detail){
          Promise.resolve(window.ExploraWeeklyEngine?.applyExpense?.(event.detail)).then(snapshot=>{if(snapshot)consumeLiveSnapshot(snapshot,"expense-event");}).catch(error=>{
            showWeeklyClosureSummaryDiagnostic("REALTIME_WEEKLY_EXPENSES",error?.code||"WEEKLY_EXPENSE_EVENT_APPLY_FAILED",error,{functionName:"forceRefresh",weeklyPeriodId:statusData.weeklyPeriodId,firestorePath:"gastos + acumulados_semanales",query:eventName});
          });
        }
        const immediate=window.ExploraWeeklyEngine?.getSnapshot?.();
        if(immediate)consumeLiveSnapshot(immediate,`${eventName}-local`);
        clearTimeout(refreshTimer);
        refreshTimer=setTimeout(()=>{
          window.ExploraFirestoreGlobalSync?.refresh?.({reason:eventName});
          window.ExploraWeeklyEngine?.refresh?.({force:true,reason:eventName}).then(snapshot=>consumeLiveSnapshot(snapshot,`${eventName}-refresh`)).catch(error=>{
            showWeeklyClosureSummaryDiagnostic("REALTIME_WEEKLY_CLOSURE","WEEKLY_CLOSURE_REALTIME_REFRESH_FAILED",error,{functionName:"forceRefresh",weeklyPeriodId:statusData.weeklyPeriodId,snapshot:statusData.weeklySnapshot,query:eventName});
          });
        },20);
      };
      ["explora:cobro-registrado","explora:derivacion-facturada","explora:gasto-registrado","explora:loan-payment"].forEach(name=>{
        window.addEventListener(name,forceRefresh);cleanups.push(()=>window.removeEventListener(name,forceRefresh));
      });
      weeklyClosureLiveUnsubscribe=()=>{clearTimeout(renderTimer);clearTimeout(refreshTimer);cleanups.splice(0).forEach(cleanup=>{try{cleanup?.();}catch(_){}});};
    }

    async function showWeeklyClosureView(view="current",{force=true}={}) {
      const overlay=$("weeklyClosureOverlay");if(!overlay||overlay.hidden)return null;
      const target=view==="previous"?"previous":"current";
      const previousView=weeklyClosureViewState.active;
      const viewRequestId=++weeklyClosureViewRequestId;
      stopWeeklyClosureLiveBinding();
      weeklyClosureViewState.active=target;
      weeklyClosureViewState.switching=true;
      updateWeeklyClosureViewControls(target,true);
      resetWeeklyDriverReceiptSelection({clearInput:true,clearMessage:true});clearWeeklyClosureReceiptError();
      const renderRequestId=++weeklyClosureLiveRequestId;
      const loading=$("weeklyClosureLoading"),content=$("weeklyClosureContent");
      clearPreviousWeeklyClosureEmptyState();
      if(loading){loading.hidden=false;loading.textContent=target==="current"?"Actualizando la semana en curso…":"Buscando el último cierre definitivo…";}
      if(content)content.dataset.liveLoading="true";
      try{
        let statusData;
        if(target==="current"){
          statusData=buildCurrentWeeklyClosureStatusData();
          const initial=statusData.weeklySnapshot||{};
          const snapshot=await loadWeeklyClosureSummarySnapshot(statusData,{force});
          if(viewRequestId!==weeklyClosureViewRequestId||weeklyClosureViewState.active!==target)return null;
          statusData.weeklySnapshot=(snapshot?.snapshotValidated===true&&snapshot?.schemaVersion===window.ExploraCanonicalWeeklyClosure?.schemaVersion)?snapshot:(window.normalizeDriverWeeklyFinancialSnapshot?.(snapshot||initial,{driverUid:auth.currentUser?.uid,weeklyPeriodId:statusData.weeklyPeriodId,source:"weekly-closure-current-view",cacheHit:false})||snapshot||initial);
          weeklyClosureViewState.currentStatusData=statusData;
        }else{
          statusData=await loadPreviousWeeklyClosureStatusData({force});
          if(viewRequestId!==weeklyClosureViewRequestId||weeklyClosureViewState.active!==target)return null;
          if(statusData?.emptyPreviousClosure===true){
            renderPreviousWeeklyClosureEmptyState(statusData);
            scrollWeeklyClosureViewToTop();
            return statusData;
          }
          const stored=statusData.weeklySnapshot||statusData.closure?.weeklySnapshot||statusData.closure||{};
          statusData={...statusData,weeklySnapshot:stored};
          applyClosureState(statusData);
          weeklyClosureViewState.previousStatusData=statusData;
        }
        weeklyClosureLiveSignature="";
        const summary=await populateWeeklyClosureDetail(statusData,{requestId:renderRequestId,allowStale:true,persistClosureState:target==="previous"});
        if(viewRequestId!==weeklyClosureViewRequestId||weeklyClosureViewState.active!==target)return null;
        if(target==="current"){
          bindCurrentWeeklyClosureRealtime(statusData);
          // Prefetch silencioso del cierre anterior: lo carga en background
          // para que el tab "VER CIERRE ANTERIOR" responda instantaneo.
          // Solo se ejecuta si todavia no hay cache valido para esa semana.
          setTimeout(()=>{
            const prev=weeklyClosureViewState.previousStatusData;
            const prevId=getPreviousWeeklyPeriod(getActiveWeeklyPeriod()).id;
            const alreadyCached=prev&&String(prev.weeklyPeriodId||"").slice(0,10)===String(prevId||"").slice(0,10)&&weeklySnapshotHasFinancialActivity(prev.weeklySnapshot||prev.closure||{});
            if(!alreadyCached&&auth.currentUser?.uid&&!$("weeklyClosureOverlay")?.hidden)
              loadPreviousWeeklyClosureStatusData({force:false}).catch(()=>{});
          },2000);
        }
        scrollWeeklyClosureViewToTop();
        return summary;
      }catch(error){
        if(viewRequestId===weeklyClosureViewRequestId){
          weeklyClosureViewState.active=previousView;
          clearPreviousWeeklyClosureEmptyState();
          if(previousView==="current"&&weeklyClosureViewState.currentStatusData)bindCurrentWeeklyClosureRealtime(weeklyClosureViewState.currentStatusData);
          showWeeklyClosureSummaryDiagnostic(target==="current"?"LOAD_CURRENT_WEEK_VIEW":"LOAD_PREVIOUS_CLOSURE_VIEW",error?.code||"WEEKLY_CLOSURE_VIEW_LOAD_FAILED",error,{functionName:"showWeeklyClosureView",weeklyPeriodId:target==="current"?getActiveWeeklyPeriod().id:getPreviousWeeklyPeriod(getActiveWeeklyPeriod()).id,firestorePath:"cierres_semanales + pagos_semanales + acumulados_semanales",query:target});
        }
        throw error;
      }finally{
        if(viewRequestId===weeklyClosureViewRequestId){
          if(loading)loading.hidden=true;
          if(content)content.dataset.liveLoading="false";
          weeklyClosureViewState.switching=false;
          updateWeeklyClosureViewControls(weeklyClosureViewState.active,false);
        }
      }
    }

    async function openWeeklyClosureModal() {
      // Nueva versión: el cierre semanal legacy queda desactivado.
      // El único flujo vigente es el cierre a demanda de Pago Home (segmento 52).
      const legacyFlags = window.EXPLORA_LEGACY_MODULES_DISABLED || {};
      if (legacyFlags.weeklyClosure !== false) {
        closeWeeklyClosureModal();
        console.info("EXPLORA_LEGACY_WEEKLY_CLOSURE_DISABLED");
        return null;
      }
      if(!auth.currentUser?.uid)return;
      const overlay=$("weeklyClosureOverlay");if(!overlay)return;
      stopWeeklyClosureLiveBinding();
      overlay.hidden=false;overlay.setAttribute("aria-hidden","false");document.body.classList.add("weekly-closure-open");window.lockPageScroll?.("weekly-closure");
      weeklyClosureViewState.active="current";
      updateWeeklyClosureViewControls("current",false);
      try{await showWeeklyClosureView("current",{force:false});}
      catch(_){/* El diagnóstico visible ya informa el error y permite copiarlo. */}
    }

    window.ExploraWeeklyClosure = Object.freeze({
      open: openWeeklyClosureModal,
      close: closeWeeklyClosureModal,
      refresh: (options={force:true}) => refreshDriverPaymentStatus(options),
      getState: () => ({...closureState})
    });

    async function ensureWeeklyClosureDocumentForReceipt(statusData = {}, summary = {}, user = null) {
      const driverUid=String(user?.uid||auth.currentUser?.uid||closureState.uid||"").trim();
      const weeklyPeriodId=String(statusData.weeklyPeriodId||summary.periodId||closureState.weeklyPeriodId||"").trim();
      if(!driverUid||!weeklyPeriodId)throw createClosureReceiptError("SYNC_CLOSURE_RECEIPT","CLOSURE_RECEIPT_SYNC_FAILED","Faltan UID o semana para materializar el cierre semanal.");
      const canonical=window.ExploraCanonicalWeeklyClosure;
      if(!canonical?.materializeWeeklyClosure)throw createClosureReceiptError("SYNC_CLOSURE_RECEIPT","CLOSURE_RECEIPT_ENGINE_UNAVAILABLE","El motor canónico de cierre no está disponible.");
      const result=await canonical.materializeWeeklyClosure(driverUid,weeklyPeriodId,{createdByOperationId:`receipt_${driverUid}_${weeklyPeriodId}`});
      if(result?.localOnly)throw createClosureReceiptError("SYNC_CLOSURE_RECEIPT","CLOSURE_RECEIPT_OFFLINE_PENDING","El cierre quedó en cola offline. Reconectá internet antes de subir el comprobante.");
      const closureId=String(result?.closureId||`${driverUid}_${weeklyPeriodId}`);
      const collectionName=String(result?.collection||canonical.closureCollectionName?.()||"cierres_semanales");
      const data=result?.data||result?.snapshot||{};
      const record={id:closureId,collection:collectionName,data};
      statusData.closureId=closureId;
      statusData.closureCollection=collectionName;
      statusData.closureRecord=record;
      statusData.closure={...(statusData.closure||{}),...data};
      statusData.isPreview=false;
      closureState.closureId=closureId;
      closureState.closureCollection=collectionName;
      closureState.closure=statusData.closure;
      return record;
    }

    async function submitDriverWeeklyReceipt(event) {
      event?.preventDefault?.();
      if (driverClosureReceiptInProgress || closureState.saving) return;
      const statusData = closureState.statusData || {};
      const file = weeklyDriverReceiptState.file;
      const btn = $("weeklyClosureSubmitBtn");
      let uploaded = null;
      let receiptFirestoreSynced = false;
      let currentStage = "RENDER_RECEIPT_UPLOAD";
      const diagnosticContext = {
        stage:currentStage, authUid:auth.currentUser?.uid || "", driverUid:closureState.uid || auth.currentUser?.uid || "",
        weeklyPeriodId:statusData.weeklyPeriodId || closureState.weeklyPeriodId || "",
        closureId:statusData.closureId || closureState.closureId || "", file, fileName:file?.name || "", mimeType:file?.type || "", fileSize:file?.size || 0,
        path:"", firestorePath:"cierres_semanales + receipt_index", percentage:0, taskState:"idle", startedAt:Date.now(), timestamp:new Date().toISOString(),
        snapshot:statusData.weeklySnapshot, payerRole:statusData.payer, finalAmount:statusData.amount, functionName:"submitDriverWeeklyReceipt"
      };
      try {
        driverClosureReceiptInProgress = true; closureState.saving = true; weeklyDriverReceiptState.uploading = true; clearWeeklyClosureReceiptError();
        if (btn) { btn.disabled = true; btn.textContent = "VALIDANDO COMPROBANTE…"; btn.setAttribute("aria-busy","true"); }
        const user = await resolveWeeklyClosureAuthUser(6000);
        diagnosticContext.authUid = user?.uid || "";
        if (!user?.uid) throw createClosureReceiptError(currentStage,"CLOSURE_RECEIPT_PERMISSION_FAILED","No hay una sesión activa.");
        const driverUid = String(user.uid || "").trim(); diagnosticContext.driverUid = driverUid;
        const role = String(exploraSession.role || "").toLowerCase();
        if (!driverUid || !["chofer","driver"].includes(role)) throw createClosureReceiptError(currentStage,"CLOSURE_RECEIPT_PERMISSION_FAILED","Sólo el chofer del cierre puede cargar este comprobante.");
        const weeklyPeriodId = String(statusData.weeklyPeriodId || closureState.weeklyPeriodId || "").trim();
        let closureId = String(statusData.closureId || statusData.closureRecord?.id || statusData.paymentRecord?.id || closureState.closureId || "").trim();
        diagnosticContext.weeklyPeriodId = weeklyPeriodId; diagnosticContext.closureId = closureId;
        if (!weeklyPeriodId || !driverUid) throw createClosureReceiptError(currentStage,"CLOSURE_RECEIPT_SYNC_FAILED","Faltan datos obligatorios del cierre semanal.");
        if (!storage || !db) throw createClosureReceiptError(currentStage,"CLOSURE_RECEIPT_UPLOAD_FAILED","Firebase Storage o Firestore no está inicializado.");
        if (!(file instanceof File) || !(file.size > 0)) throw createClosureReceiptError(currentStage,"CLOSURE_RECEIPT_FILE_REQUIRED","Seleccioná un comprobante antes de continuar.");
        const mime = String(file.type || "").toLowerCase();
        if (!["image/jpeg","image/png","image/webp"].includes(mime)) throw createClosureReceiptError(currentStage,"CLOSURE_RECEIPT_INVALID_MIME","Formato no permitido. Usá JPG, PNG o WebP.");
        const summary = statusData.normalizedSummary || calculateFinalBalance(normalizeWeeklyClosureData(statusData, statusData.weeklyScope || {}));
        const receiptRequirement = getWeeklyClosureReceiptRequirement(summary, statusData);
        const driverMayConfirm = receiptRequirement.state === WEEKLY_CLOSURE_RECEIPT_STATE.DRIVER_RECEIPT_REQUIRED;
        if (!driverMayConfirm) throw createClosureReceiptError(currentStage,"CLOSURE_RECEIPT_NOT_REQUIRED","Este cierre no requiere un comprobante del chofer.");
        currentStage = "SYNC_CLOSURE_RECEIPT"; diagnosticContext.stage = currentStage; diagnosticContext.functionName = "ensureWeeklyClosureDocumentForReceipt";
        const existingRecord = await ensureWeeklyClosureDocumentForReceipt(statusData, summary, user);
        closureId = String(existingRecord.id || closureId).trim();
        diagnosticContext.closureId = closureId;
        diagnosticContext.firestorePath = `${existingRecord.collection || "cierres_semanales"}/${existingRecord.id}`;

        const driverName = String(statusData.driverName || getProfileName(exploraSession.profile || {}, user) || "Chofer");
        const destinationPath = `${window.ExploraCanonicalWeeklyClosure?.storageBasePath?.()||"cierres_semanales"}/${weeklyPeriodId}/${driverUid}/${closureId}/comprobante.{extension}`;
        if (/(?:undefined|null|\[object Object\])/i.test(destinationPath)) throw createClosureReceiptError(currentStage,"CLOSURE_RECEIPT_UPLOAD_FAILED","La ruta de Storage contiene valores inválidos.");
        diagnosticContext.path = destinationPath;
        currentStage = "UPLOAD_CLOSURE_RECEIPT"; diagnosticContext.stage = currentStage; diagnosticContext.functionName = "submitDriverWeeklyReceipt";
        if (btn) btn.textContent = "SUBIENDO COMPROBANTE…";
        await window.ExploraCanonicalWeeklyClosure?.markProofUploading?.(closureId);
        uploaded = await window.motorCargaComprobanteGasto({
          file, context:"weeklyClosureDriver", ownerUid:driverUid, driverUid, recordId:closureId, weeklyPeriodId, destinationPath, allowPdf:false,
          uploadedByUid:driverUid, uploadedByRole:"driver", category:"weekly_closure",
          metadata:{ type:"weekly_closure", categoryLabel:"CIERRE SEMANAL", receiptCategory:"cierre", closureId, weeklyPeriodId, driverUid, driverName, payerRole:summary.balanced?null:"driver", payeeRole:summary.balanced?null:"admin", settlementAmount:Number(summary.amount||0), balanced:Boolean(summary.balanced) },
          onStage:(stage, detail={})=>{
            if (detail.path) diagnosticContext.path = detail.path;
            if (detail.mimeType) diagnosticContext.mimeType = detail.mimeType;
            if (detail.size) diagnosticContext.fileSize = detail.size;
            if (Number.isFinite(Number(detail.percent))) diagnosticContext.percentage = Number(detail.percent);
            if (detail.taskState) diagnosticContext.taskState = String(detail.taskState);
            if (btn && (stage === "UPLOAD_PROGRESS" || stage === "UPLOAD_STATE")) btn.textContent = diagnosticContext.percentage > 0 ? `SUBIENDO ${Math.round(diagnosticContext.percentage)} %` : "SUBIENDO COMPROBANTE…";
          }
        });
        currentStage = "UPLOAD_CLOSURE_RECEIPT"; diagnosticContext.stage = currentStage;
        diagnosticContext.path = uploaded?.receiptPath || diagnosticContext.path; diagnosticContext.mimeType = uploaded?.receiptMimeType || diagnosticContext.mimeType; diagnosticContext.fileSize = uploaded?.receiptSize || diagnosticContext.fileSize; diagnosticContext.percentage = 100; diagnosticContext.taskState = "success";
        if (!uploaded?.receiptUrl || !/^https?:\/\//i.test(String(uploaded.receiptUrl))) throw createClosureReceiptError(currentStage,"CLOSURE_RECEIPT_URL_FAILED","No se obtuvo una URL válida del comprobante.");

        const resultLabel = summary.resultText || (summary.balanced ? "Cuenta equilibrada · $0" : `Debés pagarle a David ${formatClosureMoney(summary.amount||0)}`);
        const closureYear = Number(weeklyPeriodId.slice(0,4)) || new Date().getFullYear();
        const commonReceipt = {
          closureId, weeklyPeriodId, driverUid, driverName, uploadedByUid:driverUid, uploadedByRole:"driver",
          receiptUrl:uploaded.receiptUrl, receiptPath:uploaded.receiptPath, receiptMimeType:uploaded.receiptMimeType, receiptFileName:uploaded.receiptFileName, receiptSize:uploaded.receiptSize,
          receiptUploadedAt:uploaded.receiptUploadedAt, receiptStatus:"uploaded", category:"weekly_closure", categoryLabel:"CIERRE SEMANAL", receiptCategory:"cierre",
          closureWeek:weeklyPeriodId, closureYear, payerRole:summary.balanced?null:"driver", payeeRole:summary.balanced?null:"admin", settlementAmount:Number(summary.amount||0), balanced:Boolean(summary.balanced), resultLabel
        };
        currentStage = "SYNC_CLOSURE_RECEIPT"; diagnosticContext.stage = currentStage; diagnosticContext.functionName = "submitDriverWeeklyReceipt"; diagnosticContext.firestorePath = `${existingRecord.collection || "cierres_semanales"}/${existingRecord.id}`;
        if (btn) btn.textContent = "GUARDANDO CIERRE…";
        const closureUpdate = {
          ...commonReceipt,
          driverReceiptUrl:uploaded.receiptUrl, driverReceiptPath:uploaded.receiptPath, driverReceiptMimeType:uploaded.receiptMimeType, driverReceiptFileName:uploaded.receiptFileName, driverReceiptSize:uploaded.receiptSize,
          driverReceiptUploadedAt:uploaded.receiptUploadedAt, driverReceiptUploadedByUid:driverUid, driverReceiptUploadedByRole:"driver", driverReceiptStatus:"uploaded",
          estadoComprobante:"cargado", pagoConfirmado:true, driverAcknowledged:true, driverAcknowledgedAt:serverTimestamp(), driverAcknowledgedBy:driverUid, driverAcknowledgedPeriodId:weeklyPeriodId,
          acknowledgementStatus:"confirmed_by_receipt", proofUploadedAt:serverTimestamp(), isResolved:true, paid:true, pagado:true, paymentStatus:"paid", closureStatus:"paid", status:"paid", statusSchemaVersion:212, actualizadoEn:serverTimestamp(), updatedAt:serverTimestamp()
        };
        const indexPayload = window.ExploraReceiptEngine.buildReceiptIndexPayload({ category:"weekly_closure", recordId:closureId, suffix:"driver", driverUid, ownerUid:driverUid, uploadedByUid:driverUid, uploadedByRole:"driver", weeklyPeriodId, amount:Number(statusData.amount||0), receipt:uploaded, status:"uploaded" });
        Object.assign(indexPayload, commonReceipt, { receiptId:indexPayload.receiptId, createdAt:serverTimestamp(), updatedAt:serverTimestamp(), detail:`Semana ${weeklyPeriodId} · Subido por el chofer · ${resultLabel}` });
        currentStage = "SYNC_CLOSURE_RECEIPT"; diagnosticContext.stage = currentStage; diagnosticContext.firestorePath = `${existingRecord.collection || "cierres_semanales"}/${existingRecord.id} + receipt_index/${indexPayload.receiptId}`;
        if (btn) btn.textContent = "SINCRONIZANDO COMPROBANTES…";
        const batch = writeBatch(db);
        batch.set(doc(db, existingRecord.collection || "cierres_semanales", existingRecord.id), closureUpdate, { merge:true });
        batch.set(doc(db, window.ExploraCanonicalWeeklyClosure?.receiptIndexCollectionName?.()||"receipt_index", indexPayload.receiptId), indexPayload, { merge:true });
        try {
          await batch.commit();
          receiptFirestoreSynced = true;
        }
        catch (firestoreError) { throw createClosureReceiptError(currentStage, String(firestoreError?.code||"").includes("permission") ? "CLOSURE_RECEIPT_PERMISSION_FAILED" : "CLOSURE_RECEIPT_SYNC_FAILED", "No se pudo guardar y sincronizar el comprobante de cierre.", firestoreError); }

        currentStage = "FINALIZE_CLOSURE_RECEIPT_UI";
        diagnosticContext.stage = currentStage;
        Object.assign(statusData, commonReceipt, { receiptUrl:uploaded.receiptUrl, receiptPath:uploaded.receiptPath });
        clearWeeklyClosureReceiptError({ force:true });
        resetWeeklyDriverReceiptSelection({ clearInput:true, clearMessage:false });
        const form = $("weeklyReceiptForm"); if (form) form.hidden = true;
        const note = $("weeklyClosureNote"); if (note) { note.textContent = summary.balanced ? "CIERRE COMPLETADO · Comprobante recibido" : "CIERRE COMPLETADO · Pago comprobado"; note.className = "weekly-closure-note is-ok"; }
        const message = $("weeklyClosureMsg"); if (message) { message.textContent = "CIERRE COMPLETADO"; message.className = "weekly-closure-msg ok"; message.hidden = false; }
        const adminStatus=$("weeklyClosureAdministrativeStatus"),adminTitle=$("weeklyClosureAdministrativeTitle"),adminDetail=$("weeklyClosureAdministrativeDetail");
        if(adminStatus)adminStatus.dataset.state="completed";if(adminTitle)adminTitle.textContent="CIERRE COMPLETADO";if(adminDetail)adminDetail.textContent=summary.balanced?"Comprobante recibido":"Pago comprobado";
        try {
          renderExistingClosureReceipt(statusData);
        } catch (renderError) {
          console.error("EXPLORA_WEEKLY_CLOSURE_RECEIPT_RENDER_ERROR", renderError);
          const receiptBox = $("weeklyClosureExistingReceipt");
          if (receiptBox) {
            receiptBox.hidden = false;
            receiptBox.replaceChildren();
            const fallback = document.createElement("div");
            fallback.className = "weekly-closure-existing-receipt-head";
            const copy = document.createElement("div");
            const label = document.createElement("span");
            label.textContent = "COMPROBANTE CARGADO";
            const detail = document.createElement("strong");
            detail.textContent = "Guardado correctamente. Abrí Comprobantes → Cierre semanal para verlo.";
            copy.append(label, detail);
            const requirement = document.createElement("b");
            requirement.className = "weekly-closure-existing-receipt-requirement";
            requirement.textContent = "REGISTRADO";
            fallback.append(copy, requirement);
            receiptBox.append(fallback);
          }
        }
        invalidateWeeklyClosureCache("receipt-uploaded"); window.invalidateWeeklyFinancialEngine?.("weekly-receipt-uploaded"); window.invalidateReceiptCache?.("cierres");
        window.ExploraReceipts?.invalidate?.("cierres");
        if (btn) { btn.textContent = "COMPROBANTE CARGADO"; btn.disabled = true; }
        refreshDriverPaymentStatus({ force:true }).catch(()=>{});
      } catch (error) {
        diagnosticContext.elapsedMs = Date.now() - diagnosticContext.startedAt;
        if (diagnosticContext.closureId) await window.ExploraCanonicalWeeklyClosure?.markProofError?.(diagnosticContext.closureId,error).catch?.(()=>{});
        if (uploaded?.receiptPath && !receiptFirestoreSynced) window.ExploraReceiptEngine?.deleteUploadedFile?.(uploaded.receiptPath).catch(()=>{});
        showWeeklyClosureReceiptError(error, diagnosticContext);
        showWeeklyClosureSummaryDiagnostic(currentStage, "WEEKLY_CLOSURE_RECEIPT_UPLOAD_FAILED", error, {
          functionName:"submitDriverWeeklyReceipt", driverUid:diagnosticContext.driverUid, weeklyPeriodId:diagnosticContext.weeklyPeriodId,
          snapshot:statusData.weeklySnapshot, finalAmount:statusData.amount, payerRole:statusData.payer, otherAdjustments:statusData.normalizedSummary?.otherAdjustments || 0, storagePath:diagnosticContext.path, firestorePath:diagnosticContext.firestorePath, query:"upload closure receipt + writeBatch closure/receipt_index"
        });
      } finally {
        driverClosureReceiptInProgress = false; closureState.saving = false; weeklyDriverReceiptState.uploading = false;
        if (btn && !statusData.receiptUrl) { const currentSummary=statusData.normalizedSummary||{};const mayUpload=currentSummary.payer==="driver"&&Number(currentSummary.amount||0)>WEEKLY_CLOSURE_BALANCE_TOLERANCE;btn.disabled=!(weeklyDriverReceiptState.file instanceof File)||!mayUpload;btn.removeAttribute("aria-busy");btn.textContent="CONFIRMAR COMPROBANTE"; }
        else btn?.removeAttribute("aria-busy");
        window.unlockPageScroll?.("weekly-closure-saving"); document.body.classList.remove("weekly-closure-saving","is-loading");
      }
    }

    $("profilePendingClosureBtn")?.addEventListener("click", openWeeklyClosureModal);
    $("weeklyClosureCurrentViewBtn")?.addEventListener("click",()=>{if(weeklyClosureViewState.active!=="current"&&!weeklyClosureViewState.switching)showWeeklyClosureView("current",{force:true}).catch(()=>{});});
    $("weeklyClosurePreviousViewBtn")?.addEventListener("click",()=>{if(weeklyClosureViewState.active!=="previous"&&!weeklyClosureViewState.switching)showWeeklyClosureView("previous",{force:false}).catch(()=>{});});
    $("weeklyClosurePreviousEmptyBackBtn")?.addEventListener("click",()=>{if(!weeklyClosureViewState.switching)showWeeklyClosureView("current",{force:true}).catch(()=>{});});
    $("weeklyClosureCloseBtn")?.addEventListener("click", closeWeeklyClosureModal);
    $("weeklyClosureKeepPendingBtn")?.addEventListener("click", closeWeeklyClosureModal);
    $("weeklyClosureBackToDashboardBtn")?.addEventListener("click", closeWeeklyClosureModal);
    $("weeklyClosureOverlay")?.addEventListener("click", (event) => { if (event.target?.id === "weeklyClosureOverlay") closeWeeklyClosureModal(); });
    $("weeklyDriverReceiptBtn")?.addEventListener("click",()=>{const input=$("weeklyDriverReceiptInput");if(!input||input.disabled||weeklyDriverReceiptState.uploading)return;try{if(typeof input.showPicker==="function")input.showPicker();else input.click();}catch(_){input.click();}});
    $("weeklyClosurePreviewRemove")?.addEventListener("click",()=>{if(!weeklyDriverReceiptState.uploading)resetWeeklyDriverReceiptSelection({ clearInput:true, clearMessage:true });});
    $("weeklyDriverReceiptInput")?.addEventListener("change",handleWeeklyDriverReceiptChange);
    $("weeklyClosureDiagnosticCopyBtn")?.addEventListener("click",copyWeeklyClosureReceiptError);
    $("weeklyClosureDiagnosticCloseBtn")?.addEventListener("click",()=>clearWeeklyClosureReceiptError({ force:true }));
    $("weeklyReceiptForm")?.addEventListener("submit", submitDriverWeeklyReceipt);
    $("weeklySummaryDiagnosticCopy")?.addEventListener("click",copyWeeklyClosureSummaryDiagnostic);
    $("weeklySummaryDiagnosticClose")?.addEventListener("click",closeWeeklyClosureSummaryDiagnostic);
    $("weeklySummaryDiagnosticCloseBottom")?.addEventListener("click",closeWeeklyClosureSummaryDiagnostic);
    $("weeklySummaryDiagnosticBackdrop")?.addEventListener("click",event=>{if(event.target?.id==="weeklySummaryDiagnosticBackdrop")closeWeeklyClosureSummaryDiagnostic();});

    // Perfil real: avatar liviano guardado directamente en Firestore
    const profileState = {
      selectedFile: null,
      previewUrl: "",
      processedPhoto: null,
      processingPromise: null,
      processingToken: 0,
      saving: false,
      saveStartedAt: 0,
      lastScrollTop: 0,
      optimisticPreviousAvatarUrl: "",
      optimisticPreviousAvatarVersion: 0
    };

    function profileWithTimeout(promise, milliseconds, code) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(code || "OPERATION_TIMEOUT"));
        }, milliseconds);
        Promise.resolve(promise).then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
      });
    }

    function profileMsg(text, type = "") {
      const el = $("profileMessage");
      if (!el) return;
      el.textContent = text || "";
      el.className = "profile-message" + (type ? " " + type : "");
    }

    function createProfileSaveError(code, cause = null) {
      const error = new Error(code);
      error.code = code;
      if (cause) error.cause = cause;
      return error;
    }

    function profileDiagnostic(stage, detail = {}) {
      const elapsedMs = profileState.saveStartedAt ? Math.max(0, Math.round(performance.now() - profileState.saveStartedAt)) : 0;
      const safeDetail = { elapsedMs, ...detail };
      try { console.info(`[EXPLORA profile] ${stage}`, safeDetail); } catch (_) {}
    }

    function withProfileStageTimeout(promise, milliseconds, code) {
      let timer = null;
      return Promise.race([
        Promise.resolve(promise).finally(() => {
          if (timer) clearTimeout(timer);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(createProfileSaveError(code)), milliseconds);
        })
      ]);
    }

    function setProfileSavingState(state = "idle") {
      const btn = $("profileSaveBtn");
      const changePhotoBtn = $("profileChangePhotoBtn");
      const progressEl = $("profileSaveProgress");
      const busy = state === "processing" || state === "saving";
      const labels = { idle:"Guardar foto", processing:"Preparando foto…", saving:"Guardando foto…", success:"Guardar foto", error:"Guardar foto" };
      if (btn) {
        btn.disabled = busy || !(profileState.selectedFile instanceof File);
        btn.textContent = labels[state] || labels.idle;
        btn.setAttribute("aria-busy", busy ? "true" : "false");
      }
      if (changePhotoBtn) changePhotoBtn.disabled = busy;
      if (progressEl) {
        const visible = busy;
        progressEl.classList.toggle("is-visible", visible);
        progressEl.textContent = visible ? (labels[state] || "") : "";
      }
    }


    function mapProfileSaveError(error) {
      const code = String((error && (error.code || error.message)) || "");
      const causeCode = String((error && error.cause && (error.cause.code || error.cause.message)) || "");
      const lower = `${code} ${causeCode}`.toLowerCase();
      if (lower.includes("auth_required") || lower.includes("auth_session") || lower.includes("user-token-expired")) {
        return "No se pudo verificar tu sesión. Vuelve a ingresar.";
      }
      if (lower.includes("session_profile_not_ready")) {
        return "No se pudo preparar tu perfil. Cierra sesión e ingresa nuevamente.";
      }
      if (lower.includes("profile_not_found") || lower.includes("invalid_profile_document")) {
        return "No se encontró el perfil asociado a tu cuenta.";
      }
      if (lower.includes("profile_document_id_missing") || lower.includes("profile_collection_missing")) {
        return "No se encontró la referencia de tu perfil.";
      }
      if (lower.includes("profile_uid_mismatch")) {
        return "La sesión no coincide con el perfil cargado.";
      }
      if (lower.includes("profile_permission_denied") || lower.includes("permission-denied") || lower.includes("firestore/permission-denied")) {
        return "No tienes permisos para actualizar tu foto.";
      }
      if (lower.includes("profile_update_timeout")) {
        return "No se pudo guardar la fotografía a tiempo. Inténtalo nuevamente.";
      }
      if (lower.includes("profile_update") || lower.includes("firestore") || lower.includes("not-found")) {
        return "No pudimos actualizar tu foto. Intenta nuevamente.";
      }
      if (lower.includes("file_empty")) {
        return "iPhone no pudo descargar la fotografía seleccionada desde iCloud. Inténtalo nuevamente.";
      }
      if (lower.includes("file_read_timeout") || lower.includes("file_read_failed")) {
        return "No se pudo leer la fotografía seleccionada. Inténtalo nuevamente.";
      }
      if (lower.includes("heic_decode_unsupported")) {
        return "No se pudo convertir esta fotografía HEIC. Intenta tomar una nueva foto o selecciona una versión JPG.";
      }
      if (lower.includes("invalid_image_file")) {
        return "Selecciona una fotografía JPG, PNG o WebP compatible.";
      }
      if (lower.includes("image_too_large")) {
        return "La imagen es demasiado grande. Selecciona otra fotografía.";
      }
      if (lower.includes("image_dimensions_invalid")) {
        return "La fotografía seleccionada no contiene una imagen válida.";
      }
      if (lower.includes("image_output_too_large")) {
        return "La fotografía no pudo optimizarse lo suficiente. Elige otra imagen.";
      }
      if (lower.includes("canvas_context_unavailable") || lower.includes("canvas_draw_failed")) {
        return "No se pudo preparar la fotografía seleccionada.";
      }
      if (lower.includes("canvas_blob_empty") || lower.includes("image_encoding") || lower.includes("webp_encoding") || lower.includes("blob_data_url")) {
        return "No se pudo comprimir la fotografía seleccionada.";
      }
      if (lower.includes("image_decode") || lower.includes("image_bitmap") || lower.includes("file_reader_decode")) {
        return "No se pudo decodificar la fotografía seleccionada.";
      }
      if (lower.includes("image_process_timeout") || lower.includes("image_decode_timeout") || lower.includes("image_encoding_timeout")) {
        return "La fotografía está tardando demasiado en procesarse. Intenta con otra imagen.";
      }
      if (lower.includes("network") || lower.includes("unavailable")) {
        return "No pudimos actualizar tu foto. Revisa tu conexión e intenta nuevamente.";
      }
      return "No pudimos actualizar tu foto. Intenta nuevamente.";
    }


    function getWritableProfileDocumentFromSession(user) {
      if (!user?.uid) throw createProfileSaveError("AUTH_REQUIRED");

      const profile = exploraSession.profile || authSessionState.profile || null;
      const profileDocumentId = String(
        exploraSession.profileDocumentId ||
        exploraSession.driverId ||
        authSessionState.profileDocumentId ||
        ""
      ).trim();
      const profileCollection = String(
        exploraSession.profileCollection ||
        authSessionState.profileCollection ||
        exploraSession.profileRef?.parent?.id ||
        ""
      ).trim();
      const profileRef = exploraSession.profileRef || (
        profileCollection && profileDocumentId
          ? doc(db, profileCollection, profileDocumentId)
          : null
      );

      if (!exploraSession.initialized || !profile || !profileRef || !profileDocumentId || !profileCollection) {
        throw createProfileSaveError("SESSION_PROFILE_NOT_READY");
      }

      const sessionUid = String(exploraSession.authUser?.uid || authSessionState.authenticatedUser?.uid || "").trim();
      if (sessionUid && sessionUid !== user.uid) {
        throw createProfileSaveError("PROFILE_UID_MISMATCH");
      }

      const declaredUid = String(profile.uid || profile.authUid || profile.firebaseUid || profile.userId || "").trim();
      if (declaredUid && declaredUid !== user.uid) {
        throw createProfileSaveError("INVALID_PROFILE_DOCUMENT");
      }

      const declaredEmail = String(profile.email || profile.correo || "").trim().toLowerCase();
      const authEmail = String(user.email || "").trim().toLowerCase();
      if (!declaredUid && declaredEmail && authEmail && declaredEmail !== authEmail) {
        throw createProfileSaveError("INVALID_PROFILE_DOCUMENT");
      }

      return { profileRef, profileDocumentId, profileCollection, profile };
    }

    function chooseExistingField(data, candidates, fallback) {
      return candidates.find((key) => Object.prototype.hasOwnProperty.call(data || {}, key)) || fallback;
    }

    function buildSafeProfileUpdates(currentProfile, values) {
      if (!values?.changedAvatar || !values?.avatarValue) return { updates:{}, avatarKey:"avatarUrl" };
      const avatarKey = "avatarUrl";
      const updates = { [avatarKey]: values.avatarValue };
      const updatedAtKey = chooseExistingField(currentProfile, ["avatarUpdatedAt", "fotoActualizadaEn"], "avatarUpdatedAt");
      const versionKey = chooseExistingField(currentProfile, ["avatarVersion", "fotoVersion"], "avatarVersion");
      updates[updatedAtKey] = serverTimestamp();
      updates[versionKey] = values.avatarVersion;
      return { updates, avatarKey, updatedAtKey, versionKey };
    }


    function getProfileAvatarPath(data = {}) {
      return String(data.avatarPath || data.avatarStoragePath || data.fotoPerfilPath || data.fotoPath || "").trim();
    }

    function cacheBustAvatarUrl(url, version = Date.now()) {
      if (!url || url.startsWith("data:") || url.startsWith("blob:")) return url;
      const sep = url.includes("?") ? "&" : "?";
      return `${url}${sep}v=${encodeURIComponent(version)}`;
    }

    function resetProfileSavingState(message = "", type = "") {
      profileState.saving = false;
      setProfileSavingState("idle");
      const btn = $("profileSaveBtn");
      if (btn) {
        btn.disabled = !(profileState.selectedFile instanceof File);
        btn.textContent = "Guardar foto";
        btn.setAttribute("aria-busy", "false");
      }

      document.body.classList.remove("profile-saving", "modal-open", "no-scroll", "is-loading");
      document.documentElement.classList.remove("profile-saving", "modal-open", "no-scroll", "is-loading");
      document.body.removeAttribute("inert");
      document.documentElement.removeAttribute("inert");
      document.body.removeAttribute("aria-busy");
      document.documentElement.removeAttribute("aria-busy");
      document.body.style.pointerEvents = "";
      document.documentElement.style.pointerEvents = "";

      document.querySelectorAll(".profile-saving-overlay,.profile-loader,.saving-overlay,.upload-overlay,.profile-backdrop").forEach((el) => {
        el.classList.remove("is-open", "is-active", "show");
        el.setAttribute("aria-hidden", "true");
        el.style.pointerEvents = "none";
      });

      const input = $("profilePhotoInput");
      if (input) {
        input.style.pointerEvents = "none";
        input.style.position = "";
        input.style.inset = "";
        input.style.zIndex = "";
      }

      const profile = $("profileScreen");
      if (profile) {
        profile.style.pointerEvents = "";
        profile.removeAttribute("inert");
        profile.classList.remove("is-loading", "profile-saving");
        if (profile.classList.contains("is-open")) {
          profile.setAttribute("aria-hidden", "false");
          profile.style.overflowY = "auto";
          profile.style.webkitOverflowScrolling = "touch";
          profile.style.touchAction = "pan-y";
          window.lockPageScroll?.("profile-screen");
        } else {
          profile.setAttribute("aria-hidden", "true");
          window.unlockPageScroll?.("profile-screen");
        }
      } else {
        window.unlockPageScroll?.("profile-screen");
      }

      if (message) profileMsg(message, type);
    }

    function openProfileScreen() {
      const screen = $("profileScreen");
      if (!screen) return;
      applyDriverDataToUI();
      sanitizeProfileScreen();
      renderDriverStatusCard({ status: CLOSURE_STATUS.CLOSURE_LOADING, clickable: false });
      refreshProfilePendingClosure().catch((error) => {
        renderPendingClosureCard(null);
        if (isPaymentStatusTimeout(error)) {
          const active = getActiveWeeklyPeriod();
          const fallback = stableDashboardNoticeFallback(active, error);
          applyClosureState(fallback.result);
          if (!fallback.rendered) renderDriverStatusCard(fallback.result);
          reportDashboardNoticeError("READ_DASHBOARD_NOTICE", "PAYMENT_STATUS_TIMEOUT", error, { functionName:"refreshProfilePendingClosure", weeklyPeriodId:active.id, firestorePath:"cierres_semanales", query:"resolveWeeklyClosureStatus(uid, weeklyPeriodId)", fallbackUsed:true, result:`Último estado conservado: ${fallback.source}`, silent:true });
          return;
        }
        renderDriverStatusCard({ status: CLOSURE_STATUS.CLOSURE_ERROR, clickable: false, error });
      });
      screen.classList.add("is-open");
      screen.setAttribute("aria-hidden","false");
      screen.style.overflowY = "auto";
      screen.style.webkitOverflowScrolling = "touch";
      screen.style.touchAction = "pan-y";
      window.lockPageScroll?.("profile-screen");
      if (window.ExploraMainNav) window.ExploraMainNav.setActive("perfil");
      window.ExploraPerformanceEngine?.renderProfileGoal?.({ animate: true, reason: "PROFILE_ENTER" });
      saveLastScreen("perfil");
    }

    function closeProfileScreen() {
      const screen = $("profileScreen");
      if (!screen) return;
      screen.classList.remove("is-open");
      screen.setAttribute("aria-hidden","true");
      window.unlockPageScroll?.("profile-screen");
      profileMsg("");
      closeWeeklyClosureModal();
      renderPendingClosureCard(null);
      if (profileState.previewUrl) URL.revokeObjectURL(profileState.previewUrl);
      profileState.previewUrl = "";
      profileState.selectedFile = null;
      profileState.processedPhoto = null;
      profileState.processingPromise = null;
      profileState.processingToken += 1;
      if ($("profilePhotoInput")) $("profilePhotoInput").value = "";
      if (window.ExploraMainNav) window.ExploraMainNav.setActive("inicio");
      saveLastScreen("dashboard");
    }

    function isValidPhone(value) {
      const cleaned = String(value || "").replace(/[\s().-]/g, "");
      return !cleaned || /^\+?[0-9]{6,18}$/.test(cleaned);
    }

    function getProfilePhotoExtension(file) {
      const name = String(file && file.name || "").trim().toLowerCase();
      const match = name.match(/\.([a-z0-9]+)$/i);
      return match ? match[1].toLowerCase() : "";
    }

    function isSupportedProfileImage(file) {
      if (!(file instanceof File)) return false;
      if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 15 * 1024 * 1024) return false;
      const type = String(file.type || "").trim().toLowerCase();
      const extension = getProfilePhotoExtension(file);
      const acceptedMime = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"]);
      const acceptedExtension = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);
      if (type && acceptedMime.has(type)) return true;
      if (extension && acceptedExtension.has(extension)) return true;
      // iOS puede entregar fotografías válidas sin MIME ni extensión confiable.
      return !type && !extension;
    }

    async function readProfileFileBuffer(file) {
      if (!(file instanceof Blob)) throw createProfileSaveError("INVALID_IMAGE_FILE");
      const headerBlob = typeof file.slice === "function" ? file.slice(0, 64) : file;
      if (typeof headerBlob.arrayBuffer === "function") {
        return await profileWithTimeout(headerBlob.arrayBuffer(), 15000, "FILE_READ_TIMEOUT");
      }
      return await profileWithTimeout(new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(createProfileSaveError("FILE_READ_FAILED", reader.error));
        reader.onabort = () => reject(createProfileSaveError("FILE_READ_FAILED"));
        reader.readAsArrayBuffer(headerBlob);
      }), 15000, "FILE_READ_TIMEOUT");
    }

    function detectProfileImageFormat(file, arrayBuffer) {
      const declaredType = String(file && file.type || "").trim().toLowerCase();
      const extension = getProfilePhotoExtension(file);
      const bytes = new Uint8Array(arrayBuffer || new ArrayBuffer(0));
      let detectedType = "";
      let detectedExtension = "";

      if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        detectedType = "image/jpeg";
        detectedExtension = "jpg";
      } else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        detectedType = "image/png";
        detectedExtension = "png";
      } else if (
        bytes.length >= 12 &&
        String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
        String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
      ) {
        detectedType = "image/webp";
        detectedExtension = "webp";
      } else if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") {
        const headerText = Array.from(bytes.slice(0, Math.min(bytes.length, 64)))
          .map((value) => String.fromCharCode(value))
          .join("")
          .toLowerCase();
        if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].some((brand) => headerText.includes(brand))) {
          detectedType = declaredType === "image/heif" || extension === "heif" ? "image/heif" : "image/heic";
          detectedExtension = detectedType === "image/heif" ? "heif" : "heic";
        }
      }

      if (!detectedType) {
        if (["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"].includes(declaredType)) {
          detectedType = declaredType === "image/jpg" ? "image/jpeg" : declaredType;
          detectedExtension = extension || (detectedType === "image/jpeg" ? "jpg" : detectedType.split("/")[1]);
        } else if (["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(extension)) {
          detectedExtension = extension === "jpeg" ? "jpg" : extension;
          detectedType = detectedExtension === "jpg" ? "image/jpeg" : `image/${detectedExtension}`;
        }
      }

      return {
        mimeType: detectedType,
        extension: detectedExtension,
        isHeic: detectedType === "image/heic" || detectedType === "image/heif" || extension === "heic" || extension === "heif"
      };
    }

    function createDecodedImageResult(source, method, cleanup = () => {}) {
      const width = Number(source && (source.width || source.naturalWidth) || 0);
      const height = Number(source && (source.height || source.naturalHeight) || 0);
      if (!width || !height) {
        try { cleanup(); } catch (_) {}
        throw createProfileSaveError("IMAGE_DIMENSIONS_INVALID");
      }
      return { source, width, height, method, cleanup };
    }

    async function decodeProfileImageWithBitmap(file) {
      if (typeof createImageBitmap !== "function") throw createProfileSaveError("IMAGE_BITMAP_UNAVAILABLE");
      let bitmap = null;
      try {
        try {
          bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        } catch (_) {
          bitmap = await createImageBitmap(file);
        }
        return createDecodedImageResult(bitmap, "createImageBitmap", () => {
          try { bitmap && typeof bitmap.close === "function" && bitmap.close(); } catch (_) {}
        });
      } catch (error) {
        try { bitmap && typeof bitmap.close === "function" && bitmap.close(); } catch (_) {}
        throw createProfileSaveError("IMAGE_BITMAP_DECODE_FAILED", error);
      }
    }

    function loadProfileImageElement(sourceUrl, { revokeUrl = false, timeoutMs = 15000, method = "image-element" } = {}) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
          callback();
        };
        const cleanupUrl = () => {
          if (revokeUrl) {
            try { URL.revokeObjectURL(sourceUrl); } catch (_) {}
          }
        };
        const timer = setTimeout(() => finish(() => {
          cleanupUrl();
          reject(createProfileSaveError("IMAGE_DECODE_TIMEOUT"));
        }), timeoutMs);

        image.decoding = "async";
        image.onload = () => finish(() => {
          try {
            resolve(createDecodedImageResult(image, method, cleanupUrl));
          } catch (error) {
            cleanupUrl();
            reject(error);
          }
        });
        image.onerror = () => finish(() => {
          cleanupUrl();
          reject(createProfileSaveError("IMAGE_DECODE_FAILED"));
        });
        image.src = sourceUrl;
      });
    }

    async function decodeProfileImageWithObjectUrl(file) {
      const objectUrl = URL.createObjectURL(file);
      return await loadProfileImageElement(objectUrl, {
        revokeUrl: true,
        timeoutMs: 15000,
        method: "object-url"
      });
    }

    async function decodeProfileImageWithDataUrl(file) {
      const dataUrl = await profileWithTimeout(new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(createProfileSaveError("FILE_READER_DECODE_FAILED", reader.error));
        reader.onabort = () => reject(createProfileSaveError("FILE_READER_DECODE_FAILED"));
        reader.readAsDataURL(file);
      }), 15000, "FILE_READ_TIMEOUT");
      if (!dataUrl.startsWith("data:image/")) throw createProfileSaveError("IMAGE_DECODE_FAILED");
      return await loadProfileImageElement(dataUrl, {
        revokeUrl: false,
        timeoutMs: 15000,
        method: "file-reader"
      });
    }

    async function decodeProfileImage(file, formatInfo) {
      profileDiagnostic("PROFILE_DECODE_START", { heic: Boolean(formatInfo && formatInfo.isHeic) });
      const isSafari = /Safari/i.test(navigator.userAgent) && !/Chrome|CriOS|Android/i.test(navigator.userAgent);
      const attempts = isSafari
        ? [
            ["object-url", decodeProfileImageWithObjectUrl],
            ["file-reader", decodeProfileImageWithDataUrl],
            ["createImageBitmap", decodeProfileImageWithBitmap]
          ]
        : [
            ["createImageBitmap", decodeProfileImageWithBitmap],
            ["object-url", decodeProfileImageWithObjectUrl],
            ["file-reader", decodeProfileImageWithDataUrl]
          ];
      let lastError = null;
      for (const [method, decoder] of attempts) {
        try {
          profileDiagnostic("PROFILE_DECODE_METHOD", { method });
          const decoded = await decoder(file);
          profileDiagnostic("PROFILE_DECODE_SUCCESS", { method: decoded.method, width: decoded.width, height: decoded.height });
          return decoded;
        } catch (error) {
          lastError = error;
          profileDiagnostic("PROFILE_PROCESSING_ERROR", { stage: `decode:${method}`, code: String(error && (error.code || error.message) || "UNKNOWN") });
        }
      }
      if (formatInfo && formatInfo.isHeic) throw createProfileSaveError("HEIC_DECODE_UNSUPPORTED", lastError);
      throw createProfileSaveError("IMAGE_DECODE_FAILED", lastError);
    }

    async function canvasToBlobSafe(canvas, type, quality) {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(createProfileSaveError("IMAGE_ENCODING_TIMEOUT"));
        }, 10000);
        try {
          canvas.toBlob((blob) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!blob || blob.size <= 0) {
              reject(createProfileSaveError("CANVAS_BLOB_EMPTY"));
              return;
            }
            resolve(blob);
          }, type, quality);
        } catch (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(createProfileSaveError("IMAGE_ENCODING_FAILED", error));
        }
      });
    }

    async function blobToProfileDataUrl(blob) {
      if (!(blob instanceof Blob) || blob.size <= 0) throw createProfileSaveError("BLOB_DATA_URL_INVALID");
      return await profileWithTimeout(new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const value = String(reader.result || "");
          if (!value.startsWith("data:image/")) {
            reject(createProfileSaveError("BLOB_DATA_URL_INVALID"));
            return;
          }
          resolve(value);
        };
        reader.onerror = () => reject(createProfileSaveError("BLOB_DATA_URL_FAILED", reader.error));
        reader.onabort = () => reject(createProfileSaveError("BLOB_DATA_URL_FAILED"));
        reader.readAsDataURL(blob);
      }), 5000, "BLOB_DATA_URL_TIMEOUT");
    }

    async function processProfilePhoto(file) {
      if (!(file instanceof File)) throw createProfileSaveError("INVALID_IMAGE_FILE");
      if (file.size <= 0) throw createProfileSaveError("FILE_EMPTY");
      if (file.size > 15 * 1024 * 1024) throw createProfileSaveError("IMAGE_TOO_LARGE");
      if (!isSupportedProfileImage(file)) throw createProfileSaveError("INVALID_IMAGE_FILE");

      const buffer = await readProfileFileBuffer(file);
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength <= 0) throw createProfileSaveError("FILE_EMPTY");
      const formatInfo = detectProfileImageFormat(file, buffer);
      if (!formatInfo.mimeType) throw createProfileSaveError("INVALID_IMAGE_FILE");

      const decoded = await profileWithTimeout(decodeProfileImage(file, formatInfo), 12000, "IMAGE_DECODE_TIMEOUT");
      let canvas = null;
      try {
        const sourceWidth = Number(decoded.width || 0);
        const sourceHeight = Number(decoded.height || 0);
        if (!sourceWidth || !sourceHeight) throw createProfileSaveError("IMAGE_DIMENSIONS_INVALID");
        const sourceSize = Math.min(sourceWidth, sourceHeight);
        if (sourceSize <= 0) throw createProfileSaveError("IMAGE_DIMENSIONS_INVALID");

        const sourceX = (sourceWidth - sourceSize) / 2;
        const sourceY = (sourceHeight - sourceSize) / 2;
        const targetBytes = 60 * 1024;
        const maxBytes = 90 * 1024;

        const renderCanvas = (outputSize) => {
          if (canvas) { canvas.width = 1; canvas.height = 1; }
          canvas = document.createElement("canvas");
          canvas.width = outputSize;
          canvas.height = outputSize;
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw createProfileSaveError("CANVAS_CONTEXT_UNAVAILABLE");
          context.fillStyle = "#0b0f12";
          context.fillRect(0, 0, outputSize, outputSize);
          context.imageSmoothingEnabled = true;
          if ("imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";
          context.drawImage(decoded.source, sourceX, sourceY, sourceSize, sourceSize, 0, 0, outputSize, outputSize);
          return canvas;
        };

        const encodeCandidates = async (outputSize) => {
          renderCanvas(outputSize);
          const attempts = [
            ["image/webp", "webp", 0.65],
            ["image/webp", "webp", 0.56],
            ["image/webp", "webp", 0.48],
            ["image/jpeg", "jpg", 0.68],
            ["image/jpeg", "jpg", 0.60],
            ["image/jpeg", "jpg", 0.55]
          ];
          let smallest = null;
          for (const [mimeType, extension, quality] of attempts) {
            try {
              const blob = await canvasToBlobSafe(canvas, mimeType, quality);
              if (!blob || blob.size <= 0) continue;
              if (mimeType === "image/webp" && !String(blob.type || "").includes("webp")) continue;
              const candidate = { blob, mimeType, contentType: mimeType, extension, quality, width: outputSize, height: outputSize, size: blob.size };
              if (!smallest || candidate.size < smallest.size) smallest = candidate;
              if (candidate.size <= targetBytes) return candidate;
            } catch (_) {}
          }
          return smallest;
        };

        let result = await encodeCandidates(256);
        if (!result || result.size > maxBytes) result = await encodeCandidates(224);
        if (!result || result.size <= 0) throw createProfileSaveError("IMAGE_ENCODING_FAILED");
        if (result.size > maxBytes) throw createProfileSaveError("IMAGE_OUTPUT_TOO_LARGE");

        const dataUrl = await blobToProfileDataUrl(result.blob);
        return {
          ...result,
          dataUrl,
          byteSize: result.size,
          decodeMethod: decoded.method
        };
      } catch (error) {
        if (String(error && (error.code || error.message) || "").includes("drawImage")) {
          throw createProfileSaveError("CANVAS_DRAW_FAILED", error);
        }
        throw error;
      } finally {
        try { decoded.cleanup(); } catch (_) {}
        if (canvas) { canvas.width = 1; canvas.height = 1; }
      }
    }


    function applyAvatarEverywhere(uid, cleanUrl, version = Date.now()) {
      if (!cleanUrl || !uid) return;
      const uidText = String(uid);
      const visualUrl = cacheBustAvatarUrl(cleanUrl, version);
      const currentUid = exploraSession.authUser && exploraSession.authUser.uid;

      if (uidText === String(currentUid || "")) {
        ["profileAvatarPreview", "adminAvatar"].forEach((id) => {
          const image = $(id);
          if (image && image.tagName && image.tagName.toLowerCase() === "img") image.src = visualUrl;
        });
      }

      document.querySelectorAll("img[data-user-id], img[data-avatar-user-id], [data-user-id] img, [data-avatar-user-id] img").forEach((image) => {
        const owner = image.dataset.userId || image.dataset.avatarUserId || image.closest("[data-user-id]")?.dataset.userId || image.closest("[data-avatar-user-id]")?.dataset.avatarUserId || "";
        if (String(owner) === uidText) image.src = visualUrl;
      });

      window.dispatchEvent(new CustomEvent("explora:avatar-updated", {
        detail: { uid: uidText, avatarUrl: cleanUrl, visualUrl, version }
      }));
    }

    function applyOptimisticAvatarEverywhere(uid, previewUrl) {
      if (!uid || !previewUrl) return;
      const uidText = String(uid);
      ["profileAvatarPreview", "adminAvatar"].forEach((id) => {
        const image = $(id);
        if (image && image.tagName?.toLowerCase() === "img") image.src = previewUrl;
      });
      document.querySelectorAll("img[data-user-id], img[data-avatar-user-id], [data-user-id] img, [data-avatar-user-id] img").forEach((image) => {
        const owner = image.dataset.userId || image.dataset.avatarUserId || image.closest("[data-user-id]")?.dataset.userId || image.closest("[data-avatar-user-id]")?.dataset.avatarUserId || "";
        if (String(owner) === uidText) image.src = previewUrl;
      });
    }

    function restoreAvatarAfterOptimisticFailure(uid, previousUrl, previousVersion) {
      if (previousUrl) applyAvatarEverywhere(uid, previousUrl, previousVersion || Date.now());
      const preview = $("profileAvatarPreview");
      if (preview && profileState.previewUrl) preview.src = profileState.previewUrl;
    }

    function beginProfilePhotoProcessing(file) {
      const token = ++profileState.processingToken;
      profileState.processedPhoto = null;
      const startedAt = performance.now();
      profileDiagnostic("PROFILE_COMPRESS_START", { sourceBytes: file.size });
      profileState.processingPromise = processProfilePhoto(file)
        .then((result) => {
          if (token !== profileState.processingToken || profileState.selectedFile !== file) {
            return { ok: false, error: createProfileSaveError("IMAGE_SELECTION_CHANGED") };
          }
          profileState.processedPhoto = result;
          profileDiagnostic("PROFILE_COMPRESS_END", {
            durationMs: Math.round(performance.now() - startedAt),
            outputBytes: result.byteSize,
            width: result.width,
            height: result.height,
            type: result.mimeType
          });
          profileMsg("Foto optimizada y lista para guardar.");
          return { ok: true, result };
        })
        .catch((error) => {
          if (token === profileState.processingToken) {
            profileState.processedPhoto = null;
            profileDiagnostic("PROFILE_PROCESSING_ERROR", { code: String(error?.code || error?.message || "UNKNOWN") });
            profileMsg(mapProfileSaveError(error), "err");
          }
          return { ok: false, error };
        });
      return profileState.processingPromise;
    }


    
    async function saveProfileChanges(event) {
      event.preventDefault();
      if (profileState.saving) return;
      const user = auth.currentUser;
      if (!user?.uid) return profileMsg("No se pudo verificar tu sesión. Vuelve a ingresar.", "err");
      if (!(profileState.selectedFile instanceof File)) {
        setProfileSavingState("idle");
        return profileMsg("Selecciona una foto nueva para guardar.", "err");
      }

      let resolved;
      try { resolved = getWritableProfileDocumentFromSession(user); }
      catch (error) { return profileMsg(mapProfileSaveError(error), "err"); }

      const currentProfile = resolved.profile || {};
      const uid = user.uid;
      const oldAvatarValue = getProfileAvatarUrl(currentProfile, user);
      const oldAvatarVersion = Number(currentProfile.avatarVersion || currentProfile.fotoVersion || 0) || Date.now();
      const previousPreviewUrl = profileState.previewUrl;
      let primarySucceeded = false;
      let finalMessage = "";
      let finalType = "";

      profileState.saving = true;
      profileState.saveStartedAt = performance.now();
      setProfileSavingState(profileState.processedPhoto ? "saving" : "processing");
      profileMsg(profileState.processedPhoto ? "Guardando foto…" : "Preparando foto…");
      profileDiagnostic("PROFILE_PHOTO_SAVE_START", { hasNewImage:true });

      try {
        if (profileState.previewUrl) applyOptimisticAvatarEverywhere(uid, profileState.previewUrl);
        const outcome = profileState.processedPhoto
          ? { ok:true, result:profileState.processedPhoto }
          : await (profileState.processingPromise || beginProfilePhotoProcessing(profileState.selectedFile));
        if (!outcome?.ok || !outcome.result?.dataUrl) throw outcome?.error || createProfileSaveError("IMAGE_PROCESSING_FAILED");

        const processed = outcome.result;
        const avatarVersion = Date.now();
        const safe = buildSafeProfileUpdates(currentProfile, {
          changedAvatar:true,
          avatarValue:processed.dataUrl,
          avatarVersion
        });
        if (!Object.keys(safe.updates).length) throw createProfileSaveError("PROFILE_UPDATE_FAILED");

        setProfileSavingState("saving");
        profileMsg("Guardando foto…");
        await withProfileStageTimeout(updateDoc(resolved.profileRef, safe.updates), 10000, "PROFILE_UPDATE_TIMEOUT");
        primarySucceeded = true;

        const mergedProfile = { ...currentProfile, avatarUrl:processed.dataUrl, avatarVersion };
        mergedProfile[safe.avatarKey] = processed.dataUrl;
        exploraSession.profile = mergedProfile;
        authSessionState.profile = mergedProfile;
        if (exploraAccessState?.user?.uid === uid) exploraAccessState.profile = mergedProfile;
        applyAvatarEverywhere(uid, processed.dataUrl, avatarVersion);
        applyDriverDataToUI();
        saveVisualSession();

        const context={uid,role:exploraSession.role||"chofer",weeklyPeriodId:getActiveWeeklyPeriod?.().id||""};
        ["driver_profiles","billing_ranking","derivation_ranking","performance_bundle","rankingSnapshot"].forEach(name=>window.ExploraFastCache?.invalidate?.(name,context));
        window.ExploraPerformanceEngine?.invalidateRankingCache?.("avatar-updated");
        Promise.resolve(window.ExploraPerformanceEngine?.refresh?.({force:true,reason:"avatar-updated"})).catch(error=>console.warn("PROFILE_RANKING_REFRESH",error));

        profileState.previewUrl = "";
        profileState.selectedFile = null;
        profileState.processedPhoto = null;
        profileState.processingPromise = null;
        profileState.processingToken += 1;
        if ($("profilePhotoInput")) $("profilePhotoInput").value = "";
        if ($("profileSaveBtn")) $("profileSaveBtn").dataset.photoSelected="false";
        if (previousPreviewUrl) { try { URL.revokeObjectURL(previousPreviewUrl); } catch (_) {} }

        finalMessage = "Tu foto de perfil se guardó correctamente.";
        finalType = "ok";
        profileMsg(finalMessage, finalType);
        window.showExploraSuccess?.({ title:"FOTO ACTUALIZADA", message:finalMessage });
        setTimeout(()=>window.ExploraSuccess?.close?.(),3200);
        profileDiagnostic("PROFILE_PHOTO_SAVE_SUCCESS", { firestoreWrites:1, avatarBytes:processed.byteSize || 0 });
      } catch (error) {
        if (!primarySucceeded) restoreAvatarAfterOptimisticFailure(uid, oldAvatarValue, oldAvatarVersion);
        finalMessage = mapProfileSaveError(error);
        finalType = "err";
        window.ExploraProductionPolicy?.handle?.("foto", error, { message:finalMessage });
        profileDiagnostic("PROFILE_PHOTO_SAVE_ERROR", { code:String(error?.code || error?.message || "UNKNOWN") });
      } finally {
        profileState.saving = false;
        setProfileSavingState(finalType === "ok" ? "success" : "error");
        resetProfileSavingState(finalMessage, finalType);
        profileState.saveStartedAt = 0;
      }
    }


    $("profileBackBtn")?.addEventListener("click", closeProfileScreen);
    $("profileChangePhotoBtn")?.addEventListener("click", () => $("profilePhotoInput")?.click());
    $("profilePhotoInput")?.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size <= 0) {
        event.target.value = "";
        return profileMsg("iPhone no pudo descargar la fotografía seleccionada desde iCloud. Inténtalo nuevamente.", "err");
      }
      if (!isSupportedProfileImage(file)) {
        event.target.value = "";
        return profileMsg("Selecciona una fotografía JPG, PNG o WebP compatible.", "err");
      }
      if (file.size > 15 * 1024 * 1024) {
        event.target.value = "";
        return profileMsg("La imagen es demasiado grande. Selecciona otra fotografía.", "err");
      }

      if (profileState.previewUrl) {
        try { URL.revokeObjectURL(profileState.previewUrl); } catch (_) {}
      }
      profileState.selectedFile = file;
      const saveButton=$("profileSaveBtn");if(saveButton)saveButton.dataset.photoSelected="true";
      profileState.processedPhoto = null;
      profileState.processingPromise = null;
      profileState.previewUrl = URL.createObjectURL(file);

      const preview = $("profileAvatarPreview");
      if (preview) {
        preview.onerror = () => profileMsg("La vista previa no pudo mostrarse, pero puedes intentar guardarla igualmente.", "err");
        preview.onload = () => {
          preview.onerror = null;
          preview.onload = null;
        };
        preview.src = profileState.previewUrl;
      }

      setProfileSavingState("idle");
      profileMsg("Preparando foto en segundo plano…");
      beginProfilePhotoProcessing(file);
    });
    $("profileForm")?.addEventListener("submit", saveProfileChanges);
    window.ExploraActions["abrir-perfil"] = openProfileScreen;
    window.addEventListener("explora:auth-ready", () => { window.ExploraLoadWeeklySession?.().catch(() => {}); });

    // El alta de servicios se registra únicamente desde el módulo financiero compartido.
    /* Registro de gastos consolidado en el módulo financiero único. */

    // Comprobantes
    function belongsToUser(data) {
      const role = exploraSession.role;
      if (role === "admin" || role === "administrador") return true;
      const user = auth.currentUser;
      const email = String(user && user.email || "").toLowerCase();
      const values = [data.choferUid,data.uid,data.userId,data.usuarioUid,data.chofer,data.choferId,data.usuario,data.email,data.choferEmail]
        .map(v => String(v || "").toLowerCase().trim());
      return values.includes(String(user && user.uid || "").toLowerCase()) || values.includes(exploraSession.driverId.toLowerCase()) || values.includes(email);
    }
    async function readCollectionSafe(name, category) {
      try {
        const snap = await getDocs(collection(db, name));
        const rows = [];
        snap.forEach(docSnap => {
          const data = docSnap.data() || {};
          if (!belongsToUser(data)) return;
          rows.push({ id: docSnap.id, sourceCollection: name, category, ...data });
        });
        return rows;
      } catch (_) { return []; }
    }

    function receiptModuleDateObject(value) {
      if (value?.toDate) return value.toDate();
      if (value?.seconds) return new Date(Number(value.seconds) * 1000);
      if (typeof value === "number") return new Date(value);
      if (typeof value === "string") { const parsed = new Date(value); if (!Number.isNaN(parsed.getTime())) return parsed; }
      return null;
    }
    function receiptModuleDateText(row = {}) {
      const value = row.receiptUploadedAt || row.comprobanteCargadoEn || row.closedAt || row.cerradoEn || row.createdAt || row.creadoEn || row.updatedAt || row.actualizadoEn;
      const date = receiptModuleDateObject(value);
      if (date && !Number.isNaN(date.getTime())) return date.toLocaleString("es-AR", { timeZone:"America/Argentina/Cordoba", day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
      return [row.fechaPago || row.fecha || row.periodoFin, row.horaPago || row.hora].filter(Boolean).join(" · ") || "—";
    }
    function receiptModuleMonthKey(row = {}) {
      const date = receiptModuleDateObject(row.receiptUploadedAt || row.closedAt || row.cerradoEn || row.createdAt || row.creadoEn || row.updatedAt) || new Date();
      return new Intl.DateTimeFormat("en-CA", { timeZone:"America/Argentina/Cordoba", year:"numeric", month:"2-digit" }).format(date).slice(0,7);
    }
    function receiptModuleName(row = {}) { return String(row.driverName || row.choferNombre || row.nombreChofer || row.nombre || row.displayName || "Chofer").trim(); }
    function receiptModulePeriod(row = {}) { return String(row.weeklyPeriodId || row.periodoSemanalId || row.periodoId || row.semanaId || row.closureWeek || row.periodo || "").trim(); }
    function receiptModuleUid(row = {}) { return String(row.driverUid || row.choferUid || row.uid || row.userUid || row.driverId || row.choferId || row.ownerUid || "").trim(); }
    function receiptModuleAmount(row = {}) {
      const values = [row.settlementAmount,row.amount,row.monto,row.importe,row.choferDebe,row.davidDebe,row.totalAmount,row.valor];
      for (const value of values) { const number = Number(value); if (Number.isFinite(number)) return Math.abs(Math.round(number)); }
      const signed = Number(row.netSettlementToDriver); return Number.isFinite(signed) ? Math.abs(Math.round(signed)) : 0;
    }
    function receiptModuleSource(row = {}) { return window.ExploraReceiptEngine?.resolveReceiptSource?.(row) || {}; }
    function receiptModuleState(row = {}, source = receiptModuleSource(row)) {
      const joined = [row.receiptStatus,row.estadoComprobante,row.paymentStatus,row.status,row.estado,row.closureStatus].map(value => String(value || "").toLowerCase()).join(" ");
      const balanced = row.balanced === true || row.sentido === "sin_diferencia" || joined.includes("equilibr") || joined.includes("no_requerido") || joined.includes("not_required");
      if (balanced) return "No requerido";
      if (joined.includes("rechaz") || joined.includes("reject")) return "Rechazado";
      if (["aprob","accept","confirm","pagado","paid","completed","completado"].some(token => joined.includes(token))) return "Aprobado";
      if (source.url || ["uploaded","subido","review","revision","revisión","recibido"].some(token => joined.includes(token))) return "Recibido";
      return "Pendiente";
    }
    function receiptModuleResultLabel(row = {}) {
      const explicit = String(row.resultLabel || row.resultadoFinal || row.actionText || "").trim();
      if (explicit) return explicit;
      const joined = [row.receiptStatus,row.estadoComprobante,row.status,row.estado].map(value => String(value || "").toLowerCase()).join(" ");
      if (row.balanced === true || row.sentido === "sin_diferencia" || joined.includes("equilibr")) return "Cuenta equilibrada";
      const payer = String(row.payerRole || row.payer || "").toLowerCase();
      if (["driver","chofer"].includes(payer) || Number(row.choferDebe || 0) > 0) return "Chofer paga a David";
      if (["admin","david"].includes(payer) || Number(row.davidDebe || 0) > 0) return "David paga al chofer";
      const signed = Number(row.netSettlementToDriver);
      if (Number.isFinite(signed)) return signed > 0 ? "David paga al chofer" : signed < 0 ? "Chofer paga a David" : "Cuenta equilibrada";
      return "Resultado semanal";
    }
    function receiptModuleKey(row = {}) {
      const closureId = String(row.closureId || row.recordId || row.id || "").trim();
      const uid = receiptModuleUid(row), period = receiptModulePeriod(row);
      return closureId || [uid, period].filter(Boolean).join("_") || `${receiptModuleName(row)}_${period}`;
    }
    function receiptModuleCommonRow(row = {}, category = "pagos", overrides = {}) {
      const source = receiptModuleSource(row);
      return {
        category,
        categoryLabel:overrides.categoryLabel || row.categoryLabel || category,
        title:overrides.title || row.title || "Comprobante",
        subtitle:overrides.subtitle || receiptModuleDateText(row),
        detail:overrides.detail || row.detail || row.notes || row.observaciones || "Comprobante registrado",
        amount:overrides.amount ?? receiptModuleAmount(row),
        state:overrides.state || receiptModuleState(row, source),
        url:overrides.url || source.url || "",
        mime:overrides.mime || source.mimeType || "",
        operationId:overrides.operationId || row.operationId || row.closureId || row.recordId || row.id || "",
        recordId:row.id || row.recordId || "",
        driverUid:receiptModuleUid(row),
        driverName:receiptModuleName(row),
        date:receiptModuleDateText(row),
        monthKey:receiptModuleMonthKey(row),
        weeklyPeriodId:receiptModulePeriod(row),
        raw:row
      };
    }
    async function receiptModuleReadMany(names = [], category = "pagos") {
      const unique = [...new Set(names.filter(Boolean))];
      const settled = await Promise.all(unique.map(name => readCollectionSafe(name, category)));
      const merged = new Map();
      settled.flat().forEach(row => merged.set(`${row.sourceCollection || ""}/${row.id || receiptModuleKey(row)}`, row));
      return [...merged.values()];
    }
    async function receiptModuleLoadClosures() {
      const canonicalClosure = window.ExploraCanonicalWeeklyClosure?.closureCollectionName?.() || "cierres_semanales";
      const canonicalIndex = window.ExploraCanonicalWeeklyClosure?.receiptIndexCollectionName?.() || "receipt_index";
      const [closures, indexes] = await Promise.all([
        receiptModuleReadMany([canonicalClosure,"cierres_semanales","cierresSemanales","cierres","pagos_semanales"], "cierres"),
        receiptModuleReadMany([canonicalIndex,"receipt_index"], "cierres")
      ]);
      const weeklyIndexes = indexes.filter(row => {
        const category = String(row.category || row.type || row.receiptCategory || "").toLowerCase();
        return category.includes("weekly_closure") || category.includes("cierre");
      });
      const indexMap = new Map();
      weeklyIndexes.forEach(row => {
        const keys = [String(row.closureId || row.recordId || "").trim(), [receiptModuleUid(row),receiptModulePeriod(row)].filter(Boolean).join("_")].filter(Boolean);
        keys.forEach(key => indexMap.set(key,row));
      });
      const used = new Set();
      const rows = closures.map(closure => {
        const keys = [String(closure.closureId || closure.id || "").trim(), [receiptModuleUid(closure),receiptModulePeriod(closure)].filter(Boolean).join("_")].filter(Boolean);
        let indexed = null;
        for (const key of keys) { if (indexMap.has(key)) { indexed = indexMap.get(key); used.add(indexed.id || key); break; } }
        const merged = {...closure,...(indexed || {}), closureId:closure.closureId || closure.id || indexed?.closureId || indexed?.recordId, weeklyPeriodId:receiptModulePeriod(closure) || receiptModulePeriod(indexed || {}), driverUid:receiptModuleUid(closure) || receiptModuleUid(indexed || {}), driverName:receiptModuleName(closure) !== "Chofer" ? receiptModuleName(closure) : receiptModuleName(indexed || {}), resultLabel:receiptModuleResultLabel({...closure,...(indexed || {})})};
        const balanced = merged.balanced === true || merged.sentido === "sin_diferencia" || merged.resultLabel === "Cuenta equilibrada";
        return receiptModuleCommonRow(merged,"cierres",{categoryLabel:"Cierre semanal",title:balanced?"Cierre equilibrado":merged.resultLabel,detail:`Semana ${receiptModulePeriod(merged) || "—"} · ${merged.resultLabel}`,amount:receiptModuleAmount(merged),state:receiptModuleState(merged)});
      });
      weeklyIndexes.forEach(indexed => {
        if (used.has(indexed.id)) return;
        const merged = {...indexed,resultLabel:receiptModuleResultLabel(indexed)};
        rows.push(receiptModuleCommonRow(merged,"cierres",{categoryLabel:"Cierre semanal",title:merged.resultLabel,detail:`Semana ${receiptModulePeriod(merged) || "—"} · ${merged.resultLabel}`,amount:receiptModuleAmount(merged),state:receiptModuleState(merged)}));
      });
      const deduped = new Map();
      rows.forEach(row => {
        const key = receiptModuleKey(row.raw || row);
        const previous = deduped.get(key);
        if (!previous || (!previous.url && row.url)) deduped.set(key,row);
      });
      return [...deduped.values()].sort((a,b) => {
        const ad = receiptModuleDateObject((a.raw||{}).closedAt || (a.raw||{}).cerradoEn || (a.raw||{}).createdAt)?.getTime() || 0;
        const bd = receiptModuleDateObject((b.raw||{}).closedAt || (b.raw||{}).cerradoEn || (b.raw||{}).createdAt)?.getTime() || 0;
        return String(b.weeklyPeriodId||"").localeCompare(String(a.weeklyPeriodId||"")) || bd-ad;
      });
    }
    function receiptModuleText(row = {}) {
      return [row.category,row.type,row.receiptCategory,row.module,row.moduleKey,row.closureKind,row.closureType,row.payTab,row.kind,row.financialCategory,row.paymentMethod,row.metodoPago,row.receiptPaymentMethod,row.reason,row.sourceCollection].map(value => String(value || "").trim().toLowerCase()).join(" ");
    }
    function receiptModulePaymentMethod(row = {}) {
      const text = receiptModuleText(row);
      if (/cash|efectivo/.test(text)) return "cash";
      if (/qr/.test(text)) return "qr";
      if (/card|tarjeta|point/.test(text)) return "card";
      if (/transfer|alias|mercado\s*pago|digital/.test(text)) return "transfer";
      return "";
    }
    function receiptModuleIsCashbox(row = {}) {
      return /caja[_\s-]*chica|cashbox|petty|repair[_\s-]*fund/.test(receiptModuleText(row));
    }
    function receiptModuleIsExpense(row = {}) {
      return /(^|\s)(expense|gasto|gastos)(\s|$)/.test(receiptModuleText(row));
    }
    function receiptModuleIsDebt(row = {}) {
      return /driver[_\s-]*debt|(^|\s)(debt|deuda|multas?|choques?)(\s|$)/.test(receiptModuleText(row));
    }
    function receiptModuleIsBillingSettlementPayment(row = {}) {
      const type = String(row.type || row.operationType || row.movementType || "").trim().toLowerCase();
      const source = String(row.sourceModule || row.category || row.module || "").trim().toLowerCase();
      return row.affectsBillingSettlement === true || type === "admin_billing_settlement_payment" || (type === "driver_payment" && /factur|billing/.test(source));
    }
    function receiptModuleDedupeRows(rows = []) {
      const deduped = new Map();
      rows.forEach(row => {
        const raw = row.raw || row;
        const key = String(raw.recordId || raw.operationId || raw.closureId || raw.debtId || raw.id || receiptModuleKey(raw));
        const previous = deduped.get(key);
        if (!previous || (!previous.url && row.url)) deduped.set(key,row);
      });
      return [...deduped.values()].sort((a,b) => {
        const ad = receiptModuleDateObject((a.raw||{}).receiptUploadedAt || (a.raw||{}).createdAt || (a.raw||{}).updatedAt)?.getTime() || 0;
        const bd = receiptModuleDateObject((b.raw||{}).receiptUploadedAt || (b.raw||{}).createdAt || (b.raw||{}).updatedAt)?.getTime() || 0;
        return bd-ad;
      });
    }
    async function receiptModuleLoadSeparated(category) {
      const indexName = window.ExploraCanonicalWeeklyClosure?.receiptIndexCollectionName?.() || "receipt_index";
      if (category === "gastos") {
        const [allIndexes,expenses] = await Promise.all([
          receiptModuleReadMany([indexName,"receipt_index"], category),
          receiptModuleReadMany(["gastos"], category)
        ]);
        const indexed = allIndexes.filter(receiptModuleIsExpense);
        const indexedIds = new Set(indexed.map(row => String(row.recordId || row.relatedDocumentId || row.operationId || "")).filter(Boolean));
        const fallback = expenses.filter(row => !indexedIds.has(String(row.id || row.recordId || row.expenseId || row.gastoId || row.operationId || "")));
        return receiptModuleDedupeRows([...indexed,...fallback].map(row => receiptModuleCommonRow(row,category,{title:row.categoryLabel || row.tipoLabel || row.expenseType || "Gasto"})));
      }
      if (category === "deudas") {
        const indexed = (await receiptModuleReadMany([indexName,"receipt_index"], category)).filter(receiptModuleIsDebt);
        const source = indexed.length ? indexed : await receiptModuleReadMany(["deudas_choferes","deuda_pagos","deuda_movimientos"], category);
        return receiptModuleDedupeRows(source.map(row => receiptModuleCommonRow(row,category,{title:`Deuda: ${row.reasonLabel || row.reason || "Otro"}`})));
      }
      if (category === "explora") {
        const [indexes,billing] = await Promise.all([
          receiptModuleReadMany([indexName,"receipt_index"], category),
          receiptModuleReadMany(["billing_records"], category)
        ]);
        const digitalIndexes = indexes.filter(row => ["qr","card","transfer"].includes(receiptModulePaymentMethod(row)) && !receiptModuleIsExpense(row) && !receiptModuleIsDebt(row) && !receiptModuleIsCashbox(row));
        const indexedIds = new Set(digitalIndexes.map(row => String(row.recordId || row.operationId || "")).filter(Boolean));
        const digitalFallback = billing.filter(row => ["qr","card","transfer"].includes(receiptModulePaymentMethod(row)) && !indexedIds.has(String(row.id || row.recordId || row.operationId || "")));
        return receiptModuleDedupeRows([...digitalIndexes,...digitalFallback].map(row => receiptModuleCommonRow(row,category,{title:receiptModuleIsBillingSettlementPayment(row)?"Pago del chofer":"Pago digital",categoryLabel:"Explora"})));
      }
      if (category === "caja_chica" || category === "chofer") {
        const [indexes,billing,closures] = await Promise.all([
          receiptModuleReadMany([indexName,"receipt_index"], category),
          receiptModuleReadMany(["billing_records"], category),
          receiptModuleReadMany(["cierres_semanales","cierresSemanales","cierres","pagos_semanales"], category)
        ]);
        const cashbox = [...indexes,...closures].filter(receiptModuleIsCashbox);
        const cash = category === "chofer" ? billing.filter(row => receiptModulePaymentMethod(row) === "cash") : [];
        const cashRows = cash.map(row => receiptModuleCommonRow(row,category,{title:receiptModuleIsBillingSettlementPayment(row)?"Pago del chofer":"Cobro en efectivo",categoryLabel:"Chofer"}));
        const cashboxRows = cashbox.map(row => receiptModuleCommonRow(row,category,{title:"Caja Chica",categoryLabel:"Caja Chica"}));
        return receiptModuleDedupeRows(category === "chofer" ? [...cashRows,...cashboxRows] : cashboxRows);
      }
      return [];
    }
    window.ExploraReceiptsData = {
      async load(category) {
        return receiptModuleLoadSeparated(category);
      }
    };

    window.ExploraLoadReceiptsLegacy = async function(category) {
      if (!auth.currentUser) throw new Error("Sesión no iniciada.");
      if (category === "gastos") return await readCollectionSafe("gastos", "gastos");
      const rows = [
        ...(await readCollectionSafe("comprobantes", "pagos")),
        ...(await readCollectionSafe("pagos", "pagos")),
        ...(await readCollectionSafe("cierres", "pagos")),
        ...(await readCollectionSafe("cierresSemanales", "pagos"))
      ];
      return rows.filter(item => !String(item.tipo || item.categoria || item.clase || "").toLowerCase().includes("gasto"));
    };

    window.getExploreLoanSnapshot = getExploreLoanSnapshot;
    window.ExploraRequestLoan = requestExploreLoan;
    window.ExploraApproveLoan = approveExploreLoan;
    window.ExploraRejectLoan = rejectExploreLoan;
    window.ExploraListPendingLoans = listPendingExploreLoans;
    window.ExploraApplyLoanClosurePayment = applyExploreLoanClosurePayment;
    window.ExploraLoanLookbackForPeriod = exploreLoanLookbackForPeriod;
    window.ExploraActions = window.ExploraActions || {};
    window.ExploraActions["prestamo-explora"] = () => window.dispatchEvent(new CustomEvent("explora:open-loan"));

    // Logout extra por botones / data-action ya existentes
    document.addEventListener("click", (event) => {
      const actionEl = event.target.closest && event.target.closest('[data-action="salir"]');
      if (actionEl) {
        event.preventDefault();
        logoutExplora();
      }
    }, true);

    // Registrar rutas internas seguras
    const originalSetActive = window.ExploraMainNav && window.ExploraMainNav.setActive;
    if (window.ExploraMainNav && typeof originalSetActive === "function") {
      window.ExploraMainNav.setActive = function(section) {
        originalSetActive(section);
        const map = { inicio: "dashboard", operaciones: "operaciones", finanzas: "cargar-gasto", comprobantes: "comprobantes", perfil: "perfil" };
        if (map[section]) saveLastScreen(map[section]);
      };
    }

    // Si hay cache visual, cargar skeleton sin autenticar.
    try {
      const cached = JSON.parse(localStorage.getItem(EXPLORA_SESSION_PREFIX + "last") || "{}");
      if (cached && cached.name && $("dashboardProfileName")) {
        $("dashboardProfileName").textContent = "Cargando perfil…";
      }
    } catch (_) {}
  
