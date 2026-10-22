import { Fragment, memo, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { emitSillyTavernChatChanged, emitSillyTavernGenerationEvent, emitSillyTavernMessageRendered, emitSillyTavernMessageSwiped, executeExtensionSlashCommand, formatExtensionMessageHtml, getActiveExtensionPrompts, initSillyTavernExtensions, syncServerExtensionSettings, syncSillyTavernExtensions, updateSillyTavernExtensionSettings, updateSillyTavernRuntime, type ExtensionMessageFormatOptions } from './sillyTavernExtensions';
import { allowScopedScripts, getRegexedString, getRegexScripts, regex_placement, saveScriptsByType, SCRIPT_TYPES, setRegexContext, setRegexNames, type RegexScript } from './regexEngine';
import { RegexSettingsPortal } from './RegexSettings';
import { MagicTranslationSettingsPortal } from './MagicTranslationSettings';
import { loadMagicTranslationSettings, translateText } from './magicTranslationEngine';
import { useLocaleContext, type Language } from './localization';

type MenuSection = 'presets' | 'connection' | 'visual' | 'personas' | 'security' | 'lorebooks' | 'cards' | 'extensions';
type IconName = 'sliders' | 'plug' | 'palette' | 'user' | 'card' | 'book' | 'bot' | 'lock' | 'key' | 'menu' | 'send' | 'edit' | 'trash' | 'eye' | 'eyeOff' | 'check' | 'x';
type ThemeId = 'midnight' | 'parchment' | 'abyss' | 'forest' | 'ocean' | 'plum' | 'ember' | 'aurora' | 'rose' | 'slate' | 'noir' | 'cyberpunk' | 'dracula' | 'nord' | 'coffee' | 'porcelain' | 'mint' | 'lavender' | 'solar' | 'sand' | 'linen' | 'cloud' | 'buttercream' | 'seashell' | 'morning' | 'paper';
type VisualSettings = {
  theme: ThemeId;
  textScale: 'tiny' | 'small' | 'normal' | 'large' | 'huge';
  density: 'compact' | 'comfortable' | 'spacious';
  messageWidth: 'narrow' | 'standard' | 'wide';
  radius: 'sharp' | 'soft' | 'round';
  motion: boolean;
  highContrast: boolean;
  showAvatars: boolean;
  stickyComposer: boolean;
  gradients: boolean;
  glass: boolean;
  texture: boolean;
  panelShadows: boolean;
  messageTint: boolean;
  backgroundVignette: boolean;
};

type CharacterCard = {
  id: string;
  filename: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_message: string;
  alternate_greetings: string[];
  message_example: string;
  creator: string;
  tags: string[];
  spec: string;
  spec_version: string;
  image_url: string;
};

type CardDraft = {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  alternateGreetings: string[];
  messageExample: string;
  creator: string;
  tags: string;
};

type Persona = {
  id: string;
  name: string;
  description: string;
  avatar: string;
  avatar_url: string;
  active: boolean;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  author: string;
  participant_id: string;
  avatar_url: string;
  username: string;
  is_admin: boolean;
  content: string;
  display_text: string;
  hidden: boolean;
  is_ooc?: boolean;
  is_secret?: boolean;
  secret_revealed?: boolean;
  is_dice_roll?: boolean;
  dice_data?: {
    formula?: string;
    rolls?: number[];
    modifier?: number;
    total?: number;
    label?: string;
    dc?: number | null;
    success?: boolean | null;
  };
  swipes?: string[];
  active_swipe_index?: number;
  swipe_votes?: Record<string, string[]>;
  created_at: string;
  updated_at: string;
};

type PartyHudPlayer = {
  name: string;
  hp: string;
  status: string;
  inventory: string;
};

type PartyHudState = {
  enabled: boolean;
  location: string;
  time_of_day: string;
  quest: string;
  notes: string;
  players: PartyHudPlayer[];
};

type SummaryMemorySettings = {
  enabled: boolean;
  auto_summarize: boolean;
  every_n_messages: number;
  use_separate_api: boolean;
  provider: string;
  chat_completion_source: string;
  base_url: string;
  model: string;
  api_key: string;
  clear_api_key: boolean;
  api_key_configured?: boolean;
  temperature: number;
  max_tokens: number;
  prompt: string;
};

type RoomInfo = {
  id: string;
  title: string;
  online_count: number;
  online_players: string[];
  active_card_id: string;
  active_chat_id: string;
  turn_mode: string;
};

type BotChatSummary = {
  id: string;
  title: string;
  filename: string;
  message_count: number;
  created_at: string;
  updated_at: string;
};

type BotChat = BotChatSummary & {
  card_id: string;
  character_name: string;
  messages: ChatMessage[];
  party_hud?: PartyHudState;
  memory_summary?: string;
  memory_summarized_count?: number;
  last_summarized_at?: string;
  parent_chat_id?: string;
  branched_from_message_id?: string;
};
type GenerationSettings = {
  provider: string;
  chat_completion_source: string;
  base_url: string;
  model: string;
  bot_name: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  timeout_seconds: number;
  api_key: string;
  clear_api_key: boolean;
  api_key_configured?: boolean;
  reverse_proxy: string;
  proxy_password: string;
  clear_proxy_password: boolean;
  proxy_password_configured?: boolean;
  source_settings: Record<string, Record<string, unknown>>;
  parameters: Record<string, unknown>;
};

type ConnectionPreset = Omit<GenerationSettings, 'api_key' | 'clear_api_key' | 'api_key_configured' | 'proxy_password' | 'clear_proxy_password' | 'proxy_password_configured' | 'bot_name'> & {
  name: string;
};

type ChatCompletionSourceMeta = {
  id: string;
  label: string;
  default_base_url: string;
  adapter: 'openai' | 'anthropic' | 'google_ai_studio';
  requires_api_key: boolean;
  supports_reverse_proxy: boolean;
  custom_url_field: boolean;
  extra_field_keys: string[];
  extra_param_keys: string[];
  secret_key_name: string;
  api_key_env: string;
};

type PresetTypeInfo = {
  id: string;
  label: string;
  directory: string;
};

type PresetSummary = {
  name: string;
  filename: string;
  type: string;
  updated_at: number;
};

type ExtensionSummary = {
  name: string;
  external_name: string;
  type: string;
  enabled: boolean;
  source: string;
  manifest: {
    display_name?: string;
    author?: string;
    version?: string;
    loading_order?: number | string;
    homePage?: string;
  };
  installed_at: string;
  updated_at: string;
};

type ManagedKeySummary = {
  id: string;
  name: string;
  label: string;
  configured: boolean;
  masked: string;
  active: boolean;
  env_name: string;
  env_configured: boolean;
};

type LorebookBinding = { book: string; target_type: 'global' | 'card' | 'chat' | 'persona'; target_id: string };
type LorebookSummary = { name: string; filename: string; entry_count: number; updated_at: number; bindings: LorebookBinding[] };

type Participant = {
  id: string;
  name: string;
  role: string;
  connected: boolean;
  connected_at?: string;
  persona_id: string;
  persona_name: string;
  avatar_url: string;
  username: string;
  is_admin: boolean;
};

type GenerationParticipant = {
  persona_id: string;
  persona_name: string;
  persona_description: string;
  participant_id?: string;
  username?: string;
};

type AuthUser = {
  username: string;
  is_admin: boolean;
};

type PermissionMode = 'everyone' | 'admins' | 'users';
type PermissionRule = { mode: PermissionMode; users: string[] };
type SecurityPermissions = Record<string, PermissionRule>;
type AccessDeniedState = { cards: boolean; personas: boolean; chats: boolean; presets: boolean; lorebooks: boolean };
type DeletionLocks = { cards: string[]; personas: string[]; chats: string[] };
type BuiltInExtensionSettings = { noriMynInfoblock: boolean; magicTranslation: boolean };
type ImageExtensionSettings = { apiType: string; endpoint: string; model: string; apiKey: string };
type ImageEndpointPreset = { name: string; apiType: string; endpoint: string; model: string };
type ImageKeyRecord = { id: string; name: string; value: string; active: boolean };

type ToastMessage = {
  id: string;
  message: string;
};

type RealtimePayload = {
  type?: string;
  card_id?: string;
  chat_id?: string;
  chat?: BotChat;
  switch_active?: boolean;
  active_generations?: string[];
  session?: {
    participants?: Record<string, Participant>;
    active_card_id?: string;
    active_chat_id?: string;
    turn?: { current_participant_id?: string | null; order?: string[]; mode?: string; ready_participant_ids?: string[] };
  };
  participant_id?: string;
  trigger_participant_id?: string;
  name?: string;
  is_typing?: boolean;
  turn_mode?: string;
  ready?: boolean;
  message?: string;
  message_id?: string;
  replace_message_id?: string | null;
  source_participant_id?: string;
  section?: string;
  auth_required?: boolean;
  registration_allowed?: boolean;
  bot_reply_allowed?: boolean;
  access_password_required?: boolean;
  access_password_configured?: boolean;
  permissions?: SecurityPermissions;
  delete_locks?: DeletionLocks;
};

type RawPreset = Record<string, unknown>;

const imagePendingKey = (cardId: string, chatId: string, messageId: string) => `${cardId}:${chatId}:${messageId}`;
const extensionMessageSignature = (message: ChatMessage) => `${message.role}:${message.active_swipe_index ?? 0}:${message.content}`;

type OpenAiPrompt = RawPreset & {
  identifier?: string;
  name?: string;
  role?: string;
  content?: string;
  marker?: boolean;
  system_prompt?: boolean;
  injection_position?: number | string;
  injection_depth?: number | string;
  injection_order?: number | string;
  injection_trigger?: unknown;
  forbid_overrides?: boolean;
};

type PromptOrderItem = {
  identifier: string;
  enabled: boolean;
};

type ReasoningDisplaySettings = {
  autoParse: boolean;
  autoExpand: boolean;
  showHidden: boolean;
  addToPrompts: boolean;
  maxAdditions: number;
  prefix: string;
  suffix: string;
  separator: string;
};

type NoricoreScene = { location: string; weather: string; date: string; time: string };
type NoricoreCharacter = { name: string; status: string; outfit: string; health: string; mood: string; feelings: string; thoughts: string };
type NoricoreData = { scene: NoricoreScene | null; characters: NoricoreCharacter[] };

function getMenuItems(t: (key: string) => string): Array<{ id: MenuSection; label: string; icon: IconName; description: string }> {
  return [
    { id: 'presets', label: t('menu.presets'), icon: 'sliders', description: t('menu.presets.desc') },
    { id: 'connection', label: t('menu.connection'), icon: 'plug', description: t('menu.connection.desc') },
    { id: 'visual', label: t('menu.visual'), icon: 'palette', description: t('menu.visual.desc') },
    { id: 'cards', label: t('menu.cards'), icon: 'card', description: t('menu.cards.desc') },
    { id: 'personas', label: t('menu.personas'), icon: 'user', description: t('menu.personas.desc') },
    { id: 'lorebooks', label: t('menu.lorebooks'), icon: 'book', description: t('menu.lorebooks.desc') },
    { id: 'extensions', label: t('menu.extensions'), icon: 'plug', description: t('menu.extensions.desc') },
    { id: 'security', label: t('menu.security'), icon: 'lock', description: t('menu.security.desc') },
  ];
}

const VISUAL_STORAGE_KEY = 'doubletrouble.visualSettings';
const SELECTED_PERSONA_STORAGE_KEY = 'doubletrouble.selectedPersonaId';
const BUILT_IN_EXTENSIONS_STORAGE_KEY = 'doubletrouble.builtInExtensions';
const PARTICIPANT_STORAGE_KEY = 'doubletrouble.participantId';
const LAST_CARD_STORAGE_KEY = 'doubletrouble.lastCardId';
const LAST_CHAT_BY_CARD_STORAGE_KEY = 'doubletrouble.lastChatByCard';
const AUTH_TOKEN_STORAGE_KEY = 'doubletrouble.authToken';
const ACCESS_TOKEN_STORAGE_KEY = 'doubletrouble.accessToken';
const AUTH_USERNAME_STORAGE_KEY = 'doubletrouble.lastUsername';
const OPENAI_PROMPT_ORDER_CHARACTER_ID = 100001;

function getPermissionLabels(t: (key: string) => string): Record<string, string> {
  return {
    view_cards: t('permissions.viewCards'),
    view_personas: t('permissions.viewPersonas'),
    view_chats: t('permissions.viewChats'),
    view_presets: t('permissions.viewPresets'),
    view_lorebooks: t('permissions.viewLorebooks'),
    edit_cards: t('permissions.editCards'),
    delete_cards: t('permissions.deleteCards'),
    edit_personas: t('permissions.editPersonas'),
    delete_personas: t('permissions.deletePersonas'),
    manage_chats: t('permissions.manageChats'),
    edit_messages: t('permissions.editMessages'),
    delete_messages: t('permissions.deleteMessages'),
    generate: t('permissions.generate'),
    manage_presets: t('permissions.managePresets'),
    manage_lorebooks: t('permissions.manageLorebooks'),
    manage_extensions: t('permissions.manageExtensions'),
    manage_keys: t('permissions.manageKeys'),
    manage_security: t('permissions.manageSecurity'),
  };
}

const defaultSecurityPermissionKeys = ['view_cards', 'view_personas', 'view_chats', 'view_presets', 'view_lorebooks', 'edit_cards', 'delete_cards', 'edit_personas', 'delete_personas', 'manage_chats', 'edit_messages', 'delete_messages', 'generate', 'manage_presets', 'manage_lorebooks', 'manage_extensions', 'manage_keys', 'manage_security'];
const defaultSecurityPermissions: SecurityPermissions = Object.fromEntries(defaultSecurityPermissionKeys.map((key) => [key, { mode: key === 'manage_security' || key === 'manage_keys' ? 'admins' : 'everyone', users: [] }])) as SecurityPermissions;
const defaultDeletionLocks: DeletionLocks = { cards: [], personas: [], chats: [] };
const defaultBuiltInExtensionSettings: BuiltInExtensionSettings = { noriMynInfoblock: true, magicTranslation: true };
const defaultImageExtensionSettings: ImageExtensionSettings = { apiType: 'openai', endpoint: '', model: '', apiKey: '' };
const EXTENSION_SETTINGS_STORAGE_KEY = 'doubletrouble.sillyTavernExtensionSettings';
const IMAGE_ENDPOINTS_STORAGE_KEY = 'doubletrouble.imageEndpoints';
const IMAGE_KEYS_STORAGE_KEY = 'doubletrouble.imageKeys';

const emptyCardDraft: CardDraft = { name: '', description: '', personality: '', scenario: '', firstMessage: '', alternateGreetings: [], messageExample: '', creator: '', tags: '' };

const chatCompletionSources: ChatCompletionSourceMeta[] = [
  { id: 'openai', label: 'OpenAI', default_base_url: 'https://api.openai.com/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: true, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'frequency_penalty', 'presence_penalty', 'seed', 'reasoning_effort', 'verbosity'], secret_key_name: 'provider_api_key_openai', api_key_env: 'OPENAI_API_KEY' },
  { id: 'claude', label: 'Claude (Anthropic)', default_base_url: 'https://api.anthropic.com/v1', adapter: 'anthropic', requires_api_key: true, supports_reverse_proxy: true, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'top_k'], secret_key_name: 'provider_api_key_claude', api_key_env: 'ANTHROPIC_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', default_base_url: 'https://openrouter.ai/api/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: ['openrouter_providers', 'openrouter_quantizations', 'openrouter_middleout', 'openrouter_use_fallback'], extra_param_keys: ['top_p', 'top_k', 'min_p', 'top_a', 'repetition_penalty', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_openrouter', api_key_env: 'OPENROUTER_API_KEY' },
  { id: 'ai21', label: 'AI21', default_base_url: 'https://api.ai21.com/studio/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p'], secret_key_name: 'provider_api_key_ai21', api_key_env: 'AI21_API_KEY' },
  { id: 'makersuite', label: 'Google AI Studio (Gemini)', default_base_url: 'https://generativelanguage.googleapis.com', adapter: 'google_ai_studio', requires_api_key: true, supports_reverse_proxy: true, custom_url_field: false, extra_field_keys: ['google_safety_off', 'google_use_sysprompt'], extra_param_keys: ['top_p', 'top_k', 'thinking_budget'], secret_key_name: 'provider_api_key_makersuite', api_key_env: 'GOOGLE_API_KEY' },
  { id: 'vertexai', label: 'Google Vertex AI', default_base_url: 'https://us-central1-aiplatform.googleapis.com', adapter: 'google_ai_studio', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: ['vertexai_region', 'vertexai_express_project_id', 'vertexai_auth_mode'], extra_param_keys: ['top_p', 'top_k', 'thinking_budget'], secret_key_name: 'provider_api_key_vertexai', api_key_env: 'GOOGLE_API_KEY' },
  { id: 'mistralai', label: 'MistralAI', default_base_url: 'https://api.mistral.ai/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: true, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p'], secret_key_name: 'provider_api_key_mistralai', api_key_env: 'MISTRAL_API_KEY' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', default_base_url: '', adapter: 'openai', requires_api_key: false, supports_reverse_proxy: false, custom_url_field: true, extra_field_keys: ['custom_include_headers', 'custom_include_body', 'custom_exclude_body'], extra_param_keys: ['top_p', 'top_k', 'min_p', 'top_a', 'repetition_penalty', 'frequency_penalty', 'presence_penalty', 'seed'], secret_key_name: 'provider_api_key_custom', api_key_env: 'DOUBLE_TROUBLE_API_KEY' },
  { id: 'cohere', label: 'Cohere', default_base_url: 'https://api.cohere.ai/v2', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'top_k', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_cohere', api_key_env: 'COHERE_API_KEY' },
  { id: 'perplexity', label: 'Perplexity', default_base_url: 'https://api.perplexity.ai', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'top_k', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_perplexity', api_key_env: 'PERPLEXITY_API_KEY' },
  { id: 'groq', label: 'Groq', default_base_url: 'https://api.groq.com/openai/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_groq', api_key_env: 'GROQ_API_KEY' },
  { id: 'electronhub', label: 'Electron Hub', default_base_url: 'https://api.electronhub.ai/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_electronhub', api_key_env: 'ELECTRONHUB_API_KEY' },
  { id: 'chutes', label: 'Chutes', default_base_url: 'https://llm.chutes.ai/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'top_k', 'min_p', 'repetition_penalty'], secret_key_name: 'provider_api_key_chutes', api_key_env: 'CHUTES_API_KEY' },
  { id: 'nanogpt', label: 'NanoGPT', default_base_url: 'https://nano-gpt.com/api/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'top_k', 'min_p', 'repetition_penalty'], secret_key_name: 'provider_api_key_nanogpt', api_key_env: 'NANOGPT_API_KEY' },
  { id: 'deepseek', label: 'DeepSeek', default_base_url: 'https://api.deepseek.com', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: true, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_deepseek', api_key_env: 'DEEPSEEK_API_KEY' },
  { id: 'aimlapi', label: 'AI/ML API', default_base_url: 'https://api.aimlapi.com/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_aimlapi', api_key_env: 'AIMLAPI_API_KEY' },
  { id: 'xai', label: 'xAI (Grok)', default_base_url: 'https://api.x.ai/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: true, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'frequency_penalty', 'presence_penalty', 'reasoning_effort'], secret_key_name: 'provider_api_key_xai', api_key_env: 'XAI_API_KEY' },
  { id: 'pollinations', label: 'Pollinations', default_base_url: 'https://gen.pollinations.ai/v1', adapter: 'openai', requires_api_key: false, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_pollinations', api_key_env: 'POLLINATIONS_API_KEY' },
  { id: 'moonshot', label: 'Moonshot AI', default_base_url: 'https://api.moonshot.ai/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: true, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_moonshot', api_key_env: 'MOONSHOT_API_KEY' },
  { id: 'fireworks', label: 'Fireworks AI', default_base_url: 'https://api.fireworks.ai/inference/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_fireworks', api_key_env: 'FIREWORKS_API_KEY' },
  { id: 'cometapi', label: 'CometAPI', default_base_url: 'https://api.cometapi.com/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: [], extra_param_keys: ['top_p', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_cometapi', api_key_env: 'COMETAPI_API_KEY' },
  { id: 'azure_openai', label: 'Azure OpenAI', default_base_url: '', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: ['azure_base_url', 'azure_deployment_name', 'azure_api_version'], extra_param_keys: ['top_p', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_azure_openai', api_key_env: 'AZURE_OPENAI_API_KEY' },
  { id: 'zai', label: 'Z.AI (GLM)', default_base_url: 'https://api.z.ai/api/paas/v4', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: ['zai_endpoint'], extra_param_keys: ['top_p', 'top_k'], secret_key_name: 'provider_api_key_zai', api_key_env: 'ZAI_API_KEY' },
  { id: 'siliconflow', label: 'SiliconFlow', default_base_url: 'https://api.siliconflow.com/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: ['siliconflow_endpoint'], extra_param_keys: ['top_p', 'top_k', 'frequency_penalty'], secret_key_name: 'provider_api_key_siliconflow', api_key_env: 'SILICONFLOW_API_KEY' },
  { id: 'workers_ai', label: 'Cloudflare Workers AI', default_base_url: 'https://api.cloudflare.com/client/v4/accounts', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: ['workers_ai_account_id'], extra_param_keys: ['top_p', 'top_k', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_workers_ai', api_key_env: 'CLOUDFLARE_API_KEY' },
  { id: 'minimax', label: 'MiniMax', default_base_url: 'https://api.minimax.io/v1', adapter: 'openai', requires_api_key: true, supports_reverse_proxy: false, custom_url_field: false, extra_field_keys: ['minimax_endpoint'], extra_param_keys: ['top_p', 'top_k', 'frequency_penalty', 'presence_penalty'], secret_key_name: 'provider_api_key_minimax', api_key_env: 'MINIMAX_API_KEY' },
];

const sourceById = (id: string): ChatCompletionSourceMeta | undefined => chatCompletionSources.find((source) => source.id === id);

function getChatCompletionSourceOptions(t: (key: string) => string): Array<[string, string]> {
  return [
    ['disabled', t('connection.disabled')],
    ...chatCompletionSources.map((source): [string, string] => [source.id, source.label]),
  ];
}

function getExtraFieldLabels(t: (key: string) => string): Record<string, string> {
  return {
    openrouter_providers: 'OpenRouter providers ' + t('common.commaSeparated'),
    openrouter_quantizations: 'OpenRouter quantizations ' + t('common.commaSeparated'),
    openrouter_middleout: 'OpenRouter middle-out (auto / on / off)',
    openrouter_use_fallback: 'OpenRouter ' + t('connection.useFallback'),
    azure_base_url: 'Azure base URL',
    azure_deployment_name: 'Azure deployment name',
    azure_api_version: 'Azure API version',
    vertexai_region: 'Vertex AI region',
    vertexai_express_project_id: 'Vertex AI Express project ID',
    vertexai_auth_mode: 'Vertex AI auth mode (express / service_account)',
    zai_endpoint: 'Z.AI endpoint (common / coding)',
    siliconflow_endpoint: 'SiliconFlow endpoint (global / cn)',
    minimax_endpoint: 'MiniMax endpoint (global / cn)',
    workers_ai_account_id: 'Cloudflare Account ID',
    custom_include_headers: t('connection.includeHeaders'),
    custom_include_body: t('connection.includeBody'),
    custom_exclude_body: t('connection.excludeBody'),
    google_safety_off: t('connection.disableSafety'),
    google_use_sysprompt: t('connection.useSystemPrompt'),
  };
}

const extraParamLabels: Record<string, string> = {
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  top_a: 'top_a',
  repetition_penalty: 'repetition_penalty',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  seed: 'seed',
  reasoning_effort: 'reasoning_effort (auto/low/medium/high/min/max)',
  verbosity: 'verbosity (auto/low/medium/high)',
  thinking_budget: 'thinking_budget (Gemini)',
};

const booleanExtraFields = new Set(['openrouter_use_fallback', 'google_safety_off', 'google_use_sysprompt']);
const longTextExtraFields = new Set(['custom_include_headers', 'custom_include_body', 'custom_exclude_body']);

const defaultGenerationSettings: GenerationSettings = {
  provider: 'disabled',
  chat_completion_source: 'disabled',
  base_url: '',
  model: '',
  bot_name: 'Bot',
  system_prompt: 'You are a collaborative roleplay assistant. Continue the scene naturally.',
  temperature: 0.8,
  max_tokens: 350,
  timeout_seconds: 60,
  api_key: '',
  clear_api_key: false,
  reverse_proxy: '',
  proxy_password: '',
  clear_proxy_password: false,
  source_settings: {},
  parameters: {},
};

function draftFromCard(card: CharacterCard): CardDraft {
  return {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    firstMessage: card.first_message,
    alternateGreetings: card.alternate_greetings || [],
    messageExample: card.message_example,
    creator: card.creator,
    tags: card.tags.join(', '),
  };
}

function filenameFromContentDisposition(disposition: string | null): string {
  if (!disposition) {
    return '';
  }
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  return disposition.match(/filename="?([^";]+)"?/i)?.[1] || '';
}

async function downloadResponse(response: Response, fallbackName: string) {
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filenameFromContentDisposition(response.headers.get('Content-Disposition')) || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

const defaultVisualSettings: VisualSettings = {
  theme: 'midnight',
  textScale: 'normal',
  density: 'comfortable',
  messageWidth: 'standard',
  radius: 'soft',
  motion: true,
  highContrast: false,
  showAvatars: true,
  stickyComposer: true,
  gradients: false,
  glass: false,
  texture: false,
  panelShadows: false,
  messageTint: false,
  backgroundVignette: false,
};

const themes: Array<{ id: ThemeId; name: string; description: string; swatches: string[]; tone: 'dark' | 'light' }> = [
  { id: 'midnight', name: 'Midnight', description: 'theme.midnight', swatches: ['#090a0d', '#171a21', '#7c8aff', '#56d4b0'], tone: 'dark' },
  { id: 'abyss', name: 'Abyss', description: 'theme.abyss', swatches: ['#000000', '#0a0a0a', '#d6b46a', '#6fb5a5'], tone: 'dark' },
  { id: 'forest', name: 'Forest', description: 'theme.forest', swatches: ['#0f1712', '#1c2a20', '#c69a55', '#7fb069'], tone: 'dark' },
  { id: 'ocean', name: 'Ocean', description: 'theme.ocean', swatches: ['#0c1420', '#172638', '#7fb7ff', '#76d1cf'], tone: 'dark' },
  { id: 'plum', name: 'Plum', description: 'theme.plum', swatches: ['#17111b', '#261d2d', '#c69ad7', '#d2a75f'], tone: 'dark' },
  { id: 'ember', name: 'Ember', description: 'theme.ember', swatches: ['#17110d', '#2a1d17', '#e09a58', '#c76f54'], tone: 'dark' },
  { id: 'aurora', name: 'Aurora', description: 'theme.aurora', swatches: ['#071317', '#10262a', '#8de3c6', '#a991ff'], tone: 'dark' },
  { id: 'slate', name: 'Slate', description: 'theme.slate', swatches: ['#111417', '#1f252b', '#9db0bf', '#d1a66b'], tone: 'dark' },
  { id: 'noir', name: 'Noir', description: 'theme.noir', swatches: ['#08090b', '#15171c', '#e6e1d8', '#c94747'], tone: 'dark' },
  { id: 'cyberpunk', name: 'Cyberpunk', description: 'theme.cyberpunk', swatches: ['#10071f', '#1b0e33', '#ff5bd8', '#47e6ff'], tone: 'dark' },
  { id: 'dracula', name: 'Dracula', description: 'theme.dracula', swatches: ['#171421', '#282238', '#ff79c6', '#50fa7b'], tone: 'dark' },
  { id: 'nord', name: 'Nord', description: 'theme.nord', swatches: ['#1d2430', '#2e3440', '#88c0d0', '#a3be8c'], tone: 'dark' },
  { id: 'coffee', name: 'Coffee', description: 'theme.coffee', swatches: ['#17100c', '#261914', '#c58b5a', '#8db596'], tone: 'dark' },
  { id: 'parchment', name: 'Parchment', description: 'theme.parchment', swatches: ['#f4eddf', '#fffaf0', '#9c6b2f', '#3e746c'], tone: 'light' },
  { id: 'rose', name: 'Rose Tea', description: 'theme.rose', swatches: ['#f4e6df', '#fff6ee', '#b95d68', '#7b5f3f'], tone: 'light' },
  { id: 'porcelain', name: 'Porcelain', description: 'theme.porcelain', swatches: ['#edf3f8', '#ffffff', '#4d7ea8', '#7a8a99'], tone: 'light' },
  { id: 'mint', name: 'Mint', description: 'theme.mint', swatches: ['#e8f4ed', '#f7fff9', '#3a8f73', '#53685f'], tone: 'light' },
  { id: 'lavender', name: 'Lavender', description: 'theme.lavender', swatches: ['#eee8f8', '#fbf8ff', '#7d61b3', '#8b6d8f'], tone: 'light' },
  { id: 'solar', name: 'Solar', description: 'theme.solar', swatches: ['#f5ead2', '#fff9e8', '#c77923', '#407c9c'], tone: 'light' },
  { id: 'sand', name: 'Sand', description: 'theme.sand', swatches: ['#efe3cc', '#fbf2df', '#a66f2d', '#6f8060'], tone: 'light' },
  { id: 'linen', name: 'Linen', description: 'theme.linen', swatches: ['#f1eadc', '#fffaf0', '#8a6b3e', '#6f7d54'], tone: 'light' },
  { id: 'cloud', name: 'Cloud', description: 'theme.cloud', swatches: ['#eef4f7', '#ffffff', '#5c89a8', '#8da6b5'], tone: 'light' },
  { id: 'buttercream', name: 'Buttercream', description: 'theme.buttercream', swatches: ['#f7efd6', '#fff9e6', '#bf7d2e', '#8a7350'], tone: 'light' },
  { id: 'seashell', name: 'Seashell', description: 'theme.seashell', swatches: ['#f7ebe4', '#fff7f1', '#c46b60', '#4f8f8a'], tone: 'light' },
  { id: 'morning', name: 'Morning', description: 'theme.morning', swatches: ['#edf0fb', '#fbfcff', '#637cc0', '#9b7fb5'], tone: 'light' },
  { id: 'paper', name: 'Paper', description: 'theme.paper', swatches: ['#f2f0e8', '#fffdf7', '#5f6f5d', '#7d8f73'], tone: 'light' },
];

const darkThemes = themes.filter((theme) => theme.tone === 'dark');
const lightThemes = themes.filter((theme) => theme.tone === 'light');

function getSlashCommands(t: (key: string) => string) {
  return [
    { command: '/ooc', hint: '<текст>', description: 'Внеигровой комментарий (виден игрокам, скрыт от ИИ)' },
    { command: '/secret', hint: '<действие>', description: 'Тайный ход / записка мастеру (скрыто от других игроков)' },
    { command: '/roll', hint: '1d20+3 [Навык] DC 15', description: 'Бросок кубиков с проверкой сложности' },
    { command: '/branch', hint: '[название]', description: 'Создать альтернативную ветку чата с этого момента' },
    { command: '/hide', hint: '0-3', description: t('commands.hideMessages') },
    { command: '/unhide', hint: '0-3', description: t('commands.unhideMessages') },
    { command: '/delete', hint: '4 7-9', description: t('commands.deleteMessages') },
    { command: '/reroll', hint: '', description: t('commands.rerollLast') },
    { command: '/copy', hint: '0-5', description: t('commands.copyMessages') },
    { command: '/help', hint: '', description: t('commands.showHelp') },
    { command: '/magic-translate', hint: '0', description: t('commands.magicTranslate') },
    { command: '/magic-translate-text', hint: '<text>', description: t('commands.magicTranslateText') },
  ];
}

function loadVisualSettings(): VisualSettings {
  try {
    const saved = window.localStorage.getItem(VISUAL_STORAGE_KEY);
    return saved ? { ...defaultVisualSettings, ...JSON.parse(saved) } : defaultVisualSettings;
  } catch {
    return defaultVisualSettings;
  }
}

let cachedBuiltInExtensionSettings: BuiltInExtensionSettings | null = null;

function saveBuiltInExtensionSettings(nextSettings: BuiltInExtensionSettings): void {
  cachedBuiltInExtensionSettings = nextSettings;
  window.localStorage.setItem(BUILT_IN_EXTENSIONS_STORAGE_KEY, JSON.stringify(nextSettings));
}

function loadBuiltInExtensionSettings(): BuiltInExtensionSettings {
  if (cachedBuiltInExtensionSettings) {
    return cachedBuiltInExtensionSettings;
  }
  try {
    const next: BuiltInExtensionSettings = { ...defaultBuiltInExtensionSettings, ...JSON.parse(window.localStorage.getItem(BUILT_IN_EXTENSIONS_STORAGE_KEY) || '{}') };
    cachedBuiltInExtensionSettings = next;
    return next;
  } catch {
    cachedBuiltInExtensionSettings = defaultBuiltInExtensionSettings;
    return defaultBuiltInExtensionSettings;
  }
}

function loadImageExtensionSettings(): ImageExtensionSettings {
  const saved = loadRawImageExtensionSettings();
  return { ...defaultImageExtensionSettings, ...saved, apiKey: '' };
}

function loadRawImageExtensionSettings(): Partial<ImageExtensionSettings> {
  try {
    const settings = JSON.parse(window.localStorage.getItem(EXTENSION_SETTINGS_STORAGE_KEY) || '{}') as Record<string, unknown>;
    const raw = (settings.sillyimages || settings.inline_image_gen || settings.inlineImageGeneration || settings.iig || {}) as Record<string, unknown>;
    return {
      ...raw,
      apiType: String(raw.apiType || raw.provider || defaultImageExtensionSettings.apiType),
      endpoint: String(raw.endpoint || raw.baseUrl || ''),
      model: String(raw.model || ''),
      apiKey: String(raw.apiKey || ''),
    };
  } catch {
    return {};
  }
}

function loadImageEndpointPresets(): ImageEndpointPreset[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(IMAGE_ENDPOINTS_STORAGE_KEY) || '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed
        .filter((item): item is Partial<ImageEndpointPreset> => Boolean(item) && typeof item === 'object')
        .map((item) => {
          const raw = item as Partial<ImageEndpointPreset> & { provider?: string; baseUrl?: string };
          return { name: String(raw.name || ''), apiType: String(raw.apiType || raw.provider || 'openai'), endpoint: String(raw.endpoint || raw.baseUrl || ''), model: String(raw.model || '') };
        })
        .filter((item) => item.name)
      : [];
  } catch {
    return [];
  }
}

function saveImageEndpointPresets(presets: ImageEndpointPreset[]) {
  window.localStorage.setItem(IMAGE_ENDPOINTS_STORAGE_KEY, JSON.stringify(presets));
}

function loadImageKeys(): ImageKeyRecord[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(IMAGE_KEYS_STORAGE_KEY) || '[]') as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    let activeAssigned = false;
    return parsed
      .filter((item): item is Partial<ImageKeyRecord> => Boolean(item) && typeof item === 'object')
      .map((item, index) => {
        const active = Boolean(item.active) && !activeAssigned;
        if (active) {
          activeAssigned = true;
        }
        return {
          id: String(item.id || `image_key_${index}_${Date.now()}`),
          name: String(item.name || 'Image API key'),
          value: String(item.value || ''),
          active,
        };
      })
      .filter((item) => item.value);
  } catch {
    return [];
  }
}

function saveImageKeys(keys: ImageKeyRecord[]) {
  window.localStorage.setItem(IMAGE_KEYS_STORAGE_KEY, JSON.stringify(keys));
}

function maskSecret(value: string) {
  return value ? `********${value.slice(-4)}` : '';
}

function syncImageExtensionSettingsDom(settings: Partial<ImageExtensionSettings>) {
  window.setTimeout(() => {
    const apiType = document.getElementById('iig_api_type');
    const endpoint = document.getElementById('iig_endpoint');
    const model = document.getElementById('iig_model');
    const apiKey = document.getElementById('iig_api_key');
    if (apiType instanceof HTMLSelectElement && settings.apiType) {
      apiType.value = settings.apiType;
      apiType.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (endpoint instanceof HTMLInputElement && settings.endpoint !== undefined) {
      endpoint.value = settings.endpoint;
      endpoint.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (model instanceof HTMLSelectElement && settings.model !== undefined) {
      if (settings.model && !Array.from(model.options).some((option) => option.value === settings.model)) {
        const option = document.createElement('option');
        option.value = settings.model;
        option.textContent = settings.model;
        model.appendChild(option);
      }
      model.value = settings.model;
      model.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (apiKey instanceof HTMLInputElement && settings.apiKey !== undefined) {
      apiKey.value = settings.apiKey;
      apiKey.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, 0);
}

function participantId(): string {
  const saved = window.localStorage.getItem(PARTICIPANT_STORAGE_KEY);
  if (saved) {
    return saved;
  }
  const id = window.crypto?.randomUUID?.() || `player_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(PARTICIPANT_STORAGE_KEY, id);
  return id;
}

export default function App() {
  const { t } = useLocaleContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<MenuSection>('presets');
  const [visualSettings, setVisualSettings] = useState<VisualSettings>(loadVisualSettings);
  const [cards, setCards] = useState<CharacterCard[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaDraft, setPersonaDraft] = useState({ name: '', description: '' });
  const [cardDraft, setCardDraft] = useState<CardDraft>(emptyCardDraft);
  const [cardAvatar, setCardAvatar] = useState<File | null>(null);
  const [activeCard, setActiveCard] = useState<CharacterCard | null>(null);
  const [activeChat, setActiveChat] = useState<BotChat | null>(null);
  const [botChats, setBotChats] = useState<BotChatSummary[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [playersMenuOpen, setPlayersMenuOpen] = useState(false);
  const [extensionSettingsOpen, setExtensionSettingsOpen] = useState(false);
  const [extensionSettingsTarget, setExtensionSettingsTarget] = useState('');
  const [mobileTopbarCollapsed, setMobileTopbarCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 640);
  const [showScrollBottomButton, setShowScrollBottomButton] = useState(false);
  const [regexRenderTick, setRegexRenderTick] = useState(0);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const lastScrolledChatIdRef = useRef('');
  const lastMessageCountRef = useRef(0);
  const [selectedPersonaId, setSelectedPersonaId] = useState(() => window.localStorage.getItem(SELECTED_PERSONA_STORAGE_KEY) || '');
  const [generationSettings, setGenerationSettings] = useState<GenerationSettings>(defaultGenerationSettings);
  const [models, setModels] = useState<string[]>([]);
  const [connectionPresets, setConnectionPresets] = useState<ConnectionPreset[]>([]);
  const [activeConnectionPresetName, setActiveConnectionPresetName] = useState('');
  const [connectionPresetName, setConnectionPresetName] = useState('');
  const [presetToDelete, setPresetToDelete] = useState('');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [libraryMessage, setLibraryMessage] = useState('');
  const [editingMessageId, setEditingMessageId] = useState('');
  const [editingMessageText, setEditingMessageText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [generationStreamText, setGenerationStreamText] = useState('');
  const [displayedStreamText, setDisplayedStreamText] = useState('');
  const [generationReplaceMessageId, setGenerationReplaceMessageId] = useState<string | null>(null);
  const [topbarVisible, setTopbarVisible] = useState(true);
  const [chatRenameDrafts, setChatRenameDrafts] = useState<Record<string, string>>({});
  const [presetTypes, setPresetTypes] = useState<PresetTypeInfo[]>([]);
  const [selectedPresetType, setSelectedPresetType] = useState('openai');
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [selectedPresetName, setSelectedPresetName] = useState('');
  const [presetNameDraft, setPresetNameDraft] = useState('');
  const [presetJsonDraft, setPresetJsonDraft] = useState('{}');
  const [presetMessage, setPresetMessage] = useState('');
  const [lorebooks, setLorebooks] = useState<LorebookSummary[]>([]);
  const [selectedLorebookName, setSelectedLorebookName] = useState('');
  const [lorebookNameDraft, setLorebookNameDraft] = useState('');
  const [lorebookJsonDraft, setLorebookJsonDraft] = useState('{\n  "entries": {}\n}');
  const [lorebookBindings, setLorebookBindings] = useState<LorebookBinding[]>([]);
  const [lorebookBindingDraft, setLorebookBindingDraft] = useState<LorebookBinding>({ book: '', target_type: 'global', target_id: '' });
  const [lorebookMessage, setLorebookMessage] = useState('');
  const [activePresets, setActivePresets] = useState<Record<string, string>>({});
  const [editingPromptId, setEditingPromptId] = useState('');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [currentTurnParticipantId, setCurrentTurnParticipantId] = useState<string | null>(null);
  const [turnMode, setTurnMode] = useState<'free' | 'round_ready'>('free');
  const [readyParticipantIds, setReadyParticipantIds] = useState<string[]>([]);
  const [currentRoomId, setCurrentRoomId] = useState<string>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('room')?.trim();
    if (fromUrl) {
      window.localStorage.setItem('doubletrouble.roomId', fromUrl);
      return fromUrl;
    }
    return window.localStorage.getItem('doubletrouble.roomId') || 'default';
  });
  const currentRoomIdRef = useRef(currentRoomId);
  const [roomsList, setRoomsList] = useState<RoomInfo[]>([]);
  const [roomInputDraft, setRoomInputDraft] = useState('');
  const [composerMode, setComposerMode] = useState<'normal' | 'ooc' | 'secret'>('normal');
  const [partyHudExpanded, setPartyHudExpanded] = useState(false);
  const [partyHudEditing, setPartyHudEditing] = useState(false);
  const [partyHudDraft, setPartyHudDraft] = useState<PartyHudState>({
    enabled: false,
    location: '',
    time_of_day: '',
    quest: '',
    notes: '',
    players: [],
  });
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);
  const [summaryMemorySettings, setSummaryMemorySettings] = useState<SummaryMemorySettings>({
    enabled: false,
    auto_summarize: true,
    every_n_messages: 20,
    use_separate_api: false,
    provider: 'openai-compatible',
    chat_completion_source: 'custom',
    base_url: '',
    model: '',
    api_key: '',
    clear_api_key: false,
    api_key_configured: false,
    temperature: 0.3,
    max_tokens: 800,
    prompt: 'Summarize the key events, character relationships, important decisions, inventory/state changes, and current situation from the roleplay conversation. Integrate with any existing chronicle seamlessly. Write a concise, well-structured chronicle in the same language as the chat.',
  });
  const [summaryModels, setSummaryModels] = useState<string[]>([]);
  const [summaryStatusMessage, setSummaryStatusMessage] = useState('');
  const [chatMemoryDraft, setChatMemoryDraft] = useState('');
  const [isSummarizingMemory, setIsSummarizingMemory] = useState(false);
  const [typingPlayers, setTypingPlayers] = useState<Record<string, string>>({});
  const lastTypingSentAtRef = useRef(0);
  const typingTimersRef = useRef<Record<string, number>>({});
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [imagePreview, setImagePreview] = useState<{ src: string; title: string } | null>(null);
  const [imagePendingMessages, setImagePendingMessages] = useState<Record<string, boolean>>({});
  const [extensionMessageRenderVersions, setExtensionMessageRenderVersions] = useState<Record<string, number>>({});
  const [authToken, setAuthToken] = useState(() => window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '');
  const [cookieAuth, setCookieAuth] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authDraft, setAuthDraft] = useState({ username: '', password: '', adminCode: '' });
  const [authMessage, setAuthMessage] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [registrationAllowed, setRegistrationAllowed] = useState(true);
  const [botReplyAllowed, setBotReplyAllowed] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [accessToken, setAccessToken] = useState(() => window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || '');
  const [accessPasswordRequired, setAccessPasswordRequired] = useState(false);
  const [accessPasswordConfigured, setAccessPasswordConfigured] = useState(false);
  const [accessUnlocked, setAccessUnlocked] = useState(false);
  const [accessPasswordDraft, setAccessPasswordDraft] = useState('');
  const [accessPasswordMessage, setAccessPasswordMessage] = useState('');
  const [securityAccessPasswordRequiredDraft, setSecurityAccessPasswordRequiredDraft] = useState(false);
  const [securityAccessPasswordDraft, setSecurityAccessPasswordDraft] = useState('');
  const [securityPermissions, setSecurityPermissions] = useState<SecurityPermissions>(defaultSecurityPermissions);
  const [securityDirty, setSecurityDirty] = useState(false);
  const lastSavedSecurityRef = useRef({
    authRequired: false,
    registrationAllowed: true,
    botReplyAllowed: true,
    securityAccessPasswordRequiredDraft: false,
    securityAccessPasswordDraft: '',
    permissionsHash: JSON.stringify(defaultSecurityPermissions),
  });
  const [accessDenied, setAccessDenied] = useState<AccessDeniedState>({ cards: false, personas: false, chats: false, presets: false, lorebooks: false });
  const [deletionLocks, setDeletionLocks] = useState<DeletionLocks>(defaultDeletionLocks);
  const [pendingDeleteKey, setPendingDeleteKey] = useState('');
  const activeMessages = activeChat?.messages ?? [];
  const reasoningDisplay = useMemo(() => reasoningSettingsFromPreset(parsePresetDraft(presetJsonDraft)), [presetJsonDraft]);
  const selectedPersona = useMemo(() => personas.find((persona) => persona.id === selectedPersonaId) ?? personas[0] ?? null, [personas, selectedPersonaId]);
  const connectedPlayers = useMemo(() => {
    const byKey = new Map<string, Participant>();
    for (const participant of participants) {
      if (!participant.connected || participant.role !== 'player') continue;
      const key = participant.username ? `user:${participant.username.toLowerCase()}` : participant.id;
      byKey.set(key, participant);
    }
    return Array.from(byKey.values());
  }, [participants]);
  const activeReferencePersonas = useMemo(() => {
    const byKey = new Map<string, Persona>();
    const addPersona = (persona: Persona | null, participant?: Participant) => {
      const id = persona?.id || participant?.persona_id || participant?.id || '';
      const name = persona?.name || participant?.persona_name || participant?.name || '';
      const avatarUrl = persona?.avatar_url || participant?.avatar_url || '';
      if (!id || !name || !avatarUrl) {
        return;
      }
      byKey.set(id, {
        id,
        name,
        description: persona?.description || '',
        avatar: persona?.avatar || avatarUrl,
        avatar_url: avatarUrl,
        active: Boolean(persona?.active),
      });
    };
    connectedPlayers.forEach((participant) => addPersona(participant.persona_id ? personas.find((persona) => persona.id === participant.persona_id) || null : null, participant));
    addPersona(selectedPersona);
    return Array.from(byKey.values());
  }, [connectedPlayers, personas, selectedPersona]);
  const connectedCount = connectedPlayers.length;
  const showScrollBottomRef = useRef(false);
  const websocketRef = useRef<WebSocket | null>(null);
  const pendingRealtimeEventsRef = useRef<Record<string, unknown>[]>([]);
  const requestBotReplyRef = useRef<(replaceMessageId?: string, sourceChat?: BotChat, resetSwipes?: boolean) => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    if (activeChat?.party_hud) {
      setPartyHudDraft(activeChat.party_hud);
    } else {
      setPartyHudDraft({ enabled: false, location: '', time_of_day: '', quest: '', notes: '', players: [] });
    }
    setChatMemoryDraft(activeChat?.memory_summary || '');
  }, [activeChat?.id, activeChat?.updated_at]);
  const participantIdRef = useRef(participantId());
  const imageEventSourceIdRef = useRef(window.crypto?.randomUUID?.() || `image_source_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const authTokenRef = useRef(authToken);
  const authUserRef = useRef<AuthUser | null>(null);
  const activeCardRef = useRef<CharacterCard | null>(null);
  const activeChatRef = useRef<BotChat | null>(null);
  const cardsRef = useRef<CharacterCard[]>([]);
  const sessionActiveTargetRef = useRef<{ cardId: string; chatId: string }>({ cardId: '', chatId: '' });
  const personasRef = useRef<Persona[]>([]);
  const personasLoadedRef = useRef(false);
  const selectedPersonaIdRef = useRef(selectedPersonaId);
  const sessionSnapshotReceivedRef = useRef(false);
  const participantPersonaRestoredRef = useRef(false);
  const lastKnownParticipantPersonaIdRef = useRef('');
  const selectedPresetTypeRef = useRef(selectedPresetType);
  const selectedLorebookNameRef = useRef(selectedLorebookName);
  const topbarScrollYRef = useRef(0);
  const swipeTouchStartRef = useRef<Record<string, { x: number; y: number }>>({});
  const restoredSelectionRef = useRef(false);
  const activePresetDraftSignatureRef = useRef('');
  const generationSettingsLoadedRef = useRef(false);
  const generationSettingsSaveSignatureRef = useRef('');
  const lastLocalSettingsSaveRef = useRef<Record<string, number>>({});
  const renderedExtensionMessageSignaturesRef = useRef<Map<string, string>>(new Map());
  const activeGenerationRef = useRef(false);
  const extensionLeaderId = connectedPlayers.length
    ? [...connectedPlayers].sort((left, right) => {
        if (left.is_admin !== right.is_admin) return left.is_admin ? -1 : 1;
        return String(left.connected_at || '').localeCompare(String(right.connected_at || '')) || left.id.localeCompare(right.id);
      })[0]?.id || participantIdRef.current
    : participantIdRef.current;
  const extensionLeader = extensionLeaderId === participantIdRef.current;

  useEffect(() => {
    activeCardRef.current = activeCard;
    activeChatRef.current = activeChat;
  }, [activeCard, activeChat]);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    selectedPersonaIdRef.current = selectedPersonaId;
  }, [selectedPersonaId]);

  useEffect(() => {
    personasRef.current = personas;
  }, [personas]);

  useEffect(() => {
    selectedPresetTypeRef.current = selectedPresetType;
  }, [selectedPresetType]);

  useEffect(() => {
    selectedLorebookNameRef.current = selectedLorebookName;
  }, [selectedLorebookName]);

  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);

  useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  useEffect(() => {
    if (authToken) {
      window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, authToken);
    } else {
      window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  }, [authToken]);

  useEffect(() => {
    window.localStorage.setItem(VISUAL_STORAGE_KEY, JSON.stringify(visualSettings));
    document.documentElement.dataset.theme = visualSettings.theme;
    document.documentElement.dataset.textScale = visualSettings.textScale;
    document.documentElement.dataset.density = visualSettings.density;
    document.documentElement.dataset.radius = visualSettings.radius;
    document.documentElement.dataset.motion = String(visualSettings.motion);
    document.documentElement.dataset.contrast = String(visualSettings.highContrast);
    document.documentElement.dataset.gradients = String(visualSettings.gradients);
    document.documentElement.dataset.glass = String(visualSettings.glass);
    document.documentElement.dataset.texture = String(visualSettings.texture);
    document.documentElement.dataset.panelShadows = String(visualSettings.panelShadows);
    document.documentElement.dataset.messageTint = String(visualSettings.messageTint);
    document.documentElement.dataset.backgroundVignette = String(visualSettings.backgroundVignette);
  }, [visualSettings]);

  useEffect(() => {
    void refreshLibrary();
    void loadGenerationSettings();
    void loadConnectionPresets();
    void loadPresetTypes();
    void loadActivePresetDraft();
    void loadLorebooks();
    void loadSecurityPermissions();
    void loadDeleteLocks();
  }, []);

  useEffect(() => {
    if (!isGenerating || !generationStreamText) {
      setDisplayedStreamText('');
      return;
    }
    let rafId = 0;
    let lastTime = performance.now();
    const tick = (now: number) => {
      let keepRunning = false;
      setDisplayedStreamText((prev) => {
        if (prev === generationStreamText) return prev;
        if (!generationStreamText.startsWith(prev)) {
          return generationStreamText;
        }
        const remaining = generationStreamText.length - prev.length;
        if (remaining <= 0) return prev;
        const dt = Math.max(8, now - lastTime);
        lastTime = now;
        const step = Math.max(1, Math.ceil(remaining * Math.min(0.32, dt / 85)));
        const next = generationStreamText.slice(0, prev.length + step);
        if (next.length < generationStreamText.length) {
          keepRunning = true;
        }
        return next;
      });
      if (isNearBottomRef.current && chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
      }
      if (keepRunning) {
        rafId = window.requestAnimationFrame(tick);
      }
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [generationStreamText, isGenerating]);

  useEffect(() => {
    if (window.location.search.includes('_v=')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    void (async () => {
      try {
        const response = await fetch(`/api/security/config?_t=${Date.now()}`, { cache: 'no-store' });
        const data = await response.json() as { cookie_auth?: boolean; build_id?: string } | null;
        if (data?.build_id && data.build_id !== 'dev') {
          const prevBuild = window.localStorage.getItem('doubletrouble.buildId');
          window.localStorage.setItem('doubletrouble.buildId', data.build_id);
          if (prevBuild && prevBuild !== data.build_id) {
            window.location.replace(`${window.location.pathname}?_v=${encodeURIComponent(data.build_id)}`);
            return;
          }
        }
        setCookieAuth(Boolean(data?.cookie_auth));
      } catch {
        setCookieAuth(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (cookieAuth) {
      void (async () => {
        await loadCurrentUser();
        sendPresence(selectedPersona);
      })();
      void loadDeleteLocks();
      return;
    }
    if (authToken) {
      void (async () => {
        await loadCurrentUser();
        sendPresence(selectedPersona);
      })();
      void loadDeleteLocks();
    } else {
      setAuthUser(null);
    }
  }, [authToken, cookieAuth]);

  useEffect(() => {
    if (accessToken) {
      window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, accessToken);
      void verifyAccessPasswordToken(accessToken);
    } else {
      window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
      setAccessUnlocked(!accessPasswordRequired);
    }
  }, [accessToken, accessPasswordRequired]);

  const scrollToChatBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = chatScrollRef.current;
    if (!el) {
      return;
    }
    el.scrollTo({ top: el.scrollHeight, behavior });
    isNearBottomRef.current = true;
    if (showScrollBottomRef.current) {
      showScrollBottomRef.current = false;
      setShowScrollBottomButton(false);
    }
  };

  const updateTopbarForScroll = (_currentY: number, scrollEl?: HTMLDivElement | null) => {
    if (scrollEl) {
      const distanceFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      const nearBottom = distanceFromBottom < 180;
      isNearBottomRef.current = nearBottom;
      const shouldShow = !nearBottom && scrollEl.scrollHeight - scrollEl.clientHeight > 240;
      if (showScrollBottomRef.current !== shouldShow) {
        showScrollBottomRef.current = shouldShow;
        setShowScrollBottomButton(shouldShow);
      }
    }
  };

  useEffect(() => {
    const onRegexUpdated = () => setRegexRenderTick((tick) => tick + 1);
    window.addEventListener('doubletrouble:regex-updated', onRegexUpdated);
    return () => {
      window.removeEventListener('doubletrouble:regex-updated', onRegexUpdated);
    };
  }, []);

  useEffect(() => {
    if (selectedPersonaId) {
      window.localStorage.setItem(SELECTED_PERSONA_STORAGE_KEY, selectedPersonaId);
    }
  }, [selectedPersonaId]);

  useEffect(() => {
    const openExtensionSettings = (event: Event) => {
      const target = (event as CustomEvent<{ name?: string }>).detail?.name || '';
      setExtensionSettingsTarget(target);
      setExtensionSettingsOpen(Boolean(target));
    };
    window.addEventListener('doubletrouble:extension-settings-open', openExtensionSettings);
    return () => window.removeEventListener('doubletrouble:extension-settings-open', openExtensionSettings);
  }, []);

  useEffect(() => {
    if (!menuOpen || activeSection !== 'extensions') {
      setExtensionSettingsOpen(false);
      setExtensionSettingsTarget('');
    }
  }, [menuOpen, activeSection]);

  useEffect(() => {
    const currentHash = JSON.stringify(securityPermissions);
    const isSame =
      authRequired === lastSavedSecurityRef.current.authRequired &&
      registrationAllowed === lastSavedSecurityRef.current.registrationAllowed &&
      botReplyAllowed === lastSavedSecurityRef.current.botReplyAllowed &&
      securityAccessPasswordRequiredDraft === lastSavedSecurityRef.current.securityAccessPasswordRequiredDraft &&
      securityAccessPasswordDraft === lastSavedSecurityRef.current.securityAccessPasswordDraft &&
      currentHash === lastSavedSecurityRef.current.permissionsHash;
    setSecurityDirty(!isSame);
  }, [authRequired, registrationAllowed, botReplyAllowed, securityAccessPasswordRequiredDraft, securityAccessPasswordDraft, securityPermissions]);

  useEffect(() => {
    const settingsHost = document.getElementById('extensions_settings');
    if (!settingsHost) {
      return;
    }
    Array.from(settingsHost.children).forEach((child) => {
      if (!(child instanceof HTMLElement) || child.dataset.dtKeepVisible === 'true') {
        return;
      }
      child.hidden = !extensionSettingsOpen || child.dataset.dtExtensionOwner !== extensionSettingsTarget;
    });
  }, [extensionSettingsOpen, extensionSettingsTarget]);

  useEffect(() => {
    sendPresence(selectedPersona);
  }, [selectedPersona?.id, selectedPersona?.name, selectedPersona?.avatar_url, authUser?.username, authUser?.is_admin]);

  useEffect(() => {
    const userName = selectedPersona?.name || authUser?.username || 'Player';
    const charName = activeCard?.name || generationSettings.bot_name || 'Bot';
    setRegexNames(userName, charName);
    setRegexContext(activeCard?.id || '', activeConnectionPresetName, generationSettings.chat_completion_source || generationSettings.provider || 'openai');
    updateSillyTavernRuntime({
      messages: activeMessages,
      characters: activeCard ? [{ id: activeCard.id, name: activeCard.name, avatar: activeCard.image_url, image_url: imageSrc(activeCard.image_url) }] : [],
      personas: personas.map((persona) => ({ ...persona, avatar_url: imageSrc(persona.avatar_url) })),
      activePersonas: activeReferencePersonas.map((persona) => ({ ...persona, avatar_url: imageSrc(persona.avatar_url) })),
      selectedPersonaId,
      characterId: activeCard ? 0 : undefined,
      chatId: activeChat?.id || 'default',
      name1: userName,
      name2: charName,
      getRequestHeaders: actorHeaders,
      saveMessageByIndex: saveExtensionMessageByIndex,
      toast: addToast,
      extensionLeader,
      reasoning: reasoningDisplay,
    });
  }, [activeMessages, activeCard?.id, activeCard?.name, activeCard?.image_url, personas, activeReferencePersonas, selectedPersonaId, selectedPersona?.name, authUser?.username, generationSettings.bot_name, authToken, accessToken, extensionLeader, presetJsonDraft, activeConnectionPresetName, generationSettings.chat_completion_source, generationSettings.provider]);

  useEffect(() => {
    if (authChecked && (!accessPasswordRequired || accessUnlocked) && (!authRequired || authUser)) {
      void initSillyTavernExtensions();
    }
  }, [authChecked, accessPasswordRequired, accessUnlocked, authRequired, authUser]);

  useEffect(() => {
    const chatId = activeChat?.id || '';
    const msgCount = activeMessages.length;
    if (chatId && lastScrolledChatIdRef.current !== chatId) {
      lastScrolledChatIdRef.current = chatId;
      lastMessageCountRef.current = msgCount;
      isNearBottomRef.current = true;
      window.requestAnimationFrame(() => scrollToChatBottom('auto'));
    } else if (msgCount > lastMessageCountRef.current && isNearBottomRef.current) {
      lastMessageCountRef.current = msgCount;
      window.requestAnimationFrame(() => scrollToChatBottom('smooth'));
    } else {
      lastMessageCountRef.current = msgCount;
    }
  }, [activeChat?.id, activeMessages.length]);

  useEffect(() => {
    if ((isGenerating || generationStreamText) && isNearBottomRef.current) {
      window.requestAnimationFrame(() => scrollToChatBottom('auto'));
    }
  }, [isGenerating, generationStreamText]);

  useEffect(() => {
    renderedExtensionMessageSignaturesRef.current = new Map(activeMessages.map((message) => [message.id, extensionMessageSignature(message)]));
    const timer = window.setTimeout(() => { void emitSillyTavernChatChanged(); }, 80);
    return () => window.clearTimeout(timer);
  }, [activeCard?.id, activeChat?.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      activeMessages.forEach((message, index) => {
        const signature = extensionMessageSignature(message);
        if (renderedExtensionMessageSignaturesRef.current.get(message.id) !== signature) {
          renderedExtensionMessageSignaturesRef.current.set(message.id, signature);
          void emitSillyTavernMessageRendered(index, message.role);
        }
      });
      void emitSillyTavernChatChanged();
    }, 120);
    return () => window.clearTimeout(timer);
  }, [activeMessages]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let pingInterval: number | undefined;
    let hasConnectedOnce = false;

    const syncAfterReconnect = () => {
      void refreshLibrary();
      const card = activeCardRef.current;
      const chat = activeChatRef.current;
      if (card && chat) {
        void openChatForCard(card, chat.id);
      }
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams();
      if (authToken) params.set('auth', authToken);
      if (accessToken) params.set('access_token', accessToken);
      const qs = params.toString();
      const roomSlug = encodeURIComponent(currentRoomIdRef.current || 'default');
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/sessions/${roomSlug}${qs ? `?${qs}` : ''}`);
      websocketRef.current = socket;
      socket.onopen = () => {
        const isReconnect = hasConnectedOnce;
        hasConnectedOnce = true;
        const currentPersona = personasRef.current.find((p) => p.id === selectedPersonaIdRef.current) || personasRef.current[0] || null;
        sendPresence(currentPersona);
        while (pendingRealtimeEventsRef.current.length) {
          const ev = pendingRealtimeEventsRef.current.shift();
          if (ev) {
            sendRealtimeEvent(ev);
          }
        }
        if (isReconnect) {
          syncAfterReconnect();
        }
        window.clearInterval(pingInterval);
        pingInterval = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
          }
        }, 25000);
      };
      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as RealtimePayload;
        if (payload.type === 'pong') {
          return;
        }
        if (payload.type === 'chat.updated' && payload.chat) {
          const sameCard = Boolean(payload.card_id && activeCardRef.current?.id === payload.card_id);
          if (activeChatRef.current?.id === payload.chat.id || (sameCard && (!activeChatRef.current || payload.switch_active))) {
            setActiveChat(payload.chat);
            if (payload.card_id) {
              rememberChatSelection(payload.card_id, payload.chat.id);
            }
            setImagePendingMessages((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${payload.card_id || payload.chat?.card_id || ''}:${payload.chat?.id || ''}:`))));
            document.querySelectorAll('#chat .iig-local-pending').forEach((element) => element.classList.remove('iig-local-pending'));
          } else if (!activeCardRef.current && payload.card_id) {
            const targetCard = cardsRef.current.find((c) => c.id === payload.card_id);
            if (targetCard) {
              setActiveCard(targetCard);
              setActiveChat(payload.chat);
              rememberChatSelection(targetCard.id, payload.chat.id);
            }
          }
          if (sameCard && payload.chat) {
            const updatedChat = payload.chat;
            setBotChats((current) => {
              const summary: BotChatSummary = {
                id: updatedChat.id,
                title: updatedChat.title,
                filename: `${updatedChat.id}.json`,
                message_count: updatedChat.messages?.length ?? 0,
                created_at: updatedChat.created_at,
                updated_at: updatedChat.updated_at,
              };
              const idx = current.findIndex((item) => item.id === updatedChat.id);
              if (idx < 0) return [summary, ...current];
              const next = [...current];
              next[idx] = summary;
              return next;
            });
          }
        }
        if (payload.type === 'card.select' && payload.card_id && payload.source_participant_id !== participantIdRef.current) {
          const targetCard = cardsRef.current.find((c) => c.id === payload.card_id);
          if (targetCard && (!activeCardRef.current || activeCardRef.current.id !== targetCard.id || (payload.chat_id && activeChatRef.current?.id !== payload.chat_id))) {
            if (payload.chat_id) {
              void openChatForCard(targetCard, payload.chat_id);
            } else {
              void selectBotCard(targetCard, false);
            }
          }
        }
        if ((payload.type === 'image_generation.pending' || payload.type === 'image_generation.finished') && payload.card_id && payload.chat_id && payload.message_id && payload.source_participant_id !== imageEventSourceIdRef.current) {
          if (payload.card_id === activeCardRef.current?.id && payload.chat_id === activeChatRef.current?.id) {
            const key = imagePendingKey(payload.card_id, payload.chat_id, payload.message_id);
            setImagePendingMessages((current) => {
              if (payload.type === 'image_generation.pending') {
                return { ...current, [key]: true };
              }
              const next = { ...current };
              delete next[key];
              return next;
            });
          }
        }
        if (payload.type === 'chat.deleted' && payload.chat_id === activeChatRef.current?.id) {
          setActiveChat(null);
          const currentCard = activeCardRef.current;
          if (currentCard) {
            void (async () => {
              const r = await authedFetch(`/api/cards/${encodeURIComponent(currentCard.id)}/chats`);
              if (r.ok) {
                const d = await r.json() as { chats: BotChatSummary[] };
                setBotChats(d.chats);
                if (d.chats[0]) {
                  await openChatForCard(currentCard, d.chats[0].id);
                }
              }
            })();
          }
        }
        if (payload.type === 'card.deleted' && payload.card_id) {
          setCards((current) => current.filter((card) => card.id !== payload.card_id));
          if (activeCardRef.current?.id === payload.card_id) {
            setActiveCard(null);
            setActiveChat(null);
            setBotChats([]);
          }
        }
        if ((payload.type === 'presence.updated' || payload.type === 'session.snapshot' || payload.type === 'session.updated') && payload.session?.participants) {
          sessionSnapshotReceivedRef.current = true;
          if (Array.isArray(payload.active_generations) && activeCardRef.current && activeChatRef.current) {
            const activeKey = `${activeCardRef.current.id}:${activeChatRef.current.id}`;
            if (payload.active_generations.includes(activeKey)) {
              activeGenerationRef.current = true;
              setIsGenerating(true);
              setGenerationStatus(`${activeCardRef.current.name || t('composer.bot')} ${t('composer.typing')}`);
            }
          }
          if (payload.session.active_card_id) {
            sessionActiveTargetRef.current = { cardId: payload.session.active_card_id, chatId: payload.session.active_chat_id || '' };
            const shouldSyncRoomTarget = !activeCardRef.current
              || (payload.type === 'session.snapshot' && (
                activeCardRef.current.id !== payload.session.active_card_id
                || (payload.session.active_chat_id && activeChatRef.current?.id !== payload.session.active_chat_id)
              ));
            if (shouldSyncRoomTarget && cardsRef.current.length) {
              const targetCard = cardsRef.current.find((c) => c.id === payload.session?.active_card_id);
              if (targetCard) {
                if (payload.session.active_chat_id) {
                  void openChatForCard(targetCard, payload.session.active_chat_id);
                } else {
                  void selectBotCard(targetCard, false);
                }
              }
            }
          }
          const nextParticipants = Object.values(payload.session.participants);
          const ownParticipant = nextParticipants.find((participant) => participant.id === participantIdRef.current);
          if (ownParticipant?.persona_id) {
            lastKnownParticipantPersonaIdRef.current = ownParticipant.persona_id;
            restoreSelectedPersonaFromParticipant(ownParticipant.persona_id);
          } else {
            selectDefaultPersonaIfNeeded();
          }
          setParticipants(nextParticipants);
          if (payload.session.turn !== undefined) {
            setCurrentTurnParticipantId(payload.session.turn?.current_participant_id || null);
            setTurnMode(payload.session.turn?.mode === 'round_ready' ? 'round_ready' : 'free');
            setReadyParticipantIds(payload.session.turn?.ready_participant_ids || []);
          }
        }
        if (payload.type === 'round.all_ready') {
          const shouldTrigger = payload.trigger_participant_id
            ? payload.trigger_participant_id === participantIdRef.current
            : extensionLeader;
          if (shouldTrigger && !activeGenerationRef.current && activeChatRef.current) {
            addToast('⚡ Все игроки готовы — запускаем ответ бота!');
            window.setTimeout(() => { void requestBotReplyRef.current(); }, 120);
          }
        }
        if (payload.type === 'typing.updated' && payload.participant_id && payload.participant_id !== participantIdRef.current) {
          const pid = payload.participant_id;
          window.clearTimeout(typingTimersRef.current[pid]);
          if (payload.is_typing) {
            const displayName = payload.name || 'Player';
            setTypingPlayers((current) => ({ ...current, [pid]: displayName }));
            typingTimersRef.current[pid] = window.setTimeout(() => {
              setTypingPlayers((current) => {
                const next = { ...current };
                delete next[pid];
                return next;
              });
            }, 4200);
          } else {
            setTypingPlayers((current) => {
              const next = { ...current };
              delete next[pid];
              return next;
            });
          }
        }
        if (payload.type === 'notification' && payload.message) {
          addToast(payload.message);
        }
        if (payload.type === 'generation.started' && payload.card_id === activeCardRef.current?.id && payload.chat_id === activeChatRef.current?.id) {
          activeGenerationRef.current = true;
          setIsGenerating(true);
          setGenerationStreamText('');
          setGenerationReplaceMessageId(payload.replace_message_id || null);
          setGenerationStatus(`${activeCardRef.current?.name || t('composer.bot')} ${t('composer.typing')}`);
        }
        if (payload.type === 'generation.stream' && payload.card_id === activeCardRef.current?.id && payload.chat_id === activeChatRef.current?.id) {
          activeGenerationRef.current = true;
          setIsGenerating(true);
          setGenerationStatus(`${activeCardRef.current?.name || t('composer.bot')} ${t('composer.typing')}`);
          setGenerationReplaceMessageId(payload.replace_message_id || null);
          setGenerationStreamText(payload.message || '');
        }
        if ((payload.type === 'generation.finished' || payload.type === 'generation.cancelled' || payload.type === 'generation.failed') && payload.card_id === activeCardRef.current?.id && payload.chat_id === activeChatRef.current?.id) {
          activeGenerationRef.current = false;
          setIsGenerating(false);
          setGenerationStatus('');
          setGenerationStreamText('');
          setGenerationReplaceMessageId(null);
          if (payload.type === 'generation.failed' && payload.message) {
            addToast(payload.message);
          }
        }
        if (payload.type === 'security.updated') {
          setAuthRequired(Boolean(payload.auth_required));
          setRegistrationAllowed(payload.registration_allowed !== false);
          setBotReplyAllowed(payload.bot_reply_allowed !== false);
          setAccessPasswordRequired(Boolean(payload.access_password_required));
          setSecurityAccessPasswordRequiredDraft(Boolean(payload.access_password_required));
          setAccessPasswordConfigured(Boolean(payload.access_password_configured));
          if (!payload.access_password_required) {
            setAccessUnlocked(true);
          }
          if (payload.permissions) {
            setSecurityPermissions({ ...defaultSecurityPermissions, ...payload.permissions });
          }
          void refreshAccessControlledData();
        }
        if (payload.type === 'settings.updated') {
          const section = payload.section || '';
          void refreshSharedSettings(section);
          window.dispatchEvent(new CustomEvent('doubletrouble:shared-settings-updated', { detail: { section } }));
        }
        if (payload.type === 'delete_locks.updated' && payload.delete_locks) {
          setDeletionLocks({ ...defaultDeletionLocks, ...payload.delete_locks });
          setPendingDeleteKey('');
        }
      };
      socket.onclose = () => {
        window.clearInterval(pingInterval);
        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      };
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || disposed) {
        return;
      }
      const ws = websocketRef.current;
      if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) {
        window.clearTimeout(reconnectTimer);
        connect();
      } else {
        syncAfterReconnect();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    connect();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pingInterval);
      websocketRef.current?.close();
    };
  }, [authToken, accessToken, accessUnlocked, currentRoomId]);

  const addToast = (message: string) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setToasts((current) => [...current.slice(-3), { id, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  };

  const sendRealtimeEvent = (event: Record<string, unknown>) => {
    const socket = websocketRef.current;
    if (!socket) {
      return;
    }
    if (socket.readyState === WebSocket.CONNECTING) {
      pendingRealtimeEventsRef.current.push(event);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ username: authUserRef.current?.username || '', is_admin: Boolean(authUserRef.current?.is_admin), ...event }));
  };

  const applySelectedPersonaId = (personaId: string) => {
    window.localStorage.setItem(SELECTED_PERSONA_STORAGE_KEY, personaId);
    selectedPersonaIdRef.current = personaId;
    setSelectedPersonaId(personaId);
  };

  const restoreSelectedPersonaFromParticipant = (personaId: string) => {
    if (!personaId || participantPersonaRestoredRef.current) {
      return;
    }
    const exists = personasRef.current.some((persona) => persona.id === personaId);
    if (!exists) {
      return;
    }
    participantPersonaRestoredRef.current = true;
    if (selectedPersonaIdRef.current !== personaId) {
      applySelectedPersonaId(personaId);
    }
  };

  const selectDefaultPersonaIfNeeded = () => {
    if (!personasLoadedRef.current) {
      return;
    }
    const currentId = selectedPersonaIdRef.current || window.localStorage.getItem(SELECTED_PERSONA_STORAGE_KEY) || '';
    if (personasRef.current.some((persona) => persona.id === currentId)) {
      return;
    }
    const nextPersona = personasRef.current.find((persona) => persona.active) || personasRef.current[0];
    if (nextPersona) {
      applySelectedPersonaId(nextPersona.id);
    }
  };

  const actorHeaders = (token = authTokenRef.current || authToken) => ({
    'X-DoubleTrouble-Actor': encodeURIComponent(authUserRef.current?.username || selectedPersona?.name || 'Player'),
    'X-DoubleTrouble-Session': encodeURIComponent(currentRoomIdRef.current || 'default'),
    ...(accessToken ? { 'X-DoubleTrouble-Access': accessToken } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  const sendPresence = (persona: Persona | null) => {
    if (!persona && !personasLoadedRef.current) {
      return;
    }
    if (persona && !selectedPersonaIdRef.current && !sessionSnapshotReceivedRef.current && !personasLoadedRef.current) {
      return;
    }
    sendRealtimeEvent({
      type: 'presence.update',
      participant_id: participantIdRef.current,
      name: persona?.name || 'Player',
      persona_id: persona?.id || '',
      persona_name: persona?.name || '',
      avatar_url: persona?.avatar_url || '',
      username: authUserRef.current?.username || '',
      is_admin: Boolean(authUserRef.current?.is_admin),
    });
  };

  const notifyImageGenerationPending = (messageIndex: number, pending: boolean) => {
    const card = activeCardRef.current;
    const chat = activeChatRef.current;
    const message = chat?.messages[messageIndex];
    if (!card || !chat || !message) {
      return;
    }
    sendRealtimeEvent({
      type: pending ? 'image_generation.pending' : 'image_generation.finished',
      card_id: card.id,
      chat_id: chat.id,
      message_id: message.id,
      source_participant_id: imageEventSourceIdRef.current,
    });
  };

  const cancelImageGeneration = (messageIndex: number, message: ChatMessage) => {
    const iig = (window as Window & { DoubleTroubleIIG?: { cancelMessageImageGeneration?: (messageIndex: number, messageId?: string) => boolean } }).DoubleTroubleIIG;
    iig?.cancelMessageImageGeneration?.(messageIndex, message.id);
    window.dispatchEvent(new CustomEvent('doubletrouble:iig-cancel', { detail: { messageIndex, messageId: message.id } }));
    const card = activeCardRef.current;
    const chat = activeChatRef.current;
    if (card && chat) {
      const key = imagePendingKey(card.id, chat.id, message.id);
      setImagePendingMessages((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      notifyImageGenerationPending(messageIndex, false);
    }
    document.querySelector(`#chat .mes[mesid="${messageIndex}"]`)?.classList.remove('iig-local-pending');
  };

  useEffect(() => {
    const seenPlaceholders = new WeakSet<Element>();
    const pendingFallbackTimers = new Map<number, number>();
    const setLocalImagePending = (messageIndex: number, pending: boolean) => {
      const card = activeCardRef.current;
      const chat = activeChatRef.current;
      const message = chat?.messages[messageIndex];
      if (!card || !chat || !message) {
        return;
      }
      const key = imagePendingKey(card.id, chat.id, message.id);
      setImagePendingMessages((current) => {
        if (pending) {
          return { ...current, [key]: true };
        }
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (pending) {
        window.setTimeout(() => {
          setImagePendingMessages((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
        }, 180000);
      }
    };
    const notifyMessageElement = (messageElement: Element | null) => {
      const messageIndex = Number(messageElement?.getAttribute('mesid'));
      if (Number.isInteger(messageIndex)) {
        setLocalImagePending(messageIndex, true);
        notifyImageGenerationPending(messageIndex, true);
      }
    };
    const notifyPlaceholder = (node: Node) => {
      if (!(node instanceof Element)) {
        return;
      }
      const placeholders = [node, ...Array.from(node.querySelectorAll('.iig-loading-placeholder'))].filter((item): item is Element => item instanceof Element && item.classList.contains('iig-loading-placeholder'));
      placeholders.forEach((placeholder) => {
        if (seenPlaceholders.has(placeholder) || placeholder.classList.contains('iig-rendered-pending')) {
          return;
        }
        seenPlaceholders.add(placeholder);
        const messageElement = placeholder.closest('.mes[mesid]');
        messageElement?.classList.remove('iig-local-pending');
        notifyMessageElement(messageElement);
      });
    };
    const notifyRegenerateClick = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const regenerateButton = target?.closest('.iig-regenerate-btn');
      if (regenerateButton) {
        const messageElement = regenerateButton.closest('.mes[mesid]');
        const messageIndex = Number(messageElement?.getAttribute('mesid'));
        if (Number.isInteger(messageIndex)) {
          window.setTimeout(() => notifyMessageElement(messageElement), 0);
          window.clearTimeout(pendingFallbackTimers.get(messageIndex));
          pendingFallbackTimers.set(messageIndex, window.setTimeout(() => {
            const currentMessageElement = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
            if (!currentMessageElement?.querySelector('.iig-loading-placeholder')) {
              setLocalImagePending(messageIndex, true);
            }
          }, 1200));
          window.setTimeout(() => {
            document.querySelector(`#chat .mes[mesid="${messageIndex}"]`)?.classList.remove('iig-local-pending');
          }, 180000);
        }
      }
    };
    const notifyImagePendingEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ messageIndex?: number; pending?: boolean }>).detail || {};
      const messageIndex = Number(detail.messageIndex);
      if (Number.isInteger(messageIndex)) {
        setLocalImagePending(messageIndex, detail.pending !== false);
      }
    };
    const observer = new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach(notifyPlaceholder)));
    observer.observe(document.getElementById('chat') || document.body, { childList: true, subtree: true });
    document.addEventListener('click', notifyRegenerateClick, true);
    window.addEventListener('doubletrouble:iig-pending', notifyImagePendingEvent);
    return () => {
      observer.disconnect();
      document.removeEventListener('click', notifyRegenerateClick, true);
      window.removeEventListener('doubletrouble:iig-pending', notifyImagePendingEvent);
      pendingFallbackTimers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const generationParticipants = (): GenerationParticipant[] => {
    const byKey = new Map<string, GenerationParticipant>();
    const addParticipant = (participant: Partial<Participant>, fallbackPersona: Persona | null = null) => {
      const persona = participant.persona_id ? personas.find((item) => item.id === participant.persona_id) : fallbackPersona;
      const personaName = participant.persona_name || persona?.name || participant.name || fallbackPersona?.name || '';
      if (!personaName.trim()) {
        return;
      }
      const key = participant.persona_id || participant.id || personaName.toLowerCase();
      byKey.set(key, {
        persona_id: participant.persona_id || persona?.id || fallbackPersona?.id || '',
        persona_name: personaName,
        persona_description: persona?.description || fallbackPersona?.description || '',
        participant_id: participant.id,
        username: participant.username,
      });
    };
    connectedPlayers.forEach((participant) => addParticipant(participant));
    addParticipant({ id: participantIdRef.current, persona_id: selectedPersona?.id || '', persona_name: selectedPersona?.name || '', name: selectedPersona?.name || '', username: authUser?.username || '' }, selectedPersona);
    return Array.from(byKey.values());
  };

  const authJsonHeaders = (token = authTokenRef.current || authToken) => ({ 'Content-Type': 'application/json', ...actorHeaders(token) });
  const authedFetch = (url: string, init: RequestInit = {}, token = authTokenRef.current || authToken) => fetch(url, { ...init, headers: { ...(init.headers || {}), ...actorHeaders(token) } });
  const imageSrc = (url: string) => {
    if (!url || (!url.startsWith('/api/') && !url.startsWith('/User Avatars/'))) return url;
    const params = new URLSearchParams();
    if (authToken) params.set('auth', authToken);
    if (accessToken) params.set('access_token', accessToken);
    const qs = params.toString();
    return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
  };
  const deniedResponse = (response: Response) => response.status === 401 || response.status === 403;
  const markAccessDenied = (section: keyof AccessDeniedState, denied: boolean) => setAccessDenied((current) => ({ ...current, [section]: denied }));

  const syncActivePresetDraft = async (draft = presetJsonDraft, token = authToken) => {
    if (!selectedPresetType || accessDenied.presets) {
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!Object.keys(parsed).length) {
      return;
    }
    const name = presetNameDraft.trim() || selectedPresetName || 'unsaved';
    const signature = `${selectedPresetType}:${name}:${draft}`;
    if (activePresetDraftSignatureRef.current === signature) {
      return;
    }
    activePresetDraftSignatureRef.current = signature;
    lastLocalSettingsSaveRef.current.presets = Date.now();
    lastLocalSettingsSaveRef.current.generation = Date.now();
    const response = await fetch(`/api/presets/${encodeURIComponent(selectedPresetType)}/active-draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...actorHeaders(token) },
      body: JSON.stringify({ name, preset: parsed }),
    });
    if (!response.ok) {
      setPresetMessage(t('presets.error.activate'));
      activePresetDraftSignatureRef.current = '';
      return;
    }
    const data = await response.json() as { active: Record<string, string>; settings: Partial<GenerationSettings> };
    lastLocalSettingsSaveRef.current.presets = Date.now();
    lastLocalSettingsSaveRef.current.generation = Date.now();
    setActivePresets(data.active);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { void syncActivePresetDraft(); }, 550);
    return () => window.clearTimeout(timer);
  }, [presetJsonDraft, presetNameDraft, selectedPresetName, selectedPresetType, authToken, accessDenied.presets]);

  useEffect(() => {
    if (!generationSettingsLoadedRef.current) {
      return;
    }
    const signature = JSON.stringify(generationSettings);
    if (generationSettingsSaveSignatureRef.current === signature) {
      return;
    }
    const snapshot = generationSettings;
    const timer = window.setTimeout(async () => {
      generationSettingsSaveSignatureRef.current = signature;
      lastLocalSettingsSaveRef.current.generation = Date.now();
      const response = await fetch('/api/generation/settings', {
        method: 'PUT',
        headers: authJsonHeaders(),
        body: JSON.stringify(snapshot),
      });
      if (!response.ok) {
        generationSettingsSaveSignatureRef.current = '';
        setConnectionMessage(t('connection.error.apply'));
        return;
      }
      const data = await response.json() as Partial<GenerationSettings>;
      lastLocalSettingsSaveRef.current.generation = Date.now();
      if (snapshot.api_key || snapshot.clear_api_key || snapshot.proxy_password || snapshot.clear_proxy_password) {
        setGenerationSettings((current) => {
          const updated = {
            ...current,
            api_key_configured: data.api_key_configured ?? current.api_key_configured,
            proxy_password_configured: data.proxy_password_configured ?? current.proxy_password_configured,
            api_key: '',
            clear_api_key: false,
            proxy_password: '',
            clear_proxy_password: false,
          };
          generationSettingsSaveSignatureRef.current = JSON.stringify(updated);
          return updated;
        });
      }
    }, 650);
    return () => window.clearTimeout(timer);
  }, [generationSettings]);
  const saveExtensionMessageByIndex = async (index: number, content: string, expectedMessageId?: string) => {
    const chat = activeChatRef.current;
    const card = activeCardRef.current;
    const messageIndex = expectedMessageId && chat ? chat.messages.findIndex((item) => item.id === expectedMessageId) : index;
    const message = chat?.messages[messageIndex];
    if (!chat || !card || !message || message.content === content) {
      return;
    }
    const response = await fetch(`/api/cards/${card.id}/chats/${chat.id}/messages/${message.id}`, {
      method: 'PUT',
      headers: authJsonHeaders(),
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      addToast(t('extensions.error.saveMessage'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
    window.setTimeout(() => {
      setExtensionMessageRenderVersions((current) => ({ ...current, [message.id]: (current[message.id] || 0) + 1 }));
      setActiveChat((current) => current?.id === data.chat.id ? { ...current, messages: [...current.messages] } : current);
    }, 0);
    if (!activeGenerationRef.current) {
      setIsGenerating(false);
      setGenerationStatus('');
    }
    const nextIndex = data.chat.messages.findIndex((item) => item.id === message.id);
    if (nextIndex >= 0) {
      void emitSillyTavernMessageSwiped(nextIndex);
    }
  };

  const chatDeleteLockId = (cardId: string, chatId: string) => `${cardId}:${chatId}`;
  const isDeleteLocked = (category: keyof DeletionLocks, itemId: string) => deletionLocks[category].includes(itemId);

  const loadDeleteLocks = async () => {
    const response = await fetch('/api/delete-locks', { headers: actorHeaders() });
    if (!response.ok) {
      return;
    }
    const data = await response.json() as { delete_locks: DeletionLocks };
    setDeletionLocks({ ...defaultDeletionLocks, ...data.delete_locks });
  };

  const loadCurrentUser = async (token = authToken) => {
    const response = await fetch('/api/auth/me', {
      headers: actorHeaders(token),
    });
    if (!response.ok) {
      if (!cookieAuth) {
        setAuthToken('');
      }
      return;
    }
    const data = await response.json() as { user: AuthUser | null };
    setAuthUser(data.user);
  };

  const submitAuth = async (mode: 'login' | 'register') => {
    const response = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({ username: authDraft.username, password: authDraft.password }),
    });
    const data = await response.json().catch(() => null) as { token?: string; user?: AuthUser; detail?: string } | null;
    if (!response.ok || !data?.token) {
      setAuthMessage(data?.detail || t('auth.error.login'));
      return;
    }
    authTokenRef.current = data.token;
    setAuthToken(data.token);
    setAuthUser(data.user || null);
    setAuthDraft({ ...authDraft, password: '' });
    window.localStorage.setItem(AUTH_USERNAME_STORAGE_KEY, authDraft.username);
    setAuthMessage(mode === 'login' ? t('auth.loggedIn') : t('auth.userCreated'));
    await Promise.all([refreshLibrary(), loadGenerationSettings(), loadConnectionPresets(), loadPresetTypes(), loadLorebooks()]);
    sendPresence(selectedPersona);
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: actorHeaders() });
    authTokenRef.current = '';
    setAuthToken('');
    setAuthUser(null);
    setAuthMessage(t('auth.loggedOut'));
    await Promise.all([refreshLibrary(), loadGenerationSettings(), loadConnectionPresets(), loadPresetTypes(), loadLorebooks()]);
    sendPresence(selectedPersona);
  };

  const claimAdmin = async () => {
    const response = await fetch('/api/auth/claim-admin', {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({ code: authDraft.adminCode }),
    });
    const data = await response.json().catch(() => null) as { user?: AuthUser; detail?: string } | null;
    if (!response.ok || !data?.user) {
      setAuthMessage(data?.detail || t('auth.error.claimAdmin'));
      return;
    }
    setAuthUser(data.user);
    setAuthDraft({ ...authDraft, adminCode: '' });
    setAuthMessage(t('auth.adminEnabled'));
    sendPresence(selectedPersona);
  };

  const loadSecurityPermissions = async () => {
    try {
      const response = await fetch('/api/security/permissions');
      if (!response.ok) {
        return;
      }
      const data = await response.json() as { auth_required?: boolean; registration_allowed?: boolean; bot_reply_allowed?: boolean; access_password_required?: boolean; access_password_configured?: boolean; permissions: SecurityPermissions };
      setAuthRequired(Boolean(data.auth_required));
      setRegistrationAllowed(data.registration_allowed !== false);
      setBotReplyAllowed(data.bot_reply_allowed !== false);
      setAccessPasswordRequired(Boolean(data.access_password_required));
      setSecurityAccessPasswordRequiredDraft(Boolean(data.access_password_required));
      setAccessPasswordConfigured(Boolean(data.access_password_configured));
      if (!data.access_password_required) {
        setAccessUnlocked(true);
      } else if (accessToken) {
        await verifyAccessPasswordToken(accessToken);
      }
      setSecurityPermissions({ ...defaultSecurityPermissions, ...data.permissions });
      lastSavedSecurityRef.current = {
        authRequired: Boolean(data.auth_required),
        registrationAllowed: data.registration_allowed !== false,
        botReplyAllowed: data.bot_reply_allowed !== false,
        securityAccessPasswordRequiredDraft: Boolean(data.access_password_required),
        securityAccessPasswordDraft: '',
        permissionsHash: JSON.stringify({ ...defaultSecurityPermissions, ...data.permissions }),
      };
      setSecurityDirty(false);
    } finally {
      setAuthChecked(true);
    }
  };

  const verifyAccessPasswordToken = async (token = accessToken) => {
    const response = await fetch('/api/security/access', { headers: token ? { 'X-DoubleTrouble-Access': token } : {} });
    const data = await response.json().catch(() => null) as { required?: boolean; unlocked?: boolean } | null;
    const required = Boolean(data?.required);
    setAccessPasswordRequired(required);
    setSecurityAccessPasswordRequiredDraft(required);
    setAccessUnlocked(!required || Boolean(data?.unlocked));
    if (required && !data?.unlocked && token) {
      setAccessToken('');
    }
  };

  const unlockAccessPassword = async () => {
    const response = await fetch('/api/security/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: accessPasswordDraft }),
    });
    const data = await response.json().catch(() => null) as { token?: string; detail?: string } | null;
    if (!response.ok || !data?.token) {
      setAccessPasswordMessage(data?.detail || t('auth.error.accessPassword'));
      return;
    }
    setAccessToken(data.token);
    setAccessUnlocked(true);
    setAccessPasswordDraft('');
    setAccessPasswordMessage(t('auth.accessUnlocked'));
    await Promise.all([refreshLibrary(), loadGenerationSettings(), loadConnectionPresets(), loadPresetTypes(), loadLorebooks(), loadDeleteLocks(), loadCurrentUser()]);
  };

  const saveSecurityPermissions = async () => {
    const nextAccessPasswordRequired = securityAccessPasswordRequiredDraft;
    if (nextAccessPasswordRequired && !accessPasswordConfigured && securityAccessPasswordDraft.trim().length < 4) {
      setAuthMessage(t('auth.error.passwordTooShort'));
      return;
    }
    const response = await fetch('/api/security/permissions', {
      method: 'PUT',
      headers: authJsonHeaders(),
      body: JSON.stringify({
        auth_required: authRequired,
        registration_allowed: registrationAllowed,
        bot_reply_allowed: botReplyAllowed,
        access_password_required: nextAccessPasswordRequired,
        access_password: securityAccessPasswordDraft,
        permissions: securityPermissions,
      }),
    });
    const data = await response.json().catch(() => null) as { auth_required?: boolean; registration_allowed?: boolean; bot_reply_allowed?: boolean; access_password_required?: boolean; access_password_configured?: boolean; permissions?: SecurityPermissions; detail?: string } | null;
    if (!response.ok || !data?.permissions) {
      setAuthMessage(data?.detail || t('auth.error.savePermissions'));
      return;
    }
    setAuthRequired(Boolean(data.auth_required));
    setRegistrationAllowed(data.registration_allowed !== false);
    setBotReplyAllowed(data.bot_reply_allowed !== false);
    setAccessPasswordRequired(Boolean(data.access_password_required));
    setSecurityAccessPasswordRequiredDraft(Boolean(data.access_password_required));
    setAccessPasswordConfigured(Boolean(data.access_password_configured));
    if (!data.access_password_required) {
      setAccessUnlocked(true);
    } else {
      setAccessToken('');
      setAccessUnlocked(false);
    }
    setSecurityPermissions({ ...defaultSecurityPermissions, ...data.permissions });
    setSecurityAccessPasswordDraft('');
    lastSavedSecurityRef.current = {
      authRequired: Boolean(data.auth_required),
      registrationAllowed: data.registration_allowed !== false,
      botReplyAllowed: data.bot_reply_allowed !== false,
      securityAccessPasswordRequiredDraft: Boolean(data.access_password_required),
      securityAccessPasswordDraft: '',
      permissionsHash: JSON.stringify({ ...defaultSecurityPermissions, ...data.permissions }),
    };
    setSecurityDirty(false);
    setAuthMessage(t('security.saved'));
  };

  const refreshLibrary = async () => {
    const [cardsResponse, personasResponse] = await Promise.all([authedFetch('/api/cards'), authedFetch('/api/personas')]);
    if (cardsResponse.ok) {
      const data = await cardsResponse.json() as { cards: CharacterCard[] };
      markAccessDenied('cards', false);
      setCards(data.cards);
      void restoreLastSelection(data.cards);
    } else if (deniedResponse(cardsResponse)) {
      markAccessDenied('cards', true);
      setCards([]);
      setActiveCard(null);
      setActiveChat(null);
      setBotChats([]);
    }
    if (personasResponse.ok) {
      const data = await personasResponse.json() as { personas: Persona[] };
      markAccessDenied('personas', false);
      personasLoadedRef.current = true;
      personasRef.current = data.personas;
      setPersonas(data.personas);
      const currentId = selectedPersonaIdRef.current || window.localStorage.getItem(SELECTED_PERSONA_STORAGE_KEY) || '';
      const participantPersonaId = lastKnownParticipantPersonaIdRef.current;
      const participantPersona = data.personas.find((persona) => persona.id === participantPersonaId);
      if (participantPersona && !participantPersonaRestoredRef.current) {
        participantPersonaRestoredRef.current = true;
        applySelectedPersonaId(participantPersona.id);
      } else if (!data.personas.some((persona) => persona.id === currentId)) {
        const nextPersona = data.personas.find((persona) => persona.active) || data.personas[0];
        if (nextPersona) {
          applySelectedPersonaId(nextPersona.id);
        }
      }
    } else if (deniedResponse(personasResponse)) {
      markAccessDenied('personas', true);
      personasLoadedRef.current = false;
      personasRef.current = [];
      setPersonas([]);
    }
  };

  const loadGenerationSettings = async () => {
    const response = await authedFetch('/api/generation/settings');
    if (!response.ok) {
      return;
    }
    const data = await response.json() as Partial<GenerationSettings>;
    const nextSettings = { ...defaultGenerationSettings, ...data, api_key: '', clear_api_key: false, proxy_password: '', clear_proxy_password: false };
    generationSettingsSaveSignatureRef.current = JSON.stringify(nextSettings);
    generationSettingsLoadedRef.current = true;
    setGenerationSettings(nextSettings);
  };

  const loadConnectionPresets = async () => {
    const response = await authedFetch('/api/generation/presets');
    if (!response.ok) {
      if (deniedResponse(response)) {
        markAccessDenied('presets', true);
        setConnectionPresets([]);
        setActiveConnectionPresetName('');
      }
      return;
    }
    const data = await response.json() as { presets: ConnectionPreset[]; active?: string };
    markAccessDenied('presets', false);
    setConnectionPresets(data.presets);
    setActiveConnectionPresetName(data.active || '');
  };

  const loadPresetTypes = async (openActivePreset = true) => {
    const [typesResponse, activeResponse] = await Promise.all([authedFetch('/api/presets/types'), authedFetch('/api/presets/active')]);
    let active: Record<string, string> = {};
    if (typesResponse.ok) {
      const data = await typesResponse.json() as { types: PresetTypeInfo[] };
      markAccessDenied('presets', false);
      setPresetTypes(data.types);
    }
    if (activeResponse.ok) {
      const data = await activeResponse.json() as { active: Record<string, string> };
      markAccessDenied('presets', false);
      active = data.active;
      setActivePresets(active);
    }
    if (deniedResponse(typesResponse) || deniedResponse(activeResponse)) {
      markAccessDenied('presets', true);
      setPresetTypes([]);
      setPresets([]);
      setSelectedPresetName('');
      setPresetNameDraft('');
      setPresetJsonDraft('{}');
      return;
    }
    const currentPresetType = selectedPresetTypeRef.current || selectedPresetType;
    if (!openActivePreset) {
      return;
    }
    await loadPresets(currentPresetType, active[currentPresetType]);
  };

  const loadActivePresetDraft = async () => {
    const presetType = selectedPresetTypeRef.current || selectedPresetType;
    const response = await authedFetch(`/api/presets/${encodeURIComponent(presetType)}/active-draft`);
    if (!response.ok) {
      return;
    }
    const data = await response.json() as { active?: Record<string, string>; name?: string; preset?: Record<string, unknown> };
    if (data.active) {
      setActivePresets(data.active);
    }
    if (!data.preset || !Object.keys(data.preset).length) {
      return;
    }
    const name = data.name || data.active?.[presetType] || selectedPresetName || 'unsaved';
    const draft = JSON.stringify(data.preset, null, 2);
    activePresetDraftSignatureRef.current = `${presetType}:${name}:${draft}`;
    setSelectedPresetName(name);
    setPresetNameDraft(name);
    setPresetJsonDraft(draft);
  };

  const loadPresets = async (presetType: string, presetToOpen = '') => {
    const response = await authedFetch(`/api/presets/${encodeURIComponent(presetType)}`);
    if (!response.ok) {
      if (deniedResponse(response)) {
        markAccessDenied('presets', true);
        setPresets([]);
        setSelectedPresetName('');
        setPresetNameDraft('');
        setPresetJsonDraft('{}');
      }
      setPresetMessage(t('presets.error.load'));
      return;
    }
    const data = await response.json() as { presets: PresetSummary[] };
    markAccessDenied('presets', false);
    setPresets(data.presets);
    if (presetToOpen && data.presets.some((preset) => preset.name === presetToOpen)) {
      await openPreset(presetType, presetToOpen, false);
    }
  };

  const changePresetType = async (presetType: string) => {
    setSelectedPresetType(presetType);
    setSelectedPresetName('');
    setPresetNameDraft('');
    setPresetJsonDraft('{}');
    await loadPresets(presetType, activePresets[presetType] || '');
  };

  const openPreset = async (presetType: string, name: string, apply: boolean, token = authToken) => {
    if (!name) {
      return;
    }
    const response = await authedFetch(`/api/presets/${encodeURIComponent(presetType)}/${encodeURIComponent(name)}`);
    if (!response.ok) {
      if (deniedResponse(response)) {
        markAccessDenied('presets', true);
        setSelectedPresetName('');
        setPresetNameDraft('');
        setPresetJsonDraft('{}');
      }
      setPresetMessage(t('presets.error.open'));
      return;
    }
    const data = await response.json() as { preset: unknown };
    markAccessDenied('presets', false);
    setSelectedPresetName(name);
    setPresetNameDraft(name);
    setPresetJsonDraft(JSON.stringify(data.preset, null, 2));
    if (!apply) {
      return;
    }
    const applyResponse = await fetch(`/api/presets/${encodeURIComponent(presetType)}/${encodeURIComponent(name)}/apply`, { method: 'POST', headers: actorHeaders() });
    if (applyResponse.ok) {
      const applied = await applyResponse.json() as { active: Record<string, string>; settings: Partial<GenerationSettings> };
      setActivePresets(applied.active);
      setGenerationSettings({ ...generationSettings, ...applied.settings, api_key: '', clear_api_key: false, proxy_password: '', clear_proxy_password: false });
    }
  };

  const selectPreset = async (name: string) => {
    await openPreset(selectedPresetType, name, true);
  };

  const savePreset = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(presetJsonDraft) as Record<string, unknown>;
    } catch {
      setPresetMessage(t('presets.error.json'));
      return;
    }
    const name = presetNameDraft.trim() || selectedPresetName;
    if (!name) {
      setPresetMessage(t('presets.error.name'));
      return;
    }
    const response = await fetch(`/api/presets/${encodeURIComponent(selectedPresetType)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...actorHeaders() },
      body: JSON.stringify({ name, preset: parsed }),
    });
    if (!response.ok) {
      setPresetMessage(t('presets.error.save'));
      return;
    }
    setPresetMessage(t('presets.saved'));
    await syncActivePresetDraft(JSON.stringify(parsed, null, 2));
    await loadPresets(selectedPresetType, name);
  };

  const importPreset = async (file: File | null) => {
    if (!file) {
      return;
    }
    const body = new FormData();
    body.append('file', file);
    const response = await fetch(`/api/presets/${encodeURIComponent(selectedPresetType)}/import`, { method: 'POST', headers: actorHeaders(), body });
    if (!response.ok) {
      setPresetMessage(t('presets.error.import'));
      return;
    }
    const data = await response.json() as { preset?: PresetSummary };
    const importedName = data.preset?.name;
    setPresetMessage(importedName ? `${t('presets.imported')}: ${importedName}` : t('presets.imported'));
    await loadPresets(selectedPresetType);
    if (importedName) {
      await selectPreset(importedName);
    }
  };

  const applyPreset = async () => {
    if (!selectedPresetName) {
      setPresetMessage(t('presets.error.selectFirst'));
      return;
    }
    const response = await fetch(`/api/presets/${encodeURIComponent(selectedPresetType)}/${encodeURIComponent(selectedPresetName)}/apply`, { method: 'POST', headers: actorHeaders() });
    if (!response.ok) {
      setPresetMessage(t('presets.error.apply'));
      return;
    }
    const data = await response.json() as { active: Record<string, string>; settings: Partial<GenerationSettings> };
    setActivePresets(data.active);
    setGenerationSettings({ ...generationSettings, ...data.settings, api_key: '', clear_api_key: false, proxy_password: '', clear_proxy_password: false });
    setPresetMessage(t('presets.applied'));
  };

  const deletePreset = async () => {
    if (!selectedPresetName) {
      return;
    }
    const response = await fetch(`/api/presets/${encodeURIComponent(selectedPresetType)}/${encodeURIComponent(selectedPresetName)}`, { method: 'DELETE', headers: actorHeaders() });
    if (!response.ok) {
      setPresetMessage(t('presets.error.delete'));
      return;
    }
    setSelectedPresetName('');
    setPresetNameDraft('');
    setPresetJsonDraft('{}');
    setPresetMessage(t('presets.deleted'));
    await loadPresets(selectedPresetType);
  };

  const importSillyTavernDefaults = async () => {
    const body = new FormData();
    body.append('source_root', 'E:/ST/SillyTavern/default/content');
    const response = await fetch('/api/presets/import-sillytavern-defaults', { method: 'POST', headers: actorHeaders(), body });
    const data = await response.json().catch(() => null) as { copied?: number } | null;
    setPresetMessage(response.ok ? `${t('presets.importedDefaults')}: ${data?.copied ?? 0}` : t('presets.error.importST'));
    await loadPresets(selectedPresetType);
  };

  const exportPreset = async () => {
    if (!selectedPresetName) {
      setPresetMessage(t('presets.error.selectFirst'));
      return;
    }
    const response = await fetch(`/api/presets/${encodeURIComponent(selectedPresetType)}/${encodeURIComponent(selectedPresetName)}/export`, { headers: actorHeaders() });
    if (!response.ok) {
      setPresetMessage(t('presets.error.export'));
      return;
    }
    await downloadResponse(response, `${selectedPresetName}.json`);
    setPresetMessage(t('presets.exported'));
  };

  const loadLorebooks = async () => {
    const response = await authedFetch('/api/lorebooks');
    if (!response.ok) {
      if (deniedResponse(response)) {
        markAccessDenied('lorebooks', true);
        setLorebooks([]);
        setLorebookBindings([]);
      }
      return;
    }
    const data = await response.json() as { lorebooks: LorebookSummary[]; bindings: LorebookBinding[] };
    markAccessDenied('lorebooks', false);
    setLorebooks(data.lorebooks);
    setLorebookBindings(data.bindings);
  };

  const reloadSelectedLorebook = async () => {
    const name = selectedLorebookNameRef.current;
    if (!name) {
      return;
    }
    const response = await authedFetch(`/api/lorebooks/${encodeURIComponent(name)}`);
    if (response.ok) {
      const data = await response.json() as { book: unknown };
      setLorebookNameDraft(name);
      setLorebookBindingDraft((current) => ({ ...current, book: name }));
      setLorebookJsonDraft(JSON.stringify(data.book, null, 2));
      return;
    }
    if (response.status === 404) {
      setSelectedLorebookName('');
      setLorebookNameDraft('');
      setLorebookJsonDraft('{\n  "entries": {}\n}');
    }
  };


  const loadSummaryMemorySettings = async () => {
    const response = await authedFetch('/api/settings/memory');
    if (!response.ok) return;
    const data = await response.json() as Partial<SummaryMemorySettings>;
    setSummaryMemorySettings((current) => ({ ...current, ...data, api_key: '', clear_api_key: false }));
  };

  const saveSummaryMemorySettings = async (override?: Partial<SummaryMemorySettings>) => {
    const payload = { ...summaryMemorySettings, ...override };
    const response = await fetch('/api/settings/memory', {
      method: 'PUT',
      headers: authJsonHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      setSummaryStatusMessage('Ошибка сохранения настроек памяти');
      return;
    }
    const data = await response.json() as Partial<SummaryMemorySettings>;
    setSummaryMemorySettings((current) => ({ ...current, ...data, api_key: '', clear_api_key: false }));
    setSummaryStatusMessage('Настройки памяти сохранены');
  };

  const fetchSummaryModels = async () => {
    setSummaryStatusMessage('Загрузка списка моделей саммари…');
    const response = await fetch('/api/settings/memory/models', {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify(summaryMemorySettings),
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; models?: unknown; error?: string } | null;
    if (!response.ok || !data?.ok) {
      setSummaryStatusMessage(data?.error || 'Не удалось получить модели с API саммари');
      return;
    }
    const modelNames = extractModelNames(data.models);
    if (modelNames.length) {
      setSummaryModels(modelNames);
      if (!summaryMemorySettings.model) {
        setSummaryMemorySettings((current) => ({ ...current, model: modelNames[0] || '' }));
      }
      setSummaryStatusMessage(`Найдено моделей: ${modelNames.length}`);
    } else {
      setSummaryStatusMessage(data.error || 'Модели не найдены');
    }
  };

  const loadRooms = async () => {
    const response = await authedFetch('/api/rooms');
    if (!response.ok) return;
    const data = await response.json() as { rooms: RoomInfo[] };
    if (Array.isArray(data.rooms)) {
      setRoomsList(data.rooms);
    }
  };

  const switchRoom = (nextRoomId: string) => {
    const clean = (nextRoomId || 'default').trim().replace(/[^a-zA-Z0-9_\-\u0400-\u04FF]/g, '-') || 'default';
    currentRoomIdRef.current = clean;
    window.localStorage.setItem('doubletrouble.roomId', clean);
    const url = new URL(window.location.href);
    if (clean === 'default') {
      url.searchParams.delete('room');
    } else {
      url.searchParams.set('room', clean);
    }
    window.history.replaceState({}, '', url.toString());
    setCurrentRoomId(clean);
    setRoomInputDraft('');
    addToast(`Комната переключена: ${clean}`);
    void loadRooms();
  };
  const refreshSharedSettings = async (section = '') => {
    const now = Date.now();
    if (section && now - (lastLocalSettingsSaveRef.current[section] || 0) < 3500) {
      return;
    }
    if (section === 'cards' || section === 'personas' || section === 'library') {
      await refreshLibrary();
      return;
    }
    if (section === 'generation') {
      await Promise.all([loadGenerationSettings(), loadConnectionPresets()]);
      return;
    }
    if (section === 'presets') {
      await Promise.all([loadGenerationSettings(), loadConnectionPresets(), loadPresetTypes(false)]);
      await loadActivePresetDraft();
      return;
    }
    if (section === 'lorebooks') {
      await loadLorebooks();
      await reloadSelectedLorebook();
      return;
    }
    if (section === 'keys') {
      await loadGenerationSettings();
      return;
    }
    if (section === 'extensions') {
      void syncSillyTavernExtensions();
      return;
    }
    if (section === 'extension_settings') {
      void syncServerExtensionSettings();
      return;
    }
    if (section === 'memory') {
      await loadSummaryMemorySettings();
      return;
    }
    await Promise.all([refreshLibrary(), loadGenerationSettings(), loadConnectionPresets(), loadPresetTypes(), loadLorebooks(), loadSummaryMemorySettings(), loadRooms()]);
    await reloadSelectedLorebook();
  };

  const openLorebook = async (name: string) => {
    if (!name) {
      return;
    }
    const response = await authedFetch(`/api/lorebooks/${encodeURIComponent(name)}`);
    if (!response.ok) {
      setLorebookMessage(t('lorebooks.error.open'));
      return;
    }
    const data = await response.json() as { book: unknown };
    setSelectedLorebookName(name);
    setLorebookNameDraft(name);
    setLorebookBindingDraft({ ...lorebookBindingDraft, book: name });
    setLorebookJsonDraft(JSON.stringify(data.book, null, 2));
  };

  const saveLorebook = async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(lorebookJsonDraft) as Record<string, unknown>;
    } catch {
      setLorebookMessage(t('lorebooks.error.json'));
      return;
    }
    const name = lorebookNameDraft.trim() || selectedLorebookName;
    if (!name) {
      setLorebookMessage(t('lorebooks.error.name'));
      return;
    }
    const response = await fetch('/api/lorebooks', { method: 'PUT', headers: authJsonHeaders(), body: JSON.stringify({ name, book: parsed }) });
    if (!response.ok) {
      setLorebookMessage(t('lorebooks.error.save'));
      return;
    }
    setLorebookMessage(t('lorebooks.saved'));
    await loadLorebooks();
    await openLorebook(name);
  };

  const importLorebook = async (file: File | null) => {
    if (!file) {
      return;
    }
    const body = new FormData();
    body.append('file', file);
    const response = await fetch('/api/lorebooks/import', { method: 'POST', headers: actorHeaders(), body });
    if (!response.ok) {
      setLorebookMessage(t('lorebooks.error.import'));
      return;
    }
    const data = await response.json() as { lorebook?: LorebookSummary };
    await loadLorebooks();
    if (data.lorebook?.name) {
      await openLorebook(data.lorebook.name);
    }
    setLorebookMessage(t('lorebooks.imported'));
  };

  const exportLorebook = async () => {
    if (!selectedLorebookName) {
      setLorebookMessage(t('lorebooks.error.selectFirst'));
      return;
    }
    const response = await fetch(`/api/lorebooks/${encodeURIComponent(selectedLorebookName)}/export`, { headers: actorHeaders() });
    if (!response.ok) {
      setLorebookMessage(t('lorebooks.error.export'));
      return;
    }
    await downloadResponse(response, `${selectedLorebookName}.json`);
    setLorebookMessage(t('lorebooks.exported'));
  };

  const deleteLorebook = async () => {
    if (!selectedLorebookName || !window.confirm(`${t('lorebooks.deleteConfirm')}"${selectedLorebookName}"?`)) {
      return;
    }
    const response = await fetch(`/api/lorebooks/${encodeURIComponent(selectedLorebookName)}`, { method: 'DELETE', headers: actorHeaders() });
    if (!response.ok) {
      setLorebookMessage(t('lorebooks.error.delete'));
      return;
    }
    setSelectedLorebookName('');
    setLorebookNameDraft('');
    setLorebookJsonDraft('{\n  "entries": {}\n}');
    await loadLorebooks();
  };

  const saveLorebookBindings = async (bindings = lorebookBindings) => {
    const response = await fetch('/api/lorebooks/bindings', { method: 'PUT', headers: authJsonHeaders(), body: JSON.stringify({ bindings }) });
    if (!response.ok) {
      setLorebookMessage(t('lorebooks.error.saveBindings'));
      return;
    }
    const data = await response.json() as { bindings: LorebookBinding[] };
    setLorebookBindings(data.bindings);
    setLorebookMessage(t('lorebooks.bindingsSaved'));
    await loadLorebooks();
  };

  const addLorebookBinding = async () => {
    const book = lorebookBindingDraft.book || selectedLorebookName;
    if (!book) {
      setLorebookMessage(t('lorebooks.error.selectBook'));
      return;
    }
    const binding = { ...lorebookBindingDraft, book, target_id: lorebookBindingDraft.target_type === 'global' ? '' : lorebookBindingDraft.target_id };
    await saveLorebookBindings([...lorebookBindings, binding]);
  };

  const removeLorebookBinding = async (index: number) => {
    await saveLorebookBindings(lorebookBindings.filter((_, itemIndex) => itemIndex !== index));
  };

  const lastChatByCard = () => {
    try {
      return JSON.parse(window.localStorage.getItem(LAST_CHAT_BY_CARD_STORAGE_KEY) || '{}') as Record<string, string>;
    } catch {
      return {};
    }
  };

  const rememberChatSelection = (cardId: string, chatId: string) => {
    const map = lastChatByCard();
    map[cardId] = chatId;
    window.localStorage.setItem(LAST_CARD_STORAGE_KEY, cardId);
    window.localStorage.setItem(LAST_CHAT_BY_CARD_STORAGE_KEY, JSON.stringify(map));
  };

  const forgetChatSelection = (cardId: string, chatId: string) => {
    const map = lastChatByCard();
    if (map[cardId] === chatId) {
      delete map[cardId];
      window.localStorage.setItem(LAST_CHAT_BY_CARD_STORAGE_KEY, JSON.stringify(map));
    }
  };

  const openChatForCard = async (card: CharacterCard, chatId: string) => {
    const response = await authedFetch(`/api/cards/${encodeURIComponent(card.id)}/chats/${encodeURIComponent(chatId)}`);
    if (!response.ok) {
      if (deniedResponse(response)) {
        markAccessDenied('chats', true);
        setActiveChat(null);
        setBotChats([]);
        setChatPickerOpen(false);
      }
      return false;
    }
    const data = await response.json() as { chat: BotChat };
    markAccessDenied('chats', false);
    setActiveCard(card);
    setActiveChat(data.chat);
    setChatPickerOpen(false);
    rememberChatSelection(card.id, data.chat.id);
    await refreshCardChats(card.id);
    return true;
  };

  const refreshAccessControlledData = async () => {
    await Promise.all([refreshLibrary(), loadConnectionPresets(), loadPresetTypes(), loadLorebooks()]);
    const card = activeCardRef.current;
    const chat = activeChatRef.current;
    if (card) {
      await refreshCardChats(card.id);
    }
    if (card && chat) {
      await openChatForCard(card, chat.id);
    }
  };

  const restoreLastSelection = async (availableCards: CharacterCard[]) => {
    if (restoredSelectionRef.current) {
      return;
    }
    restoredSelectionRef.current = true;
    const sessionTarget = sessionActiveTargetRef.current;
    if (sessionTarget.cardId) {
      const sessionCard = availableCards.find((item) => item.id === sessionTarget.cardId);
      if (sessionCard) {
        if (sessionTarget.chatId && await openChatForCard(sessionCard, sessionTarget.chatId)) {
          return;
        }
        await selectBotCard(sessionCard, false);
        return;
      }
    }
    const lastCardId = window.localStorage.getItem(LAST_CARD_STORAGE_KEY) || '';
    const card = availableCards.find((item) => item.id === lastCardId) || availableCards[0];
    if (card) {
      await selectBotCard(card, false);
    }
  };

  const saveGenerationSettings = async () => {
    const name = connectionPresetName.trim();
    if (!name) {
      setConnectionMessage(t('connection.error.presetName'));
      return;
    }
    setConnectionMessage(t('connection.saving'));
    const response = await fetch('/api/generation/presets', {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({ name, settings: generationSettings }),
    });
    if (!response.ok) {
      setConnectionMessage(t('connection.error.saveConnection'));
      return;
    }
    const data = await response.json() as { settings: Partial<GenerationSettings> };
    setGenerationSettings({ ...generationSettings, ...data.settings, api_key: '', clear_api_key: false, proxy_password: '', clear_proxy_password: false });
    setConnectionPresetName('');
    await loadConnectionPresets();
    setConnectionMessage(t('connection.savedToPreset'));
  };

  const applyConnectionPreset = async (presetName: string) => {
    const preset = connectionPresets.find((item) => item.name === presetName);
    if (!preset) {
      return;
    }
    const response = await fetch(`/api/generation/presets/${encodeURIComponent(presetName)}/active`, { method: 'POST', headers: actorHeaders() });
    if (!response.ok) {
      setConnectionMessage(t('connection.error.selectConnectionPreset'));
      return;
    }
    const data = await response.json() as { settings: Partial<GenerationSettings>; active: string };
    setGenerationSettings({ ...generationSettings, ...data.settings, api_key: '', clear_api_key: false, proxy_password: '', clear_proxy_password: false });
    setActiveConnectionPresetName(data.active);
    setConnectionMessage(`${t('connection.presetSelected')}: ${preset.name}`);
  };

  const deleteConnectionPreset = async (presetName: string) => {
    if (!presetName) {
      return;
    }
    const response = await fetch(`/api/generation/presets/${encodeURIComponent(presetName)}`, { method: 'DELETE', headers: actorHeaders() });
    if (!response.ok) {
      setConnectionMessage(t('connection.error.deleteConnectionPreset'));
      return;
    }
    const data = await response.json().catch(() => null) as { active?: string } | null;
    setActiveConnectionPresetName(data?.active || '');
    await loadConnectionPresets();
    setConnectionMessage(t('connection.presetDeleted'));
  };

  const checkConnection = async () => {
    setConnectionMessage(t('connection.checking'));
    const response = await fetch('/api/generation/models', {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify(generationSettings),
    });
    const data = await response.json().catch(() => null) as { ok?: boolean; error?: string; models?: unknown } | null;
    if (!response.ok || !data?.ok) {
      setConnectionMessage(data?.error || t('connection.providerUnavailable'));
      return;
    }
    const modelNames = extractModelNames(data.models);
    setModels(modelNames);
    setConnectionMessage(modelNames.length ? `${t('connection.modelsFound')}: ${modelNames.length}` : t('connection.emptyModelList'));
  };

  const refreshCardChats = async (cardId: string) => {
    const response = await authedFetch(`/api/cards/${encodeURIComponent(cardId)}/chats`);
    if (response.ok) {
      const data = await response.json() as { chats: BotChatSummary[] };
      markAccessDenied('chats', false);
      setBotChats(data.chats);
      return true;
    }
    if (deniedResponse(response)) {
      markAccessDenied('chats', true);
      setBotChats([]);
      setActiveChat(null);
      setChatPickerOpen(false);
    }
    return false;
  };

  const importCard = async (file: File | null) => {
    if (!file) {
      return;
    }
    const body = new FormData();
    body.append('file', file);
    setLibraryMessage(t('cards.importing'));
    const response = await fetch('/api/cards/import', { method: 'POST', headers: actorHeaders(), body });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { detail?: string } | null;
      setLibraryMessage(error?.detail || t('cards.error.import'));
      return;
    }
    const importedData = await response.json().catch(() => null) as { card?: CharacterCard; regex_scripts?: RegexScript[] } | null;
    if (importedData?.card?.id && Array.isArray(importedData.regex_scripts) && importedData.regex_scripts.length) {
      setRegexContext(importedData.card.id, activeConnectionPresetName, generationSettings.chat_completion_source || generationSettings.provider || 'openai');
      saveScriptsByType(importedData.regex_scripts, SCRIPT_TYPES.SCOPED);
      allowScopedScripts();
    }
    setLibraryMessage(t('cards.imported'));
    await refreshLibrary();
  };
  const createCard = async () => {
    const name = cardDraft.name.trim();
    if (!name) {
      setLibraryMessage(t('cards.error.name'));
      return;
    }
    const body = new FormData();
    body.append('name', name);
    body.append('description', cardDraft.description);
    body.append('personality', cardDraft.personality);
    body.append('scenario', cardDraft.scenario);
    body.append('first_message', cardDraft.firstMessage);
    cardDraft.alternateGreetings.filter((greeting) => greeting.trim()).forEach((greeting) => body.append('alternate_greetings', greeting));
    body.append('message_example', cardDraft.messageExample);
    body.append('creator', cardDraft.creator);
    body.append('tags', cardDraft.tags);
    if (cardAvatar) {
      body.append('avatar', cardAvatar);
    }
    setLibraryMessage(t('cards.creating'));
    const response = await fetch('/api/cards', { method: 'POST', headers: actorHeaders(), body });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { detail?: string } | null;
      setLibraryMessage(error?.detail || t('cards.error.create'));
      return;
    }
    setCardDraft(emptyCardDraft);
    setCardAvatar(null);
    setLibraryMessage(t('cards.created'));
    await refreshLibrary();
  };

  const updateCard = async (cardId: string, draft: CardDraft) => {
    const name = draft.name.trim();
    if (!name) {
      setLibraryMessage(t('cards.error.name'));
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...actorHeaders() },
      body: JSON.stringify({
        name,
        description: draft.description,
        personality: draft.personality,
        scenario: draft.scenario,
        first_message: draft.firstMessage,
        alternate_greetings: draft.alternateGreetings.filter((greeting) => greeting.trim()),
        message_example: draft.messageExample,
        creator: draft.creator,
        tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { detail?: string } | null;
      setLibraryMessage(error?.detail || t('cards.error.save'));
      return;
    }
    const data = await response.json() as { card: CharacterCard };
    setCards((current) => current.map((card) => card.id === data.card.id ? data.card : card));
    if (activeCard?.id === data.card.id) {
      setActiveCard(data.card);
    }
    setLibraryMessage(t('cards.saved'));
  };

  const deleteCard = async (card: CharacterCard) => {
    if (isDeleteLocked('cards', card.id)) {
      setLibraryMessage(t('cards.error.deleteLocked'));
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}`, { method: 'DELETE', headers: actorHeaders() });
    if (!response.ok) {
      setLibraryMessage(t('cards.error.delete'));
      return;
    }
    setCards((current) => current.filter((item) => item.id !== card.id));
    if (activeCard?.id === card.id) {
      setActiveCard(null);
      setActiveChat(null);
      setBotChats([]);
    }
    setLibraryMessage(t('cards.deleted'));
  };

  const uploadCardAvatar = async (card: CharacterCard, file: File | null) => {
    if (!file) {
      return;
    }
    const body = new FormData();
    body.append('file', file);
    const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}/avatar`, { method: 'POST', headers: actorHeaders(), body });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { detail?: string } | null;
      setLibraryMessage(error?.detail || t('cards.error.avatar'));
      return;
    }
    const data = await response.json() as { card: CharacterCard };
    setCards((current) => current.map((item) => item.id === data.card.id ? data.card : item));
    if (activeCard?.id === data.card.id) {
      setActiveCard(data.card);
    }
    setLibraryMessage(t('cards.avatarUpdated'));
  };

  const selectBotCard = async (card: CharacterCard, notify = true) => {
    const rememberedChatId = lastChatByCard()[card.id];
    if (rememberedChatId && await openChatForCard(card, rememberedChatId)) {
      setLibraryMessage(`${t('chat.openedLast')}: ${card.name}`);
      if (notify) {
        sendRealtimeEvent({ type: 'card.select', card_id: card.id, chat_id: rememberedChatId, participant_id: participantIdRef.current, name: card.name, persona_name: selectedPersona?.name || 'Player' });
      }
      return;
    }

    const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}/chats/current`, {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({ character_name: card.name, title: 'New Chat' }),
    });
    if (!response.ok) {
      setLibraryMessage(t('chat.error.openBotChat'));
      return;
    }
    const chatData = await response.json() as { chat: BotChat };
    await refreshCardChats(card.id);
    setActiveCard(card);
    setActiveChat(chatData.chat);
    rememberChatSelection(card.id, chatData.chat.id);
    setLibraryMessage(`${t('chat.opened')}: ${chatData.chat.title}`);
    if (notify) {
      sendRealtimeEvent({ type: 'card.select', card_id: card.id, chat_id: chatData.chat.id, participant_id: participantIdRef.current, name: card.name, persona_name: selectedPersona?.name || 'Player' });
    }
  };

  const createBotChat = async () => {
    if (!activeCard) {
      setLibraryMessage(t('chat.error.selectCardFirst'));
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats`, {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({ character_name: activeCard.name, title: `Chat ${new Date().toLocaleString()}` }),
    });
    if (!response.ok) {
      setLibraryMessage(t('chat.error.create'));
      return;
    }
    const { chat } = await response.json() as { chat: BotChat };
    setActiveChat(chat);
    rememberChatSelection(activeCard.id, chat.id);
    await refreshCardChats(activeCard.id);
  };

  const selectChat = async (chatId: string) => {
    if (!activeCard) {
      return;
    }
    const opened = await openChatForCard(activeCard, chatId);
    if (!opened) {
      setLibraryMessage(t('chat.error.open'));
      return;
    }
    sendRealtimeEvent({
      type: 'card.select',
      card_id: activeCard.id,
      chat_id: chatId,
      participant_id: participantIdRef.current,
      name: activeCard.name,
      persona_name: selectedPersona?.name || 'Player',
    });
  };

  const copyChat = async (chatId: string) => {
    if (!activeCard) {
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(chatId)}/copy`, { method: 'POST', headers: actorHeaders() });
    if (!response.ok) {
      setLibraryMessage(t('chat.error.copy'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
    rememberChatSelection(activeCard.id, data.chat.id);
    await refreshCardChats(activeCard.id);
  };

  const exportChat = async (chatId: string) => {
    if (!activeCard) {
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(chatId)}/export/sillytavern`, { headers: actorHeaders() });
    if (!response.ok) {
      setLibraryMessage(t('chat.error.exportST'));
      return;
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filenameFromContentDisposition(response.headers.get('Content-Disposition')) || `${activeCard.name}.jsonl`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    setLibraryMessage(t('chat.exportedST'));
  };

  const importBotChat = async (file: File | null) => {
    if (!file || !activeCard) {
      return;
    }
    const body = new FormData();
    body.append('file', file);
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/import`, {
      method: 'POST',
      headers: actorHeaders(),
      body,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { detail?: string } | null;
      setLibraryMessage(error?.detail || t('chat.error.open'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
    rememberChatSelection(activeCard.id, data.chat.id);
    await refreshCardChats(activeCard.id);
    setChatPickerOpen(false);
  };

  const toggleDeletionLock = async (category: keyof DeletionLocks, itemId: string) => {
    if (!authUserRef.current?.is_admin) {
      return;
    }
    const response = await fetch('/api/delete-locks', {
      method: 'PUT',
      headers: authJsonHeaders(),
      body: JSON.stringify({ category, item_id: itemId, locked: !isDeleteLocked(category, itemId) }),
    });
    if (!response.ok) {
      setLibraryMessage(t('chat.error.toggleDeleteLock'));
      return;
    }
    const data = await response.json() as { delete_locks: DeletionLocks };
    setDeletionLocks({ ...defaultDeletionLocks, ...data.delete_locks });
    setPendingDeleteKey('');
  };

  const toggleMobileTopbar = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, .players-popover')) {
      return;
    }
    setMobileTopbarCollapsed((collapsed) => !collapsed);
  };

  const renameChat = async (chat: BotChatSummary) => {
    if (!activeCard) {
      return;
    }
    const title = (chatRenameDrafts[chat.id] || chat.title).trim();
    if (!title || title === chat.title) {
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(chat.id)}`, {
      method: 'PUT',
      headers: authJsonHeaders(),
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      setLibraryMessage(t('chat.error.rename'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    if (activeChat?.id === data.chat.id) {
      setActiveChat(data.chat);
    }
    await refreshCardChats(activeCard.id);
    setChatRenameDrafts((current) => ({ ...current, [chat.id]: '' }));
  };

  const deleteChat = async (chatId: string) => {
    if (!activeCard) {
      return;
    }
    if (isDeleteLocked('chats', chatDeleteLockId(activeCard.id, chatId))) {
      setLibraryMessage(t('chat.error.deleteLocked'));
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE', headers: actorHeaders() });
    if (!response.ok) {
      setLibraryMessage(t('chat.error.delete'));
      return;
    }
    if (activeChat?.id === chatId) {
      setActiveChat(null);
    }
    forgetChatSelection(activeCard.id, chatId);
    await refreshCardChats(activeCard.id);
  };

  const savePartyHud = async (nextHud: PartyHudState) => {
    if (!activeCard || !activeChat) return;
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/hud`, {
      method: 'PUT',
      headers: authJsonHeaders(),
      body: JSON.stringify(nextHud),
    });
    if (response.ok) {
      const data = await response.json() as { chat: BotChat };
      setActiveChat(data.chat);
      setPartyHudDraft(data.chat.party_hud || nextHud);
    }
  };

  const togglePartyHudEnabled = async (enabled: boolean) => {
    const baseHud: PartyHudState = activeChat?.party_hud || partyHudDraft;
    const updated: PartyHudState = {
      ...baseHud,
      enabled,
      players: baseHud.players?.length
        ? baseHud.players
        : connectedPlayers.map((p) => ({ name: p.persona_name || p.name || 'Player', hp: '100/100', status: 'В норме', inventory: '' })),
    };
    setPartyHudDraft(updated);
    if (enabled) setPartyHudExpanded(true);
    await savePartyHud(updated);
  };

  const saveChatMemoryText = async (memorySummary: string) => {
    if (!activeCard || !activeChat) return;
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/memory`, {
      method: 'PUT',
      headers: authJsonHeaders(),
      body: JSON.stringify({ memory_summary: memorySummary }),
    });
    if (response.ok) {
      const data = await response.json() as { chat: BotChat };
      setActiveChat(data.chat);
      setChatMemoryDraft(data.chat.memory_summary || '');
      setSummaryStatusMessage('Память чата сохранена');
    }
  };

  const triggerManualSummarize = async () => {
    if (!activeCard || !activeChat || isSummarizingMemory) return;
    setIsSummarizingMemory(true);
    setSummaryStatusMessage('Генерация саммари истории…');
    try {
      const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/memory/summarize`, {
        method: 'POST',
        headers: authJsonHeaders(),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => null) as { detail?: string } | null;
        setSummaryStatusMessage(err?.detail || 'Ошибка генерации саммари');
        return;
      }
      const data = await response.json() as { chat: BotChat };
      setActiveChat(data.chat);
      setChatMemoryDraft(data.chat.memory_summary || '');
      setSummaryStatusMessage('Хроника памяти успешно обновлена!');
    } finally {
      setIsSummarizingMemory(false);
    }
  };

  const branchChatFromMessage = async (upToMessageId?: string, customTitle = '') => {
    if (!activeCard || !activeChat) return;
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/branch`, {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({ up_to_message_id: upToMessageId || null, title: customTitle }),
    });
    if (!response.ok) {
      addToast('Не удалось создать ветку чата');
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
    rememberChatSelection(activeCard.id, data.chat.id);
    await refreshCardChats(activeCard.id);
    addToast(`🌿 Открыта новая ветка: ${data.chat.title}`);
  };

  const toggleSwipeVote = async (message: ChatMessage) => {
    if (!activeCard || !activeChat) return;
    const voter = selectedPersona?.name || authUser?.username || 'Player';
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(message.id)}/vote`, {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({ voter, swipe_index: message.active_swipe_index ?? 0 }),
    });
    if (response.ok) {
      const data = await response.json() as { chat: BotChat };
      setActiveChat(data.chat);
    }
  };

  const revealSecretMessage = async (message: ChatMessage) => {
    if (!activeCard || !activeChat) return;
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(message.id)}`, {
      method: 'PUT',
      headers: authJsonHeaders(),
      body: JSON.stringify({ secret_revealed: true }),
    });
    if (response.ok) {
      const data = await response.json() as { chat: BotChat };
      setActiveChat(data.chat);
    }
  };

  const rollDiceInChat = async (formula = '1d20', label = '', dc?: number) => {
    if (!activeCard || !activeChat) return;
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/roll`, {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({
        author: selectedPersona?.name || 'Player',
        participant_id: participantIdRef.current,
        avatar_url: selectedPersona?.avatar_url || '',
        username: authUser?.username || '',
        is_admin: Boolean(authUser?.is_admin),
        formula,
        label,
        dc: dc ?? null,
      }),
    });
    if (response.ok) {
      const data = await response.json() as { chat: BotChat };
      setActiveChat(data.chat);
    }
  };

  const sendChatMessage = async (overrideContent?: string, overrideMode?: 'normal' | 'ooc' | 'secret') => {
    const rawText = overrideContent !== undefined ? overrideContent : chatInput;
    if (!rawText.trim() || isGenerating) {
      return;
    }
    if (overrideContent === undefined && rawText.trimStart().startsWith('/')) {
      await executeSlashCommand(rawText);
      return;
    }
    if (!activeCard || !activeChat) {
      return;
    }
    const effectiveMode = overrideMode || composerMode;
    let content = getRegexedString(rawText, regex_placement.USER_INPUT);
    const mtSettings = loadMagicTranslationSettings();
    if ((mtSettings.autoMode === 'inputs' || mtSettings.autoMode === 'both') && effectiveMode !== 'ooc') {
      try {
        const translated = await translateText(content, mtSettings, activeMessages.map((m) => ({ name: m.author, mes: m.content })), selectedPersona?.name || 'Player');
        if (translated) {
          content = translated;
        }
      } catch {
        // silently fall back to original content on translation failure
      }
    }
    if (overrideContent === undefined) {
      setChatInput('');
      if (composerTextareaRef.current) {
        composerTextareaRef.current.style.height = '';
      }
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages`, {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({
        author: selectedPersona?.name || 'Player',
        participant_id: participantIdRef.current,
        avatar_url: selectedPersona?.avatar_url || '',
        username: authUser?.username || '',
        is_admin: Boolean(authUser?.is_admin),
        role: 'user',
        content,
        is_ooc: effectiveMode === 'ooc',
        is_secret: effectiveMode === 'secret',
      }),
    });
    if (!response.ok) {
      if (overrideContent === undefined) setChatInput(content);
      setLibraryMessage(t('message.error.send'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
    if (composerMode === 'secret') {
      setComposerMode('normal');
    }
  };

  const messageIndexesFromInput = (input: string) => {
    const tokens = input.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
    const indexes = new Set<number>();
    for (const token of tokens) {
      const range = token.match(/^(\d+)-(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        const step = start <= end ? 1 : -1;
        for (let index = start; step > 0 ? index <= end : index >= end; index += step) {
          if (activeMessages[index]) {
            indexes.add(index);
          }
        }
        continue;
      }
      const index = Number(token);
      if (Number.isInteger(index) && activeMessages[index]) {
        indexes.add(index);
      }
    }
    return [...indexes].sort((left, right) => left - right);
  };

  const updateMessagesHidden = async (indexes: number[], hidden: boolean) => {
    if (!activeCard || !activeChat || !indexes.length) {
      setLibraryMessage(t('commands.specifyNumbers'));
      return;
    }
    let latestChat: BotChat | null = null;
    for (const index of indexes) {
      const message = activeMessages[index];
      if (!message) {
        continue;
      }
      const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(message.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...actorHeaders() },
        body: JSON.stringify({ hidden }),
      });
      if (response.ok) {
        const data = await response.json() as { chat: BotChat };
        latestChat = data.chat;
      }
    }
    if (latestChat) {
      setActiveChat(latestChat);
      setLibraryMessage(hidden ? t('message.hidden') : t('message.shown'));
    }
  };

  const deleteMessagesByIndex = async (indexes: number[]) => {
    if (!activeCard || !activeChat || !indexes.length) {
      setLibraryMessage(t('commands.specifyDeleteNumbers'));
      return;
    }
    let latestChat: BotChat | null = null;
    for (const index of [...indexes].sort((left, right) => right - left)) {
      const message = activeMessages[index];
      if (!message) {
        continue;
      }
      const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE', headers: actorHeaders() });
      if (response.ok) {
        const data = await response.json() as { chat: BotChat };
        latestChat = data.chat;
      }
    }
    if (latestChat) {
      setActiveChat(latestChat);
      setLibraryMessage(t('message.deleted'));
    }
  };

  const executeSlashCommand = async (rawCommand: string) => {
    const regexedCommand = getRegexedString(rawCommand, regex_placement.SLASH_COMMAND);
    const [commandToken, ...args] = regexedCommand.trim().split(/\s+/);
    const command = commandToken.toLowerCase();
    const argText = args.join(' ');
    if (command === '/help') {
      setLibraryMessage(`${t('commands.title')}: ${getSlashCommands(t).map((item) => `${item.command}${item.hint ? ` ${item.hint}` : ''}`).join(', ')}`);
      setChatInput('');
      return;
    }
    if (command === '/ooc') {
      if (!argText.trim()) return;
      setChatInput('');
      await sendChatMessage(argText.trim(), 'ooc');
      return;
    }
    if (command === '/secret' || command === '/whisper') {
      if (!argText.trim()) return;
      setChatInput('');
      await sendChatMessage(argText.trim(), 'secret');
      return;
    }
    if (command === '/roll' || command === '/r') {
      setChatInput('');
      await rollDiceInChat(argText.trim() || '1d20');
      return;
    }
    if (command === '/branch') {
      setChatInput('');
      const lastMsg = activeMessages[activeMessages.length - 1];
      await branchChatFromMessage(lastMsg?.id, argText.trim());
      return;
    }
    if (command === '/reroll') {
      setChatInput('');
      await rerollLastBotMessage();
      return;
    }
    const indexes = messageIndexesFromInput(argText || `${Math.max(0, activeMessages.length - 1)}`);
    if (command === '/hide') {
      setChatInput('');
      await updateMessagesHidden(indexes, true);
      return;
    }
    if (command === '/unhide') {
      setChatInput('');
      await updateMessagesHidden(indexes, false);
      return;
    }
    if (command === '/delete') {
      setChatInput('');
      await deleteMessagesByIndex(indexes);
      return;
    }
    if (command === '/copy') {
      const text = indexes.map((index) => {
        const message = activeMessages[index];
        return message ? `#${index} ${message.author}: ${message.content}` : '';
      }).filter(Boolean).join('\n\n');
      if (!text) {
        setLibraryMessage(t('message.nothingToCopy'));
        return;
      }
      await window.navigator.clipboard.writeText(text);
      setChatInput('');
      setLibraryMessage(t('message.copied'));
      return;
    }
    if (command === '/magic-translate') {
      const msgIndex = argText ? Number(argText) : activeMessages.length - 1;
      const message = activeMessages[msgIndex];
      if (!message) {
        setLibraryMessage(t('commands.messageNotFound'));
        return;
      }
      setChatInput('');
      setLibraryMessage(t('commands.translating'));
      try {
        const settings = loadMagicTranslationSettings();
        const translated = await translateText(message.content, settings, activeMessages.map((m) => ({ name: m.author, mes: m.content })), message.author);
        if (translated) {
          if (message.role === 'user') {
            await updateMessageContent(message.id, translated);
          } else {
            await updateMessageDisplayText(message.id, translated);
          }
          setLibraryMessage(t('commands.translated'));
        } else {
          setLibraryMessage(t('commands.translateFailed'));
        }
      } catch (error) {
        setLibraryMessage(`${t('commands.translateFailed')}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (command === '/magic-translate-text') {
      if (!argText) {
        setLibraryMessage(t('commands.provideText'));
        return;
      }
      setChatInput('');
      setLibraryMessage(t('commands.translating'));
      try {
        const settings = loadMagicTranslationSettings();
        const translated = await translateText(argText, settings);
        if (translated) {
          setChatInput(translated);
          setLibraryMessage(t('commands.translated'));
        } else {
          setLibraryMessage(t('commands.translateFailed'));
        }
      } catch (error) {
        setLibraryMessage(`${t('commands.translateFailed')}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const extCmdResult = await executeExtensionSlashCommand(regexedCommand);
    if (extCmdResult.handled) {
      setChatInput('');
      if (extCmdResult.output) {
        setLibraryMessage(extCmdResult.output);
      }
      return;
    }
    setLibraryMessage(t('commands.unknown'));
  };

  const startEditMessage = (message: ChatMessage) => {
    setEditingMessageId(message.id);
    setEditingMessageText(message.content);
  };

  const editChatMessage = async (message: ChatMessage) => {
    if (!activeCard || !activeChat) {
      return;
    }
    const rawContent = editingMessageText.trim();
    const editPlacement = message.role === 'user' ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
    const content = getRegexedString(rawContent, editPlacement, { isEdit: true });
    if (!content || content === message.content) {
      setEditingMessageId('');
      setEditingMessageText('');
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(message.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...actorHeaders() },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      setLibraryMessage(t('message.error.edit'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
    setEditingMessageId('');
    setEditingMessageText('');
  };

  const handleMagicTranslateMessage = async (message: ChatMessage) => {
    if (!activeCard || !activeChat) return;
    if (message.display_text) {
      await updateMessageDisplayText(message.id, '');
      return;
    }
    setLibraryMessage(t('commands.translating'));
    try {
      const settings = loadMagicTranslationSettings();
      const translated = await translateText(message.content, settings, activeMessages.map((m) => ({ name: m.author, mes: m.content })), message.author);
      if (translated) {
        if (message.role === 'user') {
          await updateMessageContent(message.id, translated);
        } else {
          await updateMessageDisplayText(message.id, translated);
        }
        setLibraryMessage(t('commands.translated'));
      } else {
        setLibraryMessage(t('commands.translateFailed'));
      }
    } catch (error) {
      setLibraryMessage(`${t('commands.translateFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const updateMessageContent = async (messageId: string, content: string) => {
    if (!activeCard || !activeChat) return;
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...actorHeaders() },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      setLibraryMessage(t('message.error.edit'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
  };

  const updateMessageDisplayText = async (messageId: string, displayText: string) => {
    if (!activeCard || !activeChat) return;
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...actorHeaders() },
      body: JSON.stringify({ display_text: displayText }),
    });
    if (!response.ok) {
      setLibraryMessage(t('message.error.edit'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
  };

  const toggleMessageHidden = async (message: ChatMessage) => {
    if (!activeCard || !activeChat) {
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(message.id)}`, {
      method: 'PUT',
      headers: authJsonHeaders(),
      body: JSON.stringify({ hidden: !message.hidden }),
    });
    if (!response.ok) {
      setLibraryMessage(t('message.error.toggleHide'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
  };

  const deleteChatMessage = async (message: ChatMessage) => {
    if (!activeCard || !activeChat) {
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE', headers: actorHeaders() });
    if (!response.ok) {
      setLibraryMessage(t('message.error.delete'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
  };

  const swipeBotMessage = async (message: ChatMessage, direction: -1 | 1) => {
    if (!activeCard || !activeChat || message.role !== 'assistant') {
      return;
    }
    const response = await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/messages/${encodeURIComponent(message.id)}/swipe`, {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({ direction }),
    });
    if (!response.ok) {
      setLibraryMessage(t('message.error.swipe'));
      return;
    }
    const data = await response.json() as { chat: BotChat };
    setActiveChat(data.chat);
  };

  const requestBotReply = async (replaceMessageId?: string, sourceChat?: BotChat, resetSwipes = false) => {
    const card = activeCard || activeCardRef.current;
    const chat = sourceChat || activeChat || activeChatRef.current;
    if (!replaceMessageId && !botReplyAllowed && !authUser?.is_admin) {
      setLibraryMessage(t('chat.error.botReplyDisabled'));
      return;
    }
    if (!card || !chat || activeGenerationRef.current || isGenerating) {
      setLibraryMessage(t('chat.error.selectCardAndChat'));
      return;
    }
    activeGenerationRef.current = true;
    setIsGenerating(true);
    setGenerationStreamText('');
    setGenerationReplaceMessageId(replaceMessageId || null);
    setGenerationStatus(`${card.name} ${t('composer.typing')}`);
    setLibraryMessage(replaceMessageId ? t('message.reroll') : t('message.botAnswering'));
    try {
      void emitSillyTavernGenerationEvent('started');
      const response = await fetch(`/api/cards/${encodeURIComponent(card.id)}/chats/${encodeURIComponent(chat.id)}/bot/reply`, {
        method: 'POST',
        headers: authJsonHeaders(),
        body: JSON.stringify({
          replace_message_id: replaceMessageId || null,
          reset_swipes: resetSwipes,
          openai_preset: selectedPresetTypeRef.current === 'openai' ? parsePresetDraft(presetJsonDraft) : null,
          persona_id: selectedPersona?.id || '',
          persona_name: selectedPersona?.name || '',
          persona_description: selectedPersona?.description || '',
          participants: generationParticipants(),
          regex_scripts: getRegexScripts({ allowedOnly: true }),
          extension_prompts: getActiveExtensionPrompts(),
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { detail?: string } | null;
        setLibraryMessage(response.status === 499 ? t('message.generationCancelled') : error?.detail || t('message.error.botReply'));
        void emitSillyTavernGenerationEvent(response.status === 499 ? 'stopped' : 'ended');
        return;
      }
      const data = await response.json() as { chat: BotChat };
      void emitSillyTavernGenerationEvent('ended');
      setActiveChat(data.chat);
      setLibraryMessage(replaceMessageId ? t('message.rerollAdded') : t('message.botReplyAdded'));
      const mtSettings = loadMagicTranslationSettings();
      if ((mtSettings.autoMode === 'responses' || mtSettings.autoMode === 'both') && data.chat) {
        const lastBotMessage = [...data.chat.messages].reverse().find((m) => m.role === 'assistant');
        if (lastBotMessage && card) {
          try {
            const translated = await translateText(lastBotMessage.content, mtSettings, data.chat.messages.map((m) => ({ name: m.author, mes: m.content })), lastBotMessage.author);
            if (translated) {
              await fetch(`/api/cards/${encodeURIComponent(card.id)}/chats/${encodeURIComponent(data.chat.id)}/messages/${encodeURIComponent(lastBotMessage.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...actorHeaders() },
                body: JSON.stringify({ display_text: translated }),
              });
              setActiveChat((current) => {
                if (!current || current.id !== data.chat.id) return current;
                return {
                  ...current,
                  messages: current.messages.map((m) => m.id === lastBotMessage.id ? { ...m, display_text: translated } : m),
                };
              });
            }
          } catch {
            // silently ignore auto translation failure
          }
        }
      }
    } finally {
      activeGenerationRef.current = false;
      setIsGenerating(false);
      setGenerationStreamText('');
      setGenerationReplaceMessageId(null);
      setGenerationStatus('');
    }
  };
  requestBotReplyRef.current = requestBotReply;

  const rerollLastBotMessage = async () => {
    const lastBotMessage = [...activeMessages].reverse().find((message) => message.role === 'assistant');
    if (!lastBotMessage) {
      setLibraryMessage(t('message.error.noBotReplyForReroll'));
      return;
    }
    await requestBotReply(lastBotMessage.id, undefined, true);
  };

  const cancelGeneration = async () => {
    if (!activeCard || !activeChat || !isGenerating) {
      return;
    }
    setGenerationStatus(t('message.generationCancelling'));
    await fetch(`/api/cards/${encodeURIComponent(activeCard.id)}/chats/${encodeURIComponent(activeChat.id)}/bot/cancel`, { method: 'POST', headers: actorHeaders() });
  };

  const createPersona = async () => {
    const name = personaDraft.name.trim();
    if (!name) {
      setLibraryMessage(t('personas.error.name'));
      return;
    }
    const response = await fetch('/api/personas', {
      method: 'POST',
      headers: authJsonHeaders(),
      body: JSON.stringify({ name, description: personaDraft.description }),
    });
    if (!response.ok) {
      setLibraryMessage(t('personas.error.create'));
      return;
    }
    const data = await response.json() as { persona: Persona };
    setPersonaDraft({ name: '', description: '' });
    participantPersonaRestoredRef.current = true;
    applySelectedPersonaId(data.persona.id);
    setLibraryMessage(t('personas.created'));
    await refreshLibrary();
  };

  const selectLocalPersona = (personaId: string) => {
    const persona = personas.find((item) => item.id === personaId) ?? null;
    participantPersonaRestoredRef.current = true;
    applySelectedPersonaId(personaId);
    setLibraryMessage(t('personas.selectedBrowser'));
    if (persona) {
      sendRealtimeEvent({ type: 'notification', content: `${t('personas.selected')}: ${persona.name}`, persona_name: persona.name });
      sendPresence(persona);
    }
  };

  const activatePersona = async (personaId: string) => {
    const response = await fetch(`/api/personas/${personaId}/active`, { method: 'PUT', headers: actorHeaders() });
    if (!response.ok) {
      setLibraryMessage(t('personas.error.activate'));
      return;
    }
    await refreshLibrary();
  };

  const editPersona = (personaId: string, patch: Partial<Pick<Persona, 'name' | 'description'>>) => {
    setPersonas((current) => current.map((persona) => persona.id === personaId ? { ...persona, ...patch } : persona));
  };

  const updatePersona = async (persona: Persona) => {
    const response = await fetch(`/api/personas/${persona.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...actorHeaders() },
      body: JSON.stringify({ name: persona.name, description: persona.description }),
    });
    if (!response.ok) {
      setLibraryMessage(t('personas.error.save'));
      return;
    }
    setLibraryMessage(t('personas.saved'));
    await refreshLibrary();
  };

  const deletePersona = async (persona: Persona) => {
    if (isDeleteLocked('personas', persona.id)) {
      setLibraryMessage(t('personas.error.deleteLocked'));
      return;
    }
    const response = await fetch(`/api/personas/${persona.id}`, { method: 'DELETE', headers: actorHeaders() });
    if (!response.ok) {
      setLibraryMessage(t('personas.error.delete'));
      return;
    }
    if (selectedPersonaId === persona.id) {
      selectedPersonaIdRef.current = '';
      setSelectedPersonaId('');
      window.localStorage.removeItem(SELECTED_PERSONA_STORAGE_KEY);
    }
    setLibraryMessage(t('personas.deleted'));
    await refreshLibrary();
  };

  const uploadPersonaAvatar = async (personaId: string, file: File | null) => {
    if (!file) {
      return;
    }
    const body = new FormData();
    body.append('file', file);
    const response = await fetch(`/api/personas/${personaId}/avatar`, { method: 'POST', headers: actorHeaders(), body });
    if (!response.ok) {
      setLibraryMessage(t('personas.error.avatarUpload'));
      return;
    }
    setLibraryMessage(t('personas.avatarUpdated'));
    await refreshLibrary();
  };

  if (accessPasswordRequired && !accessUnlocked) {
    return (
      <AccessPasswordGate
        password={accessPasswordDraft}
        setPassword={setAccessPasswordDraft}
        message={accessPasswordMessage}
        unlock={unlockAccessPassword}
      />
    );
  }

  if (authRequired && !authUser) {
    return (
      <AuthGate
        authDraft={authDraft}
        setAuthDraft={setAuthDraft}
        authMessage={authMessage}
        registrationAllowed={registrationAllowed}
        login={() => submitAuth('login')}
        register={() => submitAuth('register')}
      />
    );
  }

  return (
    <main
      className="app-shell"
      data-message-width={visualSettings.messageWidth}
      data-show-avatars={String(visualSettings.showAvatars)}
      data-sticky-composer={String(visualSettings.stickyComposer)}
      data-gradients={String(visualSettings.gradients)}
      data-glass={String(visualSettings.glass)}
      data-texture={String(visualSettings.texture)}
      data-panel-shadows={String(visualSettings.panelShadows)}
      data-message-tint={String(visualSettings.messageTint)}
      data-background-vignette={String(visualSettings.backgroundVignette)}
      data-topbar-visible={String(topbarVisible)}
    >
      <header className="topbar">
        <nav className="topbar-quick-nav" aria-label={t('topbar.menu')}>
          {getMenuItems(t).map((item) => {
            const isActive = menuOpen && activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={isActive ? 'topbar-icon-btn active' : 'topbar-icon-btn'}
                title={`${item.label} — ${item.description}`}
                aria-label={item.label}
                onClick={() => {
                  if (isActive) {
                    setMenuOpen(false);
                  } else {
                    setActiveSection(item.id);
                    setMenuOpen(true);
                  }
                }}
              >
                <Icon name={item.icon} />
                <span className="topbar-icon-label">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="topbar-right">
          <div className="connections-status">
            <button
              className={playersMenuOpen ? 'ghost-button topbar-room-btn active' : 'ghost-button topbar-room-btn'}
              type="button"
              title={`${t('topbar.players')} (#${currentRoomId})`}
              aria-label={t('topbar.players')}
              onClick={() => {
                setPlayersMenuOpen((open) => !open);
                void loadRooms();
              }}
            >
              <span className="online-dot" />
              <strong>{connectedCount}</strong>
            </button>
            {playersMenuOpen ? (
              <div className="players-popover">
                <div className="popover-section-title">Онлайн в комнате ({currentRoomId})</div>
                <div className="players-pill-list">
                  {connectedPlayers.length ? connectedPlayers.map((player) => (
                    <span className="player-pill" key={player.id} title={player.persona_name || player.name}>
                      {player.avatar_url ? <button className="avatar-preview-button" type="button" onClick={() => setImagePreview({ src: imageSrc(player.avatar_url), title: player.persona_name || player.name })}><img src={imageSrc(player.avatar_url)} alt="" loading="lazy" /></button> : <i>{(player.persona_name || player.name).slice(0, 1) || '?'}</i>}
                      <strong className="identity-name">{player.is_admin ? <span className="admin-crown">♛</span> : null}<span>{player.persona_name || player.name}</span></strong>
                      {player.username ? <small className="hover-username">({player.username})</small> : null}
                    </span>
                  )) : <strong>{t('topbar.players.none')}</strong>}
                </div>
                <div className="popover-divider" />
                <div className="popover-section-title">Режим очереди ходов</div>
                <div className="popover-segmented">
                  <button
                    type="button"
                    className={turnMode === 'free' ? 'ghost-button active' : 'ghost-button'}
                    onClick={() => sendRealtimeEvent({ type: 'turn.mode', turn_mode: 'free' })}
                  >
                    Свободный
                  </button>
                  <button
                    type="button"
                    className={turnMode === 'round_ready' ? 'ghost-button active' : 'ghost-button'}
                    onClick={() => sendRealtimeEvent({ type: 'turn.mode', turn_mode: 'round_ready' })}
                  >
                    Все готовы (Раунд)
                  </button>
                </div>
                <div className="popover-divider" />
                <label className="popover-checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(activeChat?.party_hud?.enabled)}
                    disabled={!activeChat}
                    onChange={(event) => void togglePartyHudEnabled(event.target.checked)}
                  />
                  <span>Показывать Party HUD (панель группы)</span>
                </label>
                <button
                  type="button"
                  className="ghost-button popover-full-btn"
                  onClick={() => { setMemoryModalOpen(true); setPlayersMenuOpen(false); void loadSummaryMemorySettings(); }}
                >
                  📜 Память и Авто-саммари ({summaryMemorySettings.enabled ? 'Вкл' : 'Выкл'})
                </button>
                <div className="popover-divider" />
                <div className="popover-section-title">Комнаты (Multi-Room)</div>
                <div className="rooms-list-mini">
                  {roomsList.map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      className={room.id === currentRoomId ? 'ghost-button active' : 'ghost-button'}
                      onClick={() => switchRoom(room.id)}
                    >
                      {room.id} ({room.online_count})
                    </button>
                  ))}
                </div>
                <div className="room-switch-row">
                  <input
                    type="text"
                    placeholder="Код новой комнаты…"
                    value={roomInputDraft}
                    onChange={(event) => setRoomInputDraft(event.target.value)}
                  />
                  <button type="button" className="ghost-button" onClick={() => roomInputDraft.trim() && switchRoom(roomInputDraft.trim())}>Войти</button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <section className="hybrid-layout">
        <section className="chat-stage">
          {activeChat?.party_hud?.enabled ? (
            <div className="party-hud-bar">
              <div className="party-hud-summary" onClick={() => setPartyHudExpanded((v) => !v)}>
                <span className="party-hud-badge">🛡️ HUD группы</span>
                {activeChat.party_hud.location ? <span>📍 {activeChat.party_hud.location}</span> : null}
                {activeChat.party_hud.time_of_day ? <span>🕒 {activeChat.party_hud.time_of_day}</span> : null}
                {activeChat.party_hud.quest ? <span>🎯 {activeChat.party_hud.quest}</span> : null}
                {activeChat.party_hud.players?.map((pl, idx) => (
                  <span key={idx} className="party-hud-player-chip">
                    <strong>{pl.name}</strong>{pl.hp ? ` ❤️ ${pl.hp}` : ''}{pl.status ? ` · ${pl.status}` : ''}
                  </span>
                ))}
                <button type="button" className="ghost-button hud-expand-btn" onClick={(e) => { e.stopPropagation(); setPartyHudExpanded((v) => !v); }}>
                  {partyHudExpanded ? 'Свернуть ▴' : 'Настроить ▾'}
                </button>
              </div>
              {partyHudExpanded ? (
                <div className="party-hud-editor">
                  <div className="party-hud-grid">
                    <label>
                      <span>📍 Локация</span>
                      <input value={partyHudDraft.location} placeholder="Таверна, Руины…" onChange={(e) => setPartyHudDraft({ ...partyHudDraft, location: e.target.value })} />
                    </label>
                    <label>
                      <span>🕒 Время / Погода</span>
                      <input value={partyHudDraft.time_of_day} placeholder="Полночь, гроза…" onChange={(e) => setPartyHudDraft({ ...partyHudDraft, time_of_day: e.target.value })} />
                    </label>
                    <label>
                      <span>🎯 Текущий квест / Цель</span>
                      <input value={partyHudDraft.quest} placeholder="Найти ключ…" onChange={(e) => setPartyHudDraft({ ...partyHudDraft, quest: e.target.value })} />
                    </label>
                    <label>
                      <span>📝 Заметки сцены</span>
                      <input value={partyHudDraft.notes} placeholder="Стража настороже…" onChange={(e) => setPartyHudDraft({ ...partyHudDraft, notes: e.target.value })} />
                    </label>
                  </div>
                  <div className="party-hud-players-editor">
                    {(partyHudDraft.players || []).map((pl, idx) => (
                      <div key={idx} className="party-hud-player-row">
                        <input placeholder="Имя" value={pl.name} onChange={(e) => {
                          const next = [...partyHudDraft.players];
                          next[idx] = { ...next[idx], name: e.target.value };
                          setPartyHudDraft({ ...partyHudDraft, players: next });
                        }} />
                        <input placeholder="HP / Ресурсы" value={pl.hp} onChange={(e) => {
                          const next = [...partyHudDraft.players];
                          next[idx] = { ...next[idx], hp: e.target.value };
                          setPartyHudDraft({ ...partyHudDraft, players: next });
                        }} />
                        <input placeholder="Статус" value={pl.status} onChange={(e) => {
                          const next = [...partyHudDraft.players];
                          next[idx] = { ...next[idx], status: e.target.value };
                          setPartyHudDraft({ ...partyHudDraft, players: next });
                        }} />
                        <input placeholder="Инвентарь" value={pl.inventory} onChange={(e) => {
                          const next = [...partyHudDraft.players];
                          next[idx] = { ...next[idx], inventory: e.target.value };
                          setPartyHudDraft({ ...partyHudDraft, players: next });
                        }} />
                        <button type="button" className="ghost-button danger-button" onClick={() => {
                          setPartyHudDraft({ ...partyHudDraft, players: partyHudDraft.players.filter((_, i) => i !== idx) });
                        }}>✕</button>
                      </div>
                    ))}
                    <div className="party-hud-actions">
                      <button type="button" className="ghost-button" onClick={() => setPartyHudDraft({ ...partyHudDraft, players: [...(partyHudDraft.players || []), { name: selectedPersona?.name || 'Player', hp: '100/100', status: '', inventory: '' }] })}>+ Игрок</button>
                      <button type="button" onClick={() => { void savePartyHud(partyHudDraft); setPartyHudExpanded(false); }}>Сохранить HUD</button>
                      <label className="hud-disable-inline">
                        <input type="checkbox" checked={partyHudDraft.enabled} onChange={(e) => void togglePartyHudEnabled(e.target.checked)} />
                        <span>HUD включён</span>
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="chat-scroll" id="chat" ref={chatScrollRef} onScroll={(event) => updateTopbarForScroll(event.currentTarget.scrollTop, event.currentTarget)}>
            {accessDenied.chats ? <AccessDeniedNotice /> : activeMessages.length ? activeMessages.map((message, messageIndex) => {
              const isOwnMessage = message.role === 'user' && (message.participant_id ? message.participant_id === participantIdRef.current : message.author === selectedPersona?.name);
              const messageClass = `mes ${message.role === 'assistant' ? 'message bot-message' : 'message'}${message.hidden ? ' hidden-message' : ''}${isOwnMessage ? ' own-message' : ''}${message.is_ooc ? ' ooc-message' : ''}${message.is_secret ? ' secret-message' : ''}${message.is_dice_roll ? ' dice-message' : ''}`;
              const swipeCount = message.swipes?.length ?? 0;
              const canSwipe = message.role === 'assistant' && swipeCount > 1;
              const activeSwipeKey = String(message.active_swipe_index ?? 0);
              const currentSwipeVoters = message.swipe_votes?.[activeSwipeKey] || [];
              const myVoterName = selectedPersona?.name || authUser?.username || 'Player';
              const hasVotedSwipe = currentSwipeVoters.includes(myVoterName);
              const isSecretHiddenForMe = Boolean(message.is_secret && !message.secret_revealed && !isOwnMessage);
              const isImagePending = Boolean(activeCard && activeChat && imagePendingMessages[imagePendingKey(activeCard.id, activeChat.id, message.id)]);
              const displayContent = isSecretHiddenForMe
                ? `🕵️ *${message.author} совершает тайное действие (известно только мастеру ИИ)…*`
                : (message.display_text || message.content);
              const activeStreamSlice = displayedStreamText || generationStreamText;
              const visibleMessageContent = generationReplaceMessageId === message.id && activeStreamSlice ? `${activeStreamSlice}▍` : displayContent;
              const rollPrompts = message.role === 'assistant'
                ? Array.from(visibleMessageContent.matchAll(/\[ROLL:\s*([^\]]+)\]/gi)).map((m) => m[1].trim())
                : [];
              return (
               <article
                 key={message.id}
                 className={messageClass}
                 {...{ mesid: String(messageIndex) }}
                tabIndex={canSwipe ? 0 : undefined}
                onKeyDown={(event) => {
                  if (!canSwipe || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
                    return;
                  }
                  event.preventDefault();
                  void swipeBotMessage(message, event.key === 'ArrowLeft' ? -1 : 1);
                }}
                 onTouchStart={(event) => {
                   if (canSwipe) {
                     const touch = event.touches[0];
                     swipeTouchStartRef.current[message.id] = touch ? { x: touch.clientX, y: touch.clientY } : { x: 0, y: 0 };
                   }
                 }}
                onTouchEnd={(event) => {
                  if (!canSwipe) {
                    return;
                  }
                   const start = swipeTouchStartRef.current[message.id] ?? { x: 0, y: 0 };
                   const touch = event.changedTouches[0];
                   const deltaX = (touch?.clientX ?? start.x) - start.x;
                   const deltaY = (touch?.clientY ?? start.y) - start.y;
                   delete swipeTouchStartRef.current[message.id];
                   if (Math.abs(deltaX) > 56 && Math.abs(deltaX) > Math.abs(deltaY) * 1.6) {
                     void swipeBotMessage(message, deltaX > 0 ? -1 : 1);
                   }
                }}
              >
                <div className="message-avatar-rail">
                  {message.avatar_url ? <button className="avatar-preview-button" type="button" onClick={() => setImagePreview({ src: imageSrc(message.avatar_url), title: message.author })}><img src={imageSrc(message.avatar_url)} alt="" loading="lazy" /></button> : <i>{message.author.slice(0, 1) || '?'}</i>}
                </div>
                <div className="message-actions extraMesButtons" aria-label={t('message.actions')}>
                  {canSwipe ? <button className="mes_button" type="button" title={t('message.swipe.prev')} onClick={() => void swipeBotMessage(message, -1)}>‹</button> : null}
                  {canSwipe ? <button className="mes_button" type="button" title={t('message.swipe.next')} onClick={() => void swipeBotMessage(message, 1)}>›</button> : null}
                  {canSwipe ? <small className="swipe-counter">{(message.active_swipe_index ?? 0) + 1}/{swipeCount}</small> : null}
                  {message.role === 'assistant' ? (
                    <button
                      className={hasVotedSwipe ? 'mes_button swipe-vote-btn voted' : 'mes_button swipe-vote-btn'}
                      type="button"
                      title={currentSwipeVoters.length ? `Голоса за этот вариант: ${currentSwipeVoters.join(', ')}` : 'Проголосовать за этот вариант ответа 👍'}
                      onClick={() => void toggleSwipeVote(message)}
                    >
                      👍{currentSwipeVoters.length ? <small>{currentSwipeVoters.length}</small> : null}
                    </button>
                  ) : null}
                  {message.role === 'assistant' ? <button className="mes_button" type="button" title={t('message.swipe.new')} onClick={() => void requestBotReply(message.id)}>↻</button> : null}
                  <button className="mes_button" type="button" title="Создать ветку сюжета отсюда 🌿" onClick={() => void branchChatFromMessage(message.id)}>🌿</button>
                  {isImagePending ? <button className="mes_button" type="button" title={t('message.cancelImage')} onClick={() => cancelImageGeneration(messageIndex, message)}><Icon name="x" /></button> : null}
                  <button className="mes_button" type="button" title={t('message.translate')} onClick={() => void handleMagicTranslateMessage(message)}>🌐</button>
                  {!isSecretHiddenForMe ? <button className="mes_button" type="button" title={t('message.edit')} onClick={() => startEditMessage(message)}><Icon name="edit" /></button> : null}
                  <button className="mes_button" type="button" title={message.hidden ? t('common.show') : t('common.hide')} onClick={() => void toggleMessageHidden(message)}><Icon name={message.hidden ? 'eye' : 'eyeOff'} /></button>
                  <button className="mes_button" type="button" title={t('message.delete')} onClick={() => void deleteChatMessage(message)}><Icon name="trash" /></button>
                </div>
                <div className="message-main">
                  <header>
                    <span className="message-name-block">
                      <strong className="identity-name">{message.is_admin ? <span className="admin-crown">♛</span> : null}<span>{message.author}</span></strong>
                      <small className="message-time">{formatChatMessageTime(message.created_at)}</small>
                      <small className="message-meta-inline">#{messageIndex}</small>
                      {message.username ? <small className="hover-username">({message.username})</small> : null}
                      {message.is_ooc ? <span className="msg-mode-badge ooc-badge">💬 OOC</span> : null}
                      {message.is_secret ? (
                        <span className="msg-mode-badge secret-badge">
                          🕵️ {message.secret_revealed ? 'Тайный ход (раскрыт)' : 'Тайный ход'}
                          {!message.secret_revealed && isOwnMessage ? (
                            <button type="button" className="ghost-button reveal-secret-btn" onClick={() => void revealSecretMessage(message)}>👁️ Раскрыть всем</button>
                          ) : null}
                        </span>
                      ) : null}
                      {message.is_dice_roll ? <span className="msg-mode-badge dice-badge">🎲 Бросок</span> : null}
                    </span>
                  </header>
                  {editingMessageId === message.id ? (
                    <div className="message-editor">
                      <textarea value={editingMessageText} onChange={(event) => setEditingMessageText(event.target.value)} />
                      <div>
                        <button type="button" title={t('common.save')} onClick={() => void editChatMessage(message)}><Icon name="check" /></button>
                        <button type="button" title={t('common.cancel')} onClick={() => { setEditingMessageId(''); setEditingMessageText(''); }}><Icon name="x" /></button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <MessageContent key={`${message.id}:${extensionMessageRenderVersions[message.id] || 0}:${regexRenderTick}`} content={visibleMessageContent} role={message.role} reasoning={reasoningDisplay} imagePending={isImagePending} renderPendingMarkersAsSpinner={!extensionLeader} isStreaming={generationReplaceMessageId === message.id && Boolean(generationStreamText)} />
                      {rollPrompts.length > 0 ? (
                        <div className="bot-roll-prompts">
                          {rollPrompts.map((rawSpec, rIdx) => {
                            const parts = rawSpec.split('|').map((s) => s.trim());
                            const formulaMatch = rawSpec.match(/\b(\d*d\d+(?:[+-]\d+)?)\b/i);
                            const dcMatch = rawSpec.match(/\bDC\s*(\d+)\b/i);
                            const formula = formulaMatch ? formulaMatch[1] : '1d20';
                            const dc = dcMatch ? Number(dcMatch[1]) : undefined;
                            const label = parts.filter((p) => !/^\d*d\d+/i.test(p) && !/^DC\s*\d+$/i.test(p)).join(' · ');
                            return (
                              <button
                                key={rIdx}
                                type="button"
                                className="ghost-button roll-prompt-btn"
                                onClick={() => void rollDiceInChat(formula, label, dc)}
                              >
                                🎲 Бросить {formula}{label ? ` (${label})` : ''}{dc ? ` · DC ${dc}` : ''}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
              );
            }) : <p className="empty-library">{t('chat.noCard')}</p>}
            {isGenerating && !generationReplaceMessageId ? (
              <article className="message bot-message thinking-message">
                <div className="message-avatar-rail">
                  {activeCard?.image_url ? <button className="avatar-preview-button" type="button" onClick={() => setImagePreview({ src: imageSrc(activeCard.image_url), title: activeCard.name })}><img src={imageSrc(activeCard.image_url)} alt="" loading="lazy" /></button> : <i>{activeCard?.name.slice(0, 1) || '?'}</i>}
                </div>
                <div className="message-main">
                  <header>
                    <span className="message-name-block"><strong className="identity-name"><span>{activeCard?.name || t('composer.bot')}</span></strong></span>
                  </header>
                  {(displayedStreamText || generationStreamText) ? <MessageContent content={`${displayedStreamText || generationStreamText}▍`} role="assistant" reasoning={reasoningDisplay} isStreaming /> : <div className="message-content"><p><span className="thinking-dots"><i /> <i /> <i /></span>{generationStatus || `${activeCard?.name || t('composer.bot')} ${t('composer.typing')}`}</p></div>}
                </div>
              </article>
            ) : null}
          </div>
          {showScrollBottomButton ? (
            <button
              className="scroll-bottom-button"
              type="button"
              aria-label="Прокрутить вниз"
              onClick={() => scrollToChatBottom('smooth')}
            >
              ↓
            </button>
          ) : null}
          <div className="composer-dock">
          {(composerMode !== 'normal' || Object.keys(typingPlayers).length > 0 || connectedPlayers.length > 1) ? (
            <div className="multiplayer-status-bar">
              {composerMode !== 'normal' ? (
                <button
                  type="button"
                  className="mode-pill active"
                  onClick={() => setComposerMode('normal')}
                  title="Нажмите, чтобы вернуться в обычный режим"
                >
                  {composerMode === 'ooc' ? '💬 Режим OOC (вне игры) ✕' : '🕵️ Тайный ход (скрыто от других) ✕'}
                </button>
              ) : null}
              {Object.keys(typingPlayers).length > 0 ? (
                <span className="typing-indicator-pill">
                  <span className="thinking-dots"><i /><i /><i /></span>
                  <strong>{Object.values(typingPlayers).join(', ')}</strong> печатает…
                </span>
              ) : null}
              {connectedPlayers.length > 1 ? (() => {
                const turnPlayer = connectedPlayers.find((p) => p.id === currentTurnParticipantId) || connectedPlayers[0];
                const isMyTurn = turnPlayer?.id === participantIdRef.current;
                const amIReady = readyParticipantIds.includes(participantIdRef.current);
                return (
                  <span className={isMyTurn ? 'turn-indicator-pill my-turn' : 'turn-indicator-pill'}>
                    <span>{isMyTurn ? 'Ваш ход:' : 'Ход:'}</span>
                    <strong>{turnPlayer?.persona_name || turnPlayer?.name || 'Player'}</strong>
                    {isMyTurn ? (
                      <button
                        type="button"
                        className="ghost-button pass-turn-button"
                        onClick={() => sendRealtimeEvent({ type: 'turn.pass', participant_id: participantIdRef.current, card_id: activeCard?.id, chat_id: activeChat?.id })}
                      >
                        Передать →
                      </button>
                    ) : null}
                    {turnMode === 'round_ready' ? (
                      <button
                        type="button"
                        className={amIReady ? 'ghost-button pass-turn-button ready-active' : 'ghost-button pass-turn-button'}
                        onClick={() => sendRealtimeEvent({ type: 'turn.ready', participant_id: participantIdRef.current, ready: !amIReady, card_id: activeCard?.id, chat_id: activeChat?.id })}
                      >
                        {amIReady ? `✓ Готов (${readyParticipantIds.length}/${connectedPlayers.length})` : `Готов? (${readyParticipantIds.length}/${connectedPlayers.length})`}
                      </button>
                    ) : null}
                  </span>
                );
              })() : null}
            </div>
          ) : null}

          <form id="send_form" className="composer" onSubmit={(event) => { event.preventDefault(); void sendChatMessage(); }}>
            <button className="composer-menu-button" type="button" aria-label={t('composer.actions')} title="Действия чата, бросок кубика, режимы OOC/Тайно" onClick={() => setComposerMenuOpen(!composerMenuOpen)}>+</button>
            {composerMenuOpen ? (
              <ComposerActionMenu
                activeChat={activeChat}
                isGenerating={isGenerating}
                composerMode={composerMode}
                setComposerMode={(m) => { setComposerMode(m); setComposerMenuOpen(false); }}
                rollDice={() => { setComposerMenuOpen(false); void rollDiceInChat('1d20'); }}
                openMemory={() => { setComposerMenuOpen(false); setMemoryModalOpen(true); void loadSummaryMemorySettings(); }}
                openChats={() => { setChatPickerOpen((open) => !open); setComposerMenuOpen(false); }}
                rerollLastBotMessage={() => { setComposerMenuOpen(false); return rerollLastBotMessage(); }}
              />
            ) : null}
            {chatPickerOpen ? (
              <ChatPicker
                activeChat={activeChat}
                botChats={botChats}
                createBotChat={createBotChat}
                importChat={importBotChat}
                copyChat={copyChat}
                exportChat={exportChat}
                deleteChat={deleteChat}
                renameChat={renameChat}
                activeCardId={activeCard?.id || ''}
                deleteLocks={deletionLocks}
                admin={Boolean(authUser?.is_admin)}
                pendingDeleteKey={pendingDeleteKey}
                setPendingDeleteKey={setPendingDeleteKey}
                toggleDeleteLock={(itemId) => void toggleDeletionLock('chats', itemId)}
                chatRenameDrafts={chatRenameDrafts}
                setChatRenameDrafts={setChatRenameDrafts}
                selectChat={selectChat}
                close={() => setChatPickerOpen(false)}
              />
            ) : null}
            {chatInput.trimStart().startsWith('/') ? (
              <div className="slash-command-menu">
                {getSlashCommands(t).map((item) => (
                  <button type="button" key={item.command} onClick={() => setChatInput(`${item.command}${item.hint ? ' ' : ''}`)}>
                    <strong>{item.command}</strong>
                    {item.hint ? <code>{item.hint}</code> : null}
                    <small>{item.description}</small>
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              ref={composerTextareaRef}
              value={chatInput}
              rows={1}
              placeholder={
                composerMode === 'ooc'
                  ? '💬 Внеигровое сообщение (OOC)…'
                  : composerMode === 'secret'
                    ? '🕵️ Тайное действие для ИИ…'
                    : t('composer.placeholder')
              }
              onChange={(event) => {
                const val = event.target.value;
                setChatInput(val);
                const el = event.currentTarget;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                const now = Date.now();
                if (!val.trim()) {
                  lastTypingSentAtRef.current = 0;
                  sendRealtimeEvent({ type: 'typing.update', participant_id: participantIdRef.current, persona_name: selectedPersona?.name || 'Player', is_typing: false });
                } else if (now - lastTypingSentAtRef.current > 1800) {
                  lastTypingSentAtRef.current = now;
                  sendRealtimeEvent({ type: 'typing.update', participant_id: participantIdRef.current, persona_name: selectedPersona?.name || 'Player', is_typing: true });
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || (!event.shiftKey && window.innerWidth > 900))) {
                  event.preventDefault();
                  event.currentTarget.style.height = '';
                  void sendChatMessage();
                }
              }}
            />
            <div className="composer-actions">
              {isGenerating ? (
                <button className="ghost-button bot-reply-button icon-only-btn" type="button" title={t('composer.cancel')} aria-label={t('composer.cancel')} onClick={() => void cancelGeneration()}>
                  <Icon name="x" />
                </button>
              ) : (
                <button className="ghost-button bot-reply-button icon-only-btn" type="button" disabled={!activeChat || accessDenied.chats || (!botReplyAllowed && !authUser?.is_admin)} title={(!botReplyAllowed && !authUser?.is_admin) ? t('composer.botReply.disabled') : t('composer.botReply')} aria-label={t('composer.botReply')} onClick={() => void requestBotReply()}>
                  <Icon name="bot" />
                </button>
              )}
              <button className="send-button icon-only-btn" type="submit" title={t('composer.send')} aria-label={t('composer.send')} disabled={!activeChat || isGenerating || accessDenied.chats}>
                <Icon name="send" />
              </button>
            </div>
          </form>
          </div>
        </section>

      </section>

      {toasts.length ? (
        <div className="toast-stack" aria-live="polite" aria-atomic="false">
          {toasts.map((toast) => <div className="toast" key={toast.id}>{toast.message}</div>)}
        </div>
      ) : null}

      {imagePreview ? (
        <div className="image-preview-overlay" role="dialog" aria-modal="true" onClick={() => setImagePreview(null)}>
          <button className="image-preview-close" type="button" onClick={() => setImagePreview(null)}>{t('imagePreview.close')}</button>
          <img src={imagePreview.src} alt={imagePreview.title} />
          <strong>{imagePreview.title}</strong>
        </div>
      ) : null}

      {memoryModalOpen ? (
        <div className="image-preview-overlay memory-modal-overlay" role="dialog" aria-modal="true" onClick={() => setMemoryModalOpen(false)}>
          <div className="memory-modal-card" onClick={(event) => event.stopPropagation()}>
            <header className="memory-modal-header">
              <strong>📜 Память чата и Авто-саммари</strong>
              <button type="button" className="ghost-button" onClick={() => setMemoryModalOpen(false)}>✕ Закрыть</button>
            </header>
            <div className="memory-modal-body">
              <label className="popover-checkbox-row">
                <input
                  type="checkbox"
                  checked={summaryMemorySettings.enabled}
                  onChange={(e) => {
                    const next = { ...summaryMemorySettings, enabled: e.target.checked };
                    setSummaryMemorySettings(next);
                    void saveSummaryMemorySettings(next);
                  }}
                />
                <span><strong>Включить встроенную память чата</strong> (отключите, если используете внешнее расширение памяти)</span>
              </label>
              <div className="memory-settings-grid">
                <label className="popover-checkbox-row">
                  <input
                    type="checkbox"
                    checked={summaryMemorySettings.auto_summarize}
                    onChange={(e) => setSummaryMemorySettings({ ...summaryMemorySettings, auto_summarize: e.target.checked })}
                  />
                  <span>Автоматически сжимать историю в саммари</span>
                </label>
                <label className="field-preview">
                  <span>Через сколько сообщений делать саммари</span>
                  <input
                    type="number"
                    min={2}
                    max={500}
                    value={summaryMemorySettings.every_n_messages}
                    onChange={(e) => setSummaryMemorySettings({ ...summaryMemorySettings, every_n_messages: Math.max(2, Number(e.target.value) || 20) })}
                  />
                </label>
              </div>
              <label className="popover-checkbox-row">
                <input
                  type="checkbox"
                  checked={summaryMemorySettings.use_separate_api}
                  onChange={(e) => setSummaryMemorySettings({ ...summaryMemorySettings, use_separate_api: e.target.checked })}
                />
                <span><strong>Использовать отдельный внешний API для саммари</strong> (чтобы игра шла на одном API, а саммари делал другой)</span>
              </label>
              {summaryMemorySettings.use_separate_api ? (
                <div className="memory-external-api-box">
                  <div className="memory-settings-grid">
                    <label className="field-preview">
                      <span>Источник API саммари</span>
                      <select
                        value={summaryMemorySettings.chat_completion_source || 'custom'}
                        onChange={(e) => setSummaryMemorySettings({ ...summaryMemorySettings, chat_completion_source: e.target.value, provider: e.target.value === 'custom' ? 'openai-compatible' : e.target.value })}
                      >
                        <option value="custom">Custom (OpenAI-compatible)</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="makersuite">Google AI Studio (Gemini)</option>
                        <option value="claude">Anthropic Claude</option>
                        <option value="deepseek">DeepSeek</option>
                      </select>
                    </label>
                    <label className="field-preview">
                      <span>Base URL внешнего API саммари</span>
                      <input
                        type="text"
                        placeholder="https://api.example.com/v1"
                        value={summaryMemorySettings.base_url}
                        onChange={(e) => setSummaryMemorySettings({ ...summaryMemorySettings, base_url: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="memory-settings-grid">
                    <label className="field-preview">
                      <span>API-ключ для саммари {summaryMemorySettings.api_key_configured ? '(сохранён ✓)' : ''}</span>
                      <input
                        type="password"
                        placeholder={summaryMemorySettings.api_key_configured ? 'Оставьте пустым, чтобы не менять' : 'sk-...'}
                        value={summaryMemorySettings.api_key}
                        onChange={(e) => setSummaryMemorySettings({ ...summaryMemorySettings, api_key: e.target.value, clear_api_key: false })}
                      />
                    </label>
                    <div className="memory-model-picker-col">
                      <button type="button" className="ghost-button" onClick={() => void fetchSummaryModels()}>Проверить и загрузить модели</button>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="memory-settings-grid">
                <label className="field-preview">
                  <span>Модель для саммари (пусто = основная модель чата)</span>
                  <input
                    type="text"
                    list="summary-models-datalist"
                    placeholder={generationSettings.model || 'gpt-4o-mini / gemini-2.5-flash'}
                    value={summaryMemorySettings.model}
                    onChange={(e) => setSummaryMemorySettings({ ...summaryMemorySettings, model: e.target.value })}
                  />
                  <datalist id="summary-models-datalist">
                    {(summaryModels.length ? summaryModels : models).map((m) => <option key={m} value={m} />)}
                  </datalist>
                </label>
                <label className="field-preview">
                  <span>Макс. токенов саммари</span>
                  <input
                    type="number"
                    min={100}
                    max={8000}
                    value={summaryMemorySettings.max_tokens}
                    onChange={(e) => setSummaryMemorySettings({ ...summaryMemorySettings, max_tokens: Math.max(100, Number(e.target.value) || 800) })}
                  />
                </label>
              </div>
              <label className="field-preview">
                <span>Системный промпт для генерации саммари</span>
                <textarea
                  rows={2}
                  value={summaryMemorySettings.prompt}
                  onChange={(e) => setSummaryMemorySettings({ ...summaryMemorySettings, prompt: e.target.value })}
                />
              </label>
              <div className="memory-modal-actions">
                <button type="button" onClick={() => void saveSummaryMemorySettings()}>Сохранить настройки саммари</button>
                {summaryStatusMessage ? <small className="helper-text">{summaryStatusMessage}</small> : null}
              </div>
              <div className="popover-divider" />
              <div className="memory-current-chat-box">
                <div className="memory-chat-header">
                  <strong>Хроника текущего чата ({activeChat?.title || 'нет чата'})</strong>
                  <small>Сжато сообщений: {activeChat?.memory_summarized_count ?? 0} из {activeMessages.filter((m) => !m.hidden && !m.is_ooc).length}</small>
                </div>
                <textarea
                  rows={6}
                  placeholder="Здесь хранится накопленная память (хроника событий) текущего чата…"
                  value={chatMemoryDraft}
                  disabled={!activeChat}
                  onChange={(e) => setChatMemoryDraft(e.target.value)}
                />
                <div className="memory-modal-actions">
                  <button type="button" disabled={!activeChat || isSummarizingMemory} onClick={() => void triggerManualSummarize()}>
                    {isSummarizingMemory ? 'Генерация саммари…' : '⚡ Сжать историю в саммари сейчас'}
                  </button>
                  <button type="button" className="ghost-button" disabled={!activeChat} onClick={() => void saveChatMemoryText(chatMemoryDraft)}>
                    Сохранить текст памяти
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <section
        id="extensions_settings"
        className={`extension-settings-host ${menuOpen && activeSection === 'extensions' && extensionSettingsOpen ? 'extension-settings-host-visible' : ''}`}
        aria-hidden={menuOpen && activeSection === 'extensions' && extensionSettingsOpen ? 'false' : 'true'}
        data-active-extension={extensionSettingsTarget}
      >
        <div className="extension-host-header" data-dt-keep-visible="true">
          <strong>Настройки: {extensionSettingsTarget}</strong>
          <button type="button" className="ghost-button" onClick={() => { setExtensionSettingsOpen(false); setExtensionSettingsTarget(''); }}>✕ Закрыть</button>
        </div>
      </section>
      {menuOpen ? (
        <MenuOverlay
          activeSection={activeSection}
          setActiveSection={setActiveSection}
          visualSettings={visualSettings}
          setVisualSettings={setVisualSettings}
          cards={cards}
          personas={personas}
          selectedPersonaId={selectedPersonaId}
          personaDraft={personaDraft}
          setPersonaDraft={setPersonaDraft}
          cardDraft={cardDraft}
          setCardDraft={setCardDraft}
          setCardAvatar={setCardAvatar}
          activeCard={activeCard}
          activeChat={activeChat}
          setActiveChat={setActiveChat}
          botChats={botChats}
          chatRenameDrafts={chatRenameDrafts}
          setChatRenameDrafts={setChatRenameDrafts}
          generationSettings={generationSettings}
          setGenerationSettings={setGenerationSettings}
          connectionPresets={connectionPresets}
          activeConnectionPresetName={activeConnectionPresetName}
          connectionPresetName={connectionPresetName}
          setConnectionPresetName={setConnectionPresetName}
          presetToDelete={presetToDelete}
          setPresetToDelete={setPresetToDelete}
          models={models}
          connectionMessage={connectionMessage}
          libraryMessage={libraryMessage}
          presetTypes={presetTypes}
          selectedPresetType={selectedPresetType}
          presets={presets}
          selectedPresetName={selectedPresetName}
          presetNameDraft={presetNameDraft}
          presetJsonDraft={presetJsonDraft}
          presetMessage={presetMessage}
          lorebooks={lorebooks}
          selectedLorebookName={selectedLorebookName}
          lorebookNameDraft={lorebookNameDraft}
          lorebookJsonDraft={lorebookJsonDraft}
          lorebookBindings={lorebookBindings}
          lorebookBindingDraft={lorebookBindingDraft}
          lorebookMessage={lorebookMessage}
          activePresets={activePresets}
          accessDenied={accessDenied}
          authUser={authUser}
          deletionLocks={deletionLocks}
          pendingDeleteKey={pendingDeleteKey}
          setPendingDeleteKey={setPendingDeleteKey}
          toggleDeletionLock={toggleDeletionLock}
          authDraft={authDraft}
          setAuthDraft={setAuthDraft}
          authMessage={authMessage}
          securityPermissions={securityPermissions}
          authRequired={authRequired}
          registrationAllowed={registrationAllowed}
          botReplyAllowed={botReplyAllowed}
          accessPasswordRequired={accessPasswordRequired}
          securityAccessPasswordRequiredDraft={securityAccessPasswordRequiredDraft}
          accessPasswordConfigured={accessPasswordConfigured}
          securityAccessPasswordDraft={securityAccessPasswordDraft}
          setAuthRequired={setAuthRequired}
          setRegistrationAllowed={setRegistrationAllowed}
          setBotReplyAllowed={setBotReplyAllowed}
          setSecurityAccessPasswordRequiredDraft={setSecurityAccessPasswordRequiredDraft}
          setSecurityAccessPasswordDraft={setSecurityAccessPasswordDraft}
          setSecurityPermissions={setSecurityPermissions}
          openImagePreview={(src, title) => setImagePreview({ src: imageSrc(src), title })}
          imageSrc={imageSrc}
          editingPromptId={editingPromptId}
          setEditingPromptId={setEditingPromptId}
          importCard={importCard}
          createCard={createCard}
          updateCard={updateCard}
          deleteCard={deleteCard}
          uploadCardAvatar={uploadCardAvatar}
          selectBotCard={selectBotCard}
          createBotChat={createBotChat}
          selectChat={selectChat}
          copyChat={copyChat}
          exportChat={exportChat}
          deleteChat={deleteChat}
          renameChat={renameChat}
          createPersona={createPersona}
          editPersona={editPersona}
          updatePersona={updatePersona}
          deletePersona={deletePersona}
          selectLocalPersona={selectLocalPersona}
          uploadPersonaAvatar={uploadPersonaAvatar}
          saveGenerationSettings={saveGenerationSettings}
          checkConnection={checkConnection}
          applyConnectionPreset={applyConnectionPreset}
          deleteConnectionPreset={deleteConnectionPreset}
          changePresetType={changePresetType}
          selectPreset={selectPreset}
          setPresetNameDraft={setPresetNameDraft}
          setPresetJsonDraft={setPresetJsonDraft}
          savePreset={savePreset}
          importPreset={importPreset}
          applyPreset={applyPreset}
          exportPreset={exportPreset}
          deletePreset={deletePreset}
          importSillyTavernDefaults={importSillyTavernDefaults}
          openLorebook={openLorebook}
          setLorebookNameDraft={setLorebookNameDraft}
          setLorebookJsonDraft={setLorebookJsonDraft}
          setLorebookBindingDraft={setLorebookBindingDraft}
          saveLorebook={saveLorebook}
          importLorebook={importLorebook}
          exportLorebook={exportLorebook}
          deleteLorebook={deleteLorebook}
          addLorebookBinding={addLorebookBinding}
          removeLorebookBinding={removeLorebookBinding}
          login={() => submitAuth('login')}
          register={() => submitAuth('register')}
          logout={logout}
          claimAdmin={claimAdmin}
          saveSecurityPermissions={saveSecurityPermissions}
          securityDirty={securityDirty}
          close={() => setMenuOpen(false)}
        />
      ) : null}
    </main>
  );
}

function LanguageSelector({ language, setLanguage }: { language: Language; setLanguage: (lang: Language) => void }) {
  const { t } = useLocaleContext();
  return (
    <div className="language-selector" role="group" aria-label={t('language.label')}>
      <button
        className={language === 'ru' ? 'lang-button active' : 'lang-button'}
        type="button"
        onClick={() => setLanguage('ru')}
        aria-pressed={language === 'ru'}
      >
        {t('language.ru')}
      </button>
      <button
        className={language === 'en' ? 'lang-button active' : 'lang-button'}
        type="button"
        onClick={() => setLanguage('en')}
        aria-pressed={language === 'en'}
      >
        {t('language.en')}
      </button>
    </div>
  );
}

function MenuOverlay({
  activeSection,
  setActiveSection,
  visualSettings,
  setVisualSettings,
  cards,
  personas,
  selectedPersonaId,
  personaDraft,
  setPersonaDraft,
  cardDraft,
  setCardDraft,
  setCardAvatar,
  activeCard,
  activeChat,
  setActiveChat,
  botChats,
  chatRenameDrafts,
  setChatRenameDrafts,
  generationSettings,
  setGenerationSettings,
  connectionPresets,
  activeConnectionPresetName,
  connectionPresetName,
  setConnectionPresetName,
  presetToDelete,
  setPresetToDelete,
  models,
  connectionMessage,
  libraryMessage,
  presetTypes,
  selectedPresetType,
  presets,
  selectedPresetName,
  presetNameDraft,
  presetJsonDraft,
  presetMessage,
  lorebooks,
  selectedLorebookName,
  lorebookNameDraft,
  lorebookJsonDraft,
  lorebookBindings,
  lorebookBindingDraft,
  lorebookMessage,
  activePresets,
  accessDenied,
  authUser,
  deletionLocks,
  pendingDeleteKey,
  setPendingDeleteKey,
  toggleDeletionLock,
  authDraft,
  setAuthDraft,
  authMessage,
  securityPermissions,
  authRequired,
  registrationAllowed,
  botReplyAllowed,
  accessPasswordRequired,
  securityAccessPasswordRequiredDraft,
  accessPasswordConfigured,
  securityAccessPasswordDraft,
  setAuthRequired,
  setRegistrationAllowed,
  setBotReplyAllowed,
  setSecurityAccessPasswordRequiredDraft,
  setSecurityAccessPasswordDraft,
  setSecurityPermissions,
  openImagePreview,
  imageSrc,
  editingPromptId,
  setEditingPromptId,
  importCard,
  createCard,
  updateCard,
  deleteCard,
  uploadCardAvatar,
  selectBotCard,
  createBotChat,
  selectChat,
  copyChat,
  exportChat,
  deleteChat,
  renameChat,
  createPersona,
  editPersona,
  updatePersona,
  deletePersona,
  selectLocalPersona,
  uploadPersonaAvatar,
  saveGenerationSettings,
  checkConnection,
  applyConnectionPreset,
  deleteConnectionPreset,
  changePresetType,
  selectPreset,
  setPresetNameDraft,
  setPresetJsonDraft,
  savePreset,
  importPreset,
  applyPreset,
  exportPreset,
  deletePreset,
  importSillyTavernDefaults,
  openLorebook,
  setLorebookNameDraft,
  setLorebookJsonDraft,
  setLorebookBindingDraft,
  saveLorebook,
  importLorebook,
  exportLorebook,
  deleteLorebook,
  addLorebookBinding,
  removeLorebookBinding,
  login,
  register,
  logout,
  claimAdmin,
  saveSecurityPermissions,
  securityDirty,
  close,
}: {
  activeSection: MenuSection;
  setActiveSection: (section: MenuSection) => void;
  visualSettings: VisualSettings;
  setVisualSettings: (settings: VisualSettings) => void;
  cards: CharacterCard[];
  personas: Persona[];
  selectedPersonaId: string;
  personaDraft: { name: string; description: string };
  setPersonaDraft: (draft: { name: string; description: string }) => void;
  cardDraft: CardDraft;
  setCardDraft: (draft: CardDraft) => void;
  setCardAvatar: (avatar: File | null) => void;
  activeCard: CharacterCard | null;
  activeChat: BotChat | null;
  setActiveChat: (chat: BotChat) => void;
  botChats: BotChatSummary[];
  chatRenameDrafts: Record<string, string>;
  setChatRenameDrafts: (drafts: Record<string, string>) => void;
  generationSettings: GenerationSettings;
  setGenerationSettings: (settings: GenerationSettings) => void;
  connectionPresets: ConnectionPreset[];
  activeConnectionPresetName: string;
  connectionPresetName: string;
  setConnectionPresetName: (name: string) => void;
  presetToDelete: string;
  setPresetToDelete: (name: string) => void;
  models: string[];
  connectionMessage: string;
  libraryMessage: string;
  presetTypes: PresetTypeInfo[];
  selectedPresetType: string;
  presets: PresetSummary[];
  selectedPresetName: string;
  presetNameDraft: string;
  presetJsonDraft: string;
  presetMessage: string;
  lorebooks: LorebookSummary[];
  selectedLorebookName: string;
  lorebookNameDraft: string;
  lorebookJsonDraft: string;
  lorebookBindings: LorebookBinding[];
  lorebookBindingDraft: LorebookBinding;
  lorebookMessage: string;
  activePresets: Record<string, string>;
  accessDenied: AccessDeniedState;
  authUser: AuthUser | null;
  deletionLocks: DeletionLocks;
  pendingDeleteKey: string;
  setPendingDeleteKey: (key: string) => void;
  toggleDeletionLock: (category: keyof DeletionLocks, itemId: string) => Promise<void>;
  authDraft: { username: string; password: string; adminCode: string };
  setAuthDraft: (draft: { username: string; password: string; adminCode: string }) => void;
  authMessage: string;
  securityPermissions: SecurityPermissions;
  authRequired: boolean;
  registrationAllowed: boolean;
  botReplyAllowed: boolean;
  accessPasswordRequired: boolean;
  securityAccessPasswordRequiredDraft: boolean;
  accessPasswordConfigured: boolean;
  securityAccessPasswordDraft: string;
  setAuthRequired: (required: boolean) => void;
  setRegistrationAllowed: (allowed: boolean) => void;
  setBotReplyAllowed: (allowed: boolean) => void;
  setSecurityAccessPasswordRequiredDraft: (required: boolean) => void;
  setSecurityAccessPasswordDraft: (password: string) => void;
  setSecurityPermissions: (permissions: SecurityPermissions) => void;
  openImagePreview: (src: string, title: string) => void;
  imageSrc: (src: string) => string;
  editingPromptId: string;
  setEditingPromptId: (id: string) => void;
  importCard: (file: File | null) => Promise<void>;
  createCard: () => Promise<void>;
  updateCard: (cardId: string, draft: CardDraft) => Promise<void>;
  deleteCard: (card: CharacterCard) => Promise<void>;
  uploadCardAvatar: (card: CharacterCard, file: File | null) => Promise<void>;
  selectBotCard: (card: CharacterCard) => Promise<void>;
  createBotChat: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  copyChat: (chatId: string) => Promise<void>;
  exportChat: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  renameChat: (chat: BotChatSummary) => Promise<void>;
  createPersona: () => Promise<void>;
  editPersona: (personaId: string, patch: Partial<Pick<Persona, 'name' | 'description'>>) => void;
  updatePersona: (persona: Persona) => Promise<void>;
  deletePersona: (persona: Persona) => Promise<void>;
  selectLocalPersona: (personaId: string) => void;
  uploadPersonaAvatar: (personaId: string, file: File | null) => Promise<void>;
  saveGenerationSettings: () => Promise<void>;
  checkConnection: () => Promise<void>;
  applyConnectionPreset: (presetName: string) => Promise<void>;
  deleteConnectionPreset: (presetName: string) => Promise<void>;
  changePresetType: (presetType: string) => Promise<void>;
  selectPreset: (name: string) => Promise<void>;
  setPresetNameDraft: (name: string) => void;
  setPresetJsonDraft: (json: string) => void;
  savePreset: () => Promise<void>;
  importPreset: (file: File | null) => Promise<void>;
  applyPreset: () => Promise<void>;
  exportPreset: () => Promise<void>;
  deletePreset: () => Promise<void>;
  importSillyTavernDefaults: () => Promise<void>;
  openLorebook: (name: string) => Promise<void>;
  setLorebookNameDraft: (name: string) => void;
  setLorebookJsonDraft: (json: string) => void;
  setLorebookBindingDraft: (binding: LorebookBinding) => void;
  saveLorebook: () => Promise<void>;
  importLorebook: (file: File | null) => Promise<void>;
  exportLorebook: () => Promise<void>;
  deleteLorebook: () => Promise<void>;
  addLorebookBinding: () => Promise<void>;
  removeLorebookBinding: (index: number) => Promise<void>;
  login: () => Promise<void>;
  register: () => Promise<void>;
  logout: () => Promise<void>;
  claimAdmin: () => Promise<void>;
  saveSecurityPermissions: () => Promise<void>;
  securityDirty: boolean;
  close: () => void;
}) {
  const { t, language, setLanguage } = useLocaleContext();
  const menuItems = getMenuItems(t);
  const activeItem = menuItems.find((item) => item.id === activeSection) ?? menuItems[0];

  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <button className="overlay-scrim" type="button" aria-label={t('menu.close')} onClick={close} />
      <section className="settings-drawer">
        <header className="drawer-header">
          <div>
            <span className="eyebrow">{t('menu.title')}</span>
            <h2>{activeItem.label}</h2>
          </div>
          <div className="drawer-header-actions">
            <LanguageSelector language={language} setLanguage={setLanguage} />
            <button className="close-button" type="button" onClick={close}>{t('menu.close')}</button>
          </div>
        </header>

        <div className="drawer-body">
          <nav className="menu-list" aria-label="Settings sections">
            {menuItems.map((item) => (
              <button
                className={activeSection === item.id ? 'menu-card active' : 'menu-card'}
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                title={item.description}
              >
                <Icon name={item.icon} />
                <strong>{item.label}</strong>
              </button>
            ))}
            <LanguageSelector language={language} setLanguage={setLanguage} />
          </nav>

          <section className="section-preview">
            <SettingsSection
              section={activeSection}
              visualSettings={visualSettings}
              setVisualSettings={setVisualSettings}
              cards={cards}
              personas={personas}
              selectedPersonaId={selectedPersonaId}
              personaDraft={personaDraft}
              setPersonaDraft={setPersonaDraft}
              cardDraft={cardDraft}
              setCardDraft={setCardDraft}
              setCardAvatar={setCardAvatar}
              activeCard={activeCard}
              activeChat={activeChat}
              setActiveChat={setActiveChat}
              botChats={botChats}
              chatRenameDrafts={chatRenameDrafts}
              setChatRenameDrafts={setChatRenameDrafts}
              generationSettings={generationSettings}
              setGenerationSettings={setGenerationSettings}
              connectionPresets={connectionPresets}
              activeConnectionPresetName={activeConnectionPresetName}
              connectionPresetName={connectionPresetName}
              setConnectionPresetName={setConnectionPresetName}
              presetToDelete={presetToDelete}
              setPresetToDelete={setPresetToDelete}
              models={models}
              connectionMessage={connectionMessage}
              libraryMessage={libraryMessage}
              presetTypes={presetTypes}
              selectedPresetType={selectedPresetType}
              presets={presets}
              selectedPresetName={selectedPresetName}
              presetNameDraft={presetNameDraft}
              presetJsonDraft={presetJsonDraft}
              presetMessage={presetMessage}
              lorebooks={lorebooks}
              selectedLorebookName={selectedLorebookName}
              lorebookNameDraft={lorebookNameDraft}
              lorebookJsonDraft={lorebookJsonDraft}
              lorebookBindings={lorebookBindings}
              lorebookBindingDraft={lorebookBindingDraft}
              lorebookMessage={lorebookMessage}
              activePresets={activePresets}
              accessDenied={accessDenied}
              authUser={authUser}
              deletionLocks={deletionLocks}
              pendingDeleteKey={pendingDeleteKey}
              setPendingDeleteKey={setPendingDeleteKey}
              toggleDeletionLock={toggleDeletionLock}
              authDraft={authDraft}
              setAuthDraft={setAuthDraft}
              authMessage={authMessage}
              securityPermissions={securityPermissions}
              authRequired={authRequired}
              registrationAllowed={registrationAllowed}
              botReplyAllowed={botReplyAllowed}
              accessPasswordRequired={accessPasswordRequired}
              securityAccessPasswordRequiredDraft={securityAccessPasswordRequiredDraft}
              accessPasswordConfigured={accessPasswordConfigured}
              securityAccessPasswordDraft={securityAccessPasswordDraft}
              setAuthRequired={setAuthRequired}
              setRegistrationAllowed={setRegistrationAllowed}
              setBotReplyAllowed={setBotReplyAllowed}
              setSecurityAccessPasswordRequiredDraft={setSecurityAccessPasswordRequiredDraft}
              setSecurityAccessPasswordDraft={setSecurityAccessPasswordDraft}
              setSecurityPermissions={setSecurityPermissions}
              openImagePreview={openImagePreview}
              imageSrc={imageSrc}
              editingPromptId={editingPromptId}
              setEditingPromptId={setEditingPromptId}
              importCard={importCard}
              createCard={createCard}
              updateCard={updateCard}
              deleteCard={deleteCard}
              uploadCardAvatar={uploadCardAvatar}
              selectBotCard={selectBotCard}
              createBotChat={createBotChat}
              selectChat={selectChat}
              copyChat={copyChat}
              exportChat={exportChat}
              deleteChat={deleteChat}
              renameChat={renameChat}
              createPersona={createPersona}
              editPersona={editPersona}
              updatePersona={updatePersona}
              deletePersona={deletePersona}
              selectLocalPersona={selectLocalPersona}
              uploadPersonaAvatar={uploadPersonaAvatar}
              saveGenerationSettings={saveGenerationSettings}
              checkConnection={checkConnection}
              applyConnectionPreset={applyConnectionPreset}
              deleteConnectionPreset={deleteConnectionPreset}
              changePresetType={changePresetType}
              selectPreset={selectPreset}
              setPresetNameDraft={setPresetNameDraft}
              setPresetJsonDraft={setPresetJsonDraft}
              savePreset={savePreset}
              importPreset={importPreset}
              applyPreset={applyPreset}
              exportPreset={exportPreset}
              deletePreset={deletePreset}
              importSillyTavernDefaults={importSillyTavernDefaults}
              openLorebook={openLorebook}
              setLorebookNameDraft={setLorebookNameDraft}
              setLorebookJsonDraft={setLorebookJsonDraft}
              setLorebookBindingDraft={setLorebookBindingDraft}
              saveLorebook={saveLorebook}
              importLorebook={importLorebook}
              exportLorebook={exportLorebook}
              deleteLorebook={deleteLorebook}
              addLorebookBinding={addLorebookBinding}
              removeLorebookBinding={removeLorebookBinding}
              login={login}
              register={register}
              logout={logout}
              claimAdmin={claimAdmin}
              saveSecurityPermissions={saveSecurityPermissions}
              securityDirty={securityDirty}
            />
          </section>
        </div>
      </section>
    </div>
  );
}

function AuthGate({ authDraft, setAuthDraft, authMessage, registrationAllowed, login, register }: { authDraft: { username: string; password: string; adminCode: string }; setAuthDraft: (draft: { username: string; password: string; adminCode: string }) => void; authMessage: string; registrationAllowed: boolean; login: () => Promise<void>; register: () => Promise<void> }) {
  const { t } = useLocaleContext();
  useEffect(() => {
    const saved = window.localStorage.getItem(AUTH_USERNAME_STORAGE_KEY);
    if (saved) {
      setAuthDraft({ ...authDraft, username: saved });
    }
  }, []);
  return (
    <main className="auth-gate-shell">
      <section className="auth-gate-card">
        <div>
          <span className="eyebrow">DoubleTrouble</span>
          <h1>{t('auth.loginClosed')}</h1>
          <p>{t('auth.loginRequired')}</p>
        </div>
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void login(); }}>
          <EditableField label={t('auth.username')} value={authDraft.username} onChange={(username) => setAuthDraft({ ...authDraft, username })} />
          <EditableField label={t('auth.password')} type="password" value={authDraft.password} onChange={(password) => setAuthDraft({ ...authDraft, password })} />
          <div className="preset-actions">
            <button type="submit">{t('auth.login')}</button>
            {registrationAllowed ? <button className="ghost-button" type="button" onClick={() => void register()}>{t('auth.register')}</button> : null}
          </div>
          {!registrationAllowed ? <p className="helper-text">{t('auth.registrationDisabled')}</p> : null}
          {authMessage ? <p className="library-message">{authMessage}</p> : null}
        </form>
      </section>
    </main>
  );
}

function AccessPasswordGate({ password, setPassword, message, unlock }: { password: string; setPassword: (password: string) => void; message: string; unlock: () => Promise<void> }) {
  const { t } = useLocaleContext();
  return (
    <main className="auth-gate-shell">
      <section className="auth-gate-card">
        <div>
          <span className="eyebrow">DoubleTrouble</span>
          <h1>{t('auth.accessClosed')}</h1>
          <p>{t('auth.accessPasswordHelp')}</p>
        </div>
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
          <EditableField label={t('auth.accessPassword')} type="password" value={password} onChange={setPassword} />
          <div className="preset-actions">
            <button type="submit">{t('auth.unlockAccess')}</button>
          </div>
          {message ? <p className="library-message">{message}</p> : null}
        </form>
      </section>
    </main>
  );
}

function KeyManager({ mode = 'panel' }: { mode?: 'panel' | 'popover' }) {
  const { t } = useLocaleContext();
  const [keys, setKeys] = useState<ManagedKeySummary[]>([]);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>({});
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState('');

  const headers = (json = false) => {
    const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '';
    const accessToken = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || '';
    return {
      'X-DoubleTrouble-Actor': 'Player',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(accessToken ? { 'X-DoubleTrouble-Access': accessToken } : {}),
    };
  };

  const loadKeys = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/keys', { headers: headers() });
      const data = await response.json().catch(() => null) as { keys?: ManagedKeySummary[]; detail?: string } | null;
      if (!response.ok) {
        setMessage(response.status === 401 || response.status === 403 ? t('keys.noAccess') : data?.detail || t('keys.error.load'));
        return;
      }
      setKeys(data?.keys || []);
      setMessage('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadKeys();
    const onSharedSettingsUpdated = (event: Event) => {
      const section = (event as CustomEvent<{ section?: string }>).detail?.section || '';
      if (!section || section === 'keys') {
        void loadKeys();
      }
    };
    window.addEventListener('doubletrouble:shared-settings-updated', onSharedSettingsUpdated);
    return () => window.removeEventListener('doubletrouble:shared-settings-updated', onSharedSettingsUpdated);
  }, []);

  const applyKeys = (nextKeys: ManagedKeySummary[]) => {
    setKeys(nextKeys);
    setNameDrafts({});
    setValueDrafts({});
    setNewKeyName('');
    setNewKeyValue('');
    setEditingKeyId('');
  };

  const createKey = async () => {
    const name = newKeyName.trim();
    const value = newKeyValue.trim();
    if (!name || !value) {
      setMessage(t('keys.error.nameValue'));
      return;
    }
    const response = await fetch('/api/keys', {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ name, value }),
    });
    const data = await response.json().catch(() => null) as { keys?: ManagedKeySummary[]; detail?: string } | null;
    if (!response.ok || !data?.keys) {
      setMessage(data?.detail || t('keys.error.create'));
      return;
    }
    applyKeys(data.keys);
    setMessage(t('keys.added'));
  };

  const saveKey = async (key: ManagedKeySummary) => {
    const name = (nameDrafts[key.id] ?? key.name ?? key.label).trim();
    const value = (valueDrafts[key.id] || '').trim();
    if (!name) {
      setMessage(t('keys.error.name'));
      return;
    }
    const response = await fetch(`/api/keys/${encodeURIComponent(key.id)}`, {
      method: 'PUT',
      headers: headers(true),
      body: JSON.stringify({ name, value }),
    });
    const data = await response.json().catch(() => null) as { keys?: ManagedKeySummary[]; detail?: string } | null;
    if (!response.ok || !data?.keys) {
      setMessage(data?.detail || t('keys.error.save'));
      return;
    }
    applyKeys(data.keys);
    setMessage(t('keys.saved'));
  };

  const activateKey = async (keyId: string) => {
    const response = await fetch(`/api/keys/${encodeURIComponent(keyId)}/active`, { method: 'POST', headers: headers() });
    const data = await response.json().catch(() => null) as { keys?: ManagedKeySummary[]; detail?: string } | null;
    if (!response.ok || !data?.keys) {
      setMessage(data?.detail || t('keys.error.select'));
      return;
    }
    applyKeys(data.keys);
    setMessage(t('keys.activeSelected'));
  };

  const deleteKey = async (keyId: string) => {
    const response = await fetch(`/api/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', headers: headers() });
    const data = await response.json().catch(() => null) as { keys?: ManagedKeySummary[]; detail?: string } | null;
    if (!response.ok || !data?.keys) {
      setMessage(data?.detail || t('keys.error.delete'));
      return;
    }
    applyKeys(data.keys);
    setMessage(t('keys.deleted'));
  };

  const activeKey = keys.find((key) => key.active);
  const manager = (
    <div className={mode === 'panel' ? 'key-manager' : 'key-manager key-manager-compact'}>
      <div className="key-manager-toolbar">
        <div>
          <strong>{activeKey ? activeKey.name : t('keys.noActive')}</strong>
          <small>{activeKey?.masked || (activeKey?.configured ? t('keys.savedStatus') : t('keys.addOrSelect'))}</small>
        </div>
        <button className="ghost-button" type="button" disabled={loading} onClick={() => void loadKeys()}>{t('common.refresh')}</button>
      </div>
      <article className="key-manager-create">
        <input value={newKeyName} placeholder={t('keys.namePlaceholder')} onChange={(event) => setNewKeyName(event.target.value)} />
        <input type="password" value={newKeyValue} placeholder={t('keys.apiKeyPlaceholder')} onChange={(event) => setNewKeyValue(event.target.value)} />
        <button type="button" onClick={() => void createKey()}>{t('common.add')}</button>
      </article>
      {keys.length ? keys.map((key) => {
        const configured = key.configured || key.env_configured;
        const keyName = key.name || key.label;
        const editing = editingKeyId === key.id;
        return (
          <article className={key.active ? 'key-manager-row active' : 'key-manager-row'} key={key.id}>
            <button className={key.active ? 'key-select-button active' : 'key-select-button'} type="button" disabled={key.active || !key.configured} onClick={() => void activateKey(key.id)}>
              <strong>{keyName}</strong>
              <small>{key.active ? t('keys.active') : configured ? t('keys.makeActive') : t('keys.noValue')}{key.masked ? ` · ${key.masked}` : ''}{key.env_configured ? ` · env ${key.env_name}` : ''}</small>
            </button>
            <div className="key-manager-actions">
              <button className="ghost-button" type="button" onClick={() => { setEditingKeyId(editing ? '' : key.id); setNameDrafts({ ...nameDrafts, [key.id]: keyName }); }}>{editing ? t('common.collapse') : t('common.edit')}</button>
              <button className="ghost-button danger-button" type="button" onClick={() => void deleteKey(key.id)}>{t('common.delete')}</button>
            </div>
            {editing ? (
              <div className="key-manager-edit">
                <input className="key-name-input" value={nameDrafts[key.id] ?? keyName} aria-label={t('keys.namePlaceholder')} onChange={(event) => setNameDrafts({ ...nameDrafts, [key.id]: event.target.value })} />
                <input type="password" value={valueDrafts[key.id] || ''} placeholder={configured ? t('keys.newValue') : t('keys.valuePlaceholder')} onChange={(event) => setValueDrafts({ ...valueDrafts, [key.id]: event.target.value })} />
                <button type="button" onClick={() => void saveKey(key)}>{t('common.save')}</button>
              </div>
            ) : null}
          </article>
        );
      }) : <p className="empty-library">{t('keys.notLoaded')}</p>}
      {message ? <p className="library-message">{message}</p> : null}
    </div>
  );

  if (mode === 'popover') {
    return (
      <div className="field-preview api-key-field">
        <span>API key</span>
        <button className={open ? 'api-key-trigger active' : 'api-key-trigger'} type="button" onClick={() => setOpen(!open)}>
          <Icon name="key" />
          <span>
            <strong>{activeKey ? activeKey.name : t('keys.manager')}</strong>
            <small>{activeKey?.masked || (generationKeyState(keys, t) || t('keys.openSaved'))}</small>
          </span>
        </button>
        {open ? (
          <div className="api-key-popover" role="dialog" aria-label={t('keys.apiManager')}>
            <div className="key-popover-header">
              <div>
                <span className="eyebrow">Provider</span>
                <h3>API keys</h3>
              </div>
              <button className="ghost-button" type="button" onClick={() => setOpen(false)}>{t('common.close')}</button>
            </div>
            {manager}
          </div>
        ) : null}
      </div>
    );
  }

  return manager;
}

function ImageKeyManager({ onApplyKey }: { onApplyKey: (apiKey: string) => void }) {
  const { t } = useLocaleContext();
  const [keys, setKeys] = useState<ImageKeyRecord[]>(loadImageKeys);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>({});
  const [editingKeyId, setEditingKeyId] = useState('');
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');

  const activeKey = keys.find((key) => key.active);
  const persistKeys = (nextKeys: ImageKeyRecord[], nextMessage: string, applyActive = false) => {
    setKeys(nextKeys);
    saveImageKeys(nextKeys);
    setNameDrafts({});
    setValueDrafts({});
    setNewKeyName('');
    setNewKeyValue('');
    setEditingKeyId('');
    setMessage(nextMessage);
    if (applyActive) {
      onApplyKey(nextKeys.find((key) => key.active)?.value || '');
    }
  };

  const createKey = () => {
    const value = newKeyValue.trim();
    if (!value) {
      setMessage(t('keys.error.value'));
      return;
    }
    const key: ImageKeyRecord = {
      id: window.crypto?.randomUUID?.() || `image_key_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: newKeyName.trim() || `Image key ${keys.length + 1}`,
      value,
      active: !activeKey,
    };
    persistKeys([...keys, key], key.active ? t('keys.addedAndSelected') : t('keys.added'), key.active);
  };

  const saveKey = (key: ImageKeyRecord) => {
    const name = (nameDrafts[key.id] ?? key.name).trim() || key.name;
    const value = (valueDrafts[key.id] || '').trim() || key.value;
    const nextKeys = keys.map((item) => item.id === key.id ? { ...item, name, value } : item);
    persistKeys(nextKeys, t('keys.saved'), key.active);
  };

  const activateKey = (keyId: string) => {
    const nextKeys = keys.map((key) => ({ ...key, active: key.id === keyId }));
    persistKeys(nextKeys, t('keys.selectedForImages'), true);
  };

  const deleteKey = (keyId: string) => {
    const wasActive = keys.some((key) => key.id === keyId && key.active);
    const nextKeys = keys.filter((key) => key.id !== keyId).map((key, index) => ({ ...key, active: wasActive ? index === 0 : key.active }));
    persistKeys(nextKeys, t('keys.deleted'), wasActive);
  };

  const manager = (
    <div className="key-manager key-manager-compact image-local-key-manager">
      <div className="key-manager-toolbar">
        <div>
          <strong>{activeKey ? activeKey.name : t('keys.noImageKey')}</strong>
          <small>{activeKey ? maskSecret(activeKey.value) : t('keys.imageExtensionKeys')}</small>
        </div>
      </div>
      <article className="key-manager-create">
        <input value={newKeyName} placeholder={t('keys.namePlaceholder')} onChange={(event) => setNewKeyName(event.target.value)} />
        <input type="password" value={newKeyValue} placeholder={t('keys.imageApiKeyPlaceholder')} onChange={(event) => setNewKeyValue(event.target.value)} />
        <button type="button" onClick={createKey}>{t('common.add')}</button>
      </article>
      {keys.length ? keys.map((key) => {
        const editing = editingKeyId === key.id;
        return (
          <article className={key.active ? 'key-manager-row active' : 'key-manager-row'} key={key.id}>
            <button className={key.active ? 'key-select-button active' : 'key-select-button'} type="button" disabled={key.active} onClick={() => activateKey(key.id)}>
              <strong>{key.name}</strong>
              <small>{key.active ? t('keys.activeForImages') : t('keys.makeActive')} · {maskSecret(key.value)}</small>
            </button>
            <div className="key-manager-actions">
              <button className="ghost-button" type="button" onClick={() => { setEditingKeyId(editing ? '' : key.id); setNameDrafts({ ...nameDrafts, [key.id]: key.name }); }}>{editing ? t('common.collapse') : t('common.edit')}</button>
              <button className="ghost-button danger-button" type="button" onClick={() => deleteKey(key.id)}>{t('common.delete')}</button>
            </div>
            {editing ? (
              <div className="key-manager-edit">
                <input className="key-name-input" value={nameDrafts[key.id] ?? key.name} aria-label={t('keys.namePlaceholder')} onChange={(event) => setNameDrafts({ ...nameDrafts, [key.id]: event.target.value })} />
                <input type="password" value={valueDrafts[key.id] || ''} placeholder={t('keys.newValue')} onChange={(event) => setValueDrafts({ ...valueDrafts, [key.id]: event.target.value })} />
                <button type="button" onClick={() => saveKey(key)}>{t('common.save')}</button>
              </div>
            ) : null}
          </article>
        );
      }) : <p className="empty-library">{t('keys.noImageKeys')}</p>}
      {message ? <p className="library-message">{message}</p> : null}
    </div>
  );

  return (
    <div className="image-key-button-wrap">
      <button className={open ? 'ghost-button image-key-button active' : 'ghost-button image-key-button'} type="button" onClick={() => setOpen(!open)}>
        <Icon name="key" />
        <span>{t('keys.label')}</span>
      </button>
      {open ? (
        <div className="api-key-popover image-key-popover" role="dialog" aria-label={t('keys.imageExtensionKeys')}>
          <div className="key-popover-header">
            <div>
              <span className="eyebrow">Images</span>
              <h3>{t('keys.imageKeysTitle')}</h3>
            </div>
            <button className="ghost-button" type="button" onClick={() => setOpen(false)}>{t('common.close')}</button>
          </div>
          {manager}
        </div>
      ) : null}
    </div>
  );
}

function ImageExtensionSettingsPortal({ extension, imageSettings, setImageSettings, imageEndpointPresets, selectedImageEndpointName, imageEndpointName, setImageEndpointName, applyImageEndpointPreset, saveImageEndpointPreset, saveImageSettings, applyImageKey }: { extension: ExtensionSummary | null; imageSettings: ImageExtensionSettings; setImageSettings: (settings: ImageExtensionSettings) => void; imageEndpointPresets: ImageEndpointPreset[]; selectedImageEndpointName: string; imageEndpointName: string; setImageEndpointName: (name: string) => void; applyImageEndpointPreset: (name: string) => void; saveImageEndpointPreset: () => void; saveImageSettings: () => void; applyImageKey: (apiKey: string) => void }) {
  const { t } = useLocaleContext();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [imageModelsLoading, setImageModelsLoading] = useState(false);
  const [imageModelsMessage, setImageModelsMessage] = useState('');

  useEffect(() => {
    setHost(document.getElementById('extensions_settings'));
  }, []);

  if (!host || !extension) {
    return null;
  }

  const loadImageModels = async () => {
    setImageModelsLoading(true);
    setImageModelsMessage('');
    try {
      const existingSettings = loadRawImageExtensionSettings();
      const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '';
      const accessToken = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || '';
      const response = await fetch('/api/image-generation/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(accessToken ? { 'X-DoubleTrouble-Access': accessToken } : {}),
        },
        body: JSON.stringify({
          api_type: imageSettings.apiType,
          endpoint: imageSettings.endpoint,
          api_key: imageSettings.apiKey.trim() || String(existingSettings.apiKey || ''),
          timeout_seconds: 30,
        }),
      });
      const data = await response.json().catch(() => null) as { ok?: boolean; error?: string; models?: unknown } | null;
      if (!response.ok || !data?.ok) {
        setImageModels([]);
        setImageModelsMessage(data?.error || t('image.error.loadModels'));
        return;
      }
      const modelNames = extractModelNames(data.models);
      setImageModels(modelNames);
      setImageModelsMessage(modelNames.length ? `${t('image.modelsLoaded')}: ${modelNames.length}` : t('image.emptyModelList'));
    } finally {
      setImageModelsLoading(false);
    }
  };

  return createPortal(
    <section className="image-extension-settings-panel image-extension-settings-portal" data-dt-extension-owner={extension.external_name}>
      <div className="image-extension-settings-header">
        <div>
          <strong>{t('image.connection')}</strong>
          <small>{t('image.connectionHelp')}</small>
        </div>
        <ImageKeyManager onApplyKey={applyImageKey} />
      </div>
      <div className="image-endpoint-row">
        <select value={selectedImageEndpointName} onChange={(event) => applyImageEndpointPreset(event.target.value)}>
          <option value="">{t('image.selectEndpoint')}</option>
          {imageEndpointPresets.map((preset) => <option value={preset.name} key={preset.name}>{preset.name}</option>)}
        </select>
        <input value={imageEndpointName} placeholder={t('image.endpointName')} onChange={(event) => setImageEndpointName(event.target.value)} />
        <button className="ghost-button tiny-button" type="button" onClick={saveImageEndpointPreset}>{t('common.saveShort')}</button>
      </div>
      <div className="key-manager-edit image-extension-fields">
        <select value={imageSettings.apiType} onChange={(event) => setImageSettings({ ...imageSettings, apiType: event.target.value })}>
          <option value="openai">OpenAI Images</option>
          <option value="gemini">Gemini / nano-banana</option>
          <option value="naistera">Naistera</option>
        </select>
        <input value={imageSettings.endpoint} placeholder="Endpoint URL" onChange={(event) => setImageSettings({ ...imageSettings, endpoint: event.target.value })} />
        <div className="image-model-picker-row">
          <input value={imageSettings.model} list="image-model-options" placeholder="Model" onChange={(event) => setImageSettings({ ...imageSettings, model: event.target.value })} />
          <datalist id="image-model-options">
            {imageModels.map((model) => <option value={model} key={model} />)}
          </datalist>
          <button className="ghost-button tiny-button" type="button" disabled={imageModelsLoading} onClick={() => void loadImageModels()}>{imageModelsLoading ? '...' : t('image.models')}</button>
        </div>
        <input type="password" value={imageSettings.apiKey} placeholder={t('image.apiKeyPlaceholder')} onChange={(event) => setImageSettings({ ...imageSettings, apiKey: event.target.value })} />
        <button type="button" onClick={saveImageSettings}>{t('common.apply')}</button>
      </div>
      {imageModelsMessage ? <small className="helper-text">{imageModelsMessage}</small> : null}
    </section>,
    host,
  );
}

function generationKeyState(keys: ManagedKeySummary[], t: (key: string) => string) {
  if (!keys.length) {
    return '';
  }
  return keys.some((key) => key.configured || key.env_configured) ? t('keys.savedAvailable') : t('keys.notConfigured');
}

function ExtensionsManager() {
  const { t } = useLocaleContext();
  const [extensions, setExtensions] = useState<ExtensionSummary[]>([]);
  const [builtInSettings, setBuiltInSettings] = useState(loadBuiltInExtensionSettings);
  const [imageSettings, setImageSettings] = useState(loadImageExtensionSettings);
  const [imageEndpointPresets, setImageEndpointPresets] = useState(loadImageEndpointPresets);
  const [selectedImageEndpointName, setSelectedImageEndpointName] = useState('');
  const [imageEndpointName, setImageEndpointName] = useState('');
  const [installUrl, setInstallUrl] = useState('');
  const [installBranch, setInstallBranch] = useState('');
  const [installOverwrite, setInstallOverwrite] = useState(true);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const headers = (json = false) => {
    const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '';
    const accessToken = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY) || '';
    return {
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(accessToken ? { 'X-DoubleTrouble-Access': accessToken } : {}),
    };
  };

  const openExtensionSettingsPanel = (extension: ExtensionSummary) => window.dispatchEvent(new CustomEvent('doubletrouble:extension-settings-open', { detail: { name: extension.external_name } }));

  const loadExtensions = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/extensions', { headers: headers() });
      if (!response.ok) {
        setMessage(response.status === 401 || response.status === 403 ? t('extensions.noPermission') : t('extensions.error.load'));
        return;
      }
      const data = await response.json() as { extensions: ExtensionSummary[] };
      setExtensions(data.extensions);
      const noriMynExtension = data.extensions.find((extension) => extension.name === 'norimyn-infoblock' || extension.external_name.includes('norimyn-infoblock'));
      if (noriMynExtension) {
        setBuiltInSettings((current) => {
          const nextSettings = { ...current, noriMynInfoblock: noriMynExtension.enabled };
          saveBuiltInExtensionSettings(nextSettings);
          return nextSettings;
        });
      }
      const magicTranslationExtension = data.extensions.find((extension) => extension.name === 'magic-translation' || extension.external_name.includes('magic-translation'));
      if (magicTranslationExtension) {
        setBuiltInSettings((current) => {
          const nextSettings = { ...current, magicTranslation: magicTranslationExtension.enabled };
          saveBuiltInExtensionSettings(nextSettings);
          return nextSettings;
        });
      }
      setMessage('');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadExtensions();
    const onSharedSettingsUpdated = (event: Event) => {
      const section = (event as CustomEvent<{ section?: string }>).detail?.section || '';
      if (!section || section === 'extensions') {
        void loadExtensions();
      }
    };
    window.addEventListener('doubletrouble:shared-settings-updated', onSharedSettingsUpdated);
    return () => window.removeEventListener('doubletrouble:shared-settings-updated', onSharedSettingsUpdated);
  }, []);

  const setEnabled = async (extension: ExtensionSummary, enabled: boolean): Promise<boolean> => {
    setLoading(true);
    try {
      const response = await fetch(`/api/extensions/${encodeURIComponent(extension.name)}/enabled`, {
        method: 'PUT',
        headers: headers(true),
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) {
        setMessage(t('extensions.error.toggle'));
        return false;
      }
      setExtensions((current) => current.map((item) => item.name === extension.name ? { ...item, enabled } : item));
      if (enabled) {
        void syncSillyTavernExtensions();
      }
      setMessage(`${enabled ? t('common.enabled') : t('common.disabled')}. ${t('extensions.oldMessagesNotRerendered')}`);
      return true;
    } finally {
      setLoading(false);
    }
  };

  const setNoriMynEnabled = async (extension: ExtensionSummary | null, enabled: boolean) => {
    if (extension && !(await setEnabled(extension, enabled))) {
      return;
    }
    const nextSettings = { ...builtInSettings, noriMynInfoblock: enabled };
    setBuiltInSettings(nextSettings);
    saveBuiltInExtensionSettings(nextSettings);
    setMessage(`${enabled ? t('common.enabled') : t('common.disabled')}. ${t('extensions.newMessagesApply')}`);
  };

  const setMagicTranslationEnabled = async (extension: ExtensionSummary | null, enabled: boolean) => {
    if (extension && !(await setEnabled(extension, enabled))) {
      return;
    }
    const nextSettings = { ...builtInSettings, magicTranslation: enabled };
    setBuiltInSettings(nextSettings);
    saveBuiltInExtensionSettings(nextSettings);
    setMessage(`${enabled ? t('common.enabled') : t('common.disabled')}. ${t('extensions.newMessagesApply')}`);
  };

  const persistImageSettings = (settings: ImageExtensionSettings, messageText = '', clearApiKeyDraft = false) => {
    const existingSettings = loadRawImageExtensionSettings();
    const apiKey = settings.apiKey.trim() || String(existingSettings.apiKey || '');
    const sharedSettings = {
      ...existingSettings,
      apiType: settings.apiType,
      endpoint: settings.endpoint.trim(),
      model: settings.model.trim(),
      ...(apiKey ? { apiKey } : {}),
    };
    updateSillyTavernExtensionSettings({
      sillyimages: sharedSettings,
    });
    syncImageExtensionSettingsDom(sharedSettings);
    if (clearApiKeyDraft) {
      setImageSettings((current) => ({ ...current, apiKey: '' }));
    }
    if (messageText) {
      setMessage(messageText);
    }
  };

  const updateImageSettings = (nextSettings: ImageExtensionSettings) => {
    setImageSettings(nextSettings);
    persistImageSettings(nextSettings);
  };

  const saveImageSettings = () => {
    persistImageSettings(imageSettings, t('extensions.imageSettingsSaved'), true);
  };

  const applyImageKey = (apiKey: string) => {
    persistImageSettings({ ...imageSettings, apiKey });
    setImageSettings((current) => ({ ...current, apiKey: '' }));
    setMessage(apiKey ? t('extensions.imageKeySelected') : t('extensions.imageKeyCleared'));
  };

  const applyImageEndpointPreset = (name: string) => {
    setSelectedImageEndpointName(name);
    const preset = imageEndpointPresets.find((item) => item.name === name);
    if (!preset) {
      return;
    }
    setImageEndpointName(preset.name);
    updateImageSettings({ ...imageSettings, apiType: preset.apiType, endpoint: preset.endpoint, model: preset.model });
  };

  const saveImageEndpointPreset = () => {
    const name = (imageEndpointName.trim() || imageSettings.model.trim() || imageSettings.endpoint.trim() || imageSettings.apiType).slice(0, 80);
    const preset = { name, apiType: imageSettings.apiType, endpoint: imageSettings.endpoint.trim(), model: imageSettings.model.trim() };
    const nextPresets = [...imageEndpointPresets.filter((item) => item.name.toLowerCase() !== name.toLowerCase()), preset].sort((left, right) => left.name.localeCompare(right.name));
    setImageEndpointPresets(nextPresets);
    saveImageEndpointPresets(nextPresets);
    setSelectedImageEndpointName(name);
    setImageEndpointName(name);
    setMessage(t('extensions.endpointSaved'));
  };

  const installFromGit = async () => {
    const source = installUrl.trim();
    if (!source) {
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/extensions/install', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          source,
          branch: installBranch.trim(),
          enabled: true,
          overwrite: installOverwrite,
        }),
      });
      const data = await response.json().catch(() => null) as { extension?: ExtensionSummary; detail?: string } | null;
      if (!response.ok || !data?.extension) {
        setMessage(data?.detail || t('extensions.error.install'));
        return;
      }
      setInstallUrl('');
      setInstallBranch('');
      await loadExtensions();
      await syncSillyTavernExtensions();
      setMessage(`${t('extensions.installedOk')} (${data.extension.manifest?.display_name || data.extension.name})`);
    } finally {
      setLoading(false);
    }
  };

  const uploadExtensionZip = async (file: File | null) => {
    if (!file) {
      return;
    }
    setLoading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('overwrite', String(installOverwrite));
      const response = await fetch('/api/extensions/upload', {
        method: 'POST',
        headers: headers(false),
        body,
      });
      const data = await response.json().catch(() => null) as { extension?: ExtensionSummary; detail?: string } | null;
      if (!response.ok || !data?.extension) {
        setMessage(data?.detail || t('extensions.error.install'));
        return;
      }
      await loadExtensions();
      await syncSillyTavernExtensions();
      setMessage(`${t('extensions.installedOk')} (${data.extension.manifest?.display_name || data.extension.name})`);
    } finally {
      setLoading(false);
    }
  };

  const updateExtension = async (extension: ExtensionSummary) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/extensions/${encodeURIComponent(extension.name)}/update`, {
        method: 'POST',
        headers: headers(false),
      });
      const data = await response.json().catch(() => null) as { extension?: ExtensionSummary; detail?: string } | null;
      if (!response.ok || !data?.extension) {
        setMessage(data?.detail || t('extensions.error.update'));
        return;
      }
      await loadExtensions();
      await syncSillyTavernExtensions();
      setMessage(`${t('extensions.updatedOk')} (${data.extension.manifest?.display_name || data.extension.name})`);
    } finally {
      setLoading(false);
    }
  };

  const deleteExtension = async (extension: ExtensionSummary) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/extensions/${encodeURIComponent(extension.name)}`, { method: 'DELETE', headers: headers() });
      if (!response.ok) {
        setMessage(t('extensions.error.delete'));
        return;
      }
      setExtensions((current) => current.filter((item) => item.name !== extension.name));
      setMessage(t('extensions.deleted'));
    } finally {
      setLoading(false);
    }
  };

  const inlineImageExtension = extensions.find((extension) => extension.name === 'sillyimages' || extension.external_name.includes('sillyimages')) || null;
  const magicTranslationExtension = extensions.find((extension) => extension.name === 'magic-translation' || extension.external_name.includes('magic-translation')) || null;
  const magicTranslationEnabled = magicTranslationExtension?.enabled ?? builtInSettings.magicTranslation;
  const noriMynExtension = extensions.find((extension) => extension.name === 'norimyn-infoblock' || extension.external_name.includes('norimyn-infoblock')) || null;
  const noriMynEnabled = noriMynExtension?.enabled ?? builtInSettings.noriMynInfoblock;
  const thirdPartyExtensions = extensions.filter((extension) => extension.type !== 'system' && extension !== inlineImageExtension && extension !== magicTranslationExtension && extension !== noriMynExtension);

  return (
    <section className="extensions-manager">
      <div className="extension-install-card">
        <span className="extension-warning">{t('extensions.unstable')}</span>
        <p className="helper-text">{t('extensions.installDisabledHelp')}</p>
        <div className="key-manager-edit" style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
          <input
            value={installUrl}
            placeholder={t('extensions.installPlaceholder')}
            onChange={(event) => setInstallUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && installUrl.trim()) void installFromGit(); }}
          />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              style={{ flex: '1 1 200px' }}
              value={installBranch}
              placeholder={t('extensions.branchPlaceholder')}
              onChange={(event) => setInstallBranch(event.target.value)}
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.88rem' }}>
              <input type="checkbox" checked={installOverwrite} onChange={(event) => setInstallOverwrite(event.target.checked)} />
              <span>{t('extensions.overwrite')}</span>
            </label>
          </div>
        </div>
        <div className="preset-actions" style={{ marginTop: '10px' }}>
          <button type="button" disabled={loading || !installUrl.trim()} onClick={() => void installFromGit()}>{t('extensions.installDisabled')}</button>
          <label className="ghost-button" style={{ cursor: loading ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center' }}>
            <span>{t('extensions.uploadZip')}</span>
            <input
              type="file"
              accept=".zip,application/zip"
              style={{ display: 'none' }}
              disabled={loading}
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                event.target.value = '';
                void uploadExtensionZip(file);
              }}
            />
          </label>
          <button className="ghost-button" type="button" disabled={loading} onClick={() => void loadExtensions()}>{t('extensions.refreshList')}</button>
        </div>
      </div>

      {message ? <p className="library-message">{message}</p> : null}

      <div className="extension-list">
        <div className="preset-title-row">
          <div>
            <span className="eyebrow">{t('extensions.thirdParty')}</span>
            <h3>{t('extensions.installed')}</h3>
          </div>
        </div>
        {thirdPartyExtensions.length ? thirdPartyExtensions.map((extension) => {
          const manifest = extension.manifest || {};
          const canUpdateGit = Boolean(extension.source && /^(https?:|git@)/i.test(extension.source));
          return (
            <article className={extension.enabled ? 'extension-row enabled' : 'extension-row'} key={extension.name}>
              <div className="extension-row-main">
                <strong>{manifest.display_name || extension.name}</strong>
                <small>{extension.external_name} · {manifest.version || t('extensions.noVersion')} · {manifest.author || t('extensions.unknownAuthor')}</small>
                <small>{extension.source || t('extensions.localInstall')}</small>
              </div>
              <div className="extension-row-actions">
                <span className={extension.enabled ? 'extension-status enabled' : 'extension-status'}>{extension.enabled ? t('common.enabled') : t('common.disabled')}</span>
                <button className="ghost-button" type="button" disabled={loading || !extension.enabled} onClick={() => openExtensionSettingsPanel(extension)}>{t('common.settings')}</button>
                {canUpdateGit ? <button className="ghost-button" type="button" disabled={loading} onClick={() => void updateExtension(extension)}>{t('extensions.update')}</button> : null}
                <button type="button" disabled={loading} onClick={() => void setEnabled(extension, !extension.enabled)}>{extension.enabled ? t('common.disable') : t('common.enable')}</button>
                <button className="ghost-button danger-button" type="button" disabled={loading} onClick={() => void deleteExtension(extension)}>{t('common.delete')}</button>
              </div>
            </article>
          );
        }) : <EmptyLibrary text={t('extensions.noThirdParty')} />}
      </div>

      <div className="extension-list">
        <div className="preset-title-row">
          <div>
            <span className="eyebrow">{t('extensions.builtIn')}</span>
            <h3>{t('extensions.dtExtensions')}</h3>
          </div>
        </div>
        <article className={inlineImageExtension?.enabled ? 'extension-row enabled' : 'extension-row'}>
          <div className="extension-row-main">
            <strong>{inlineImageExtension?.manifest.display_name || 'SillyImages'}</strong>
            <small>{t('extensions.sillyImagesDesc')}</small>
          </div>
          <div className="extension-row-actions">
            <span className={inlineImageExtension?.enabled ? 'extension-status enabled' : 'extension-status'}>{inlineImageExtension?.enabled ? t('common.enabled') : t('common.disabled')}</span>
            <button className="ghost-button" type="button" disabled={loading || !inlineImageExtension?.enabled} onClick={() => inlineImageExtension && openExtensionSettingsPanel(inlineImageExtension)}>{t('common.settings')}</button>
            <button type="button" disabled={loading || !inlineImageExtension} onClick={() => inlineImageExtension && void setEnabled(inlineImageExtension, !inlineImageExtension.enabled)}>{inlineImageExtension?.enabled ? t('common.disable') : t('common.enable')}</button>
          </div>
        </article>
        <ImageExtensionSettingsPortal
          extension={inlineImageExtension}
          imageSettings={imageSettings}
          setImageSettings={updateImageSettings}
          imageEndpointPresets={imageEndpointPresets}
          selectedImageEndpointName={selectedImageEndpointName}
          imageEndpointName={imageEndpointName}
          setImageEndpointName={setImageEndpointName}
          applyImageEndpointPreset={applyImageEndpointPreset}
          saveImageEndpointPreset={saveImageEndpointPreset}
          saveImageSettings={saveImageSettings}
          applyImageKey={applyImageKey}
        />
        <article className={magicTranslationEnabled ? 'extension-row enabled' : 'extension-row'}>
          <div className="extension-row-main">
            <strong>Magic Translation</strong>
            <small>{t('extensions.magicTranslationDesc')}</small>
          </div>
          <div className="extension-row-actions">
            <span className={magicTranslationEnabled ? 'extension-status enabled' : 'extension-status'}>{magicTranslationEnabled ? t('common.enabled') : t('common.disabled')}</span>
            <button className="ghost-button" type="button" disabled={loading || !magicTranslationEnabled} onClick={() => window.dispatchEvent(new CustomEvent('doubletrouble:extension-settings-open', { detail: { name: 'magic-translation' } }))}>{t('common.settings')}</button>
            <button type="button" disabled={loading} onClick={() => void setMagicTranslationEnabled(magicTranslationExtension, !magicTranslationEnabled)}>{magicTranslationEnabled ? t('common.disable') : t('common.enable')}</button>
          </div>
        </article>
        <MagicTranslationSettingsPortal />
        <article className={noriMynEnabled ? 'extension-row enabled' : 'extension-row'}>
          <div className="extension-row-main">
            <strong>NoriMyn Infoblock</strong>
            <small>{t('extensions.noriMynDesc')}</small>
          </div>
          <div className="extension-row-actions">
            <span className={noriMynEnabled ? 'extension-status enabled' : 'extension-status'}>{noriMynEnabled ? t('common.enabled') : t('common.disabled')}</span>
            <button type="button" disabled={loading} onClick={() => void setNoriMynEnabled(noriMynExtension, !noriMynEnabled)}>{noriMynEnabled ? t('common.disable') : t('common.enable')}</button>
          </div>
        </article>
        <article className="extension-row enabled">
          <div className="extension-row-main">
            <strong>Regex</strong>
            <small>{t('extensions.regexDesc')}</small>
          </div>
          <div className="extension-row-actions">
            <span className="extension-status enabled">{t('extensions.alwaysEnabled')}</span>
            <button className="ghost-button" type="button" onClick={() => window.dispatchEvent(new CustomEvent('doubletrouble:extension-settings-open', { detail: { name: 'regex' } }))}>{t('common.settings')}</button>
          </div>
        </article>
        <RegexSettingsPortal />
      </div>
    </section>
  );
}

function SettingsSection({
  section,
  visualSettings,
  setVisualSettings,
  cards,
  personas,
  selectedPersonaId,
  personaDraft,
  setPersonaDraft,
  cardDraft,
  setCardDraft,
  setCardAvatar,
  activeCard,
  activeChat,
  setActiveChat,
  botChats,
  chatRenameDrafts,
  setChatRenameDrafts,
  generationSettings,
  setGenerationSettings,
  connectionPresets,
  activeConnectionPresetName,
  connectionPresetName,
  setConnectionPresetName,
  presetToDelete,
  setPresetToDelete,
  models,
  connectionMessage,
  libraryMessage,
  presetTypes,
  selectedPresetType,
  presets,
  selectedPresetName,
  presetNameDraft,
  presetJsonDraft,
  presetMessage,
  lorebooks,
  selectedLorebookName,
  lorebookNameDraft,
  lorebookJsonDraft,
  lorebookBindings,
  lorebookBindingDraft,
  lorebookMessage,
  activePresets,
  accessDenied,
  authUser,
  deletionLocks,
  pendingDeleteKey,
  setPendingDeleteKey,
  toggleDeletionLock,
  authDraft,
  setAuthDraft,
  authMessage,
  securityPermissions,
  authRequired,
  registrationAllowed,
  botReplyAllowed,
  accessPasswordRequired,
  securityAccessPasswordRequiredDraft,
  accessPasswordConfigured,
  securityAccessPasswordDraft,
  setAuthRequired,
  setRegistrationAllowed,
  setBotReplyAllowed,
  setSecurityAccessPasswordRequiredDraft,
  setSecurityAccessPasswordDraft,
  setSecurityPermissions,
  openImagePreview,
  imageSrc,
  editingPromptId,
  setEditingPromptId,
  importCard,
  createCard,
  updateCard,
  deleteCard,
  uploadCardAvatar,
  selectBotCard,
  createBotChat,
  selectChat,
  copyChat,
  exportChat,
  deleteChat,
  renameChat,
  createPersona,
  editPersona,
  updatePersona,
  deletePersona,
  selectLocalPersona,
  uploadPersonaAvatar,
  saveGenerationSettings,
  checkConnection,
  applyConnectionPreset,
  deleteConnectionPreset,
  changePresetType,
  selectPreset,
  setPresetNameDraft,
  setPresetJsonDraft,
  savePreset,
  importPreset,
  applyPreset,
  exportPreset,
  deletePreset,
  importSillyTavernDefaults,
  openLorebook,
  setLorebookNameDraft,
  setLorebookJsonDraft,
  setLorebookBindingDraft,
  saveLorebook,
  importLorebook,
  exportLorebook,
  deleteLorebook,
  addLorebookBinding,
  removeLorebookBinding,
  login,
  register,
  logout,
  claimAdmin,
  saveSecurityPermissions,
  securityDirty,
}: {
  section: MenuSection;
  visualSettings: VisualSettings;
  setVisualSettings: (settings: VisualSettings) => void;
  cards: CharacterCard[];
  personas: Persona[];
  selectedPersonaId: string;
  personaDraft: { name: string; description: string };
  setPersonaDraft: (draft: { name: string; description: string }) => void;
  cardDraft: CardDraft;
  setCardDraft: (draft: CardDraft) => void;
  setCardAvatar: (avatar: File | null) => void;
  activeCard: CharacterCard | null;
  activeChat: BotChat | null;
  setActiveChat: (chat: BotChat) => void;
  botChats: BotChatSummary[];
  chatRenameDrafts: Record<string, string>;
  setChatRenameDrafts: (drafts: Record<string, string>) => void;
  generationSettings: GenerationSettings;
  setGenerationSettings: (settings: GenerationSettings) => void;
  connectionPresets: ConnectionPreset[];
  activeConnectionPresetName: string;
  connectionPresetName: string;
  setConnectionPresetName: (name: string) => void;
  presetToDelete: string;
  setPresetToDelete: (name: string) => void;
  models: string[];
  connectionMessage: string;
  libraryMessage: string;
  presetTypes: PresetTypeInfo[];
  selectedPresetType: string;
  presets: PresetSummary[];
  selectedPresetName: string;
  presetNameDraft: string;
  presetJsonDraft: string;
  presetMessage: string;
  lorebooks: LorebookSummary[];
  selectedLorebookName: string;
  lorebookNameDraft: string;
  lorebookJsonDraft: string;
  lorebookBindings: LorebookBinding[];
  lorebookBindingDraft: LorebookBinding;
  lorebookMessage: string;
  activePresets: Record<string, string>;
  accessDenied: AccessDeniedState;
  authUser: AuthUser | null;
  deletionLocks: DeletionLocks;
  pendingDeleteKey: string;
  setPendingDeleteKey: (key: string) => void;
  toggleDeletionLock: (category: keyof DeletionLocks, itemId: string) => Promise<void>;
  authDraft: { username: string; password: string; adminCode: string };
  setAuthDraft: (draft: { username: string; password: string; adminCode: string }) => void;
  authMessage: string;
  securityPermissions: SecurityPermissions;
  authRequired: boolean;
  registrationAllowed: boolean;
  botReplyAllowed: boolean;
  accessPasswordRequired: boolean;
  securityAccessPasswordRequiredDraft: boolean;
  accessPasswordConfigured: boolean;
  securityAccessPasswordDraft: string;
  setAuthRequired: (required: boolean) => void;
  setRegistrationAllowed: (allowed: boolean) => void;
  setBotReplyAllowed: (allowed: boolean) => void;
  setSecurityAccessPasswordRequiredDraft: (required: boolean) => void;
  setSecurityAccessPasswordDraft: (password: string) => void;
  setSecurityPermissions: (permissions: SecurityPermissions) => void;
  openImagePreview: (src: string, title: string) => void;
  imageSrc: (src: string) => string;
  editingPromptId: string;
  setEditingPromptId: (id: string) => void;
  importCard: (file: File | null) => Promise<void>;
  createCard: () => Promise<void>;
  updateCard: (cardId: string, draft: CardDraft) => Promise<void>;
  deleteCard: (card: CharacterCard) => Promise<void>;
  uploadCardAvatar: (card: CharacterCard, file: File | null) => Promise<void>;
  selectBotCard: (card: CharacterCard) => Promise<void>;
  createBotChat: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  copyChat: (chatId: string) => Promise<void>;
  exportChat: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  renameChat: (chat: BotChatSummary) => Promise<void>;
  createPersona: () => Promise<void>;
  editPersona: (personaId: string, patch: Partial<Pick<Persona, 'name' | 'description'>>) => void;
  updatePersona: (persona: Persona) => Promise<void>;
  deletePersona: (persona: Persona) => Promise<void>;
  selectLocalPersona: (personaId: string) => void;
  uploadPersonaAvatar: (personaId: string, file: File | null) => Promise<void>;
  saveGenerationSettings: () => Promise<void>;
  checkConnection: () => Promise<void>;
  applyConnectionPreset: (presetName: string) => Promise<void>;
  deleteConnectionPreset: (presetName: string) => Promise<void>;
  changePresetType: (presetType: string) => Promise<void>;
  selectPreset: (name: string) => Promise<void>;
  setPresetNameDraft: (name: string) => void;
  setPresetJsonDraft: (json: string) => void;
  savePreset: () => Promise<void>;
  importPreset: (file: File | null) => Promise<void>;
  applyPreset: () => Promise<void>;
  exportPreset: () => Promise<void>;
  deletePreset: () => Promise<void>;
  importSillyTavernDefaults: () => Promise<void>;
  openLorebook: (name: string) => Promise<void>;
  setLorebookNameDraft: (name: string) => void;
  setLorebookJsonDraft: (json: string) => void;
  setLorebookBindingDraft: (binding: LorebookBinding) => void;
  saveLorebook: () => Promise<void>;
  importLorebook: (file: File | null) => Promise<void>;
  exportLorebook: () => Promise<void>;
  deleteLorebook: () => Promise<void>;
  addLorebookBinding: () => Promise<void>;
  removeLorebookBinding: (index: number) => Promise<void>;
  login: () => Promise<void>;
  register: () => Promise<void>;
  logout: () => Promise<void>;
  claimAdmin: () => Promise<void>;
  saveSecurityPermissions: () => Promise<void>;
  securityDirty: boolean;
}) {
  const { t } = useLocaleContext();
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [loreEntriesOpen, setLoreEntriesOpen] = useState(true);
  const [editingCardId, setEditingCardId] = useState('');
  const [cardEditDraft, setCardEditDraft] = useState<CardDraft>(emptyCardDraft);
  const [editingPersonaId, setEditingPersonaId] = useState('');
  const [editingLoreEntryUid, setEditingLoreEntryUid] = useState('');
  const presetObject = parsePresetDraft(presetJsonDraft);
  const openAiPrompts = presetObject && selectedPresetType === 'openai' ? orderedOpenAiPrompts(presetObject) : [];
  const lorebookObject = parsePresetDraft(lorebookJsonDraft) || { entries: {} };
  const lorebookEntries = lorebookEntriesFromBook(lorebookObject);
  const editingCard = cards.find((card) => card.id === editingCardId) ?? null;
  const editingPersona = personas.find((persona) => persona.id === editingPersonaId) ?? personas.find((persona) => persona.id === selectedPersonaId) ?? personas[0] ?? null;
  const startEditCard = (card: CharacterCard) => {
    setEditingCardId(card.id);
    setCardEditDraft(draftFromCard(card));
  };
  const saveEditingCard = async () => {
    if (!editingCard) {
      return;
    }
    await updateCard(editingCard.id, cardEditDraft);
    setEditingCardId('');
  };
  const updatePresetField = (key: string, value: unknown) => {
    const current = parsePresetDraft(presetJsonDraft) || {};
    setPresetJsonDraft(JSON.stringify({ ...current, [key]: value }, null, 2));
  };
  const updateReasoningPreset = (patch: Partial<ReasoningDisplaySettings>) => {
    const current = parsePresetDraft(presetJsonDraft) || {};
    const currentReasoning = reasoningSettingsFromPreset(current);
    const nextReasoning = { ...currentReasoning, ...patch };
    setPresetJsonDraft(JSON.stringify({
      ...current,
      reasoning_auto_parse: nextReasoning.autoParse,
      reasoning_auto_expand: nextReasoning.autoExpand,
      reasoning_show_hidden: nextReasoning.showHidden,
      reasoning_add_to_prompts: nextReasoning.addToPrompts,
      reasoning_max_additions: nextReasoning.maxAdditions,
      reasoning_prefix: nextReasoning.prefix,
      reasoning_suffix: nextReasoning.suffix,
      reasoning_separator: nextReasoning.separator,
    }, null, 2));
  };
  const updateAssistantPrefill = (value: string) => {
    updatePresetField('assistant_prefill', value);
  };
  const updateOpenAiPrompt = (identifier: string, patch: Record<string, unknown>) => {
    const current = parsePresetDraft(presetJsonDraft) || {};
    const prompts = Array.isArray(current.prompts) ? current.prompts : [];
    const nextPrompts = prompts.map((prompt) => {
      if (!isObjectRecord(prompt) || prompt.identifier !== identifier) {
        return prompt;
      }
      return { ...prompt, ...patch };
    });
    setPresetJsonDraft(JSON.stringify({ ...current, prompts: nextPrompts }, null, 2));
  };
  const toggleOpenAiPrompt = (identifier: string) => {
    const current = parsePresetDraft(presetJsonDraft) || {};
    const order = normalizePromptOrder(current.prompt_order);
    const target = order.find((item) => item.identifier === identifier);
    const nextOrder = target
      ? order.map((item) => item.identifier === identifier ? { ...item, enabled: !item.enabled } : item)
      : [...order, { identifier, enabled: true }];
    setPresetJsonDraft(JSON.stringify({ ...current, prompt_order: updateOpenAiPromptOrder(current.prompt_order, nextOrder) }, null, 2));
  };
  const moveOpenAiPrompt = (identifier: string, direction: -1 | 1) => {
    const current = parsePresetDraft(presetJsonDraft) || {};
    const order = buildFullPromptOrder(current);
    const index = order.findIndex((item) => item.identifier === identifier);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) {
      return;
    }
    const nextOrder = [...order];
    [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];
    setPresetJsonDraft(JSON.stringify({ ...current, prompt_order: updateOpenAiPromptOrder(current.prompt_order, nextOrder) }, null, 2));
  };
  const setOpenAiPromptPosition = (identifier: string, value: number | string) => {
    if (typeof value !== 'number') {
      return;
    }
    const current = parsePresetDraft(presetJsonDraft) || {};
    const order = buildFullPromptOrder(current);
    const index = order.findIndex((item) => item.identifier === identifier);
    if (index < 0) {
      return;
    }
    const nextIndex = clampNumber(Math.round(value) - 1, 0, order.length - 1);
    const nextOrder = [...order];
    const [item] = nextOrder.splice(index, 1);
    nextOrder.splice(nextIndex, 0, item);
    setPresetJsonDraft(JSON.stringify({ ...current, prompt_order: updateOpenAiPromptOrder(current.prompt_order, nextOrder) }, null, 2));
  };
  const deleteOpenAiPrompt = (identifier: string) => {
    const current = parsePresetDraft(presetJsonDraft) || {};
    const prompts = Array.isArray(current.prompts) ? current.prompts : [];
    const nextPrompts = prompts.filter((prompt) => !isObjectRecord(prompt) || String(prompt.identifier || '') !== identifier);
    setPresetJsonDraft(JSON.stringify({ ...current, prompts: nextPrompts, prompt_order: removePromptFromAllOrders(current.prompt_order, identifier) }, null, 2));
    if (editingPromptId === identifier) {
      setEditingPromptId('');
    }
  };
  const addOpenAiPrompt = () => {
    const current = parsePresetDraft(presetJsonDraft) || {};
    const identifier = `custom_${Date.now()}`;
    const prompts = Array.isArray(current.prompts) ? current.prompts : [];
    const order = normalizePromptOrder(current.prompt_order);
    const next = {
      ...current,
      prompts: [...prompts, { identifier, name: 'New Prompt', role: 'system', content: '', system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [] }],
      prompt_order: updateOpenAiPromptOrder(current.prompt_order, [...order, { identifier, enabled: true }]),
    };
    setPresetJsonDraft(JSON.stringify(next, null, 2));
    setEditingPromptId(identifier);
    setPromptsOpen(true);
  };

  const setLorebookDraft = (book: RawPreset) => {
    setLorebookJsonDraft(JSON.stringify({ ...book, entries: isObjectRecord(book.entries) ? book.entries : {} }, null, 2));
  };
  const updateLorebookEntry = (uid: string, patch: RawPreset) => {
    const current = parsePresetDraft(lorebookJsonDraft) || { entries: {} };
    const entries = isObjectRecord(current.entries) ? { ...current.entries } : {};
    const existing = isObjectRecord(entries[uid]) ? entries[uid] : {};
    entries[uid] = { ...existing, ...patch };
    setLorebookDraft({ ...current, entries });
  };
  const addLorebookEntry = () => {
    const current = parsePresetDraft(lorebookJsonDraft) || { entries: {} };
    const entries = isObjectRecord(current.entries) ? { ...current.entries } : {};
    const nextUid = nextLorebookUid(entries);
    entries[String(nextUid)] = {
      uid: nextUid,
      key: [],
      keysecondary: [],
      comment: 'New entry',
      content: '',
      constant: false,
      selective: false,
      order: 100,
      position: 0,
      disable: false,
      displayIndex: nextUid,
      addMemo: true,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      sticky: 0,
      cooldown: 0,
      delay: 0,
      probability: 100,
      depth: 4,
      useProbability: false,
      role: null,
      vectorized: false,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      useGroupScoring: null,
      automationId: '',
    };
    setLorebookDraft({ ...current, entries });
    setEditingLoreEntryUid(String(nextUid));
  };
  const duplicateLorebookEntry = (uid: string) => {
    const current = parsePresetDraft(lorebookJsonDraft) || { entries: {} };
    const entries = isObjectRecord(current.entries) ? { ...current.entries } : {};
    const source = isObjectRecord(entries[uid]) ? entries[uid] : null;
    if (!source) {
      return;
    }
    const nextUid = nextLorebookUid(entries);
    entries[String(nextUid)] = { ...source, uid: nextUid, comment: `${String(source.comment || 'Entry')} copy`, displayIndex: nextUid };
    setLorebookDraft({ ...current, entries });
    setEditingLoreEntryUid(String(nextUid));
  };
  const deleteLorebookEntry = (uid: string) => {
    const current = parsePresetDraft(lorebookJsonDraft) || { entries: {} };
    const entries = isObjectRecord(current.entries) ? { ...current.entries } : {};
    delete entries[uid];
    setLorebookDraft({ ...current, entries });
    if (editingLoreEntryUid === uid) {
      setEditingLoreEntryUid('');
    }
  };

  if (section === 'extensions') {
    return (
      <div className="form-stack preset-editor">
        <div className="preset-title-row">
          <div>
            <span className="eyebrow">SillyTavern compatible</span>
            <h3>{t('extensions.manager')}</h3>
          </div>
        </div>
        <ExtensionsManager />
        <div className="extension-settings-note">
          <strong>{t('extensions.enabledSettings')}</strong>
          <small>{t('extensions.enabledSettingsHelp')}</small>
        </div>
      </div>
    );
  }

  if (section === 'presets') {
    if (accessDenied.presets) {
      return (
        <div className="form-stack preset-editor">
          <div className="preset-title-row">
            <div>
              <span className="eyebrow">SillyTavern compatible</span>
              <h3>{t('presets.title')}</h3>
            </div>
          </div>
          <AccessDeniedNotice />
        </div>
      );
    }
    return (
      <div className="form-stack preset-editor">
        <div className="preset-title-row">
          <div>
            <span className="eyebrow">SillyTavern compatible</span>
            <h3>{selectedPresetType === 'openai' ? t('presets.title.openai') : t('presets.title.st')}</h3>
            <TokenBadge count={approxTokens(presetJsonDraft)} label={t('tokens.label')} />
          </div>
          <button className="ghost-button" type="button" onClick={() => void importSillyTavernDefaults()}>{t('presets.importST')}</button>
        </div>
        <TwoColumns
          left={(
            <div className="preset-select-save-row">
              <label className="field-preview">
                <span>{t('presets.select')}</span>
                <div className="preset-select-with-button">
                  <select value={selectedPresetName} onChange={(event) => void selectPreset(event.target.value)}>
                    <option value="">{t('presets.select')}</option>
                    {presets.map((preset) => <option value={preset.name} key={preset.filename}>{preset.name}{activePresets[preset.type] === preset.name ? ' · active' : ''}</option>)}
                  </select>
                  <button className="preset-save-icon-button" type="button" title={t('common.save')} onClick={() => void savePreset()} aria-label={t('common.save')}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 3h13.2L20 5.8V21H4V3Zm2 2v14h12V6.7L16.3 5H16v5H8V5H6Zm4 0v3h4V5h-4Zm-1 9h6v2H9v-2Z" />
                    </svg>
                  </button>
                </div>
              </label>
            </div>
          )}
          right={<EditableField label={t('presets.saveName')} value={presetNameDraft} onChange={setPresetNameDraft} />}
        />
        <label className="upload-card compact-upload">
          <span>{t('presets.import')}</span>
          <input type="file" accept="application/json,.json" onChange={(event) => { void importPreset(event.target.files?.[0] ?? null); event.target.value = ''; }} />
        </label>
        {selectedPresetType === 'openai' && presetObject ? (
          <div className="tavern-preset-panel">
            <section className="preset-card-section">
              <h3>{t('presets.generation')}</h3>
              <ToggleRow label={t('presets.unlimitedContext')} checked={Boolean(presetObject.max_context_unlocked)} onChange={(checked) => updatePresetField('max_context_unlocked', checked)} />
              <SliderField label={t('presets.contextSize')} value={presetObject.openai_max_context} fallback={4095} min={0} max={1000000} step={512} onChange={(value) => updatePresetField('openai_max_context', value)} />
              <NumberInputField label={t('presets.maxResponseLength')} value={presetObject.openai_max_tokens} fallback={300} min={0} step={1} onChange={(value) => updatePresetField('openai_max_tokens', value)} />
              <NumberInputField label={t('presets.swipesPerGen')} value={presetObject.n} fallback={1} min={0} step={1} onChange={(value) => updatePresetField('n', value)} />
              <ToggleRow label={t('presets.textStreaming')} checked={Boolean(presetObject.stream_openai)} onChange={(checked) => updatePresetField('stream_openai', checked)} />
              <SliderField label={t('presets.temperature')} value={presetObject.temperature} fallback={1} min={0} max={2} step={0.01} onChange={(value) => updatePresetField('temperature', value)} />
              <SliderField label={t('presets.frequencyPenalty')} value={presetObject.frequency_penalty} fallback={0} min={-2} max={2} step={0.01} onChange={(value) => updatePresetField('frequency_penalty', value)} />
              <SliderField label={t('presets.presencePenalty')} value={presetObject.presence_penalty} fallback={0} min={-2} max={2} step={0.01} onChange={(value) => updatePresetField('presence_penalty', value)} />
              <SliderField label="Top P" value={presetObject.top_p} fallback={1} min={0} max={1} step={0.01} onChange={(value) => updatePresetField('top_p', value)} />
            </section>

            <details className="preset-card-section collapsible-preset-section">
              <summary>{t('presets.systemPrompts')}</summary>
              <div className="collapsible-section-body">
                <NumberInputField label={t('presets.seed')} value={presetObject.seed} fallback={-1} step={1} onChange={(value) => updatePresetField('seed', value)} />
                <NumberInputField label={t('presets.nameInsertion')} value={presetObject.names_behavior} fallback={0} min={0} step={1} onChange={(value) => updatePresetField('names_behavior', value)} />
                <EditableField label={t('presets.continueNudge')} value={String(presetObject.continue_nudge_prompt ?? '')} onChange={(value) => updatePresetField('continue_nudge_prompt', value)} />
                <ToggleRow label={t('presets.continuePrefill')} checked={Boolean(presetObject.continue_prefill)} onChange={(checked) => updatePresetField('continue_prefill', checked)} />
                <ToggleRow label={t('presets.squashSystemMessages')} checked={Boolean(presetObject.squash_system_messages)} onChange={(checked) => updatePresetField('squash_system_messages', checked)} />
                <ToggleRow label={t('presets.functionCalling')} checked={Boolean(presetObject.function_calling)} onChange={(checked) => updatePresetField('function_calling', checked)} />
                <ToggleRow label={t('presets.sendInlineMedia')} checked={Boolean(presetObject.send_inline_images)} onChange={(checked) => updatePresetField('send_inline_images', checked)} />
                <ToggleRow label={t('presets.requestReasoning')} checked={presetObject.show_thoughts !== false} onChange={(checked) => updatePresetField('show_thoughts', checked)} />
                <SelectField label={t('presets.reasoning')} value={String(presetObject.reasoning_effort ?? 'auto')} options={['auto', 'minimal', 'low', 'medium', 'high']} onChange={(value) => updatePresetField('reasoning_effort', value)} />
                <SelectField label="Verbosity" value={String(presetObject.verbosity ?? 'auto')} options={['auto', 'low', 'medium', 'high']} onChange={(value) => updatePresetField('verbosity', value)} />
              </div>
            </details>

            <section className="preset-card-section">
              <div className="preset-title-row">
                <div>
                  <h3>{t('presets.promptEditor')}</h3>
                  <small>{t('presets.promptEditorHelp')}</small>
                </div>
                <div className="prompt-header-actions">
                  <button className="ghost-button" type="button" onClick={() => setPromptsOpen((open) => !open)}>{promptsOpen ? t('common.collapse') : `${t('common.show')} (${openAiPrompts.length})`}</button>
                  <button type="button" onClick={addOpenAiPrompt}>{t('common.add')}</button>
                </div>
              </div>
              {promptsOpen ? <div className="prompt-list">
                {openAiPrompts.map(({ prompt, enabled }) => {
                  const identifier = String(prompt.identifier || prompt.name || 'prompt');
                  const isEditing = editingPromptId === identifier;
                  const isInChatPrompt = String(prompt.injection_position ?? 0) === '1';
                  const promptKind = isInChatPrompt ? 'In-chat' : prompt.marker ? 'Marker' : prompt.system_prompt ? 'System' : 'Preset';
                  const promptPosition = Math.max(1, buildFullPromptOrder(presetObject).findIndex((item) => item.identifier === identifier) + 1);
                  return (
                    <article className={enabled ? 'prompt-row enabled' : 'prompt-row'} key={identifier}>
                      <button className="drag-handle" type="button" aria-label={t('presets.moveUp')} onClick={() => moveOpenAiPrompt(identifier, -1)}>↑</button>
                      <span className="prompt-kind">{isInChatPrompt ? '@' : prompt.marker ? '◆' : prompt.system_prompt ? '★' : '*'}</span>
                      <div className="prompt-main">
                        <strong>{String(prompt.name || identifier)}</strong>
                        <small>#{promptPosition} · {promptKind} · {String(prompt.role || 'system')} · {approxTokens(String(prompt.content || ''))} {t('message.tokens')}</small>
                      </div>
                      <button className="prompt-icon" type="button" title={t('presets.moveDown')} onClick={() => moveOpenAiPrompt(identifier, 1)}>↓</button>
                      <button className="prompt-icon" type="button" title={t('common.edit')} onClick={() => setEditingPromptId(isEditing ? '' : identifier)}><Icon name="edit" /></button>
                      <button className="prompt-icon danger" type="button" title={prompt.system_prompt ? t('presets.cannotDeleteSystem') : t('common.delete')} disabled={Boolean(prompt.system_prompt)} onClick={() => deleteOpenAiPrompt(identifier)}><Icon name="trash" /></button>
                      <button className={enabled ? 'prompt-toggle active' : 'prompt-toggle'} type="button" onClick={() => toggleOpenAiPrompt(identifier)} aria-label="Toggle prompt"><i /></button>
                      {isEditing ? (
                        <div className="prompt-edit-panel">
                          <div className="prompt-edit-header">
                            <div>
                              <h4>Edit</h4>
                              <small>{String(prompt.name || 'Prompt settings')}</small>
                            </div>
                            <button className="ghost-button" type="button" onClick={() => setEditingPromptId('')}>{t('common.close')}</button>
                          </div>
                          <div className="prompt-edit-grid">
                            <EditableField label="Name" value={String(prompt.name || '')} onChange={(value) => updateOpenAiPrompt(identifier, { name: value })} />
                            <SelectField label="Role" value={String(prompt.role || 'system')} options={['system', 'user', 'assistant']} onChange={(value) => updateOpenAiPrompt(identifier, { role: value })} />
                            <SelectChoicesField label="Position" value={String(prompt.injection_position ?? 0)} options={[["0", "Relative"], ["1", "In-chat @ Depth"]]} onChange={(value) => updateOpenAiPrompt(identifier, { injection_position: Number(value) })} />
                            {isInChatPrompt ? <NumberInputField label="Depth" value={prompt.injection_depth} fallback={4} min={0} max={9999} step={1} onChange={(value) => updateOpenAiPrompt(identifier, { injection_depth: value })} /> : <NumberInputField label={t('presets.listPosition')} value={promptPosition} fallback={promptPosition} min={1} max={openAiPrompts.length} step={1} onChange={(value) => setOpenAiPromptPosition(identifier, value)} />}
                            {isInChatPrompt ? <NumberInputField label="Order" value={prompt.injection_order} fallback={100} min={0} max={9999} step={1} onChange={(value) => updateOpenAiPrompt(identifier, { injection_order: value })} /> : <div className="relative-position-help"><span>Relative</span><small>{t('presets.relativePositionHelp')}</small></div>}
                          </div>
                          <CheckboxGroupField label="Triggers" values={promptTriggerValues(prompt.injection_trigger)} options={['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']} onChange={(values) => updateOpenAiPrompt(identifier, { injection_trigger: values })} />
                          <div className="prompt-option-list">
                            <PromptOptionRow title="Forbid Overrides" text={t('presets.forbidOverridesHelp')} checked={Boolean(prompt.forbid_overrides)} onChange={(checked) => updateOpenAiPrompt(identifier, { forbid_overrides: checked })} />
                            <PromptOptionRow title="System Prompt" text={t('presets.systemPromptHelp')} checked={Boolean(prompt.system_prompt)} onChange={(checked) => updateOpenAiPrompt(identifier, { system_prompt: checked })} />
                            <PromptOptionRow title="Marker" text={t('presets.markerHelp')} checked={Boolean(prompt.marker)} onChange={(checked) => updateOpenAiPrompt(identifier, { marker: checked })} />
                          </div>
                          <EditableTextArea label="Prompt" value={String(prompt.content || '')} disabled={Boolean(prompt.marker)} onChange={(value) => updateOpenAiPrompt(identifier, { content: value })} />
                          {prompt.marker ? <small>Marker prompt content is pulled from context pieces, like in SillyTavern.</small> : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div> : <p className="prompt-list-collapsed">{t('presets.promptListCollapsed')}</p>}
            </section>

            <ReasoningPresetPanel
              settings={reasoningSettingsFromPreset(presetObject)}
              assistantPrefill={String(presetObject.assistant_prefill ?? '')}
              update={updateReasoningPreset}
              updateAssistantPrefill={updateAssistantPrefill}
            />
          </div>
        ) : null}

        <details className="raw-preset-details">
          <summary>{t('presets.rawJson')}</summary>
          <EditableTextArea label="Raw JSON" value={presetJsonDraft} onChange={setPresetJsonDraft} />
        </details>
        {presetMessage ? <p className="library-message">{presetMessage}</p> : null}
        <div className="preset-actions">
          <button type="button" onClick={() => void exportPreset()}>{t('presets.export')}</button>
          <button type="button" onClick={() => void deletePreset()}>{t('common.delete')}</button>
        </div>
      </div>
    );
  }

  if (section === 'connection') {
    return (
      <div className="form-stack connection-settings-panel">
        {accessDenied.presets ? <AccessDeniedNotice /> : null}
        <div className="connection-preset-bar">
          <label className="field-preview">
            <span>{t('connection.preset')}</span>
            <select value={activeConnectionPresetName} onChange={(event) => void applyConnectionPreset(event.target.value)}>
              <option value="">{t('connection.preset.select')}</option>
              {connectionPresets.map((preset) => <option value={preset.name} key={preset.name}>{preset.name}{activeConnectionPresetName === preset.name ? ' · active' : ''}</option>)}
            </select>
          </label>
          <div className="connection-save-row">
            <EditableField label={t('connection.preset.saveName')} value={connectionPresetName} onChange={setConnectionPresetName} />
            <button type="button" onClick={() => void saveGenerationSettings()}>{t('connection.preset.save')}</button>
          </div>
        </div>
        {(() => {
          const sourceId = generationSettings.chat_completion_source && generationSettings.chat_completion_source !== 'disabled' ? generationSettings.chat_completion_source : (generationSettings.provider === 'disabled' ? '' : generationSettings.chat_completion_source);
          const selectedSourceId = generationSettings.chat_completion_source || (generationSettings.provider === 'disabled' ? 'disabled' : '');
          const sourceMeta = sourceById(selectedSourceId);
          const sourceExtras = (generationSettings.source_settings || {})[selectedSourceId] || {};
          const updateExtras = (patch: Record<string, unknown>) => {
            const nextExtras = { ...sourceExtras, ...patch };
            setGenerationSettings({
              ...generationSettings,
              source_settings: { ...(generationSettings.source_settings || {}), [selectedSourceId]: nextExtras },
            });
          };
          const updateParameters = (patch: Record<string, unknown>) => {
            const nextParameters = { ...(generationSettings.parameters || {}), ...patch };
            setGenerationSettings({ ...generationSettings, parameters: nextParameters });
          };
          const handleSourceChange = (nextSourceId: string) => {
            const meta = sourceById(nextSourceId);
            // Always reset base URL to the new source's default; keep an existing override
            // only when the previous source had no default (custom / azure) so user-typed URLs persist.
            const previousMeta = sourceById(selectedSourceId);
            const previousHadDefault = Boolean(previousMeta?.default_base_url);
            const nextBaseUrl = nextSourceId === 'disabled'
              ? ''
              : (previousHadDefault ? (meta?.default_base_url || '') : (generationSettings.base_url || meta?.default_base_url || ''));
            setGenerationSettings({
              ...generationSettings,
              provider: nextSourceId,
              chat_completion_source: nextSourceId,
              base_url: nextBaseUrl,
            });
          };
          const extraFieldKey = selectedSourceId;
          void sourceId;
          void extraFieldKey;
          return (
            <>
              <label className="field-preview">
                <span>{t('connection.source')}</span>
                <select value={selectedSourceId || 'disabled'} onChange={(event) => handleSourceChange(event.target.value)}>
                  {getChatCompletionSourceOptions(t).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              {sourceMeta?.custom_url_field || sourceMeta?.supports_reverse_proxy || !sourceMeta ? (
                <EditableField
                  label={sourceMeta?.custom_url_field ? t('connection.endpoint') : t('connection.endpoint.optional')}
                  value={generationSettings.base_url}
                  onChange={(base_url) => setGenerationSettings({ ...generationSettings, base_url })}
                />
              ) : (
                <p className="helper-text">{t('connection.baseUrl')}: <code>{sourceMeta.default_base_url}</code></p>
              )}
              <TwoColumns
                left={(
                  <label className="field-preview model-field">
                    <span>{t('connection.model')}</span>
                    <input value={generationSettings.model} onChange={(event) => setGenerationSettings({ ...generationSettings, model: event.target.value })} />
                    <select className="model-picker" value={models.includes(generationSettings.model) ? generationSettings.model : ''} disabled={!models.length} onChange={(event) => event.target.value && setGenerationSettings({ ...generationSettings, model: event.target.value })}>
                      <option value="">{models.length ? t('connection.model.select') : t('connection.model.empty')}</option>
                      {models.map((model) => <option value={model} key={model}>{model}</option>)}
                    </select>
                    <button className="ghost-button model-load-button" type="button" onClick={() => void checkConnection()}>{t('connection.model.check')}</button>
                    {connectionMessage ? <p className="library-message connection-message-inline">{connectionMessage}</p> : null}
                  </label>
                )}
                right={<KeyManager mode="popover" />}
              />
              {sourceMeta && sourceMeta.extra_field_keys.length > 0 ? (
                <details className="connection-params-section">
                  <summary>Дополнительные параметры запроса и заголовки</summary>
                  <div className="connection-source-extras">
                    {sourceMeta.extra_field_keys.map((key) => {
                      const label = getExtraFieldLabels(t)[key] || key;
                      const raw = sourceExtras[key];
                      if (booleanExtraFields.has(key)) {
                        return (
                          <label className="field-preview checkbox-inline-field" key={key}>
                            <input type="checkbox" checked={Boolean(raw)} onChange={(event) => updateExtras({ [key]: event.target.checked })} />
                            <span>{label}</span>
                          </label>
                        );
                      }
                      if (longTextExtraFields.has(key)) {
                        return (
                          <label className="field-preview" key={key}>
                            <span>{label}</span>
                            <textarea value={typeof raw === 'string' ? raw : ''} onChange={(event) => updateExtras({ [key]: event.target.value })} />
                          </label>
                        );
                      }
                      return (
                        <EditableField
                          key={key}
                          label={label}
                          value={typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''}
                          onChange={(value) => updateExtras({ [key]: value })}
                        />
                      );
                    })}
                  </div>
                </details>
              ) : null}
              {sourceMeta && sourceMeta.supports_reverse_proxy ? (
                <details className="connection-proxy-section">
                  <summary>{t('connection.reverseProxy')}</summary>
                  <EditableField
                    label={t('connection.proxyUrl')}
                    value={generationSettings.reverse_proxy}
                    onChange={(reverse_proxy) => setGenerationSettings({ ...generationSettings, reverse_proxy })}
                  />
                  <label className="field-preview">
                    <span>{t('connection.proxyPassword')} {generationSettings.proxy_password_configured ? t('connection.proxyPassword.set') : ''}</span>
                    <input
                      type="password"
                      value={generationSettings.proxy_password}
                      placeholder={generationSettings.proxy_password_configured ? t('connection.proxyPassword.placeholder.new') : t('connection.proxyPassword.placeholder.empty')}
                      onChange={(event) => setGenerationSettings({ ...generationSettings, proxy_password: event.target.value, clear_proxy_password: false })}
                    />
                  </label>
                  {generationSettings.proxy_password_configured ? (
                    <button type="button" className="ghost-button" onClick={() => setGenerationSettings({ ...generationSettings, proxy_password: '', clear_proxy_password: true })}>
                      {t('connection.proxyPassword.clear')}
                    </button>
                  ) : null}
                  <p className="helper-text">{t('connection.proxy.help')}</p>
                </details>
              ) : null}
              {sourceMeta && sourceMeta.extra_param_keys.length > 0 ? (
                <details className="connection-params-section">
                  <summary>{t('connection.extraParams')}</summary>
                  <div className="connection-source-extras">
                    {sourceMeta.extra_param_keys.map((key) => {
                      const label = extraParamLabels[key] || key;
                      const raw = (generationSettings.parameters || {})[key];
                      return (
                        <EditableField
                          key={key}
                          label={label}
                          value={typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''}
                          onChange={(value) => {
                            if (!value.trim()) {
                              const next = { ...(generationSettings.parameters || {}) };
                              delete next[key];
                              setGenerationSettings({ ...generationSettings, parameters: next });
                              return;
                            }
                            const numeric = Number(value);
                            updateParameters({ [key]: Number.isFinite(numeric) && value.trim() !== '' && !isNaN(numeric) && !value.trim().match(/^[a-z]/i) ? numeric : value });
                          }}
                        />
                      );
                    })}
                  </div>
                </details>
              ) : null}
            </>
          );
        })()}
        <details className="connection-params-section">
          <summary>Прочие настройки профиля (удаление, лимиты по умолчанию)</summary>
          <div className="connection-source-extras">
            <TwoColumns
              left={<NumberInputField label={t('connection.temperature')} value={generationSettings.temperature} fallback={0.8} min={0} max={2} step={0.05} onChange={(temperature) => setGenerationSettings({ ...generationSettings, temperature: Number(temperature) || 0 })} />}
              right={<NumberInputField label={t('connection.maxTokens')} value={generationSettings.max_tokens} fallback={350} min={1} max={128000} step={50} onChange={(maxTokens) => setGenerationSettings({ ...generationSettings, max_tokens: Number(maxTokens) || 1 })} />}
            />
            {connectionPresets.length > 0 ? (
              <div className="field-preview delete-preset-field">
                <span>{t('connection.preset.delete')}</span>
                <div className="delete-preset-row">
                  <select value={presetToDelete} onChange={(event) => setPresetToDelete(event.target.value)}>
                    <option value="">{t('connection.preset.select')}</option>
                    {connectionPresets.map((preset) => <option value={preset.name} key={preset.name}>{preset.name}</option>)}
                  </select>
                  <button type="button" onClick={() => void deleteConnectionPreset(presetToDelete)}>{t('common.delete')}</button>
                </div>
              </div>
            ) : null}
          </div>
        </details>
      </div>
    );
  }

  if (section === 'visual') {
    const activeTheme = themes.find((theme) => theme.id === visualSettings.theme) || themes[0];
    return (
      <div className="form-stack visual-settings">
        <details className="visual-group theme-details">
          <summary>
            <span className="theme-summary-label">{t('visual.theme')}</span>
            <strong>{activeTheme.name}</strong>
            <span className="theme-summary-action">{t('visual.palettes')}</span>
          </summary>
          <div className="theme-columns">
            <section className="theme-column">
              <h4>{t('visual.darkThemes')}</h4>
              <div className="theme-grid">
                {darkThemes.map((theme) => (
                  <button
                    className={visualSettings.theme === theme.id ? 'theme-card active' : 'theme-card'}
                    key={theme.id}
                    type="button"
                    onClick={() => setVisualSettings({ ...visualSettings, theme: theme.id })}
                  >
                    <span className="theme-swatches">
                      {theme.swatches.map((swatch) => <i key={swatch} style={{ background: swatch }} />)}
                    </span>
                    <strong>{theme.name}</strong>
                    <small>{t(theme.description)}</small>
                  </button>
                ))}
              </div>
            </section>
            <section className="theme-column">
              <h4>{t('visual.lightThemes')}</h4>
              <div className="theme-grid">
                {lightThemes.map((theme) => (
                  <button
                    className={visualSettings.theme === theme.id ? 'theme-card active' : 'theme-card'}
                    key={theme.id}
                    type="button"
                    onClick={() => setVisualSettings({ ...visualSettings, theme: theme.id })}
                  >
                    <span className="theme-swatches">
                      {theme.swatches.map((swatch) => <i key={swatch} style={{ background: swatch }} />)}
                    </span>
                    <strong>{theme.name}</strong>
                    <small>{t(theme.description)}</small>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </details>

        <section className="visual-group">
          <h3>{t('visual.readability')}</h3>
          <SegmentedControl
            label={t('visual.textSize')}
            value={visualSettings.textScale}
            options={[
              ['tiny', t('visual.textSize.tiny')],
              ['small', t('visual.textSize.small')],
              ['normal', t('visual.textSize.normal')],
              ['large', t('visual.textSize.large')],
              ['huge', t('visual.textSize.huge')],
            ]}
            onChange={(textScale) => setVisualSettings({ ...visualSettings, textScale: textScale as VisualSettings['textScale'] })}
          />
          <SegmentedControl
            label={t('visual.density')}
            value={visualSettings.density}
            options={[
              ['compact', t('visual.density.compact')],
              ['comfortable', t('visual.density.comfortable')],
              ['spacious', t('visual.density.spacious')],
            ]}
            onChange={(density) => setVisualSettings({ ...visualSettings, density: density as VisualSettings['density'] })}
          />
          <SegmentedControl
            label={t('visual.messageWidth')}
            value={visualSettings.messageWidth}
            options={[
              ['narrow', t('visual.messageWidth.narrow')],
              ['standard', t('visual.messageWidth.standard')],
              ['wide', t('visual.messageWidth.wide')],
            ]}
            onChange={(messageWidth) => setVisualSettings({ ...visualSettings, messageWidth: messageWidth as VisualSettings['messageWidth'] })}
          />
        </section>

        <section className="visual-group">
          <h3>{t('visual.behavior')}</h3>
          <SegmentedControl
            label={t('visual.radius')}
            value={visualSettings.radius}
            options={[
              ['sharp', t('visual.radius.sharp')],
              ['soft', t('visual.radius.soft')],
              ['round', t('visual.radius.round')],
            ]}
            onChange={(radius) => setVisualSettings({ ...visualSettings, radius: radius as VisualSettings['radius'] })}
          />
          <ToggleRow label={t('visual.motion')} checked={visualSettings.motion} onChange={(motion) => setVisualSettings({ ...visualSettings, motion })} />
          <ToggleRow label={t('visual.highContrast')} checked={visualSettings.highContrast} onChange={(highContrast) => setVisualSettings({ ...visualSettings, highContrast })} />
          <ToggleRow label={t('visual.showAvatars')} checked={visualSettings.showAvatars} onChange={(showAvatars) => setVisualSettings({ ...visualSettings, showAvatars })} />
          <ToggleRow label={t('visual.stickyComposer')} checked={visualSettings.stickyComposer} onChange={(stickyComposer) => setVisualSettings({ ...visualSettings, stickyComposer })} />
        </section>

        <section className="visual-group">
          <h3>{t('visual.decorations')}</h3>
          <ToggleRow label={t('visual.gradients')} checked={visualSettings.gradients} onChange={(gradients) => setVisualSettings({ ...visualSettings, gradients })} />
          <ToggleRow label={t('visual.glass')} checked={visualSettings.glass} onChange={(glass) => setVisualSettings({ ...visualSettings, glass })} />
          <ToggleRow label={t('visual.texture')} checked={visualSettings.texture} onChange={(texture) => setVisualSettings({ ...visualSettings, texture })} />
          <ToggleRow label={t('visual.panelShadows')} checked={visualSettings.panelShadows} onChange={(panelShadows) => setVisualSettings({ ...visualSettings, panelShadows })} />
          <ToggleRow label={t('visual.messageTint')} checked={visualSettings.messageTint} onChange={(messageTint) => setVisualSettings({ ...visualSettings, messageTint })} />
          <ToggleRow label={t('visual.backgroundVignette')} checked={visualSettings.backgroundVignette} onChange={(backgroundVignette) => setVisualSettings({ ...visualSettings, backgroundVignette })} />
        </section>

        <button type="button" onClick={() => setVisualSettings(defaultVisualSettings)}>{t('visual.reset')}</button>
      </div>
    );
  }

  if (section === 'lorebooks') {
    const bindingTargetOptions = lorebookBindingDraft.target_type === 'card'
      ? cards.map((card) => ({ id: card.id, label: card.name }))
      : lorebookBindingDraft.target_type === 'chat'
        ? botChats.map((chat) => ({ id: chat.id, label: chat.title }))
        : lorebookBindingDraft.target_type === 'persona'
          ? personas.map((persona) => ({ id: persona.id, label: persona.name }))
          : [];
    return (
      <div className="form-stack preset-editor">
        <div className="preset-title-row">
          <div>
            <span className="eyebrow">SillyTavern World Info</span>
            <h3>{t('lorebooks.title')}</h3>
            <TokenBadge count={lorebookTokenCount(lorebookEntries)} label={t('lorebooks.tokens')} />
          </div>
          <button className="ghost-button" type="button" onClick={() => void exportLorebook()}>{t('lorebooks.export')}</button>
        </div>
        {accessDenied.lorebooks ? <AccessDeniedNotice /> : <>
          <TwoColumns
            left={(
              <label className="field-preview">
                <span>{t('lorebooks.title')}</span>
                <select value={selectedLorebookName} onChange={(event) => void openLorebook(event.target.value)}>
                  <option value="">{t('lorebooks.select')}</option>
                  {lorebooks.map((book) => <option value={book.name} key={book.filename}>{book.name} · {book.entry_count} entries</option>)}
                </select>
              </label>
            )}
            right={<EditableField label={t('lorebooks.saveName')} value={lorebookNameDraft} onChange={setLorebookNameDraft} />}
          />
          <label className="upload-card compact-upload">
            <span>{t('lorebooks.importST')}</span>
            <small>{t('lorebooks.importHelp')}</small>
            <input type="file" accept="application/json,.json" onChange={(event) => { void importLorebook(event.target.files?.[0] ?? null); event.target.value = ''; }} />
          </label>
          <section className="preset-card-section">
            <div className="preset-title-row">
              <div>
                <h3>{t('lorebooks.entries')}</h3>
                <small>{t('lorebooks.entriesHelp')}</small>
              </div>
              <div className="prompt-header-actions">
                <button className="ghost-button" type="button" onClick={() => setLoreEntriesOpen((open) => !open)}>{loreEntriesOpen ? t('common.collapse') : `${t('common.show')} (${lorebookEntries.length})`}</button>
                <button type="button" onClick={addLorebookEntry}>{t('lorebooks.addEntry')}</button>
              </div>
            </div>
            {loreEntriesOpen ? <div className="prompt-list">
              {lorebookEntries.length ? lorebookEntries.map((entry) => {
                const uid = String(entry.uid ?? '0');
                const isEditing = editingLoreEntryUid === uid;
                const disabled = Boolean(entry.disable);
                return (
                  <article className={disabled ? 'prompt-row lore-entry-row' : 'prompt-row lore-entry-row enabled'} key={uid}>
                    <span className="prompt-kind">{disabled ? '×' : '◆'}</span>
                    <div className="prompt-main">
                      <strong>{String(entry.comment || `Entry ${uid}`)}</strong>
                      <small>uid {uid} · {lorebookPositionLabel(entry.position)} · order {String(entry.order ?? 100)} · {entryTokenCount(entry)} {t('message.tokens')} · {csvFromArray(entry.key).join(', ') || t('lorebooks.noKeys')}</small>
                    </div>
                    <div className="lore-entry-actions">
                      <button className="prompt-icon" type="button" title={t('common.edit')} onClick={() => setEditingLoreEntryUid(isEditing ? '' : uid)}><Icon name="edit" /></button>
                      <button className="prompt-icon" type="button" title={t('common.duplicate')} onClick={() => duplicateLorebookEntry(uid)}>⧉</button>
                      <button className="prompt-icon danger" type="button" title={t('common.delete')} onClick={() => deleteLorebookEntry(uid)}><Icon name="trash" /></button>
                      <button className={disabled ? 'prompt-toggle' : 'prompt-toggle active'} type="button" onClick={() => updateLorebookEntry(uid, { disable: !disabled })} aria-label={t('common.toggle')}><i /></button>
                    </div>
                    {isEditing ? (
                      <div className="prompt-edit-panel">
                        <div className="prompt-edit-header">
                          <div>
                            <h4>{String(entry.comment || `Entry ${uid}`)}</h4>
                            <small>{t('lorebooks.entryFieldsHelp')} {entryTokenCount(entry)} {t('message.tokens')}</small>
                          </div>
                          <button className="ghost-button" type="button" onClick={() => setEditingLoreEntryUid('')}>{t('common.close')}</button>
                        </div>
                        <div className="prompt-edit-grid">
                          <EditableField label="Comment / Memo" value={String(entry.comment || '')} onChange={(value) => updateLorebookEntry(uid, { comment: value })} />
                          <EditableField label="Automation ID" value={String(entry.automationId || '')} onChange={(value) => updateLorebookEntry(uid, { automationId: value })} />
                          <NumberInputField label="Display Index" value={entry.displayIndex} fallback={numberField(entry.uid, 0)} step={1} onChange={(value) => updateLorebookEntry(uid, { displayIndex: value })} />
                          <NumberInputField label="Order" value={entry.order} fallback={100} step={1} onChange={(value) => updateLorebookEntry(uid, { order: value })} />
                          <SelectChoicesField label="Position" value={String(entry.position ?? 0)} options={[["0", "↑Char / Before"], ["1", "↓Char / After"], ["2", "↑Author's Note"], ["3", "↓Author's Note"], ["4", "@ Depth"], ["5", "↑Examples"], ["6", "↓Examples"], ["7", "Outlet"]]} onChange={(value) => updateLorebookEntry(uid, { position: Number(value) })} />
                          <SelectChoicesField label="Role @ Depth" value={String(entry.role ?? 'null')} options={[["null", "Default/System"], ["0", "System"], ["1", "User"], ["2", "Assistant"]]} onChange={(value) => updateLorebookEntry(uid, { role: value === 'null' ? null : Number(value) })} />
                          <NumberInputField label="Depth" value={entry.depth} fallback={4} min={0} step={1} onChange={(value) => updateLorebookEntry(uid, { depth: value })} />
                          <EditableField label="Group" value={String(entry.group || '')} onChange={(value) => updateLorebookEntry(uid, { group: value })} />
                          <NumberInputField label="Group Weight" value={entry.groupWeight} fallback={100} step={1} onChange={(value) => updateLorebookEntry(uid, { groupWeight: value })} />
                          <NumberInputField label="Probability %" value={entry.probability} fallback={100} min={0} max={100} step={1} onChange={(value) => updateLorebookEntry(uid, { probability: value })} />
                          <NumberInputField label="Sticky" value={entry.sticky} fallback={0} min={0} step={1} onChange={(value) => updateLorebookEntry(uid, { sticky: value })} />
                          <NumberInputField label="Cooldown" value={entry.cooldown} fallback={0} min={0} step={1} onChange={(value) => updateLorebookEntry(uid, { cooldown: value })} />
                          <NumberInputField label="Delay" value={entry.delay} fallback={0} min={0} step={1} onChange={(value) => updateLorebookEntry(uid, { delay: value })} />
                          <NumberInputField label="Scan Depth" value={entry.scanDepth ?? ''} fallback={0} min={0} step={1} onChange={(value) => updateLorebookEntry(uid, { scanDepth: value === '' ? null : value })} />
                        </div>
                        <TwoColumns
                          left={<EditableTextArea label="Primary Keys (one per line or comma)" value={csvFromArray(entry.key).join('\n')} onChange={(value) => updateLorebookEntry(uid, { key: csvToArray(value) })} />}
                          right={<EditableTextArea label="Secondary Keys" value={csvFromArray(entry.keysecondary).join('\n')} onChange={(value) => updateLorebookEntry(uid, { keysecondary: csvToArray(value) })} />}
                        />
                        <EditableTextArea label="Content" value={String(entry.content || '')} onChange={(value) => updateLorebookEntry(uid, { content: value })} />
                        <div className="prompt-option-list">
                          <PromptOptionRow title="Enabled" text={t('lorebooks.enabledHelp')} checked={!disabled} onChange={(checked) => updateLorebookEntry(uid, { disable: !checked })} />
                          <PromptOptionRow title="Constant" text={t('lorebooks.constantHelp')} checked={Boolean(entry.constant)} onChange={(checked) => updateLorebookEntry(uid, { constant: checked })} />
                          <PromptOptionRow title="Selective" text={t('lorebooks.selectiveHelp')} checked={Boolean(entry.selective)} onChange={(checked) => updateLorebookEntry(uid, { selective: checked })} />
                          <PromptOptionRow title="Use Probability" text={t('lorebooks.useProbabilityHelp')} checked={Boolean(entry.useProbability)} onChange={(checked) => updateLorebookEntry(uid, { useProbability: checked })} />
                          <PromptOptionRow title="Add Memo" text={t('lorebooks.addMemoHelp')} checked={entry.addMemo !== false} onChange={(checked) => updateLorebookEntry(uid, { addMemo: checked })} />
                          <PromptOptionRow title="Group Override" text={t('lorebooks.groupOverrideHelp')} checked={Boolean(entry.groupOverride)} onChange={(checked) => updateLorebookEntry(uid, { groupOverride: checked })} />
                          <PromptOptionRow title="Use Group Scoring" text={t('lorebooks.nullGlobalHelp')} checked={entry.useGroupScoring === true} onChange={(checked) => updateLorebookEntry(uid, { useGroupScoring: checked ? true : null })} />
                          <PromptOptionRow title="Case Sensitive" text={t('lorebooks.nullGlobalHelp')} checked={entry.caseSensitive === true} onChange={(checked) => updateLorebookEntry(uid, { caseSensitive: checked ? true : null })} />
                          <PromptOptionRow title="Match Whole Words" text={t('lorebooks.nullGlobalHelp')} checked={entry.matchWholeWords === true} onChange={(checked) => updateLorebookEntry(uid, { matchWholeWords: checked ? true : null })} />
                          <PromptOptionRow title="Vectorized" text={t('lorebooks.vectorizedHelp')} checked={Boolean(entry.vectorized)} onChange={(checked) => updateLorebookEntry(uid, { vectorized: checked })} />
                          <PromptOptionRow title="Exclude Recursion" text={t('lorebooks.excludeRecursionHelp')} checked={Boolean(entry.excludeRecursion)} onChange={(checked) => updateLorebookEntry(uid, { excludeRecursion: checked })} />
                          <PromptOptionRow title="Prevent Recursion" text={t('lorebooks.preventRecursionHelp')} checked={Boolean(entry.preventRecursion)} onChange={(checked) => updateLorebookEntry(uid, { preventRecursion: checked })} />
                          <PromptOptionRow title="Delay Until Recursion" text={t('lorebooks.delayUntilRecursionHelp')} checked={Boolean(entry.delayUntilRecursion)} onChange={(checked) => updateLorebookEntry(uid, { delayUntilRecursion: checked })} />
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              }) : <p className="empty-library">{t('lorebooks.emptyEntries')}</p>}
            </div> : <p className="prompt-list-collapsed">{t('lorebooks.entriesCollapsed')}</p>}
          </section>
          <section className="preset-card-section">
            <div className="preset-title-row">
              <div>
                <h3>{t('lorebooks.bindings')}</h3>
                <small>{t('lorebooks.bindingsHelp')}</small>
              </div>
              <button type="button" onClick={() => void addLorebookBinding()}>{t('lorebooks.addBinding')}</button>
            </div>
            <div className="prompt-edit-grid">
              <label className="field-preview">
                <span>{t('lorebooks.title')}</span>
                <select value={lorebookBindingDraft.book || selectedLorebookName} onChange={(event) => setLorebookBindingDraft({ ...lorebookBindingDraft, book: event.target.value })}>
                  <option value="">{t('common.select')}</option>
                  {lorebooks.map((book) => <option value={book.name} key={book.filename}>{book.name}</option>)}
                </select>
              </label>
              <SelectChoicesField label={t('lorebooks.target')} value={lorebookBindingDraft.target_type} options={[["global", "Global"], ["card", t('lorebooks.targetCard')], ["chat", t('lorebooks.targetChat')], ["persona", t('lorebooks.targetPersona')]]} onChange={(value) => setLorebookBindingDraft({ ...lorebookBindingDraft, target_type: value as LorebookBinding['target_type'], target_id: '' })} />
              {lorebookBindingDraft.target_type === 'global' ? <div className="relative-position-help"><span>Global</span><small>{t('lorebooks.globalHelp')}</small></div> : (
                <label className="field-preview">
                  <span>{t('lorebooks.targetId')}</span>
                  <select value={lorebookBindingDraft.target_id} onChange={(event) => setLorebookBindingDraft({ ...lorebookBindingDraft, target_id: event.target.value })}>
                    <option value="">{t('common.select')}</option>
                    {bindingTargetOptions.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
                  </select>
                </label>
              )}
            </div>
            <div className="prompt-list">
              {lorebookBindings.length ? lorebookBindings.map((binding, index) => (
                <article className="prompt-row lore-binding-row enabled" key={`${binding.book}:${binding.target_type}:${binding.target_id}:${index}`}>
                  <span className="prompt-kind">◆</span>
                  <div className="prompt-main">
                    <strong>{binding.book}</strong>
                    <small>{binding.target_type}{binding.target_id ? ` · ${binding.target_id}` : ''}</small>
                  </div>
                  <button className="prompt-icon danger" type="button" title={t('lorebooks.removeBinding')} onClick={() => void removeLorebookBinding(index)}><Icon name="trash" /></button>
                </article>
              )) : <p className="empty-library">{t('lorebooks.noBindings')}</p>}
            </div>
          </section>
          <details className="raw-preset-details" open>
            <summary>{t('lorebooks.rawJson')}</summary>
            <EditableTextArea label="World Info JSON" value={lorebookJsonDraft} onChange={setLorebookJsonDraft} />
          </details>
          {lorebookMessage ? <p className="library-message">{lorebookMessage}</p> : null}
          <div className="preset-actions">
            <button type="button" onClick={() => void saveLorebook()}>{t('lorebooks.save')}</button>
            <button type="button" onClick={() => void exportLorebook()}>{t('lorebooks.export')}</button>
            <button type="button" onClick={() => void deleteLorebook()}>{t('common.delete')}</button>
          </div>
        </>}
      </div>
    );
  }

  if (section === 'cards') {
    return (
      <div className="form-stack library-workspace card-workspace">
        <section className="library-column library-list-panel">
          <div className="panel-heading compact-heading">
            <div>
              <span className="eyebrow">{t('cards.title')}</span>
              <strong>{cards.length ? `${cards.length} ${t('common.inLibrary')}` : t('common.emptyLibrary')}</strong>
            </div>
          </div>

          {accessDenied.cards ? <AccessDeniedNotice /> : <>
          <details className="create-card-panel">
            <summary>{t('cards.import')}</summary>
            <div className="form-stack">
              <label className="upload-card">
                <span>{t('cards.importST')}</span>
                <small>{t('cards.importHelp')}</small>
                <input type="file" accept="image/png,application/json,.json" onChange={(event) => { void importCard(event.target.files?.[0] ?? null); event.target.value = ''; }} />
              </label>
              <TwoColumns
                left={<EditableField label={t('personas.name')} value={cardDraft.name} onChange={(name) => setCardDraft({ ...cardDraft, name })} />}
                right={<EditableField label={t('common.tags')} value={cardDraft.tags} onChange={(tags) => setCardDraft({ ...cardDraft, tags })} />}
              />
              <EditableTextArea label={t('personas.description')} value={cardDraft.description} onChange={(description) => setCardDraft({ ...cardDraft, description })} />
              <TwoColumns
                left={<EditableTextArea label="Personality" value={cardDraft.personality} onChange={(personality) => setCardDraft({ ...cardDraft, personality })} />}
                right={<EditableTextArea label="Scenario" value={cardDraft.scenario} onChange={(scenario) => setCardDraft({ ...cardDraft, scenario })} />}
              />
              <EditableTextArea label="First message" value={cardDraft.firstMessage} onChange={(firstMessage) => setCardDraft({ ...cardDraft, firstMessage })} />
              <AlternateGreetingsEditor value={cardDraft.alternateGreetings} onChange={(alternateGreetings) => setCardDraft({ ...cardDraft, alternateGreetings })} />
              <TokenBadge count={cardDraftTokenCount(cardDraft)} label={t('cards.tokens')} />
              <TwoColumns
                left={<EditableTextArea label="Example dialogue" value={cardDraft.messageExample} onChange={(messageExample) => setCardDraft({ ...cardDraft, messageExample })} />}
                right={<EditableField label="Creator" value={cardDraft.creator} onChange={(creator) => setCardDraft({ ...cardDraft, creator })} />}
              />
              <TwoColumns
                left={<button className="compact-action-button" type="button" onClick={() => void createCard()}>{t('cards.create')}</button>}
                right={(
                  <label className="upload-card compact-upload">
                    <span>{t('cards.pngAvatar')}</span>
                    <small>{t('cards.avatarFallback')}</small>
                    <input type="file" accept="image/png" onChange={(event) => setCardAvatar(event.target.files?.[0] ?? null)} />
                  </label>
                )}
              />
            </div>
          </details>

          <div className="compact-card-list">
            {cards.length ? cards.map((card) => (
              <CharacterCardView active={activeCard?.id === card.id} editing={editingCardId === card.id} card={card} key={card.filename} onSelect={selectBotCard} onEdit={startEditCard} onDelete={deleteCard} openImagePreview={openImagePreview} imageSrc={imageSrc} deleteLocked={deletionLocks.cards.includes(card.id)} admin={Boolean(authUser?.is_admin)} pendingDeleteKey={pendingDeleteKey} setPendingDeleteKey={setPendingDeleteKey} toggleDeleteLock={() => void toggleDeletionLock('cards', card.id)} />
            )) : <EmptyLibrary text={t('cards.emptyLibrary')} />}
          </div>
          </>}
        </section>

        <section className="library-column library-detail-panel">
        {libraryMessage ? <p className="library-message">{libraryMessage}</p> : null}
        {accessDenied.cards ? <AccessDeniedNotice /> : activeCard ? (
          <article className="active-bot-panel">
            <button className="avatar-preview-button card-image-button" type="button" onClick={() => openImagePreview(activeCard.image_url, activeCard.name)}><img src={imageSrc(activeCard.image_url)} alt="" loading="lazy" /></button>
            <div>
              <span className="eyebrow">{t('cards.selected')}</span>
                <strong>{activeCard.name}</strong>
                <TokenBadge count={cardTokenCount(activeCard)} label={t('common.tokens')} />
              <p>{activeCard.description || activeCard.first_message || t('cards.noDescription')}</p>
              <button type="button" onClick={() => void createBotChat()}>{t('cards.newChatWithCard')}</button>
            </div>
          </article>
        ) : null}

        {editingCard ? (
          <section className="card-edit-panel">
            <div className="panel-heading compact-heading">
              <div className="editing-card-heading">
                <button className="avatar-preview-button card-image-button" type="button" onClick={() => openImagePreview(editingCard.image_url, editingCard.name)}><img src={imageSrc(editingCard.image_url)} alt="" loading="lazy" /></button>
                <div>
                <span className="eyebrow">{t('cards.editingMetadata')}</span>
                <strong>{editingCard.name}</strong>
                </div>
              </div>
              <button className="ghost-button" type="button" onClick={() => setEditingCardId('')}>{t('common.close')}</button>
            </div>
            <TwoColumns
              left={<EditableField label={t('personas.name')} value={cardEditDraft.name} onChange={(name) => setCardEditDraft({ ...cardEditDraft, name })} />}
              right={<EditableField label={t('common.tags')} value={cardEditDraft.tags} onChange={(tags) => setCardEditDraft({ ...cardEditDraft, tags })} />}
            />
            <EditableTextArea label={t('personas.description')} value={cardEditDraft.description} onChange={(description) => setCardEditDraft({ ...cardEditDraft, description })} />
            <TwoColumns
              left={<EditableTextArea label="Personality" value={cardEditDraft.personality} onChange={(personality) => setCardEditDraft({ ...cardEditDraft, personality })} />}
              right={<EditableTextArea label="Scenario" value={cardEditDraft.scenario} onChange={(scenario) => setCardEditDraft({ ...cardEditDraft, scenario })} />}
            />
            <EditableTextArea label="First message" value={cardEditDraft.firstMessage} onChange={(firstMessage) => setCardEditDraft({ ...cardEditDraft, firstMessage })} />
            <AlternateGreetingsEditor value={cardEditDraft.alternateGreetings} onChange={(alternateGreetings) => setCardEditDraft({ ...cardEditDraft, alternateGreetings })} />
            <TokenBadge count={cardDraftTokenCount(cardEditDraft)} label={t('cards.tokens')} />
            <TwoColumns
              left={<EditableTextArea label="Example dialogue" value={cardEditDraft.messageExample} onChange={(messageExample) => setCardEditDraft({ ...cardEditDraft, messageExample })} />}
              right={<EditableField label="Creator" value={cardEditDraft.creator} onChange={(creator) => setCardEditDraft({ ...cardEditDraft, creator })} />}
            />
            <label className="upload-card compact-upload">
              <span>{t('cards.replaceAvatar')}</span>
              <small>{t('cards.replaceAvatarHelp')}</small>
              <input type="file" accept="image/png" onChange={(event) => { void uploadCardAvatar(editingCard, event.target.files?.[0] ?? null); event.target.value = ''; }} />
            </label>
            <div className="preset-actions">
              <button type="button" onClick={() => void saveEditingCard()}>{t('cards.save')}</button>
              <button className="ghost-button" type="button" onClick={() => { setEditingCardId(''); setCardEditDraft(emptyCardDraft); }}>{t('common.cancel')}</button>
            </div>
          </section>
        ) : <EmptyLibrary text={t('cards.selectOrEdit')} />}

        <section className="chat-list">
          <h3>{t('cards.chatsOfSelected')}</h3>
          {accessDenied.chats ? <AccessDeniedNotice /> : botChats.length ? botChats.map((chat) => (
            <article className={activeChat?.id === chat.id ? 'chat-row active' : 'chat-row'} key={chat.id}>
              <button type="button" onClick={() => void selectChat(chat.id)}>
                <strong>{chat.title}</strong>
                <small>{chat.message_count} {t('chat.messages')} · {new Date(chat.updated_at).toLocaleString()}</small>
              </button>
              <div className="chat-row-actions">
                <input aria-label={t('chat.newName')} value={chatRenameDrafts[chat.id] ?? ''} placeholder={t('chat.newName')} onChange={(event) => setChatRenameDrafts({ ...chatRenameDrafts, [chat.id]: event.target.value })} />
                <button type="button" onClick={() => void copyChat(chat.id)}>{t('common.copy')}</button>
                <button type="button" onClick={() => void exportChat(chat.id)}>ST .jsonl</button>
                <button type="button" onClick={() => void renameChat(chat)}>{t('chat.rename')}</button>
                <DeleteConfirmButton itemKey={`chat:${chat.id}`} locked={Boolean(activeCard && deletionLocks.chats.includes(`${activeCard.id}:${chat.id}`))} admin={Boolean(authUser?.is_admin)} pendingDeleteKey={pendingDeleteKey} setPendingDeleteKey={setPendingDeleteKey} toggleLock={() => activeCard ? void toggleDeletionLock('chats', `${activeCard.id}:${chat.id}`) : undefined} onConfirm={() => void deleteChat(chat.id)} />
              </div>
            </article>
          )) : <EmptyLibrary text={t('cards.noCardForChats')} />}
        </section>
        </section>
      </div>
    );
  }

  if (section === 'personas') {
    return (
      <div className="form-stack library-workspace personas-workspace">
        <section className="library-column library-list-panel">
          <div className="panel-heading compact-heading">
            <div>
              <span className="eyebrow">{t('personas.title')}</span>
              <strong>{personas.length ? `${personas.length} ${t('personas.profiles')}` : t('personas.none')}</strong>
            </div>
          </div>

          {accessDenied.personas ? <AccessDeniedNotice /> : <>
          <details className="create-card-panel">
            <summary>{t('personas.create')}</summary>
            <div className="form-stack">
              <EditableField label={t('personas.name')} value={personaDraft.name} onChange={(name) => setPersonaDraft({ ...personaDraft, name })} />
              <EditableTextArea label="Persona prompt" value={personaDraft.description} onChange={(description) => setPersonaDraft({ ...personaDraft, description })} />
              <TokenBadge count={personaTokenCount(personaDraft)} label={t('personas.tokens')} />
              <button type="button" onClick={() => void createPersona()}>{t('common.create')}</button>
            </div>
          </details>

          <div className="persona-list">
            {personas.length ? personas.map((persona) => (
              <article className={selectedPersonaId === persona.id ? 'persona-card persona-card-compact active' : 'persona-card persona-card-compact'} key={persona.id}>
                <div className="persona-list-main">
                  <div className="persona-heading persona-heading-card">
                    {persona.avatar_url ? <button className="avatar-preview-button persona-image-button" type="button" onClick={() => openImagePreview(persona.avatar_url, persona.name)}><img src={imageSrc(persona.avatar_url)} alt="" loading="lazy" /></button> : <i className="persona-avatar-fallback">{persona.name.slice(0, 1) || '?'}</i>}
                    <div>
                      <strong>{persona.name}</strong>
                      <small>{selectedPersonaId === persona.id ? t('personas.selectedHere') : t('personas.notSelected')}</small>
                      <TokenBadge count={personaTokenCount(persona)} label={t('message.tokens')} />
                      <p>{persona.description || t('personas.emptyPrompt')}</p>
                    </div>
                  </div>
                </div>
                <div className="card-row-actions">
                  <button type="button" onClick={() => selectLocalPersona(persona.id)}>{selectedPersonaId === persona.id ? t('personas.selected') : t('common.select')}</button>
                  <button className="ghost-button" type="button" onClick={() => setEditingPersonaId(persona.id)}>{t('common.edit')}</button>
                  <DeleteConfirmButton itemKey={`persona:${persona.id}`} label={t('common.delete')} locked={deletionLocks.personas.includes(persona.id)} admin={Boolean(authUser?.is_admin)} pendingDeleteKey={pendingDeleteKey} setPendingDeleteKey={setPendingDeleteKey} toggleLock={() => void toggleDeletionLock('personas', persona.id)} onConfirm={() => void deletePersona(persona)} />
                </div>
              </article>
            )) : <EmptyLibrary text={t('personas.empty')} />}
          </div>
          </>}
        </section>

        <section className="library-column library-detail-panel">
          {libraryMessage ? <p className="library-message">{libraryMessage}</p> : null}
          {accessDenied.personas ? <AccessDeniedNotice /> : editingPersona ? (
            <article className={selectedPersonaId === editingPersona.id ? 'persona-card persona-card-compact active' : 'persona-card persona-card-compact'} key={editingPersona.id}>
              <div className="persona-heading">
                {editingPersona.avatar_url ? <button className="avatar-preview-button persona-image-button" type="button" onClick={() => openImagePreview(editingPersona.avatar_url, editingPersona.name)}><img src={imageSrc(editingPersona.avatar_url)} alt="" loading="lazy" /></button> : <span>{editingPersona.name.slice(0, 1) || '?'}</span>}
                <div>
                  <input aria-label={t('personas.name')} value={editingPersona.name} onChange={(event) => editPersona(editingPersona.id, { name: event.target.value })} />
                  <small>{selectedPersonaId === editingPersona.id ? t('personas.selectedLocal') : t('personas.notSelectedLocal')}</small>
                  <TokenBadge count={personaTokenCount(editingPersona)} label={t('message.tokens')} />
                </div>
              </div>
              <EditableTextArea label={t('personas.descriptionPrompt')} value={editingPersona.description} onChange={(description) => editPersona(editingPersona.id, { description })} />
              <div className="persona-actions">
                <button type="button" onClick={() => void updatePersona(editingPersona)}>{t('common.save')}</button>
                <button className="ghost-button" type="button" onClick={() => selectLocalPersona(editingPersona.id)}>{selectedPersonaId === editingPersona.id ? t('personas.selected') : t('common.select')}</button>
                <DeleteConfirmButton itemKey={`persona:${editingPersona.id}:edit`} label={t('common.delete')} locked={deletionLocks.personas.includes(editingPersona.id)} admin={Boolean(authUser?.is_admin)} pendingDeleteKey={pendingDeleteKey} setPendingDeleteKey={setPendingDeleteKey} toggleLock={() => void toggleDeletionLock('personas', editingPersona.id)} onConfirm={() => void deletePersona(editingPersona)} />
                <label className="avatar-upload">
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadPersonaAvatar(editingPersona.id, event.target.files?.[0] ?? null)} />
                </label>
              </div>
            </article>
          ) : <EmptyLibrary text={t('personas.selectOrCreate')} />}
        </section>
      </div>
    );
  }

  return (
    <div className="form-stack security-panel">
      <section className="preset-card-section">
        <div className="preset-title-row">
          <div>
            <span className="eyebrow">{t('security.account')}</span>
            <h3>{authUser ? `${authUser.is_admin ? '♛ ' : ''}${authUser.username}` : t('auth.guest')}</h3>
          </div>
          {authUser ? <button className="ghost-button" type="button" onClick={() => void logout()}>{t('auth.logout')}</button> : null}
        </div>
        {!authUser ? (
          <div className="form-stack">
            <TwoColumns
              left={<EditableField label={t('auth.username')} value={authDraft.username} onChange={(username) => setAuthDraft({ ...authDraft, username })} />}
              right={<EditableField label={t('auth.password')} type="password" value={authDraft.password} onChange={(password) => setAuthDraft({ ...authDraft, password })} />}
            />
            <div className="preset-actions">
              <button type="button" onClick={() => void login()}>{t('auth.login')}</button>
              {registrationAllowed ? <button className="ghost-button" type="button" onClick={() => void register()}>{t('auth.register')}</button> : null}
            </div>
            {!registrationAllowed ? <p className="helper-text">{t('auth.registerDisabled')}</p> : null}
          </div>
        ) : (
          <div className="form-stack">
            <p className="helper-text">{t('auth.tokenSaved')}</p>
            {!authUser.is_admin ? (
              <TwoColumns
                left={<EditableField label={t('auth.adminCode')} type="password" value={authDraft.adminCode} onChange={(adminCode) => setAuthDraft({ ...authDraft, adminCode })} />}
                right={<button type="button" onClick={() => void claimAdmin()}>{t('auth.claimAdmin')}</button>}
              />
            ) : <p className="library-message">{t('auth.adminActive')}</p>}
          </div>
        )}
        {authMessage ? <p className="library-message">{authMessage}</p> : null}
      </section>

      <section className="preset-card-section">
        <div className="preset-title-row">
          <div>
            <span className="eyebrow">{t('security.keys')}</span>
            <h3>{t('keyManager.title')}</h3>
          </div>
        </div>
        <KeyManager />
      </section>

      <section className="preset-card-section">
        <div className="preset-title-row">
          <div>
            <span className="eyebrow">{t('security.permissions')}</span>
            <h3>{t('security.whoCanEdit')}</h3>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            {securityDirty ? <span style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>● {t('security.unsavedChanges')}</span> : null}
            <button type="button" onClick={() => void saveSecurityPermissions()}>{t('security.savePermissions')}</button>
          </div>
        </div>
        <ToggleRow label={t('security.requireAuth')} checked={authRequired} onChange={setAuthRequired} />
        <ToggleRow label={t('security.allowRegistration')} checked={registrationAllowed} onChange={setRegistrationAllowed} />
        <ToggleRow label={t('security.allowBotReply')} checked={botReplyAllowed} onChange={setBotReplyAllowed} />
        <p className="helper-text">{t('security.requireAuthHelp')}</p>
        <ToggleRow label={t('security.requireAccessPassword')} checked={securityAccessPasswordRequiredDraft} onChange={setSecurityAccessPasswordRequiredDraft} />
        {accessPasswordRequired !== securityAccessPasswordRequiredDraft ? <p className="helper-text">{t('security.accessPasswordHint')}</p> : null}
        <TwoColumns
          left={<EditableField label={accessPasswordConfigured ? t('security.newAccessPassword') : t('security.accessPassword')} type="password" value={securityAccessPasswordDraft} onChange={setSecurityAccessPasswordDraft} />}
          right={<p className="helper-text">{t('security.accessPasswordHelp')}</p>}
        />
        <div className="permission-grid">
          {Object.entries(getPermissionLabels(t)).map(([key, label]) => {
            const rule = securityPermissions[key] || defaultSecurityPermissions[key];
            return (
              <article className="permission-row" key={key}>
                <strong>{label}</strong>
                <select value={rule.mode} onChange={(event) => setSecurityPermissions({ ...securityPermissions, [key]: { ...rule, mode: event.target.value as PermissionMode } })}>
                  <option value="everyone">{t('security.everyone')}</option>
                  <option value="admins">{t('security.adminsOnly')}</option>
                  <option value="users">{t('security.adminsAndList')}</option>
                </select>
                <input value={rule.users.join(', ')} placeholder={t('security.usernamesPlaceholder')} onChange={(event) => setSecurityPermissions({ ...securityPermissions, [key]: { ...rule, users: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } })} />
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ChatPicker({
  activeChat,
  botChats,
  createBotChat,
  importChat,
  copyChat,
  exportChat,
  deleteChat,
  renameChat,
  activeCardId,
  deleteLocks,
  admin,
  pendingDeleteKey,
  setPendingDeleteKey,
  toggleDeleteLock,
  chatRenameDrafts,
  setChatRenameDrafts,
  selectChat,
  close,
}: {
  activeChat: BotChat | null;
  botChats: BotChatSummary[];
  createBotChat: () => Promise<void>;
  importChat?: (file: File | null) => Promise<void>;
  copyChat: (chatId: string) => Promise<void>;
  exportChat: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  renameChat: (chat: BotChatSummary) => Promise<void>;
  activeCardId: string;
  deleteLocks: DeletionLocks;
  admin: boolean;
  pendingDeleteKey: string;
  setPendingDeleteKey: (key: string) => void;
  toggleDeleteLock: (itemId: string) => void;
  chatRenameDrafts: Record<string, string>;
  setChatRenameDrafts: (drafts: Record<string, string>) => void;
  selectChat: (chatId: string) => Promise<void>;
  close: () => void;
}) {
  const { t } = useLocaleContext();
  return (
    <div className="chat-picker">
      <header>
        <strong>{t('chat.cardChats')}</strong>
        <div className="chat-picker-header-actions">
          <button type="button" onClick={() => void createBotChat()}>{t('common.new')}</button>
          {importChat ? (
            <label className="ghost-button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', padding: '0.45rem 0.55rem', fontSize: '0.84rem' }}>
              <span>+ .jsonl</span>
              <input
                type="file"
                accept=".jsonl,.json,application/jsonl,application/json"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0] || null;
                  event.target.value = '';
                  void importChat(file);
                }}
              />
            </label>
          ) : null}
          <button className="ghost-button" type="button" onClick={close}>{t('common.close')}</button>
        </div>
      </header>
      {botChats.length ? botChats.map((chat) => (
        <article className={activeChat?.id === chat.id ? 'chat-row active' : 'chat-row'} key={chat.id}>
          <button type="button" onClick={() => void selectChat(chat.id)}>
            <strong>{chat.title}</strong>
            <small>{chat.message_count} {t('chat.messages')}</small>
          </button>
          <div className="chat-row-actions">
            <input aria-label={t('chat.newName')} value={chatRenameDrafts[chat.id] ?? ''} placeholder={t('chat.newName')} onChange={(event) => setChatRenameDrafts({ ...chatRenameDrafts, [chat.id]: event.target.value })} />
            <button type="button" onClick={() => void copyChat(chat.id)}>{t('common.copy')}</button>
            <button type="button" onClick={() => void exportChat(chat.id)}>ST .jsonl</button>
            <button type="button" onClick={() => void renameChat(chat)}>{t('chat.rename')}</button>
            <DeleteConfirmButton itemKey={`composer-chat:${chat.id}`} locked={deleteLocks.chats.includes(`${activeCardId}:${chat.id}`)} admin={admin} pendingDeleteKey={pendingDeleteKey} setPendingDeleteKey={setPendingDeleteKey} toggleLock={() => toggleDeleteLock(`${activeCardId}:${chat.id}`)} onConfirm={() => void deleteChat(chat.id)} />
          </div>
        </article>
      )) : <p className="empty-library">{t('chat.noChats')}</p>}
    </div>
  );
}

function ComposerActionMenu({
  activeChat,
  isGenerating,
  composerMode,
  setComposerMode,
  rollDice,
  openMemory,
  openChats,
  rerollLastBotMessage,
}: {
  activeChat: BotChat | null;
  isGenerating: boolean;
  composerMode: 'normal' | 'ooc' | 'secret';
  setComposerMode: (mode: 'normal' | 'ooc' | 'secret') => void;
  rollDice: () => void;
  openMemory: () => void;
  openChats: () => void;
  rerollLastBotMessage: () => Promise<void>;
}) {
  const { t } = useLocaleContext();
  return (
    <div className="composer-action-menu">
      <button type="button" onClick={openChats}>🗂️ {t('composer.chats')}</button>
      <button type="button" disabled={!activeChat || isGenerating} onClick={() => void rerollLastBotMessage()}>↻ {t('message.reroll')}</button>
      <button type="button" disabled={!activeChat || isGenerating} onClick={rollDice}>🎲 Бросить кубик (1d20)</button>
      <button type="button" className={composerMode === 'ooc' ? 'active' : ''} onClick={() => setComposerMode(composerMode === 'ooc' ? 'normal' : 'ooc')}>💬 Режим OOC (вне игры)</button>
      <button type="button" className={composerMode === 'secret' ? 'active' : ''} onClick={() => setComposerMode(composerMode === 'secret' ? 'normal' : 'secret')}>🕵️ Тайный ход (скрыто)</button>
      <button type="button" onClick={openMemory}>📜 Память чата (Саммари)</button>
    </div>
  );
}

function ReasoningPresetPanel({ settings, assistantPrefill, update, updateAssistantPrefill }: { settings: ReasoningDisplaySettings; assistantPrefill: string; update: (patch: Partial<ReasoningDisplaySettings>) => void; updateAssistantPrefill: (value: string) => void }) {
  const { t } = useLocaleContext();
  const applyTemplate = (name: string) => {
    const templates: Record<string, Pick<ReasoningDisplaySettings, 'prefix' | 'suffix' | 'separator'>> = {
      DeepSeek: { prefix: '<think>\n', suffix: '\n</think>', separator: '\n\n' },
      'Think XML': { prefix: '<think>', suffix: '</think>', separator: '\n' },
      Blank: { prefix: '', suffix: '', separator: '\n' },
    };
    update(templates[name] || templates.DeepSeek);
  };

  return (
    <details className="preset-card-section reasoning-settings-panel collapsible-preset-section">
      <summary>{t('reasoning.title')}</summary>
      <div className="collapsible-section-body">
        <div className="reasoning-toggle-grid">
          <label><input type="checkbox" checked={settings.autoParse} onChange={(event) => update({ autoParse: event.target.checked })} />{t('reasoning.autoParse')}</label>
          <label><input type="checkbox" checked={settings.autoExpand} onChange={(event) => update({ autoExpand: event.target.checked })} />{t('reasoning.autoExpand')}</label>
          <label><input type="checkbox" checked={settings.showHidden} onChange={(event) => update({ showHidden: event.target.checked })} />{t('reasoning.showHidden')}</label>
          <label><input type="checkbox" checked={settings.addToPrompts} onChange={(event) => update({ addToPrompts: event.target.checked })} />{t('reasoning.addToPrompts')}</label>
          <NumberInputField label={t('common.max')} value={settings.maxAdditions} fallback={1} min={0} max={99} step={1} onChange={(value) => typeof value === 'number' && update({ maxAdditions: value })} />
        </div>
        <div className="reasoning-format-row">
          <label className="field-preview">
            <span>{t('reasoning.formatting')}</span>
            <select value={reasoningTemplateName(settings)} onChange={(event) => applyTemplate(event.target.value)}>
              <option value="Custom">Custom</option>
              <option value="DeepSeek">DeepSeek</option>
              <option value="Think XML">Think XML</option>
              <option value="Blank">Blank</option>
            </select>
          </label>
        </div>
        <div className="reasoning-text-grid">
          <EditableTextArea label={t('reasoning.prefix')} value={settings.prefix} onChange={(prefix) => update({ prefix })} />
          <EditableTextArea label={t('reasoning.suffix')} value={settings.suffix} onChange={(suffix) => update({ suffix })} />
          <EditableTextArea label={t('reasoning.separator')} value={settings.separator} onChange={(separator) => update({ separator })} />
        </div>
        <EditableTextArea label={t('reasoning.assistantPrefill')} value={assistantPrefill} onChange={updateAssistantPrefill} />
      </div>
    </details>
  );
}

const MessageContent = memo(function MessageContent({ content, role = 'assistant', reasoning, imagePending = false, renderPendingMarkersAsSpinner = false, isStreaming = false }: { content: string; role?: string; reasoning: ReasoningDisplaySettings; imagePending?: boolean; renderPendingMarkersAsSpinner?: boolean; isStreaming?: boolean }) {
  const { t } = useLocaleContext();
  const displayPlacement = role === 'user' ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
  const regexedContent = getRegexedString(content, displayPlacement, { isMarkdown: true });
  const parsed = reasoning.autoParse ? splitReasoning(regexedContent, reasoning) : { reasoning: '', visible: regexedContent, complete: false };
  const reasoningText = parsed.reasoning ? getRegexedString(parsed.reasoning, regex_placement.REASONING, { isMarkdown: true }) : '';
  const formatOptions: ExtensionMessageFormatOptions = { forceImagePending: imagePending, renderPendingMarkersAsSpinner, reasoning, t };
  const reasoningOpen = isStreaming ? Boolean(reasoningText && !parsed.complete) : reasoning.autoExpand;
  return (
    <div className="message-content mes_text">
      {reasoningText && !reasoning.showHidden ? (
        <details className="reasoning-block" open={reasoningOpen}>
          <summary>{t('reasoning.thinking')}</summary>
          <pre>{reasoningText}</pre>
        </details>
      ) : null}
      {reasoningText && reasoning.showHidden ? <pre className="reasoning-visible">{reasoningText}</pre> : null}
      {formatMessageText(parsed.visible, formatOptions, true)}
    </div>
  );
});

function formatChatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function reasoningSettingsFromPreset(preset: RawPreset | null): ReasoningDisplaySettings {
  return {
    autoParse: preset?.reasoning_auto_parse !== false,
    autoExpand: Boolean(preset?.reasoning_auto_expand),
    showHidden: Boolean(preset?.reasoning_show_hidden),
    addToPrompts: preset?.reasoning_add_to_prompts !== false,
    maxAdditions: numberField(preset?.reasoning_max_additions, 1),
    prefix: String(preset?.reasoning_prefix ?? ''),
    suffix: String(preset?.reasoning_suffix ?? ''),
    separator: String(preset?.reasoning_separator ?? '\n'),
  };
}

function reasoningTemplateName(settings: ReasoningDisplaySettings): string {
  if (settings.prefix === '<think>\n' && settings.suffix === '\n</think>' && settings.separator === '\n\n') {
    return 'DeepSeek';
  }
  if (settings.prefix === '<think>' && settings.suffix === '</think>' && settings.separator === '\n') {
    return 'Think XML';
  }
  if (!settings.prefix && !settings.suffix) {
    return 'Blank';
  }
  return 'Custom';
}

function splitReasoning(content: string, settings: ReasoningDisplaySettings): { reasoning: string; visible: string; complete: boolean } {
  if (!settings.prefix || !settings.suffix) {
    return { reasoning: '', visible: content, complete: false };
  }
  const prefix = findReasoningMarker(content, [settings.prefix, settings.prefix.trim()], 0);
  const start = prefix.index;
  if (start < 0) {
    return { reasoning: '', visible: content, complete: false };
  }
  const bodyStart = start + prefix.marker.length;
  const suffix = findReasoningMarker(content, [settings.suffix, settings.suffix.trim()], bodyStart);
  const end = suffix.index;
  if (end < 0) {
    return { reasoning: content.slice(bodyStart), visible: content.slice(0, start).trim(), complete: false };
  }
  const reasoning = content.slice(bodyStart, end);
  const visible = `${content.slice(0, start)}${content.slice(end + suffix.marker.length)}`.trim();
  return { reasoning, visible, complete: true };
}

function findReasoningMarker(content: string, markers: string[], fromIndex: number): { index: number; marker: string } {
  return Array.from(new Set(markers.filter(Boolean))).reduce((best, marker) => {
    const index = content.indexOf(marker, fromIndex);
    if (index < 0 || (best.index >= 0 && best.index <= index)) {
      return best;
    }
    return { index, marker };
  }, { index: -1, marker: '' });
}

function formatMessageText(content: string, options: ExtensionMessageFormatOptions = {}, alreadyRegexed = false): ReactNode {
  const regexedContent = alreadyRegexed ? content : getRegexedString(content, regex_placement.MD_DISPLAY, { isMarkdown: true });
  if (loadBuiltInExtensionSettings().noriMynInfoblock && /◈NORICORE◈/i.test(regexedContent)) {
    return formatNoricoreMessageText(regexedContent, options);
  }
  return formatMessageSegmentText(regexedContent, options);
}

function formatMessageSegmentText(content: string, options: ExtensionMessageFormatOptions = {}): ReactNode {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const range of collectMessageSpecialRanges(content)) {
    if (range.start > lastIndex) {
      nodes.push(<p key={`text-${lastIndex}`}>{formatInlineMessageText(content.slice(lastIndex, range.start))}</p>);
    }
    const token = content.slice(range.start, range.end);
    if (token.startsWith('```') || token.startsWith('~~~')) {
      nodes.push(<pre key={`code-${range.start}`}><code>{token.slice(3, -3).replace(/^\w+\n/, '')}</code></pre>);
    } else if (token.startsWith('<')) {
      nodes.push(<span className="extension-media-html" dangerouslySetInnerHTML={{ __html: formatExtensionMessageHtml(token, options) }} key={`media-${range.start}`} />);
    }
    lastIndex = range.end;
  }
  if (lastIndex < content.length || nodes.length === 0) {
    nodes.push(<p key={`text-${lastIndex}`}>{formatInlineMessageText(content.slice(lastIndex))}</p>);
  }
  return <>{nodes}</>;
}

function collectMessageSpecialRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const codePattern = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = codePattern.exec(content)) !== null) {
    ranges.push({ start: codeMatch.index, end: codeMatch.index + codeMatch[0].length });
  }

  const markerPattern = /data-iig-instruction\b|iig-loading-placeholder\b|iig-error-image\b|iig-pending-media-shell\b/gi;
  let markerMatch: RegExpExecArray | null;
  while ((markerMatch = markerPattern.exec(content)) !== null) {
    const range = findExtensionHtmlRange(content, markerMatch.index);
    if (range) {
      ranges.push(range);
    }
  }

  return ranges
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce<Array<{ start: number; end: number }>>((merged, range) => {
      const last = merged[merged.length - 1];
      if (!last || range.start >= last.end) {
        merged.push(range);
      } else if (range.end > last.end) {
        last.end = range.end;
      }
      return merged;
    }, []);
}

function findExtensionHtmlRange(content: string, markerIndex: number): { start: number; end: number } | null {
  const containers = ['div', 'span', 'video']
    .map((tag) => {
      const index = content.lastIndexOf(`<${tag}`, markerIndex);
      const end = index >= 0 ? findMatchingHtmlTagEnd(content, tag, index) : -1;
      return { tag, index, end };
    })
    .filter((item) => item.index >= 0 && item.end > markerIndex && markerIndex - item.index < 3000)
    .sort((left, right) => left.index - right.index);
  if (containers[0]) {
    return { start: containers[0].index, end: containers[0].end };
  }

  const imageStart = content.lastIndexOf('<img', markerIndex);
  if (imageStart < 0) {
    return null;
  }
  const tagEnd = content.indexOf('>', imageStart);
  if (tagEnd < 0) {
    return null;
  }
  return { start: imageStart, end: tagEnd + 1 };
}

function findMatchingHtmlTagEnd(content: string, tagName: string, startIndex: number) {
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = startIndex;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(content)) !== null) {
    const isClosing = /^<\//.test(match[0]);
    depth += isClosing ? -1 : 1;
    if (depth === 0) {
      return match.index + match[0].length;
    }
  }
  return -1;
}

function formatNoricoreMessageText(content: string, options: ExtensionMessageFormatOptions = {}): ReactNode {
  const nodes: ReactNode[] = [];
  const pattern = /◈NORICORE◈([\s\S]*?)◈\/NORICORE◈/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={`noricore-text-${lastIndex}`}>{formatMessageSegmentText(content.slice(lastIndex, match.index).trim(), options)}</Fragment>);
    }
    const data = parseNoricoreBlock(match[1]);
    nodes.push(data.scene && data.characters.length ? <NoricoreBlock data={data} key={`noricore-${match.index}`} /> : <p className="message-tag" key={`noricore-raw-${match.index}`}>{match[0]}</p>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    nodes.push(<Fragment key={`noricore-text-${lastIndex}`}>{formatMessageSegmentText(content.slice(lastIndex).trim(), options)}</Fragment>);
  }
  return <>{nodes.filter(Boolean)}</>;
}

function parseNoricoreBlock(raw: string): NoricoreData {
  const data: NoricoreData = { scene: null, characters: [] };
  const sceneMatch = raw.match(/⟪СЦЕНА⟫([^⟫]+)⟫/i);
  if (sceneMatch) {
    const parts = sceneMatch[1].split('|').map((item) => item.trim());
    data.scene = { location: parts[0] || '—', weather: parts[1] || '—', date: parts[2] || '—', time: parts[3] || '—' };
  }
  const characterPattern = /⟪ПЕРСОНАЖ⟫([^⟫]+)⟫/gi;
  let match: RegExpExecArray | null;
  while ((match = characterPattern.exec(raw)) !== null) {
    const parts = match[1].split('|').map((item) => item.trim());
    if (!parts[0]) continue;
    data.characters.push({
      name: parts[0],
      status: parts[1] || 'Present',
      outfit: parts[2] || '—',
      health: parts[3] || 'Healthy',
      mood: parts[4] || '—',
      feelings: parts[5] || '—',
      thoughts: stripOuterQuotes(parts[6] || ''),
    });
  }
  return data;
}

function stripOuterQuotes(value: string) {
  const trimmed = value.trim();
  return trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) ? trimmed.slice(1, -1) : trimmed;
}

function NoricoreBlock({ data }: { data: NoricoreData }) {
  const { t } = useLocaleContext();
  const scene = data.scene;
  if (!scene) return null;
  return (
    <section className="noricore-block">
      <header className="noricore-header">
        <strong><span className="noricore-pin">📍</span><span className="noricore-location">{scene.location}</span></strong>
        <div className="noricore-meta">
          <span>🌤️ {scene.weather}</span>
          <span>📅 {scene.date}</span>
          <span>🕘 {scene.time}</span>
        </div>
      </header>
      <details className="noricore-section">
        <summary><span>👥 {t('noricore.characters')} ({data.characters.length})</span></summary>
        <div className="noricore-character-list">
          {data.characters.map((character, index) => <NoricoreCharacterCard character={character} key={`${character.name}-${index}`} />)}
        </div>
      </details>
    </section>
  );
}

function NoricoreCharacterCard({ character }: { character: NoricoreCharacter }) {
  const { t } = useLocaleContext();
  const status = character.status.toLowerCase();
  const away = status.includes('отсутств') || status.includes('away');
  const nearby = status.includes('рядом') || status.includes('nearby');
  return (
    <article className={`noricore-character${away ? ' away' : nearby ? ' nearby' : ''}`}>
      <header>
        <strong><span>{noricoreStatusIcon(character.status)}</span><span className="noricore-character-name">{character.name}</span></strong>
        <small>{character.status}</small>
      </header>
      <div className="noricore-grid">
        <NoricoreField label={t('noricore.outfit')} icon="👗" value={character.outfit} />
        <NoricoreField label={t('noricore.health')} icon={noricoreHealthIcon(character.health)} value={character.health} tone={noricoreHealthTone(character.health)} />
        <NoricoreField label={t('noricore.mood')} icon="🎭" value={character.mood} />
        <NoricoreField label={t('noricore.feelings')} icon="💜" value={character.feelings} wide italic />
      </div>
      {character.thoughts && character.thoughts !== '—' ? (
        <blockquote className="noricore-thought"><span>💭 {t('noricore.thoughts')}</span>{character.thoughts}</blockquote>
      ) : null}
    </article>
  );
}

function NoricoreField({ label, icon, value, tone, wide, italic }: { label: string; icon: string; value: string; tone?: string; wide?: boolean; italic?: boolean }) {
  return (
    <div className={wide ? 'noricore-field wide' : 'noricore-field'}>
      <span>{icon} {label}</span>
      <p className={italic ? 'italic' : ''} style={tone ? { color: tone } : undefined}>{value}</p>
    </div>
  );
}

function noricoreStatusIcon(status: string) {
  const value = status.toLowerCase();
  if (value.includes('отсутств') || value.includes('away')) return '⚫';
  if (value.includes('рядом') || value.includes('nearby')) return '🟡';
  return '🟢';
}

function noricoreHealthIcon(health: string) {
  const value = health.toLowerCase();
  if (value.includes('крит') || value.includes('critical')) return '🔴';
  if (value.includes('серь') || value.includes('serious')) return '🟠';
  if (value.includes('умерен') || value.includes('moderate')) return '🟡';
  return '💚';
}

function noricoreHealthTone(health: string) {
  const value = health.toLowerCase();
  if (value.includes('крит') || value.includes('critical')) return '#ff8c8c';
  if (value.includes('серь') || value.includes('serious')) return '#f0b36e';
  if (value.includes('умерен') || value.includes('moderate')) return '#e3d26b';
  return '#8fe0a5';
}

function formatInlineMessageText(content: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(``[^`\n]+``|`[^`\n]+`|"[^"\n]+"|“[^”\n]+”|«[^»\n]+»|「[^」\n]+」|『[^』\n]+』|＂[^＂\n]+＂|\*\*[^*\n][^\n]*?\*\*|\*(?!\*)[^*\n]+?\*(?!\*)|<\/?[a-zA-Z_][^>\n]{0,80}>|◈[^\n]+◈|⟪[^\n]+⟫)/g;
  const quotePattern = /^("[^"\n]+"|“[^”\n]+”|«[^»\n]+»|「[^」\n]+」|『[^』\n]+』|＂[^＂\n]+＂)$/;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`t-${lastIndex}`}>{content.slice(lastIndex, match.index)}</span>);
    }
    const token = match[0];
    if (token.startsWith('``')) {
      nodes.push(<code key={`m-${match.index}`}>{token.slice(2, -2)}</code>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={`m-${match.index}`}>{token.slice(1, -1)}</code>);
    } else if (quotePattern.test(token)) {
      nodes.push(<q key={`m-${match.index}`}>{token}</q>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`m-${match.index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      const inner = token.slice(1, -1);
      nodes.push(<em key={`m-${match.index}`}>{quotePattern.test(inner) ? <q>{inner}</q> : inner}</em>);
    } else {
      nodes.push(<span className="message-tag" key={`m-${match.index}`}>{token}</span>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < content.length) {
    nodes.push(<span key={`t-${lastIndex}`}>{content.slice(lastIndex)}</span>);
  }
  return nodes;
}

function extractModelNames(rawModels: unknown): string[] {
  if (!rawModels || typeof rawModels !== 'object') {
    return [];
  }
  const maybeData = rawModels as { data?: unknown; models?: unknown };
  const list = Array.isArray(maybeData.data) ? maybeData.data : Array.isArray(maybeData.models) ? maybeData.models : Array.isArray(rawModels) ? rawModels : [];
  return list
    .map((item) => {
      const value = typeof item === 'string'
        ? item
        : typeof item === 'object' && item && 'id' in item
          ? String((item as { id: unknown }).id)
          : typeof item === 'object' && item && 'name' in item
            ? String((item as { name: unknown }).name)
            : '';
      return value.replace(/^models\//, '');
    })
    .filter(Boolean);
}

function isObjectRecord(value: unknown): value is RawPreset {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePresetDraft(value: string): RawPreset | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function numberField(value: unknown, fallback: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function numberInputText(value: unknown, fallback: number): string {
  if (value === '' || value === '-' || value === '.' || value === '-.') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value;
  }
  return String(fallback);
}

function parseNumberInput(value: string): number | string {
  if (value === '' || value === '-' || value === '.' || value === '-.') {
    return value;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : value;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function approxTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function csvFromArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return csvToArray(value);
  }
  return [];
}

function csvToArray(value: string): string[] {
  return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function lorebookEntriesFromBook(book: RawPreset): RawPreset[] {
  const raw = book.entries;
  const list = Array.isArray(raw) ? raw : isObjectRecord(raw) ? Object.values(raw) : [];
  return list
    .filter(isObjectRecord)
    .sort((left, right) => numberField(left.displayIndex, numberField(left.uid, 0)) - numberField(right.displayIndex, numberField(right.uid, 0)));
}

function nextLorebookUid(entries: RawPreset): number {
  const used = Object.values(entries).filter(isObjectRecord).map((entry) => numberField(entry.uid, -1));
  return Math.max(-1, ...used) + 1;
}

function lorebookPositionLabel(value: unknown): string {
  const labels: Record<string, string> = {
    '0': '↑Char',
    '1': '↓Char',
    '2': '↑AN',
    '3': '↓AN',
    '4': '@Depth',
    '5': '↑EM',
    '6': '↓EM',
    '7': 'Outlet',
  };
  return labels[String(value ?? 0)] || '↑Char';
}

function normalizePromptOrder(rawOrder: unknown): PromptOrderItem[] {
  if (!Array.isArray(rawOrder)) {
    return [];
  }
  const preferredOrder = rawOrder.find((entry) => isObjectRecord(entry) && String(entry.character_id) === String(OPENAI_PROMPT_ORDER_CHARACTER_ID) && Array.isArray(entry.order));
  const firstOrder = preferredOrder || rawOrder.find((entry) => isObjectRecord(entry) && Array.isArray(entry.order));
  const order = isObjectRecord(firstOrder) && Array.isArray(firstOrder.order) ? firstOrder.order : [];
  return order
    .filter(isObjectRecord)
    .map((entry) => ({ identifier: String(entry.identifier || ''), enabled: entry.enabled !== false }))
    .filter((entry) => entry.identifier);
}

function updateOpenAiPromptOrder(rawOrder: unknown, nextOrder: PromptOrderItem[]): RawPreset[] {
  const promptOrder = Array.isArray(rawOrder) ? [...rawOrder] : [];
  const preferredIndex = promptOrder.findIndex((entry) => isObjectRecord(entry) && String(entry.character_id) === String(OPENAI_PROMPT_ORDER_CHARACTER_ID) && Array.isArray(entry.order));
  const firstIndex = promptOrder.findIndex((entry) => isObjectRecord(entry) && Array.isArray(entry.order));
  const targetIndex = preferredIndex >= 0 ? preferredIndex : firstIndex;
  const normalizedOrder = nextOrder.map((item) => ({ identifier: item.identifier, enabled: item.enabled }));

  if (targetIndex >= 0 && isObjectRecord(promptOrder[targetIndex])) {
    promptOrder[targetIndex] = { ...promptOrder[targetIndex], order: normalizedOrder };
  } else {
    promptOrder.push({ character_id: OPENAI_PROMPT_ORDER_CHARACTER_ID, order: normalizedOrder });
  }

  return promptOrder.filter(isObjectRecord);
}

function buildFullPromptOrder(preset: RawPreset): PromptOrderItem[] {
  const order = normalizePromptOrder(preset.prompt_order);
  const prompts = Array.isArray(preset.prompts) ? preset.prompts.filter(isObjectRecord) as OpenAiPrompt[] : [];
  const knownIds = new Set(order.map((item) => item.identifier));
  const missing = prompts
    .map((prompt) => String(prompt.identifier || ''))
    .filter((identifier) => identifier && !knownIds.has(identifier))
    .map((identifier) => ({ identifier, enabled: true }));
  return [...order, ...missing];
}

function removePromptFromAllOrders(rawOrder: unknown, identifier: string): RawPreset[] {
  if (!Array.isArray(rawOrder)) {
    return [];
  }
  return rawOrder
    .filter(isObjectRecord)
    .map((entry) => Array.isArray(entry.order)
      ? { ...entry, order: entry.order.filter((item) => !isObjectRecord(item) || String(item.identifier || '') !== identifier) }
      : entry);
}

function orderedOpenAiPrompts(preset: RawPreset): Array<{ prompt: OpenAiPrompt; enabled: boolean }> {
  const prompts = Array.isArray(preset.prompts) ? preset.prompts.filter(isObjectRecord) as OpenAiPrompt[] : [];
  const order = normalizePromptOrder(preset.prompt_order);
  const ordered = order
    .map((orderItem) => {
      const prompt = prompts.find((item) => String(item.identifier || '') === orderItem.identifier);
      return prompt ? { prompt, enabled: orderItem.enabled } : null;
    })
    .filter((item): item is { prompt: OpenAiPrompt; enabled: boolean } => Boolean(item));
  const orderedIds = new Set(ordered.map((item) => String(item.prompt.identifier || '')));
  const rest = prompts
    .filter((prompt) => !orderedIds.has(String(prompt.identifier || '')))
    .map((prompt) => ({ prompt, enabled: true }));
  return [...ordered, ...rest];
}

function promptTriggerValues(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function SliderField({
  label,
  value,
  fallback,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: unknown;
  fallback: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number | string) => void;
}) {
  const rangeValue = clampNumber(numberField(value, fallback), min, max);
  return (
    <label className="slider-field">
      <span>{label}</span>
      <div>
        <input type="range" min={min} max={max} step={step} value={rangeValue} onChange={(event) => onChange(Number(event.target.value))} />
        <input type="number" min={min} max={max} step={step} value={numberInputText(value, fallback)} onChange={(event) => onChange(parseNumberInput(event.target.value))} />
      </div>
    </label>
  );
}

function NumberInputField({ label, value, fallback, min, max, step, onChange }: { label: string; value: unknown; fallback: number; min?: number; max?: number; step?: number; onChange: (value: number | string) => void }) {
  return (
    <label className="field-preview">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={numberInputText(value, fallback)} onChange={(event) => onChange(parseNumberInput(event.target.value))} />
    </label>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="field-preview">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option value={option} key={option}>{option}</option>)}
      </select>
    </label>
  );
}

function SelectChoicesField({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return (
    <label className="field-preview">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => <option value={optionValue} key={optionValue}>{optionLabel}</option>)}
      </select>
    </label>
  );
}

function CheckboxGroupField({ label, values, options, onChange }: { label: string; values: string[]; options: string[]; onChange: (values: string[]) => void }) {
  const selected = new Set(values);
  return (
    <div className="checkbox-group-field">
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={selected.has(option)}
              onChange={(event) => {
                const next = new Set(selected);
                event.target.checked ? next.add(option) : next.delete(option);
                onChange(Array.from(next));
              }}
            />
            <small>{option}</small>
          </label>
        ))}
      </div>
    </div>
  );
}

function PromptOptionRow({ title, text, checked, onChange }: { title: string; text: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="prompt-option-row">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
    </label>
  );
}

function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented-row">
      <span>{label}</span>
      <div className="segmented-control">
        {options.map(([optionValue, optionLabel]) => (
          <button
            className={value === optionValue ? 'segment active' : 'segment'}
            key={optionValue}
            type="button"
            onClick={() => onChange(optionValue)}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button className={checked ? 'toggle-row active' : 'toggle-row'} type="button" onClick={() => onChange(!checked)}>
      <span>{label}</span>
      <i aria-hidden="true" />
    </button>
  );
}

function PanelHeading({ label }: { label: string }) {
  return (
    <header className="panel-heading">
      <strong>{label}</strong>
    </header>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    sliders: (
      <>
        <path d="M4 7h7" />
        <path d="M15 7h5" />
        <path d="M4 17h5" />
        <path d="M13 17h7" />
        <circle cx="13" cy="7" r="2" />
        <circle cx="11" cy="17" r="2" />
      </>
    ),
    plug: (
      <>
        <path d="M9 3v5" />
        <path d="M15 3v5" />
        <path d="M7 8h10v4a5 5 0 0 1-10 0V8Z" />
        <path d="M12 17v4" />
      </>
    ),
    palette: (
      <>
        <path d="M12 3a9 9 0 0 0 0 18h1.2a2.2 2.2 0 0 0 1.4-3.9l-.5-.4a1.4 1.4 0 0 1 .9-2.5h1.2A4.8 4.8 0 0 0 21 9.4C21 5.9 17 3 12 3Z" />
        <circle cx="8" cy="10" r="1" />
        <circle cx="11" cy="7" r="1" />
        <circle cx="15" cy="8" r="1" />
      </>
    ),
    bot: (
      <>
        <path d="M12 4v3" />
        <rect x="5" y="7" width="14" height="11" rx="3" />
        <path d="M9 12h.01" />
        <path d="M15 12h.01" />
        <path d="M9 16h6" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
    card: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M8 8h8" />
        <path d="M8 12h8" />
        <path d="M8 16h5" />
      </>
    ),
    book: (
      <>
        <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z" />
        <path d="M8 4v16" />
        <path d="M11 8h5" />
        <path d="M11 12h4" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        <path d="M12 14v2" />
      </>
    ),
    key: (
      <>
        <circle cx="7.5" cy="14.5" r="3.5" />
        <path d="M10 12 20 2" />
        <path d="M16 6h4v4" />
        <path d="M14 8h3" />
      </>
    ),
    menu: (
      <>
        <path d="M5 7h14" />
        <path d="M5 12h14" />
        <path d="M5 17h14" />
      </>
    ),
    send: (
      <>
        <path d="M4 12 20 4l-4 16-3-7-9-1Z" />
        <path d="m13 13 7-9" />
      </>
    ),
    edit: (
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5Z" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M6 7l1 14h10l1-14" />
        <path d="M9 7V4h6v3" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    eyeOff: (
      <>
        <path d="M3 3l18 18" />
        <path d="M10.6 10.6A3 3 0 0 0 13.4 13.4" />
        <path d="M9.9 5.3A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a16.1 16.1 0 0 1-3.1 4.2" />
        <path d="M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.1-.9" />
      </>
    ),
    check: (
      <>
        <path d="M20 6 9 17l-5-5" />
      </>
    ),
    x: (
      <>
        <path d="M18 6 6 18" />
        <path d="M6 6l12 12" />
      </>
    ),
  };

  return (
    <svg className={`icon icon-${name}`} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <label className="field-preview">
      <span>{label}</span>
      <input value={value} readOnly />
    </label>
  );
}

function EditableField({ label, value, type = 'text', onChange }: { label: string; value: string; type?: string; onChange: (value: string) => void }) {
  return (
    <label className="field-preview">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TextArea({ label, value }: { label: string; value: string }) {
  return (
    <label className="field-preview">
      <span>{label}</span>
      <textarea value={value} readOnly />
    </label>
  );
}

function EditableTextArea({ label, value, disabled = false, onChange }: { label: string; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <label className="field-preview">
      <span>{label}</span>
      <textarea value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TwoColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return <div className="two-columns">{left}{right}</div>;
}

function TokenBadge({ count, label = 'tokens' }: { count: number; label?: string }) {
  return <small className="token-badge">{count} {label}</small>;
}

function cardDraftTokenCount(card: CardDraft) {
  return tokenCountForParts([card.name, card.description, card.personality, card.scenario, card.firstMessage, ...card.alternateGreetings, card.messageExample]);
}

function cardTokenCount(card: CharacterCard) {
  return tokenCountForParts([card.name, card.description, card.personality, card.scenario, card.first_message, ...(card.alternate_greetings || []), card.message_example]);
}

function personaTokenCount(persona: Pick<Persona, 'name' | 'description'> | { name: string; description: string }) {
  return tokenCountForParts([persona.name, persona.description]);
}

function entryTokenCount(entry: RawPreset) {
  return tokenCountForParts([String(entry.comment || ''), String(entry.content || ''), csvFromArray(entry.key).join('\n'), csvFromArray(entry.keysecondary).join('\n')]);
}

function lorebookTokenCount(entries: RawPreset[]) {
  return entries.reduce((sum, entry) => sum + entryTokenCount(entry), 0);
}

function tokenCountForParts(parts: string[]) {
  return approxTokens(parts.filter((part) => part.trim()).join('\n'));
}

function AlternateGreetingsEditor({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const { t } = useLocaleContext();
  const updateGreeting = (index: number, nextValue: string) => onChange(value.map((item, itemIndex) => itemIndex === index ? nextValue : item));
  const removeGreeting = (index: number) => onChange(value.filter((_, itemIndex) => itemIndex !== index));
  return (
    <section className="alternate-greetings-editor">
      <div className="alternate-greetings-header">
        <div>
          <strong>{t('cards.alternateGreetings')}</strong>
          <TokenBadge count={tokenCountForParts(value)} label={t('common.tokens')} />
        </div>
        <button className="ghost-button" type="button" onClick={() => onChange([...value, ''])}>{t('cards.addGreeting')}</button>
      </div>
      {value.length ? value.map((greeting, index) => (
        <label className="field-preview" key={index}>
          <span>{t('cards.greeting')} #{index + 2}</span>
          <textarea value={greeting} onChange={(event) => updateGreeting(index, event.target.value)} />
          <button className="ghost-button danger-button" type="button" onClick={() => removeGreeting(index)}>{t('cards.deleteGreeting')}</button>
        </label>
      )) : <p className="helper-text">{t('cards.alternateGreetingsHelp')}</p>}
    </section>
  );
}

function DeleteConfirmButton({
  itemKey,
  label = 'Delete',
  locked,
  admin,
  pendingDeleteKey,
  setPendingDeleteKey,
  toggleLock,
  onConfirm,
}: {
  itemKey: string;
  label?: string;
  locked: boolean;
  admin: boolean;
  pendingDeleteKey: string;
  setPendingDeleteKey: (key: string) => void;
  toggleLock?: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLocaleContext();
  const pending = pendingDeleteKey === itemKey;
  return (
    <span className="delete-confirm-group">
      {pending ? (
        <>
          <span className="delete-confirm-label">{t('common.confirm')}</span>
          <button className="danger-button" type="button" onClick={() => { setPendingDeleteKey(''); onConfirm(); }}>{t('common.yes')}</button>
          <button className="ghost-button" type="button" onClick={() => setPendingDeleteKey('')}>{t('common.no')}</button>
        </>
      ) : (
        <span className="delete-confirm-main">
          {admin && toggleLock ? <button className={locked ? 'ghost-button lock-button locked' : 'ghost-button lock-button'} type="button" title={locked ? t('common.unlockDeletion') : t('common.lockDeletion')} onClick={toggleLock}>{locked ? '🔒' : '🔓'}</button> : null}
          <button className="ghost-button danger-button" type="button" disabled={locked} title={locked ? t('common.deletionLocked') : label} onClick={() => setPendingDeleteKey(itemKey)}>{label}</button>
        </span>
      )}
    </span>
  );
}

function Option({ title, text, active = false }: { title: string; text: string; active?: boolean }) {
  return (
    <article className={active ? 'option-card active' : 'option-card'}>
      <strong>{title}</strong>
      <span>{text}</span>
    </article>
  );
}

function CharacterCardView({ active = false, editing = false, card, onSelect, onEdit, onDelete, openImagePreview, imageSrc = (src) => src, deleteLocked = false, admin = false, pendingDeleteKey = '', setPendingDeleteKey = () => undefined, toggleDeleteLock }: { active?: boolean; editing?: boolean; card: CharacterCard; onSelect?: (card: CharacterCard) => Promise<void>; onEdit?: (card: CharacterCard) => void; onDelete?: (card: CharacterCard) => Promise<void>; openImagePreview?: (src: string, title: string) => void; imageSrc?: (src: string) => string; deleteLocked?: boolean; admin?: boolean; pendingDeleteKey?: string; setPendingDeleteKey?: (key: string) => void; toggleDeleteLock?: () => void }) {
  const { t } = useLocaleContext();
  const tags = card.tags.slice(0, 4);
  return (
    <article className={`${active ? 'character-card-view active' : 'character-card-view'}${editing ? ' editing' : ''}`}>
      <button className="avatar-preview-button card-image-button" type="button" onClick={() => openImagePreview?.(card.image_url, card.name)}><img src={imageSrc(card.image_url)} alt="" loading="lazy" /></button>
      <div className="character-card-copy">
        <div className="card-title-row">
          <strong>{card.name}</strong>
          {tags.length ? <div className="card-tag-list card-title-tags">{tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
        </div>
        <TokenBadge count={cardTokenCount(card)} label={t('common.tokens')} />
        <p>{card.description || card.first_message || t('cards.noDescription')}</p>
        <div className="card-row-actions">
          {onSelect ? <button type="button" onClick={() => void onSelect(card)}>{active ? t('cards.opened') : t('cards.open')}</button> : null}
          {onEdit ? <button className="ghost-button" type="button" onClick={() => onEdit(card)}>{editing ? t('cards.editing') : t('cards.edit')}</button> : null}
          {onDelete ? <DeleteConfirmButton itemKey={`card:${card.id}`} label={t('common.deleteShort')} locked={deleteLocked} admin={admin} pendingDeleteKey={pendingDeleteKey} setPendingDeleteKey={setPendingDeleteKey} toggleLock={toggleDeleteLock} onConfirm={() => void onDelete(card)} /> : null}
        </div>
      </div>
    </article>
  );
}

function EmptyLibrary({ text }: { text: string }) {
  return <p className="empty-library">{text}</p>;
}

function AccessDeniedNotice() {
  const { t } = useLocaleContext();
  return <p className="empty-library access-denied">{t('accessDenied.description')}</p>;
}
