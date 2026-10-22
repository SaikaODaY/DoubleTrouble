import { hydrateRegexStoreFromServer } from './regexEngine';

type ExtensionManifest = {
  display_name?: string;
  loading_order?: number | string;
  js?: string;
  css?: string;
};

type RuntimeMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  author: string;
  content: string;
  hidden?: boolean;
  swipes?: string[];
  active_swipe_index?: number;
};

type RuntimeCharacter = {
  id: string;
  name: string;
  avatar: string;
  image_url: string;
};

type RuntimePersona = {
  id: string;
  name: string;
  description: string;
  avatar: string;
  avatar_url: string;
  active?: boolean;
};

type RuntimeReasoningSettings = {
  prefix?: string;
  suffix?: string;
};

type RuntimeState = {
  chat: Record<string, unknown>[];
  messages: RuntimeMessage[];
  characters: RuntimeCharacter[];
  personas: RuntimePersona[];
  activePersonas: RuntimePersona[];
  selectedPersonaId: string;
  characterId?: number;
  chatId?: string;
  name1: string;
  name2: string;
  getRequestHeaders: () => Record<string, string>;
  saveMessageByIndex: (index: number, content: string, expectedMessageId?: string) => Promise<void>;
  addMessage?: (role: 'user' | 'assistant' | 'system', content: string, author?: string) => Promise<void>;
  deleteLastMessage?: () => Promise<void>;
  reloadChat?: () => Promise<void>;
  stopGeneration?: () => Promise<void>;
  toast: (message: string) => void;
  extensionLeader: boolean;
  reasoning: RuntimeReasoningSettings;
};

type EventHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type EventHandlerRecord = { handler: EventHandler; owner: string };

const SETTINGS_STORAGE_KEY = 'doubletrouble.sillyTavernExtensionSettings';
const loadedExtensionScripts = new Set<string>();
const loadedExtensionStyles = new Set<string>();
const templateCache = new Map<string, string>();
const chatMetadata: Record<string, unknown> = {};
const extensionPrompts: Record<string, { value: string; position: number; depth: number; scan: boolean; role: number }> = {};
const registeredMacros = new Map<string, string | (() => unknown)>();
let loadingExtensionName = '';

const eventTypes = {
  APP_READY: 'app_ready',
  CHAT_CHANGED: 'chat_id_changed',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_SENT: 'message_sent',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
  SETTINGS_UPDATED: 'settings_updated',
  SETTINGS_LOADED: 'settings_loaded',
  EXTRAS_CONNECTED: 'extras_connected',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  GROUP_UPDATED: 'group_updated',
};
class ExtensionEventSource {
  private handlers = new Map<string, EventHandlerRecord[]>();

  on(event: string, handler: EventHandler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), { handler, owner: loadingExtensionName }]);
  }

  once(event: string, handler: EventHandler) {
    const onceHandler: EventHandler = async (...args) => {
      this.removeListener(event, onceHandler);
      await handler(...args);
    };
    this.on(event, onceHandler);
  }

  makeLast(event: string, handler: EventHandler) {
    this.on(event, handler);
  }

  makeFirst(event: string, handler: EventHandler) {
    this.handlers.set(event, [{ handler, owner: loadingExtensionName }, ...(this.handlers.get(event) ?? [])]);
  }

  removeListener(event: string, handler: EventHandler) {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((item) => item.handler !== handler));
  }

  async emit(event: string, ...args: unknown[]) {
    for (const record of this.handlers.get(event) ?? []) {
      await runExtensionHandler(record, args, event);
    }
  }
}

const eventSource = new ExtensionEventSource();

async function runExtensionHandler(record: EventHandlerRecord, args: unknown[], event = '') {
  if (!shouldRunExtensionHandler(record, event)) {
    return;
  }
  const settingsHost = document.getElementById('extensions_settings');
  const before = new Set(settingsHost ? Array.from(settingsHost.children) : []);
  const previousLoadingExtensionName = loadingExtensionName;
  if (record.owner) {
    loadingExtensionName = record.owner;
  }
  try {
    await record.handler(...args);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    tagNewExtensionSettingsChildren(settingsHost, before, record.owner);
  } finally {
    loadingExtensionName = previousLoadingExtensionName;
  }
}

function shouldRunExtensionHandler(record: EventHandlerRecord, event: string) {
  const owner = record.owner.toLowerCase();
  if (isImageGenerationOwner(owner) && event === eventTypes.CHAT_CHANGED) {
    return false;
  }
  if (isImageGenerationOwner(owner) && event === eventTypes.CHARACTER_MESSAGE_RENDERED && !runtime.extensionLeader) {
    return false;
  }
  return true;
}

function isImageGenerationOwner(owner: string) {
  return /(?:sillyimages|inline.*image|image.*generation|iig|stable-diffusion|sd-webui|comfy)/i.test(owner);
}

function tagNewExtensionSettingsChildren(settingsHost: HTMLElement | null, before: Set<Element>, owner: string) {
  if (!settingsHost || !owner) {
    return;
  }
  Array.from(settingsHost.children).forEach((child) => {
    if (!before.has(child) && child instanceof HTMLElement && !child.dataset.dtExtensionOwner) {
      child.dataset.dtExtensionOwner = owner;
      child.hidden = true;
    }
  });
}

function tagSettingsChild(settingsHost: HTMLElement, node: Node, owner: string) {
  if (!owner || !(node instanceof HTMLElement)) {
    return;
  }
  let child: HTMLElement | null = node;
  while (child?.parentElement && child.parentElement !== settingsHost) {
    child = child.parentElement;
  }
  if (child?.parentElement === settingsHost && !child.dataset.dtExtensionOwner) {
    child.dataset.dtExtensionOwner = owner;
    child.hidden = true;
  }
}

function observeExtensionSettingsOwner(owner: string) {
  const settingsHost = document.getElementById('extensions_settings');
  if (!settingsHost) {
    return () => {};
  }
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => tagSettingsChild(settingsHost, node, owner)));
  });
  observer.observe(settingsHost, { childList: true, subtree: true });
  return () => observer.disconnect();
}

const extensionSettings = loadExtensionSettings();
let settingsSaveTimer = 0;
let extensionsInitialized = false;
let fileInputLabelCompatibilityInstalled = false;

let runtime: RuntimeState = {
  chat: [],
  messages: [],
  characters: [],
  personas: [],
  activePersonas: [],
  selectedPersonaId: '',
  characterId: undefined,
  name1: 'Player',
  name2: 'Bot',
  getRequestHeaders: () => ({}),
  saveMessageByIndex: async () => {},
  toast: () => {},
  extensionLeader: true,
  reasoning: {},
};

function loadExtensionSettings(): Record<string, unknown> {
  try {
    return JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSettingsDebounced() {
  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(extensionSettings));
    void fetch('/api/extensions/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...runtime.getRequestHeaders() },
      body: JSON.stringify({ extension_settings: extensionSettings, merge: true }),
    }).catch(() => {});
    void eventSource.emit(eventTypes.SETTINGS_UPDATED);
  }, 250);
}

export function updateSillyTavernExtensionSettings(patch: Record<string, unknown>) {
  Object.assign(extensionSettings, patch);
  saveSettingsDebounced();
}

export function getActiveExtensionPrompts() {
  return Object.entries(extensionPrompts)
    .filter(([, item]) => item && typeof item.value === 'string' && item.value.trim())
    .map(([key, item]) => ({ key, ...item }));
}
function toast(kind: 'success' | 'info' | 'warning' | 'error', message: string, title?: string) {
  const prefix = title ? `${title}: ` : '';
  runtime.toast(`${prefix}${message}`);
  const logger = kind === 'error' ? console.error : kind === 'warning' ? console.warn : console.log;
  logger(`[extension:${kind}]`, prefix + message);
}

