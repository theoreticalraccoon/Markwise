// Hash router, since the app is static and may run from disk or a subpath.
// A route's render() can return a cleanup fn, called before the next one mounts.

import { esc } from "./ui/dom.js";

const routes = new Map();

/** Bumped on every navigation, so a slow render can tell it has been replaced. */
let navToken = 0;
let current = null;
let cleanup = null;
let container = null;

export function defineRoute(name, module) {
  routes.set(name, module);
}

export function setOutlet(el) {
  container = el;
}

/** '#/mock/abc?x=1' → { name:'mock', segments:['abc'], query:{x:'1'} } */
export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, "");
  const [path, search = ""] = raw.split("?");
  const segments = path.split("/").filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(search));
  return { name: segments[0] || "planner", segments: segments.slice(1), query };
}

export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith("#") ? path : `#/${path.replace(/^\/+/, "")}`;
  if (location.hash === target) {
    handleRoute();
    return;
  }
  if (replace) {
    // replaceState doesn't fire hashchange, so render explicitly.
    history.replaceState(null, "", target);
    handleRoute();
  } else {
    location.hash = target;   // hashchange drives the render
  }
}

// Delegated listeners pile up on a reused outlet (three visits, three clicks
// per click). A fresh element each navigation starts clean.
function freshOutlet() {
  const next = container.cloneNode(false);
  container.replaceWith(next);
  container = next;
  return next;
}

export async function handleRoute() {
  if (!container) return;
  const { name, segments, query } = parseHash();
  const module = routes.get(name) ?? routes.get("planner");
  if (!module) return;

  const id = ++navToken;

  // Same route, different params: let the view decide rather than remounting.
  const sameRoute = current === name;
  if (!sameRoute) {
    cleanup?.();
    cleanup = null;
  } else if (cleanup) {
    // The old outlet is going, so its timers and listeners go too.
    cleanup();
    cleanup = null;
  }

  current = name;
  document.body.dataset.route = name;
  markActiveNav(name);

  const outlet = freshOutlet();

  try {
    const result = await module.render(outlet, { segments, query, sameRoute });

    // Navigated away while loading; only cleanup matters now.
    if (id !== navToken) {
      if (typeof result === "function") result();
      return;
    }
    if (typeof result === "function") cleanup = result;

    // Move focus to the new page unless the view already placed it.
    if (document.activeElement === document.body || !outlet.contains(document.activeElement)) {
      if (!outlet.contains(document.activeElement) && document.activeElement?.tagName !== "INPUT") {
        outlet.focus({ preventScroll: true });
      }
    }
  } catch (e) {
    console.error(`Route "${name}" failed`, e);
    if (id === navToken) {
      outlet.innerHTML = `<div class="empty error"><h3>This page failed to load</h3><p>${esc(e.message ?? "")}</p></div>`;
    }
  }
}

function markActiveNav(name) {
  document.querySelectorAll("[data-nav]").forEach((el) => {
    const active = el.dataset.nav === name;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}

export function startRouter() {
  window.addEventListener("hashchange", handleRoute);
  handleRoute();
}

export function stopRouter() {
  window.removeEventListener("hashchange", handleRoute);
  cleanup?.();
  cleanup = null;
  current = null;
}

export function currentRoute() {
  return current;
}
