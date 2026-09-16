
(()=>{
      "use strict";
      const lockReasons=new Set();
      let savedScrollY=0;
      function syncLock(){
        const locked=lockReasons.size>0;
        document.body.classList.toggle("is-scroll-locked",locked);
        if(!locked){document.documentElement.style.overflowY="";document.body.style.overflowY="";document.body.style.touchAction="pan-y";}
      }
      window.lockPageScroll=(reason="modal")=>{if(!lockReasons.size)savedScrollY=window.scrollY||0;lockReasons.add(reason);syncLock();};
      window.unlockPageScroll=(reason="modal")=>{lockReasons.delete(reason);syncLock();};
      window.unlockAllPageScroll=()=>{lockReasons.clear();document.body.classList.remove("modal-open","no-scroll","is-loading","weekly-closure-saving","is-scroll-locked");document.documentElement.classList.remove("modal-open","no-scroll","is-loading");document.body.style.overflow="";document.documentElement.style.overflow="";document.body.style.pointerEvents="";document.body.style.touchAction="pan-y";syncLock();};
      function hasVisibleBlockingSurface(){
        const selectors=[
          '.dialog-backdrop.open','.billing-form-backdrop.is-open','#exploraSuccessBackdrop.is-open',
          '#weeklyClosureOverlay:not([hidden])','[id$="Overlay"][aria-hidden="false"]',
          '[id$="Backdrop"].is-open','[id$="Backdrop"].open','[id$="Screen"].is-open'
        ];
        return selectors.some(selector=>{
          try{return Boolean(document.querySelector(selector));}catch(_){return false;}
        });
      }
      function reconcileScrollLock(){
        if(!hasVisibleBlockingSurface()&&lockReasons.size){lockReasons.clear();}
        syncLock();
        return {locked:lockReasons.size>0,reasons:[...lockReasons]};
      }
      window.ExploraScroll={lock:window.lockPageScroll,unlock:window.unlockPageScroll,unlockAll:window.unlockAllPageScroll,reconcile:reconcileScrollLock,get reasons(){return [...lockReasons];},get savedY(){return savedScrollY;}};
      function nearestScrollable(element){
        let node=element?.parentElement||null;
        while(node&&node!==document.body){
          const style=getComputedStyle(node);
          if(/auto|scroll/.test(style.overflowY)&&node.scrollHeight>node.clientHeight+2)return node;
          node=node.parentElement;
        }
        return null;
      }
      function scrollElementInside(container,element,{top=18,bottom=24,behavior}={}){
        if(!container||!element)return;
        const c=container.getBoundingClientRect(),e=element.getBoundingClientRect();
        let delta=0;
        if(e.top<c.top+top)delta=e.top-(c.top+top);
        else if(e.bottom>c.bottom-bottom)delta=e.bottom-(c.bottom-bottom);
        if(Math.abs(delta)>1)container.scrollTo({top:Math.max(0,container.scrollTop+delta),behavior:behavior||((matchMedia('(prefers-reduced-motion: reduce)').matches)?'auto':'smooth')});
      }
      window.ExploraNearestScrollable=nearestScrollable;
      window.ExploraScrollElementInside=scrollElementInside;
      window.scrollToReceiptSubmitButton=function scrollToReceiptSubmitButton(button){
        if(!button)return;
        const preferred=button.closest('.billing-modal-content,.weekly-closure-content,.derivation-modal,[data-scroll-container]');
        const preferredScrollable=preferred&&preferred.scrollHeight>preferred.clientHeight+2&&/auto|scroll/.test(getComputedStyle(preferred).overflowY);
        const container=preferredScrollable?preferred:nearestScrollable(button);
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
          if(container)scrollElementInside(container,button,{top:16,bottom:Math.max(28,parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom-offset'))||28)});
          else button.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center',inline:'nearest'});
        }));
      };

      function updateVisualViewportVariables(){
        const viewport=window.visualViewport;
        const h=viewport?.height||window.innerHeight;
        const keyboard=Math.max(0,window.innerHeight-h-(viewport?.offsetTop||0));
        document.documentElement.style.setProperty("--visual-viewport-height",`${Math.round(h)}px`);
        document.documentElement.style.setProperty("--keyboard-height",`${Math.round(keyboard)}px`);
      }
      window.updateVisualViewportVariables=updateVisualViewportVariables;
      if(window.visualViewport){window.visualViewport.addEventListener("resize",updateVisualViewportVariables,{passive:true});window.visualViewport.addEventListener("scroll",updateVisualViewportVariables,{passive:true});}
      window.addEventListener("orientationchange",()=>setTimeout(updateVisualViewportVariables,80),{passive:true});
      updateVisualViewportVariables();
      document.addEventListener("focusin",event=>{const el=event.target;if(!el?.matches?.("input,textarea,select,button,[tabindex]"))return;setTimeout(()=>{const container=el.closest('.billing-modal-content,.weekly-closure-content,.derivation-modal,[data-scroll-container]')||nearestScrollable(el);if(container)scrollElementInside(container,el,{top:18,bottom:28});},180);});

      const successBackdrop=document.getElementById("exploraSuccessBackdrop");
      let successCallback=null;
      function closeSuccess(){if(!successBackdrop)return;successBackdrop.classList.remove("is-open");successBackdrop.setAttribute("aria-hidden","true");window.unlockPageScroll("success");const cb=successCallback;successCallback=null;try{cb?.();}catch(error){console.warn("SUCCESS_CALLBACK",error?.message);}}
      window.showExploraSuccess=(input="Operación registrada correctamente.",onAccept=null)=>{const options=input&&typeof input==="object"?input:{message:String(input||"Operación registrada correctamente."),onAccept};const message=String(options.message||"Operación registrada correctamente.");if(!successBackdrop){options.onAccept?.();return;}const title=document.getElementById("exploraSuccessTitle");if(title)title.textContent=String(options.title||"¡EXITOSO!");document.getElementById("exploraSuccessMessage").textContent=message;successCallback=typeof options.onAccept==="function"?options.onAccept:null;successBackdrop.classList.add("is-open");successBackdrop.setAttribute("aria-hidden","false");window.lockPageScroll("success");};
      window.ExploraSuccess={show:window.showExploraSuccess,close:closeSuccess};
      document.getElementById("exploraSuccessAccept")?.addEventListener("click",closeSuccess);
      successBackdrop?.addEventListener("click",event=>{if(event.target===successBackdrop)closeSuccess();});
      document.addEventListener("keydown",event=>{if(event.key==="Escape"&&successBackdrop?.classList.contains("is-open"))closeSuccess();});

      document.addEventListener("click",event=>{
        if(event.target.closest("[data-action='salir'],#logoutBtn,#adminLogoutBtn"))setTimeout(window.unlockAllPageScroll,0);
      },true);
      window.addEventListener("explora:auth-cleared",window.unlockAllPageScroll);
    })();
  