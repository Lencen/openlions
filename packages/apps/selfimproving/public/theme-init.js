// LIONS 主题 — inline head script 防止 FOUC + 立即同步 React state
(function() {
  try {
    var params = new URLSearchParams(window.location.search);
    var urlT = params.get("theme");
    var mode = "dark";
    if (urlT && (urlT === "dark" || urlT === "light" || urlT === "system")) {
      mode = urlT;
      try { localStorage.setItem("lions-theme-mode", urlT); } catch (e) {}
    } else {
      var saved = null;
      try { saved = localStorage.getItem("lions-theme-mode"); } catch (e) {}
      if (saved && (saved === "dark" || saved === "light" || saved === "system")) mode = saved;
    }
    if (mode === "system") {
      var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
      mode = (mq && mq.matches) ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", mode);
    // 立刻触发 custom event, 让 React useTheme 同步
    setTimeout(function() {
      try { window.dispatchEvent(new CustomEvent("lions-theme-ready", { detail: { mode: mode } })); } catch (e) {}
    }, 0);
  } catch (err) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
