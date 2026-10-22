/**
 * Built-in Regex engine for DoubleTrouble.
 * Adapted from SillyTavern's regex extension (engine.js + index.js core logic).
 */

// --- Types ---

export interface RegexScript {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: number;
  minDepth: number | null;
  maxDepth: number | null;
}

export interface RegexParams {
  characterOverride?: string;
  isMarkdown?: boolean;
  isPrompt?: boolean;
  isEdit?: boolean;
  depth?: number;
}

export interface RegexScriptParams {
  characterOverride?: string;
}

// --- Enums ---

export const SCRIPT_TYPES = {
  GLOBAL: 0,
  PRESET: 2,
  SCOPED: 1,
} as const;

export const SCRIPT_TYPE_UNKNOWN = -1;

export type ScriptType = (typeof SCRIPT_TYPES)[keyof typeof SCRIPT_TYPES];

export const regex_placement = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
} as const;

export const substitute_find_regex = {
  NONE: 0,
  RAW: 1,
  ESCAPED: 2,
} as const;

// --- Storage Keys ---

const GLOBAL_KEY = 'doubletrouble.regex.global';
const SCOPED_PREFIX = 'doubletrouble.regex.scoped.';
const PRESET_PREFIX = 'doubletrouble.regex.preset.';
const SCOPED_ALLOWED_KEY = 'doubletrouble.regex.scopedAllowed';
const PRESET_ALLOWED_KEY = 'doubletrouble.regex.presetAllowed';

// --- LRU Regex Cache ---

export class RegexProvider {
  private cache = new Map<string, RegExp>();
  private maxSize = 1000;

  static instance = new RegexProvider();

  get(regexString: string): RegExp | null {
    const isCached = this.cache.has(regexString);
    let regex: RegExp | undefined;

    try {
      regex = isCached ? this.cache.get(regexString) : regexFromString(regexString);
    } catch {
      return null;
    }

    if (!regex) {
      return null;
    }

    if (isCached) {
      this.cache.delete(regexString);
      this.cache.set(regexString, regex);
    } else {
      if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey !== undefined) {
          this.cache.delete(firstKey);
        }
      }
      this.cache.set(regexString, regex);
    }

    if (regex.global || regex.sticky) {
      regex.lastIndex = 0;
    }

    return regex;
  }

  clear() {
    this.cache.clear();
  }
}

// --- Storage Helpers ---

const storageCache = new Map<string, unknown>();

function loadArray<T>(key: string): T[] {
  if (storageCache.has(key)) {
    return storageCache.get(key) as T[];
  }
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as T[]) : [];
    storageCache.set(key, parsed);
    return parsed;
  } catch {
    return [];
  }
}
let suppressServerPush = false;
let pushRegexTimer: number | undefined;

function collectRegexStoreSnapshot(): Record<string, unknown> {
  const scoped: Record<string, unknown> = {};
  const preset: Record<string, unknown> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (!k) continue;
    if (k.startsWith(SCOPED_PREFIX)) {
      scoped[k.slice(SCOPED_PREFIX.length)] = loadArray(k);
    } else if (k.startsWith(PRESET_PREFIX)) {
      preset[k.slice(PRESET_PREFIX.length)] = loadArray(k);
    }
  }
  return {
    global: loadArray(GLOBAL_KEY),
    scoped,
    preset,
    scopedAllowed: loadArray(SCOPED_ALLOWED_KEY),
    presetAllowed: loadRaw(PRESET_ALLOWED_KEY) || {},
    presets: loadArray(PRESETS_KEY),
  };
}

function scheduleRegexServerPush() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('doubletrouble:regex-updated'));
  if (suppressServerPush) return;
  window.clearTimeout(pushRegexTimer);
  pushRegexTimer = window.setTimeout(() => {
    const token = window.localStorage.getItem('doubletrouble.authToken') || '';
    const access = window.localStorage.getItem('doubletrouble.accessToken') || '';
    void fetch('/api/extensions/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(access ? { 'X-DoubleTrouble-Access': access } : {}),
      },
      body: JSON.stringify({ extension_settings: { __dt_regex_store: collectRegexStoreSnapshot() }, merge: true }),
    }).catch(() => undefined);
  }, 250);
}

