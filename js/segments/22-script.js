
(()=>{
  "use strict";

  const MODULE="BOTTOM_NAV";
  const STAGE="SCROLL_RENDER";
  const CODE="BOTTOM_NAV_REPAINT_FAILED";
  const $=id=>document.getElementById(id);

  const ua=navigator.userAgent||"";
  const isIOS=/iP(?:hone|ad|od)/i.test(ua);
  const isFilePage=location.protocol==="file:";
  const isEmbeddedWebView=isIOS&&(!/Safari\//i.test(ua)||isFilePage);

  if(isEmbeddedWebView){
    document.documentElement.classList.add("explora-ios-webview","explora-bottom-nav-safe-mode");
  }

  let timer=0;
  let reported=false;
  let failureCount=0;
  let lastRootY=Math.round(window.scrollY||document.documentElement.scrollTop||0);
  let lastMeaningfulY=lastRootY;
  let hasMeaningfulRootScroll=lastRootY>2;
  let lastScrollEventAt=0;

  function safeArea(){
    const probe=document.createElement("div");
    probe.style.cssText="position:fixed;left:-9999px;bottom:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    const value=getComputedStyle(probe).paddingBottom||"0px";
    probe.remove();
    return value;
  }

  function identityTransform(value){
    if(!value||value==="none")return true;
    try{
      const matrix=new DOMMatrixReadOnly(value);
      return Math.abs(matrix.a-1)<.002&&Math.abs(matrix.b)<.002&&Math.abs(matrix.c)<.002&&Math.abs(matrix.d-1)<.002&&Math.abs(matrix.e)<1&&Math.abs(matrix.f)<1;
    }catch(_){
      return false;
    }
  }

  function diagnostic(error,detail={}){
    if(reported)return;
    if(window.ExploraProductionPolicy&&!window.ExploraProductionPolicy.handle("navegacion",error,{message:"No pudimos actualizar esta pantalla. Intenta nuevamente.",context:detail})){reported=true;return;}
    reported=true;
    const context={
      eventType:"ERROR",
      functionName:"validateBottomNavScrollRender",
      scrollPosition:Math.round(window.scrollY||document.documentElement.scrollTop||0),
      safeArea:safeArea(),
      device:ua||"—",
      result:CODE,
      firestorePath:"DOM#mainBottomNav",
      query:"getBoundingClientRect + getComputedStyle",
      ...detail
    };

    if(typeof window.ExploraPerformanceEngine?.showDiagnostic==="function"){
      window.ExploraPerformanceEngine.showDiagnostic(STAGE,CODE,error,context);
      return;
    }

    const payload=[
      "EXPLORA - ERROR BOTTOM_NAV",
      `MÓDULO: ${MODULE}`,
      `ETAPA: ${STAGE}`,
      `TIPO_EVENTO: ERROR`,
      `CÓDIGO INTERNO: ${CODE}`,
      `MENSAJE REAL JAVASCRIPT: ${error?.message||String(error||CODE)}`,
      `STACK: ${error?.stack||"—"}`,
      "FUNCIÓN: validateBottomNavScrollRender",
      `SCROLL POSITION: ${context.scrollPosition}`,
      `SAFE AREA: ${context.safeArea}`,
      `DEVICE: ${context.device}`,
      `TIMESTAMP: ${new Date().toISOString()}`
    ].join("\n");

    const backdrop=$("performanceDiagnosticBackdrop");
    const text=$("performanceDiagnosticText");
    const title=$("performanceDiagnosticTitle");
    if(text)text.textContent=payload;
    if(title)title.textContent="EXPLORA · DIAGNÓSTICO";
    backdrop?.classList.add("is-open");
    backdrop?.setAttribute("aria-hidden","false");
  }

  function inspect(){
    const nav=$("mainBottomNav");
    if(!nav||!nav.isConnected)return {ok:false,reason:"NAV_NOT_CONNECTED",nav:null};
    if(!document.body.classList.contains("explora-authenticated"))return null;
    if(document.visibilityState!=="visible")return null;

    const rect=nav.getBoundingClientRect();
    const style=getComputedStyle(nav);
    const layoutHeight=window.innerHeight||document.documentElement.clientHeight||0;
    const visible=style.display!=="none"&&style.visibility!=="hidden"&&Number.parseFloat(style.opacity||"1")>.05;
    const fixed=style.position==="fixed";
    const sized=rect.width>=Math.min(240,window.innerWidth*.66)&&rect.height>=64;
    const stableTransform=identityTransform(style.transform);

    /* WKWebView puede informar rect.bottom contra un viewport visual transitorio.
       Esa diferencia no demuestra un repaint negro y no debe generar un error. */
    const geometryReliable=!isEmbeddedWebView&&!isFilePage;
    const bottomDistance=Math.abs(rect.bottom-layoutHeight);
    const anchored=!geometryReliable||bottomDistance<=Math.max(48,Math.round(layoutHeight*.08));

    return {
      ok:visible&&fixed&&sized&&stableTransform&&anchored,
      structuralOk:visible&&fixed&&sized&&stableTransform,
      visible,
      fixed,
      sized,
      stableTransform,
      anchored,
      geometryReliable,
      rect,
      style,
      layoutHeight,
      bottomDistance,
      reason:!visible?"NAV_NOT_VISIBLE":!fixed?"NAV_NOT_FIXED":!sized?"NAV_INVALID_SIZE":!stableTransform?"NAV_UNEXPECTED_TRANSFORM":!anchored?"NAV_NOT_ANCHORED":"OK"
    };
  }

  function applySafeMode(){
    document.documentElement.classList.add("explora-bottom-nav-safe-mode");
    const nav=$("mainBottomNav");
    if(!nav)return;
    nav.style.removeProperty("transform");
    nav.style.removeProperty("-webkit-transform");
    nav.style.removeProperty("will-change");
    nav.style.removeProperty("filter");
    nav.style.removeProperty("-webkit-filter");
  }

  function validate(){
    timer=0;

    /* El error reportado por el usuario ocurría con SCROLL POSITION: 0.
       En esa condición no existe desplazamiento raíz que validar. */
    const currentY=Math.round(window.scrollY||document.documentElement.scrollTop||0);
    if(!hasMeaningfulRootScroll||currentY<=1||lastMeaningfulY<=1)return;
    if(Date.now()-lastScrollEventAt<180){schedule();return;}

    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      try{
        let result=inspect();
        if(!result)return;
        if(result.ok){failureCount=0;return;}

        applySafeMode();
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
          try{
            result=inspect();
            if(!result||result.ok||result.structuralOk){
              failureCount=0;
              return;
            }

            failureCount+=1;
            if(failureCount<5)return;

            const error=Object.assign(new Error("La navegación inferior perdió su estructura visible durante un desplazamiento real."),{
              code:CODE,
              details:{
                reason:result.reason,
                rectBottom:Math.round(result.rect?.bottom||0),
                rectHeight:Math.round(result.rect?.height||0),
                rectWidth:Math.round(result.rect?.width||0),
                layoutHeight:Math.round(result.layoutHeight||0),
                bottomDistance:Math.round(result.bottomDistance||0),
                position:result.style?.position||"—",
                transform:result.style?.transform||"—",
                embeddedWebView:isEmbeddedWebView,
                rootScrollY:currentY
              }
            });
            diagnostic(error,{validationDetails:error.details,failureCount});
          }catch(error){
            diagnostic(error,{failureCount});
          }
        }));
      }catch(error){
        diagnostic(error,{failureCount});
      }
    }));
  }

  function schedule(){
    clearTimeout(timer);
    timer=setTimeout(validate,340);
  }

  function onRootScroll(){
    const currentY=Math.round(window.scrollY||document.documentElement.scrollTop||0);
    const delta=Math.abs(currentY-lastRootY);
    lastRootY=currentY;
    lastScrollEventAt=Date.now();

    if(delta>=2&&currentY>1){
      hasMeaningfulRootScroll=true;
      lastMeaningfulY=currentY;
      schedule();
      return;
    }

    /* Volver al inicio invalida cualquier comprobación pendiente y evita falsos positivos. */
    if(currentY<=1){
      clearTimeout(timer);
      timer=0;
      failureCount=0;
      hasMeaningfulRootScroll=false;
      lastMeaningfulY=0;
    }
  }

  window.addEventListener("scroll",onRootScroll,{passive:true});
  window.addEventListener("orientationchange",()=>{
    clearTimeout(timer);
    timer=0;
    failureCount=0;
    hasMeaningfulRootScroll=false;
    lastRootY=Math.round(window.scrollY||0);
    lastMeaningfulY=lastRootY>1?lastRootY:0;
    applySafeMode();
  },{passive:true});

  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState!=="visible")return;
    clearTimeout(timer);
    timer=0;
    failureCount=0;
    hasMeaningfulRootScroll=false;
    lastRootY=Math.round(window.scrollY||0);
    lastMeaningfulY=lastRootY>1?lastRootY:0;
    if(isEmbeddedWebView)applySafeMode();
  });

  window.addEventListener("pageshow",()=>{
    failureCount=0;
    if(isEmbeddedWebView)applySafeMode();
  },{passive:true});

  if(isEmbeddedWebView)applySafeMode();
})();
