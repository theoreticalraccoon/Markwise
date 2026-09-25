// Bootstrap: auth gate, catalogue load, router. Sign-in, password recovery
// and onboarding render outside the router, without the app shell.

import { byId, on } from "./ui/dom.js";
import { toast } from "./ui/feedback.js";
import { sb } from "./api/client.js";
import { store, reset, loadPrefs } from "./store.js";
import { loadCatalogue, loadProfile, loadAdmin } from "./api/data.js";
import { initTheme } from "./theme.js";
import { clearOfflineWork } from "./lib/offline.js";
import { defineRoute, setOutlet, startRouter, navigate, handleRoute } from "./router.js";
import { renderAuth, renderRecovery, renderOnboarding } from "./views/auth.js";

import * as planner from "./views/planner.js";
import * as calendar from "./views/calendar.js";
import * as assistant from "./views/assistant.js";
import * as library from "./views/library.js";
import * as recall from "./views/recall.js";
import * as mock from "./views/mock.js";
import * as markpaper from "./views/markpaper.js";
import * as papers from "./views/papers.js";
import * as progress from "./views/progress.js";
import * as settings from "./views/settings.js";

defineRoute("planner", planner);
defineRoute("calendar", calendar);
defineRoute("assistant", assistant);
defineRoute("library", library);
defineRoute("recall", recall);
defineRoute("mock", mock);
defineRoute("markpaper", markpaper);
defineRoute("papers", papers);
defineRoute("progress", progress);
defineRoute("settings", settings);

let recoveryActive = false;
let routerStarted = false;

/* ---------------------------------------------------------------- screens -- */

function show(screen) {
  for (const id of ["authScreen", "recoveryScreen", "onboardScreen", "appShell"]) {
    byId(id).hidden = id !== screen;
  }
  document.body.classList.toggle("signed-in", screen === "appShell");
}

function showAuth() {
  clearOfflineWork();
  reset();
  resetViews();
  show("authScreen");
  renderAuth();
}

// Clear per-view state on sign-out, or the next person sees the last one's chat.
function resetViews() {
  for (const view of [planner, calendar, recall, assistant, library, markpaper, progress]) {
    view.invalidate?.();
  }
}

let booting = null;

async function showApp(user) {
  // onAuthStateChange and getSession() both fire on load; only boot once.
  if (booting) return booting;
  booting = doShowApp(user).finally(() => { booting = null; });
  return booting;
}

async function doShowApp(user) {
  if (store.user && store.user.id !== user.id) clearOfflineWork();
  store.user = user;
  show("appShell");
  byId("userEmail").textContent = user.email ?? "";

  try {
    await loadCatalogue();
    await loadProfile(user.id);
    await loadAdmin(user.id).catch(() => {});
  } catch (e) {
    toast(e.message, "error");
  }

  if (!store.mySubjects.length) {
    show("onboardScreen");
    renderOnboarding(() => {
      show("appShell");
      boot();
    });
    return;
  }
  boot();
}

function boot() {
  resetViews();
  if (!routerStarted) {
    setOutlet(byId("outlet"));
    startRouter();
    routerStarted = true;
  } else {
    // Re-render in place so a reload keeps #/mock/<id> rather than #/mock.
    handleRoute();
  }
}

/* ------------------------------------------------------------------ shell -- */

function wireShell() {
  on(document, "click", "[data-nav]", (e, el) => {
    e.preventDefault();
    navigate(el.dataset.nav);
    byId("appShell").classList.remove("nav-open");
    byId("navToggle").setAttribute("aria-expanded", "false");
  });

  byId("navToggle").addEventListener("click", (e) => {
    const open = byId("appShell").classList.toggle("nav-open");
    e.currentTarget.setAttribute("aria-expanded", String(open));
  });

  byId("signOut").addEventListener("click", async () => {
    await sb.auth.signOut().catch(() => {});
  });

  // Keyboard shortcuts: single letters, only when not typing.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!byId("appShell") || byId("appShell").hidden) return;
    if (!byId("modalOverlay").hidden) return;

    // Keep in step with the sidebar and README.
    const routes = {
      p: "planner",
      c: "calendar",
      a: "assistant",
      l: "library",
      r: "recall",
      m: "mock",
      k: "markpaper",
      g: "progress",
    };
    const target = routes[e.key.toLowerCase()];
    if (target) {
      e.preventDefault();
      navigate(target);
    }
  });
}

/* ------------------------------------------------------------------ start -- */

(async function start() {
  initTheme();
  loadPrefs();
  wireShell();
  registerServiceWorker();

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      recoveryActive = true;
      show("recoveryScreen");
      renderRecovery((user) => {
        recoveryActive = false;
        cleanUrl();
        if (user) showApp(user);
        else showAuth();
      });
      return;
    }
    if (recoveryActive) return;

    if (session?.user) {
      if (!store.user || store.user.id !== session.user.id) showApp(session.user);
    } else {
      showAuth();
    }
  });

  const isRecovery = /type=recovery/.test(location.hash) || /type=recovery/.test(location.search);

  try {
    const { data } = await sb.auth.getSession();
    if (recoveryActive) return;
    if (isRecovery && data.session) {
      recoveryActive = true;
      show("recoveryScreen");
      renderRecovery((user) => {
        recoveryActive = false;
        cleanUrl();
        if (user) showApp(user);
        else showAuth();
      });
      return;
    }
    if (data.session?.user) await showApp(data.session.user);
    else showAuth();
  } catch (e) {
    console.error(e);
    showAuth();
  }
})();

function cleanUrl() {
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {
    /* ignore */
  }
}

// Cache the shell so the app opens offline. Skipped on file://, never fatal.
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => {
      console.warn("Service worker not registered:", e.message);
    });
  });
}
