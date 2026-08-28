export const SETTLEMENT_EPSILON = 0.5;

export const SERVICES = Object.freeze([
  { id: "clasico", name: "Clásico", price: 10000 },
  { id: "sombreado", name: "Sombreado", price: 12000 },
  { id: "corte_barba", name: "Corte + barba", price: 15000 },
  { id: "solo_barba", name: "Solo barba", price: 5000 }
]);

export function numberFromMoney(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const compact = String(value ?? "").replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (!compact || compact === "-" || compact === "," || compact === ".") return 0;

  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  let normalized = compact;
  if (comma >= 0 && dot >= 0) {
    normalized = comma > dot
      ? compact.replace(/\./g, "").replace(/,/g, ".")
      : compact.replace(/,/g, "");
  } else if (comma >= 0) {
    const decimals = compact.length - comma - 1;
    normalized = decimals === 3 ? compact.replace(/,/g, "") : compact.replace(/,/g, ".");
  } else if (dot >= 0) {
    const decimals = compact.length - dot - 1;
    normalized = decimals === 3 ? compact.replace(/\./g, "") : compact;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatMoney(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

export function normalizedBalance(value) {
  const amount = Number(value || 0);
  return Math.abs(amount) > SETTLEMENT_EPSILON ? amount : 0;
}

export function calculateSettlement({ cashTotal = 0, digitalTotal = 0 } = {}) {
  const cash = Math.max(0, Number(cashTotal || 0));
  const digital = Math.max(0, Number(digitalTotal || 0));
  const cashAdvertising = cash * 0.10;
  const digitalAdvertising = digital * 0.10;
  const cashShare = cash * 0.45;
  const digitalShare = digital * 0.45;
  // El barbero conserva el efectivo: de ahí debe entregar el 45 % de la
  // barbería más el 10 % de publicidad. Ese fondo se documenta en dos aportes
  // del 5 %. En digital, la barbería conserva el cobro y entrega 45 % al barbero.
  const cashDueToBusiness = cashShare + cashAdvertising;
  const digitalDueToBarber = digitalShare;
  const balance = normalizedBalance(cashDueToBusiness - digitalDueToBarber);

  return {
    cash,
    digital,
    total: cash + digital,
    cashShare,
    digitalShare,
    cashAdvertising,
    digitalAdvertising,
    advertisingFund: cashAdvertising + digitalAdvertising,
    advertisingCashReceipt: (cash + digital) * 0.05,
    advertisingDigitalReceipt: (cash + digital) * 0.05,
    cashDueToBusiness,
    digitalDueToBarber,
    barberShare: cashShare + digitalShare,
    businessShare: cashShare + digitalShare,
    balance,
    amount: Math.abs(balance),
    direction: balance > 0
      ? "barber_pays_business"
      : balance < 0
        ? "business_pays_barber"
        : "balanced"
  };
}

export function timestampMs(record = {}) {
  for (const candidate of [record.createdAt, record.requestedAt, record.completedAt, record.updatedAt]) {
    if (!candidate) continue;
    if (typeof candidate.toMillis === "function") return candidate.toMillis();
    if (typeof candidate.toDate === "function") return candidate.toDate().getTime();
    if (candidate instanceof Date) return candidate.getTime();
  }
  for (const candidate of [record.createdAtMs, record.requestedAtMs, record.cutoffAtMs, record.completedAtMs, record.updatedAtMs]) {
    const parsed = Number(candidate || 0);
    if (parsed > 0) return parsed;
  }
  return 0;
}

export function closureCutoffMs(closure = {}) {
  const cutoff = Number(closure.cutoffAtMs || closure.requestedAtMs || closure.createdAtMs || 0);
  return cutoff > 0 ? cutoff : timestampMs(closure);
}

export function latestClosureCutoff(closures = []) {
  return closures
    .filter(item => item && item.deleted !== true && item.cutoffActive !== false)
    .map(closureCutoffMs)
    .filter(value => value > 0)
    .sort((a, b) => b - a)[0] || 0;
}

export function openCharges(charges = [], closures = []) {
  const cutoff = latestClosureCutoff(closures);
  return charges
    .filter(item => item && item.deleted !== true && item.voided !== true)
    .filter(item => timestampMs(item) > cutoff)
    .sort((a, b) => timestampMs(b) - timestampMs(a));
}

export function modelForPeriod(charges = [], closures = []) {
  const currentCharges = openCharges(charges, closures);
  const cashTotal = currentCharges
    .filter(item => item.method === "cash")
    .reduce((total, item) => total + Math.max(0, Number(item.amount || 0)), 0);
  const digitalTotal = currentCharges
    .filter(item => item.method === "digital")
    .reduce((total, item) => total + Math.max(0, Number(item.amount || 0)), 0);
  return {
    ...calculateSettlement({ cashTotal, digitalTotal }),
    charges: currentCharges,
    cutoffAtMs: latestClosureCutoff(closures)
  };
}

export function impactForCharge(method, amount) {
  const gross = Math.max(0, Number(amount || 0));
  return method === "cash" ? gross * 0.55 : -(gross * 0.45);
}

export function settlementLabel(balance, barberName = "El barbero", businessName = "la barbería") {
  const normalized = normalizedBalance(balance);
  if (normalized > 0) return `${barberName} debe pagar a ${businessName}`;
  if (normalized < 0) return `${businessName} debe pagar a ${barberName}`;
  return "Cuentas equilibradas";
}

export function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[character]));
}