export function hydrateRegexStoreFromServer(rawStore: unknown) {
  if (!rawStore || typeof rawStore !== 'object' || Array.isArray(rawStore)) return;
  const store = rawStore as Record<string, unknown>;
  suppressServerPush = true;
  try {
    if (Array.isArray(store.global)) {
      window.localStorage.setItem(GLOBAL_KEY, JSON.stringify(store.global));
    }
    if (store.scoped && typeof store.scoped === 'object' && !Array.isArray(store.scoped)) {
      for (const [cardId, list] of Object.entries(store.scoped as Record<string, unknown>)) {
        if (Array.isArray(list)) {
          window.localStorage.setItem(`${SCOPED_PREFIX}${cardId}`, JSON.stringify(list));
        }
      }
    }
    if (store.preset && typeof store.preset === 'object' && !Array.isArray(store.preset)) {
      for (const [presetName, list] of Object.entries(store.preset as Record<string, unknown>)) {
        if (Array.isArray(list)) {
          window.localStorage.setItem(`${PRESET_PREFIX}${presetName}`, JSON.stringify(list));
        }
      }
    }
    if (Array.isArray(store.scopedAllowed)) {
      window.localStorage.setItem(SCOPED_ALLOWED_KEY, JSON.stringify(store.scopedAllowed));
    }
    if (store.presetAllowed && typeof store.presetAllowed === 'object') {
      window.localStorage.setItem(PRESET_ALLOWED_KEY, JSON.stringify(store.presetAllowed));
    }
    if (Array.isArray(store.presets)) {
      window.localStorage.setItem(PRESETS_KEY, JSON.stringify(store.presets));
    }
  } finally {
    suppressServerPush = false;
  }
  storageCache.clear();
  window.dispatchEvent(new CustomEvent('doubletrouble:regex-updated'));
}

function saveArray(key: string, value: unknown[]) {
  storageCache.set(key, value);
  window.localStorage.setItem(key, JSON.stringify(value));
  scheduleRegexServerPush();
}
export function getScriptsByType(scriptType: ScriptType | typeof SCRIPT_TYPE_UNKNOWN): RegexScript[] {
  if (scriptType === SCRIPT_TYPE_UNKNOWN) return [];
  switch (scriptType) {
    case SCRIPT_TYPES.GLOBAL:
      return loadArray<RegexScript>(GLOBAL_KEY);
    case SCRIPT_TYPES.SCOPED: {
      const cardId = getCurrentCardId();
      if (!cardId) return [];
      return loadArray<RegexScript>(`${SCOPED_PREFIX}${cardId}`);
    }
    case SCRIPT_TYPES.PRESET: {
      const presetName = getCurrentPresetName();
      if (!presetName) return [];
      return loadArray<RegexScript>(`${PRESET_PREFIX}${presetName}`);
    }
    default:
      return [];
  }
}

export function saveScriptsByType(scripts: RegexScript[], scriptType: ScriptType) {
  switch (scriptType) {
    case SCRIPT_TYPES.GLOBAL:
      saveArray(GLOBAL_KEY, scripts);
      break;
    case SCRIPT_TYPES.SCOPED: {
      const cardId = getCurrentCardId();
      if (cardId) {
        saveArray(`${SCOPED_PREFIX}${cardId}`, scripts);
      }
      break;
    }
    case SCRIPT_TYPES.PRESET: {
      const presetName = getCurrentPresetName();
      if (presetName) {
        saveArray(`${PRESET_PREFIX}${presetName}`, scripts);
      }
      break;
    }
  }
}

export function getRegexScripts(options: { allowedOnly?: boolean } = {}): RegexScript[] {
  const types = [SCRIPT_TYPES.GLOBAL, SCRIPT_TYPES.SCOPED, SCRIPT_TYPES.PRESET] as const;
  const all = types.flatMap((type) => getScriptsByType(type));
  if (!options.allowedOnly) return all;

  const allowedScoped = isScopedScriptsAllowed();
  const allowedPreset = isPresetScriptsAllowed();

  return all.filter((script) => {
    const type = getScriptType(script);
    if (type === SCRIPT_TYPES.SCOPED && !allowedScoped) return false;
    if (type === SCRIPT_TYPES.PRESET && !allowedPreset) return false;
    return true;
  });
}

