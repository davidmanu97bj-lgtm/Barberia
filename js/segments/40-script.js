
(() => {
  "use strict";

  const DIAGNOSTIC_SELECTOR = [
    '[id*="diagnostic" i]',
    '[class*="diagnostic" i]',
    '#performanceDiagnosticBackdrop',
    '#adminUiDiagnostic',
    '#exploraWeeklyClosureDiagnosticV283',
    '#exploreLoanDiagnostic'
  ].join(',');

  const hideNode = (node) => {
    if (!(node instanceof Element)) return;
    const nodes = [];
    if (node.matches?.(DIAGNOSTIC_SELECTOR)) nodes.push(node);
    node.querySelectorAll?.(DIAGNOSTIC_SELECTOR).forEach(el => nodes.push(el));
    for (const el of nodes) {
      if (el.dataset.exploraDiagnosticSuppressed === '1') continue;
      el.dataset.exploraDiagnosticSuppressed = '1';
      el.classList.remove('is-open','open','show','visible','is-visible');
      el.setAttribute('aria-hidden','true');
      el.hidden = true;
    }
  };

  const releaseDiagnosticLocksOnly = () => {
    const body = document.body;
    if (!body) return;
    body.classList.remove('diagnostic-open','performance-diagnostic-open','weekly-diagnostic-open');
    const reason = String(body.dataset.scrollLockReason || '').toLowerCase();
    if (reason.includes('diagnostic')) {
      body.classList.remove('is-scroll-locked');
      body.style.removeProperty('overflow');
      body.style.removeProperty('touch-action');
      delete body.dataset.scrollLockReason;
    }
  };

  const neutralizeApi = () => {
    const engine = window.ExploraPerformanceEngine;
    if (engine && typeof engine.showDiagnostic === 'function' && !engine.showDiagnostic.__visualSuppressed) {
      const silent = function(stage, code, error, context) {
        console.error('[EXPLORA_DIAGNOSTIC_HIDDEN]', { stage, code, error, context });
        return error || null;
      };
      silent.__visualSuppressed = true;
      try { engine.showDiagnostic = silent; } catch (_) {}
    }
    const closure = window.ExploraCanonicalWeeklyClosure;
    if (closure && typeof closure.showDiagnostic === 'function' && !closure.showDiagnostic.__visualSuppressed) {
      const silentClosure = function(error, context) {
        console.error('[EXPLORA_WEEKLY_DIAGNOSTIC_HIDDEN]', { error, context });
        return error || null;
      };
      silentClosure.__visualSuppressed = true;
      try { closure.showDiagnostic = silentClosure; } catch (_) {}
    }
  };

  let observer = null;
  const start = () => {
    hideNode(document.documentElement);
    releaseDiagnosticLocksOnly();
    neutralizeApi();

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach(hideNode);
      }
      neutralizeApi();
      releaseDiagnosticLocksOnly();
    });
    observer.observe(document.documentElement, { subtree:true, childList:true });

    let attempts = 0;
    const timer = setInterval(() => {
      neutralizeApi();
      hideNode(document.documentElement);
      releaseDiagnosticLocksOnly();
      attempts += 1;
      if (attempts >= 30) clearInterval(timer);
    }, 1000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once:true });
  } else {
    start();
  }
})();