function toPath(path: string | Array<string | number>) {
  return Array.isArray(path) ? path.map(String) : path.replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
}

function lodashChain(initialValue: unknown) {
  let value = initialValue;
  const chain = {
    map: (iteratee: string | ((item: unknown, index: number) => unknown) = (item) => item) => {
      value = lodashShim.map(value, typeof iteratee === 'string' ? (item) => lodashShim.get(item, iteratee) : (item, key) => iteratee(item, Number(key)));
      return chain;
    },
    filter: (predicate: (item: unknown, index: number) => boolean = Boolean) => {
      value = lodashShim.filter(value, (item, key) => predicate(item, Number(key)));
      return chain;
    },
    flatMap: (iteratee: (item: unknown, index: number) => unknown) => {
      value = (Array.isArray(value) ? value : Object.values((value || {}) as Record<string, unknown>)).flatMap((item, index) => {
        const nextValue = iteratee(item, index);
        return Array.isArray(nextValue) ? nextValue : [nextValue];
      });
      return chain;
    },
    values: () => {
      value = Object.values((value || {}) as Record<string, unknown>);
      return chain;
    },
    sortBy: (iteratee: string | ((item: unknown) => unknown)) => {
      const getter = typeof iteratee === 'string' ? (item: unknown) => lodashShim.get(item, iteratee) : iteratee;
      value = [...(Array.isArray(value) ? value : Object.values((value || {}) as Record<string, unknown>))].sort((left, right) => String(getter(left)).localeCompare(String(getter(right)), undefined, { numeric: true }));
      return chain;
    },
    flatten: () => {
      value = (Array.isArray(value) ? value : []).flat();
      return chain;
    },
    uniq: () => {
      value = Array.from(new Set(Array.isArray(value) ? value : []));
      return chain;
    },
    compact: () => {
      value = (Array.isArray(value) ? value : []).filter(Boolean);
      return chain;
    },
    push: (...items: unknown[]) => {
      value = [...(Array.isArray(value) ? value : []), ...items];
      return chain;
    },
    set: (path: string | Array<string | number>, nextValue: unknown) => {
      value = lodashShim.set((value || {}) as Record<string, unknown>, path, nextValue);
      return chain;
    },
    merge: (...objects: Array<Record<string, unknown>>) => {
      value = lodashShim.merge(value as Record<string, unknown>, ...objects);
      return chain;
    },
    fromPairs: () => {
      value = Object.fromEntries((value || []) as Array<[string, unknown]>);
      return chain;
    },
    value: () => value,
  };
  return chain;
}

const lodashMethods = {
  map: (collection: unknown, iteratee: (value: unknown, key: string | number) => unknown = (value) => value) => Array.isArray(collection)
    ? collection.map((value, index) => iteratee(value, index))
    : Object.entries((collection || {}) as Record<string, unknown>).map(([key, value]) => iteratee(value, key)),
  flatMap: (collection: unknown, iteratee: (value: unknown, key: string | number) => unknown = (value) => value) => lodashMethods.map(collection, iteratee).flatMap((value) => Array.isArray(value) ? value : [value]),
  filter: (collection: unknown, predicate: (value: unknown, key: string | number) => boolean = Boolean) => Array.isArray(collection)
    ? collection.filter((value, index) => predicate(value, index))
    : Object.entries((collection || {}) as Record<string, unknown>).filter(([key, value]) => predicate(value, key)).map(([, value]) => value),
  find: (collection: unknown, predicate: (value: unknown, key: string | number) => boolean) => Array.isArray(collection)
    ? collection.find((value, index) => predicate(value, index))
    : Object.entries((collection || {}) as Record<string, unknown>).find(([key, value]) => predicate(value, key))?.[1],
  includes: (collection: unknown, value: unknown) => Array.isArray(collection) || typeof collection === 'string' ? collection.includes(value as never) : Object.values((collection || {}) as Record<string, unknown>).includes(value),
  difference: (array: unknown[] = [], values: unknown[] = []) => array.filter((item) => !values.includes(item)),
  concat: (...values: unknown[]) => values.flatMap((value) => Array.isArray(value) ? value : [value]),
  reject: (collection: unknown, predicate: (value: unknown, key: string | number) => boolean) => lodashMethods.filter(collection, (value, key) => !predicate(value, key)),
  range: (start: number, end?: number, step = 1) => {
    const from = end === undefined ? 0 : start;
    const to = end === undefined ? start : end;
    const result: number[] = [];
    for (let value = from; step > 0 ? value < to : value > to; value += step) result.push(value);
    return result;
  },
  sample: (collection: unknown[]) => collection[Math.floor(Math.random() * collection.length)],
  random: (min = 0, max = 1) => Math.floor(Math.random() * (max - min + 1)) + min,
  min: (collection: number[] = []) => collection.length ? Math.min(...collection) : undefined,
  max: (collection: number[] = []) => collection.length ? Math.max(...collection) : undefined,
  inRange: (value: number, start: number, end?: number) => {
    const from = end === undefined ? 0 : start;
    const to = end === undefined ? start : end;
    return value >= Math.min(from, to) && value < Math.max(from, to);
  },
  drop: <T,>(array: T[] = [], count = 1) => array.slice(count),
  dropRight: <T,>(array: T[] = [], count = 1) => array.slice(0, Math.max(0, array.length - count)),
  zip: (...arrays: unknown[][]) => Array.from({ length: Math.max(0, ...arrays.map((array) => array.length)) }, (_, index) => arrays.map((array) => array[index])),
  pull: <T,>(array: T[], ...values: T[]) => {
    values.forEach((value) => {
      let index = array.indexOf(value);
      while (index !== -1) {
        array.splice(index, 1);
        index = array.indexOf(value);
      }
    });
    return array;
  },
  remove: <T>(collection: T[], predicate: (value: T, index: number) => boolean) => {
    const removed: T[] = [];
    for (let index = collection.length - 1; index >= 0; index -= 1) {
      if (predicate(collection[index], index)) removed.unshift(...collection.splice(index, 1));
    }
    return removed;
  },
  pick: (target: Record<string, unknown>, keys: string[] | string) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => Object.hasOwn(target || {}, key)).map((key) => [key, target[key]])),
  values: (target: unknown) => Object.values((target || {}) as Record<string, unknown>),
  partition: (collection: unknown[], predicate: (value: unknown) => boolean) => [collection.filter(predicate), collection.filter((value) => !predicate(value))],
  mapKeys: (target: Record<string, unknown>, iteratee: (value: unknown, key: string) => string) => Object.fromEntries(Object.entries(target || {}).map(([key, value]) => [iteratee(value, key), value])),
  merge: (...objects: Array<Record<string, unknown>>) => objects.reduce((result, object) => {
    Object.entries(object || {}).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = lodashShim.merge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    });
    return result;
  }, {} as Record<string, unknown>),
  mergeWith: (...args: unknown[]) => lodashMethods.merge(...(args.filter((arg) => typeof arg === 'object' && arg !== null) as Array<Record<string, unknown>>)),
  defaultsDeep: (...objects: Array<Record<string, unknown>>) => objects.reduceRight((result, object) => lodashMethods.merge(object, result), {} as Record<string, unknown>),
  fromPairs: (pairs: Array<[string, unknown]>) => Object.fromEntries(pairs || []),
  times: (count: number, iteratee: (index: number) => unknown = (index) => index) => Array.from({ length: Math.max(0, count) }, (_, index) => iteratee(index)),
  constant: <T,>(value: T) => () => value,
  toString: (value: unknown) => String(value ?? ''),
  get: (target: unknown, path: string | Array<string | number>, fallback?: unknown) => {
    const value = toPath(path).reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, target);
    return value === undefined ? fallback : value;
  },
  set: (target: Record<string, unknown>, path: string | Array<string | number>, value: unknown) => {
    const keys = toPath(path);
    let current = target;
    keys.slice(0, -1).forEach((key) => {
      if (!current[key] || typeof current[key] !== 'object') current[key] = {};
      current = current[key] as Record<string, unknown>;
    });
    if (keys.length) current[keys[keys.length - 1]] = value;
    return target;
  },
  unset: (target: Record<string, unknown>, path: string | Array<string | number>) => {
    const keys = toPath(path);
    const parent = keys.slice(0, -1).reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, target);
    if (parent && typeof parent === 'object' && keys.length) delete (parent as Record<string, unknown>)[keys[keys.length - 1]];
    return true;
  },
  has: (target: unknown, path: string | Array<string | number>) => lodashShim.get(target, path) !== undefined,
  isArray: Array.isArray,
  isPlainObject: (value: unknown) => Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
  isEmpty: (value: unknown) => value == null || (Array.isArray(value) || typeof value === 'string' ? value.length === 0 : Object.keys(value as Record<string, unknown>).length === 0),
  isEqual: (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right),
  cloneDeep: <T,>(value: T): T => structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T,
  debounce: <T extends (...args: unknown[]) => unknown>(fn: T, wait = 0) => {
    let timer = 0;
    return (...args: Parameters<T>) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), wait);
    };
  },
  throttle: <T extends (...args: unknown[]) => unknown>(fn: T, wait = 0) => {
    let last = 0;
    return (...args: Parameters<T>) => {
      const now = Date.now();
      if (now - last >= wait) {
        last = now;
        return fn(...args);
      }
      return undefined;
    };
  },
};