export function getScriptType(script: RegexScript): ScriptType | typeof SCRIPT_TYPE_UNKNOWN {
  for (const type of [SCRIPT_TYPES.GLOBAL, SCRIPT_TYPES.SCOPED, SCRIPT_TYPES.PRESET] as const) {
    const list = getScriptsByType(type);
    if (list.some((s) => s.id === script.id)) return type;
  }
  return SCRIPT_TYPE_UNKNOWN;
}

// --- Scoped / Preset Allow Helpers ---

export function isScopedScriptsAllowed(): boolean {
  const cardId = getCurrentCardId();
  if (!cardId) return false;
  const allowed = loadArray<string>(SCOPED_ALLOWED_KEY);
  return allowed.includes(cardId);
}

export function allowScopedScripts() {
  const cardId = getCurrentCardId();
  if (!cardId) return;
  const allowed = loadArray<string>(SCOPED_ALLOWED_KEY);
  if (!allowed.includes(cardId)) {
    allowed.push(cardId);
    saveArray(SCOPED_ALLOWED_KEY, allowed);
  }
}

export function disallowScopedScripts() {
  const cardId = getCurrentCardId();
  if (!cardId) return;
  const allowed = loadArray<string>(SCOPED_ALLOWED_KEY);
  const index = allowed.indexOf(cardId);
  if (index !== -1) {
    allowed.splice(index, 1);
    saveArray(SCOPED_ALLOWED_KEY, allowed);
  }
}

export function isPresetScriptsAllowed(): boolean {
  const presetName = getCurrentPresetName();
  if (!presetName) return false;
  const allowed: Record<string, string[]> = (loadRaw(PRESET_ALLOWED_KEY) as Record<string, string[]>) || {};
  const apiId = getCurrentPresetAPI();
  return Boolean(allowed[apiId]?.includes(presetName));
}

export function allowPresetScripts() {
  const presetName = getCurrentPresetName();
  if (!presetName) return;
  const allowed: Record<string, string[]> = (loadRaw(PRESET_ALLOWED_KEY) as Record<string, string[]>) || {};
  const apiId = getCurrentPresetAPI();
  if (!allowed[apiId]) allowed[apiId] = [];
  if (!allowed[apiId].includes(presetName)) {
    allowed[apiId].push(presetName);
    saveRaw(PRESET_ALLOWED_KEY, allowed);
  }
}

export function disallowPresetScripts() {
  const presetName = getCurrentPresetName();
  if (!presetName) return;
  const allowed: Record<string, string[]> = (loadRaw(PRESET_ALLOWED_KEY) as Record<string, string[]>) || {};
  const apiId = getCurrentPresetAPI();
  if (!allowed[apiId]) return;
  const index = allowed[apiId].indexOf(presetName);
  if (index !== -1) {
    allowed[apiId].splice(index, 1);
    saveRaw(PRESET_ALLOWED_KEY, allowed);
  }
}

// --- Context accessors (populated by App) ---

let currentCardId = '';
let currentPresetName = '';
let currentPresetAPI = 'openai'; // default api id

export function setRegexContext(cardId: string, presetName: string, presetAPI: string) {
  currentCardId = cardId;
  currentPresetName = presetName;
  currentPresetAPI = presetAPI;
}

function getCurrentCardId(): string {
  return currentCardId;
}

function getCurrentPresetName(): string {
  return currentPresetName;
}

function getCurrentPresetAPI(): string {
  return currentPresetAPI;
}

// --- Utils ---

