(function(){
  var done=false;
  function hasRecentCachedSession(){
    try{
      var raw=localStorage.getItem('explora_sesion_nueva_last');
      if(!raw)return false;
      var c=JSON.parse(raw),age=Date.now()-Number(c&&c.ts||0);
      return !!(c&&c.uid&&age>=0&&age<1000*60*60*24*45);
    }catch(e){return false;}
  }
  function isChecking(){
    return document.body&&document.body.classList&&document.body.classList.contains('explora-auth-checking');
  }
  function finish(force){
    if(done) return;
    if(isChecking()&&!force) return;
    done=true;
    document.body.classList.add('explora-splash-hidden');
    document.documentElement.style.pointerEvents='';
    document.body.style.pointerEvents='';
    document.documentElement.style.overflow='';
    document.body.style.overflow='';
    var s=document.getElementById('exploraSplash');
    if(s){s.setAttribute('aria-hidden','true');s.style.display='none';s.style.pointerEvents='none';}
    var hasMode=document.body.classList.contains('explora-auth-checking')||document.body.classList.contains('explora-authenticated')||document.body.classList.contains('explora-admin-authenticated')||document.body.classList.contains('explora-login-visible')||document.body.classList.contains('explora-role-blocked');
    if(!hasMode) document.body.classList.add('explora-login-visible');
  }
  window.ExploraFinishSplash=function(){finish(true);};
  setTimeout(function(){finish(false);},1400);
  window.addEventListener('error',function(){setTimeout(function(){finish(false);},0);});
  window.addEventListener('unhandledrejection',function(){setTimeout(function(){finish(false);},0);});
  setTimeout(function(){
    try{
      var authenticated=document.body.classList.contains('explora-authenticated')||document.body.classList.contains('explora-admin-authenticated');
      var login=document.body.classList.contains('explora-login-visible');
      if(!authenticated&&!login&&document.body.classList.contains('explora-auth-checking')&&!hasRecentCachedSession()){
        document.body.classList.remove('explora-auth-checking');
        document.body.classList.add('explora-login-visible');
        finish(true);
      }
    }catch(e){}
  },18000);
})();
