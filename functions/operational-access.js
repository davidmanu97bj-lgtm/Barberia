'use strict';
// Only trusted Firebase Auth / Firestore membership decides operational access.
// No role from request.data, no public signup fallback, no account/profile writes.
const ADMIN_ROLES = new Set(['admin','administrador','owner','propietario','superadmin']);
const MEMBER_ROLES = new Set(['driver','chofer']);
const PROFILE_COLLECTIONS = ['usuarios','choferes','drivers'];
const ADMIN_COLLECTIONS = ['administradores','admins'];
const ID_FIELDS = ['authUid','firebaseUid','uid','driverUid','choferUid','userUid','driverId','choferId'];
const MAX_MATCHES = 20;
const normalized = value => String(value ?? '').trim().toLowerCase();
const identifier = value => typeof value === 'string' ? value.trim() : '';
function isInactive(data = {}) {
  const off = value => value === false || value === 0 || ['false','0','no'].includes(normalized(value));
  const on = value => value === true || value === 1 || ['true','1','si','sí'].includes(normalized(value));
  return ['active','activo','enabled','habilitado'].some(k => Object.hasOwn(data,k) && off(data[k])) ||
    ['disabled','deleted','isDeleted','eliminado','blocked','bloqueado'].some(k => on(data[k])) ||
    ['status','estado'].some(k => /^(?:inactiv|disabled|deshabil|eliminad|deleted|bloquead|blocked|suspend)/.test(normalized(data[k])) || ['baja','de baja','de_baja','dado de baja'].includes(normalized(data[k])));
}
function boundUid(data = {}) {
  // authUid/firebaseUid are authoritative; driverId may be a legacy document id.
  return ID_FIELDS.map(k => identifier(data[k])).find(Boolean) || '';
}
function belongs(snapshot, uid) {
  const binding = boundUid(snapshot.data() || {});
  return binding ? binding === uid : snapshot.id === uid;
}
function createOperationalAccess({db,auth,HttpsError}) {
  if (!db || !auth || typeof auth.getUser !== 'function' || typeof HttpsError !== 'function') {
    throw new Error('Faltan dependencias para verificar los permisos operativos.');
  }
  const contexts = new WeakMap();
  function deny(code,message,reason) { throw new HttpsError(code,message,{reason}); }
  async function resolve(request) {
    const uid = identifier(request.auth?.uid);
    if (!uid || uid.includes('/') || uid.length > 128) deny('unauthenticated','Iniciá sesión para registrar movimientos.','explora_session_required');
    if (request.auth?.token?.firebase?.sign_in_provider === 'anonymous') {
      deny('permission-denied','Iniciá sesión con una cuenta de Explora.','explora_profile_missing');
    }
    let user;
    try { user = await auth.getUser(uid); }
    catch (error) {
      if (error.code === 'auth/user-not-found') deny('unauthenticated','La cuenta ya no está disponible.','explora_session_required');
      deny('unavailable','El servidor no pudo verificar la cuenta. No cambies los permisos del chofer.','explora_auth_lookup_failed');
    }
    if (user.uid !== uid) deny('unauthenticated','La identidad de la sesión no coincide.','explora_session_required');
    if (user.disabled === true) deny('permission-denied','La cuenta está deshabilitada en Explora.','explora_account_inactive');
    const validAfter = Date.parse(user.tokensValidAfterTime || '');
    const authTime = Number(request.auth?.token?.auth_time);
    if (Number.isFinite(validAfter) && Number.isFinite(authTime) && authTime * 1000 < validAfter) {
      deny('unauthenticated','La sesión fue revocada. Volvé a iniciar sesión.','explora_session_revoked');
    }
    const claims = user.customClaims || {};
    const claimAdmin = claims.admin === true || [claims.role,claims.rol].some(r => ADMIN_ROLES.has(normalized(r)));
    const claimDriver = [claims.role,claims.rol].some(r => MEMBER_ROLES.has(normalized(r)));
    const profiles = [], adminProfiles = [];
    try {
      const direct = await Promise.all([...PROFILE_COLLECTIONS,...ADMIN_COLLECTIONS].map(async collection => ({
        collection, snap:await db.collection(collection).doc(uid).get()
      })));
      for (const item of direct) {
        if (!item.snap.exists) continue;
        if (!belongs(item.snap,uid)) deny('permission-denied','El perfil no coincide con la cuenta. El administrador debe revisar su vínculo.','explora_profile_conflict');
        (ADMIN_COLLECTIONS.includes(item.collection) ? adminProfiles : profiles).push(item);
      }
      // Keep canonical uid documents fast. Legacy profiles can be keyed by an alias,
      // but are accepted ONLY via a stored uid field, never by name or unverified email.
      for (const collection of PROFILE_COLLECTIONS) {
        if (direct.some(item => item.collection === collection && item.snap.exists)) continue;
        const found = new Map();
        for (const field of ID_FIELDS) {
          const result = await db.collection(collection).where(field,'==',uid).limit(MAX_MATCHES+1).get();
          if (result.docs.length > MAX_MATCHES) deny('failed-precondition','Hay demasiados perfiles vinculados a esta cuenta.','explora_profile_conflict');
          for (const snap of result.docs) {
            if (belongs(snap,uid)) found.set(snap.id,snap);
          }
        }
        for (const snap of found.values()) profiles.push({collection,snap});
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      deny('unavailable','No se pudieron consultar los perfiles de Explora. Reintentá; no es una baja del chofer.','explora_profile_lookup_failed');
    }
    // Disabling a linked profile always wins over stale claims or another active copy.
    if ([...profiles,...adminProfiles].some(item => isInactive(item.snap.data() || {}))) {
      deny('permission-denied','La cuenta figura deshabilitada en Explora.','explora_account_inactive');
    }
    const profileAdmin = adminProfiles.length > 0 || profiles.some(({snap}) => {
      const p=snap.data() || {};
      return p.admin === true || p.isAdmin === true || [p.role,p.rol].some(r => ADMIN_ROLES.has(normalized(r)));
    });
    const isAdmin = claimAdmin || profileAdmin;
    const member = profiles.some(({collection,snap}) => {
      const p=snap.data() || {}, roles=[p.role,p.rol].map(normalized).filter(Boolean);
      // An admin-created usuarios record is an existing app membership, not a public Auth signup.
      return roles.some(r => MEMBER_ROLES.has(r) || ADMIN_ROLES.has(r)) ||
        (roles.length === 0 && PROFILE_COLLECTIONS.includes(collection));
    });
    if (!isAdmin && !claimDriver && !member) {
      deny('permission-denied','La cuenta no está vinculada a un perfil de Explora. El administrador debe asociarla.','explora_profile_missing');
    }
    const profile = profiles.find(p=>p.collection==='usuarios')?.snap || profiles[0]?.snap || adminProfiles[0]?.snap ||
      {id:uid,exists:true,data:()=>({displayName:user.displayName||'Chofer'})};
    return {uid,isAdmin,profile};
  }
  function context(request) {
    if (!request || typeof request !== 'object') return Promise.reject(new HttpsError('unauthenticated','Iniciá sesión.'));
    if (!contexts.has(request)) contexts.set(request,resolve(request));
    return contexts.get(request);
  }
  return {
    resolve:context,
    assertViewer:async request => (await context(request)).uid,
    assertAdmin:async request => {
      const account=await context(request);
      if (!account.isAdmin) deny('permission-denied','No podés acceder al comprobante de otra cuenta.','explora_other_owner');
      return account.uid;
    },
    getProfile:async (uid,request) => {
      const account=await context(request);
      if(account.uid!==uid) deny('permission-denied','El perfil no corresponde a tu cuenta.','explora_other_owner');
      return account.profile;
    }
  };
}
module.exports = {createOperationalAccess,isInactive,boundUid,belongs};
