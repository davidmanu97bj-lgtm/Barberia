import { doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const F = window.ExploraFirebase || {};
const db = F.db || null;
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>'"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[c]));
const money = (v) => new Intl.NumberFormat("es-AR", { style:"currency", currency:"ARS", maximumFractionDigits:0 }).format(Number(v) || 0).replace(/\s/g, "");

const state = { rows: [] };

function normalizedId(row = {}) {
  return String(row.__photoKey || row.photoKey || row.id || row.debtId || row.paymentId || row.closureId || row.documentId || row.uid || "").trim();
}

function rowMatchesViewerId(row = {}, wanted = "") {
  const id = String(wanted || "").trim();
  if (!id) return false;
  if (normalizedId(row) === id) return true;
  return String(row.id || row.debtId || row.paymentId || row.closureId || row.documentId || row.uid || "").trim() === id;
}

function findDebtById(id) {
  const wanted = String(id || "").trim();
  return state.rows.find((row) => rowMatchesViewerId(row, wanted))
    || window.ExploraActivityPhotoRows?.find?.((row) => rowMatchesViewerId(row, wanted))
    || window.ExploraPendingDebtRows?.find?.((row) => rowMatchesViewerId(row, wanted))
    || window.ExploraDriverIncidents?.getState?.().rows?.find?.((row) => rowMatchesViewerId(row, wanted))
    || window.ExploraDriverIncidents?.getState?.().summary?.normalized?.find?.((row) => rowMatchesViewerId(row, wanted))
    || null;
}

function firstAttachment(row = {}) {
  const directFields = [
    "receiptUrl", "comprobanteUrl", "attachmentUrl", "fileUrl", "downloadUrl", "url",
    "photoUrl", "fotoUrl", "imageUrl", "voucherUrl", "proofUrl", "proofImageUrl",
    "receiptDownloadUrl", "comprobanteDownloadUrl", "comprobantePagoUrl", "comprobanteTransferenciaUrl",
    "driverReceiptUrl", "adminReceiptUrl", "davidReceiptUrl"
  ];
  const directField = directFields.find((field) => row[field]);
  const direct = directField ? row[directField] : null;
  if (direct) {
    return {
      url: String(direct),
      name: String(row.receiptName || row.fileName || row.attachmentName || row.comprobanteName || row.photoName || "Comprobante"),
      mime: String(row.receiptMime || row.mimeType || row.contentType || row.fileType || "")
    };
  }

  const objects = [row.receipt, row.comprobante, row.attachment, row.file, row.photo, row.foto, row.image, row.proof].filter((item) => item && typeof item === "object");
  for (const item of objects) {
    const url = item.url || item.receiptUrl || item.downloadUrl || item.fileUrl || item.photoUrl || item.imageUrl || item.comprobanteUrl;
    if (url) {
      return {
        url: String(url),
        name: String(item.name || item.fileName || item.originalName || item.title || row.receiptName || "Comprobante"),
        mime: String(item.mime || item.mimeType || item.contentType || row.receiptMime || "")
      };
    }
  }

  const arrays = [row.attachments, row.files, row.receipts, row.comprobantes, row.photos, row.fotos, row.images, row.evidences].filter(Array.isArray);
  for (const arr of arrays) {
    const item = arr.find((entry) => entry && (entry.url || entry.receiptUrl || entry.downloadUrl || entry.fileUrl || entry.photoUrl || entry.imageUrl || entry.comprobanteUrl));
    if (item) {
      return {
        url: String(item.url || item.receiptUrl || item.downloadUrl || item.fileUrl || item.photoUrl || item.imageUrl || item.comprobanteUrl),
        name: String(item.name || item.fileName || item.originalName || item.title || row.receiptName || "Comprobante"),
        mime: String(item.mime || item.mimeType || item.contentType || row.receiptMime || "")
      };
    }
  }

  return null;
}

function isImageAttachment(attachment = {}) {
  const mime = String(attachment.mime || "").toLowerCase();
  const url = String(attachment.url || "").toLowerCase().split("?")[0];
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(url);
}

function compactDate(row = {}) {
  const raw = row.createdAt?.toDate?.() || row.createdAtMs || row.createdAt || row.updatedAt?.toDate?.() || Date.now();
  const date = raw instanceof Date ? raw : new Date(Number(raw) || raw || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-AR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
}

function render(rows = []) {
  const box = $("debtNotificationStack");

  // La campana de Pendientes + la fila normal en Última actividad son el aviso principal.
  // No mostramos el cartel extra "Pendiente registrado" para evitar duplicar información.
  // Conservamos state.rows para que el botón pequeño "ver foto" de Última actividad
  // pueda abrir el comprobante con el mismo modal blanco moderno.
  state.rows = Array.isArray(rows) ? rows : [];

  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
}

function ensurePhotoModal() {
  let modal = $("debtPhotoModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "debtPhotoModal";
  modal.className = "debt-photo-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="debt-photo-backdrop" data-debt-photo-close></div>
    <section class="debt-photo-sheet" role="dialog" aria-modal="true" aria-labelledby="debtPhotoTitle">
      <header class="debt-photo-header">
        <div>
          <span>Comprobante</span>
          <strong id="debtPhotoTitle">Foto del pendiente</strong>
          <small id="debtPhotoMeta"></small>
        </div>
        <button type="button" class="debt-photo-close" data-debt-photo-close aria-label="Cerrar comprobante">×</button>
      </header>
      <div class="debt-photo-body" id="debtPhotoBody"></div>
      <footer class="debt-photo-footer">
        <a class="debt-photo-open" id="debtPhotoOpen" href="#" target="_blank" rel="noopener">Abrir completo</a>
        <button type="button" data-debt-photo-close>Cerrar</button>
      </footer>
    </section>`;
  document.body.appendChild(modal);
  return modal;
}

function openPhotoModal(row) {
  const attachment = firstAttachment(row);
  if (!attachment?.url) return;

  const modal = ensurePhotoModal();
  const title = $("debtPhotoTitle");
  const meta = $("debtPhotoMeta");
  const body = $("debtPhotoBody");
  const open = $("debtPhotoOpen");
  const label = row.photoTitle || row.reasonLabel || row.reason || row.type || "Comprobante";
  const amount = Number(row.photoAmount ?? row.totalAmount ?? row.amount ?? row.remainingAmount ?? row.saldoPendiente ?? 0);

  if (title) title.textContent = amount > 0 && !/\$/.test(String(label)) ? `${label} · ${money(amount)}` : String(label);
  if (meta) meta.textContent = row.photoMeta || attachment.name || "Comprobante cargado";
  if (open) open.href = attachment.url;
  if (body) {
    body.innerHTML = isImageAttachment(attachment)
      ? `<img src="${esc(attachment.url)}" alt="Comprobante de pendiente">`
      : `<div class="debt-photo-file"><strong>Archivo disponible</strong><span>${esc(attachment.name || "Comprobante")}</span><a href="${esc(attachment.url)}" target="_blank" rel="noopener">Abrir archivo</a></div>`;
  }

  modal.hidden = false;
  document.documentElement.classList.add("debt-photo-modal-open");
}

function closePhotoModal() {
  const modal = $("debtPhotoModal");
  if (!modal) return;
  modal.hidden = true;
  document.documentElement.classList.remove("debt-photo-modal-open");
}

window.addEventListener("explora:driver-debts-updated", (event) => render(event.detail?.rows || []));
window.addEventListener("explora:auth-cleared", () => render([]));

document.addEventListener("click", async (event) => {
  const closePhoto = event.target.closest?.("[data-debt-photo-close]");
  if (closePhoto) {
    closePhotoModal();
    return;
  }

  const attachment = event.target.closest?.("[data-notification-attachment]");
  if (attachment) {
    event.preventDefault();
    const debt = findDebtById(attachment.dataset.notificationAttachment);
    if (debt) openPhotoModal(debt);
    return;
  }

  const button = event.target.closest?.("[data-ack-debt]");
  if (!button) return;
  const id = button.dataset.ackDebt;
  if (!id) return;
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = "Cerrando…";
  try {
    if (!db) throw new Error("Firestore no está disponible.");
    await updateDoc(doc(db, "deudas_choferes", id), {
      acknowledgedByDriver: true,
      acknowledgedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    console.error("DEBT_ACK_FAILED", error);
    button.disabled = false;
    button.textContent = previousText || "Cerrar";
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePhotoModal();
});
