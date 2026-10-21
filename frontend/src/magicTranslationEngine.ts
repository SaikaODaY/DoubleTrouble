/**
 * Built-in Magic Translation engine for DoubleTrouble.
 * Adapted from SillyTavern-Magic-Translation.
 */

export const languageCodes: Record<string, string> = {
  Afrikaans: 'af',
  Albanian: 'sq',
  Amharic: 'am',
  Arabic: 'ar',
  Armenian: 'hy',
  Azerbaijani: 'az',
  Basque: 'eu',
  Belarusian: 'be',
  Bengali: 'bn',
  Bosnian: 'bs',
  Bulgarian: 'bg',
  Catalan: 'ca',
  Cebuano: 'ceb',
  'Chinese (Simplified)': 'zh-CN',
  'Chinese (Traditional)': 'zh-TW',
  Corsican: 'co',
  Croatian: 'hr',
  Czech: 'cs',
  Danish: 'da',
  Dutch: 'nl',
  English: 'en',
  Esperanto: 'eo',
  Estonian: 'et',
  Finnish: 'fi',
  French: 'fr',
  Frisian: 'fy',
  Galician: 'gl',
  Georgian: 'ka',
  German: 'de',
  Greek: 'el',
  Gujarati: 'gu',
  'Haitian Creole': 'ht',
  Hausa: 'ha',
  Hawaiian: 'haw',
  Hebrew: 'iw',
  Hindi: 'hi',
  Hmong: 'hmn',
  Hungarian: 'hu',
  Icelandic: 'is',
  Igbo: 'ig',
  Indonesian: 'id',
  Irish: 'ga',
  Italian: 'it',
  Japanese: 'ja',
  Javanese: 'jw',
  Kannada: 'kn',
  Kazakh: 'kk',
  Khmer: 'km',
  Korean: 'ko',
  Kurdish: 'ku',
  Kyrgyz: 'ky',
  Lao: 'lo',
  Latin: 'la',
  Latvian: 'lv',
  Lithuanian: 'lt',
  Luxembourgish: 'lb',
  Macedonian: 'mk',
  Malagasy: 'mg',
  Malay: 'ms',
  Malayalam: 'ml',
  Maltese: 'mt',
  Maori: 'mi',
  Marathi: 'mr',
  Mongolian: 'mn',
  'Myanmar (Burmese)': 'my',
  Nepali: 'ne',
  Norwegian: 'no',
  'Nyanja (Chichewa)': 'ny',
  Pashto: 'ps',
  Persian: 'fa',
  Polish: 'pl',
  'Portuguese (Portugal)': 'pt-PT',
  'Portuguese (Brazil)': 'pt-BR',
  Punjabi: 'pa',
  Romanian: 'ro',
  Russian: 'ru',
  Samoan: 'sm',
  'Scots Gaelic': 'gd',
  Serbian: 'sr',
  Sesotho: 'st',
  Shona: 'sn',
  Sindhi: 'sd',
  'Sinhala (Sinhalese)': 'si',
  Slovak: 'sk',
  Slovenian: 'sl',
  Somali: 'so',
  Spanish: 'es',
  Sundanese: 'su',
  Swahili: 'sw',
  Swedish: 'sv',
  'Tagalog (Filipino)': 'tl',
  Tajik: 'tg',
  Tamil: 'ta',
  Telugu: 'te',
  Thai: 'th',
  Turkish: 'tr',
  Ukrainian: 'uk',
  Urdu: 'ur',
  Uzbek: 'uz',
  Vietnamese: 'vi',
  Welsh: 'cy',
  Xhosa: 'xh',
  Yiddish: 'yi',
  Yoruba: 'yo',
  Zulu: 'zu',
};

export type AutoMode = 'none' | 'responses' | 'inputs' | 'both';

export interface PromptPreset {
  content: string;
  filterCodeBlock: boolean;
}

export interface ConnectionProfile {
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
}

