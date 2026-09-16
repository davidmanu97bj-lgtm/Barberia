(()=>{
  "use strict";

  const screen=document.getElementById("newServiceScreen");
  if(!screen)return;

  const $=id=>document.getElementById(id);
  const AR_TZ="America/Argentina/Cordoba";
  const RECEIPT_METHODS=new Set(["qr","card","transfer"]);
  const METHODS=Object.freeze({
    qr:{
      label:"Código QR",
      title:"REGISTRAR COBRO QR",
      subtitle:"Ingresá el monto y cargá la foto del pago aprobado",
      receiptText:"Comprobante del cobro QR aprobado",
      icon:'<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M14 14h2v2h-2zM18 14h2v6h-6v-2M14 18h2"/></svg>'
    },
    cash:{
      label:"Efectivo",
      title:"REGISTRAR COBRO EN EFECTIVO",
      subtitle:"Ingresá el monto recibido en efectivo",
      receiptText:"",
      icon:'<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="3"/></svg>'
    },
    card:{
      label:"Tarjeta",
      title:"REGISTRAR COBRO CON TARJETA",
      subtitle:"Ingresá el monto y cargá la foto del pago aprobado",
      receiptText:"Comprobante del cobro con tarjeta aprobado",
      icon:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>'
    },
    transfer:{
      label:"Transferencia",
      title:"REGISTRAR TRANSFERENCIA",
      subtitle:"Ingresá el monto y cargá la foto del pago recibido",
      receiptText:"Comprobante de la transferencia recibida",
      icon:'<svg viewBox="0 0 24 24"><path d="M4 7h16v11H4z"/><path d="M8 11h8"/><path d="m14 4 3 3-3 3"/></svg>'
    }
  });

  const state={method:null,amount:0,busy:false,previousScrollY:0};
  const receiptState={file:null,previewUrl:null,processedFile:null,uploading:false,lastError:null};
  let saveInProgress=false;
  const billingViewportCleanup=[];

  const requiresReceipt=method=>RECEIPT_METHODS.has(String(method||""));

  function clearBillingViewportListeners(){
    while(billingViewportCleanup.length){
      try{billingViewportCleanup.pop()();}catch(_){}
    }
  }

  function installBillingViewportListeners(){
    clearBillingViewportListeners();
    const refresh=()=>window.updateVisualViewportVariables?.();
    const add=(target,type,handler,options)=>{
      target?.addEventListener?.(type,handler,options);
      billingViewportCleanup.push(()=>target?.removeEventListener?.(type,handler,options));
    };
    add(window,"focus",refresh,{passive:true});
    add(document,"visibilitychange",refresh,{passive:true});
    add(window.visualViewport,"resize",refresh,{passive:true});
  }

  function parseBillingAmount(value){
    const raw=String(value??"")
      .replace(/\$/g,"")
      .replace(/\s/g,"")
      .replace(/\./g,"")
      .replace(/,/g,".")
      .replace(/[^\d.\-]/g,"");
    const amount=Number(raw);
    return Number.isFinite(amount)&&amount>0?Math.round(amount):0;
  }
  window.parseBillingAmount=parseBillingAmount;

  const formatInput=value=>{
    const digits=String(value||"").replace(/\D/g,"").replace(/^0+/,"");
    return digits?Number(digits).toLocaleString("es-AR"):"";
  };

  const createOperationId=()=>`bill_${String(window.ExploraFirebase?.auth?.currentUser?.uid||"anon").slice(0,10)}_${Date.now()}_${globalThis.crypto?.randomUUID?.().slice(0,8)||Math.random().toString(36).slice(2,10)}`
    .replace(/[^a-zA-Z0-9_-]/g,"")
    .slice(0,64);

  function nowParts(){
    const now=window.ExploraOperationalClock?.getNow?.()||new Date();
    return{
      date:now.toLocaleDateString("es-AR",{timeZone:AR_TZ}),
      time:now.toLocaleTimeString("es-AR",{timeZone:AR_TZ,hour:"2-digit",minute:"2-digit"})
    };
  }

  function setMessage(message="",type=""){
    const element=$("billingMessage");
    if(!element)return;
    element.textContent=message;
    element.className=`billing-message${type?` is-${type}`:""}`;
  }

  function formatBytes(value){
    const size=Number(value||0);
    if(!(size>0))return"—";
    if(size<1024)return`${size} B`;
    if(size<1024*1024)return`${(size/1024).toFixed(size<10240?1:0)} KB`;
    return`${(size/1024/1024).toFixed(2)} MB`;
  }

  function sanitizePath(value){
    const path=String(value||"").replace(/(?:undefined|null)/gi,"—").trim();
    return path||"—";
  }

  function renderReceiptError(error){
    receiptState.lastError=error||null;
    const stage=String(error?.aliasStage||"VALIDATION");
    const code=String(error?.code||error?.message||"UNKNOWN");
    const realMessage=String(error?.message||error?.cause?.message||code||"Error desconocido");
    const prefix=stage==="FIRESTORE_WRITE"&&error?.aliasStorageUploaded?"El archivo se subió, pero el cobro no pudo registrarse.\n\n":"";
    const firebaseStorage=window.ExploraFirebase?.storage;
    const bucket=String(error?.aliasBucket||firebaseStorage?.app?.options?.storageBucket||firebaseStorage?._bucket?.bucket||"—");
    const authUid=String(error?.aliasAuthUid||window.ExploraFirebase?.auth?.currentUser?.uid||"").trim();
    const exactPath=sanitizePath(error?.aliasPath);
    const routeUid=String(error?.aliasRouteUid||(exactPath!=="—"?exactPath.split("/")[1]:"")||"").trim();
    const uidMatch=Boolean(authUid&&routeUid&&authUid===routeUid);
    const mimeType=String(error?.aliasMimeType||receiptState.processedFile?.mimeType||receiptState.file?.type||"—");
    const processedSize=Number(error?.aliasProcessedSize||receiptState.processedFile?.size||receiptState.processedFile?.byteSize||receiptState.processedFile?.blob?.size||0);
    const unauthorized=code.toLowerCase().includes("storage/unauthorized");
    const methodLabel=METHODS[state.method]?.label||"Cobro";
    const detail=[
      `${prefix}ERROR REGISTRAR ${methodLabel.toUpperCase()}`,
      "",
      `Etapa exacta: ${stage}`,
      `Código Firebase: ${code}`,
      `Mensaje Firebase: ${realMessage}`,
      `Ruta exacta: ${exactPath}`,
      `UID auth: ${authUid?authUid.slice(0,8):"—"}`,
      `UID ruta: ${routeUid?routeUid.slice(0,8):"—"}`,
      `Coinciden: ${uidMatch?"Sí":"No"}`,
      `Bucket: ${bucket}`,
      `Storage inicializado: ${firebaseStorage?"Sí":"No"}`,
      `MIME: ${mimeType}`,
      `Peso original: ${formatBytes(error?.aliasOriginalSize||receiptState.file?.size)}`,
      `Peso procesado: ${formatBytes(processedSize)}`,
      "Categoría: pago_cliente",
      unauthorized?"Sugerencia: revisá los permisos de Firebase Storage para la ruta indicada.":""
    ].filter(Boolean).join("\n");
    const element=$("billingMessage");
    if(element){
      element.textContent=detail;
      element.className="billing-message is-alias-diagnostic";
    }
  }

  function revokeReceiptPreview(){
    if(receiptState.previewUrl){
      try{URL.revokeObjectURL(receiptState.previewUrl);}catch(_){}
    }
    receiptState.previewUrl=null;
  }

  function syncReceiptVisualState(){
    const form=$("billingForm");
    const panel=$("billingTransferReceiptPanel");
    const hasReceipt=receiptState.file instanceof File;
    form?.classList.toggle("has-receipt",hasReceipt);
    panel?.classList.toggle("has-receipt",hasReceipt);
    const requirement=$("billingReceiptRequirement");
    requirement?.classList.toggle("is-complete",hasReceipt);
    const title=$("billingReceiptRequirementTitle");
    const text=$("billingReceiptRequirementText");
    if(title)title.textContent=hasReceipt?"FOTO CARGADA":"Todavía no cargaste la foto";
    if(text)text.textContent=hasReceipt?"Ya podés finalizar el cobro.":"Usá el botón ELEGIR FOTO que está abajo ↓";
  }

  function clearReceipt(){
    revokeReceiptPreview();
    try{window.ExploraReceiptEngine?.resetUploadState?.("aliasPayment");}catch(_){}
    receiptState.file=null;
    receiptState.processedFile=null;
    receiptState.uploading=false;
    receiptState.lastError=null;
    const input=$("aliasReceiptInput");
    if(input)input.value="";
    window.ExploraReceiptUI?.clear?.({
      previewId:"billingTransferReceiptPreview",
      thumbId:"billingTransferReceiptVisual",
      nameId:"billingTransferReceiptName",
      metaId:"billingTransferReceiptSize"
    });
    syncReceiptVisualState();
    updatePrimary();
  }

  function resetForm(){
    clearReceipt();
    state.method=null;
    state.amount=0;
    state.busy=false;
    const amountInput=$("billingAmountInput");
    if(amountInput){
      amountInput.value="";
      amountInput.disabled=false;
      amountInput.closest(".billing-amount-box")?.classList.remove("is-valid","is-invalid");
    }
    $("billingTransferReceiptPanel").hidden=true;
    const form=$("billingForm");
    if(form){
      delete form.dataset.billingMethod;
      form.classList.remove("has-receipt");
    }
    setMessage("");
  }

  function setBusy(busy,label=""){
    state.busy=busy;
    receiptState.uploading=Boolean(busy&&requiresReceipt(state.method));
    $("billingAmountInput").disabled=busy;
    $("billingExitBtn").disabled=busy;
    $("aliasReceiptInput").disabled=busy;
    $("billingTransferReceiptRemove").disabled=busy;
    const button=$("billingPrimaryBtn");
    if(button)button.disabled=busy;
    if(label&&button)button.textContent=label;
    else updatePrimary();
  }

  function updatePrimary(){
    const button=$("billingPrimaryBtn");
    if(!button)return;
    button.classList.remove("is-upload","is-finalize");
    if(state.busy||saveInProgress){
      button.disabled=true;
      button.setAttribute("aria-disabled","true");
      return;
    }

    const validAmount=state.amount>0;
    const validSession=Boolean(window.ExploraFirebase?.auth?.currentUser?.uid);
    const hasReceipt=receiptState.file instanceof File;

    if(requiresReceipt(state.method)){
      if(!hasReceipt){
        button.textContent="ELEGIR FOTO";
        button.classList.add("is-upload");
        button.disabled=!(validAmount&&validSession);
      }else{
        button.textContent="FINALIZAR COBRO";
        button.classList.add("is-finalize");
        button.disabled=!(validAmount&&validSession&&!receiptState.uploading);
      }
    }else{
      button.textContent="FINALIZAR COBRO";
      button.classList.add("is-finalize");
      button.disabled=!(validAmount&&validSession);
    }

    button.setAttribute("aria-disabled",String(button.disabled));
    syncReceiptVisualState();
  }

  function setAmount(){
    const input=$("billingAmountInput");
    input.value=formatInput(input.value);
    state.amount=parseBillingAmount(input.value);
    input.closest(".billing-amount-box")?.classList.toggle("is-valid",state.amount>0);
    input.closest(".billing-amount-box")?.classList.toggle("is-invalid",!(state.amount>0));
    setMessage("");
    updatePrimary();
  }

  function openScreen(){
    // El kilometraje funciona como recordatorio independiente.
    // Registrar cobro nunca espera una consulta de Firestore.
    state.previousScrollY=window.scrollY||0;
    screen.classList.add("is-open");
    screen.setAttribute("aria-hidden","false");
    document.body.classList.add("new-service-open");
    window.lockPageScroll?.("billing-screen");
    window.ExploraMainNav?.setActive?.("operaciones");
  }

  async function closeForm(){
    if(state.busy)return;
    resetForm();
    const backdrop=$("billingFormBackdrop");
    backdrop?.classList.remove("is-open");
    backdrop?.setAttribute("aria-hidden","true");
    const content=backdrop?.querySelector(".billing-modal-content");
    if(content)content.scrollTop=0;
    document.body.classList.remove("billing-form-open");
    clearBillingViewportListeners();
    document.body.style.overflow="";
    document.body.style.touchAction="";
    window.unlockPageScroll?.("billing-form");
  }

  function closeScreen(){
    closeForm().finally(()=>{
      screen.classList.remove("is-open");
      screen.setAttribute("aria-hidden","true");
      document.body.classList.remove("new-service-open","billing-form-open");
      document.body.style.overflow="";
      document.body.style.touchAction="";
      window.unlockPageScroll?.("billing-screen");
      window.ExploraMainNav?.setActive?.("inicio");
      requestAnimationFrame(()=>window.scrollTo(0,state.previousScrollY||0));
    });
  }

  function openBillingForm(method){
    if(!METHODS[method])return;
    resetForm();
    state.method=method;
    const copy=METHODS[method];
    $("billingFormTitle").textContent=copy.title;
    $("billingTypeValue").textContent=copy.label;
    $("billingFormSubtitle").textContent=copy.subtitle;
    $("billingFormIcon").innerHTML=copy.icon;
    $("billingFormIcon").className=`billing-form-icon is-${method}`;
    const form=$("billingForm");
    if(form)form.dataset.billingMethod=method;
    const parts=nowParts();
    $("billingDateValue").textContent=parts.date;
    $("billingTimeValue").textContent=parts.time;
    const panel=$("billingTransferReceiptPanel");
    panel.hidden=!requiresReceipt(method);
    if(requiresReceipt(method)){
      $("billingReceiptRequirementTitle").textContent="Todavía no cargaste la foto";
      $("billingReceiptRequirementText").textContent="Usá el botón ELEGIR FOTO que está abajo ↓";
    }
    const backdrop=$("billingFormBackdrop");
    const content=backdrop?.querySelector(".billing-modal-content");
    if(content)content.scrollTop=0;
    backdrop?.classList.add("is-open");
    backdrop?.setAttribute("aria-hidden","false");
    document.body.classList.add("billing-form-open");
    window.updateVisualViewportVariables?.();
    installBillingViewportListeners();
    window.lockPageScroll?.("billing-form");
    $("billingAmountInput")?.closest(".billing-amount-box")?.classList.add("is-invalid");
    updatePrimary();
    setTimeout(()=>$("billingAmountInput")?.focus({preventScroll:false}),100);
  }

  function mapError(error){
    const code=String(error?.code||error?.message||"").toLowerCase();
    if(code.includes("auth")||code.includes("unauthenticated"))return"No se pudo verificar tu sesión.";
    if(code.includes("permission"))return"No tenés permisos para registrar este cobro.";
    if(code.includes("storage/unauthorized"))return"No tenés permiso para subir este comprobante.";
    if(code.includes("storage"))return"No se pudo almacenar el comprobante.";
    if(code.includes("network")||code.includes("fetch"))return"No hay conexión disponible.";
    return"No se pudo registrar el cobro.";
  }

  async function registerManual(){
    const operationId=createOperationId();
    const withReceipt=requiresReceipt(state.method);
    const payload={
      operationId,
      amount:state.amount,
      paymentMethod:state.method,
      receiptFile:withReceipt?receiptState.file:null,
      processedFile:withReceipt?receiptState.processedFile:null,
      onProcessed:processed=>{receiptState.processedFile=processed||null;},
      onStage:stage=>{
        if(!withReceipt)return;
        if(stage==="SESSION"||stage==="VALIDATION"||stage==="PROCESS_IMAGE")setBusy(true,"PREPARANDO COMPROBANTE…");
        else if(stage==="STORAGE_UPLOAD"||stage==="GET_URL")setBusy(true,"SUBIENDO COMPROBANTE…");
        else if(stage==="FIRESTORE_WRITE")setBusy(true,"REGISTRANDO COBRO…");
      }
    };
    const result=await window.ExploraRegisterBillingRecord(payload);
    window.dispatchEvent(new CustomEvent("explora:cobro-registrado",{detail:result}));
    setMessage("");
    window.showExploraSuccess?.({
      title:"¡EXITOSO!",
      message:withReceipt?"Cobro y comprobante registrados correctamente.":"Cobro en efectivo registrado correctamente.",
      onAccept:()=>{
        try{window.ExploraOperationalWhatsapp?.billing?.(result);}catch(error){console.warn("BILLING_WHATSAPP",error);}
        closeForm().then(closeScreen);
      }
    });
  }

  function openReceiptPicker(){
    const input=$("aliasReceiptInput");
    if(!input||input.disabled)return;
    input.value="";
    try{
      if(typeof input.showPicker==="function")input.showPicker();
      else input.click();
    }catch(_){input.click();}
  }

  async function submitPayment(event){
    event.preventDefault();
    if(saveInProgress)return;
    state.amount=parseBillingAmount($("billingAmountInput").value);
    if(!(state.amount>0)){
      setMessage("Ingresá un valor válido.","error");
      updatePrimary();
      return;
    }
    if(!window.ExploraFirebase?.auth?.currentUser?.uid){
      setMessage("No se pudo verificar tu sesión.","error");
      updatePrimary();
      return;
    }
    if(requiresReceipt(state.method)&&!(receiptState.file instanceof File)){
      setMessage("");
      openReceiptPicker();
      return;
    }
    saveInProgress=true;
    receiptState.lastError=null;
    setMessage("");
    setBusy(true,requiresReceipt(state.method)?"PREPARANDO COMPROBANTE…":"REGISTRANDO COBRO…");
    try{
      await registerManual();
    }catch(error){
      console.warn("BILLING_REGISTER",error);
      if(requiresReceipt(state.method))renderReceiptError(error);
      else setMessage(mapError(error),"error");
    }finally{
      saveInProgress=false;
      receiptState.uploading=false;
      setBusy(false);
    }
  }

  function selectReceipt(file){
    if(!file)return;
    try{
      const selected=window.ExploraReceiptEngine?.selectUploadFile?.(file,"aliasPayment",{allowPdf:false,maxSourceBytes:15*1024*1024});
      if(!selected?.file)throw new Error("RECEIPT_FILE_INVALID");
      revokeReceiptPreview();
      receiptState.file=selected.file;
      receiptState.processedFile=null;
      receiptState.previewUrl=selected.previewUrl||URL.createObjectURL(selected.file);
      receiptState.lastError=null;
      const rendered=window.ExploraReceiptUI?.render?.({
        previewId:"billingTransferReceiptPreview",
        thumbId:"billingTransferReceiptVisual",
        nameId:"billingTransferReceiptName",
        metaId:"billingTransferReceiptSize",
        file:selected.file,
        previewUrl:receiptState.previewUrl
      });
      syncReceiptVisualState();
      setMessage("");
      updatePrimary();
      if(rendered){
        window.updateVisualViewportVariables?.();
        requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollToReceiptSubmitButton?.($("billingPrimaryBtn"))));
      }
    }catch(error){
      console.warn("PAYMENT_RECEIPT_SELECT",error);
      revokeReceiptPreview();
      try{window.ExploraReceiptEngine?.resetUploadState?.("aliasPayment");}catch(_){}
      const code=String(error?.code||error?.message||"").toLowerCase();
      setMessage(code.includes("too_large")?"El comprobante es demasiado pesado.":"Seleccioná una imagen JPG, PNG o WebP compatible.","error");
      const input=$("aliasReceiptInput");
      if(input)input.value="";
      receiptState.file=null;
      receiptState.processedFile=null;
      receiptState.lastError=error;
      window.ExploraReceiptUI?.clear?.({
        previewId:"billingTransferReceiptPreview",
        thumbId:"billingTransferReceiptVisual",
        nameId:"billingTransferReceiptName",
        metaId:"billingTransferReceiptSize"
      });
      syncReceiptVisualState();
      updatePrimary();
    }
  }

  window.ExploraActions=window.ExploraActions||{};
  window.ExploraActions["nuevo-servicio"]=openScreen;
  window.ExploraActions["registrar-cobro"]=openScreen;
  window.ExploraNewService={
    open:openScreen,
    close:closeScreen,
    getCatalog:()=>({}),
    getState:()=>({paymentMethod:state.method,amount:state.amount,receiptRequired:requiresReceipt(state.method),receiptSelected:receiptState.file instanceof File})
  };
  window.ExploraBilling={open:openScreen,openForm:openBillingForm,close:closeScreen,parseBillingAmount};

  document.addEventListener("DOMContentLoaded",()=>{
    $("newServiceBackBtn")?.addEventListener("click",closeScreen);
    $("billingMethodGrid")?.addEventListener("click",event=>{
      const button=event.target.closest("[data-billing-method]");
      if(button)openBillingForm(button.dataset.billingMethod);
    });
    $("billingForm")?.addEventListener("submit",submitPayment);
    $("billingAmountInput")?.addEventListener("input",setAmount);
    $("billingExitBtn")?.addEventListener("click",closeForm);
    $("aliasReceiptInput")?.addEventListener("change",event=>selectReceipt(event.target.files?.[0]||null));
    $("billingTransferReceiptRemove")?.addEventListener("click",clearReceipt);
    $("billingFormBackdrop")?.addEventListener("click",event=>{
      if(event.target.id==="billingFormBackdrop"&&!state.busy)closeForm();
    });
  });
})();