const lodashShim = Object.assign((value: unknown) => lodashChain(value), lodashMethods);

function interpolateTemplate(html: string, data: Record<string, unknown> = {}) {
  if (!data || typeof data !== 'object') return html;
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const val = lodashShim.get(data, key);
    return val !== undefined && val !== null ? String(val) : match;
  });
}

async function renderExtensionTemplateAsyncImpl(extensionName: string, templateId: string, templateData: Record<string, unknown> = {}) {
  const cleanExt = String(extensionName || '').replace(/^\/+|\/+$/g, '');
  const cleanId = String(templateId || '').replace(/\.html$/i, '').replace(/^\/+/, '');
  const cacheKey = `${cleanExt}:${cleanId}`;
  if (templateCache.has(cacheKey)) {
    return interpolateTemplate(templateCache.get(cacheKey) || '', templateData);
  }
  const candidates = cleanExt
    ? [
        `/scripts/extensions/${cleanExt}/${cleanId}.html`,
        ...(cleanExt.startsWith('third-party/') || cleanExt.startsWith('built-in/')
          ? []
          : [`/scripts/extensions/third-party/${cleanExt}/${cleanId}.html`, `/scripts/extensions/built-in/${cleanExt}/${cleanId}.html`]),
      ]
    : [`/scripts/extensions/${cleanId}.html`];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { headers: runtime.getRequestHeaders() });
      if (response.ok) {
        const html = await response.text();
        templateCache.set(cacheKey, html);
        return interpolateTemplate(html, templateData);
      }
    } catch {}
  }
  return '';
}

function renderExtensionTemplateImpl(extensionName: string, templateId: string, templateData: Record<string, unknown> = {}) {
  const cleanExt = String(extensionName || '').replace(/^\/+|\/+$/g, '');
  const cleanId = String(templateId || '').replace(/\.html$/i, '').replace(/^\/+/, '');
  const cached = templateCache.get(`${cleanExt}:${cleanId}`);
  if (cached !== undefined) {
    return interpolateTemplate(cached, templateData);
  }
  void renderExtensionTemplateAsyncImpl(extensionName, templateId, templateData);
  return '';
}

async function generateExtensionCompletion(promptOrOpts: unknown, systemPrompt = '', responseLength?: number): Promise<string> {
  let prompt = '';
  let sys = systemPrompt;
  let maxTokens = responseLength;
  if (typeof promptOrOpts === 'string') {
    prompt = promptOrOpts;
  } else if (promptOrOpts && typeof promptOrOpts === 'object') {
    const opts = promptOrOpts as Record<string, unknown>;
    prompt = String(opts.quietPrompt ?? opts.quiet_prompt ?? opts.prompt ?? '');
    sys = String(opts.systemPrompt ?? opts.system_prompt ?? sys ?? '');
    if (typeof opts.responseLength === 'number') maxTokens = opts.responseLength;
  }
  if (!prompt.trim() && !sys.trim()) return '';
  const response = await fetch('/api/backends/chat-completions/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...runtime.getRequestHeaders() },
    body: JSON.stringify({ prompt, system_prompt: sys, max_tokens: maxTokens }),
  });
  if (!response.ok) return '';
  const data = await response.json().catch(() => null) as { text?: string; content?: string } | null;
  return String(data?.text ?? data?.content ?? '');
}

async function showExtensionPopupModal(content: unknown, type = 1, inputValue = '', options: Record<string, unknown> = {}): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.68);display:flex;align-items:center;justify-content:center;padding:16px;';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:var(--surface,#181924);color:var(--fg,#f4f4f8);border:1px solid var(--border,rgba(255,255,255,0.14));border-radius:14px;max-width:640px;width:100%;max-height:85vh;display:flex;flex-direction:column;gap:12px;padding:18px;box-shadow:0 18px 48px rgba(0,0,0,0.5);';
  const body = document.createElement('div');
  body.style.cssText = 'overflow:auto;max-height:65vh;';
  if (content instanceof HTMLElement) {
    body.appendChild(content);
  } else if (content && typeof content === 'object' && 'get' in content && typeof content.get === 'function') {
    const rawNodes: unknown = content.get();
    if (Array.isArray(rawNodes)) {
      rawNodes.forEach((n) => n instanceof Node && body.appendChild(n));
    }
  } else {
    body.innerHTML = String(content ?? '');
  }
  dialog.appendChild(body);
  let inputEl: HTMLInputElement | HTMLTextAreaElement | null = null;
  if (type === 3) {
    inputEl = options.rows && Number(options.rows) > 1 ? document.createElement('textarea') : document.createElement('input');
    inputEl.value = String(inputValue ?? '');
    inputEl.style.cssText = 'width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.25);color:inherit;';
    dialog.appendChild(inputEl);
  }
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
  const close = (result: unknown) => {
    overlay.remove();
    resolve(result);
  };
  if (type === 2 || type === 3 || options.cancelButton) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ghost-button';
    cancelBtn.textContent = typeof options.cancelButton === 'string' ? options.cancelButton : 'Cancel';
    cancelBtn.onclick = () => close(type === 3 ? null : 0);
    actions.appendChild(cancelBtn);
  }
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.textContent = typeof options.okButton === 'string' ? options.okButton : 'OK';
  okBtn.onclick = () => close(type === 3 ? (inputEl?.value ?? '') : 1);
  actions.appendChild(okBtn);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  inputEl?.focus();
  return promise;
}