function loadRaw(key: string): unknown {
  if (storageCache.has(key)) {
    return storageCache.get(key);
  }
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    storageCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function saveRaw(key: string, value: unknown) {
  storageCache.set(key, value);
  window.localStorage.setItem(key, JSON.stringify(value));
  scheduleRegexServerPush();
}

export function regexFromString(str: string): RegExp {
  const match = str.match(/^\/(.*)\/([gimuy]*)$/);
  if (match) {
    return new RegExp(match[1], match[2]);
  }
  return new RegExp(str);
}

function substituteParams(text: string, overrides?: Record<string, string>): string {
  let result = text;
  const user = overrides?.user || getContextUserName();
  const char = overrides?.char || getContextCharName();
  result = result.replace(/\{\{user\}\}/g, user);
  result = result.replace(/\{\{char\}\}/g, char);
  result = result.replace(/\{user\}/g, user);
  result = result.replace(/\{char\}/g, char);
  return result;
}

function substituteParamsExtended(
  text: string,
  overrides?: Record<string, string>,
  macroEscaper?: (x: string) => string,
): string {
  let result = text;
  const user = overrides?.user || getContextUserName();
  const char = overrides?.char || getContextCharName();
  if (macroEscaper) {
    result = result.replace(/\{\{user\}\}/g, macroEscaper(user));
    result = result.replace(/\{\{char\}\}/g, macroEscaper(char));
    result = result.replace(/\{user\}/g, macroEscaper(user));
    result = result.replace(/\{char\}/g, macroEscaper(char));
  } else {
    result = result.replace(/\{\{user\}\}/g, user);
    result = result.replace(/\{\{char\}\}/g, char);
    result = result.replace(/\{user\}/g, user);
    result = result.replace(/\{char\}/g, char);
  }
  return result;
}

function sanitizeRegexMacro(x: string): string {
  if (x && typeof x === 'string') {
    return x.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (s) => {
      switch (s) {
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        case '\t':
          return '\\t';
        case '\v':
          return '\\v';
        case '\f':
          return '\\f';
        case '\0':
          return '\\0';
        default:
          return '\\' + s;
      }
    });
  }
  return x;
}

// Runtime names injected by App.tsx
let contextUserName = 'Player';
let contextCharName = 'Bot';

export function setRegexNames(userName: string, charName: string) {
  contextUserName = userName;
  contextCharName = charName;
}

function getContextUserName(): string {
  return contextUserName;
}

function getContextCharName(): string {
  return contextCharName;
}

// --- Core Functions ---

