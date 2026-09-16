export const FINAL_STATES = new Set([
  "finalized","finalized_review_required","late_start_pending_review","completed","reviewed","closed"
]);
export const FINAL_ALERT_STATES = new Set(["reviewed","resolved","closed","dismissed","archived"]);

const clean = value => String(value ?? "").trim();
const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function mileageDomainError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// Conservado únicamente para identificar documentos legacy de V13.
export function stableHash(text = "") {
  let hash = 2166136261;
  for (const ch of String(text)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function sha256HexText(text = "") {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder === "undefined") {
    throw mileageDomainError("MILEAGE_CRYPTO_UNAVAILABLE", "El navegador no dispone de criptografía segura para registrar el kilometraje.");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export function normalizeJustification(value = "") {
  return clean(value).replace(/\s+/g, " ").toLowerCase();
}

export async function buildOperationFingerprint(input = {}) {
  const canonical = [
    clean(input.driverUid), clean(input.weeklyPeriodId), clean(input.mileageRecordId),
    clean(input.operationType), number(input.expectedRevision), clean(input.vehicleId),
    number(input.km), clean(input.photoHash), normalizeJustification(input.justification),
    clean(input.expectedStatus)
  ].join("|");
  return `sha256_${await sha256HexText(canonical)}`;
}

export async function buildOperationId(input = {}) {
  const canonical = [clean(input.driverUid),clean(input.weeklyPeriodId),clean(input.mileageRecordId),clean(input.operationType),clean(input.operationFingerprint)].join("|");
  return `op_${(await sha256HexText(canonical)).slice(0,48)}`;
}

// Se conserva estable para no duplicar alertas ya creadas en V13.
export function buildAlertId(uid, periodId, mileageRecordId, kind, eventVersion = "1") {
  const base = [clean(uid), clean(periodId), clean(mileageRecordId), clean(kind), clean(eventVersion)].join("|");
  return `${clean(mileageRecordId)}_${stableHash(base)}`;
}

export async function buildIncidentKey(input = {}) {
  const canonical = [clean(input.driverUid), clean(input.weeklyPeriodId), clean(input.mileageRecordId), clean(input.incidentType), clean(input.operationFingerprint || "legacy")].join("|");
  return `incident_${await sha256HexText(canonical)}`;
}

export function buildOutboxEntry({ alertId, incidentType, incidentKey = "", operationFingerprint = "", payload = {} } = {}) {
  return { alertId: clean(alertId), incidentType: clean(incidentType), incidentKey: clean(incidentKey), operationFingerprint: clean(operationFingerprint), status: "pending", attempts: 0, payload };
}

export function validateIdentity(existing = {}, expected = {}) {
  if (clean(existing.driverUid) && clean(existing.driverUid) !== clean(expected.driverUid)) {
    throw mileageDomainError("MILEAGE_RECORD_OWNER_MISMATCH", "El registro pertenece a otro chofer.");
  }
  if (clean(existing.weeklyPeriodId) && clean(existing.weeklyPeriodId) !== clean(expected.weeklyPeriodId)) {
    throw mileageDomainError("MILEAGE_RECORD_PERIOD_MISMATCH", "El registro pertenece a otra semana.");
  }
}

function assertRevision(existing, expectedRevision) {
  const currentRevision = number(existing?.revision);
  if (currentRevision !== number(expectedRevision)) {
    throw mileageDomainError("MILEAGE_CONFLICT", "El control cambió en otro dispositivo.", { currentRevision, expectedRevision });
  }
  return currentRevision;
}

export function buildStartMutation(existing, payload, { late = false, expectedRevision = 0 } = {}) {
  const exists = Boolean(existing);
  const data = existing || {};
  if (exists) {
    validateIdentity(data, payload);
    if (FINAL_STATES.has(clean(data.status))) {
      if (clean(data.startOperationFingerprint) && clean(data.startOperationFingerprint) === clean(payload.operationFingerprint)) {
        return { idempotent: true, revision: number(data.revision), mutation: null };
      }
      throw mileageDomainError("MILEAGE_RECORD_FINALIZED", "Este control ya fue finalizado y no puede reiniciarse.");
    }
    const currentRevision = assertRevision(data, expectedRevision);
    if (number(data.startKm) > 0) {
      if (clean(data.startOperationFingerprint) === clean(payload.operationFingerprint)) {
        return { idempotent: true, revision: currentRevision, mutation: null };
      }
      throw mileageDomainError("MILEAGE_ALREADY_STARTED", "El kilometraje inicial ya fue registrado.");
    }
  } else if (number(expectedRevision) !== 0) {
    throw mileageDomainError("MILEAGE_CONFLICT", "El estado local está desactualizado.");
  }
  const revision = number(data.revision) + 1;
  return {
    idempotent: false,
    revision,
    mutation: {
      ...payload,
      fingerprintAlgorithm: "sha256",
      startOperationId: payload.operationId,
      startOperationFingerprint: payload.operationFingerprint,
      status: late ? "late_start_pending_review" : "tracking",
      lateStartAtClosure: Boolean(late),
      adminReviewRequired: Boolean(late),
      reviewedByAdmin: false,
      operationState: late ? "outbox_pending" : "completed",
      revision
    }
  };
}

export function buildFinalizeMutation(existing, payload, { expectedRevision, allowedStatuses = ["tracking"] } = {}) {
  if (!existing) throw mileageDomainError("MILEAGE_RECORD_MISSING", "No existe un kilometraje inicial verificable.");
  validateIdentity(existing, payload);
  const currentRevision = number(existing.revision);
  if (FINAL_STATES.has(clean(existing.status))) {
    if (clean(existing.endOperationFingerprint) && clean(existing.endOperationFingerprint) === clean(payload.operationFingerprint)) {
      return { idempotent: true, revision: currentRevision, mutation: null };
    }
    throw mileageDomainError("MILEAGE_RECORD_FINALIZED", "Este control ya fue finalizado con otra operación.");
  }
  if (!allowedStatuses.includes(clean(existing.status))) {
    throw mileageDomainError("MILEAGE_INVALID_STATE", `El estado actual (${clean(existing.status) || "sin estado"}) no permite cerrar.`);
  }
  assertRevision(existing, expectedRevision);
  if (number(existing.startKm) <= 0) throw mileageDomainError("MILEAGE_START_MISSING", "Falta el kilometraje inicial verificado.");
  const revision = currentRevision + 1;
  return {
    idempotent: false,
    revision,
    mutation: {
      ...payload,
      fingerprintAlgorithm: "sha256",
      endOperationId: payload.operationId,
      endOperationFingerprint: payload.operationFingerprint,
      revision,
      operationState: payload.alertOutbox && Object.keys(payload.alertOutbox).length ? "outbox_pending" : "completed"
    }
  };
}

export function classifyOperationCommit(record, operation = {}) {
  if (!record) return { status: "rejected", reason: "record-missing" };
  const kind = clean(operation.kind);
  const isStart = kind === "start" || kind === "late_start";
  const fingerprint = clean(isStart ? record.startOperationFingerprint : record.endOperationFingerprint);
  const path = clean(isStart ? record.startPhotoPath : record.endPhotoPath);
  if (fingerprint && fingerprint === clean(operation.operationFingerprint) && path === clean(operation.photoPath || operation.path)) {
    return { status: "confirmed", reason: "fingerprint-and-path-match" };
  }
  if (FINAL_STATES.has(clean(record.status)) || fingerprint) {
    return { status: "conflicting", reason: "different-operation-confirmed" };
  }
  return { status: "rejected", reason: "operation-not-referenced" };
}

export function nextOutboxDeliveryState({ alert = null, outboxItem = {}, now = null } = {}) {
  const status = clean(alert?.status);
  if (FINAL_ALERT_STATES.has(status)) {
    return {
      action: "already_resolved",
      alertMutation: null,
      outboxMutation: { ...outboxItem, status: "already_resolved", resolvedStatus: status, attempts: number(outboxItem.attempts) + 1, lastAttemptAt: now }
    };
  }
  return {
    action: "deliver",
    alertMutation: {
      ...(outboxItem.payload || {}),
      alertId: clean(outboxItem.alertId),
      incidentType: clean(outboxItem.incidentType),
      incidentKey: clean(outboxItem.incidentKey),
      operationFingerprint: clean(outboxItem.operationFingerprint),
      status: "pending_admin_review",
      outboxStatus: "delivered",
      alertRevision: number(alert?.alertRevision) + 1
    },
    outboxMutation: { ...outboxItem, status: "delivered", attempts: number(outboxItem.attempts) + 1, deliveredAt: now }
  };
}

export function pendingReviewRequired(alerts = [], outbox = {}) {
  const alertPending = alerts.some(alert => !FINAL_ALERT_STATES.has(clean(alert?.status)));
  const outboxPending = Object.values(outbox || {}).some(item => !["delivered","reviewed","cancelled","already_resolved","resolved"].includes(clean(item?.status)));
  return alertPending || outboxPending;
}