function substituteExtensionParams(text: string): string {
  let out = String(text ?? '')
    .replaceAll('{{user}}', runtime.name1 || 'User')
    .replaceAll('{{char}}', runtime.name2 || 'Char')
    .replaceAll('{user}', runtime.name1 || 'User')
    .replaceAll('{char}', runtime.name2 || 'Char');
  if (out.includes('{{')) {
    out = out.replace(/\{\{([^}]+)\}\}/g, (match, rawKey) => {
      const key = String(rawKey).trim();
      if (registeredMacros.has(key)) {
        const macro = registeredMacros.get(key);
        return typeof macro === 'function' ? String(macro() ?? '') : String(macro ?? '');
      }
      return match;
    });
  }
  return out;
}

export async function executeExtensionSlashCommand(rawInput: string): Promise<{ handled: boolean; output?: string }> {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith('/')) return { handled: false };
  const spaceIdx = trimmed.indexOf(' ');
  const cmdName = (spaceIdx >= 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
  const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : '';
  const registry = (window as typeof window & { __dtSlashCommands?: Map<string, Record<string, unknown>> }).__dtSlashCommands;
  if (!registry || !cmdName) return { handled: false };
  const entry = registry.get(cmdName) || Array.from(registry.values()).find((item) => String(item.name || '').toLowerCase() === cmdName || (Array.isArray(item.aliases) && item.aliases.some((a) => String(a).toLowerCase() === cmdName)));
  if (!entry || typeof entry.callback !== 'function') return { handled: false };
  const namedArgs: Record<string, string> = {};
  let unnamed = rest;
  const argRegex = /^(\w+)=("[^"]*"|\S+)\s*/;
  while (true) {
    const m = unnamed.match(argRegex);
    if (!m) break;
    namedArgs[m[1]] = m[2].replace(/^"|"$/g, '');
    unnamed = unnamed.slice(m[0].length);
  }
  const res = await (entry.callback as (args: Record<string, string>, value: string) => unknown)(namedArgs, unnamed);
  return { handled: true, output: res != null ? String(res) : undefined };
}

function ensureGlobals() {
  const win = window as typeof window & { SillyTavern?: unknown; toastr?: unknown; $?: unknown; jQuery?: unknown; t?: unknown; _?: unknown; hljs?: unknown; Popper?: unknown; createPopper?: unknown; DOMPurify?: unknown };
  win.SillyTavern = {
    getContext: () => {
      const contextChat = runtime.chat;
      return {
        chat: contextChat,
        characters: runtime.characters,
        personas: runtime.personas,
        activePersonas: runtime.activePersonas,
        connectedPersonas: runtime.activePersonas,
        selectedPersona: runtime.personas.find((persona) => persona.id === runtime.selectedPersonaId) || runtime.personas[0] || null,
        selectedPersonaId: runtime.selectedPersonaId,
        characterId: runtime.characterId,
        groupId: null,
        groups: [],
        chatId: runtime.chatId || 'default',
        getCurrentChatId: () => runtime.chatId || 'default',
        name1: runtime.name1,
        name2: runtime.name2,
        extensionSettings: extensionSettings,
        chatMetadata,
        chat_metadata: chatMetadata,
        extensionPrompts,
        eventSource,
        eventTypes,
        event_types: eventTypes,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', ...runtime.getRequestHeaders() }),
        isExtensionLeader: runtime.extensionLeader,
        saveSettingsDebounced,
        saveSettings: saveSettingsDebounced,
        saveMetadataDebounced: saveSettingsDebounced,
        saveMetadata: async () => saveSettingsDebounced(),
        saveChat: () => saveChatFromExtension(contextChat),
        reloadCurrentChat: async () => runtime.reloadChat?.(),
        addOneMessage: async (mes: Record<string, unknown>) => runtime.addMessage?.(mes?.is_user ? 'user' : mes?.is_system ? 'system' : 'assistant', String(mes?.mes ?? ''), String(mes?.name || '')),
        sendSystemMessage: async (_type: string, text: string) => runtime.addMessage?.('system', String(text ?? ''), 'System'),
        deleteLastMessage: async () => runtime.deleteLastMessage?.(),
        stopGeneration: async () => runtime.stopGeneration?.(),
        generateQuietPrompt: (promptOrOpts: unknown, _quietToLoud?: boolean, _skipWIAN?: boolean, _img?: string, _name?: string, responseLength?: number) => generateExtensionCompletion(promptOrOpts, '', responseLength),
        generateRaw: (opts: unknown) => generateExtensionCompletion(opts),
        Generate: (_type: string, opts: Record<string, unknown> = {}) => generateExtensionCompletion(opts.quiet_prompt || opts),
        setExtensionPrompt: (key: string, value: string, position = 1, depth = 4, scan = false, role = 0) => {
          extensionPrompts[String(key)] = { value: String(value ?? ''), position: Number(position), depth: Number(depth), scan: Boolean(scan), role: Number(role) };
        },
        renderExtensionTemplateAsync: renderExtensionTemplateAsyncImpl,
        renderExtensionTemplate: renderExtensionTemplateImpl,
        writeExtensionField: async (_chid: unknown, key: string, value: unknown) => {
          extensionSettings[String(key)] = value;
          saveSettingsDebounced();
        },
        callGenericPopup: showExtensionPopupModal,
        callPopup: showExtensionPopupModal,
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
        substituteParams: substituteExtensionParams,
        substituteParamsExtended: substituteExtensionParams,
        registerMacro: (name: string, value: string | (() => unknown)) => { registeredMacros.set(String(name), value); },
        unregisterMacro: (name: string) => { registeredMacros.delete(String(name)); },
        registerSlashCommand: (name: string, callback: unknown, aliases: string[] = [], helpString = '') => {
          const reg = ((window as typeof window & { __dtSlashCommands?: Map<string, unknown> }).__dtSlashCommands ??= new Map());
          reg.set(String(name), { name, callback, aliases, helpString });
        },
        executeSlashCommands: async (text: string) => (await executeExtensionSlashCommand(text)).output ?? '',
        executeSlashCommandsWithOptions: async (text: string) => ({ pipe: (await executeExtensionSlashCommand(text)).output ?? '' }),
        getTokenCountAsync: async (text: string) => Math.ceil(String(text ?? '').length / 4),
        messageFormatting: formatExtensionMessageHtml,
        getCharacterAvatar: (characterId: number) => runtime.characters[characterId]?.image_url || runtime.characters[characterId]?.avatar || '',
        scrollOnMediaLoad: () => window.requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })),
      };
    },
  };
  win.toastr = {
    success: (message: string, title?: string) => toast('success', message, title),
    info: (message: string, title?: string) => toast('info', message, title),
    warning: (message: string, title?: string) => toast('warning', message, title),
    error: (message: string, title?: string) => toast('error', message, title),
    clear: () => {},
  };
  win.$ = win.jQuery = Object.assign(jqueryShim, {
    extend: (_deepOrTarget: unknown, ...rest: unknown[]) => Object.assign(typeof _deepOrTarget === 'boolean' ? (rest.shift() as object || {}) : (_deepOrTarget as object || {}), ...rest),
    ajax: async (opts: Record<string, unknown>) => {
      const res = await fetch(String(opts.url || ''), {
        method: String(opts.type || opts.method || 'GET'),
        headers: { ...(opts.contentType ? { 'Content-Type': String(opts.contentType) } : {}), ...runtime.getRequestHeaders(), ...(opts.headers as Record<string, string> || {}) },
        body: opts.data ? (typeof opts.data === 'string' ? opts.data : JSON.stringify(opts.data)) : undefined,
      });
      const data = await res.json().catch(() => res.text());
      if (res.ok && typeof opts.success === 'function') opts.success(data);
      if (!res.ok && typeof opts.error === 'function') opts.error(res);
      return data;
    },
    get: async (url: string, cb?: (data: unknown) => void) => {
      const res = await fetch(url, { headers: runtime.getRequestHeaders() });
      const data = await res.text();
      cb?.(data);
      return data;
    },
    getJSON: async (url: string, cb?: (data: unknown) => void) => {
      const res = await fetch(url, { headers: runtime.getRequestHeaders() });
      const data = await res.json();
      cb?.(data);
      return data;
    },
  });
  win.DOMPurify = win.DOMPurify || { sanitize: (html: string) => html };
  win.t = (strings: TemplateStringsArray | string, ...values: unknown[]) => Array.isArray(strings) && 'raw' in strings ? String.raw(strings, ...values) : String(strings);
  win._ = lodashShim;
  win.hljs = win.hljs || { highlightElement: () => {} };
  const createPopper = win.createPopper || (() => ({ state: {}, setOptions: () => {}, forceUpdate: () => {}, update: () => Promise.resolve({}), destroy: () => {} }));
  win.createPopper = createPopper;
  win.Popper = win.Popper || { createPopper };
  installFileInputLabelCompatibility();
}
function installFileInputLabelCompatibility() {
  if (fileInputLabelCompatibilityInstalled) {
    return;
  }
  fileInputLabelCompatibilityInstalled = true;
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target instanceof HTMLInputElement) {
      return;
    }
    const label = target.closest('label');
    if (!label || !label.closest('#extensions_settings') || label.closest('[data-dt-extension-owner="regex"], [data-dt-extension-owner="magic-translation"]')) {
      return;
    }
    const input = label.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    event.preventDefault();
    input.click();
  }, true);
}

