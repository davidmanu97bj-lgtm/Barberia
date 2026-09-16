
    (() => {
      "use strict";
      const nav = document.getElementById("mainBottomNav");
      if (!nav) return;

      function closeInternalScreensExcept(except = "") {
        const registry = [
          ["new-service", "newServiceScreen", () => window.ExploraNewService?.close?.()],
          ["derivations", "derivationScreen", () => window.ExploraDerivations?.close?.()],
          ["receipts", "receiptsScreen", () => window.ExploraReceipts?.close?.()],
          ["profile", "profileScreen", () => document.getElementById("profileBackBtn")?.click?.()],
          ["performance", "performanceScreen", () => window.ExploraPerformanceEngine?.close?.()],
          ["admin-shared", "adminSharedScreen", () => window.ExploraAdminShared?.close?.()]
        ];
        registry.forEach(([name, id, closer]) => {
          if (name === except) return;
          const element = document.getElementById(id);
          if (!element?.classList.contains("is-open")) return;
          try { closer(); } catch (_) {
            element.classList.remove("is-open");
            element.setAttribute("aria-hidden", "true");
          }
        });
      }

      function navigateMain(section) {
        if (section === "inicio") {
          closeInternalScreensExcept("");
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        if (section === "metas" || section === "performance") {
          closeInternalScreensExcept("performance");
          window.ExploraPerformanceEngine?.open?.("ranking");
          return;
        }
        if (section === "derivaciones-performance") {
          closeInternalScreensExcept("performance");
          window.ExploraPerformanceEngine?.open?.("derivations");
        }
      }

      nav.addEventListener("click", event => {
        const goal = event.target.closest("[data-performance-goal]");
        if (goal) {
          window.ExploraPerformanceEngine?.open?.("ranking");
          return;
        }
      });

      window.ExploraMainNav = {
        setActive(section = "inicio") {
          window.dispatchEvent(new CustomEvent("explora:main-nav-active", { detail: { section } }));
        },
        navigate: navigateMain,
        closeInternalScreensExcept
      };
    })();
  