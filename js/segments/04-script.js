
    (() => {
      "use strict";

      const app = document.getElementById("app");
      const toast = document.getElementById("toast");
      const backdrop = document.getElementById("dialogBackdrop");
      const dialogTitle = document.getElementById("dialogTitle");
      const dialogText = document.getElementById("dialogText");
      const dialogCancel = document.getElementById("dialogCancel");
      const dialogAccept = document.getElementById("dialogAccept");

      let toastTimer = null;
      let pendingAction = null;

      const labels = {
        "abrir-perfil": ["Mi perfil", "Información personal y cuenta."],
        "notificaciones": ["Notificaciones", "Consulta tus avisos operativos actuales."],
        "salir": ["Cerrar sesión", "¿Deseas salir de tu cuenta de EXPLORA?"],
        "estado-al-dia": ["Estado al día", "Todo está en orden y no hay acciones pendientes."],
        "carga-comprobante": ["Carga de comprobante", "Aquí se conectará el formulario para subir el comprobante de pago."],
        "ver-ranking": ["Ranking diario", "Abriendo el ranking diario de EXPLORA."],
        "ranking-actual": ["Ranking diario actual", "Abriendo el ranking diario de la semana activa."],
        "nuevo-servicio": ["Registrar cobro", "Registra un monto facturado según el medio de pago."],
        "cargar-gastos": ["Cargar gastos", "Registra un gasto con su comprobante."],
        "derivar-servicio": ["Derivar servicio", "Envía un concepto y un monto sugerido a otro chofer de EXPLORA."],
        "detalle-financiero": ["Detalle financiero", "Aquí se mostrará el resumen económico completo."],
        "facturacion-semanal": ["Facturación semanal", "Abriendo el detalle de la semana activa."],
        "gastos-semanales": ["Gastos semanales", "Abriendo los gastos reales de la semana activa."],
        "comprobantes": ["Comprobantes", "Aquí se listarán y gestionarán los comprobantes."],
        "resumen-servicios": ["Cobros registrados", "Abriendo los cobros reales de la semana activa."],
        "resumen-comprobantes": ["Resumen de comprobantes", "Abriendo los comprobantes registrados."],
        "resumen-gastos": ["Gastos semanales", "Abriendo los gastos reales de la semana activa."],
        "objetivo-semanal": ["Ranking diario", "Consulta los resultados diarios calculados con datos reales."],
        "nav-dashboard": ["Dashboard", "Ya estás en el Dashboard."],
        "nav-operaciones": ["Operaciones", "La pantalla de Operaciones se conectará más adelante."],
        "nav-finanzas": ["Finanzas", "La pantalla de Finanzas se conectará más adelante."],
        "nav-comprobantes": ["Comprobantes", "La pantalla central de comprobantes se conectará más adelante."],
        "nav-perfil": ["Perfil", "La pantalla de Perfil se conectará más adelante."]
      };

      /*
        Punto de integración:
        Asigna funciones desde otro script, por ejemplo:

        window.ExploraActions["nuevo-servicio"] = () => {
          window.location.href = "nuevo-servicio.html";
        };
      */
      window.ExploraActions = window.ExploraActions || {};

      function showToast(message) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.add("show");
        toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
      }

      function openDialog(action) {
        pendingAction = action;
        const content = labels[action] || ["EXPLORA", "Función preparada para conectar más adelante."];
        dialogTitle.textContent = content[0];
        dialogText.textContent = content[1];
        backdrop.classList.add("open");
        dialogAccept.focus();
      }

      function closeDialog() {
        backdrop.classList.remove("open");
        pendingAction = null;
      }

      function setActiveNavigation(button) {
        document.querySelectorAll(".hotspot").forEach(item => {
          item.removeAttribute("aria-current");
        });
        button.setAttribute("aria-current", "page");
      }

      function dispatchAction(action, button) {
        setActiveNavigation(button);

        const customHandler = window.ExploraActions[action];

        if (typeof customHandler === "function") {
          customHandler({ action, button });
          return;
        }

        if (action === "driver-status" && typeof window.ExploraWeeklyClosure?.open === "function") {
          window.ExploraWeeklyClosure.open();
          return;
        }

        if (action.startsWith("nav-")) {
          showToast(labels[action]?.[0] || "Sección seleccionada");
          return;
        }

        openDialog(action);
      }

      app.addEventListener("click", event => {
        const button = event.target.closest("[data-action]");
        if (!button) return;
        dispatchAction(button.dataset.action, button);
      });

      dialogCancel.addEventListener("click", closeDialog);

      dialogAccept.addEventListener("click", () => {
        const title = labels[pendingAction]?.[0] || "Acción";
        closeDialog();
        showToast(title + ": función lista para conectar.");
      });

      backdrop.addEventListener("click", event => {
        if (event.target === backdrop) closeDialog();
      });

      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && backdrop.classList.contains("open")) {
          closeDialog();
        }
      });

      const params = new URLSearchParams(location.search);
      if (params.get("hotspots") === "1") {
        app.classList.add("debug");
      }
    })();
  