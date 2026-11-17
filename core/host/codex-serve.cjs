#!/usr/bin/env node
"use strict";

/**
 * Codex for Android — Hardened Native ARM64 Extension Host (`codex-serve.cjs`)
 * Hosts the official OpenAI Codex VS Code Extension (`openai.chatgpt` v26.51111.x)
 * with zero Electron overhead, per-boot cryptographic authentication + Host/Origin
 * enforcement, async indexed `webview-bundle.pak` serving, workspace management,
 * and 1-Tap ARM64 MCP Plugins Hub (`~/.codex/config.toml`).
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const zlib = require("zlib");
const dns = require("dns");
const Module = require("module");
const { promisify } = require("util");

const gunzipAsync = promisify(zlib.gunzip);
const { createVSCodeShim } = require("./vscode-shim.cjs");

// -----------------------------------------------------------------------------
// CLI Arguments, Per-Boot Secret & Core Paths
// -----------------------------------------------------------------------------
function parseCliArgs(argv) {
  let port = Number(process.env.CE_PORT || 45197);
  let host = "127.0.0.1";
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--port" || a === "-p") && argv[i + 1]) {
      port = Number(argv[++i]) || port;
    } else if (a.startsWith("--port=")) {
      port = Number(a.split("=")[1]) || port;
    } else if ((a === "--host" || a === "--hostname") && argv[i + 1]) {
      host = argv[++i];
    }
  }
  return { host, port };
}

const args = parseCliArgs(process.argv);

// Capture and immediately scrub CE_AUTH_TOKEN so child processes never inherit it
const HOST_AUTH_TOKEN =
  String(process.env.CE_AUTH_TOKEN || "").trim() || crypto.randomBytes(32).toString("hex");
delete process.env.CE_AUTH_TOKEN;
const HOST_AUTH_BUF = Buffer.from(HOST_AUTH_TOKEN, "utf8");

const EXTENSION_DIR = __dirname;
const RUNTIME_DIR = path.resolve(EXTENSION_DIR, "..");
const HOME_DIR = process.env.HOME || path.resolve(RUNTIME_DIR, "..");
const PREFIX_DIR = process.env.PREFIX || path.join(HOME_DIR, "usr");
const WEB_DIR = path.join(HOME_DIR, "web");
const CODEX_DIR = process.env.CODEX_HOME || path.join(HOME_DIR, ".codex");
const HOST_STORAGE_DIR = path.join(CODEX_DIR, "android-host");
const DEFAULT_WORKSPACE = "/storage/emulated/0/Documents/Codex";

process.env.HOME = HOME_DIR;
process.env.CODEX_HOME = CODEX_DIR;

function canonicalizeAndroidPath(p) {
  let s = String(p || "").trim().replace(/\\/g, "/");
  if (!s) return DEFAULT_WORKSPACE;
  s = s.replace(/^\/sdcard(?=\/|$)/, "/storage/emulated/0");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return path.resolve(s) || "/";
}

function canonicalizeExplicitPath(p) {
  const raw = String(p || "").trim();
  if (!raw) return "";
  return canonicalizeAndroidPath(raw);
}

function safeInlineJson(val) {
  return JSON.stringify(val)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function isProtectedSecretPath(absPath) {
  const norm = path.resolve(String(absPath || ""));
  const authJson = path.resolve(CODEX_DIR, "auth.json");
  const secretsJson = path.resolve(HOST_STORAGE_DIR, "secrets.json");
  const netrc = path.resolve(HOME_DIR, ".netrc");
  const adbKey = path.resolve(HOME_DIR, ".android", "adbkey");
  const sshDir = path.resolve(HOME_DIR, ".ssh");
  if (
    norm === authJson ||
    norm === secretsJson ||
    norm === netrc ||
    norm === adbKey ||
    norm === adbKey + ".pub" ||
    norm === sshDir ||
    norm.startsWith(sshDir + path.sep)
  ) {
    return true;
  }
  return false;
}

function isProtectedWritePath(absPath) {
  if (isProtectedSecretPath(absPath)) return true;
  const norm = path.resolve(String(absPath || ""));
  const cfgToml = path.resolve(CODEX_DIR, "config.toml");
  const rtDir = path.resolve(RUNTIME_DIR);
  if (norm === cfgToml || norm === rtDir || norm.startsWith(rtDir + path.sep)) {
    return true;
  }
  return false;
}

function isAllowedWorkspacePath(absPath) {
  const norm = path.resolve(String(absPath || ""));
  if (!norm || norm === "/" || /[\x00-\x1f\x7f<>]/.test(norm)) return false;
  if (isProtectedWritePath(norm)) return false;
  const codexRoot = path.resolve(CODEX_DIR);
  if (norm === codexRoot || norm.startsWith(codexRoot + path.sep)) return false;
  return (
    norm.startsWith("/storage/") ||
    norm.startsWith(path.resolve(HOME_DIR) + path.sep)
  );
}

// -----------------------------------------------------------------------------
// Request Authentication & Loopback Host/Origin Enforcement
// -----------------------------------------------------------------------------
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${args.port}`,
  `localhost:${args.port}`,
]);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${args.port}`,
  `http://localhost:${args.port}`,
]);

function isAllowedLoopbackHost(req) {
  const h = String(req.headers.host || "").trim().toLowerCase();
  return ALLOWED_HOSTS.has(h);
}

function isAllowedOrigin(req, requireOrigin) {
  const raw = req.headers.origin;
  if (raw === undefined || raw === "") {
    return !requireOrigin;
  }
  return ALLOWED_ORIGINS.has(String(raw).trim().toLowerCase());
}

function parseCookieValue(cookieHeader, name) {
  if (!cookieHeader) return "";
  const parts = String(cookieHeader).split(";");
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (seg.startsWith(name + "=")) {
      try {
        return decodeURIComponent(seg.slice(name.length + 1).trim());
      } catch (_) {
        return seg.slice(name.length + 1).trim();
      }
    }
  }
  return "";
}

function verifyTokenConstantTime(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const candBuf = Buffer.from(candidate, "utf8");
  if (candBuf.length !== HOST_AUTH_BUF.length) return false;
  return crypto.timingSafeEqual(candBuf, HOST_AUTH_BUF);
}

function authorizeHttpRequest(req) {
  if (!isAllowedLoopbackHost(req)) return false;
  if (!isAllowedOrigin(req, false)) return false;
  const hdrToken = String(req.headers["x-ce-token"] || "").trim();
  if (hdrToken && verifyTokenConstantTime(hdrToken)) return true;
  const cookieToken = parseCookieValue(req.headers.cookie, "ce_auth");
  return verifyTokenConstantTime(cookieToken);
}

function authorizeUpgradeRequest(req) {
  if (!isAllowedLoopbackHost(req)) return false;
  if (!isAllowedOrigin(req, true)) return false;
  const hdrToken = String(req.headers["x-ce-token"] || "").trim();
  if (hdrToken && verifyTokenConstantTime(hdrToken)) return true;
  const cookieToken = parseCookieValue(req.headers.cookie, "ce_auth");
  return verifyTokenConstantTime(cookieToken);
}

// -----------------------------------------------------------------------------
// Android DNS Setup (Prevents Node c-ares 127.0.0.1:53 ECONNREFUSED)
// -----------------------------------------------------------------------------
function configureAndroidDns() {
  const servers = [];
  const candidates = [
    path.join(HOME_DIR, "etc", "resolv.conf"),
    path.join(PREFIX_DIR, "etc", "resolv.conf"),
  ];
  for (const rc of candidates) {
    try {
      if (!fs.existsSync(rc)) continue;
      const lines = fs.readFileSync(rc, "utf8").split(/\r?\n/);
      for (const line of lines) {
        const m = /^\s*nameserver\s+([^\s#]+)/.exec(line);
        if (m && m[1] && m[1] !== "127.0.0.1" && m[1] !== "::1" && !servers.includes(m[1])) {
          servers.push(m[1]);
        }
      }
    } catch (_) {}
  }
  for (const fb of ["8.8.8.8", "1.1.1.1"]) {
    if (!servers.includes(fb)) servers.push(fb);
  }
  try {
    dns.setServers(servers);
  } catch (_) {}
}
configureAndroidDns();

// -----------------------------------------------------------------------------
// Persistent Android Codex Configuration & Workspace Registry
// -----------------------------------------------------------------------------
const WORKSPACES_STATE_FILE = path.join(HOST_STORAGE_DIR, "workspaces.json");

function ensureAndroidCodexConfig() {
  fs.mkdirSync(CODEX_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(HOST_STORAGE_DIR, { recursive: true, mode: 0o700 });

  const configTomlPath = path.join(CODEX_DIR, "config.toml");
  let toml = "";
  try {
    if (fs.existsSync(configTomlPath)) {
      toml = fs.readFileSync(configTomlPath, "utf8");
    }
  } catch (_) {}

  let changed = false;
  if (!/^\s*sandbox_mode\s*=/m.test(toml)) {
    const header =
      "# Codex for Android — Native ARM64 Configuration\n" +
      "# Linux user-namespace sandboxing (bwrap) is blocked by Android SELinux.\n" +
      'sandbox_mode = "danger-full-access"\n';
    toml = header + (toml ? "\n" + toml : "");
    changed = true;
  }
  const migrated = toml
    .replace(/^\s*code_mode_host\s*=\s*false\s*$/gm, "code_mode_host = true")
    .replace(/^\s*code_mode\s*=\s*false\s*\r?\n?/gm, "")
    .replace(/^\s*code_mode_only\s*=\s*false\s*\r?\n?/gm, "");
  if (migrated !== toml) {
    toml = migrated;
    changed = true;
  }
  if (!/^\s*\[features\]/m.test(toml)) {
    const featBlock = "\n[features]\ncode_mode_host = true\n";
    const firstMcp = toml.search(/^\s*\[mcp_servers\./m);
    if (firstMcp >= 0) {
      toml = toml.slice(0, firstMcp).trimEnd() + "\n" + featBlock + "\n" + toml.slice(firstMcp);
    } else {
      toml = toml.trimEnd() + "\n" + featBlock;
    }
    changed = true;
  } else if (!/^\s*code_mode_host\s*=/m.test(toml)) {
    toml = toml.replace(/^(\s*\[features\]\s*\r?\n)/m, "$1code_mode_host = true\n");
    changed = true;
  }
  if (changed) {
    try {
      const tmp = configTomlPath + ".tmp";
      fs.writeFileSync(tmp, toml, { mode: 0o600 });
      fs.renameSync(tmp, configTomlPath);
    } catch (_) {}
  }

  // Seed bundled skills into ~/.agents/skills/ and ~/.codex/skills/
  const bundledSkillsRoot = path.join(RUNTIME_DIR, "bundled-skills");
  if (fs.existsSync(bundledSkillsRoot)) {
    for (const targetRoot of [path.join(HOME_DIR, ".agents", "skills"), path.join(CODEX_DIR, "skills")]) {
      try {
        fs.mkdirSync(targetRoot, { recursive: true });
        for (const ent of fs.readdirSync(bundledSkillsRoot, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const dst = path.join(targetRoot, ent.name);
          if (!fs.existsSync(dst)) {
            fs.cpSync(path.join(bundledSkillsRoot, ent.name), dst, { recursive: true });
          }
        }
      } catch (_) {}
    }
  }
}

function readWorkspacesRegistry() {
  const defaultWs = canonicalizeAndroidPath(
    process.env.CE_DEFAULT_WORKSPACE || DEFAULT_WORKSPACE
  );
  let state = { activeWorkspace: defaultWs, workspaces: [defaultWs] };
  try {
    if (fs.existsSync(WORKSPACES_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(WORKSPACES_STATE_FILE, "utf8"));
      if (parsed && typeof parsed === "object") {
        const list = Array.isArray(parsed.workspaces)
          ? parsed.workspaces.map(canonicalizeAndroidPath).filter(isAllowedWorkspacePath)
          : [];
        const candActive = canonicalizeAndroidPath(parsed.activeWorkspace || list[0] || defaultWs);
        const active = isAllowedWorkspacePath(candActive) ? candActive : defaultWs;
        if (!list.includes(active)) list.unshift(active);
        state = { activeWorkspace: active, workspaces: Array.from(new Set(list)) };
      }
    }
  } catch (_) {}
  try {
    fs.mkdirSync(state.activeWorkspace, { recursive: true });
  } catch (_) {
    const fallback = path.join(HOME_DIR, "workspace");
    try { fs.mkdirSync(fallback, { recursive: true }); } catch (_) {}
    state.activeWorkspace = fallback;
    if (!state.workspaces.includes(fallback)) state.workspaces.unshift(fallback);
  }
  return state;
}

function saveWorkspacesRegistry(state) {
  try {
    const tmp = WORKSPACES_STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, WORKSPACES_STATE_FILE);
  } catch (_) {}
}

function resolveCodexBinaryPath() {
  const candidates = [
    process.env.CE_CODEX_BIN,
    path.join(RUNTIME_DIR, "bin", "codex"),
    path.join(RUNTIME_DIR, "bin", "codex.elf"),
    path.join(PREFIX_DIR, "bin", "codex"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        fs.chmodSync(c, 0o755);
        return c;
      }
    } catch (_) {}
  }
  return path.join(RUNTIME_DIR, "bin", "codex");
}

ensureAndroidCodexConfig();
let wsRegistry = readWorkspacesRegistry();
saveWorkspacesRegistry(wsRegistry);
try { process.chdir(wsRegistry.activeWorkspace); } catch (_) {}
const codexBinaryPath = resolveCodexBinaryPath();

// -----------------------------------------------------------------------------
// Indexed `webview-bundle.pak` Reader (Sync boot fallback + Async HTTP serving)
// -----------------------------------------------------------------------------
let pakFd = null;
let pakIndex = Object.create(null);

function initWebviewPak() {
  const pakCandidates = [
    path.join(RUNTIME_DIR, "webview-bundle.pak"),
    path.join(EXTENSION_DIR, "webview-bundle.pak"),
  ];
  const idxCandidates = [
    path.join(EXTENSION_DIR, "webview-index.json"),
    path.join(RUNTIME_DIR, "webview-index.json"),
  ];
  const pakFile = pakCandidates.find((p) => fs.existsSync(p));
  const idxFile = idxCandidates.find((p) => fs.existsSync(p));
  if (!pakFile || !idxFile) return;
  try {
    pakIndex = JSON.parse(fs.readFileSync(idxFile, "utf8"));
    pakFd = fs.openSync(pakFile, "r");
  } catch (err) {
    console.error("[codex-host] failed to open webview-bundle.pak:", err.message);
  }
}
initWebviewPak();

function readPakBuffer(relPath, gunzipIfCompressed = false) {
  if (pakFd === null) return null;
  const clean = String(relPath || "").replace(/^\/+/, "");
  const meta = pakIndex[clean];
  if (!meta) return null;
  const [offset, length, isGz] = meta;
  const buf = Buffer.allocUnsafe(length);
  const bytesRead = fs.readSync(pakFd, buf, 0, length, offset);
  const slice = bytesRead === length ? buf : buf.subarray(0, bytesRead);
  if (gunzipIfCompressed && isGz === 1) {
    try { return zlib.gunzipSync(slice); } catch (_) { return slice; }
  }
  return slice;
}

function readPakSliceAsync(offset, length) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.allocUnsafe(length);
    fs.read(pakFd, buf, 0, length, offset, (err, bytesRead) => {
      if (err) return reject(err);
      resolve(bytesRead === length ? buf : buf.subarray(0, bytesRead));
    });
  });
}

async function servePakAsset(req, res, relPath) {
  if (pakFd === null) return false;
  const clean = String(relPath || "").replace(/^\/+/, "");
  const meta = pakIndex[clean];
  if (!meta) return false;
  const [offset, length, isGz, mime] = meta;
  let slice;
  try {
    slice = await readPakSliceAsync(offset, length);
  } catch (_) {
    return false;
  }
  const acceptGz = /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""));

  const headers = {
    "Content-Type": mime || "application/octet-stream",
    "Cache-Control": clean === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  };

  if (isGz === 1) {
    if (acceptGz) {
      headers["Content-Encoding"] = "gzip";
      headers["Content-Length"] = slice.length;
      res.writeHead(200, headers);
      res.end(slice);
      return true;
    }
    const raw = await gunzipAsync(slice);
    headers["Content-Length"] = raw.length;
    res.writeHead(200, headers);
    res.end(raw);
    return true;
  }

  headers["Content-Length"] = slice.length;
  res.writeHead(200, headers);
  res.end(slice);
  return true;
}

// -----------------------------------------------------------------------------
// RFC-6455 Pure Node.js WebSocket Framing (Mask-enforced, O(n) buffered, leak-free)
// -----------------------------------------------------------------------------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WS_MESSAGE_BYTES = 16 * 1024 * 1024;

function acceptWebSocket(req, socket, onMessage, onClose) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  let closing = false;
  let onCloseFired = false;
  let buffer = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragChunks = [];
  let fragBytes = 0;

  function fireOnClose() {
    if (onCloseFired) return;
    onCloseFired = true;
    closing = true;
    fragChunks = [];
    fragBytes = 0;
    buffer = Buffer.alloc(0);
    if (onClose) {
      try { onClose(wsConn); } catch (_) {}
    }
  }

  function sendFrame(opcode, payloadBuf) {
    if (closing || socket.destroyed) return;
    const len = payloadBuf.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      socket.write(Buffer.concat([header, payloadBuf]));
    } catch (_) {}
  }

  function stringifyForWs(obj) {
    return JSON.stringify(obj, (_k, v) => {
      if (v instanceof Uint8Array) {
        return { __ce_u8__: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") };
      }
      if (v && typeof v === "object" && v.type === "Buffer" && Array.isArray(v.data)) {
        return { __ce_u8__: Buffer.from(v.data).toString("base64") };
      }
      return v;
    });
  }

  const wsConn = {
    sendText(str) {
      sendFrame(0x01, Buffer.from(String(str), "utf8"));
    },
    sendJson(obj) {
      sendFrame(0x01, Buffer.from(stringifyForWs(obj), "utf8"));
    },
    close() {
      if (!closing) {
        try { sendFrame(0x08, Buffer.alloc(0)); } catch (_) {}
        closing = true;
        try { socket.end(); } catch (_) {}
      }
      fireOnClose();
    },
  };

  socket.on("data", (chunk) => {
    if (closing) return;
    if (buffer.length + chunk.length > MAX_WS_MESSAGE_BYTES) {
      wsConn.close();
      socket.destroy();
      return;
    }
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      if (!masked) {
        // RFC 6455 §5.1: client-to-server frames MUST be masked
        wsConn.close();
        socket.destroy();
        return;
      }
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_WS_MESSAGE_BYTES)) {
          wsConn.close();
          socket.destroy();
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_WS_MESSAGE_BYTES) {
        wsConn.close();
        socket.destroy();
        return;
      }

      const frameTotal = offset + 4 + payloadLen;
      if (buffer.length < frameTotal) return;

      const mask = buffer.subarray(offset, offset + 4);
      const rawPayload = buffer.subarray(offset + 4, frameTotal);
      const payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = rawPayload[i] ^ mask[i & 3];
      }
      buffer = frameTotal === buffer.length ? Buffer.alloc(0) : buffer.subarray(frameTotal);

      if (opcode === 0x08) {
        wsConn.close();
        return;
      } else if (opcode === 0x09) {
        sendFrame(0x0a, payload);
      } else if (opcode === 0x01 || opcode === 0x02) {
        if (fin) {
          onMessage(payload, opcode === 0x02);
        } else {
          fragOpcode = opcode;
          fragChunks = [payload];
          fragBytes = payload.length;
        }
      } else if (opcode === 0x00 && fragChunks.length > 0) {
        fragBytes += payload.length;
        if (fragBytes > MAX_WS_MESSAGE_BYTES) {
          wsConn.close();
          socket.destroy();
          return;
        }
        fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragChunks, fragBytes);
          const isBin = fragOpcode === 0x02;
          fragChunks = [];
          fragBytes = 0;
          fragOpcode = 0;
          onMessage(full, isBin);
        }
      }
    }
  });

  socket.on("close", fireOnClose);
  socket.on("error", fireOnClose);

  return wsConn;
}

// -----------------------------------------------------------------------------
// Activate Official OpenAI Codex Extension (`openai.chatgpt`)
// -----------------------------------------------------------------------------
const uiClients = new Set(); // { ws, panelId }
const pendingOpenDialogs = new Map(); // reqId -> resolve(paths[])
let openDialogSeq = 0;

function broadcastHostEvent(eventType, payload = {}) {
  const frame = { __ce_host_event: eventType, ...payload };
  for (const c of uiClients) {
    if (c.panelId === "sidebar" || !c.panelId) {
      c.ws.sendJson(frame);
    }
  }
}

const shim = createVSCodeShim({
  port: args.port,
  extensionPath: EXTENSION_DIR,
  storageDir: HOST_STORAGE_DIR,
  initialWorkspace: wsRegistry.activeWorkspace,
  codexBinaryPath,
  readPakBuffer,
  log: (...a) => console.log(...a),
  onPanelCreated(panel) {
    if (panel && panel.isSubPanel) {
      setImmediate(() => {
        broadcastHostEvent("open_preview", {
          kind: "subpanel",
          panelId: panel.id,
          title: panel.title || "Codex",
        });
      });
    }
  },
  onPanelDisposed(panelId) {
    broadcastHostEvent("panel_disposed", { panelId });
  },
  onPanelMessage(panelId, message) {
    for (const c of uiClients) {
      if (c.panelId === panelId) {
        c.ws.sendJson({ __ce_panel_msg: true, panelId, message });
      }
    }
  },
  onOpenExternal(urlStr) {
    if (uiClients.size > 0) {
      broadcastHostEvent("open_external", { url: urlStr });
      return true;
    }
    return false;
  },
  onShowMessage(level, text) {
    broadcastHostEvent("toast", { level, text: String(text || "") });
  },
  onOpenPreview(previewPayload) {
    broadcastHostEvent("open_preview", previewPayload);
  },
  onShowOpenDialog(options = {}) {
    if (uiClients.size === 0) return Promise.resolve([]);
    const reqId = "dlg_" + (++openDialogSeq) + "_" + Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingOpenDialogs.has(reqId)) {
          pendingOpenDialogs.delete(reqId);
          resolve([]);
        }
      }, 180000);
      pendingOpenDialogs.set(reqId, (paths) => {
        clearTimeout(timer);
        resolve(Array.isArray(paths) ? paths : []);
      });
      broadcastHostEvent("show_open_dialog", {
        reqId,
        canSelectFiles: options.canSelectFiles !== false,
        canSelectFolders: Boolean(options.canSelectFolders),
        canSelectMany: Boolean(options.canSelectMany),
        filters: options.filters || null,
        title: options.title || "",
      });
    });
  },
});

const origLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === "vscode") {
    return shim.vscodeApi;
  }
  return origLoad.apply(this, arguments);
};

let extensionActivated = false;
let extModuleRef = null;
let extContextRef = null;

function reloadCodexMcpServers() {
  let sent = false;
  if (extContextRef && Array.isArray(extContextRef.subscriptions)) {
    for (const sub of extContextRef.subscriptions) {
      if (sub && typeof sub.sendMessage === "function") {
        try {
          sub.sendMessage({
            id: "__ce_mcp_reload_" + Date.now(),
            method: "config/mcpServer/reload",
            params: {},
          });
          sent = true;
        } catch (_) {}
      }
    }
  }
  return sent;
}

function switchActiveWorkspace(targetPath) {
  const cand = canonicalizeExplicitPath(targetPath);
  if (!cand || !isAllowedWorkspacePath(cand)) {
    throw new Error("Invalid workspace directory");
  }
  const resolved = shim.setWorkspaceDirectory(cand);
  try { process.chdir(resolved); } catch (_) {}
  wsRegistry.activeWorkspace = resolved;
  if (!wsRegistry.workspaces.includes(resolved)) {
    wsRegistry.workspaces.unshift(resolved);
  }
  saveWorkspacesRegistry(wsRegistry);
  return resolved;
}

async function bootExtensionHost() {
  try {
    extModuleRef = require(path.join(EXTENSION_DIR, "extension.js"));
    const ctx = shim.createExtensionContext();
    extContextRef = ctx;
    await Promise.resolve(extModuleRef.activate(ctx));
    await shim.resolvePrimarySidebarView("chatgpt.sidebarView");
    extensionActivated = true;
    console.log(
      `[codex-host] openai.chatgpt activated; panels=${shim.getPanels().size}; workspace=${shim.getWorkspaceDirectory()}`
    );
  } catch (err) {
    console.error("[codex-host] activation failed:", err && err.stack ? err.stack : err);
  }
}

// -----------------------------------------------------------------------------
// Transform Webview HTML for Mobile Android WebView + WebSocket Bridge
// -----------------------------------------------------------------------------
function sanitizeHttpUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.toString();
    }
  } catch (_) {}
  return "";
}

function readAuthSummary() {
  const authPath = path.join(CODEX_DIR, "auth.json");
  let hasChatGptTokens = false;
  let hasApiKey = false;
  let email = null;
  let planType = null;
  try {
    if (fs.existsSync(authPath)) {
      const a = JSON.parse(fs.readFileSync(authPath, "utf8"));
      if (a && typeof a === "object") {
        if (typeof a.OPENAI_API_KEY === "string" && a.OPENAI_API_KEY.trim().length > 0) {
          hasApiKey = true;
        }
        if (a.tokens && (a.tokens.access_token || a.tokens.refresh_token || a.tokens.id_token)) {
          hasChatGptTokens = true;
          try {
            const parts = String(a.tokens.id_token || "").split(".");
            if (parts.length >= 2) {
              const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
              email = claims.email || null;
              const authClaim = claims["https://api.openai.com/auth"] || {};
              planType = authClaim.chatgpt_plan_type || null;
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  let customBaseUrl = "";
  try {
    const cfgFile = path.join(CODEX_DIR, "config.toml");
    if (fs.existsSync(cfgFile)) {
      const txt = fs.readFileSync(cfgFile, "utf8");
      const m = /^\s*openai_base_url\s*=\s*"([^"]*)"/m.exec(txt);
      if (m) customBaseUrl = sanitizeHttpUrl(m[1]);
    }
  } catch (_) {}

  return {
    authenticated: hasChatGptTokens || hasApiKey,
    mode: hasChatGptTokens ? "chatgpt" : (hasApiKey ? "apikey" : "none"),
    email,
    planType,
    customBaseUrl,
  };
}

function renderPanelHtml(panel, themeHint, isSubPanelView) {
  const panelId = String(panel.id || "sidebar");
  let html = panel.webview.html || "";
  const auth = readAuthSummary();

  // Strip embedded HTML comment inside <html data-build="<!-- PROD_BUILD_TAG_HERE -->"> BEFORE tag regexes
  html = html.replace(/<!--\s*PROD_BUILD_TAG_HERE\s*-->/g, "prod");

  // Replace strict VS Code CSP with local loopback + OpenAI asset/auth policy
  html = html.replace(
    /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self' http://127.0.0.1:${args.port} http://localhost:${args.port} ws://127.0.0.1:${args.port} ws://localhost:${args.port} https: data: blob:; style-src 'self' 'unsafe-inline' http://127.0.0.1:${args.port} http://localhost:${args.port}; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:${args.port} http://localhost:${args.port} blob:; img-src 'self' data: blob: http://127.0.0.1:${args.port} http://localhost:${args.port} https:; media-src 'self' data: blob: http://127.0.0.1:${args.port} http://localhost:${args.port} https:; font-src 'self' data: http://127.0.0.1:${args.port} http://localhost:${args.port}; connect-src 'self' http://127.0.0.1:${args.port} http://localhost:${args.port} ws://127.0.0.1:${args.port} ws://localhost:${args.port} https:; worker-src 'self' blob: http://127.0.0.1:${args.port} http://localhost:${args.port}; frame-src 'self' http://127.0.0.1:${args.port} http://localhost:${args.port} https://*.openai.com https://*.chatgpt.com;">`
  );

  html = html.replace(
    /<meta\s+name="viewport"[^>]*>/i,
    `<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">`
  );

  const resolvedTheme = themeHint === "light" ? "light" : "dark";
  const bodyClass =
    (resolvedTheme === "light" ? "vscode-light" : "vscode-dark") +
    (auth.authenticated ? " ce-authed" : "") +
    (isSubPanelView ? " ce-subpanel" : "");

  html = html.replace(/<html([^>]*)>/i, `<html$1 data-ce-theme="${resolvedTheme}" data-vscode-theme-kind="${resolvedTheme === "light" ? "vscode-light" : "vscode-dark"}">`);
  html = html.replace(/<body([^>]*)>/i, `<body$1 class="${bodyClass}">`);

  const bootTag = `\n    <script src="/__ce_android_boot.js" defer></script>`;

  const bridgeScript = `
    <link rel="stylesheet" href="/ext/codex-theme.css">
    <script>
      (function() {
        var PANEL_ID = ${safeInlineJson(panelId)};
        window.__CE_PANEL_ID__ = PANEL_ID;
        window.__CE_IS_SUBPANEL__ = ${Boolean(isSubPanelView)};
        window.__CE_HOST_THEME__ = ${safeInlineJson(resolvedTheme)};
        window.__CE_INITIAL_WORKSPACE__ = ${safeInlineJson(canonicalizeAndroidPath(shim.getWorkspaceDirectory()))};
        window.__CE_INITIAL_AUTH__ = ${safeInlineJson(auth)};
        var STATE_KEY = "__ce_vscode_state_" + PANEL_ID;
        var MAX_OUT_QUEUE = 200;
        var outQueue = [];
        var ws = null;
        var reconnectTimer = null;
        var reconnectAttempt = 0;
        var everOpened = false;

        function u8ToB64(u8) {
          var CHUNK = 0x8000;
          var parts = [];
          for (var i = 0; i < u8.length; i += CHUNK) {
            parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
          }
          return btoa(parts.join(""));
        }
        function b64ToU8(b64) {
          var bin = atob(b64);
          var out = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        function parseWsJson(raw) {
          return JSON.parse(raw, function(_k, v) {
            if (v && typeof v === "object" && typeof v.__ce_u8__ === "string") {
              return b64ToU8(v.__ce_u8__);
            }
            return v;
          });
        }
        function stringifyWsJson(obj) {
          return JSON.stringify(obj, function(_k, v) {
            if (v instanceof Uint8Array) {
              return { __ce_u8__: u8ToB64(v) };
            }
            return v;
          });
        }

        function scheduleReconnect() {
          if (reconnectTimer || document.visibilityState === "hidden") return;
          var base = Math.min(15000, 500 * Math.pow(1.8, reconnectAttempt));
          reconnectAttempt = Math.min(reconnectAttempt + 1, 10);
          var delay = Math.round(base + Math.random() * 250);
          reconnectTimer = setTimeout(function() {
            reconnectTimer = null;
            connectWs();
          }, delay);
        }

        function connectWs() {
          if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
          var proto = location.protocol === "https:" ? "wss:" : "ws:";
          var url = proto + "//" + location.host + "/ws?panel=" + encodeURIComponent(PANEL_ID);
          ws = new WebSocket(url);
          ws.onopen = function() {
            var isReconnect = everOpened;
            everOpened = true;
            reconnectAttempt = 0;
            if (isReconnect && ws.readyState === 1) {
              ws.send(JSON.stringify({ panelId: PANEL_ID, message: { type: "ready" } }));
            }
            while (outQueue.length > 0 && ws.readyState === 1) {
              ws.send(outQueue.shift());
            }
          };
          ws.onmessage = function(ev) {
            try {
              var pkt = parseWsJson(ev.data);
              if (pkt && pkt.__ce_panel_msg) {
                window.dispatchEvent(new MessageEvent("message", { data: pkt.message, origin: window.location.origin }));
              } else if (pkt && pkt.__ce_host_event) {
                window.dispatchEvent(new CustomEvent("ce:host-event", { detail: pkt }));
              }
            } catch (err) {
              console.error("[ce-ws] parse error:", err);
            }
          };
          ws.onclose = function() {
            ws = null;
            scheduleReconnect();
          };
        }

        document.addEventListener("visibilitychange", function() {
          if (document.visibilityState === "visible" && (!ws || ws.readyState > 1)) {
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            reconnectAttempt = 0;
            connectWs();
          }
        });
        connectWs();

        var apiInstance = {
          postMessage: function(msg) {
            if (msg && msg.type === "set-telemetry-user") {
              window.dispatchEvent(new CustomEvent("ce:telemetry-user", { detail: msg }));
            }
            var raw = stringifyWsJson({ panelId: PANEL_ID, message: msg });
            if (ws && ws.readyState === 1) {
              ws.send(raw);
            } else {
              if (outQueue.length >= MAX_OUT_QUEUE) outQueue.shift();
              outQueue.push(raw);
            }
          },
          getState: function() {
            try {
              var s = sessionStorage.getItem(STATE_KEY);
              return s ? JSON.parse(s) : undefined;
            } catch (_) {
              return undefined;
            }
          },
          setState: function(nextState) {
            try {
              sessionStorage.setItem(STATE_KEY, JSON.stringify(nextState));
            } catch (_) {}
            return nextState;
          }
        };

        window.__CE_VSCODE_API__ = apiInstance;
        window.acquireVsCodeApi = function() {
          return apiInstance;
        };
      })();
    </script>${bootTag}
  `;

  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    html = html.slice(0, headClose) + bridgeScript + html.slice(headClose);
  } else {
    html = bridgeScript + html;
  }
  return html;
}

// -----------------------------------------------------------------------------
// Async Cached Recent Session Workspaces Discovery (`~/.codex/sessions`)
// -----------------------------------------------------------------------------
const rolloutCwdCache = new Map(); // filePath -> { mtimeMs, cwd }
let cachedSessionCwds = { expiresAt: 0, cwds: [] };

async function readRolloutCwdAsync(filePath, mtimeMs) {
  const hit = rolloutCwdCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.cwd;

  let fh = null;
  let cwd = "";
  try {
    fh = await fsp.open(filePath, "r");
    const sample = Buffer.allocUnsafe(8192);
    const { bytesRead } = await fh.read(sample, 0, sample.length, 0);
    const lines = sample.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    for (let i = 0; i < Math.min(lines.length, 8); i++) {
      const ln = lines[i].trim();
      if (!ln.startsWith("{")) continue;
      try {
        const obj = JSON.parse(ln);
        if (obj.type === "session_meta" && obj.payload && obj.payload.cwd) {
          cwd = canonicalizeAndroidPath(obj.payload.cwd);
          break;
        }
      } catch (_) {}
    }
  } catch (_) {
  } finally {
    if (fh) {
      try { await fh.close(); } catch (_) {}
    }
  }
  if (rolloutCwdCache.size > 120) {
    const oldestKey = rolloutCwdCache.keys().next().value;
    if (oldestKey) rolloutCwdCache.delete(oldestKey);
  }
  rolloutCwdCache.set(filePath, { mtimeMs, cwd });
  return cwd;
}

async function discoverSessionWorkspaceDirs() {
  const now = Date.now();
  if (now < cachedSessionCwds.expiresAt) {
    return cachedSessionCwds.cwds;
  }
  const sessionsRoot = path.join(CODEX_DIR, "sessions");
  const files = [];

  async function walk(dir, depth) {
    if (depth > 4) return;
    let ents;
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const st = await fsp.stat(full);
          files.push({ full, mtimeMs: st.mtimeMs });
        } catch (_) {}
      }
    }
  }

  await walk(sessionsRoot, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const cwds = [];
  const seen = new Set();
  for (const item of files.slice(0, 40)) {
    const cwd = await readRolloutCwdAsync(item.full, item.mtimeMs);
    if (cwd && isAllowedWorkspacePath(cwd) && !seen.has(cwd)) {
      seen.add(cwd);
      cwds.push(cwd);
    }
  }
  cachedSessionCwds = { expiresAt: now + 15000, cwds };
  return cwds;
}

// -----------------------------------------------------------------------------
// MCP Servers TOML Manager (`~/.codex/config.toml`)
// -----------------------------------------------------------------------------
const SAFE_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function cleanTomlStringVal(v) {
  return String(v == null ? "" : v).replace(/[\x00-\x1f\x7f]/g, "");
}

function readMcpCatalog() {
  const candidates = [
    path.join(WEB_DIR, "__ce_plugins_catalog.json"),
    path.resolve(EXTENSION_DIR, "..", "..", "web", "__ce_plugins_catalog.json"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, "utf8"));
    } catch (_) {}
  }
  return { plugins: [] };
}

function readConfiguredMcpIds() {
  const cfgPath = path.join(CODEX_DIR, "config.toml");
  const enabled = new Set();
  try {
    if (fs.existsSync(cfgPath)) {
      const txt = fs.readFileSync(cfgPath, "utf8");
      const re = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm;
      let m;
      while ((m = re.exec(txt)) !== null) {
        enabled.add(m[1]);
      }
    }
  } catch (_) {}
  return enabled;
}

function upsertOrRemoveMcpInToml(id, serverDef) {
  const safeId = String(id || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeId) return false;
  const cfgPath = path.join(CODEX_DIR, "config.toml");
  let txt = "";
  try {
    if (fs.existsSync(cfgPath)) txt = fs.readFileSync(cfgPath, "utf8");
  } catch (_) {}

  const blockRe = new RegExp(
    `\\n?\\[mcp_servers\\.${safeId}(?:\\.(?:env|headers))?\\][\\s\\S]*?(?=\\n\\[|$)`,
    "g"
  );
  txt = txt.replace(blockRe, "").trimEnd();

  if (serverDef) {
    const lines = ["", `[mcp_servers.${safeId}]`];
    if (serverDef.url) {
      lines.push(`url = ${JSON.stringify(cleanTomlStringVal(serverDef.url))}`);
    } else {
      lines.push(`command = ${JSON.stringify(cleanTomlStringVal(serverDef.command || ""))}`);
      const argsArr = Array.isArray(serverDef.args)
        ? serverDef.args.map((x) => JSON.stringify(cleanTomlStringVal(x)))
        : [];
      lines.push(`args = [${argsArr.join(", ")}]`);
    }
    if (serverDef.env && typeof serverDef.env === "object") {
      const envEntries = Object.entries(serverDef.env).filter(([k]) => SAFE_ENV_KEY_RE.test(k));
      if (envEntries.length > 0) {
        lines.push(`[mcp_servers.${safeId}.env]`);
        for (const [k, v] of envEntries) {
          lines.push(`${k} = ${JSON.stringify(cleanTomlStringVal(v))}`);
        }
      }
    }
    txt += "\n" + lines.join("\n") + "\n";
  } else if (txt.length > 0) {
    txt += "\n";
  }

  fs.writeFileSync(cfgPath + ".tmp", txt, { mode: 0o600 });
  fs.renameSync(cfgPath + ".tmp", cfgPath);
  return true;
}

// -----------------------------------------------------------------------------
// Attachment Temp Directory Housekeeping (`~/.codex/attachments`)
// -----------------------------------------------------------------------------
let lastAttachmentPruneMs = 0;

async function pruneOldAttachments(attDir) {
  const now = Date.now();
  if (now - lastAttachmentPruneMs < 300000) return;
  lastAttachmentPruneMs = now;
  const maxAgeMs = 24 * 60 * 60 * 1000;
  try {
    const ents = await fsp.readdir(attDir, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isFile()) continue;
      const full = path.join(attDir, e.name);
      try {
        const st = await fsp.stat(full);
        if (now - st.mtimeMs > maxAgeMs) {
          await fsp.unlink(full);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// -----------------------------------------------------------------------------
// HTTP + WebSocket Loopback Server
// -----------------------------------------------------------------------------
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const SAFE_INLINE_RAW_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico",
  ".mp3", ".wav", ".mp4", ".webm",
]);

function sendJson(res, status, obj) {
  const raw = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": raw.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(raw);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("application/json")) {
      const err = new Error("Unsupported Content-Type");
      err.statusCode = 415;
      reject(err);
      return;
    }
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > 16 * 1024 * 1024) {
        const err = new Error("Body too large");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks, total).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        e.statusCode = 400;
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function serveStaticFileAsync(res, filePath, cacheImmutable = false, extraHeaders = null) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const buf = await fsp.readFile(filePath);
    const headers = {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": buf.length,
      "Cache-Control": cacheImmutable ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...(extraHeaders || {}),
    };
    res.writeHead(200, headers);
    res.end(buf);
    return true;
  } catch (_) {
    return false;
  }
}

const NORM_EXT_DIR = path.resolve(EXTENSION_DIR);
const NORM_EXT_WEBVIEW_DIR = path.resolve(EXTENSION_DIR, "webview");

const server = http.createServer(async (req, res) => {
  try {
    if (!isAllowedLoopbackHost(req)) {
      return sendJson(res, 403, { ok: false, error: "Forbidden host" });
    }

    const parsed = new URL(req.url || "/", `http://127.0.0.1:${args.port}`);
    const pathname = parsed.pathname;

    // 1. Cryptographic HMAC Health Check probed by Android CoreReadyProbe
    if (pathname === "/__ce_health" || pathname === "/healthz") {
      const nonce = String(parsed.searchParams.get("nonce") || "").trim();
      const hmac = nonce
        ? crypto.createHmac("sha256", HOST_AUTH_TOKEN).update(nonce, "utf8").digest("hex")
        : undefined;
      return sendJson(res, extensionActivated ? 200 : 503, {
        ok: extensionActivated,
        ...(hmac ? { hmac } : {}),
      });
    }

    // Gate EVERY remaining endpoint behind per-boot secret + Origin validation
    if (!authorizeHttpRequest(req)) {
      return sendJson(res, 403, { ok: false, error: "Unauthorized" });
    }

    if (pathname === "/api/info" && req.method === "GET") {
      const ws = canonicalizeAndroidPath(shim.getWorkspaceDirectory());
      return sendJson(res, 200, {
        ok: true,
        workspace: ws,
        auth: readAuthSummary(),
      });
    }

    if (pathname === "/api/subpanel/close" && req.method === "POST") {
      const body = await readJsonBody(req);
      const pid = String(body.panelId || "");
      if (pid && pid !== "sidebar") {
        const p = shim.getPanels().get(pid);
        if (p && typeof p.dispose === "function") p.dispose();
      }
      return sendJson(res, 200, { ok: true });
    }

    // 2. Main Codex UI & Sub-panel HTML
    if (pathname === "/" || pathname === "/index.html") {
      if (!extensionActivated) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Starting Codex host...");
        return;
      }
      const reqPanelId = parsed.searchParams.get("panel") || "sidebar";
      const isSubPanel = parsed.searchParams.get("subpanel") === "1" || reqPanelId !== "sidebar";
      const themeHint = parsed.searchParams.get("theme") || "dark";
      let panel = shim.getPanels().get(reqPanelId);
      if (!panel && reqPanelId === "sidebar") {
        panel = await shim.resolvePrimarySidebarView("chatgpt.sidebarView");
      }
      if (!panel) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Panel not found");
        return;
      }
      const html = renderPanelHtml(panel, themeHint, isSubPanel);
      const buf = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": buf.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(buf);
      return;
    }

    // 3. Indexed Webview Assets (`/ext/webview/*`) + Extension Assets (`/ext/*`)
    if (pathname.startsWith("/ext/webview/")) {
      const rel = decodeURIComponent(pathname.slice("/ext/webview/".length));
      if (await servePakAsset(req, res, rel)) return;
      const diskFallback = path.resolve(NORM_EXT_WEBVIEW_DIR, rel);
      if (
        diskFallback.startsWith(NORM_EXT_WEBVIEW_DIR + path.sep) &&
        (await serveStaticFileAsync(res, diskFallback, true))
      ) {
        return;
      }
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    if (pathname.startsWith("/ext/")) {
      const rel = decodeURIComponent(pathname.slice("/ext/".length));
      const full = path.resolve(NORM_EXT_DIR, rel);
      if (
        full.startsWith(NORM_EXT_DIR + path.sep) &&
        (await serveStaticFileAsync(res, full, false))
      ) {
        return;
      }
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // Fallback for root-relative webview assets (/assets/*, /images/*, /fonts/*, /audio/*)
    if (
      pathname.startsWith("/assets/") ||
      pathname.startsWith("/images/") ||
      pathname.startsWith("/fonts/") ||
      pathname.startsWith("/audio/")
    ) {
      const rel = decodeURIComponent(pathname.slice(1));
      if (await servePakAsset(req, res, rel)) return;
    }

    // 4. Android Mobile UI Assets (`/__ce_android_boot.js`, `/__ce_plugins_catalog.json`, `/codex-icon.png`)
    if (
      pathname === "/__ce_android_boot.js" ||
      pathname === "/__ce_plugins_catalog.json" ||
      pathname === "/codex-icon.png"
    ) {
      const cleanName = pathname.slice(1);
      for (const base of [WEB_DIR, path.resolve(EXTENSION_DIR, "..", "..", "web")]) {
        if (await serveStaticFileAsync(res, path.join(base, cleanName), false)) return;
      }
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    // 5. Workspaces & New Chat API
    if (pathname === "/api/workspaces" && req.method === "GET") {
      const sessionCwds = await discoverSessionWorkspaceDirs();
      const wsSet = new Set(wsRegistry.workspaces.map(canonicalizeAndroidPath).filter(isAllowedWorkspacePath));
      for (const cwd of sessionCwds) wsSet.add(cwd);
      const activeWs = canonicalizeAndroidPath(shim.getWorkspaceDirectory());
      wsSet.add(activeWs);

      const workspaces = Array.from(wsSet).map((wsPath) => ({
        path: wsPath,
        name: path.basename(wsPath) || wsPath,
        active: wsPath === activeWs,
      }));

      return sendJson(res, 200, {
        ok: true,
        activeWorkspace: activeWs,
        workspaces,
      });
    }

    if (pathname === "/api/workspaces/select" && req.method === "POST") {
      const body = await readJsonBody(req);
      const rawWs = String(body.workspace || "").trim();
      if (!rawWs) return sendJson(res, 400, { ok: false, error: "Missing workspace" });
      const resolved = switchActiveWorkspace(rawWs);
      return sendJson(res, 200, { ok: true, activeWorkspace: resolved });
    }

    if (pathname === "/api/workspaces/create" && req.method === "POST") {
      const body = await readJsonBody(req);
      const rawName = path.basename(String(body.name || "").trim()).replace(/[\x00-\x1f\x7f<>]/g, "");
      const parentDir = body.parentDir
        ? canonicalizeExplicitPath(body.parentDir)
        : DEFAULT_WORKSPACE;
      const target = body.fullPath
        ? canonicalizeExplicitPath(body.fullPath)
        : canonicalizeExplicitPath(path.join(parentDir || DEFAULT_WORKSPACE, rawName || "NewProject"));
      const resolved = switchActiveWorkspace(target);
      return sendJson(res, 200, { ok: true, activeWorkspace: resolved });
    }

    if (pathname === "/api/sessions/new" && req.method === "POST") {
      await shim.vscodeApi.commands.executeCommand("chatgpt.newChat");
      return sendJson(res, 200, { ok: true });
    }

    // 6. Sandboxed File Preview, Editor & Attachment API
    if (pathname === "/api/fs/raw" && req.method === "GET") {
      const target = canonicalizeExplicitPath(parsed.searchParams.get("path") || "");
      if (!target || isProtectedSecretPath(target)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const ext = path.extname(target).toLowerCase();
      const extraHeaders = {
        "Content-Security-Policy": "sandbox",
      };
      if (!SAFE_INLINE_RAW_EXTS.has(ext)) {
        const safeBase = path.basename(target).replace(/["\r\n]/g, "_");
        extraHeaders["Content-Disposition"] = `attachment; filename="${safeBase}"`;
      }
      if (await serveStaticFileAsync(res, target, false, extraHeaders)) return;
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    if (pathname === "/api/fs/read" && req.method === "GET") {
      const target = canonicalizeExplicitPath(parsed.searchParams.get("path") || "");
      if (!target) return sendJson(res, 400, { ok: false, error: "Missing path" });
      if (isProtectedSecretPath(target)) return sendJson(res, 403, { ok: false, error: "Forbidden path" });
      let st;
      try {
        st = await fsp.stat(target);
      } catch (_) {
        return sendJson(res, 404, { ok: false, error: "File not found" });
      }
      if (!st.isFile()) return sendJson(res, 404, { ok: false, error: "Not a file" });
      if (st.size > 2 * 1024 * 1024) return sendJson(res, 413, { ok: false, error: "File larger than 2 MB" });
      const content = await fsp.readFile(target, "utf8");
      return sendJson(res, 200, { ok: true, path: target, content });
    }

    if (pathname === "/api/fs/write" && req.method === "POST") {
      const body = await readJsonBody(req);
      const target = canonicalizeExplicitPath(body.path || "");
      if (!target) return sendJson(res, 400, { ok: false, error: "Missing path" });
      if (isProtectedWritePath(target)) return sendJson(res, 403, { ok: false, error: "Forbidden path" });
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, String(body.content ?? ""), "utf8");
      return sendJson(res, 200, { ok: true, path: target });
    }

    if (pathname === "/api/dialog/resolve" && req.method === "POST") {
      const body = await readJsonBody(req);
      const reqId = String(body.reqId || "");
      const paths = Array.isArray(body.paths)
        ? body.paths
            .map((p) => canonicalizeExplicitPath(p))
            .filter((p) => p && !isProtectedSecretPath(p))
        : [];
      const fn = pendingOpenDialogs.get(reqId);
      if (fn) {
        pendingOpenDialogs.delete(reqId);
        fn(paths);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/fs/upload-attachment" && req.method === "POST") {
      const body = await readJsonBody(req);
      const rawName = path.basename(String(body.name || "attachment.bin")).replace(/[^A-Za-z0-9._-]/g, "_");
      const b64 = String(body.dataBase64 || "");
      const attDir = path.join(CODEX_DIR, "attachments");
      await fsp.mkdir(attDir, { recursive: true });
      pruneOldAttachments(attDir).catch(() => {});
      const dest = path.join(attDir, `${Date.now()}-${rawName}`);
      await fsp.writeFile(dest, Buffer.from(b64, "base64"));
      return sendJson(res, 200, { ok: true, path: dest });
    }

    if (pathname === "/api/fs/dir" && req.method === "GET") {
      const rawQuery = parsed.searchParams.get("path");
      const dir = rawQuery ? canonicalizeExplicitPath(rawQuery) : canonicalizeAndroidPath(shim.getWorkspaceDirectory());
      if (!dir) return sendJson(res, 400, { ok: false, error: "Invalid directory" });
      const parent = path.dirname(dir);
      const items = [];
      try {
        const ents = await fsp.readdir(dir, { withFileTypes: true });
        for (const e of ents) {
          if (e.name.startsWith(".")) continue;
          if (e.isDirectory()) {
            items.push({ name: e.name, path: path.join(dir, e.name), type: "directory" });
          }
        }
        items.sort((a, b) => a.name.localeCompare(b.name));
      } catch (_) {}
      return sendJson(res, 200, { ok: true, directory: dir, parent, items });
    }

    // 7. 1-Tap ARM64 MCP Plugins Hub (`~/.codex/config.toml` + `~/.codex/android-plugins.json`)
    if (pathname === "/api/plugins" && req.method === "GET") {
      const cat = readMcpCatalog();
      const enabledMcp = readConfiguredMcpIds();
      let hubMeta = {};
      try {
        const stateFile = path.join(CODEX_DIR, "android-plugins.json");
        if (fs.existsSync(stateFile)) {
          const parsedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          hubMeta = (parsedState && parsedState.plugins) || {};
        }
      } catch (_) {}
      const hubRoot = path.join(CODEX_DIR, "plugins-hub");
      const list = (cat.plugins || []).map((p) => {
        const key = p.name || p.id;
        const dirExists = fs.existsSync(path.join(hubRoot, key));
        const meta = hubMeta[key] || null;
        const installed = Boolean(dirExists || meta);
        let enabled = enabledMcp.has(p.id);
        if (!enabled && meta && Array.isArray(meta.servers) && meta.servers.length > 0) {
          enabled = meta.servers.some((srv) => enabledMcp.has(String(srv).replace(/[^A-Za-z0-9_-]/g, "")));
        } else if (!p.mcp && meta && typeof meta.enabled === "boolean") {
          enabled = installed && meta.enabled;
        }
        return {
          ...p,
          installed,
          enabled,
        };
      });
      return sendJson(res, 200, { ok: true, plugins: list, enabledIds: Array.from(enabledMcp) });
    }

    if (pathname === "/api/plugins/reload" && req.method === "POST") {
      await readJsonBody(req);
      const reloaded = reloadCodexMcpServers();
      return sendJson(res, 200, {
        ok: true,
        reloaded,
        enabledIds: Array.from(readConfiguredMcpIds()),
      });
    }

    if (pathname === "/api/plugins/toggle" && req.method === "POST") {
      const body = await readJsonBody(req);
      const id = String(body.id || "").trim();
      const enable = Boolean(body.enable);
      const cat = readMcpCatalog();
      const item = (cat.plugins || []).find((p) => p.id === id || p.name === id);
      if (!item) {
        return sendJson(res, 404, { ok: false, error: "Plugin not found in catalog" });
      }
      const rawDef = item.mcp || null;
      let resolvedDef = null;
      if (enable && rawDef) {
        const replaceVars = (s) =>
          String(s || "")
            .replace(/\$PREFIX/g, PREFIX_DIR)
            .replace(/\$HOME/g, HOME_DIR);
        resolvedDef = {
          command: rawDef.command ? replaceVars(rawDef.command) : undefined,
          args: Array.isArray(rawDef.args) ? rawDef.args.map(replaceVars) : [],
          url: rawDef.url ? replaceVars(rawDef.url) : undefined,
          env: rawDef.env || {},
        };
      }
      if (rawDef || !enable) {
        upsertOrRemoveMcpInToml(item.id || id, enable ? resolvedDef : null);
        reloadCodexMcpServers();
      }
      return sendJson(res, 200, { ok: true, enabledIds: Array.from(readConfiguredMcpIds()) });
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (err) {
    const code = err && typeof err.statusCode === "number" ? err.statusCode : 500;
    console.error("[codex-host] HTTP error:", err && err.stack ? err.stack : err);
    if (!res.headersSent) {
      sendJson(res, code, { ok: false, error: String(err && err.message ? err.message : err) });
    } else {
      res.destroy();
    }
  }
});

server.on("upgrade", (req, socket) => {
  try {
    if (!authorizeUpgradeRequest(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const parsed = new URL(req.url || "/", `http://127.0.0.1:${args.port}`);
    if (parsed.pathname === "/ws") {
      const panelId = parsed.searchParams.get("panel") || "sidebar";
      let clientRec = null;
      const ws = acceptWebSocket(
        req,
        socket,
        (buf) => {
          try {
            const pkt = JSON.parse(buf.toString("utf8"), (_k, v) => {
              if (v && typeof v === "object" && typeof v.__ce_u8__ === "string") {
                const b = Buffer.from(v.__ce_u8__, "base64");
                return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
              }
              return v;
            });
            const targetId = pkt.panelId || panelId;
            const panel = shim.getPanels().get(targetId);
            if (panel && panel.webview && pkt.message) {
              panel.webview._receiveFromClient(pkt.message);
            }
          } catch (_) {}
        },
        () => {
          if (clientRec) uiClients.delete(clientRec);
        }
      );
      if (!ws) return;
      clientRec = { ws, panelId };
      uiClients.add(clientRec);
      return;
    }
    socket.destroy();
  } catch (_) {
    socket.destroy();
  }
});

// Prevent unhandled stream/async errors from crashing the host daemon
process.on("uncaughtException", (err) => {
  console.error("[codex-host] uncaughtException:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[codex-host] unhandledRejection:", reason);
});

let shuttingDown = false;
function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (extModuleRef && typeof extModuleRef.deactivate === "function") {
      Promise.resolve(extModuleRef.deactivate()).catch(() => {});
    }
  } catch (_) {}
  for (const c of uiClients) {
    try { c.ws.close(); } catch (_) {}
  }
  uiClients.clear();
  try {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  } catch (_) {
    process.exit(0);
  }
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
process.on("SIGHUP", gracefulShutdown);

// Start listening immediately so /__ce_health responds while extension activates
server.listen(args.port, args.host, () => {
  console.log(`[codex-host] listening on http://${args.host}:${args.port}`);
  bootExtensionHost();
});
