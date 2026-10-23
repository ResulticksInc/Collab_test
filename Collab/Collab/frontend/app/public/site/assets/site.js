/* Collab marketing site — shared behavior. Framework-free, ~1KB. */
(function () {
  /* ------------------------------------------------------------------ *
   * CONFIG — set these to your live deployment.
   *   APP_ORIGIN : where the Collab web app is hosted (Sign In / Open Collab
   *                / Help / Privacy / Terms all point here).
   * ------------------------------------------------------------------ */
  var APP_ORIGIN = "https://collab.resulticks.com";

  // Point every [data-app-link] at the app. Sign In deep-links to the app root
  // (which shows the login); the others open the app too — repoint if you add
  // dedicated /help, /privacy, /terms pages on the app.
  document.querySelectorAll("[data-app-link]").forEach(function (a) {
    a.setAttribute("href", APP_ORIGIN);
  });
  // Download page: build real desktop URLs from APP_ORIGIN (files live under
  // <app>/desktop/…). Only elements that exist on that page are touched.
  document.querySelectorAll("[data-dl]").forEach(function (a) {
    a.setAttribute("href", APP_ORIGIN + a.getAttribute("data-dl"));
  });

  // The hrefs above are only the FALLBACK baked into the page. The source of truth
  // is <app>/desktop/latest.json — the same manifest the desktop auto-updater and
  // the in-app download modal read — so a new release never needs a site edit.
  // Any failure (offline, CORS, bad JSON) leaves the baked-in links in place.
  if (document.querySelector("[data-dl], [data-dl-version]")) {
    fetch(APP_ORIGIN + "/desktop/latest.json?_=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (m) {
        var ch = (m && m.channels) || {};
        var win = ch.windows && ch.windows.x64;
        var mac = ch.mac && (ch.mac.universal || ch.mac.x64);
        var urls = {
          "win-installer": win && win.installer,
          "win-portable": win && win.portable,
          "mac-installer": mac && mac.installer
        };
        document.querySelectorAll("[data-dl-key]").forEach(function (a) {
          var u = urls[a.getAttribute("data-dl-key")];
          if (u) a.setAttribute("href", /^https?:/i.test(u) ? u : APP_ORIGIN + u);
        });
        if (m && m.version) {
          document.querySelectorAll("[data-dl-version]").forEach(function (el) {
            el.textContent = m.version;
          });
        }
      })
      .catch(function () { /* keep the fallback links */ });
  }

  /* ---- Theme toggle (persists; defaults to LIGHT, not OS preference) ---- */
  var root = document.documentElement;
  // The <head> inline script already sets data-theme before first paint (no dark
  // flash). This is the belt-and-suspenders fallback: default light, saved wins.
  try {
    root.setAttribute("data-theme", localStorage.getItem("collab-theme") || "light");
  } catch (e) { root.setAttribute("data-theme", "light"); }
  var toggle = document.getElementById("themeToggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var cur =
        root.getAttribute("data-theme") ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      var next = cur === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("collab-theme", next); } catch (e) {}
    });
  }

  /* ---- Mobile nav ---- */
  var burger = document.getElementById("navBurger");
  var links = document.getElementById("navLinks");
  if (burger && links) {
    burger.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") { links.classList.remove("open"); burger.setAttribute("aria-expanded", "false"); }
    });
  }

  /* ---- Reveal on scroll ---- */
  var els = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    els.forEach(function (el) { io.observe(el); });
  } else {
    els.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---- Footer year ---- */
  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();
})();
