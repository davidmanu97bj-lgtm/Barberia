"use strict";
const {randomUUID} = require('node:crypto');
const {richMessage,invoiceFilename} = require('./telegram-compact');

// Both the collection event and ARCA authorization event use the same lease and
// message. Authorization upgrades that message; it never generates another invoice.
async function deliverTripNotification({db,ref,paymentId,caption,photo,chatId,api,invoicePdf,now=Date.now}) {
  const owner = randomUUID();
  const previous = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref), row = snapshot.data() || {};
    if (row.invoiceAttached === true || (row.status === 'sent' && row.layoutVersion !== 1)) return null;
    const leaseUntil = row.layoutVersion === 1 ? row.leaseUntil : Number(row.updatedAtMs || 0)+600000;
    if (row.status === 'processing' && leaseUntil > now()) throw new Error('TELEGRAM_NOTIFICATION_BUSY');
    tx.set(ref,{layoutVersion:1,status:'processing',owner,leaseUntil:now()+180000,updatedAtMs:now(),sourceCollection:'billing_records',sourceDocumentId:paymentId},{merge:true});
    return row;
  });
  if (!previous) return {skipped:true};
  let messageId = previous.telegramMessageId || null;
  const targetChat = previous.telegramChatId || chatId;
  const stableCaption = String(previous.caption || caption).replace(/^Total con caja:[^\r\n]*(?:\r?\n)?/gmi,'').trim();
  const stablePhoto = previous.photoUrl || photo || '';
  const save = values => db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (current?.owner !== owner) throw new Error('TELEGRAM_LEASE_LOST');
    tx.set(ref,{...values,updatedAtMs:now()},{merge:true});
  });
  try {
    const invoice = (await db.collection('arca_invoices').doc(paymentId).get()).data();
    const authorized = invoice?.status === 'authorized' && invoice.environment === 'production';
    const invoiceState = authorized ? 'authorized' : invoice?.status || 'queued';
    if (messageId && previous.invoiceState === invoiceState && !authorized) {
      await save({status:'sent',leaseUntil:0});
      return {skipped:true,messageId};
    }
    const notice = authorized ? '' : ['review','rejected','disabled'].includes(invoiceState)
      ? '\n\n⚠️ Factura pendiente de revisión en Explora.' : '\n\n🧾 Factura ARCA pendiente.';
    let bytes = null, pdfError = null;
    if (authorized) {
      try { bytes = await invoicePdf(invoice); }
      catch(error) { pdfError = error; }
    }
    const text = stableCaption + (pdfError ? '\n\n🧾 Factura autorizada. Preparando PDF.' : notice);
    async function send(includePhoto) {
      const rich = richMessage(text,{photo:includePhoto ? stablePhoto : '',document:bytes ? 'attach://invoice' : ''});
      const payload = {chat_id:targetChat,rich_message:rich,...(messageId ? {message_id:messageId} : {})};
      const method = messageId ? 'editMessageText' : 'sendRichMessage';
      if (!bytes) return api(method,payload);
      const form = new FormData();
      form.append('chat_id',String(targetChat));
      if (messageId) form.append('message_id',String(messageId));
      form.append('rich_message',JSON.stringify(rich));
      form.append('invoice',new Blob([bytes],{type:'application/pdf'}),invoiceFilename(invoice));
      return api(method,form,{multipart:true});
    }
    let message;
    try { message = await send(Boolean(stablePhoto)); }
    catch(error) {
      if (messageId && /message is not modified/i.test(error.message)) message = {message_id:messageId};
      // Only an explicit media rejection is safe to retry without its photo.
      else if (stablePhoto && error.telegramStatus === 400 && /photo|image|url|webpage|http/i.test(error.message)) message = await send(false);
      else throw error;
    }
    messageId = message?.message_id || messageId;
    if (!messageId) throw new Error('TELEGRAM_MESSAGE_ID_MISSING');
    await save({status:'sent',leaseUntil:0,telegramMessageId:messageId,telegramChatId:String(targetChat),caption:stableCaption,
      photoUrl:stablePhoto,invoiceState,invoiceAttached:Boolean(bytes),invoiceFilename:bytes ? invoiceFilename(invoice) : null,
      sentAtMs:previous.sentAtMs || now(),lastError:null});
    if (pdfError) throw pdfError;
    return {sent:true,messageId,invoiceAttached:Boolean(bytes)};
  } catch(error) {
    await save({status:'error',leaseUntil:0,lastError:String(error.message || error).slice(0,500)}).catch(()=>{});
    throw error;
  }
}
module.exports = {deliverTripNotification};