export interface MagicTranslationSettings {
  version: string;
  targetLanguage: string;
  internalLanguage: string;
  autoMode: AutoMode;
  promptPreset: string;
  promptPresets: Record<string, PromptPreset>;
  activeProfile: string;
  connectionProfiles: Record<string, ConnectionProfile>;
}

const VERSION = '0.1.1-dt';
const STORAGE_KEY = 'doubletrouble.magicTranslation.settings';

const DEFAULT_PROMPT = `# Task: Translate Text

You are an expert multilingual translator. Your task is to translate the user's text into {{language}} accurately, preserving the original markdown formatting.

## Context: Previous Messages
{{#each (slice chat -3)}}
**Message {{add @index 1}}:**
> {{this.name}}: {{this.mes}}

{{/each}}

## Perspective
{{name}}

## Text to Translate
\`\`\`
{{prompt}}
\`\`\`

## Instructions
1.  Translate the "Text to Translate" into **{{language}}**.
2.  Preserve all markdown formatting (headings, lists, bold, etc.).
3.  Your response **must** only contain the translated text, enclosed in a single markdown code block.

Important: Your response must follow this exact format with the translation enclosed in code blocks (\`\`\`).`;

export function getDefaultSettings(): MagicTranslationSettings {
  return {
    version: VERSION,
    targetLanguage: 'en',
    internalLanguage: 'en',
    autoMode: 'none',
    promptPreset: 'default',
    promptPresets: {
      default: { content: DEFAULT_PROMPT, filterCodeBlock: true },
    },
    activeProfile: '',
    connectionProfiles: {},
  };
}

export function loadMagicTranslationSettings(): MagicTranslationSettings {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    const defaults = getDefaultSettings();
    return {
      version: raw.version || defaults.version,
      targetLanguage: raw.targetLanguage || defaults.targetLanguage,
      internalLanguage: raw.internalLanguage || defaults.internalLanguage,
      autoMode: raw.autoMode || defaults.autoMode,
      promptPreset: raw.promptPreset || defaults.promptPreset,
      promptPresets: { ...defaults.promptPresets, ...(raw.promptPresets || {}) },
      activeProfile: raw.activeProfile || defaults.activeProfile,
      connectionProfiles: raw.connectionProfiles || defaults.connectionProfiles,
    };
  } catch {
    return getDefaultSettings();
  }
}

export function saveMagicTranslationSettings(settings: MagicTranslationSettings): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export async function translateText(
  text: string,
  settings: MagicTranslationSettings,
  chatContext: { name: string; mes: string }[] = [],
  messageName = 'User',
): Promise<string | null> {
  const preset = settings.promptPresets[settings.promptPreset];
  if (!preset) return null;

  const token = window.localStorage.getItem('doubletrouble.authToken') || window.localStorage.getItem('doubletrouble_auth_token') || '';
  const accessToken = window.localStorage.getItem('doubletrouble.accessToken') || '';
  const profile = settings.activeProfile ? settings.connectionProfiles[settings.activeProfile] : undefined;
  const response = await fetch('/api/magic-translation/translate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(accessToken ? { 'X-DoubleTrouble-Access': accessToken } : {}),
    },
    body: JSON.stringify({
      text,
      prompt: preset.content,
      target_language: Object.entries(languageCodes).find(([, code]) => code === settings.targetLanguage)?.[0] || 'English',
      filter_code_block: preset.filterCodeBlock,
      chat_context: chatContext,
      message_name: messageName,
      ...(profile ? {
        provider: profile.provider,
        base_url: profile.baseUrl,
        model: profile.model,
        api_key: profile.apiKey,
        temperature: profile.temperature,
        max_tokens: profile.maxTokens,
        timeout_seconds: profile.timeoutSeconds,
      } : {}),
    }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(data.detail || 'Translation failed');
  }

  const data = await response.json() as { ok?: boolean; text?: string };
  return data.ok ? (data.text || null) : null;
}
