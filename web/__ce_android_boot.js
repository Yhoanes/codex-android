(function () {
  "use strict";

  if (window.__CE_ANDROID_BOOTED__) return;
  window.__CE_ANDROID_BOOTED__ = true;

  var IS_SUBPANEL = Boolean(window.__CE_IS_SUBPANEL__);
  var BRIDGE_TOKEN = window.__CE_BRIDGE_TOKEN__ || "";
  try {
    delete window.__CE_BRIDGE_TOKEN__;
  } catch (_) {
    window.__CE_BRIDGE_TOKEN__ = undefined;
  }

  var INITIAL_THEME = window.__CE_HOST_THEME__ || "dark";
  var currentTheme = INITIAL_THEME === "light" ? "light" : "dark";
  var currentWorkspace = normalizeWsPath(window.__CE_INITIAL_WORKSPACE__ || "/storage/emulated/0/Documents/Codex");
  var pendingCallbacks = Object.create(null);
  var cbCounter = 0;
  var suppressPopStateCount = 0;
  var overlayHistoryDepth = 0;
  var isEs = /^es\b/i.test(navigator.language || "es");

  function normalizeWsPath(p) {
    var s = String(p || "").trim().replace(/\\/g, "/");
    if (!s) return "/storage/emulated/0/Documents/Codex";
    s = s.replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0");
    if (s.length > 1) s = s.replace(/\/+$/, "");
    return s || "/";
  }

  function basename(p) {
    if (!p || p === "/") return "/";
    var clean = String(p).replace(/\/+$/, "");
    var idx = clean.lastIndexOf("/");
    return idx >= 0 ? clean.slice(idx + 1) : clean;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function nextCallbackId(prefix) {
    return (prefix || "ce_cb_") + (++cbCounter) + "_" + Date.now();
  }

  function handlePluginOpDone(cbId, resJson) {
    var fn = pendingCallbacks[cbId];
    if (fn) {
      delete pendingCallbacks[cbId];
      var parsed = {};
      try { parsed = typeof resJson === "string" ? JSON.parse(resJson) : (resJson || {}); } catch (_) {}
      fn(parsed);
    }
  }
  window.__ceOnPluginOpDone = handlePluginOpDone;

  function handleDirectoryPicked(cbId, pickedPath) {
    var fn = pendingCallbacks[cbId];
    if (fn) {
      delete pendingCallbacks[cbId];
      fn(pickedPath || "");
    }
  }
  window.__ceOnDirectoryPicked = handleDirectoryPicked;

  function getBridge() {
    return window.Android || window.AndroidBridge || null;
  }

  function registerTimedCallback(prefix, timeoutMs, onResult, fallbackVal) {
    var cbId = nextCallbackId(prefix);
    var timer = setTimeout(function () {
      if (pendingCallbacks[cbId]) {
        delete pendingCallbacks[cbId];
        if (onResult) onResult(fallbackVal);
      }
    }, timeoutMs);
    pendingCallbacks[cbId] = function (res) {
      clearTimeout(timer);
      if (onResult) onResult(res);
    };
    return cbId;
  }

  // Same-origin RPC bridge so Official Codex Settings subpanel iframe can invoke AndroidBridge securely
  if (!IS_SUBPANEL) {
    window.__CE_HOST_RPC__ = {
      openUrl: function (url) {
        var b = getBridge();
        if (b && typeof b.openUrlAuth === "function" && BRIDGE_TOKEN) {
          b.openUrlAuth(BRIDGE_TOKEN, url);
        } else {
          window.open(url, "_blank");
        }
      },
      hasDirectoryPicker: function () {
        var b = getBridge();
        return Boolean(b && typeof b.pickProjectDirectoryAuth === "function" && BRIDGE_TOKEN);
      },
      pickDirectory: function (cb) {
        var b = getBridge();
        if (b && typeof b.pickProjectDirectoryAuth === "function" && BRIDGE_TOKEN) {
          var cbId = registerTimedCallback("dir_", 120000, function (picked) {
            if (cb) cb(picked || "");
          }, "");
          b.pickProjectDirectoryAuth(BRIDGE_TOKEN, cbId);
          return true;
        }
        return false;
      },
      installPlugin: function (name, archiveUrl, version, sha256, cb) {
        var b = getBridge();
        if (b && typeof b.installMarketplacePluginAsync === "function" && BRIDGE_TOKEN) {
          var cbId = registerTimedCallback("inst_", 120000, function (res) {
            if (cb) cb(res || { ok: false, error: isEs ? "Tiempo de espera agotado" : "Timed out" });
          }, { ok: false, error: isEs ? "Tiempo de espera agotado" : "Timed out" });
          b.installMarketplacePluginAsync(
            BRIDGE_TOKEN,
            cbId,
            name,
            archiveUrl || "",
            sha256 || "",
            "android-arm64",
            version || "1.0.0"
          );
          return true;
        }
        return false;
      },
      togglePlugin: function (name, enable, cb) {
        var b = getBridge();
        if (b && typeof b.toggleAndroidPluginAsync === "function" && BRIDGE_TOKEN) {
          var cbId = registerTimedCallback("tog_", 60000, function (res) {
            if (cb) cb(res || { ok: false });
          }, { ok: false });
          b.toggleAndroidPluginAsync(BRIDGE_TOKEN, cbId, name, Boolean(enable));
          return true;
        }
        return false;
      },
      uninstallPlugin: function (name, cb) {
        var b = getBridge();
        if (b && typeof b.uninstallMarketplacePluginAsync === "function" && BRIDGE_TOKEN) {
          var cbId = registerTimedCallback("uninst_", 60000, function (res) {
            if (cb) cb(res || { ok: false });
          }, { ok: false });
          b.uninstallMarketplacePluginAsync(BRIDGE_TOKEN, cbId, name);
          return true;
        }
        return false;
      },
      getUpdateState: function () {
        var b = getBridge();
        if (b && typeof b.getUpdateStateJson === "function") {
          try {
            return JSON.parse(b.getUpdateStateJson() || '{"type":"idle"}');
          } catch (_) {}
        }
        return { type: "idle" };
      },
      checkForUpdates: function (manual) {
        var b = getBridge();
        if (b && typeof b.checkForAppUpdates === "function") {
          try {
            b.checkForAppUpdates(Boolean(manual));
            return true;
          } catch (_) {}
        }
        return false;
      },
      applyUpdate: function () {
        var b = getBridge();
        if (b && typeof b.applyAppUpdateAuth === "function" && BRIDGE_TOKEN) {
          try {
            b.applyAppUpdateAuth(BRIDGE_TOKEN);
            return true;
          } catch (_) {}
        }
        return false;
      },
      notifyWorkspaceChanged: function (ws) {
        setWorkspaceState(ws);
      }
    };
  }

  function getHostRpc() {
    try {
      if (window.__CE_HOST_RPC__) return window.__CE_HOST_RPC__;
      if (window.top && window.top.__CE_HOST_RPC__) return window.top.__CE_HOST_RPC__;
    } catch (_) {}
    return null;
  }

  function applyResolvedTheme(mode) {
    currentTheme = mode === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-ce-theme", currentTheme);
    document.documentElement.setAttribute("data-vscode-theme-kind", currentTheme === "light" ? "vscode-light" : "vscode-dark");
    document.body.classList.remove("vscode-dark", "vscode-light");
    document.body.classList.add(currentTheme === "light" ? "vscode-light" : "vscode-dark");
    if (!IS_SUBPANEL) {
      var b = getBridge();
      if (b && typeof b.onVisualThemeChanged === "function") {
        try { b.onVisualThemeChanged(currentTheme); } catch (_) {}
      }
      if (subFrameEl && subFrameEl.contentWindow && subFrameEl.contentWindow.__ceApplyThemeFromParent) {
        try { subFrameEl.contentWindow.__ceApplyThemeFromParent(currentTheme); } catch (_) {}
      }
    }
  }
  window.__ceApplyThemeFromParent = applyResolvedTheme;

  window.__ceOnSystemThemeChanged = function () {
    if (window.__CE_RESOLVED_THEME__) {
      applyResolvedTheme(window.__CE_RESOLVED_THEME__);
    }
  };

  function apiGet(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function apiPost(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function pushOverlayHistory(kind) {
    try {
      window.history.pushState({ __ceOverlay: kind }, "", window.location.href);
      overlayHistoryDepth++;
    } catch (_) {}
  }

  function popOverlayHistory() {
    if (overlayHistoryDepth <= 0) return;
    overlayHistoryDepth--;
    suppressPopStateCount++;
    try {
      window.history.back();
    } catch (_) {
      suppressPopStateCount = Math.max(0, suppressPopStateCount - 1);
    }
  }

  var SVG = {
    folder14: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><path d="M2 4.2C2 3.54 2.54 3 3.2 3H6.15C6.47 3 6.78 3.13 7 3.35L7.85 4.2H12.8C13.46 4.2 14 4.74 14 5.4V11.8C14 12.46 13.46 13 12.8 13H3.2C2.54 13 2 12.46 2 11.8V4.2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    folderPlus15: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><path d="M2 4.2C2 3.54 2.54 3 3.2 3H6.15L7.85 4.2H12.8C13.46 4.2 14 4.74 14 5.4V11.8C14 12.46 13.46 13 12.8 13H3.2C2.54 13 2 12.46 2 11.8V4.2Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M8 6.8V10.4M6.2 8.6H9.8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
    folderOpen15: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><path d="M2 4.2C2 3.54 2.54 3 3.2 3H6.1L7.6 4.2H12.8C13.46 4.2 14 4.74 14 5.4V6.5M2 4.2V12L3.6 7.2H14.3L12.7 12H2Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>',
    chevDown11: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;opacity:0.7"><path d="M4.25 6.25L8 10L11.75 6.25" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevRight14: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check14: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><path d="M3.5 8.4L6.6 11.5L12.6 4.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close16: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    back16: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3.5L5.5 8L10 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    up15: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 12.5V3.5M8 3.5L4.5 7M8 3.5L11.5 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pluginIcon: function (kind) {
      if (kind === "github") {
        return '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>';
      }
      if (kind === "binary") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="3" y="3" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/><rect x="11" y="11" width="6" height="6" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M14 3V9M11 6H17M6 11V17" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      }
      if (kind === "terminal") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M6 7.5L9 10L6 12.5M10.5 12.5H14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      if (kind === "gamepad") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="2" y="5.5" width="16" height="9.5" rx="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M6.5 8.5V12M4.75 10.25H8.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="13" cy="9.2" r="1" fill="currentColor"/><circle cx="14.8" cy="11" r="1" fill="currentColor"/></svg>';
      }
      if (kind === "cube") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2.5L16.8 6.4V13.6L10 17.5L3.2 13.6V6.4L10 2.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 10V17.5M10 10L16.8 6.4M10 10L3.2 6.4" stroke="currentColor" stroke-width="1.35"/></svg>';
      }
      if (kind === "video") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="2.5" y="4.5" width="11" height="11" rx="2.2" stroke="currentColor" stroke-width="1.4"/><path d="M13.5 8.4L17.5 6V14L13.5 11.6" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      }
      if (kind === "sparkles") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2.5L11.7 7.6L16.8 9.3L11.7 11L10 16.1L8.3 11L3.2 9.3L8.3 7.6L10 2.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      }
      if (kind === "globe") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M3.2 10H16.8M10 3C11.9 5 12.8 7.4 12.8 10C12.8 12.6 11.9 15 10 17C8.1 15 7.2 12.6 7.2 10C7.2 7.4 8.1 5 10 3Z" stroke="currentColor" stroke-width="1.3"/></svg>';
      }
      if (kind === "shield") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 2.5L16.2 5V9.8C16.2 13.7 13.5 16.4 10 17.6C6.5 16.4 3.8 13.7 3.8 9.8V5L10 2.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M7.5 10L9.3 11.8L12.8 8.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      if (kind === "scissors") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="6" cy="6" r="2.3" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="14" r="2.3" stroke="currentColor" stroke-width="1.4"/><path d="M8 7.4L16.5 14.5M8 12.6L16.5 5.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      }
      if (kind === "flask") {
        return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M7.5 3H12.5M8.5 3V7.4L4.2 14.6C3.7 15.5 4.3 16.6 5.4 16.6H14.6C15.7 16.6 16.3 15.5 15.8 14.6L11.5 7.4V3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 12.5H14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
      }
      return '<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="5" y="2.5" width="10" height="15" rx="2.2" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="14.7" r="0.9" fill="currentColor"/></svg>';
    }
  };

  function injectStyles() {
    if (document.getElementById("ce-native-styles")) return;
    var st = document.createElement("style");
    st.id = "ce-native-styles";
    st.textContent = [
      /* Pure Official Codex Edge-to-Edge */
      "#root { position: fixed !important; inset: 0 !important; width: 100% !important; height: 100% !important; }",

      /* 1. Native Composer Workspace Pill (44px accessible hit area via ::after while keeping native compact row height) */
      ".ce-composer-ws-slot { display: inline-flex; align-items: center; gap: 5px; min-width: 0; flex-shrink: 1; }",
      ".ce-cmp-div { width: 1px; height: 13px; background: rgba(128, 128, 128, 0.24); flex-shrink: 0; margin: 0 1px; }",
      ".ce-cmp-ws-btn { position: relative; display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px; border: none; border-radius: 9999px; background: transparent; color: var(--vscode-descriptionForeground, #9b9b9b); font-family: inherit; font-size: 13px; font-weight: 400; line-height: 1; cursor: pointer; min-width: 0; max-width: 152px; transition: background 0.12s ease, color 0.12s ease; }",
      ".ce-cmp-ws-btn::after { content: ''; position: absolute; inset: -8px -4px; }",
      ".ce-cmp-ws-btn:hover, .ce-cmp-ws-btn.open { background: rgba(128, 128, 128, 0.12); color: var(--vscode-foreground, #ececec); }",
      ".ce-cmp-ws-lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }",

      /* Native OpenAI Radix-Style Floating Workspace Popover */
      "#ce-ws-popover { position: fixed; z-index: 9500; min-width: 244px; max-width: min(316px, calc(100vw - 24px)); padding: 5px; border-radius: 14px; background: #1f1f1f; color: #ececec; border: 1px solid rgba(255, 255, 255, 0.10); box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55); font-family: var(--vscode-font-family, -apple-system, sans-serif); font-size: 13.5px; display: none; flex-direction: column; gap: 1px; transform-origin: bottom left; animation: cePopIn 0.12s cubic-bezier(0.16, 1, 0.3, 1); box-sizing: border-box; }",
      "html[data-ce-theme='light'] #ce-ws-popover { background: #ffffff; color: #0d0d0d; border-color: rgba(0, 0, 0, 0.10); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.16); }",
      "#ce-ws-popover.open { display: flex; }",
      "@keyframes cePopIn { from { opacity: 0; transform: translateY(4px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }",
      ".ce-pop-sec { padding: 6px 10px 4px; font-size: 11.5px; font-weight: 500; color: #8e8e8e; user-select: none; }",
      ".ce-pop-list { max-height: 210px; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; -webkit-overflow-scrolling: touch; }",
      ".ce-pop-item { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 40px; padding: 0 10px; border: none; border-radius: 9px; background: transparent; color: inherit; font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; box-sizing: border-box; }",
      ".ce-pop-item:hover, .ce-pop-item:active { background: rgba(128, 128, 128, 0.14); }",
      ".ce-pop-item-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".ce-pop-sep { height: 1px; margin: 4px 6px; background: rgba(128, 128, 128, 0.16); }",
      ".ce-pop-inline-box { padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }",
      ".ce-pop-hint { font-size: 11px; color: #8e8e8e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".ce-pop-inp { width: 100%; min-height: 38px; box-sizing: border-box; padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(128, 128, 128, 0.28); background: rgba(0, 0, 0, 0.22); color: inherit; font: inherit; font-size: 13.5px; outline: none; }",
      "html[data-ce-theme='light'] .ce-pop-inp { background: rgba(0, 0, 0, 0.04); }",
      ".ce-pop-inp:focus { border-color: #ececec; }",
      "html[data-ce-theme='light'] .ce-pop-inp:focus { border-color: #0d0d0d; }",

      /* 2. Native OpenAI Card-Tile ARM64 Marketplace inside Codex Settings (MCP / Plugins) */
      "#ce-arm64-market-section { margin-top: 22px; padding-bottom: 28px; display: flex; flex-direction: column; gap: 10px; font-family: inherit; }",
      ".ce-mkt-hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 2px; }",
      ".ce-mkt-title-wrap { display: inline-flex; align-items: center; gap: 8px; }",
      ".ce-mkt-title { font-size: 13.5px; font-weight: 500; color: var(--vscode-foreground, #ececec); }",
      ".ce-mkt-count { display: inline-flex; align-items: center; justify-content: center; padding: 1px 7px; border-radius: 999px; font-size: 11.5px; background: rgba(128, 128, 128, 0.16); color: var(--vscode-descriptionForeground, #9b9b9b); }",
      ".ce-mkt-sub { font-size: 12.5px; color: var(--vscode-descriptionForeground, #9b9b9b); margin: -4px 0 4px; }",
      ".ce-mkt-grid { display: flex; flex-direction: column; gap: 8px; }",
      ".ce-mkt-card { border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.09); background: rgba(255, 255, 255, 0.015); transition: background 0.14s ease, border-color 0.14s ease; overflow: hidden; }",
      "html[data-ce-theme='light'] .ce-mkt-card { border-color: rgba(0, 0, 0, 0.09); background: rgba(0, 0, 0, 0.015); }",
      ".ce-mkt-card:hover { background: rgba(128, 128, 128, 0.06); }",
      ".ce-mkt-row { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 12px 14px; cursor: pointer; user-select: none; box-sizing: border-box; }",
      ".ce-mkt-ico { width: 36px; height: 36px; border-radius: 10px; background: rgba(128, 128, 128, 0.12); color: var(--vscode-foreground, #ececec); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }",
      ".ce-mkt-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }",
      ".ce-mkt-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }",
      ".ce-mkt-name { font-size: 14px; font-weight: 500; color: var(--vscode-foreground, #ececec); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".ce-mkt-desc { font-size: 12.5px; color: var(--vscode-descriptionForeground, #9b9b9b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".ce-mkt-right { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; }",
      /* Exact OpenAI Pill Switch with 44px touch target via ::before */
      ".ce-switch { position: relative; width: 36px; height: 20px; border-radius: 999px; border: 1.5px solid rgba(255, 255, 255, 0.36); background: transparent; padding: 0; cursor: pointer; transition: background 0.16s ease, border-color 0.16s ease; flex-shrink: 0; }",
      ".ce-switch::before { content: ''; position: absolute; inset: -12px -6px; }",
      "html[data-ce-theme='light'] .ce-switch { border-color: rgba(0, 0, 0, 0.32); }",
      ".ce-switch-thumb { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #ececec; transition: transform 0.16s cubic-bezier(0.16, 1, 0.3, 1), background 0.16s ease; }",
      "html[data-ce-theme='light'] .ce-switch-thumb { background: #555555; }",
      ".ce-switch.on { background: #ececec; border-color: #ececec; }",
      ".ce-switch.on .ce-switch-thumb { background: #0d0d0d; transform: translateX(16px); }",
      "html[data-ce-theme='light'] .ce-switch.on { background: #0d0d0d; border-color: #0d0d0d; }",
      "html[data-ce-theme='light'] .ce-switch.on .ce-switch-thumb { background: #ffffff; transform: translateX(16px); }",
      "@keyframes ceSpin { to { transform: rotate(360deg); } }",
      ".ce-spinner { width: 16px; height: 16px; border: 1.8px solid rgba(128,128,128,0.3); border-top-color: currentColor; border-radius: 50%; animation: ceSpin 0.7s linear infinite; }",
      ".ce-mkt-chev { color: var(--vscode-descriptionForeground, #9b9b9b); opacity: 0.55; transition: transform 0.15s ease; display: inline-flex; }",
      ".ce-mkt-card.expanded .ce-mkt-chev { transform: rotate(90deg); }",
      ".ce-mkt-detail { display: none; padding: 0 14px 12px 62px; font-size: 12.5px; line-height: 1.45; color: var(--vscode-descriptionForeground, #9b9b9b); }",
      ".ce-mkt-card.expanded .ce-mkt-detail { display: block; }",
      ".ce-mkt-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }",

      /* Sub-panel Slide-Over Sheet & Minimal Native Modals */
      "#ce-subpanel-sheet { position: fixed; inset: 0; z-index: 8800; background: var(--ce-bg-primary); display: none; flex-direction: column; }",
      "#ce-subpanel-sheet.open { display: flex; }",
      ".ce-sub-hdr { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 12px; background: var(--ce-bg-primary); border-bottom: 1px solid var(--ce-border); font-family: var(--vscode-font-family); font-size: 13.5px; font-weight: 500; flex-shrink: 0; }",
      ".ce-sub-back { display: inline-flex; align-items: center; gap: 5px; min-height: 36px; padding: 0 12px 0 8px; border-radius: 999px; border: 1px solid var(--ce-border); background: transparent; color: var(--ce-fg-primary); font: inherit; font-size: 12.5px; cursor: pointer; }",
      ".ce-sub-back:hover { background: var(--ce-bg-hover); }",
      "#ce-subpanel-frame { flex: 1; width: 100%; border: none; background: var(--ce-bg-primary); }",
      "#ce-dialog-backdrop { position: fixed; inset: 0; z-index: 9600; background: rgba(0, 0, 0, 0.55); display: none; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }",
      "#ce-dialog-backdrop.open { display: flex; }",
      "#ce-dialog-box { width: 100%; max-width: 520px; max-height: min(84dvh, 640px); background: #1f1f1f; color: #ececec; border: 1px solid rgba(255, 255, 255, 0.10); border-radius: 16px; box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55); display: flex; flex-direction: column; overflow: hidden; font-family: var(--vscode-font-family); font-size: 13px; }",
      "html[data-ce-theme='light'] #ce-dialog-box { background: #ffffff; color: #0d0d0d; border-color: rgba(0, 0, 0, 0.10); }",
      ".ce-dlg-hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; padding: 8px 12px 8px 14px; border-bottom: 1px solid rgba(128, 128, 128, 0.16); box-sizing: border-box; }",
      ".ce-dlg-close { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border: none; border-radius: 999px; background: transparent; color: inherit; cursor: pointer; }",
      ".ce-dlg-close:hover { background: rgba(128, 128, 128, 0.12); }",
      ".ce-dlg-body { flex: 1; overflow-y: auto; padding: 14px; -webkit-overflow-scrolling: touch; }",
      ".ce-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 12.5px; font-weight: 500; min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid rgba(128, 128, 128, 0.28); background: transparent; color: inherit; cursor: pointer; box-sizing: border-box; }",
      ".ce-btn:hover { background: rgba(128, 128, 128, 0.12); }",
      ".ce-btn.primary { background: #ececec; border-color: transparent; color: #0d0d0d; }",
      "html[data-ce-theme='light'] .ce-btn.primary { background: #0d0d0d; color: #ffffff; }",
      ".ce-ws-row { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 10px; border-radius: 9px; cursor: pointer; }",
      ".ce-ws-row:hover { background: rgba(128, 128, 128, 0.12); }",
      ".ce-editor-area { width: 100%; min-height: 300px; box-sizing: border-box; padding: 10px; border-radius: 10px; border: 1px solid rgba(128, 128, 128, 0.24); background: rgba(0,0,0,0.2); color: inherit; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.45; resize: vertical; outline: none; }",
      "#ce-toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 9900; background: #262626; color: #ececec; border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 7px 14px; font-family: var(--vscode-font-family); font-size: 12.5px; box-shadow: 0 8px 24px rgba(0,0,0,0.45); opacity: 0; pointer-events: none; transition: opacity 0.16s ease; max-width: calc(100vw - 32px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      "#ce-toast.visible { opacity: 1; }"
    ].join("\n");
    document.head.appendChild(st);
  }

  var toastEl = null;
  var toastTimer = null;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "ce-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("visible"); }, 2500);
  }

  // ---------------------------------------------------------------------------
  // 1. Native Composer Workspace Pill & Floating Radix-Style Popover
  // ---------------------------------------------------------------------------
  var activeAnchorBtnEl = null;
  var wsPopoverEl = null;
  var viewportRepositionHandler = null;

  function setWorkspaceState(ws) {
    if (ws) currentWorkspace = normalizeWsPath(ws);
    var labels = document.querySelectorAll(".ce-cmp-ws-lbl");
    for (var i = 0; i < labels.length; i++) {
      labels[i].textContent = basename(currentWorkspace);
    }
    var btns = document.querySelectorAll(".ce-cmp-ws-btn[data-ce-ws-trigger='1']");
    for (var j = 0; j < btns.length; j++) {
      btns[j].title = currentWorkspace;
    }
  }

  function findLeadingRowInContainer(leading) {
    if (!leading) return null;
    for (var i = 0; i < leading.children.length; i++) {
      var ch = leading.children[i];
      if (ch.classList.contains("ce-composer-ws-slot")) continue;
      if (ch.classList.contains("flex") || ch.classList.contains("inline-flex")) {
        return ch;
      }
      var st = window.getComputedStyle(ch);
      if (st.display === "flex" || st.display === "inline-flex") {
        return ch;
      }
    }
    var btn = leading.querySelector("button:not([data-ce-ws-trigger='1'])");
    if (btn && btn.parentElement && leading.contains(btn.parentElement)) {
      return btn.parentElement;
    }
    return leading;
  }

  function createWorkspaceSlotNode() {
    var slot = document.createElement("span");
    slot.className = "ce-composer-ws-slot";
    slot.addEventListener("pointerdown", function (ev) {
      ev.stopPropagation();
    });

    var div = document.createElement("span");
    div.className = "ce-cmp-div";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ce-cmp-ws-btn";
    btn.setAttribute("data-ce-ws-trigger", "1");
    btn.setAttribute("aria-label", isEs ? "Seleccionar carpeta de trabajo" : "Select workspace folder");
    btn.title = currentWorkspace;
    btn.innerHTML = SVG.folder14;

    var lbl = document.createElement("span");
    lbl.className = "ce-cmp-ws-lbl";
    lbl.textContent = basename(currentWorkspace);

    var chev = document.createElement("span");
    chev.style.display = "inline-flex";
    chev.innerHTML = SVG.chevDown11;

    btn.appendChild(lbl);
    btn.appendChild(chev);

    btn.onclick = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      toggleWorkspacePopover(btn);
    };

    slot.appendChild(div);
    slot.appendChild(btn);
    return slot;
  }

  function ensureComposerWorkspaceSlot() {
    if (IS_SUBPANEL) return;
    var leadings = document.querySelectorAll("[data-composer-leading-controls]");
    for (var i = 0; i < leadings.length; i++) {
      var leadingRow = findLeadingRowInContainer(leadings[i]);
      if (!leadingRow) continue;
      if (!leadingRow.querySelector(".ce-composer-ws-slot")) {
        leadingRow.appendChild(createWorkspaceSlotNode());
      }
    }
  }

  function detachViewportListeners() {
    if (!viewportRepositionHandler) return;
    window.removeEventListener("resize", viewportRepositionHandler);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", viewportRepositionHandler);
      window.visualViewport.removeEventListener("scroll", viewportRepositionHandler);
    }
    viewportRepositionHandler = null;
  }

  function closeWorkspacePopover() {
    detachViewportListeners();
    if (wsPopoverEl && wsPopoverEl.classList.contains("open")) {
      wsPopoverEl.classList.remove("open");
      wsPopoverEl.innerHTML = "";
    }
    if (activeAnchorBtnEl) {
      activeAnchorBtnEl.classList.remove("open");
      activeAnchorBtnEl = null;
    }
  }

  function isExistingConversationView() {
    // Check only active composer placeholder attribute or back-toolbar header — O(1), zero transcript scan
    if (document.querySelector("[data-docked-chat-toolbar] button[aria-label]")) {
      var ph = document.querySelector("[contenteditable='true'][data-placeholder], [data-placeholder]");
      if (ph) {
        var ptxt = ph.getAttribute("data-placeholder") || "";
        if (ptxt.indexOf("seguimiento") !== -1 || ptxt.indexOf("follow-up") !== -1) return true;
      }
    }
    return false;
  }

  function activatePickedWorkspace(targetPath) {
    var norm = normalizeWsPath(targetPath);
    var changed = norm !== currentWorkspace;
    var wasInThread = isExistingConversationView();
    closeWorkspacePopover();
    setWorkspaceState(norm);
    apiPost("/api/workspaces/select", { workspace: norm }).then(function (r) {
      if (r && r.activeWorkspace) setWorkspaceState(r.activeWorkspace);
      if (changed && wasInThread) {
        apiPost("/api/sessions/new", {}).catch(function () {});
      }
      showToast((isEs ? "Carpeta: " : "Workspace: ") + basename(norm));
    }).catch(function () {
      showToast(isEs ? "No se pudo cambiar la carpeta" : "Failed to switch folder");
    });
  }

  function toggleWorkspacePopover(anchorBtn) {
    if (!wsPopoverEl) {
      wsPopoverEl = document.createElement("div");
      wsPopoverEl.id = "ce-ws-popover";
      document.body.appendChild(wsPopoverEl);
      document.addEventListener("pointerdown", function (ev) {
        if (!wsPopoverEl || !wsPopoverEl.classList.contains("open")) return;
        if (wsPopoverEl.contains(ev.target)) return;
        if (activeAnchorBtnEl && activeAnchorBtnEl.contains(ev.target)) return;
        closeWorkspacePopover();
      }, true);
    }

    if (wsPopoverEl.classList.contains("open") && activeAnchorBtnEl === anchorBtn) {
      closeWorkspacePopover();
      return;
    }

    detachViewportListeners();
    if (activeAnchorBtnEl) activeAnchorBtnEl.classList.remove("open");
    activeAnchorBtnEl = anchorBtn;
    if (activeAnchorBtnEl) activeAnchorBtnEl.classList.add("open");
    wsPopoverEl.innerHTML = "";

    var sec = document.createElement("div");
    sec.className = "ce-pop-sec";
    sec.textContent = isEs ? "Espacio de trabajo" : "Workspace";
    wsPopoverEl.appendChild(sec);

    var listWrap = document.createElement("div");
    listWrap.className = "ce-pop-list";
    wsPopoverEl.appendChild(listWrap);

    function renderWorkspaceItems(workspaces) {
      listWrap.innerHTML = "";
      var seen = Object.create(null);
      var all = [];
      function pushUnique(p) {
        var np = normalizeWsPath(p);
        if (!seen[np]) {
          seen[np] = true;
          all.push(np);
        }
      }
      pushUnique(currentWorkspace);
      (workspaces || []).forEach(function (w) { pushUnique(w.path || w); });

      all.slice(0, 8).forEach(function (p) {
        var isCur = p === currentWorkspace;
        var item = document.createElement("button");
        item.type = "button";
        item.className = "ce-pop-item";
        item.title = p;
        item.innerHTML =
          SVG.folder14 +
          '<span class="ce-pop-item-lbl">' + escapeHtml(basename(p)) + "</span>" +
          (isCur ? SVG.check14 : "");
        item.onclick = function () { activatePickedWorkspace(p); };
        listWrap.appendChild(item);
      });
    }

    renderWorkspaceItems([]);
    apiGet("/api/workspaces").then(function (data) {
      if (wsPopoverEl.classList.contains("open") && data && data.workspaces) {
        renderWorkspaceItems(data.workspaces);
        repositionPopover();
      }
    }).catch(function () {});

    var sep = document.createElement("div");
    sep.className = "ce-pop-sep";
    wsPopoverEl.appendChild(sep);

    var newFolderContainer = document.createElement("div");
    wsPopoverEl.appendChild(newFolderContainer);

    var newFolderBtn = document.createElement("button");
    newFolderBtn.type = "button";
    newFolderBtn.className = "ce-pop-item";
    newFolderBtn.innerHTML = SVG.folderPlus15 + '<span class="ce-pop-item-lbl">' + (isEs ? "Nueva carpeta…" : "New folder…") + "</span>";
    newFolderBtn.onclick = function () {
      newFolderBtn.style.display = "none";
      var box = document.createElement("div");
      box.className = "ce-pop-inline-box";
      var parentDir = "/storage/emulated/0/Documents";
      var hint = document.createElement("div");
      hint.className = "ce-pop-hint";
      hint.textContent = (isEs ? "En: " : "In: ") + parentDir + "/";
      var inp = document.createElement("input");
      inp.type = "text";
      inp.className = "ce-pop-inp";
      inp.placeholder = isEs ? "Nombre de la carpeta…" : "Folder name…";
      var creating = false;
      inp.onkeydown = function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          if (creating) return;
          var nm = inp.value.trim();
          if (!nm) return;
          creating = true;
          inp.disabled = true;
          apiPost("/api/workspaces/create", { parentDir: parentDir, name: nm }).then(function (r) {
            if (r && r.ok && r.activeWorkspace) {
              activatePickedWorkspace(r.activeWorkspace);
            } else {
              creating = false;
              inp.disabled = false;
              showToast(isEs ? "Error al crear la carpeta" : "Failed to create folder");
            }
          }).catch(function () {
            creating = false;
            inp.disabled = false;
            showToast(isEs ? "Error al crear la carpeta" : "Failed to create folder");
          });
        } else if (e.key === "Escape") {
          closeWorkspacePopover();
        }
      };
      box.appendChild(hint);
      box.appendChild(inp);
      newFolderContainer.appendChild(box);
      repositionPopover();
      setTimeout(function () { inp.focus(); }, 20);
    };
    wsPopoverEl.appendChild(newFolderBtn);

    var browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.className = "ce-pop-item";
    browseBtn.innerHTML = SVG.folderOpen15 + '<span class="ce-pop-item-lbl">' + (isEs ? "Elegir carpeta…" : "Choose folder…") + "</span>";
    browseBtn.onclick = function () {
      closeWorkspacePopover();
      var rpc = getHostRpc();
      openFolderBrowserModal(isEs ? "Seleccionar carpeta" : "Select folder", function (picked) {
        if (picked) activatePickedWorkspace(picked);
      }, rpc);
    };
    wsPopoverEl.appendChild(browseBtn);

    wsPopoverEl.classList.add("open");

    function repositionPopover() {
      if (!activeAnchorBtnEl || !wsPopoverEl.classList.contains("open")) return;
      var vv = window.visualViewport;
      var viewTop = vv ? vv.offsetTop : 0;
      var viewW = vv ? vv.width : window.innerWidth;
      var viewH = vv ? vv.height : window.innerHeight;
      var viewBottom = viewTop + viewH;

      var maxH = Math.max(160, viewH - 24);
      wsPopoverEl.style.maxHeight = Math.round(maxH) + "px";

      var r = activeAnchorBtnEl.getBoundingClientRect();
      var pr = wsPopoverEl.getBoundingClientRect();
      var left = Math.max(10, Math.min(r.left, viewW - pr.width - 10));
      var top = r.top - pr.height - 8;
      if (top < viewTop + 10) {
        top = Math.min(r.bottom + 8, viewBottom - pr.height - 10);
      }
      top = Math.max(viewTop + 8, Math.min(top, viewBottom - pr.height - 8));
      wsPopoverEl.style.left = Math.round(left) + "px";
      wsPopoverEl.style.top = Math.round(top) + "px";
    }

    viewportRepositionHandler = repositionPopover;
    window.addEventListener("resize", viewportRepositionHandler);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", viewportRepositionHandler);
      window.visualViewport.addEventListener("scroll", viewportRepositionHandler);
    }
    repositionPopover();
  }

  // ---------------------------------------------------------------------------
  // 2. Native ARM64 Marketplace inside Codex Settings (Subpanel Only!)
  // ---------------------------------------------------------------------------
  var marketSectionEl = null;
  var marketLoading = false;
  var marketCatalogCache = null;
  var expandedCards = Object.create(null);
  var busyPlugins = Object.create(null);

  function findSettingsContentHost() {
    if (!IS_SUBPANEL) return null;
    var root = document.getElementById("root");
    if (!root) return null;

    var candidates = root.querySelectorAll("h1, h2, h3, [role='heading'], div, span");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.children.length > 0) continue;
      var txt = (el.textContent || "").trim();
      if (
        txt !== "Servidores MCP" &&
        txt !== "MCP servers" &&
        txt !== "MCP Servers" &&
        txt !== "Complementos" &&
        txt !== "Plugins"
      ) {
        continue;
      }
      if (el.closest("button, a, nav, aside, [role='tablist'], article, [data-message-author-role], #ce-arm64-market-section")) {
        continue;
      }
      var fst = window.getComputedStyle(el);
      if (parseFloat(fst.fontSize || "0") < 17) {
        continue;
      }

      var box = el.parentElement;
      while (box && box.parentElement && box.parentElement !== root && box.parentElement !== document.body) {
        var parent = box.parentElement;
        var pst = window.getComputedStyle(parent);
        if (pst.display === "flex" && pst.flexDirection === "row") break;
        if (pst.overflowY === "auto" || pst.overflowY === "scroll") break;
        box = parent;
      }
      if (box) {
        var bst = window.getComputedStyle(box);
        if ((bst.overflowY === "auto" || bst.overflowY === "scroll") && box.firstElementChild && box.firstElementChild.id !== "ce-arm64-market-section") {
          return box.firstElementChild;
        }
        return box;
      }
    }
    return null;
  }

  function syncNativeArm64Marketplace() {
    if (!IS_SUBPANEL) return;
    var host = findSettingsContentHost();
    if (!host) {
      if (marketSectionEl && marketSectionEl.parentNode) {
        marketSectionEl.parentNode.removeChild(marketSectionEl);
      }
      return;
    }

    if (!marketSectionEl) {
      marketSectionEl = document.createElement("section");
      marketSectionEl.id = "ce-arm64-market-section";
    }

    if (marketSectionEl.parentNode !== host) {
      host.appendChild(marketSectionEl);
      loadAndRenderArm64Marketplace();
    }
  }

  function loadAndRenderArm64Marketplace() {
    if (marketLoading) return;
    marketLoading = true;
    apiGet("/api/plugins").then(function (data) {
      marketLoading = false;
      marketCatalogCache = (data && data.plugins) || [];
      renderArm64Cards();
    }).catch(function () {
      marketLoading = false;
    });
  }

  function renderArm64Cards() {
    if (!marketSectionEl) return;
    var list = marketCatalogCache || [];
    marketSectionEl.innerHTML = "";

    var hdr = document.createElement("div");
    hdr.className = "ce-mkt-hdr";
    hdr.innerHTML =
      '<div class="ce-mkt-title-wrap">' +
      '<span class="ce-mkt-title">' + (isEs ? "Nativos para Android (ARM64)" : "Built for Android (ARM64)") + "</span>" +
      '<span class="ce-mkt-count">' + list.length + "</span>" +
      "</div>";
    marketSectionEl.appendChild(hdr);

    var sub = document.createElement("div");
    sub.className = "ce-mkt-sub";
    sub.textContent = isEs
      ? "Herramientas MCP y habilidades compiladas localmente para ARM64 sin contenedores"
      : "Native ARM64 MCP servers and skills running locally without containers";
    marketSectionEl.appendChild(sub);

    var grid = document.createElement("div");
    grid.className = "ce-mkt-grid";

    list.forEach(function (pl) {
      var id = pl.id || pl.name;
      var isBusy = Boolean(busyPlugins[id]);
      var isOn = Boolean(pl.enabled);
      var isExp = Boolean(expandedCards[id]);

      var card = document.createElement("div");
      card.className = "ce-mkt-card" + (isExp ? " expanded" : "");

      var row = document.createElement("div");
      row.className = "ce-mkt-row";

      var ico = document.createElement("div");
      ico.className = "ce-mkt-ico";
      ico.innerHTML = SVG.pluginIcon(pl.icon || "cube");

      var body = document.createElement("div");
      body.className = "ce-mkt-body";
      var shortText = isBusy
        ? (isEs ? "Descargando e instalando paquete ARM64…" : "Downloading & installing ARM64 package…")
        : ((isEs ? pl.shortEs : pl.shortEn) || (isEs ? pl.descriptionEs : pl.description) || "");

      body.innerHTML =
        '<div class="ce-mkt-name-row"><span class="ce-mkt-name">' + escapeHtml(pl.title || id) + "</span></div>" +
        '<div class="ce-mkt-desc">' + escapeHtml(shortText) + "</div>";

      var right = document.createElement("div");
      right.className = "ce-mkt-right";

      if (isBusy) {
        var sp = document.createElement("span");
        sp.className = "ce-spinner";
        right.appendChild(sp);
      } else {
        var sw = document.createElement("button");
        sw.type = "button";
        sw.role = "switch";
        sw.setAttribute("aria-checked", isOn ? "true" : "false");
        sw.setAttribute("aria-label", (pl.title || id));
        sw.className = "ce-switch" + (isOn ? " on" : "");
        sw.innerHTML = '<span class="ce-switch-thumb"></span>';
        sw.onclick = function (ev) {
          ev.stopPropagation();
          onToggleArm64Plugin(pl, !isOn);
        };
        right.appendChild(sw);
      }

      var chev = document.createElement("span");
      chev.className = "ce-mkt-chev";
      chev.innerHTML = SVG.chevRight14;
      right.appendChild(chev);

      row.onclick = function () {
        expandedCards[id] = !expandedCards[id];
        card.classList.toggle("expanded", expandedCards[id]);
      };

      row.appendChild(ico);
      row.appendChild(body);
      row.appendChild(right);
      card.appendChild(row);

      var detail = document.createElement("div");
      detail.className = "ce-mkt-detail";
      var fullDesc = (isEs ? pl.descriptionEs : pl.description) || shortText;
      var dText = document.createElement("div");
      dText.textContent = fullDesc;
      detail.appendChild(dText);

      var meta = document.createElement("div");
      meta.className = "ce-mkt-meta";
      meta.innerHTML =
        '<span>v' + escapeHtml(pl.version || "1.0.0") + " · ARM64" +
        (pl.installed ? (isEs ? " · Instalado" : " · Installed") : "") + "</span>";

      if (pl.installed && !isBusy) {
        var unBtn = document.createElement("button");
        unBtn.type = "button";
        unBtn.className = "ce-btn";
        unBtn.style.minHeight = "34px";
        unBtn.style.padding = "0 12px";
        unBtn.style.fontSize = "12px";
        unBtn.textContent = isEs ? "Desinstalar" : "Uninstall";
        unBtn.onclick = function (ev) {
          ev.stopPropagation();
          onUninstallArm64Plugin(pl);
        };
        meta.appendChild(unBtn);
      }
      detail.appendChild(meta);
      card.appendChild(detail);
      grid.appendChild(card);
    });

    marketSectionEl.appendChild(grid);
  }

  function onToggleArm64Plugin(pl, nextEnable) {
    var id = pl.id || pl.name;
    var nameKey = pl.name || pl.id;
    var rpc = getHostRpc();

    busyPlugins[id] = true;
    renderArm64Cards();

    function finishRefresh(toastMsg) {
      delete busyPlugins[id];
      if (toastMsg) showToast(toastMsg);
      loadAndRenderArm64Marketplace();
    }

    if (nextEnable && !pl.installed && pl.archiveUrl) {
      if (!rpc) {
        finishRefresh(isEs ? "Puente nativo no disponible" : "Native bridge unavailable");
        return;
      }
      var started = rpc.installPlugin(nameKey, pl.archiveUrl, pl.version || "1.0.0", pl.sha256 || "", function (res) {
        if (res && res.ok) {
          finishRefresh((pl.title || nameKey) + (isEs ? " activado" : " enabled"));
        } else {
          finishRefresh((res && res.error) || (isEs ? "Error al instalar" : "Install failed"));
        }
      });
      if (!started) {
        finishRefresh(isEs ? "Puente nativo no disponible" : "Native bridge unavailable");
      }
      return;
    }

    if (pl.installed && rpc) {
      var toggled = rpc.togglePlugin(nameKey, nextEnable, function (res) {
        if (res && res.ok) {
          finishRefresh((pl.title || nameKey) + (nextEnable ? (isEs ? " activado" : " enabled") : (isEs ? " desactivado" : " disabled")));
        } else {
          finishRefresh((res && res.error) || (isEs ? "Error al actualizar complemento" : "Plugin update failed"));
        }
      });
      if (toggled) return;
    }

    apiPost("/api/plugins/toggle", { id: id, enable: nextEnable }).then(function () {
      finishRefresh();
    }).catch(function () {
      finishRefresh(isEs ? "Error al actualizar complemento" : "Plugin update failed");
    });
  }

  function onUninstallArm64Plugin(pl) {
    var id = pl.id || pl.name;
    var nameKey = pl.name || pl.id;
    var rpc = getHostRpc();
    if (!rpc) {
      showToast(isEs ? "Puente nativo no disponible" : "Native bridge unavailable");
      return;
    }
    busyPlugins[id] = true;
    renderArm64Cards();
    var ok = rpc.uninstallPlugin(nameKey, function () {
      delete busyPlugins[id];
      showToast((pl.title || nameKey) + (isEs ? " desinstalado" : " uninstalled"));
      loadAndRenderArm64Marketplace();
    });
    if (!ok) {
      delete busyPlugins[id];
      renderArm64Cards();
      showToast(isEs ? "Error al desinstalar" : "Uninstall failed");
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Modals, Subpanel Sheet & Native File/Folder Dialogs
  // ---------------------------------------------------------------------------
  var backdropEl = null;
  var dlgBoxEl = null;
  var dlgTitleEl = null;
  var dlgHdrRightEl = null;
  var dlgBodyEl = null;
  var onCloseCleanup = null;

  function ensureDialogDom() {
    if (backdropEl) return;
    backdropEl = document.createElement("div");
    backdropEl.id = "ce-dialog-backdrop";
    backdropEl.onclick = function (ev) { if (ev.target === backdropEl) closeDialog(); };
    dlgBoxEl = document.createElement("div");
    dlgBoxEl.id = "ce-dialog-box";
    var hdr = document.createElement("div");
    hdr.className = "ce-dlg-hdr";
    dlgTitleEl = document.createElement("div");
    dlgTitleEl.style.cssText = "font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    var rightWrap = document.createElement("div");
    rightWrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;";
    dlgHdrRightEl = document.createElement("div");
    dlgHdrRightEl.style.cssText = "display:inline-flex;align-items:center;gap:6px;";
    var cls = document.createElement("button");
    cls.type = "button";
    cls.className = "ce-dlg-close";
    cls.setAttribute("aria-label", isEs ? "Cerrar" : "Close");
    cls.innerHTML = SVG.close16;
    cls.onclick = function () { closeDialog(); };
    rightWrap.appendChild(dlgHdrRightEl);
    rightWrap.appendChild(cls);
    hdr.appendChild(dlgTitleEl);
    hdr.appendChild(rightWrap);
    dlgBodyEl = document.createElement("div");
    dlgBodyEl.className = "ce-dlg-body";
    dlgBoxEl.appendChild(hdr);
    dlgBoxEl.appendChild(dlgBodyEl);
    backdropEl.appendChild(dlgBoxEl);
    document.body.appendChild(backdropEl);
  }

  function openDialog(title, renderFn, cleanupFn, maxWidthPx) {
    ensureDialogDom();
    var wasOpen = backdropEl.classList.contains("open");
    if (onCloseCleanup) {
      try { onCloseCleanup(); } catch (_) {}
      onCloseCleanup = null;
    }
    dlgBoxEl.style.maxWidth = (maxWidthPx || 520) + "px";
    dlgTitleEl.textContent = title;
    dlgHdrRightEl.innerHTML = "";
    dlgBodyEl.innerHTML = "";
    onCloseCleanup = cleanupFn || null;
    renderFn(dlgBodyEl, dlgHdrRightEl);
    backdropEl.classList.add("open");
    if (!wasOpen) pushOverlayHistory("dialog");
  }

  function closeDialog(skipHistoryBack) {
    if (!backdropEl || !backdropEl.classList.contains("open")) return;
    backdropEl.classList.remove("open");
    if (onCloseCleanup) {
      var fn = onCloseCleanup;
      onCloseCleanup = null;
      try { fn(); } catch (_) {}
    }
    if (skipHistoryBack !== true) popOverlayHistory();
  }

  function openFolderBrowserModal(title, onResult, rpc) {
    var settled = false;
    function complete(dir) {
      if (settled) return;
      settled = true;
      if (typeof onResult === "function") onResult(dir || "");
    }

    openDialog(title, function (container) {
      var browsePath = currentWorkspace;

      if (rpc && typeof rpc.hasDirectoryPicker === "function" && rpc.hasDirectoryPicker()) {
        var topRow = document.createElement("div");
        topRow.style.cssText = "display:flex;gap:8px;margin-bottom:10px;";
        var safBtn = document.createElement("button");
        safBtn.type = "button";
        safBtn.className = "ce-btn primary";
        safBtn.textContent = isEs ? "Selector nativo de Android" : "Android System Picker";
        safBtn.onclick = function () {
          var launched = rpc.pickDirectory(function (picked) {
            if (picked) {
              complete(picked);
              closeDialog();
            }
          });
          if (!launched) {
            showToast(isEs ? "Selector no disponible" : "Picker unavailable");
          }
        };
        topRow.appendChild(safBtn);
        container.appendChild(topRow);
      }

      var quickRow = document.createElement("div");
      quickRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;";
      [
        { label: "Documents", path: "/storage/emulated/0/Documents" },
        { label: "Codex", path: "/storage/emulated/0/Documents/Codex" },
        { label: "IA", path: "/storage/emulated/0/IA" },
        { label: "Download", path: "/storage/emulated/0/Download" }
      ].forEach(function (q) {
        var p = document.createElement("button");
        p.type = "button";
        p.className = "ce-btn";
        p.textContent = q.label;
        p.onclick = function () { loadDir(q.path); };
        quickRow.appendChild(p);
      });
      container.appendChild(quickRow);

      var pathBar = document.createElement("div");
      pathBar.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:1px solid rgba(128,128,128,0.2);border-radius:10px;margin-bottom:8px;";
      var pathLbl = document.createElement("div");
      pathLbl.style.cssText = "font-family:var(--vscode-editor-font-family);font-size:11.5px;word-break:break-all;flex:1;";
      var openHere = document.createElement("button");
      openHere.type = "button";
      openHere.className = "ce-btn primary";
      openHere.textContent = isEs ? "Usar esta carpeta" : "Use folder";
      openHere.onclick = function () {
        complete(browsePath);
        closeDialog();
      };
      pathBar.appendChild(pathLbl);
      pathBar.appendChild(openHere);
      container.appendChild(pathBar);

      var dirList = document.createElement("div");
      container.appendChild(dirList);

      function loadDir(target) {
        browsePath = target;
        pathLbl.textContent = target;
        dirList.innerHTML = "";
        apiGet("/api/fs/dir?path=" + encodeURIComponent(target)).then(function (data) {
          browsePath = (data && data.directory) || target;
          pathLbl.textContent = browsePath;
          dirList.innerHTML = "";
          if (browsePath !== "/" && data && data.parent && data.parent !== browsePath) {
            var up = document.createElement("div");
            up.className = "ce-ws-row";
            up.innerHTML = SVG.up15 + "<span>..</span>";
            up.onclick = function () { loadDir(data.parent); };
            dirList.appendChild(up);
          }
          ((data && data.items) || []).forEach(function (d) {
            var row = document.createElement("div");
            row.className = "ce-ws-row";
            row.innerHTML = SVG.folder14 + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(d.name) + "</span>";
            row.onclick = function () { loadDir(d.path); };
            dirList.appendChild(row);
          });
        }).catch(function () {});
      }
      loadDir(browsePath);
    }, function () {
      complete("");
    }, 480);
  }

  var subSheetEl = null;
  var subFrameEl = null;
  var subTitleEl = null;
  var activeSubPanelId = null;

  function openSubPanelSheet(panelId, title) {
    if (!subSheetEl) {
      subSheetEl = document.createElement("div");
      subSheetEl.id = "ce-subpanel-sheet";
      var hdr = document.createElement("div");
      hdr.className = "ce-sub-hdr";
      var backBtn = document.createElement("button");
      backBtn.type = "button";
      backBtn.className = "ce-sub-back";
      backBtn.innerHTML = SVG.back16 + "<span>" + (isEs ? "Atrás" : "Back") + "</span>";
      backBtn.onclick = function () { closeSubPanelSheet(); };
      subTitleEl = document.createElement("span");
      var spacer = document.createElement("span");
      spacer.style.width = "64px";
      hdr.appendChild(backBtn);
      hdr.appendChild(subTitleEl);
      hdr.appendChild(spacer);
      subFrameEl = document.createElement("iframe");
      subFrameEl.id = "ce-subpanel-frame";
      subSheetEl.appendChild(hdr);
      subSheetEl.appendChild(subFrameEl);
      document.body.appendChild(subSheetEl);
    }
    activeSubPanelId = panelId;
    subTitleEl.textContent = title || "Codex";
    subFrameEl.src = "/?panel=" + encodeURIComponent(panelId) + "&subpanel=1&theme=" + encodeURIComponent(currentTheme);
    if (!subSheetEl.classList.contains("open")) {
      subSheetEl.classList.add("open");
      pushOverlayHistory("subpanel");
    }
  }

  function closeSubPanelSheet(skipHistoryBack) {
    if (!subSheetEl || !subSheetEl.classList.contains("open")) return;
    subSheetEl.classList.remove("open");
    subFrameEl.src = "about:blank";
    if (activeSubPanelId) {
      var pid = activeSubPanelId;
      activeSubPanelId = null;
      apiPost("/api/subpanel/close", { panelId: pid }).catch(function () {});
    }
    if (skipHistoryBack !== true) popOverlayHistory();
  }

  function openFileEditorDialog(filePath, initialContent, title) {
    if (/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(filePath)) {
      openDialog(title || basename(filePath), function (container) {
        var img = document.createElement("img");
        img.src = "/api/fs/raw?path=" + encodeURIComponent(filePath) + "&t=" + Date.now();
        img.style.cssText = "max-width:100%;max-height:64dvh;display:block;margin:0 auto;border-radius:8px;";
        container.appendChild(img);
      });
      return;
    }
    openDialog(title || basename(filePath), function (container, hdrRight) {
      var hint = document.createElement("div");
      hint.style.cssText = "font-family:var(--vscode-editor-font-family);font-size:11px;opacity:0.65;margin-bottom:8px;word-break:break-all;";
      hint.textContent = filePath;
      container.appendChild(hint);

      var ta = document.createElement("textarea");
      ta.className = "ce-editor-area";
      ta.spellcheck = false;
      ta.value = initialContent != null ? initialContent : "";
      container.appendChild(ta);

      var saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "ce-btn primary";
      saveBtn.textContent = isEs ? "Guardar" : "Save";
      saveBtn.onclick = function () {
        saveBtn.disabled = true;
        apiPost("/api/fs/write", { path: filePath, content: ta.value }).then(function (r) {
          saveBtn.disabled = false;
          showToast(r && r.ok
            ? ((isEs ? "Guardado " : "Saved ") + basename(filePath))
            : (isEs ? "Error al guardar" : "Save failed"));
        }).catch(function () {
          saveBtn.disabled = false;
          showToast(isEs ? "Error al guardar" : "Save failed");
        });
      };
      hdrRight.appendChild(saveBtn);

      if (initialContent == null) {
        ta.placeholder = "…";
        apiGet("/api/fs/read?path=" + encodeURIComponent(filePath)).then(function (r) {
          ta.placeholder = "";
          ta.value = (r && r.content) || "";
        }).catch(function () {
          ta.placeholder = "";
        });
      }
    });
  }

  var MAX_ATTACHMENT_BYTES = 11 * 1024 * 1024;

  function handleShowOpenDialog(pkt) {
    var reqId = pkt.reqId;
    var resolved = false;
    function finish(paths) {
      if (resolved) return;
      resolved = true;
      apiPost("/api/dialog/resolve", { reqId: reqId, paths: paths || [] }).catch(function () {});
    }

    if (pkt.canSelectFolders && !pkt.canSelectFiles) {
      // Attachment folder picker ONLY resolves the selected folder path without mutating currentWorkspace
      openFolderBrowserModal(pkt.title || (isEs ? "Adjuntar carpeta" : "Attach folder"), function (pickedDir) {
        if (pickedDir) {
          finish([normalizeWsPath(pickedDir)]);
        } else {
          finish([]);
        }
      }, getHostRpc());
      return;
    }

    var inp = document.createElement("input");
    inp.type = "file";
    inp.style.display = "none";
    if (pkt.canSelectMany) inp.multiple = true;
    if (pkt.filters && pkt.filters.Images) inp.accept = "image/*";
    document.body.appendChild(inp);

    var cleaned = false;
    function cleanupInput() {
      if (cleaned) return;
      cleaned = true;
      if (inp.parentNode) inp.parentNode.removeChild(inp);
    }

    inp.onchange = function () {
      var files = Array.prototype.slice.call(inp.files || []);
      cleanupInput();
      if (files.length === 0) {
        finish([]);
        return;
      }
      var validFiles = files.filter(function (f) {
        if (f.size > MAX_ATTACHMENT_BYTES) {
          showToast(isEs ? ("Archivo mayor de 11 MB: " + f.name) : ("File exceeds 11 MB: " + f.name));
          return false;
        }
        return true;
      });
      if (validFiles.length === 0) {
        finish([]);
        return;
      }
      Promise.all(validFiles.map(function (f) {
        return new Promise(function (resolve) {
          var reader = new FileReader();
          reader.onload = function () {
            var resStr = String(reader.result || "");
            var comma = resStr.indexOf(",");
            var b64 = comma >= 0 ? resStr.slice(comma + 1) : resStr;
            apiPost("/api/fs/upload-attachment", { name: f.name, dataBase64: b64 })
              .then(function (r) { resolve((r && r.ok && r.path) ? r.path : ""); })
              .catch(function () { resolve(""); });
          };
          reader.onerror = function () { resolve(""); };
          reader.readAsDataURL(f);
        });
      })).then(function (uploadedPaths) {
        finish(uploadedPaths.filter(Boolean));
      });
    };
    inp.addEventListener("cancel", function () {
      cleanupInput();
      finish([]);
    });
    inp.click();
  }

  // ---------------------------------------------------------------------------
  // 2b. Native GitHub Releases OTA Updater Card (Codex Settings -> General)
  // ---------------------------------------------------------------------------
  var otaSectionEl = null;
  var otaBannerEl = null;
  var otaDismissedVer = "";
  var currentOtaState = { type: "idle" };

  function readInitialOtaState() {
    var rpc = getHostRpc();
    if (rpc && typeof rpc.getUpdateState === "function") {
      var st = rpc.getUpdateState();
      if (st && typeof st === "object") currentOtaState = st;
    }
  }

  function findGeneralSettingsHost() {
    if (!IS_SUBPANEL) return null;
    var root = document.getElementById("root");
    if (!root) return null;
    var candidates = root.querySelectorAll("h1, h2, h3, [role='heading'], div, span");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.children.length > 0) continue;
      var txt = (el.textContent || "").trim();
      if (txt !== "General") continue;
      if (el.closest("button, a, nav, aside, [role='tablist'], article, [data-message-author-role], #ce-ota-update-section")) {
        continue;
      }
      var fst = window.getComputedStyle(el);
      if (parseFloat(fst.fontSize || "0") < 17) continue;

      var box = el.parentElement;
      while (box && box.parentElement && box.parentElement !== root && box.parentElement !== document.body) {
        var parent = box.parentElement;
        var pst = window.getComputedStyle(parent);
        if (pst.display === "flex" && pst.flexDirection === "row") break;
        if (pst.overflowY === "auto" || pst.overflowY === "scroll") break;
        box = parent;
      }
      if (box) {
        var bst = window.getComputedStyle(box);
        if ((bst.overflowY === "auto" || bst.overflowY === "scroll") && box.firstElementChild && box.firstElementChild.id !== "ce-ota-update-section") {
          return box.firstElementChild;
        }
        return box;
      }
    }
    return null;
  }

  function renderOtaSettingsCard() {
    if (!otaSectionEl) return;
    var st = currentOtaState || { type: "idle" };
    var t = st.type || "idle";
    var instVer = st.installedVersion || "26.51120.1-r1";
    var remVer = st.version || "";
    var prog = typeof st.progress === "number" ? st.progress : -1;
    var rpc = getHostRpc();

    otaSectionEl.innerHTML = "";
    var card = document.createElement("div");
    card.className = "ce-mkt-card";
    card.style.marginTop = "16px";

    var row = document.createElement("div");
    row.className = "ce-mkt-row";
    row.style.cursor = "default";

    var body = document.createElement("div");
    body.className = "ce-mkt-body";

    var statusText = "";
    if (t === "checking for updates") {
      statusText = isEs ? "Comprobando GitHub Releases…" : "Checking GitHub Releases…";
    } else if (t === "downloading" || t === "available for download") {
      statusText = (isEs ? "Descargando v" : "Downloading v") + remVer + (prog >= 0 ? " (" + prog + "%)…" : "…");
    } else if (t === "ready" && remVer) {
      statusText = (isEs ? "Nueva versión v" : "New release v") + remVer + (isEs ? " verificada y lista para instalar" : " verified and ready to install");
    } else {
      statusText = "v" + instVer + " · ARM64 · " + (isEs ? "Actualizaciones vía GitHub Releases" : "GitHub Releases OTA");
    }

    body.innerHTML =
      '<div class="ce-mkt-name-row"><span class="ce-mkt-name">' +
      (isEs ? "Actualizaciones de Codex" : "Codex App Updates") +
      "</span></div>" +
      '<div class="ce-mkt-desc">' + escapeHtml(statusText) + "</div>";

    var right = document.createElement("div");
    right.className = "ce-mkt-right";

    if (t === "checking for updates" || t === "downloading" || t === "available for download") {
      var sp = document.createElement("span");
      sp.className = "ce-spinner";
      right.appendChild(sp);
    } else if (t === "ready" && remVer) {
      var instBtn = document.createElement("button");
      instBtn.type = "button";
      instBtn.className = "ce-btn primary";
      instBtn.style.cssText = "min-height:34px;padding:0 12px;font-size:12px;";
      instBtn.textContent = (isEs ? "Instalar v" : "Install v") + remVer;
      instBtn.onclick = function () {
        if (rpc && rpc.applyUpdate) rpc.applyUpdate();
      };
      right.appendChild(instBtn);
    } else {
      var chkBtn = document.createElement("button");
      chkBtn.type = "button";
      chkBtn.className = "ce-btn";
      chkBtn.style.cssText = "min-height:34px;padding:0 12px;font-size:12px;";
      chkBtn.textContent = isEs ? "Buscar actualizaciones" : "Check for updates";
      chkBtn.onclick = function () {
        if (rpc && rpc.checkForUpdates) rpc.checkForUpdates(true);
      };
      right.appendChild(chkBtn);
    }

    row.appendChild(body);
    row.appendChild(right);
    card.appendChild(row);
    otaSectionEl.appendChild(card);
  }

  function syncOtaSettingsCard() {
    if (!IS_SUBPANEL) return;
    var host = findGeneralSettingsHost();
    if (!host) {
      if (otaSectionEl && otaSectionEl.parentNode) {
        otaSectionEl.parentNode.removeChild(otaSectionEl);
      }
      return;
    }
    if (!otaSectionEl) {
      otaSectionEl = document.createElement("section");
      otaSectionEl.id = "ce-ota-update-section";
      readInitialOtaState();
    }
    if (otaSectionEl.parentNode !== host) {
      host.appendChild(otaSectionEl);
      renderOtaSettingsCard();
    }
  }

  function renderMainOtaReadyBanner() {
    if (IS_SUBPANEL) return;
    var st = currentOtaState || {};
    if (st.type !== "ready" || !st.version || st.version === otaDismissedVer) {
      if (otaBannerEl && otaBannerEl.parentNode) otaBannerEl.parentNode.removeChild(otaBannerEl);
      return;
    }
    if (!otaBannerEl) {
      otaBannerEl = document.createElement("div");
      otaBannerEl.id = "ce-ota-banner";
      otaBannerEl.style.cssText =
        "position:fixed;top:max(12px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:2147483644;" +
        "display:inline-flex;align-items:center;gap:10px;padding:8px 12px;border-radius:999px;" +
        "background:var(--ce-pop-bg,#1e1e1e);color:var(--ce-fg,#f3f3f3);border:1px solid var(--ce-border,rgba(255,255,255,0.14));" +
        "box-shadow:0 10px 28px rgba(0,0,0,0.45);font-size:12.5px;max-width:calc(100vw - 24px);";
    }
    otaBannerEl.innerHTML = "";
    var lbl = document.createElement("span");
    lbl.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    lbl.textContent = (isEs ? "Actualización v" : "Update v") + st.version + (isEs ? " lista" : " ready");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ce-btn primary";
    btn.style.cssText = "min-height:28px;padding:0 10px;font-size:12px;border-radius:999px;";
    btn.textContent = isEs ? "Instalar" : "Install";
    btn.onclick = function () {
      var rpc = getHostRpc();
      if (rpc && rpc.applyUpdate) rpc.applyUpdate();
    };
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.style.cssText = "background:none;border:none;color:inherit;opacity:0.65;padding:2px 4px;cursor:pointer;font-size:14px;line-height:1;";
    closeBtn.textContent = "×";
    closeBtn.onclick = function () {
      otaDismissedVer = st.version;
      if (otaBannerEl && otaBannerEl.parentNode) otaBannerEl.parentNode.removeChild(otaBannerEl);
    };
    otaBannerEl.appendChild(lbl);
    otaBannerEl.appendChild(btn);
    otaBannerEl.appendChild(closeBtn);
    if (!otaBannerEl.parentNode) document.body.appendChild(otaBannerEl);
  }

  function handleUpdaterState(stateObj) {
    if (!stateObj) return;
    var parsed = stateObj;
    if (typeof stateObj === "string") {
      try { parsed = JSON.parse(stateObj); } catch (_) { return; }
    }
    currentOtaState = parsed || { type: "idle" };
    if (IS_SUBPANEL) {
      renderOtaSettingsCard();
    } else {
      renderMainOtaReadyBanner();
      if (subFrameEl && subFrameEl.contentWindow && subFrameEl.contentWindow.__ceOnUpdaterStateChanged) {
        try { subFrameEl.contentWindow.__ceOnUpdaterStateChanged(currentOtaState); } catch (_) {}
      }
    }
  }
  window.__ceOnUpdaterStateChanged = handleUpdaterState;

  function syncDomIntegrations() {
    if (IS_SUBPANEL) {
      syncNativeArm64Marketplace();
      syncOtaSettingsCard();
    } else {
      ensureComposerWorkspaceSlot();
    }
  }

  window.addEventListener("popstate", function () {
    if (suppressPopStateCount > 0) {
      suppressPopStateCount--;
      return;
    }
    if (overlayHistoryDepth > 0) overlayHistoryDepth--;
    closeWorkspacePopover();
    if (backdropEl && backdropEl.classList.contains("open")) closeDialog(true);
    else if (subSheetEl && subSheetEl.classList.contains("open")) closeSubPanelSheet(true);
  });

  window.addEventListener("ce:host-event", function (ev) {
    if (IS_SUBPANEL) return;
    var pkt = (ev && ev.detail) || {};
    var kind = pkt.__ce_host_event;
    if (kind === "open_external" && pkt.url) {
      var rpc = getHostRpc();
      if (rpc) rpc.openUrl(pkt.url);
    } else if (kind === "toast" && pkt.text) {
      showToast(pkt.text);
    } else if (kind === "show_open_dialog") {
      handleShowOpenDialog(pkt);
    } else if (kind === "panel_disposed" && pkt.panelId && pkt.panelId === activeSubPanelId) {
      activeSubPanelId = null;
      closeSubPanelSheet();
    } else if (kind === "open_preview") {
      if (pkt.kind === "subpanel" && pkt.panelId) {
        openSubPanelSheet(pkt.panelId, pkt.title || "Codex");
      } else if (pkt.kind === "reload") {
        window.location.reload();
      } else if (pkt.kind === "file" && pkt.filePath) {
        openFileEditorDialog(pkt.filePath, pkt.content, pkt.title);
      } else if (pkt.kind === "diff") {
        openDialog(pkt.title || (isEs ? "Diferencias" : "Changes"), function (container) {
          var pre = document.createElement("pre");
          pre.style.cssText = "margin:0;padding:10px;border-radius:8px;background:rgba(0,0,0,0.25);font-family:var(--vscode-editor-font-family);font-size:11.5px;overflow-x:auto;white-space:pre-wrap;";
          pre.textContent = pkt.rightText || "";
          container.appendChild(pre);
        });
      }
    }
  });

  function installHistoryRouteHook() {
    ["pushState", "replaceState"].forEach(function (fnName) {
      var orig = window.history[fnName];
      if (typeof orig !== "function") return;
      window.history[fnName] = function () {
        var res = orig.apply(this, arguments);
        syncDomIntegrations();
        return res;
      };
    });
  }

  function boot() {
    injectStyles();
    applyResolvedTheme(INITIAL_THEME);
    installHistoryRouteHook();
    syncDomIntegrations();

    // Throttled MutationObserver (120ms trailing) so streaming replies never trigger per-frame layout work
    var rootNode = document.getElementById("root") || document.body;
    var syncTimer = null;
    var obs = new MutationObserver(function () {
      if (syncTimer) return;
      syncTimer = setTimeout(function () {
        syncTimer = null;
        syncDomIntegrations();
      }, 120);
    });
    obs.observe(rootNode, { childList: true, subtree: true });

    if (!IS_SUBPANEL) {
      apiGet("/api/info").then(function (info) {
        if (info && info.workspace) setWorkspaceState(info.workspace);
      }).catch(function () {});

      var b = getBridge();
      if (b && typeof b.onUiReady === "function") {
        setTimeout(function () {
          try { b.onUiReady(); } catch (_) {}
        }, 150);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