export function getRegexedString(rawString: string, placement: number, params: RegexParams = {}): string {
  if (typeof rawString !== 'string') {
    console.warn('getRegexedString: rawString is not a string. Returning empty string.');
    return '';
  }

  let finalString = rawString;
  if (!rawString || placement === undefined) {
    return finalString;
  }

  const allRegex = getRegexScripts({ allowedOnly: true });
  allRegex.forEach((script) => {
    if (
      (script.markdownOnly && params.isMarkdown) ||
      (script.promptOnly && params.isPrompt) ||
      (!script.markdownOnly && !script.promptOnly && !params.isMarkdown && !params.isPrompt)
    ) {
      if (params.isEdit && !script.runOnEdit) {
        console.debug(`getRegexedString: Skipping script ${script.scriptName} because it does not run on edit`);
        return;
      }

      if (typeof params.depth === 'number') {
        if (!isNaN(script.minDepth ?? NaN) && script.minDepth !== null && script.minDepth >= -1 && params.depth < script.minDepth) {
          console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${params.depth} is less than minDepth ${script.minDepth}`);
          return;
        }
        if (!isNaN(script.maxDepth ?? NaN) && script.maxDepth !== null && script.maxDepth >= 0 && params.depth > script.maxDepth) {
          console.debug(`getRegexedString: Skipping script ${script.scriptName} because depth ${params.depth} is greater than maxDepth ${script.maxDepth}`);
          return;
        }
      }

      if (script.placement.includes(placement)) {
        finalString = runRegexScript(script, finalString, { characterOverride: params.characterOverride });
      }
    }
  });

  return finalString;
}

export function runRegexScript(regexScript: RegexScript, rawString: string, params: RegexScriptParams = {}): string {
  let newString = rawString;
  if (!regexScript || regexScript.disabled || !regexScript.findRegex || !rawString) {
    return newString;
  }

  const getRegexString = (): string => {
    switch (Number(regexScript.substituteRegex)) {
      case substitute_find_regex.NONE:
        return regexScript.findRegex;
      case substitute_find_regex.RAW:
        return substituteParamsExtended(regexScript.findRegex);
      case substitute_find_regex.ESCAPED:
        return substituteParamsExtended(regexScript.findRegex, {}, sanitizeRegexMacro);
      default:
        console.warn(`runRegexScript: Unknown substituteRegex value ${regexScript.substituteRegex}. Using raw regex.`);
        return regexScript.findRegex;
    }
  };

  const regexString = getRegexString();
  const findRegex = RegexProvider.instance.get(regexString);

  if (!findRegex) {
    return newString;
  }

  newString = rawString.replace(findRegex, function (match: string) {
    const args = [...arguments] as unknown[];
    let replaceString = regexScript.replaceString.replace(/\{\{match\}\}/gi, '$0');
    replaceString = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
      let matched: string | undefined;
      if (num) {
        matched = args[Number(num)] as string;
      } else if (groupName) {
        const groups = args[args.length - 1];
        if (groups && typeof groups === 'object') {
          matched = (groups as Record<string, string>)[groupName];
        }
      }
      if (!matched) {
        return '';
      }
      return filterString(matched, regexScript.trimStrings, { characterOverride: params.characterOverride });
    });

    return substituteParams(replaceString, { user: getContextUserName(), char: getContextCharName() });
  });

  return newString;
}

function filterString(rawString: string, trimStrings: string[], params: RegexScriptParams = {}): string {
  let finalString = rawString;
  trimStrings.forEach((trimString) => {
    const subTrimString = substituteParams(trimString, { user: getContextUserName(), char: getContextCharName() });
    finalString = finalString.replaceAll(subTrimString, '');
  });
  return finalString;
}

// --- Import / Export helpers ---

function makeRegexId(): string {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `regex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRegexScript(raw: unknown): RegexScript | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.findRegex !== 'string' && typeof obj.scriptName !== 'string' && typeof obj.replaceString !== 'string') {
    return null;
  }
  const placementRaw = Array.isArray(obj.placement) ? obj.placement.map((v) => Number(v)).filter((v) => Number.isFinite(v)) : [regex_placement.AI_OUTPUT];
  const trimRaw = Array.isArray(obj.trimStrings)
    ? obj.trimStrings.map((s) => String(s))
    : typeof obj.trimStrings === 'string' && obj.trimStrings.trim()
      ? obj.trimStrings.split('\n')
      : [];
  return {
    id: typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : makeRegexId(),
    scriptName: typeof obj.scriptName === 'string' ? obj.scriptName : (typeof obj.name === 'string' ? obj.name : 'Imported Regex'),
    findRegex: typeof obj.findRegex === 'string' ? obj.findRegex : '',
    replaceString: typeof obj.replaceString === 'string' ? obj.replaceString : '',
    trimStrings: trimRaw,
    placement: placementRaw.length ? placementRaw : [regex_placement.AI_OUTPUT],
    disabled: Boolean(obj.disabled),
    markdownOnly: Boolean(obj.markdownOnly),
    promptOnly: Boolean(obj.promptOnly),
    runOnEdit: Boolean(obj.runOnEdit),
    substituteRegex: Number.isFinite(Number(obj.substituteRegex)) ? Number(obj.substituteRegex) : substitute_find_regex.NONE,
    minDepth: obj.minDepth === null || obj.minDepth === undefined || obj.minDepth === '' ? null : Number(obj.minDepth),
    maxDepth: obj.maxDepth === null || obj.maxDepth === undefined || obj.maxDepth === '' ? null : Number(obj.maxDepth),
  };
}

export function exportRegexScript(script: RegexScript): string {
  return JSON.stringify(script, null, 4);
}

export function importRegexScriptsFromJson(json: string): RegexScript[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeRegexScript).filter((s): s is RegexScript => s !== null);
    }
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      const single = normalizeRegexScript(rec);
      if (single) {
        return [single];
      }
      if (Array.isArray(rec.regex_scripts)) {
        return rec.regex_scripts.map(normalizeRegexScript).filter((s): s is RegexScript => s !== null);
      }
      const ext = rec.extensions as Record<string, unknown> | undefined;
      if (ext && Array.isArray(ext.regex_scripts)) {
        return ext.regex_scripts.map(normalizeRegexScript).filter((s): s is RegexScript => s !== null);
      }
      const data = rec.data as Record<string, unknown> | undefined;
      const dataExt = data?.extensions as Record<string, unknown> | undefined;
      if (dataExt && Array.isArray(dataExt.regex_scripts)) {
        return dataExt.regex_scripts.map(normalizeRegexScript).filter((s): s is RegexScript => s !== null);
      }
      const presetList = [
        ...(Array.isArray(rec.global) ? rec.global : []),
        ...(Array.isArray(rec.scoped) ? rec.scoped : []),
        ...(Array.isArray(rec.preset) ? rec.preset : []),
      ];
      if (presetList.length) {
        return presetList.map(normalizeRegexScript).filter((s): s is RegexScript => s !== null);
      }
    }
    return [];
  } catch {
    return [];
  }
}