function jqueryShim(input?: unknown, context?: unknown) {
  if (typeof input === 'function') {
    const owner = loadingExtensionName;
    const runCallback = () => {
      if (owner) {
        void runExtensionHandler({ handler: input as EventHandler, owner }, []);
      } else {
        input();
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runCallback);
    } else {
      window.setTimeout(runCallback, 0);
    }
    return jqueryCollection([]);
  }
  if (typeof input === 'string' && input.trim().startsWith('<')) {
    const template = document.createElement('template');
    template.innerHTML = input.trim();
    const created = Array.from(template.content.children);
    if (loadingExtensionName) {
      created.forEach((element) => element instanceof HTMLElement && (element.dataset.dtExtensionOwner = loadingExtensionName));
    }
    return jqueryCollection(created);
  }
  if (typeof input === 'string') {
    const root = context instanceof Document || context instanceof Element ? context : document;
    return jqueryCollection(Array.from(root.querySelectorAll(input)));
  }
  if (input === window || input === document || input instanceof Element) {
    return jqueryCollection([input as Window | Document | Element]);
  }
  if (Array.isArray(input) || input instanceof NodeList) {
    return jqueryCollection(Array.from(input as ArrayLike<unknown>));
  }
  return jqueryCollection([]);
}

function jqueryCollection(elements: unknown[]) {
  const elementOnly = () => elements.filter((element): element is Element => element instanceof Element);
  const collectionItems = (value: unknown) => value && typeof value === 'object' && 'get' in value && typeof (value as { get?: unknown }).get === 'function'
    ? ((value as { get: () => unknown[] }).get() || [])
    : (jqueryShim(value) as { get: () => unknown[] }).get();
  const childElements = (child: unknown) => collectionItems(child).filter((element): element is Element => element instanceof Element);
  const targetElements = (target: unknown) => typeof target === 'string'
    ? Array.from(document.querySelectorAll(target))
    : collectionItems(target).filter((element): element is Element => element instanceof Element);
  const assignSettingsOwner = (element: Element, parent: Element) => {
    if (!(element instanceof HTMLElement) || parent.id !== 'extensions_settings') {
      return;
    }
    const owner = element.dataset.dtExtensionOwner || loadingExtensionName;
    if (owner) {
      element.dataset.dtExtensionOwner = owner;
      element.hidden = true;
    }
  };
  const eventName = (event: string) => event.split('.')[0] || event;
  const api: Record<string, unknown> = {
    length: elements.length,
    0: elements[0],
    get: (index?: number) => index === undefined ? elements : elements[index],
    toArray: () => elements,
    ready: (callback: () => void) => {
      jqueryShim(callback);
      return api;
    },
    each: (callback: (index: number, element: Element) => void) => {
      elements.forEach((element, index) => element instanceof Element && callback(index, element));
      return api;
    },
    appendTo: (target: unknown) => {
      const parents = targetElements(target);
      parents.forEach((parent) => elements.forEach((element) => {
        if (element instanceof Element) {
          assignSettingsOwner(element, parent);
          parent.appendChild(element);
        }
      }));
      return api;
    },
    prependTo: (target: unknown) => {
      const parents = targetElements(target);
      parents.forEach((parent) => elements.slice().reverse().forEach((element) => {
        if (element instanceof Element) {
          assignSettingsOwner(element, parent);
          parent.prepend(element);
        }
      }));
      return api;
    },
    append: (child: unknown) => {
      const children = childElements(child);
      elements.forEach((element, idx) => {
        if (element instanceof Element) {
          children.forEach((childElement) => {
            const node = idx === 0 ? childElement : (childElement.cloneNode(true) as Element);
            assignSettingsOwner(node, element);
            element.appendChild(node);
          });
        }
      });
      return api;
    },
    prepend: (child: unknown) => {
      const children = childElements(child);
      elements.forEach((element, idx) => {
        if (element instanceof Element) {
          children.slice().reverse().forEach((childElement) => {
            const node = idx === 0 ? childElement : (childElement.cloneNode(true) as Element);
            assignSettingsOwner(node, element);
            element.prepend(node);
          });
        }
      });
      return api;
    },
    before: (child: unknown) => {
      const children = childElements(child);
      elements.forEach((element, idx) => element instanceof Element && children.forEach((childElement) => element.before(idx === 0 ? childElement : childElement.cloneNode(true))));
      return api;
    },
    after: (child: unknown) => {
      const children = childElements(child);
      elements.forEach((element, idx) => element instanceof Element && children.slice().reverse().forEach((childElement) => element.after(idx === 0 ? childElement : childElement.cloneNode(true))));
      return api;
    },
    on: (event: string, selectorOrHandler: string | EventListener, maybeHandler?: EventListener) => {
      const type = eventName(event);
      const selector = typeof selectorOrHandler === 'string' ? selectorOrHandler : '';
      const handler = typeof selectorOrHandler === 'function' ? selectorOrHandler : maybeHandler;
      if (!type || typeof handler !== 'function') return api;
      elements.forEach((element) => {
        const listener: EventListener = selector
          ? (domEvent) => {
              const target = domEvent.target instanceof Element ? domEvent.target.closest(selector) : null;
              if (target) handler.call(target, domEvent);
            }
          : handler;
        if (element instanceof EventTarget) element.addEventListener(type, listener);
      });
      return api;
    },
    off: (event: string, selectorOrHandler?: string | EventListener, maybeHandler?: EventListener) => {
      const type = eventName(event);
      const handler = typeof selectorOrHandler === 'function' ? selectorOrHandler : maybeHandler;
      if (!type || typeof handler !== 'function') return api;
      elements.forEach((element) => element instanceof EventTarget && element.removeEventListener(type, handler));
      return api;
    },
    attr: (name: string, value?: string) => {
      if (value === undefined) return elements[0] instanceof Element ? elements[0].getAttribute(name) : undefined;
      elements.forEach((element) => element instanceof Element && element.setAttribute(name, value));
      return api;
    },
    removeAttr: (name: string) => {
      elements.forEach((element) => element instanceof Element && element.removeAttribute(name));
      return api;
    },
    prop: (name: string, value?: unknown) => {
      const first = elements[0] as unknown as Record<string, unknown> | undefined;
      if (value === undefined) return first?.[name];
      elements.forEach((element) => { (element as unknown as Record<string, unknown>)[name] = value; });
      return api;
    },
    css: (name: string | Record<string, string>, value?: string) => {
      const first = elements[0] as HTMLElement | undefined;
      if (typeof name === 'string' && value === undefined) return first?.style?.getPropertyValue(name) || '';
      elements.forEach((element) => {
        if (!(element instanceof HTMLElement)) return;
        if (typeof name === 'string') element.style.setProperty(name, value || '');
        else Object.entries(name).forEach(([key, nextValue]) => element.style.setProperty(key, nextValue));
      });
      return api;
    },
    hide: () => {
      elements.forEach((element) => { if (element instanceof HTMLElement) element.style.display = 'none'; });
      return api;
    },
    show: () => {
      elements.forEach((element) => { if (element instanceof HTMLElement) element.style.display = ''; });
      return api;
    },
    toggle: (force?: boolean) => {
      elements.forEach((element) => { if (element instanceof HTMLElement) element.style.display = force ?? element.style.display === 'none' ? '' : 'none'; });
      return api;
    },
    data: (name?: string, value?: string) => {
      const first = elements[0] as HTMLElement | undefined;
      if (name === undefined) return first?.dataset || {};
      if (value === undefined) return first?.dataset?.[name];
      elements.forEach((element) => { if (element instanceof HTMLElement) element.dataset[name] = value; });
      return api;
    },
    val: (value?: string) => {
      const first = elements[0] as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined;
      if (value === undefined) return first?.value;
      elements.forEach((element) => {
        if (element && typeof element === 'object' && 'value' in element) (element as HTMLInputElement).value = value;
      });
      return api;
    },
    text: (value?: string) => {
      if (value === undefined) return elements.map((element) => element instanceof Element ? element.textContent || '' : '').join('');
      elements.forEach((element) => { if (element instanceof Element) element.textContent = value; });
      return api;
    },
    html: (value?: string) => {
      if (value === undefined) return elements[0] instanceof Element ? elements[0].innerHTML : '';
      elements.forEach((element) => { if (element instanceof Element) element.innerHTML = value; });
      return api;
    },
    empty: () => {
      elements.forEach((element) => { if (element instanceof Element) element.innerHTML = ''; });
      return api;
    },
    map: (callback: (index: number, element: Element) => unknown) => jqueryCollection(elementOnly().map((element, index) => callback(index, element)).flat().filter((item) => item != null)),
    find: (selector: string) => jqueryCollection(elements.flatMap((element) => element instanceof Element ? Array.from(element.querySelectorAll(selector)) : [])),
    closest: (selector: string) => jqueryCollection(elements.map((element) => element instanceof Element ? element.closest(selector) : null).filter(Boolean) as Element[]),
    children: (selector?: string) => {
      const children = elementOnly().flatMap((element) => Array.from(element.children));
      return jqueryCollection(selector ? children.filter((element) => element.matches(selector)) : children);
    },
    parent: (selector?: string) => {
      const parents = elementOnly().map((element) => element.parentElement).filter((element): element is HTMLElement => Boolean(element));
      return jqueryCollection(selector ? parents.filter((element) => element.matches(selector)) : parents);
    },
    siblings: (selector?: string) => {
      const siblings = elementOnly().flatMap((element) => Array.from(element.parentElement?.children || []).filter((sibling) => sibling !== element));
      return jqueryCollection(selector ? siblings.filter((element) => element.matches(selector)) : siblings);
    },
    eq: (index: number) => jqueryCollection(elements[index] ? [elements[index]] : []),
    first: () => jqueryCollection(elements[0] ? [elements[0]] : []),
    last: () => jqueryCollection(elements[elements.length - 1] ? [elements[elements.length - 1]] : []),
    is: (selector: string) => elements[0] instanceof Element ? elements[0].matches(selector) : false,
    filter: (selectorOrCallback: string | ((index: number, element: Element) => boolean)) => jqueryCollection(elements.filter((element, index) => element instanceof Element && (typeof selectorOrCallback === 'string' ? element.matches(selectorOrCallback) : selectorOrCallback(index, element))) as Element[]),
    remove: () => {
      elements.forEach((element) => element instanceof Element && element.remove());
      return api;
    },
    wrap: (html: string) => {
      const wrapper = childElements(html)[0];
      if (!wrapper) return api;
      elementOnly().forEach((element) => {
        const clone = wrapper.cloneNode(true) as Element;
        element.before(clone);
        clone.appendChild(element);
      });
      return api;
    },
    add: (other: unknown) => jqueryCollection([...elements, ...collectionItems(other)]),
    clone: () => jqueryCollection(elementOnly().map((element) => element.cloneNode(true))),
    replaceWith: (replacement: unknown) => {
      const replacements = childElements(replacement);
      elementOnly().forEach((element) => element.replaceWith(...replacements.map((replacementElement) => replacementElement.cloneNode(true))));
      return api;
    },
    trigger: (event: string, data?: unknown) => {
      elements.forEach((element) => element instanceof EventTarget && element.dispatchEvent(new CustomEvent(event, { bubbles: true, detail: data })));
      return api;
    },
    addClass: (className: string) => {
      elements.forEach((element) => element instanceof Element && element.classList.add(...className.split(/\s+/).filter(Boolean)));
      return api;
    },
    removeClass: (className: string) => {
      elements.forEach((element) => element instanceof Element && element.classList.remove(...className.split(/\s+/).filter(Boolean)));
      return api;
    },
    toggleClass: (className: string, force?: boolean) => {
      elements.forEach((element) => {
        if (element instanceof Element) {
          className.split(/\s+/).filter(Boolean).forEach((cls) => element.classList.toggle(cls, force));
        }
      });
      return api;
    },
    hasClass: (className: string) => elements[0] instanceof Element ? elements[0].classList.contains(className) : false,
    fadeIn: (_duration?: number, callback?: () => void) => {
      elements.forEach((element) => { if (element instanceof HTMLElement) element.style.display = ''; });
      callback?.();
      return api;
    },
    fadeOut: (_duration?: number, callback?: () => void) => {
      elements.forEach((element) => { if (element instanceof HTMLElement) element.style.display = 'none'; });
      callback?.();
      return api;
    },
    slideUp: (_duration?: number, callback?: () => void) => {
      elements.forEach((element) => { if (element instanceof HTMLElement) element.style.display = 'none'; });
      callback?.();
      return api;
    },
    slideDown: (_duration?: number, callback?: () => void) => {
      elements.forEach((element) => { if (element instanceof HTMLElement) element.style.display = ''; });
      callback?.();
      return api;
    },
    slideToggle: (_duration?: number, callback?: () => void) => {
      elements.forEach((element) => { if (element instanceof HTMLElement) element.style.display = element.style.display === 'none' ? '' : 'none'; });
      callback?.();
      return api;
    },
    focus: () => {
      if (elements[0] instanceof HTMLElement) elements[0].focus();
      return api;
    },
    blur: () => {
      if (elements[0] instanceof HTMLElement) elements[0].blur();
      return api;
    },
    next: (selector?: string) => {
      const nextEls = elementOnly().map((el) => el.nextElementSibling).filter((el): el is Element => Boolean(el));
      return jqueryCollection(selector ? nextEls.filter((el) => el.matches(selector)) : nextEls);
    },
    prev: (selector?: string) => {
      const prevEls = elementOnly().map((el) => el.previousElementSibling).filter((el): el is Element => Boolean(el));
      return jqueryCollection(selector ? prevEls.filter((el) => el.matches(selector)) : prevEls);
    },
    not: (selector: string) => jqueryCollection(elementOnly().filter((el) => !el.matches(selector))),
    index: () => elements[0] instanceof Element && elements[0].parentElement ? Array.from(elements[0].parentElement.children).indexOf(elements[0]) : -1,
    width: () => elements[0] instanceof HTMLElement ? elements[0].clientWidth : 0,
    height: () => elements[0] instanceof HTMLElement ? elements[0].clientHeight : 0,
    outerWidth: () => elements[0] instanceof HTMLElement ? elements[0].offsetWidth : 0,
    outerHeight: () => elements[0] instanceof HTMLElement ? elements[0].offsetHeight : 0,
    scrollTop: (val?: number) => {
      if (val === undefined) return elements[0] instanceof Element ? elements[0].scrollTop : 0;
      elements.forEach((el) => { if (el instanceof Element) el.scrollTop = val; });
      return api;
    },
    serializeArray: () => elementOnly().flatMap((element) => Array.from(element.querySelectorAll('input, select, textarea')))
      .filter((field): field is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => 'name' in field && 'value' in field && Boolean(field.name))
      .map((field) => ({ name: field.name, value: field.value })),
  };
  return api;
}

