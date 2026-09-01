/* The harness every SQLite Viewer gate loads the real main.js through.
 *
 * An `obsidian` module stub, just enough of the API for main.js to load and
 * for the plugin class to be constructed. The gates measure the pure library
 * and the engines with injected fakes; no real database and no real process
 * is ever started here. `loadPlugin()` runs main.js inside a vm context with
 * `require('obsidian')` answered by the stub and every other require
 * answered by Node, which is what the plugin sees on the desktop.
 * `Platform.isDesktopApp` is a switch so the mobile path can be measured
 * too.
 *
 * One realm note, learned on the Sync gates: arrays made inside the vm have
 * the sandbox's Array prototype and fail strict deepEqual against literals.
 * `unwrap()` deep-copies a value into the test realm first.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(repo, 'main.js'), 'utf8');
const nodeRequire = createRequire(import.meta.url);

export const notices = [];

/* ------------------------------------------------------------ fake DOM -- */

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attrs = Object.create(null);
    this.classSet = new Set();
    this.handlers = Object.create(null);
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.style = {};
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addClass(c) { this.classSet.add(c); }
  get classList() {
    const s = this.classSet;
    return { add: (...c) => { for (const x of c) s.add(x); }, remove: (...c) => { for (const x of c) s.delete(x); }, contains: (c) => s.has(c) };
  }
  focus() { this.focused = true; }
  appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
  addEventListener(type, fn) { (this.handlers[type] || (this.handlers[type] = [])).push(fn); }
  empty() { this.children = []; }
  setText(t) { this.textContent = String(t); }
  createDiv(opts) { return this.appendChild(makeEl('div', opts)); }
  createSpan(opts) { return this.appendChild(makeEl('span', opts)); }
  createEl(tag, opts) { return this.appendChild(makeEl(tag, opts)); }
  * walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
}

function makeEl(tag, opts = {}) {
  const el = new FakeEl(tag);
  if (opts && typeof opts === 'object') {
    if (opts.cls) for (const c of String(opts.cls).split(/\s+/).filter(Boolean)) el.classSet.add(c);
    if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.attrs[k] = String(v);
    if (opts.text) el.textContent = String(opts.text);
    if (opts.type) el.attrs.type = String(opts.type);
    if (opts.value !== undefined) el.value = String(opts.value);
  }
  return el;
}

/* ----------------------------------------------------------- the stub -- */

export function makeObsidian({ desktop = true } = {}) {
  const chain = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : chain()), apply: () => chain() });
  class Component {
    constructor() { this.events = []; }
    registerEvent(e) { this.events.push(e); }
  }
  class ItemView extends Component {
    constructor(leaf) { super(); this.leaf = leaf; this.contentEl = makeEl('div'); this.containerEl = makeEl('div'); this.app = leaf ? leaf.app : undefined; }
  }
  class FileView extends ItemView {
    constructor(leaf) { super(leaf); this.file = null; }
  }
  class TFile { constructor(path) { this.path = path; } }
  return {
    Plugin: class extends Component {
      constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this.saved = null; }
      async loadData() { return this.saved === null ? null : JSON.parse(JSON.stringify(this.saved)); }
      async saveData(d) { this.saved = JSON.parse(JSON.stringify(d)); }
      registerView(type, factory) { (this.viewFactories || (this.viewFactories = {}))[type] = factory; }
      registerExtensions() {}
      addRibbonIcon() { return makeEl('div'); }
      addCommand(c) { (this.commands || (this.commands = [])).push(c); }
      addSettingTab() {}
    },
    PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = makeEl('div'); } },
    Setting: class { constructor() { return chain(); } },
    Modal: class { constructor(app) { this.app = app; this.contentEl = makeEl('div'); this.titleEl = makeEl('div'); this.modalEl = makeEl('div'); } open() { this.opened = true; if (this.onOpen) this.onOpen(); } close() { this.closed = true; if (this.onClose) this.onClose(); } },
    Notice: class { constructor(msg) { this.msg = msg; notices.push(String(msg)); } },
    Platform: { isDesktopApp: desktop, isMobile: !desktop, isMobileApp: !desktop, isMacOS: true, isWin: false, isLinux: false },
    setIcon: (el, icon) => { el.attrs['data-icon'] = icon; },
    normalizePath: (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''),
    ItemView, FileView, TFile,
    TFolder: class {},
  };
}

