"use strict";

/**
 * Codex for Android — Pure Node.js `vscode` API Shim
 * Tailored specifically to the official OpenAI Codex VS Code Extension (`openai.chatgpt` v26.51111.x)
 * running standalone on native Android ARM64 without Electron or code-server.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

function createVSCodeShim(hostOpts) {
  const port = hostOpts.port;
  const extensionPath = hostOpts.extensionPath;
  const storageDir = hostOpts.storageDir;
  const codexBinaryPath = hostOpts.codexBinaryPath || "";
  const readPakBuffer = typeof hostOpts.readPakBuffer === "function" ? hostOpts.readPakBuffer : () => null;
  const onPanelCreated = hostOpts.onPanelCreated || (() => {});
  const onPanelDisposed = hostOpts.onPanelDisposed || (() => {});
  const onPanelMessage = hostOpts.onPanelMessage || (() => {});
  const onOpenExternal = hostOpts.onOpenExternal || (() => false);
  const onShowMessage = hostOpts.onShowMessage || (() => {});
  const onOpenPreview = hostOpts.onOpenPreview || (() => {});
  const log = hostOpts.log || (() => {});

  fs.mkdirSync(storageDir, { recursive: true });

  let packageJSON = { name: "chatgpt", publisher: "openai", version: "26.51111.21308" };
  try {
    const pkgFile = path.join(extensionPath, "package.json");
    if (fs.existsSync(pkgFile)) {
      packageJSON = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    }
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // Core Primitives: Disposable, EventEmitter, CancellationToken
  // ---------------------------------------------------------------------------
  class Disposable {
    constructor(callOnDispose) {
      this._fn = typeof callOnDispose === "function" ? callOnDispose : null;
      this._disposed = false;
    }
    static from(...items) {
      return new Disposable(() => {
        for (const it of items) {
          try {
            if (it && typeof it.dispose === "function") it.dispose();
          } catch (_) {}
        }
      });
    }
    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      const fn = this._fn;
      this._fn = null;
      if (fn) {
        try { fn(); } catch (_) {}
      }
    }
  }

  class EventEmitter {
    constructor() {
      this._listeners = new Set();
      this.event = (listener, thisArgs, disposables) => {
        const entry = { fn: listener, ctx: thisArgs };
        this._listeners.add(entry);
        const disp = new Disposable(() => this._listeners.delete(entry));
        if (Array.isArray(disposables)) disposables.push(disp);
        return disp;
      };
    }
    fire(data) {
      for (const entry of Array.from(this._listeners)) {
        try {
          entry.fn.call(entry.ctx, data);
        } catch (err) {
          log("[vscode-shim] event listener error:", err && err.stack ? err.stack : err);
        }
      }
    }
    dispose() {
      this._listeners.clear();
    }
  }

  class CancellationError extends Error {
    constructor() {
      super("Canceled");
      this.name = "Canceled";
    }
  }

  class CancellationTokenSource {
    constructor() {
      this._emitter = new EventEmitter();
      this._cancelled = false;
      const self = this;
      this.token = {
        get isCancellationRequested() {
          return self._cancelled;
        },
        onCancellationRequested: this._emitter.event,
      };
    }
    cancel() {
      if (this._cancelled) return;
      this._cancelled = true;
      this._emitter.fire(undefined);
    }
    dispose() {
      this._emitter.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Uri, Position, Range, Selection, Location, CodeLens, WorkspaceEdit
  // ---------------------------------------------------------------------------
  class Uri {
    constructor(scheme, authority, fsPathVal, query, fragment) {
      this.scheme = scheme || "file";
      this.authority = authority || "";
      this.path = (fsPathVal || "").replace(/\\/g, "/");
      this.query = query || "";
      this.fragment = fragment || "";
    }
    get fsPath() {
      return this.path;
    }
    static file(p) {
      const resolved = path.resolve(String(p || "/"));
      return new Uri("file", "", resolved, "", "");
    }
    static parse(value) {
      const raw = String(value || "");
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(raw);
      if (!m) return Uri.file(raw);
      const scheme = m[1].toLowerCase();
      const authority = decodeURIComponent(m[2] || "");
      const p = decodeURIComponent(m[3] || "");
      const query = m[4] || "";
      const fragment = m[5] || "";
      return new Uri(scheme, authority, p, query, fragment);
    }
    static from(components) {
      const c = components || {};
      return new Uri(
        c.scheme || "file",
        c.authority || "",
        c.path || "",
        c.query || "",
        c.fragment || ""
      );
    }
    static joinPath(base, ...segments) {
      const joined = path.posix.join(base.path || "/", ...segments.map((s) => String(s)));
      return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
    }
    with(change) {
      if (!change) return this;
      return new Uri(
        change.scheme !== undefined ? change.scheme : this.scheme,
        change.authority !== undefined ? change.authority : this.authority,
        change.path !== undefined ? change.path : this.path,
        change.query !== undefined ? change.query : this.query,
        change.fragment !== undefined ? change.fragment : this.fragment
      );
    }
    toString(skipEncoding) {
      const encodeSeg = skipEncoding
        ? (s) => s
        : (s) => String(s || "").split("/").map((seg) => encodeURIComponent(seg)).join("/");
      if (this.scheme === "file" && !this.authority && !this.query && !this.fragment) {
        return `file://${encodeSeg(this.path)}`;
      }
      const auth = this.authority ? `//${this.authority}` : "//";
      const q = this.query ? `?${this.query}` : "";
      const f = this.fragment ? `#${this.fragment}` : "";
      return `${this.scheme}:${auth}${encodeSeg(this.path)}${q}${f}`;
    }
    toJSON() {
      return {
        $mid: 1,
        fsPath: this.fsPath,
        external: this.toString(),
        path: this.path,
        scheme: this.scheme,
        authority: this.authority,
        query: this.query,
        fragment: this.fragment,
      };
    }
  }

  class Position {
    constructor(line = 0, character = 0) {
      this.line = Math.max(0, Number(line) || 0);
      this.character = Math.max(0, Number(character) || 0);
    }
    isEqual(other) {
      return !!other && this.line === other.line && this.character === other.character;
    }
    isBefore(other) {
      return this.line < other.line || (this.line === other.line && this.character < other.character);
    }
    isAfter(other) {
      return other.isBefore(this);
    }
    compareTo(other) {
      if (this.isEqual(other)) return 0;
      return this.isBefore(other) ? -1 : 1;
    }
    translate(lineDelta = 0, charDelta = 0) {
      if (typeof lineDelta === "object" && lineDelta !== null) {
        return new Position(this.line + (lineDelta.lineDelta || 0), this.character + (lineDelta.characterDelta || 0));
      }
      return new Position(this.line + lineDelta, this.character + charDelta);
    }
    with(line, character) {
      if (typeof line === "object" && line !== null) {
        return new Position(
          line.line !== undefined ? line.line : this.line,
          line.character !== undefined ? line.character : this.character
        );
      }
      return new Position(line !== undefined ? line : this.line, character !== undefined ? character : this.character);
    }
  }

  class Range {
    constructor(a, b, c, d) {
      if (a instanceof Position || (a && typeof a.line === "number")) {
        const p1 = new Position(a.line, a.character);
        const p2 = b ? new Position(b.line, b.character) : p1;
        this.start = p1.isBefore(p2) || p1.isEqual(p2) ? p1 : p2;
        this.end = p1.isBefore(p2) || p1.isEqual(p2) ? p2 : p1;
      } else {
        this.start = new Position(a, b);
        this.end = new Position(c, d);
      }
    }
    get isEmpty() { return this.start.isEqual(this.end); }
    get isSingleLine() { return this.start.line === this.end.line; }
    contains(posOrRange) {
      if (!posOrRange) return false;
      if (posOrRange.start && posOrRange.end) {
        return this.contains(posOrRange.start) && this.contains(posOrRange.end);
      }
      return !posOrRange.isBefore(this.start) && !posOrRange.isAfter(this.end);
    }
    with(start, end) {
      return new Range(start || this.start, end || this.end);
    }
  }

  class Selection extends Range {
    constructor(a, b, c, d) {
      if (a instanceof Position || (a && typeof a.line === "number")) {
        const anchor = new Position(a.line, a.character);
        const active = b ? new Position(b.line, b.character) : anchor;
        super(anchor, active);
        this.anchor = anchor;
        this.active = active;
      } else {
        const anchor = new Position(a, b);
        const active = new Position(c, d);
        super(anchor, active);
        this.anchor = anchor;
        this.active = active;
      }
    }
    get isReversed() { return this.active.isBefore(this.anchor); }
  }

  class Location {
    constructor(uri, rangeOrPosition) {
      this.uri = uri;
      this.range = rangeOrPosition instanceof Range
        ? rangeOrPosition
        : new Range(rangeOrPosition || new Position(0, 0), rangeOrPosition || new Position(0, 0));
    }
  }

  class CodeLens {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }
    get isResolved() {
      return Boolean(this.command);
    }
  }

  class RelativePattern {
    constructor(base, pattern) {
      if (typeof base === "string") {
        this.baseUri = Uri.file(base);
        this.base = base;
      } else if (base && base.uri) {
        this.baseUri = base.uri;
        this.base = base.uri.fsPath;
      } else if (base instanceof Uri) {
        this.baseUri = base;
        this.base = base.fsPath;
      } else {
        this.baseUri = Uri.file(currentWorkspaceDir || "/");
        this.base = this.baseUri.fsPath;
      }
      this.pattern = String(pattern || "*");
    }
  }

  class TextEdit {
    constructor(range, newText) {
      this.range = range;
      this.newText = newText || "";
    }
    static replace(range, newText) { return new TextEdit(range, newText); }
    static insert(pos, newText) { return new TextEdit(new Range(pos, pos), newText); }
    static delete(range) { return new TextEdit(range, ""); }
  }

  class WorkspaceEdit {
    constructor() {
      this._ops = [];
      this._map = new Map();
    }
    replace(uri, range, newText) { this._addTextEdit(uri, new TextEdit(range, newText)); }
    insert(uri, pos, newText) { this._addTextEdit(uri, new TextEdit(new Range(pos, pos), newText)); }
    delete(uri, range) { this._addTextEdit(uri, new TextEdit(range, "")); }
    _addTextEdit(uri, edit) {
      const key = uri.toString();
      if (!this._map.has(key)) this._map.set(key, { uri, edits: [] });
      this._map.get(key).edits.push(edit);
      this._ops.push({ kind: "edit", uri, edit });
    }
    set(uri, edits) {
      const key = uri.toString();
      this._map.set(key, { uri, edits: Array.isArray(edits) ? edits.slice() : [] });
      this._ops.push({ kind: "set", uri, edits: Array.isArray(edits) ? edits.slice() : [] });
    }
    get(uri) {
      const item = this._map.get(uri.toString());
      return item ? item.edits : [];
    }
    has(uri) { return this._map.has(uri.toString()); }
    entries() { return Array.from(this._map.values()).map((v) => [v.uri, v.edits]); }
    createFile(uri, options) { this._ops.push({ kind: "create", uri, options: options || {} }); }
    deleteFile(uri, options) { this._ops.push({ kind: "delete", uri, options: options || {} }); }
    renameFile(oldUri, newUri, options) { this._ops.push({ kind: "rename", oldUri, newUri, options: options || {} }); }
    get size() { return this._map.size + this._ops.filter((o) => o.kind !== "edit").length; }
  }

  class FileSystemError extends Error {
    constructor(message, code) {
      super(message || code || "FileSystemError");
      this.code = code || "Unknown";
    }
    static FileNotFound(u) { return new FileSystemError(String(u || ""), "FileNotFound"); }
    static FileExists(u) { return new FileSystemError(String(u || ""), "FileExists"); }
    static FileNotADirectory(u) { return new FileSystemError(String(u || ""), "FileNotADirectory"); }
    static FileIsADirectory(u) { return new FileSystemError(String(u || ""), "FileIsADirectory"); }
    static NoPermissions(u) { return new FileSystemError(String(u || ""), "NoPermissions"); }
    static Unavailable(u) { return new FileSystemError(String(u || ""), "Unavailable"); }
  }

  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  class ThemeColor { constructor(id) { this.id = id; } }
  class MarkdownString {
    constructor(value = "", supportThemeIcons = false) {
      this.value = value;
      this.supportThemeIcons = supportThemeIcons;
      this.isTrusted = false;
    }
    appendText(v) { this.value += String(v || ""); return this; }
    appendMarkdown(v) { this.value += String(v || ""); return this; }
    appendCodeblock(v, lang = "") { this.value += `\n\`\`\`${lang}\n${v}\n\`\`\`\n`; return this; }
  }

  class TabInputText { constructor(uri) { this.uri = uri; } }
  class TabInputTextDiff { constructor(original, modified) { this.original = original; this.modified = modified; } }
  class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }

  // ---------------------------------------------------------------------------
  // Enums
  // ---------------------------------------------------------------------------
  const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4 };
  const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
  const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
  const UIKind = { Desktop: 1, Web: 2 };
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 };
  const EndOfLine = { LF: 1, CRLF: 2 };
  const StatusBarAlignment = { Left: 1, Right: 2 };
  const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
  const TextEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 };
  const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
  const SymbolKind = {
    File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
    Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
    Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
    Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
    Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
  };

  // ---------------------------------------------------------------------------
  // Persistent JSON State (Memento, SecretStorage, Configuration)
  // ---------------------------------------------------------------------------
  function createJsonMemento(filePath, defaults = {}) {
    let data = { ...defaults };
    try {
      if (fs.existsSync(filePath)) {
        data = { ...defaults, ...JSON.parse(fs.readFileSync(filePath, "utf8")) };
      }
    } catch (_) {}
    let saveTimer = null;
    const flushSaveAsync = async () => {
      try {
        const tmp = filePath + ".tmp";
        await fsp.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
        await fsp.rename(tmp, filePath);
      } catch (_) {}
    };
    const scheduleSave = () => {
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        flushSaveAsync();
      }, 180);
      if (typeof saveTimer.unref === "function") saveTimer.unref();
    };
    return {
      keys: () => Object.keys(data),
      get: (key, defaultValue) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : defaultValue),
      update: async (key, value) => {
        if (value === undefined) delete data[key];
        else data[key] = value;
        scheduleSave();
      },
      setKeysForSync: () => {},
    };
  }

  function createSecretStorage(filePath) {
    const onDidChangeEmitter = new EventEmitter();
    let secrets = {};
    try {
      if (fs.existsSync(filePath)) {
        secrets = JSON.parse(fs.readFileSync(filePath, "utf8"));
      }
    } catch (_) {}
    const save = () => {
      try {
        const tmp = filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, filePath);
      } catch (_) {}
    };
    return {
      onDidChange: onDidChangeEmitter.event,
      get: async (key) => (Object.prototype.hasOwnProperty.call(secrets, key) ? secrets[key] : undefined),
      store: async (key, value) => {
        secrets[key] = String(value);
        save();
        onDidChangeEmitter.fire({ key });
      },
      delete: async (key) => {
        delete secrets[key];
        save();
        onDidChangeEmitter.fire({ key });
      },
      keys: async () => Object.keys(secrets),
    };
  }

  const configStorePath = path.join(storageDir, "host-config.json");
  let configData = {
    "chatgpt.cliExecutable": codexBinaryPath,
    "chatgpt.runCodexInWindowsSubsystemForLinux": false,
    "chatgpt.useExperimentalLspMcpServer": false,
    "chatgpt.openOnStartup": false,
    "editor.fontSize": 13,
    "editor.fontFamily": "JetBrains Mono, ui-monospace, monospace",
    "editor.fontWeight": "normal",
    "chat.fontSize": 14,
    "chat.editor.fontSize": 13,
    "files.autoSave": "afterDelay",
    "http.proxy": "",
    "http.proxyStrictSSL": true,
    "workbench.colorTheme": "Codex Dark",
  };
  try {
    if (fs.existsSync(configStorePath)) {
      configData = { ...configData, ...JSON.parse(fs.readFileSync(configStorePath, "utf8")) };
    }
  } catch (_) {}
  if (codexBinaryPath) {
    configData["chatgpt.cliExecutable"] = codexBinaryPath;
  }

  const configChangeEmitter = new EventEmitter();

  function saveConfigData() {
    try {
      fs.writeFileSync(configStorePath, JSON.stringify(configData, null, 2), { mode: 0o600 });
    } catch (_) {}
  }

  function updateHostSetting(fullKey, value) {
    if (value === undefined) delete configData[fullKey];
    else configData[fullKey] = value;
    saveConfigData();
    configChangeEmitter.fire({
      affectsConfiguration: (section) =>
        fullKey === section || fullKey.startsWith(section + ".") || section.startsWith(fullKey + "."),
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace & FileSystem
  // ---------------------------------------------------------------------------
  let currentWorkspaceDir = hostOpts.initialWorkspace || process.cwd();
  const workspaceFoldersEmitter = new EventEmitter();
  const fsProviders = new Map();
  const contentProviders = new Map();
  const openDocuments = new Map();
  const docOpenEmitter = new EventEmitter();
  const docChangeEmitter = new EventEmitter();
  const docCloseEmitter = new EventEmitter();
  const docSaveEmitter = new EventEmitter();

  function makeWorkspaceFolders() {
    if (!currentWorkspaceDir) return [];
    return [{
      uri: Uri.file(currentWorkspaceDir),
      name: path.basename(currentWorkspaceDir) || "Workspace",
      index: 0,
    }];
  }

  function setWorkspaceDirectory(newDir) {
    const resolved = path.resolve(newDir);
    fs.mkdirSync(resolved, { recursive: true });
    if (resolved === currentWorkspaceDir) {
      return resolved;
    }
    const oldFolders = makeWorkspaceFolders();
    currentWorkspaceDir = resolved;
    const newFolders = makeWorkspaceFolders();
    workspaceFoldersEmitter.fire({ added: newFolders, removed: oldFolders });
    return resolved;
  }

  function guessLanguageId(p) {
    const ext = path.extname(p || "").toLowerCase();
    const map = {
      ".js": "javascript", ".cjs": "javascript", ".mjs": "javascript",
      ".ts": "typescript", ".tsx": "typescriptreact", ".jsx": "javascriptreact",
      ".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".kt": "kotlin",
      ".json": "json", ".toml": "toml", ".md": "markdown", ".sh": "shellscript",
      ".css": "css", ".html": "html", ".xml": "xml", ".yml": "yaml", ".yaml": "yaml",
      ".c": "c", ".cpp": "cpp",
    };
    return map[ext] || "plaintext";
  }

  function createTextDocument(uri, text) {
    let content = String(text ?? "");
    const lines = () => content.split(/\r?\n/);
    const offsetAt = (pos) => {
      const ls = lines();
      const l = Math.min(Math.max(0, pos.line), Math.max(0, ls.length - 1));
      let off = 0;
      for (let i = 0; i < l; i++) off += ls[i].length + 1;
      return off + Math.min(Math.max(0, pos.character), (ls[l] || "").length);
    };
    const positionAt = (offset) => {
      const clamped = Math.max(0, Math.min(content.length, offset));
      const slice = content.slice(0, clamped).split("\n");
      return new Position(slice.length - 1, slice[slice.length - 1].length);
    };
    const doc = {
      uri,
      fileName: uri.fsPath,
      isUntitled: false,
      languageId: guessLanguageId(uri.path),
      version: 1,
      isDirty: false,
      isClosed: false,
      eol: EndOfLine.LF,
      get lineCount() { return lines().length; },
      lineAt(lineOrPos) {
        const idx = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line;
        const ls = lines();
        const t = ls[idx] ?? "";
        return {
          lineNumber: idx,
          text: t,
          range: new Range(idx, 0, idx, t.length),
          rangeIncludingLineBreak: new Range(idx, 0, idx + 1, 0),
          firstNonWhitespaceCharacterIndex: Math.max(0, t.search(/\S/)),
          isEmptyOrWhitespace: t.trim().length === 0,
        };
      },
      offsetAt,
      positionAt,
      getText(range) {
        if (!range) return content;
        return content.slice(offsetAt(range.start), offsetAt(range.end));
      },
      validateRange: (r) => r,
      validatePosition: (p) => p,
      save: async () => {
        if (uri.scheme === "file" && uri.fsPath) {
          await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fsp.writeFile(uri.fsPath, content, "utf8");
          docSaveEmitter.fire(doc);
          return true;
        }
        return false;
      },
      _updateText(nextText) {
        content = String(nextText ?? "");
        doc.version += 1;
      },
    };
    return doc;
  }

  async function readUriContent(uri) {
    if (!uri) return "";
    const u = typeof uri === "string" ? Uri.parse(uri) : uri;
    if (fsProviders.has(u.scheme)) {
      const prov = fsProviders.get(u.scheme);
      const data = await Promise.resolve(prov.readFile ? prov.readFile(u) : null);
      if (data) return Buffer.from(data).toString("utf8");
    }
    if (contentProviders.has(u.scheme)) {
      const prov = contentProviders.get(u.scheme);
      const txt = await Promise.resolve(prov.provideTextDocumentContent(u, new CancellationTokenSource().token));
      return String(txt ?? "");
    }
    if (u.scheme === "file" && u.fsPath) {
      return await fsp.readFile(u.fsPath, "utf8");
    }
    return "";
  }

  const normExtWebviewPrefix = path.resolve(extensionPath, "webview") + path.sep;

  const workspaceFs = {
    stat: async (uri) => {
      if (fsProviders.has(uri.scheme)) {
        return await Promise.resolve(fsProviders.get(uri.scheme).stat(uri));
      }
      try {
        const st = await fsp.stat(uri.fsPath);
        return {
          type: st.isDirectory() ? FileType.Directory : (st.isSymbolicLink() ? FileType.SymbolicLink : FileType.File),
          ctime: st.ctimeMs,
          mtime: st.mtimeMs,
          size: st.size,
        };
      } catch (_) {
        const normP = path.resolve(uri.fsPath || "");
        if (normP.startsWith(normExtWebviewPrefix)) {
          const rel = normP.slice(normExtWebviewPrefix.length).replace(/\\/g, "/");
          const buf = readPakBuffer(rel, true);
          if (buf) {
            return { type: FileType.File, ctime: 0, mtime: 0, size: buf.length };
          }
        }
        throw FileSystemError.FileNotFound(uri);
      }
    },
    readFile: async (uri) => {
      if (fsProviders.has(uri.scheme)) {
        const p = fsProviders.get(uri.scheme);
        if (typeof p.readFile === "function") return await Promise.resolve(p.readFile(uri));
      }
      try {
        return new Uint8Array(await fsp.readFile(uri.fsPath));
      } catch (_) {
        const normP = path.resolve(uri.fsPath || "");
        if (normP.startsWith(normExtWebviewPrefix)) {
          const rel = normP.slice(normExtWebviewPrefix.length).replace(/\\/g, "/");
          const buf = readPakBuffer(rel, true);
          if (buf) return new Uint8Array(buf);
        }
        throw FileSystemError.FileNotFound(uri);
      }
    },
    writeFile: async (uri, content) => {
      await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fsp.writeFile(uri.fsPath, Buffer.from(content));
    },
    delete: async (uri, opts) => {
      await fsp.rm(uri.fsPath, { recursive: !!(opts && opts.recursive), force: true });
    },
    rename: async (oldUri, newUri) => {
      await fsp.mkdir(path.dirname(newUri.fsPath), { recursive: true });
      await fsp.rename(oldUri.fsPath, newUri.fsPath);
    },
    copy: async (src, dst, opts) => {
      await fsp.mkdir(path.dirname(dst.fsPath), { recursive: true });
      await fsp.cp(src.fsPath, dst.fsPath, { recursive: true, force: !!(opts && opts.overwrite) });
    },
    createDirectory: async (uri) => {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    readDirectory: async (uri) => {
      const entries = await fsp.readdir(uri.fsPath, { withFileTypes: true });
      return entries.map((e) => [
        e.name,
        e.isDirectory() ? FileType.Directory : (e.isSymbolicLink() ? FileType.SymbolicLink : FileType.File),
      ]);
    },
    isWritableFileSystem: () => true,
  };

  async function walkWorkspaceFiles(maxResults = 1500) {
    const out = [];
    const root = currentWorkspaceDir;
    if (!root || !fs.existsSync(root)) return out;
    const skip = new Set([".git", "node_modules", "build-out", ".gradle", "target", "__pycache__", ".next", "dist"]);
    async function walk(dir, depth) {
      if (depth > 8 || out.length >= maxResults) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const ent of entries) {
        if (out.length >= maxResults) break;
        if (skip.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) await walk(full, depth + 1);
        else if (ent.isFile()) out.push(Uri.file(full));
      }
    }
    await walk(root, 0);
    return out;
  }

  const workspace = {
    get name() { return path.basename(currentWorkspaceDir) || "Workspace"; },
    get workspaceFolders() { return makeWorkspaceFolders(); },
    get rootPath() { return currentWorkspaceDir; },
    workspaceFile: undefined,
    isTrusted: true,
    onDidGrantWorkspaceTrust: new EventEmitter().event,
    onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
    onDidChangeConfiguration: configChangeEmitter.event,
    onDidOpenTextDocument: docOpenEmitter.event,
    onDidChangeTextDocument: docChangeEmitter.event,
    onDidCloseTextDocument: docCloseEmitter.event,
    onDidSaveTextDocument: docSaveEmitter.event,
    get textDocuments() { return Array.from(openDocuments.values()); },
    notebookDocuments: [],
    fs: workspaceFs,
    getWorkspaceFolder(uri) {
      const folders = makeWorkspaceFolders();
      if (!folders.length || !uri) return undefined;
      return folders[0];
    },
    asRelativePath(pathOrUri) {
      const p = typeof pathOrUri === "string" ? pathOrUri : (pathOrUri.fsPath || pathOrUri.path || "");
      if (currentWorkspaceDir && p.startsWith(currentWorkspaceDir + "/")) {
        return p.slice(currentWorkspaceDir.length + 1);
      }
      return p;
    },
    getConfiguration(section) {
      const prefix = section ? section + "." : "";
      return {
        get(key, defaultValue) {
          const full = prefix + key;
          if (Object.prototype.hasOwnProperty.call(configData, full)) {
            return configData[full];
          }
          return defaultValue;
        },
        has(key) {
          return Object.prototype.hasOwnProperty.call(configData, prefix + key);
        },
        inspect(key) {
          const full = prefix + key;
          const val = configData[full];
          return { key: full, globalValue: val, workspaceValue: undefined, defaultValue: undefined };
        },
        update: async (key, value) => {
          updateHostSetting(prefix + key, value);
        },
      };
    },
    registerFileSystemProvider(scheme, provider) {
      fsProviders.set(scheme, provider);
      return new Disposable(() => fsProviders.delete(scheme));
    },
    registerTextDocumentContentProvider(scheme, provider) {
      contentProviders.set(scheme, provider);
      return new Disposable(() => contentProviders.delete(scheme));
    },
    async openTextDocument(uriOrFileName) {
      const uri = typeof uriOrFileName === "string"
        ? Uri.file(uriOrFileName)
        : (uriOrFileName instanceof Uri ? uriOrFileName : Uri.file(String(uriOrFileName?.path || "")));
      const key = uri.toString();
      const txt = await readUriContent(uri).catch(() => "");
      if (openDocuments.has(key)) {
        const existing = openDocuments.get(key);
        existing._updateText(txt);
        return existing;
      }
      const doc = createTextDocument(uri, txt);
      openDocuments.set(key, doc);
      docOpenEmitter.fire(doc);
      return doc;
    },
    async findFiles(includePattern, _excludePattern, maxResults) {
      const all = await walkWorkspaceFiles(maxResults || 1500);
      if (!includePattern || typeof includePattern !== "string" || includePattern === "**/*") {
        return all;
      }
      const needle = includePattern.replace(/^\*\*\/?/, "").replace(/\*/g, "").toLowerCase();
      if (!needle) return all;
      return all.filter((u) => u.fsPath.toLowerCase().includes(needle));
    },
    async applyEdit(edit) {
      if (!edit || !Array.isArray(edit._ops)) return true;
      for (const [uri, edits] of edit.entries()) {
        try {
          const doc = await workspace.openTextDocument(uri);
          let text = doc.getText();
          const sorted = edits.slice().sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
          for (const te of sorted) {
            const s = doc.offsetAt(te.range.start);
            const e = doc.offsetAt(te.range.end);
            text = text.slice(0, s) + (te.newText || "") + text.slice(e);
          }
          doc._updateText(text);
          if (uri.scheme === "file" && uri.fsPath) {
            await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
            await fsp.writeFile(uri.fsPath, text, "utf8");
          }
        } catch (_) {}
      }
      return true;
    },
    createFileSystemWatcher(globPattern) {
      const createEmitter = new EventEmitter();
      const changeEmitter = new EventEmitter();
      const deleteEmitter = new EventEmitter();
      let watcher = null;
      try {
        const watchDir = (globPattern && typeof globPattern === "object" && globPattern.base)
          ? globPattern.base
          : null;
        if (watchDir && fs.existsSync(watchDir)) {
          const targetName = String(globPattern.pattern || "").replace(/^\*\*\//, "");
          watcher = fs.watch(watchDir, { persistent: false }, (eventType, filename) => {
            if (!filename) return;
            if (targetName && targetName !== "*" && !targetName.includes("*") && filename !== targetName) {
              return;
            }
            const full = Uri.file(path.join(watchDir, filename));
            if (eventType === "rename") {
              if (fs.existsSync(full.fsPath)) createEmitter.fire(full);
              else deleteEmitter.fire(full);
            } else {
              changeEmitter.fire(full);
            }
          });
        }
      } catch (_) {}
      return {
        onDidCreate: createEmitter.event,
        onDidChange: changeEmitter.event,
        onDidDelete: deleteEmitter.event,
        dispose: () => {
          try { if (watcher) watcher.close(); } catch (_) {}
          createEmitter.dispose();
          changeEmitter.dispose();
          deleteEmitter.dispose();
        },
      };
    },
  };

  // ---------------------------------------------------------------------------
  // Commands, Views, Custom Editors & Webview Panels
  // ---------------------------------------------------------------------------
  const commandsMap = new Map();
  const contextKeys = new Map();
  let panelSeq = 0;
  const panels = new Map();
  let activePanelId = null;
  const webviewViewProviders = new Map();
  const customEditorProviders = new Map();
  const uriHandlers = new Set();
  const tabChangeEmitter = new EventEmitter();
  const tabGroupChangeEmitter = new EventEmitter();
  const previewTabs = [];

  function closePreviewTabById(tabId) {
    const idx = previewTabs.findIndex((t) => t._id === tabId);
    if (idx !== -1) {
      const removed = previewTabs.splice(idx, 1)[0];
      tabChangeEmitter.fire({ opened: [], closed: [removed], changed: [] });
      return true;
    }
    return false;
  }

  commandsMap.set("setContext", (key, val) => {
    contextKeys.set(key, val);
    return undefined;
  });
  commandsMap.set("_codex.microphone.available", async () => 0);
  commandsMap.set("chatgpt.sidebarView.focus", async () => undefined);
  commandsMap.set("workbench.action.openSettings", async () => {
    onOpenPreview({ kind: "host_modal", tab: "settings" });
    return undefined;
  });
  commandsMap.set("workbench.action.openGlobalKeybindings", async () => undefined);
  commandsMap.set("workbench.action.showCommands", async () => {
    onOpenPreview({ kind: "host_modal", tab: "settings" });
    return undefined;
  });
  commandsMap.set("workbench.action.reloadWindow", async () => {
    onOpenPreview({ kind: "reload" });
    return undefined;
  });

  commandsMap.set("vscode.open", async (targetUri) => {
    if (!targetUri) return undefined;
    const u = typeof targetUri === "string" ? Uri.parse(targetUri) : targetUri;
    if (u.scheme === "http" || u.scheme === "https") {
      await env.openExternal(u);
      return undefined;
    }
    if (u.scheme === "file" && u.fsPath) {
      await windowObj.showTextDocument(u);
      return undefined;
    }
    if (customEditorProviders.has("chatgpt.conversationEditor")) {
      return await commandsMap.get("vscode.openWith")(u, "chatgpt.conversationEditor");
    }
    return undefined;
  });

  commandsMap.set("vscode.openWith", async (targetUri, viewType, showOptions) => {
    const prov = customEditorProviders.get(viewType);
    if (!prov) {
      return await commandsMap.get("vscode.open")(targetUri);
    }
    const u = typeof targetUri === "string" ? Uri.parse(targetUri) : targetUri;
    const cts = new CancellationTokenSource();
    const customDoc = prov.openCustomDocument
      ? await Promise.resolve(prov.openCustomDocument(u, {}, cts.token))
      : { uri: u, dispose: () => {} };
    const panel = windowObj.createWebviewPanel(viewType, "Codex", showOptions || ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    await Promise.resolve(prov.resolveCustomEditor(customDoc, panel, cts.token));
    onOpenPreview({ kind: "subpanel", panelId: panel.id, title: panel.title || "Codex" });
    return undefined;
  });

  commandsMap.set("vscode.diff", async (leftUri, rightUri, title) => {
    const leftText = await readUriContent(leftUri).catch(() => "");
    const rightText = await readUriContent(rightUri).catch(() => "");
    onOpenPreview({
      kind: "diff",
      title: title || path.basename(rightUri?.path || "Diff"),
      filePath: rightUri?.fsPath || rightUri?.path || "",
      leftText,
      rightText,
    });
    return undefined;
  });

  const commands = {
    registerCommand(id, handler, thisArg) {
      commandsMap.set(id, thisArg ? handler.bind(thisArg) : handler);
      return new Disposable(() => commandsMap.delete(id));
    },
    registerTextEditorCommand(id, handler, thisArg) {
      commandsMap.set(id, thisArg ? handler.bind(thisArg) : handler);
      return new Disposable(() => commandsMap.delete(id));
    },
    async executeCommand(id, ...args) {
      const fn = commandsMap.get(id);
      if (fn) return await fn(...args);
      return undefined;
    },
    async getCommands() {
      return Array.from(commandsMap.keys());
    },
  };

  function createWebviewObject(panelId) {
    const msgEmitter = new EventEmitter();
    let htmlValue = "";
    let optionsValue = {};
    const cspOrigin = `http://127.0.0.1:${port} http://localhost:${port} ws://127.0.0.1:${port} ws://localhost:${port} data: blob:`;
    return {
      get options() { return optionsValue; },
      set options(v) { optionsValue = v || {}; },
      get html() { return htmlValue; },
      set html(v) { htmlValue = String(v || ""); },
      cspSource: cspOrigin,
      onDidReceiveMessage: msgEmitter.event,
      asWebviewUri(localResource) {
        const fsP = localResource?.fsPath || localResource?.path || "";
        const normExt = path.resolve(extensionPath);
        const normRes = path.resolve(fsP);
        if (normRes === normExt || normRes.startsWith(normExt + path.sep)) {
          const rel = normRes.slice(normExt.length + 1).split(path.sep).map(encodeURIComponent).join("/");
          return Uri.parse(`http://127.0.0.1:${port}/ext/${rel}`);
        }
        return Uri.parse(`http://127.0.0.1:${port}/api/fs/raw?path=${encodeURIComponent(normRes)}`);
      },
      async postMessage(message) {
        onPanelMessage(panelId, message);
        return true;
      },
      _receiveFromClient(message) {
        msgEmitter.fire(message);
      },
      _dispose() {
        msgEmitter.dispose();
      },
    };
  }

  function buildTabGroupSnapshot() {
    const panelTabs = Array.from(panels.values()).map((p) => ({
      _id: p.id,
      _panel: p,
      label: p.title || "Codex",
      isActive: p.id === activePanelId,
      isDirty: false,
      isPinned: false,
      isPreview: false,
      input: new TabInputWebview(p.viewType),
    }));
    const allTabs = [...panelTabs, ...previewTabs];
    const group = {
      isActive: true,
      viewColumn: ViewColumn.One,
      activeTab: allTabs.find((t) => t.isActive) || allTabs[0],
      tabs: allTabs,
    };
    for (const t of allTabs) t.group = group;
    return group;
  }

  const tabGroups = {
    get all() { return [buildTabGroupSnapshot()]; },
    get activeTabGroup() { return buildTabGroupSnapshot(); },
    onDidChangeTabs: tabChangeEmitter.event,
    onDidChangeTabGroups: tabGroupChangeEmitter.event,
    async close(tabOrTabs) {
      const list = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs];
      for (const t of list) {
        if (!t) continue;
        if (t._panel) t._panel.dispose();
        else if (t._id) closePreviewTabById(t._id);
      }
      return true;
    },
  };

  const activeEditorEmitter = new EventEmitter();
  const visibleEditorsEmitter = new EventEmitter();
  const selectionChangeEmitter = new EventEmitter();
  const termShellIntegrationEmitter = new EventEmitter();
  const windowStateEmitter = new EventEmitter();
  const terminals = [];

  const windowObj = {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    terminals,
    activeTerminal: undefined,
    state: { focused: true, active: true, onDidChange: windowStateEmitter.event },
    onDidChangeWindowState: windowStateEmitter.event,
    tabGroups,
    onDidChangeActiveTextEditor: activeEditorEmitter.event,
    onDidChangeVisibleTextEditors: visibleEditorsEmitter.event,
    onDidChangeTextEditorSelection: selectionChangeEmitter.event,
    onDidChangeTerminalShellIntegration: termShellIntegrationEmitter.event,

    createOutputChannel(name) {
      return {
        name,
        append: (v) => log(`[ext:${name}]`, String(v).trimEnd()),
        appendLine: (v) => log(`[ext:${name}]`, v),
        replace: () => {},
        clear: () => {},
        show: () => {},
        hide: () => {},
        log: (lvl, ...a) => log(`[ext:${name}:${lvl}]`, ...a),
        info: (...a) => log(`[ext:${name}:INFO]`, ...a),
        warn: (...a) => log(`[ext:${name}:WARN]`, ...a),
        warning: (...a) => log(`[ext:${name}:WARN]`, ...a),
        error: (...a) => log(`[ext:${name}:ERROR]`, ...a),
        debug: () => {},
        trace: () => {},
        logLevel: 2,
        onDidChangeLogLevel: new EventEmitter().event,
        dispose: () => {},
      };
    },

    createTextEditorDecorationType() {
      return { key: "dec-" + Math.random().toString(36).slice(2, 7), dispose: () => {} };
    },

    registerWebviewViewProvider(viewId, provider) {
      webviewViewProviders.set(viewId, provider);
      return new Disposable(() => webviewViewProviders.delete(viewId));
    },

    registerCustomEditorProvider(viewType, provider) {
      customEditorProviders.set(viewType, provider);
      return new Disposable(() => customEditorProviders.delete(viewType));
    },

    registerUriHandler(handler) {
      uriHandlers.add(handler);
      return new Disposable(() => uriHandlers.delete(handler));
    },

    createWebviewPanel(viewType, title, showOptions, options) {
      const id = "panel-" + (++panelSeq);
      const disposeEmitter = new EventEmitter();
      const viewStateEmitter = new EventEmitter();
      const webview = createWebviewObject(id);
      if (options) webview.options = options;

      let currentTitle = title || "Codex";
      let disposed = false;
      const col = typeof showOptions === "number" ? showOptions : (showOptions?.viewColumn || ViewColumn.One);

      const panel = {
        id,
        viewType,
        isSubPanel: true,
        get title() { return currentTitle; },
        set title(v) { currentTitle = String(v || "Codex"); },
        iconPath: undefined,
        webview,
        options: options || {},
        viewColumn: col,
        get active() { return activePanelId === id; },
        get visible() { return !disposed; },
        onDidDispose: disposeEmitter.event,
        onDidChangeViewState: viewStateEmitter.event,
        reveal() {
          if (disposed) return;
          activePanelId = id;
          viewStateEmitter.fire({ webviewPanel: panel });
          onOpenPreview({ kind: "subpanel", panelId: id, title: currentTitle });
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          panels.delete(id);
          if (activePanelId === id) {
            activePanelId = panels.has("sidebar") ? "sidebar" : null;
          }
          webview._dispose();
          disposeEmitter.fire(undefined);
          disposeEmitter.dispose();
          viewStateEmitter.dispose();
          onPanelDisposed(id);
        },
      };

      panels.set(id, panel);
      onPanelCreated(panel);
      return panel;
    },

    async showOpenDialog(options = {}) {
      if (typeof hostOpts.onShowOpenDialog === "function") {
        const pickedPaths = await Promise.resolve(hostOpts.onShowOpenDialog(options));
        if (Array.isArray(pickedPaths) && pickedPaths.length > 0) {
          return pickedPaths.map((p) => Uri.file(p));
        }
        return undefined;
      }
      if (options.canSelectFolders && !options.canSelectFiles) {
        return [Uri.file(currentWorkspaceDir)];
      }
      return undefined;
    },

    async showSaveDialog(options = {}) {
      if (options.defaultUri) return options.defaultUri;
      return undefined;
    },

    async showTextDocument(docOrUri) {
      const doc = docOrUri && docOrUri.getText ? docOrUri : await workspace.openTextDocument(docOrUri);
      onOpenPreview({
        kind: "file",
        title: path.basename(doc.uri.path || "File"),
        filePath: doc.uri.fsPath || doc.uri.path || "",
        content: doc.getText(),
        languageId: doc.languageId,
      });
      return {
        document: doc,
        selection: new Selection(0, 0, 0, 0),
        selections: [new Selection(0, 0, 0, 0)],
        visibleRanges: [new Range(0, 0, Math.max(0, doc.lineCount - 1), 0)],
        options: {},
        viewColumn: ViewColumn.One,
        edit: async () => true,
        setDecorations: () => {},
        revealRange: () => {},
        show: () => {},
        hide: () => {},
      };
    },

    async showInformationMessage(message) {
      onShowMessage("info", message);
      return undefined;
    },
    async showWarningMessage(message) {
      onShowMessage("warn", message);
      return undefined;
    },
    async showErrorMessage(message) {
      onShowMessage("error", message);
      return undefined;
    },

    createTerminal(opts = {}) {
      const term = {
        name: opts.name || "Codex Terminal",
        processId: Promise.resolve(process.pid),
        creationOptions: opts,
        exitStatus: undefined,
        state: { isInteractedWith: true },
        shellIntegration: undefined,
        sendText(text) {
          onOpenPreview({
            kind: "terminal",
            title: term.name,
            command: text,
            cwd: opts.cwd || currentWorkspaceDir,
          });
        },
        show() {
          onOpenPreview({
            kind: "terminal",
            title: term.name,
            command: "",
            cwd: opts.cwd || currentWorkspaceDir,
          });
        },
        hide() {},
        dispose() {
          const i = terminals.indexOf(term);
          if (i !== -1) terminals.splice(i, 1);
        },
      };
      if (terminals.length >= 20) terminals.shift();
      terminals.push(term);
      windowObj.activeTerminal = term;
      return term;
    },
  };

  // ---------------------------------------------------------------------------
  // Resolve Primary Full-Screen Codex Extension View ("chatgpt.sidebarView")
  // ---------------------------------------------------------------------------
  async function resolvePrimarySidebarView(viewId = "chatgpt.sidebarView") {
    if (panels.has("sidebar")) return panels.get("sidebar");
    const prov = webviewViewProviders.get(viewId);
    if (!prov || typeof prov.resolveWebviewView !== "function") return null;

    const id = "sidebar";
    const disposeEmitter = new EventEmitter();
    const visEmitter = new EventEmitter();
    const webview = createWebviewObject(id);
    let currentTitle = "Codex";
    let disposed = false;

    const webviewView = {
      id,
      viewType: viewId,
      isSubPanel: false,
      webview,
      get title() { return currentTitle; },
      set title(v) { currentTitle = String(v || "Codex"); },
      description: undefined,
      badge: undefined,
      get visible() { return !disposed; },
      get active() { return activePanelId === id; },
      onDidDispose: disposeEmitter.event,
      onDidChangeVisibility: visEmitter.event,
      show() {
        activePanelId = id;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        panels.delete(id);
        webview._dispose();
        disposeEmitter.fire(undefined);
        disposeEmitter.dispose();
        visEmitter.dispose();
        onPanelDisposed(id);
      },
    };

    panels.set(id, webviewView);
    activePanelId = id;
    const cts = new CancellationTokenSource();
    await Promise.resolve(prov.resolveWebviewView(webviewView, { state: undefined }, cts.token));
    onPanelCreated(webviewView);
    return webviewView;
  }

  // ---------------------------------------------------------------------------
  // env, l10n, lm, chat, languages, extensions
  // ---------------------------------------------------------------------------
  let clipboardText = "";
  const machineIdPath = path.join(storageDir, "machine-id");
  let machineId = "";
  try {
    if (fs.existsSync(machineIdPath)) machineId = fs.readFileSync(machineIdPath, "utf8").trim();
  } catch (_) {}
  if (!machineId) {
    machineId = crypto.randomBytes(32).toString("hex");
    try { fs.writeFileSync(machineIdPath, machineId, { mode: 0o600 }); } catch (_) {}
  }

  const env = {
    appName: "Visual Studio Code",
    appRoot: extensionPath,
    language: process.env.CE_UI_LOCALE || "es",
    clipboard: {
      readText: async () => clipboardText,
      writeText: async (v) => { clipboardText = String(v || ""); },
    },
    machineId,
    sessionId: crypto.randomUUID(),
    isNewAppInstall: false,
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: new EventEmitter().event,
    remoteName: undefined,
    shell: process.env.SHELL || "/system/bin/sh",
    uiKind: UIKind.Desktop,
    uriScheme: process.env.CE_OAUTH_SCHEME || "codex",
    async openExternal(target) {
      const urlStr = typeof target === "string" ? target : target.toString(true);
      const handledByUi = Boolean(onOpenExternal(urlStr));
      if (!handledByUi) {
        const xdg = process.env.BROWSER || "xdg-open";
        try {
          const child = spawn(xdg, [urlStr], { stdio: "ignore", detached: true });
          child.on("error", () => {});
          child.unref();
        } catch (_) {}
      }
      return true;
    },
    asExternalUri: async (u) => u,
  };

  const l10n = {
    t(messageOrOptions, ...args) {
      if (messageOrOptions && typeof messageOrOptions === "object") {
        return formatL10n(String(messageOrOptions.message || ""), messageOrOptions.args);
      }
      if (args.length === 1 && args[0] && typeof args[0] === "object") {
        return formatL10n(String(messageOrOptions || ""), args[0]);
      }
      return formatL10n(String(messageOrOptions || ""), args);
    },
    bundle: undefined,
    uri: undefined,
  };

  function formatL10n(template, args) {
    if (!args) return template;
    if (Array.isArray(args)) {
      return template.replace(/\{(\d+)\}/g, (m, i) => (args[Number(i)] !== undefined ? String(args[Number(i)]) : m));
    }
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (args[k] !== undefined ? String(args[k]) : m));
  }

  const lm = {
    isModelProxyAvailable: () => false,
    getModelProxy: async () => null,
    onDidChangeModelProxyAvailability: new EventEmitter().event,
    selectChatModels: async () => [],
  };

  const chat = {
    registerChatSessionItemProvider: () => new Disposable(() => {}),
    createChatParticipant: () => ({ iconPath: undefined, dispose: () => {} }),
  };

  const languages = {
    onDidChangeDiagnostics: new EventEmitter().event,
    getDiagnostics: () => [],
    registerCodeLensProvider: () => new Disposable(() => {}),
  };

  const selfExtensionObj = {
    id: "openai.chatgpt",
    extensionUri: Uri.file(extensionPath),
    extensionPath,
    isActive: true,
    exports: undefined,
    packageJSON,
    activate: async () => undefined,
  };

  const extensions = {
    get all() { return [selfExtensionObj]; },
    onDidChange: new EventEmitter().event,
    getExtension(id) {
      if (id === "openai.chatgpt") return selfExtensionObj;
      return undefined;
    },
  };

  // ---------------------------------------------------------------------------
  // ExtensionContext Factory
  // ---------------------------------------------------------------------------
  const globalStorageDir = path.join(storageDir, "global-storage");
  const workspaceStorageDir = path.join(storageDir, "workspace-storage");
  const logDir = path.join(storageDir, "logs");
  fs.mkdirSync(globalStorageDir, { recursive: true });
  fs.mkdirSync(workspaceStorageDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const globalState = createJsonMemento(path.join(storageDir, "global-state.json"), {});
  const workspaceState = createJsonMemento(path.join(storageDir, "workspace-state.json"), {});
  const secrets = createSecretStorage(path.join(storageDir, "secrets.json"));

  function createExtensionContext() {
    const extUri = Uri.file(extensionPath);
    return {
      subscriptions: [],
      workspaceState,
      globalState,
      secrets,
      extensionUri: extUri,
      extensionPath,
      environmentVariableCollection: {
        persistent: true,
        description: undefined,
        replace: () => {},
        append: () => {},
        prepend: () => {},
        get: () => undefined,
        forEach: () => {},
        delete: () => {},
        clear: () => {},
        getScoped: () => ({}),
      },
      asAbsolutePath: (rel) => path.join(extensionPath, rel),
      storageUri: Uri.file(workspaceStorageDir),
      storagePath: workspaceStorageDir,
      globalStorageUri: Uri.file(globalStorageDir),
      globalStoragePath: globalStorageDir,
      logUri: Uri.file(logDir),
      logPath: logDir,
      extensionMode: ExtensionMode.Production,
      extension: selfExtensionObj,
      languageModelAccessInformation: {
        onDidChange: new EventEmitter().event,
        canSendRequest: () => undefined,
      },
    };
  }

  const rawVscode = {
    version: "1.99.0",
    Disposable,
    EventEmitter,
    CancellationError,
    CancellationTokenSource,
    Uri,
    Position,
    Range,
    Selection,
    Location,
    CodeLens,
    RelativePattern,
    TextEdit,
    WorkspaceEdit,
    FileSystemError,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    TabInputWebview,
    ViewColumn,
    ExtensionMode,
    ConfigurationTarget,
    UIKind,
    FileType,
    FileChangeType,
    EndOfLine,
    StatusBarAlignment,
    ProgressLocation,
    TextEditorRevealType,
    DiagnosticSeverity,
    SymbolKind,
    workspace,
    window: windowObj,
    commands,
    env,
    l10n,
    lm,
    chat,
    languages,
    extensions,
  };

  const vscodeApi = new Proxy(rawVscode, {
    get(target, prop) {
      return prop in target ? target[prop] : undefined;
    },
  });

  return {
    vscodeApi,
    createExtensionContext,
    resolvePrimarySidebarView,
    getPanels: () => panels,
    getWorkspaceDirectory: () => currentWorkspaceDir,
    setWorkspaceDirectory,
    getGlobalState: () => globalState,
    dispatchUri: async (uriStr) => {
      const parsed = Uri.parse(uriStr);
      for (const h of Array.from(uriHandlers)) {
        if (h && typeof h.handleUri === "function") {
          await h.handleUri(parsed);
        }
      }
    },
  };
}

module.exports = { createVSCodeShim };