async function saveChatFromExtension(sourceChat = runtime.chat) {
  await Promise.all(sourceChat.map(async (message, index) => {
    const nextContent = String(message.mes ?? '');
    const expectedMessageId = typeof message.dt_message_id === 'string' ? message.dt_message_id : undefined;
    const currentIndex = expectedMessageId ? runtime.messages.findIndex((item) => item.id === expectedMessageId) : index;
    if (currentIndex < 0) {
      return;
    }
    if (runtime.messages[currentIndex]?.content !== nextContent) {
      await runtime.saveMessageByIndex(currentIndex, nextContent, expectedMessageId);
    }
  }));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type ExtensionMessageFormatOptions = {
  forceImagePending?: boolean;
  renderPendingMarkersAsSpinner?: boolean;
  reasoning?: RuntimeReasoningSettings;
  t?: (key: string) => string;
};

export function formatExtensionMessageHtml(content: string, options: ExtensionMessageFormatOptions = {}) {
  const formatOptions = options && typeof options === 'object' ? options : {};
  return sanitizeExtensionHtml(stripReasoningBlocks(content, formatOptions.reasoning ?? runtime.reasoning), formatOptions);
}

function stripReasoningBlocks(content: string, reasoning: RuntimeReasoningSettings = {}) {
  const prefix = String(reasoning.prefix || '');
  const suffix = String(reasoning.suffix || '');
  if (!prefix || !suffix) {
    return content.trim();
  }
  let output = content;
  while (true) {
    const start = findMarker(output, [prefix, prefix.trim()], 0);
    if (start.index < 0) {
      break;
    }
    const bodyStart = start.index + start.marker.length;
    const end = findMarker(output, [suffix, suffix.trim()], bodyStart);
    output = end.index < 0
      ? output.slice(0, start.index)
      : `${output.slice(0, start.index)}${output.slice(end.index + end.marker.length)}`;
  }
  return output.trim();
}

function findMarker(content: string, markers: string[], fromIndex: number) {
  return Array.from(new Set(markers.filter(Boolean))).reduce((best, marker) => {
    const index = content.indexOf(marker, fromIndex);
    if (index < 0 || (best.index >= 0 && best.index <= index)) {
      return best;
    }
    return { index, marker };
  }, { index: -1, marker: '' });
}

function sanitizeExtensionHtml(content: string, options: ExtensionMessageFormatOptions) {
  const template = document.createElement('template');
  template.innerHTML = content;
  return Array.from(template.content.childNodes).map((node) => sanitizeNode(node, options)).join('');
}

function sanitizeNode(node: ChildNode, options: ExtensionMessageFormatOptions): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent || '').replace(/\n/g, '<br>');
  }
  if (!(node instanceof Element)) {
    return '';
  }

  const tag = node.tagName.toLowerCase();
  const allowedTags = new Set([
    'div', 'span', 'p', 'br', 'hr', 'img', 'video', 'audio', 'source',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'small',
    'code', 'pre', 'blockquote', 'a', 'button', 'label', 'input', 'select', 'option', 'textarea',
    'details', 'summary', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'nav', 'aside',
    'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'defs', 'lineargradient', 'stop',
  ]);
  if (!allowedTags.has(tag)) {
    return escapeHtml(node.outerHTML || node.textContent || '');
  }

  const attrs = Array.from(node.attributes)
    .map((attr) => sanitizeAttribute(tag, attr.name, attr.value))
    .filter((attr): attr is string => Boolean(attr))
    .join('');
  if ((tag === 'img' || tag === 'video') && shouldRenderImagePending(node, options)) {
    return renderImagePendingPlaceholder(node, options);
  }
  if ((tag === 'img' || tag === 'video') && isImagePendingMarker(node)) {
    return `<span class="iig-pending-media-shell">${renderSanitizedElement(tag, attrs, node, options)}</span>`;
  }
  if (tag === 'br' || tag === 'hr' || tag === 'img' || tag === 'input' || tag === 'source') {
    return `<${tag}${attrs}>`;
  }
  return renderSanitizedElement(tag, attrs, node, options);
}