/* Load main.js. Returns the plugin class, the pure library it exposes for
 * the gates, and a `makePlugin(app)` that constructs an instance. */
export function loadPlugin({ desktop = true } = {}) {
  const obsidian = makeObsidian({ desktop });
  const body = makeEl('body');
  const doc = {
    body,
    createElement: (tag) => makeEl(tag),
    createElementNS: (ns, tag) => makeEl(tag),
  };
  const sandbox = {
    require: (name) => (name === 'obsidian' ? obsidian : nodeRequire(name)),
    module: { exports: {} },
    document: doc,
    window: { setTimeout, clearTimeout },
    navigator: { clipboard: { writeText: async () => {} } },
    Function,
    encodeURIComponent, decodeURIComponent, JSON, Date, Math, Number, String, Array, Object, Map, Set, Promise, Buffer, Error, RegExp, Uint8Array,
    console, setTimeout, clearTimeout, process, URL,
    /* What sql-wasm.js needs when the wasm gate loads it for real. */
    WebAssembly, TextDecoder, TextEncoder, performance,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'main.js' });
  const PluginClass = sandbox.module.exports;
  return {
    PluginClass,
    lib: PluginClass.lib,
    obsidian,
    makePlugin(app, saved = null) {
      const plugin = new PluginClass(app, { id: 'icor-for-life-sqlite-viewer', version: '0.0.0-gate', dir: '.obsidian/plugins/icor-for-life-sqlite-viewer' });
      plugin.saved = saved;
      return plugin;
    },
  };
}

/* Deep-copy a sandbox-realm value into the test realm so deepEqual works. */
export function unwrap(value) { return JSON.parse(JSON.stringify(value)); }

/* An in-memory vault adapter for the migration and cache gates. Paths and
 * contents live in a Map; rename moves the entry; nothing touches disk. */
export function makeFakeAdapter(initialFiles = {}, initialBinaries = {}) {
  const files = new Map(Object.entries(initialFiles));
  const binaries = new Map(Object.entries(initialBinaries));
  const folders = new Set(['']);
  const log = [];
  return {
    files, binaries, folders, log,
    async exists(p) {
      if (files.has(p) || binaries.has(p) || folders.has(p)) return true;
      /* Like a real vault: a folder exists when something lives under it. */
      const prefix = p + '/';
      for (const key of files.keys()) if (key.startsWith(prefix)) return true;
      for (const key of binaries.keys()) if (key.startsWith(prefix)) return true;
      for (const key of folders) if (key.startsWith(prefix)) return true;
      return false;
    },
    async stat(p) {
      if (binaries.has(p)) return { size: binaries.get(p).length, mtime: 1 };
      return files.has(p) ? { size: (files.get(p) || '').length, mtime: 1 } : null;
    },
    async readBinary(p) { if (!binaries.has(p)) throw new Error('not found: ' + p); return binaries.get(p); },
    async mkdir(p) { folders.add(p); log.push(['mkdir', p]); },
    async read(p) { if (!files.has(p)) throw new Error('not found: ' + p); return files.get(p); },
    async write(p, text) { files.set(p, text); log.push(['write', p]); },
    async rename(from, to) {
      if (!files.has(from)) throw new Error('not found: ' + from);
      if (files.has(to)) throw new Error('already exists: ' + to);
      files.set(to, files.get(from));
      files.delete(from);
      log.push(['rename', from, to]);
    },
    async list(p) {
      const out = { files: [], folders: [] };
      for (const key of files.keys()) if (key.startsWith(p + '/') && !key.slice(p.length + 1).includes('/')) out.files.push(key);
      return out;
    },
  };
}
