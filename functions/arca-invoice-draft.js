"use strict";

// Preparation only. No ARCA authorization, tax exemption or CAE is inferred here.
function prepareInvoiceDraft(payment, paymentId, issuer = {}) {
  const request = payment.invoiceRequest;
  if (!request || request.version !== "arca_preparation_v1") return null;
  const amount = Number(payment.amount);
  const distance = Number(request.distanceKm);
  const text = (value, max = 160) => String(value || "").trim().slice(0,max);
  const origin = text(request.origin), destination = text(request.destination);
  const date = text(request.serviceDate,10);
  const customer = request.customer || {};
  const missing = [];
  const regime = issuer.regime || "monotributo";
  const nationalMonotributo = regime === "monotributo" && request.scope === "national";
  if (!["monotributo", "general"].includes(regime)) missing.push("issuerRegime");
  if (customer.requested === true && (!text(customer.name) || !text(customer.documentNumber))) missing.push("customerReview");
  if (!Number.isFinite(amount) || amount <= 0) missing.push("amount");
  if (!origin || !destination) missing.push("route");
  if (!Number.isFinite(distance) || distance <= 0 || distance > 20000) missing.push("distanceKm");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) missing.push("serviceDate");
  if (!["national","international"].includes(request.scope)) missing.push("scope");
  const cuit = text(issuer.cuit,13).replace(/\D/g,"");
  if (!/^\d{11}$/.test(cuit)) missing.push("issuerCuit");
  if (!text(issuer.legalName)) missing.push("issuerLegalName");
  if (!issuer.pointOfSale) missing.push("pointOfSale");
  return {
    version:"arca_preparation_v1", paymentId, driverUid:text(payment.driverUid),
    status:"preparation", fiscalValidity:false, emissionEnabled:false,
    targetRegime:regime, vatTreatment:nationalMonotributo ? "monotributo_no_vat_breakdown" : "pending_review", voucherType:nationalMonotributo ? 11 : null,
    issuer:{cuit:/^\d{11}$/.test(cuit) ? cuit : null, legalName:text(issuer.legalName) || null, pointOfSale:issuer.pointOfSale || null, registrationVerified:false},
    total:Number.isFinite(amount) ? amount : 0, currency:"ARS",
    paymentMethod:payment.method, paymentChannel:text(request.paymentChannel,20),
    service:{date,origin,destination,distanceKm:Number.isFinite(distance) ? distance : null,scope:text(request.scope,20)},
    description:`Traslado de pasajeros con chofer. ${date}. Origen: ${origin}. Destino: ${destination}. Recorrido informado: ${Number.isFinite(distance) ? distance : "pendiente"} km.`,
    customer:{requested:customer.requested === true,name:text(customer.name),documentType:text(customer.documentType,20),documentNumber:text(customer.documentNumber,30),vatCondition:text(customer.vatCondition,30)},
    reviewReason:request.scope === "international" ? "international_transport" : distance <= 100 ? "national_taxi_eligibility" : "national_over_100km",
    blockers:[...missing,"issuer_registration_unverified","tax_treatment_unverified","receiver_requirements_unverified","arca_connection_not_configured"],
    // This identifier must be reused by a future issuer to reconcile uncertain responses.
    idempotencyKey:`billing:${paymentId}`
  };
}

module.exports = { prepareInvoiceDraft };