function shouldRenderImagePending(node: Element, options: ExtensionMessageFormatOptions) {
  if (options.forceImagePending) {
    return true;
  }
  if (!isImagePendingMarker(node)) {
    return false;
  }
  return Boolean(options.renderPendingMarkersAsSpinner);
}

function isImagePendingMarker(node: Element) {
  const hasInstruction = node.hasAttribute('data-iig-instruction');
  const pendingSrc = node.getAttribute('data-iig-pending-src') || node.getAttribute('src') || '';
  const pendingPoster = node.getAttribute('data-iig-pending-poster') || node.getAttribute('poster') || '';
  return Boolean(hasInstruction && /^\[(?:IMG|VID):/i.test(pendingSrc || pendingPoster));
}

function renderImagePendingPlaceholder(node: Element, options: ExtensionMessageFormatOptions) {
  const instruction = node.getAttribute('data-iig-instruction') || '';
  const pendingSrc = node.getAttribute('data-iig-pending-src') || node.getAttribute('src') || '';
  const statusText = options.t ? options.t('message.imageGenerating') : 'Generating image...';
  return `<div class="iig-loading-placeholder iig-rendered-pending" data-iig-instruction="${escapeHtml(instruction)}" data-iig-pending-src="${escapeHtml(pendingSrc)}"><div class="iig-spinner"></div><div class="iig-status">${escapeHtml(statusText)}</div></div>`;
}

function renderSanitizedElement(tag: string, attrs: string, node: Element, options: ExtensionMessageFormatOptions) {
  if (tag === 'br' || tag === 'hr' || tag === 'img' || tag === 'input' || tag === 'source') {
    return `<${tag}${attrs}>`;
  }
  return `<${tag}${attrs}>${Array.from(node.childNodes).map((child) => sanitizeNode(child, options)).join('')}</${tag}>`;
}

function sanitizeAttribute(tag: string, name: string, value: string) {
  const attr = name.toLowerCase();
  if (attr.startsWith('on')) {
    return '';
  }
  if (attr.startsWith('data-') || attr.startsWith('aria-')) {
    return ` ${attr}="${escapeHtml(value)}"`;
  }
  if (['class', 'id', 'style', 'title', 'alt', 'name', 'type', 'value', 'checked', 'for', 'placeholder', 'disabled', 'readonly', 'selected', 'rows', 'cols', 'min', 'max', 'step', 'colspan', 'rowspan', 'open', 'role', 'tabindex', 'viewbox', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'xmlns', 'offset', 'stop-color', 'stop-opacity'].includes(attr)) {
    return ` ${name}="${escapeHtml(value)}"`;
  }
  if (attr === 'href') {
    return /^(https?:|mailto:|\/|#)/i.test(value.trim()) ? ` href="${escapeHtml(value.trim())}" target="_blank" rel="noopener noreferrer"` : '';
  }
  if (['controls', 'autoplay', 'loop', 'muted', 'playsinline'].includes(attr)) {
    return tag === 'video' || tag === 'audio' ? ` ${attr}="${escapeHtml(value)}"` : '';
  }
  if (['src', 'poster'].includes(attr)) {
    if (/^\[(?:IMG|VID):/i.test(value)) {
      return ` data-iig-pending-${attr}="${escapeHtml(value)}"`;
    }
    return /^(https?:|data:image\/|data:video\/|data:audio\/|\/|#)/i.test(value) ? ` ${attr}="${escapeHtml(value)}"` : '';
  }
  return '';
}

function toSillyTavernChat(messages: RuntimeMessage[]) {
  return messages.map((message) => ({
    dt_message_id: message.id,
    name: message.author,
    is_user: message.role === 'user',
    is_system: message.role === 'system',
    mes: message.content,
    extra: {},
    swipes: message.swipes?.length ? message.swipes : message.role === 'assistant' ? [message.content] : undefined,
    swipe_id: message.active_swipe_index ?? 0,
  }));
}

export function updateSillyTavernRuntime(patch: Omit<RuntimeState, 'chat'>) {
  runtime = {
    ...patch,
    chat: toSillyTavernChat(patch.messages),
  };
  ensureGlobals();
}

async function loadJson<T>(url: string): Promise<T | null> {
  const token = window.localStorage.getItem('doubletrouble.authToken') || '';
  const accessToken = window.localStorage.getItem('doubletrouble.accessToken') || '';
  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(accessToken ? { 'X-DoubleTrouble-Access': accessToken } : {}),
    },
  });
  if (!response.ok) {
    return null;
  }
  return await response.json() as T;
}

function loadStyle(name: string, manifest: ExtensionManifest) {
  if (!manifest.css || loadedExtensionStyles.has(name)) {
    return;
  }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `/scripts/extensions/${name}/${manifest.css}`;
  document.head.appendChild(link);
  loadedExtensionStyles.add(name);
}

function loadScript(name: string, manifest: ExtensionManifest) {
  if (!manifest.js || loadedExtensionScripts.has(name)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const settingsHost = document.getElementById('extensions_settings');
    const existingSettingsChildren = new Set(settingsHost ? Array.from(settingsHost.children) : []);
    const stopObservingSettings = observeExtensionSettingsOwner(name);
    const script = document.createElement('script');
    script.type = 'module';
    script.src = `/scripts/extensions/${name}/${manifest.js}`;
    script.onload = () => {
      window.setTimeout(() => {
        loadedExtensionScripts.add(name);
        tagNewExtensionSettingsChildren(settingsHost, existingSettingsChildren, name);
        stopObservingSettings();
        if (loadingExtensionName === name) {
          loadingExtensionName = '';
        }
        resolve();
      }, 100);
    };
    script.onerror = () => {
      stopObservingSettings();
      if (loadingExtensionName === name) {
        loadingExtensionName = '';
      }
      reject(new Error(`Could not load extension script: ${name}`));
    };
    loadingExtensionName = name;
    document.body.appendChild(script);
  });
}

