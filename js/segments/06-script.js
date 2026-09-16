
  (()=>{
    "use strict";
    const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
    const bytes=value=>{const size=Number(value||0);if(!(size>0))return"—";if(size<1024)return`${size} B`;if(size<1024*1024)return`${(size/1024).toFixed(size<10240?1:0)} KB`;return`${(size/1024/1024).toFixed(2)} MB`;};
    function markup({triggerId,previewId,thumbId,nameId,metaId,removeId,heading="Comprobante"}={}){
      return `<div class="receipt-upload-field"><div class="receipt-upload-heading">${esc(heading)}</div><button id="${esc(triggerId)}" type="button" class="receipt-upload-trigger" aria-label="Subir comprobante"><svg class="receipt-upload-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 18a5 5 0 0 0 0-10 6 6 0 0 0-11.5 2A4 4 0 0 0 6 18h11"/><path d="M12 12v8"/><path d="m8 16 4-4 4 4"/></svg><span><b class="receipt-upload-title">Subir comprobante</b><small class="receipt-upload-subtitle">Toca para seleccionar o tomar foto</small></span></button><div id="${esc(previewId)}" class="receipt-preview" hidden><div id="${esc(thumbId)}" class="receipt-preview-image"></div><div class="receipt-preview-info"><b id="${esc(nameId)}"></b><small id="${esc(metaId)}"></small></div><button id="${esc(removeId)}" type="button" class="receipt-preview-remove" aria-label="Eliminar comprobante">×</button></div><p class="receipt-formats">Formatos permitidos: JPG, PNG y WebP. La imagen se optimiza antes de subir.</p></div>`;
    }
    function updatePrompt(preview,replacing){
      const field=preview?.closest?.(".receipt-upload-field");
      const title=field?.querySelector?.(".receipt-upload-title");
      const subtitle=field?.querySelector?.(".receipt-upload-subtitle");
      if(title)title.textContent=replacing?"Reemplazar comprobante":"Subir comprobante";
      if(subtitle)subtitle.textContent=replacing?"Toca para seleccionar otra foto":"Toca para seleccionar o tomar foto";
    }
    function render({previewId,thumbId,nameId,metaId,file,previewUrl}={}){
      const preview=document.getElementById(previewId),thumb=document.getElementById(thumbId),name=document.getElementById(nameId),meta=document.getElementById(metaId);
      if(!preview||!thumb||!file||!previewUrl)return false;
      thumb.innerHTML="";const image=document.createElement("img");image.alt="Vista previa del comprobante";image.src=previewUrl;image.addEventListener("error",()=>{thumb.innerHTML="";thumb.textContent="IMG";},{once:true});thumb.appendChild(image);
      if(name)name.textContent=file.name||"Comprobante";
      if(meta)meta.textContent=`${String(file.type||"imagen").toLowerCase()} · ${bytes(file.size)}`;
      preview.hidden=false;preview.classList.add("is-visible");updatePrompt(preview,true);return true;
    }
    function clear({previewId,thumbId,nameId,metaId}={}){
      const preview=document.getElementById(previewId),thumb=document.getElementById(thumbId),name=document.getElementById(nameId),meta=document.getElementById(metaId);
      if(preview){preview.hidden=true;preview.classList.remove("is-visible");updatePrompt(preview,false);}
      if(thumb)thumb.innerHTML="";if(name)name.textContent="";if(meta)meta.textContent="";
    }
    window.ExploraReceiptUI={markup,render,clear,bytes};
  })();
  