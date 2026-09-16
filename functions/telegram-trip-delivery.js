'use strict';
const {randomUUID}=require('node:crypto');
const {invoiceFilename}=require('./telegram-compact');

// One operational message per payment. Digital receipts MUST remain photographs.
// Later ARCA authorization changes the photo caption, not the media or the payment.
async function deliverTripNotification({db,ref,paymentId,caption,photo,requirePhoto=Boolean(photo),chatId,api,sendPhoto,now=Date.now}) {
  const owner=randomUUID();
  const previous=await db.runTransaction(async tx=>{
    const snapshot=await tx.get(ref),row=snapshot.data()||{};
    // Do not resend messages already delivered by an older release.
    if (row.telegramMessageId && row.layoutVersion!==2) return null;
    if (row.status==='processing' && Number(row.leaseUntil || 0)>now()) throw new Error('TELEGRAM_NOTIFICATION_BUSY');
    tx.set(ref,{layoutVersion:2,status:'processing',owner,leaseUntil:now()+180000,updatedAtMs:now(),
      sourceCollection:'billing_records',sourceDocumentId:paymentId},{merge:true});
    return row;
  });
  if (!previous) return {skipped:true};
  const save=values=>db.runTransaction(async tx=>{
    const current=(await tx.get(ref)).data();
    if (current?.owner!==owner) throw new Error('TELEGRAM_LEASE_LOST');
    tx.set(ref,{...values,updatedAtMs:now()},{merge:true});
  });
  let messageId=previous.telegramMessageId || null;
  const target=previous.telegramChatId || chatId;
  const image=previous.photoUrl || photo || '';
  const stableCaption=String(previous.caption || caption || '').trim();
  try {
    if (requirePhoto && !image) throw new Error('TELEGRAM_REQUIRED_IMAGE_MISSING');
    const invoice=(await db.collection('arca_invoices').doc(paymentId).get()).data();
    const authorized=invoice?.status==='authorized';
    const state=authorized?'authorized':invoice?.status || 'queued';
    if (messageId && previous.invoiceState===state) {
      await save({status:'sent',leaseUntil:0});return {skipped:true,messageId};
    }
    const name=authorized?invoiceFilename(invoice):'';
    const notice=authorized?`\n\n🧾 ${name} · PDF disponible en Explora.`:
      ['review','rejected','disabled'].includes(state)?'\n\n🧾 Factura ARCA pendiente de revisión en Explora.':'\n\n🧾 Factura ARCA pendiente.';
    const text=(stableCaption+notice).slice(0,requirePhoto?1024:4096);
    let message;
    try {
      if (messageId) {
        message=await api(requirePhoto?'editMessageCaption':'editMessageText',{
          chat_id:target,message_id:messageId,...(requirePhoto?{caption:text,show_caption_above_media:true}:{text})});
      } else if (requirePhoto) {
        message=sendPhoto?await sendPhoto(image,text,target):await api('sendPhoto',{chat_id:target,photo:image,caption:text,show_caption_above_media:true});
      } else message=await api('sendMessage',{chat_id:target,text});
    } catch(error) {
      if (messageId && /message is not modified/i.test(error.message)) message={message_id:messageId};
      else throw error; // Never mark a text-only fallback as a delivered image.
    }
    messageId=message?.message_id || messageId;
    if (!messageId) throw new Error('TELEGRAM_MESSAGE_ID_MISSING');
    await save({status:'sent',leaseUntil:0,telegramMessageId:messageId,telegramChatId:String(target),
      caption:stableCaption,photoUrl:image,invoiceState:state,invoiceAttached:false,invoiceFilename:name||null,
      sentAtMs:previous.sentAtMs || now(),lastError:null,attachmentType:requirePhoto?'photo':'text'});
    return {sent:true,messageId,invoiceAttached:false,photoSent:requirePhoto};
  } catch(error) {
    await save({status:'error',leaseUntil:0,lastError:String(error.message || error).slice(0,500)}).catch(()=>{});
    throw error;
  }
}
module.exports={deliverTripNotification};