export async function syncServerExtensionSettings() {
  const data = await loadJson<{ extension_settings?: Record<string, unknown> }>('/api/extensions/settings');
  if (data?.extension_settings && typeof data.extension_settings === 'object') {
    if (data.extension_settings.__dt_regex_store) {
      hydrateRegexStoreFromServer(data.extension_settings.__dt_regex_store);
    }
    Object.entries(data.extension_settings).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && extensionSettings[key] && typeof extensionSettings[key] === 'object') {
        extensionSettings[key] = { ...(extensionSettings[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
      } else {
        extensionSettings[key] = value;
      }
    });
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(extensionSettings));
  }
}

export async function syncSillyTavernExtensions() {
  ensureGlobals();
  await syncServerExtensionSettings();
  const discovered = await loadJson<Array<{ name: string; type: string }>>('/api/extensions/discover') ?? [];
  const manifests = await Promise.all(discovered.map(async (extension) => ({
    name: extension.name,
    manifest: await loadJson<ExtensionManifest>(`/scripts/extensions/${extension.name}/manifest.json`),
  })));

  const enabled = manifests
    .filter((item): item is { name: string; manifest: ExtensionManifest } => Boolean(item.manifest))
    .sort((a, b) => Number(a.manifest.loading_order ?? 100) - Number(b.manifest.loading_order ?? 100));

  let newlyLoaded = false;
  for (const extension of enabled) {
    const wasLoaded = loadedExtensionScripts.has(extension.name);
    loadStyle(extension.name, extension.manifest);
    try {
      await loadScript(extension.name, extension.manifest);
      if (!wasLoaded && loadedExtensionScripts.has(extension.name)) {
        newlyLoaded = true;
      }
    } catch (err) {
      console.warn('[extension:load-error]', extension.name, err);
    }
  }
  if (newlyLoaded) {
    await eventSource.emit(eventTypes.APP_READY);
    await eventSource.emit(eventTypes.CHAT_CHANGED);
  }
}

export async function initSillyTavernExtensions() {
  if (extensionsInitialized) {
    return;
  }
  extensionsInitialized = true;
  await syncSillyTavernExtensions();
  await eventSource.emit(eventTypes.APP_READY);
  await eventSource.emit(eventTypes.CHAT_CHANGED);
}

export async function emitSillyTavernChatChanged() {
  await eventSource.emit(eventTypes.CHAT_CHANGED);
}

export async function emitSillyTavernMessageRendered(index: number, role: RuntimeMessage['role']) {
  await eventSource.emit(role === 'user' ? eventTypes.MESSAGE_SENT : eventTypes.MESSAGE_RECEIVED, index);
  await eventSource.emit(role === 'user' ? eventTypes.USER_MESSAGE_RENDERED : eventTypes.CHARACTER_MESSAGE_RENDERED, index);
}

export async function emitSillyTavernMessageSwiped(index: number) {
  await eventSource.emit(eventTypes.MESSAGE_SWIPED, index);
}

export async function emitSillyTavernGenerationEvent(stage: 'started' | 'ended' | 'stopped') {
  const evt = stage === 'started' ? eventTypes.GENERATION_STARTED : stage === 'stopped' ? eventTypes.GENERATION_STOPPED : eventTypes.GENERATION_ENDED;
  await eventSource.emit(evt);
}
