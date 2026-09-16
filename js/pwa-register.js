/* EXPLORA PWA registration · v4145 · Acciones financieras en Últimas actividades */
(() => {
  'use strict';
  if (!('serviceWorker' in navigator)) return;

  const BUILD = 'v4145-activity-receipt-actions';

  const clearLegacyCaches = async () => {
    try {
      if (!('caches' in window)) return;
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((key) => key.startsWith('explora-pwa-') && !key.includes(BUILD))
        .map((key) => caches.delete(key)));
    } catch (error) {
      console.warn('[EXPLORA_PWA_CACHE_CLEAR_WARN]', error);
    }
  };

  const register = async () => {
    try {
      await clearLegacyCaches();
      const registration = await navigator.serviceWorker.register(`./service-worker.js?build=${BUILD}`, {
        scope: './',
        updateViaCache: 'none'
      });

      const activateWaiting = () => {
        if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      };

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed') activateWaiting();
        });
      });

      activateWaiting();
      registration.update().catch(() => {});

      // Antes se ejecutaba window.location.reload() en cada controllerchange.
      // En iOS/Android eso podía reconstruir la app, volver a mostrar el login y
      // repetir el arranque. Ahora la actualización queda activa sin interrumpir
      // la sesión; la nueva versión se utiliza naturalmente en la próxima apertura.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.__EXPLORA_SW_UPDATE_READY__ = true;
        window.dispatchEvent(new CustomEvent('explora:service-worker-updated', {
          detail: { build: BUILD, reloadRequired: false }
        }));
      });

      window.setInterval(() => {
        registration.update().catch(() => {});
      }, 30 * 60 * 1000);
    } catch (error) {
      console.error('[EXPLORA_PWA_REGISTRATION_ERROR]', error);
    }
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
})();