export function importRegexScript(json: string): RegexScript | null {
  const list = importRegexScriptsFromJson(json);
  return list[0] || null;
}

export function createEmptyRegexScript(): RegexScript {
  return {
    id: makeRegexId(),
    scriptName: '',
    findRegex: '',
    replaceString: '',
    trimStrings: [],
    placement: [regex_placement.AI_OUTPUT],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: substitute_find_regex.NONE,
    minDepth: null,
    maxDepth: null,
  };
}

// --- Preset Manager ---

export interface RegexPreset {
  id: string;
  name: string;
  global: RegexScript[];
  scoped: RegexScript[];
  preset: RegexScript[];
}

const PRESETS_KEY = 'doubletrouble.regex.presets';

export function getRegexPresets(): RegexPreset[] {
  return loadArray<RegexPreset>(PRESETS_KEY);
}

export function saveRegexPresets(presets: RegexPreset[]) {
  saveArray(PRESETS_KEY, presets);
}

export function createEmptyRegexPreset(): RegexPreset {
  return {
    id: makeRegexId(),
    name: '',
    global: [],
    scoped: [],
    preset: [],
  };
}

export function applyRegexPreset(presetId: string): boolean {
  const preset = getRegexPresets().find((p) => p.id === presetId);
  if (!preset) return false;
  saveArray(GLOBAL_KEY, preset.global);
  const cardId = getCurrentCardId();
  if (cardId) saveArray(`${SCOPED_PREFIX}${cardId}`, preset.scoped);
  const presetName = getCurrentPresetName();
  if (presetName) saveArray(`${PRESET_PREFIX}${presetName}`, preset.preset);
  return true;
}

export function saveRegexPreset(preset: RegexPreset): boolean {
  const presets = getRegexPresets();
  const index = presets.findIndex((p) => p.id === preset.id);
  if (index >= 0) {
    presets[index] = preset;
  } else {
    presets.push(preset);
  }
  saveRegexPresets(presets);
  return true;
}

export function deleteRegexPreset(presetId: string): boolean {
  const presets = getRegexPresets().filter((p) => p.id !== presetId);
  saveRegexPresets(presets);
  return true;
}

export function exportRegexPreset(preset: RegexPreset): string {
  return JSON.stringify(preset, null, 4);
}

export function importRegexPreset(json: string, fallbackName = 'Imported Regex'): RegexPreset | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (Array.isArray(parsed.global) || Array.isArray(parsed.scoped) || Array.isArray(parsed.preset))) {
      return {
        id: typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id : makeRegexId(),
        name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : fallbackName,
        global: Array.isArray(parsed.global) ? parsed.global.map(normalizeRegexScript).filter((s): s is RegexScript => s !== null) : [],
        scoped: Array.isArray(parsed.scoped) ? parsed.scoped.map(normalizeRegexScript).filter((s): s is RegexScript => s !== null) : [],
        preset: Array.isArray(parsed.preset) ? parsed.preset.map(normalizeRegexScript).filter((s): s is RegexScript => s !== null) : [],
      };
    }
    const scripts = importRegexScriptsFromJson(json);
    if (scripts.length) {
      return {
        id: makeRegexId(),
        name: scripts[0]?.scriptName || fallbackName,
        global: scripts,
        scoped: [],
        preset: [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

if (typeof window !== 'undefined') {
  (window as typeof window & { DoubleTroubleRegex?: unknown }).DoubleTroubleRegex = {
    regex_placement,
    getRegexedString,
    runRegexScript,
  };
}
