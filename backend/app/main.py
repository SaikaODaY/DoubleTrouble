from __future__ import annotations

import base64
import hashlib
import json
import asyncio
import logging
import os
import re
import time

import httpx
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse
from uuid import uuid4
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from backend.app.config import DEFAULT_CONFIG_PATH, PROJECT_ROOT, ensure_admin_code, load_config
from backend.app.models import ClientEvent, JoinSessionRequest, SendMessageRequest
from pydantic import BaseModel, Field

from backend.app.services.bot_chats_service import (
    BotChatsService,
    ChatBranchRequest,
    ChatCreate,
    ChatDiceRollRequest,
    ChatMemoryUpdate,
    ChatMessageCreate,
    ChatMessageUpdate,
    ChatSwipeRequest,
    ChatSwipeVoteRequest,
    ChatUpdate,
    PartyHudState,
)
from backend.app.services.character_cards_service import CharacterCardCreate, CharacterCardsService, CharacterCardUpdate
from backend.app.realtime.connection_manager import ConnectionManager
from backend.app.secrets import SecretStore
from backend.app.services.generation_service import GenerationService
from backend.app.services.regex_service import RegexService
from backend.app.services.lorebooks_service import LorebookBindingPayload, LorebookPayload, LorebooksService
from backend.app.services.extensions_service import ExtensionInstallRequest, ExtensionsService
from backend.app.llm.chat_completion_sources import build_provider, get_source, list_sources_payload, resolve_source_id
from backend.app.llm.openai_compatible import OpenAICompatibleProvider
from backend.app.services.personas_service import PersonaCreate, PersonasService, PersonaUpdate
from backend.app.services.auth_service import AuthService, AuthUser
from backend.app.services.presets_service import PresetPayload, PresetsService
from backend.app.services.settings_service import (
    GenerationPresetSave,
    GenerationSettingsUpdate,
    SecuritySettingsPayload,
    SettingsService,
    SummaryMemorySettingsUpdate,
)
from backend.app.services.session_service import DEFAULT_SESSION_ID, SessionService
from backend.app.storage.file_storage import FileStorage


config = load_config()
generated_admin_code = ensure_admin_code(config, DEFAULT_CONFIG_PATH)
if generated_admin_code:
    logging.getLogger(__name__).warning("Generated new admin code: %s", generated_admin_code)
    admin_code_file = DEFAULT_CONFIG_PATH.parent / ".admin_code.txt"
    admin_code_file.parent.mkdir(parents=True, exist_ok=True)
    admin_code_file.write_text(f"Admin code: {generated_admin_code}\n", encoding="utf-8")
    logging.getLogger(__name__).warning("Admin code written to: %s", admin_code_file)
storage = FileStorage(config.storage.data_root, config.storage.default_user)
session_service = SessionService(storage)
secret_store = SecretStore(storage.user_root / "secrets.yaml")
settings_service = SettingsService(storage.user_root / "settings.yaml", secret_store)
auth_service = AuthService(storage.user_root / "users.yaml")
generation_service = GenerationService(settings_service.generation_config(), secret_store, session_service)
character_cards_service = CharacterCardsService(storage.user_root / "characters")
bot_chats_service = BotChatsService(storage.user_root / "chats")
personas_service = PersonasService(storage.user_root / "personas.yaml", storage.user_root / "User Avatars")
presets_service = PresetsService(storage.user_root)
lorebooks_service = LorebooksService(storage.user_root / "worlds", storage.user_root / "lorebook_bindings.yaml")
extensions_service = ExtensionsService(storage.user_root / "extensions", storage.user_root / "extensions" / "extensions.yaml", PROJECT_ROOT / "builtin-extensions")
connection_manager = ConnectionManager()
generation_tasks: dict[str, asyncio.Task[str]] = {}
active_preset_overrides: dict[str, dict[str, object]] = {}
PROVIDER_KEY_REGISTRY_SECRET = "provider_api_key_registry"
PROVIDER_KEY_ACTIVE_SECRET = "provider_api_key_active"
managed_secret_keys = {
    "provider_api_key": {"label": "Provider API key", "env_name": settings_service.generation_config().api_key_env},
}


class GenerationParticipantRequest(BaseModel):
    persona_id: str = ""
    persona_name: str = ""
    persona_description: str = ""
    participant_id: str = ""
    username: str = ""


class BotReplyRequest(BaseModel):
    replace_message_id: str | None = None
    reset_swipes: bool = False
    openai_preset: dict[str, object] | None = None
    persona_id: str | None = None
    persona_name: str | None = None
    persona_description: str | None = None
    participants: list[GenerationParticipantRequest] = Field(default_factory=list)
    regex_scripts: list[dict[str, object]] = Field(default_factory=list)
    extension_prompts: list[dict[str, object]] = Field(default_factory=list)

class AuthRequest(BaseModel):
    username: str
    password: str


class AdminClaimRequest(BaseModel):
    code: str


class AccessPasswordRequest(BaseModel):
    password: str


class KeyUpdateRequest(BaseModel):
    name: str = ""
    value: str = ""


class ImageModelsRequest(BaseModel):
    api_type: str = "openai"
    endpoint: str = ""
    api_key: str = ""
    timeout_seconds: float = 30.0


class DeleteLockUpdate(BaseModel):
    category: str
    item_id: str
    locked: bool


class ExtensionImageUpload(BaseModel):
    image: str
    format: str = "png"
    ch_name: str = "generated"
    filename: str = "image"


class ExtensionFileUpload(BaseModel):
    name: str
    data: str


class MagicTranslationRequest(BaseModel):
    text: str
    prompt: str
    target_language: str
    filter_code_block: bool = True
    max_tokens: int = 4096
    temperature: float = 0.3
    chat_context: list[dict[str, str]] = Field(default_factory=list)
    message_name: str = ""
    # Optional connection profile override
    provider: str = ""
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    timeout_seconds: float = 60.0
    source_settings: dict[str, Any] = Field(default_factory=dict)


def _session_id_from_request(request: Request | None = None) -> str:
    if request is None:
        return DEFAULT_SESSION_ID
    header_sid = unquote(request.headers.get("x-doubletrouble-session", "").strip())
    if header_sid:
        return header_sid
    query_sid = str(request.query_params.get("session_id") or "").strip()
    return query_sid or DEFAULT_SESSION_ID

def _target_sessions_for_chat(card_id: str, chat_id: str, primary_session_id: str = DEFAULT_SESSION_ID, switch_active: bool = False) -> set[str]:
    targets = {primary_session_id or DEFAULT_SESSION_ID}
    if not switch_active:
        for sid, sess in session_service.sessions.items():
            if sess.active_card_id == card_id and (not sess.active_chat_id or sess.active_chat_id == chat_id):
                targets.add(sid)
    return targets


async def _broadcast_chat(card_id: str, chat_id: str, switch_active: bool = False, session_id: str = DEFAULT_SESSION_ID, chat: Any = None) -> None:
    session_service.set_active_chat(session_id, card_id, chat_id)
    resolved_chat = chat if chat is not None else bot_chats_service.get_chat(card_id, chat_id)
    payload = {"type": "chat.updated", "card_id": card_id, "chat": resolved_chat.model_dump(mode="json"), "switch_active": switch_active}
    for target_sid in _target_sessions_for_chat(card_id, chat_id, session_id, switch_active):
        await connection_manager.broadcast(target_sid, payload)

def _card_avatar_url(card_id: str) -> str:
    try:
        return character_cards_service.get_card(card_id).image_url
    except FileNotFoundError:
        return ""

def _ensure_card_first_message(card_id: str, chat_id: str) -> object:
    chat = bot_chats_service.get_chat(card_id, chat_id)
    character_data = character_cards_service.card_data(card_id)
    first_message = str(character_data.get("first_mes") or character_data.get("first_message") or "").strip()
    if not first_message:
        return chat
    raw_alternates = character_data.get("alternate_greetings", [])
    if isinstance(raw_alternates, list):
        alternate_greetings = [str(item).strip() for item in raw_alternates if str(item).strip()]
    elif isinstance(raw_alternates, str) and raw_alternates.strip():
        alternate_greetings = [raw_alternates.strip()]
    else:
        alternate_greetings = []
    greeting_swipes = [first_message, *alternate_greetings]
    if chat.messages:
        return bot_chats_service.sync_first_assistant_swipes(card_id, chat_id, greeting_swipes)
    return bot_chats_service.add_bot_message(card_id, chat_id, chat.character_name, first_message, _card_avatar_url(card_id), greeting_swipes)

async def _broadcast_generation_state(card_id: str, chat_id: str, event_type: str, message: str = "", replace_message_id: str | None = None, streaming: bool | None = None, session_id: str = DEFAULT_SESSION_ID) -> None:
    event: dict[str, object] = {"type": event_type, "card_id": card_id, "chat_id": chat_id, "replace_message_id": replace_message_id}
    if message:
        event["message"] = message
    if streaming is not None:
        event["streaming"] = streaming
    for target_sid in _target_sessions_for_chat(card_id, chat_id, session_id, False):
        await connection_manager.broadcast(target_sid, event)

def _frontend_build_info() -> tuple[str, str]:
    index_path = PROJECT_ROOT / "frontend" / "dist" / "index.html"
    if not index_path.exists():
        return "dev", ""
    try:
        raw = index_path.read_text(encoding="utf-8")
        build_id = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
        match = re.search(r'src="[^"]*/(index-[^"/]+\.js)"', raw)
        return build_id, (match.group(1) if match else "")
    except OSError:
        return "dev", ""


def _apply_cache_bust_headers(request: Request, response: Response) -> str:
    build_id, _ = _frontend_build_info()
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    response.headers["CDN-Cache-Control"] = "no-store"
    response.headers["Cloudflare-CDN-Cache-Control"] = "no-store"
    if build_id and request.cookies.get("dt_build_id") != build_id:
        response.headers["Clear-Site-Data"] = '"cache"'
        response.set_cookie("dt_build_id", build_id, path="/", max_age=31536000, samesite="lax")
    return build_id


async def _broadcast_presence(session_id: str = DEFAULT_SESSION_ID) -> None:
    session_service.prune_disconnected(session_id, connection_manager.active_participant_ids(session_id))
    await connection_manager.broadcast(
        session_id,
        {"type": "presence.updated", "session": session_service.snapshot(session_id)},
    )
def _actor_from_request(request: Request) -> str:
    actor = unquote(request.headers.get("x-doubletrouble-actor", "").strip())
    user = _auth_user_from_request(request)
    if user:
        return user.username
    return actor

def _token_from_request(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return request.cookies.get("doubletrouble_auth_token", "").strip() or str(request.query_params.get("auth") or "").strip()


def _auth_user_from_request(request: Request) -> AuthUser | None:
    return auth_service.user_by_token(_token_from_request(request))


def _access_token_from_request(request: Request) -> str:
    return (
        request.headers.get("x-doubletrouble-access", "").strip()
        or str(request.cookies.get("doubletrouble_access") or "").strip()
        or str(request.query_params.get("access_token") or "").strip()
    )


AUTH_RATE_LIMIT_MAX = 15
AUTH_RATE_LIMIT_WINDOW = 60.0
_auth_rate_limit_store: dict[str, list[float]] = {}


def _request_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if forwarded:
        return forwarded
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip
    return request.client.host if request.client else "unknown"


def _check_auth_rate_limit(client_ip: str) -> None:
    now = time.time()
    _auth_rate_limit_store.setdefault(client_ip, [t for t in _auth_rate_limit_store.get(client_ip, []) if now - t < AUTH_RATE_LIMIT_WINDOW])
    if len(_auth_rate_limit_store[client_ip]) >= AUTH_RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Too many auth attempts")
    _auth_rate_limit_store[client_ip].append(now)


def _check_csrf(request: Request) -> None:
    if not config.security.cookie_auth or request.method in ("GET", "HEAD", "OPTIONS"):
        return
    if (
        request.headers.get("authorization")
        or request.headers.get("x-doubletrouble-access")
        or request.headers.get("x-doubletrouble-actor")
    ):
        return
    origin = request.headers.get("origin", "").strip()
    if not origin:
        return
    origin_host = urlparse(origin).netloc.lower()
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip().lower()
    request_host = (forwarded_host or request.headers.get("host", "")).strip().lower()
    expected = str(request.base_url).rstrip("/")
    if origin != expected and (not origin_host or origin_host != request_host):
        raise HTTPException(status_code=403, detail="Invalid origin")

def _require_access_password(request: Request) -> None:
    _check_csrf(request)
    if settings_service.access_password_required() and not settings_service.verify_access_token(_access_token_from_request(request)):
        raise HTTPException(status_code=403, detail="Access password required")


def _require_permission(request: Request, action: str) -> None:
    _require_access_password(request)
    user = _auth_user_from_request(request)
    if settings_service.auth_required() and not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not settings_service.auth_required() and not user:
        return
    permissions = settings_service.security_permissions().model_dump()
    rule = permissions.get(action, {"mode": "everyone", "users": []})
    mode = str(rule.get("mode") or "everyone")
    allowed_users = {str(username).lower() for username in rule.get("users", []) if str(username).strip()}
    if mode == "everyone":
        return
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    if mode == "admins" and (user.is_admin or not any(u.is_admin for u in auth_service.state.users)):
        return
    if mode == "users" and (user.is_admin or user.username.lower() in allowed_users):
        return
    raise HTTPException(status_code=403, detail="Not enough permissions")

def _notification_text(message: str, actor: str = "") -> str:
    return f"{actor}: {message}" if actor else message


async def _broadcast_notification(message: str, session_id: str = DEFAULT_SESSION_ID, actor: str = "") -> None:
    await connection_manager.broadcast(session_id, {"type": "notification", "message": _notification_text(message, actor)})


async def _broadcast_delete_locks() -> None:
    await connection_manager.broadcast(
        DEFAULT_SESSION_ID,
        {"type": "delete_locks.updated", "delete_locks": settings_service.delete_locks().model_dump(mode="json")},
    )


async def _broadcast_shared_settings(section: str) -> None:
    await connection_manager.broadcast(DEFAULT_SESSION_ID, {"type": "settings.updated", "section": section})


def _chat_lock_key(card_id: str, chat_id: str) -> str:
    return f"{card_id}:{chat_id}"


def _require_delete_unlocked(category: str, item_id: str) -> None:
    if settings_service.is_delete_locked(category, item_id):
        raise HTTPException(status_code=423, detail="Deletion is locked")


def _require_card_chats_unlocked(card_id: str) -> None:
    prefix = f"{card_id}:"
    if any(item.startswith(prefix) for item in settings_service.delete_locks().chats):
        raise HTTPException(status_code=423, detail="A chat in this card is locked")


def _apply_generation_preset(preset_type: str, preset: dict[str, object]) -> object | None:
    current = settings_service.generation_settings()
    update = GenerationSettingsUpdate(
        provider=str(current.get("provider") or "disabled"),
        base_url=str(current.get("base_url") or ""),
        model=str(current.get("model") or ""),
        system_prompt=str(current.get("system_prompt") or ""),
        temperature=float(current.get("temperature") or 0.8),
        max_tokens=int(current.get("max_tokens") or 350),
        timeout_seconds=float(current.get("timeout_seconds") or 60),
    )

    if preset_type == "sysprompt":
        update.system_prompt = str(preset.get("content") or update.system_prompt)
    if preset_type == "openai":
        update.temperature = float(preset.get("temperature") or update.temperature)
        update.max_tokens = int(preset.get("openai_max_tokens") or preset.get("max_tokens") or update.max_tokens)
        update.model = str(preset.get("custom_model") or preset.get("openai_model") or preset.get("openrouter_model") or update.model)
    if preset_type in {"textgenerationwebui", "kobold"}:
        update.temperature = float(preset.get("temp") or preset.get("temperature") or update.temperature)
        update.max_tokens = int(preset.get("max_length") or preset.get("max_tokens") or update.max_tokens)

    if preset_type in {"openai", "textgenerationwebui", "kobold", "sysprompt"}:
        return settings_service.update_generation_settings(update)
    return None


def _active_openai_preset() -> dict[str, object] | None:
    override = active_preset_overrides.get("openai")
    if override is not None:
        return override
    name = settings_service.active_preset_settings().get("openai")
    if not name:
        return None
    try:
        return presets_service.get_preset("openai", name)
    except (KeyError, FileNotFoundError, json.JSONDecodeError):
        return None


def _generation_persona_context(request: BotReplyRequest | None, history: list[Any] | None = None) -> tuple[str | None, str | None, bool, list[str]]:
    known_list = personas_service.list_all_personas()
    known_personas = {persona.id: persona for persona in known_list}
    known_by_name = {persona.name.strip().lower(): persona for persona in known_list if persona.name.strip()}
    participants: list[GenerationParticipantRequest] = list((request.participants if request else None) or [])
    if request and (request.persona_id or request.persona_name or request.persona_description):
        participants.append(
            GenerationParticipantRequest(
                persona_id=request.persona_id or "",
                persona_name=request.persona_name or "",
                persona_description=request.persona_description or "",
            )
        )
    history_user_authors: list[str] = []
    for msg in history or []:
        if getattr(msg, "role", "") == "user" and not getattr(msg, "hidden", False) and not getattr(msg, "is_ooc", False):
            author = str(getattr(msg, "author", "") or "").strip()
            if author and author not in history_user_authors:
                history_user_authors.append(author)

    by_key: dict[str, tuple[str, str]] = {}
    persona_ids: list[str] = []
    primary_name = ((request.persona_name if request else "") or "").strip() or None
    primary_id = ((request.persona_id if request else "") or "").strip()
    if primary_id and primary_id not in persona_ids:
        persona_ids.append(primary_id)
    for participant in participants:
        stored = known_personas.get(participant.persona_id) or known_by_name.get(participant.persona_name.strip().lower())
        name = (participant.persona_name or (stored.name if stored else "")).strip()
        description = (participant.persona_description or (stored.description if stored else "")).strip()
        if not name:
            continue
        pid = participant.persona_id.strip() or (stored.id if stored else "")
        if pid and pid not in persona_ids:
            persona_ids.append(pid)
        key = pid or participant.participant_id.strip() or name.lower()
        by_key[key] = (name, description)
        if primary_id and participant.persona_id == primary_id:
            primary_name = name
    active_participant_count = len(by_key)
    for author in history_user_authors:
        if author.lower() == "player" and by_key:
            continue
        if any(existing_name.lower() == author.lower() for existing_name, _ in by_key.values()):
            continue
        if active_participant_count <= 1 and len(by_key) >= 1:
            continue
        stored = known_by_name.get(author.lower())
        pid = stored.id if stored else ""
        if pid and pid not in persona_ids:
            persona_ids.append(pid)
        by_key[pid or author.lower()] = (author, (stored.description if stored else "").strip())

    personas = list(by_key.values())
    if not personas:
        return primary_name, ((request.persona_description if request else "") or "").strip() or None, False, persona_ids
    if len(personas) == 1:
        return primary_name or personas[0][0], personas[0][1], False, persona_ids
    names_str = ", ".join(name for name, _ in personas)
    combined = (
        f"Active player personas in this multiplayer roleplay ({names_str}):\n"
        + "\n".join(f"- {name}: {description or 'No persona description provided.'}" for name, description in personas)
        + "\nEach user message in the chat history is prefixed with the speaker's name (e.g. 'Name: message'). Respond only as {{char}} and do not write dialogue or actions on behalf of any player persona."
    )
    return names_str, combined, True, persona_ids

def _managed_key_payload(key_id: str, meta: dict[str, str]) -> dict[str, object]:
    env_name = meta.get("env_name") or ""
    return {
        "id": key_id,
        "name": meta.get("name") or meta.get("label") or key_id,
        "label": meta.get("label") or meta.get("name") or key_id,
        "configured": secret_store.exists(key_id),
        "masked": _masked_secret(secret_store.read(key_id)),
        "active": key_id == _active_provider_key_id(),
        "env_name": env_name,
        "env_configured": bool(env_name and secret_store.exists("", env_name)),
    }


def _masked_secret(value: str) -> str:
    return f"********{value[-4:]}" if value else ""


def _provider_key_registry() -> list[dict[str, str]]:
    raw = secret_store.read(PROVIDER_KEY_REGISTRY_SECRET)
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = []
        if isinstance(parsed, list):
            return [
                {"id": str(item.get("id") or ""), "name": str(item.get("name") or "")}
                for item in parsed
                if isinstance(item, dict) and str(item.get("id") or "").strip()
            ]
    if secret_store.exists("provider_api_key"):
        return [{"id": "provider_api_key", "name": "Provider API key"}]
    return []


def _save_provider_key_registry(entries: list[dict[str, str]]) -> None:
    secret_store.write(PROVIDER_KEY_REGISTRY_SECRET, json.dumps(entries, ensure_ascii=False))


def _active_provider_key_id() -> str:
    active_id = secret_store.read(PROVIDER_KEY_ACTIVE_SECRET).strip()
    entries = _provider_key_registry()
    if active_id and any(entry["id"] == active_id for entry in entries):
        return active_id
    return entries[0]["id"] if entries else ""


def _set_active_provider_key(key_id: str) -> None:
    value = secret_store.read(key_id)
    if not value:
        raise ValueError("Key value is empty")
    secret_store.write(PROVIDER_KEY_ACTIVE_SECRET, key_id)
    if key_id != "provider_api_key":
        secret_store.write("provider_api_key", value)


def _provider_key_payloads() -> list[dict[str, object]]:
    env_name = settings_service.generation_config().api_key_env
    return [
        _managed_key_payload(entry["id"], {"name": entry["name"], "label": entry["name"], "env_name": env_name})
        for entry in _provider_key_registry()
    ]

MAX_UPLOAD_SIZE = 50 * 1024 * 1024
RATE_LIMIT_MAX = 240
RATE_LIMIT_WINDOW = 60.0
_rate_limit_store: dict[str, list[float]] = {}


class UploadSizeLimitMiddleware:
    def __init__(self, app, **kwargs) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] in ("POST", "PUT", "PATCH"):
            for name, value in scope.get("headers", []):
                if name.lower() == b"content-length":
                    if int(value.decode()) > MAX_UPLOAD_SIZE:
                        await send({"type": "http.response.start", "status": 413, "headers": [[b"content-type", b"text/plain"]]})
                        await send({"type": "http.response.body", "body": b"Request too large", "more_body": False})
                        return
        await self.app(scope, receive, send)


class ExternalConnectionsMiddleware:
    def __init__(self, app, **kwargs) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            client = scope.get("client")
            client_ip = client[0] if client else "unknown"
            if not config.security.allow_external_connections and client_ip not in ("127.0.0.1", "::1", "localhost"):
                await send({"type": "http.response.start", "status": 403, "headers": [[b"content-type", b"text/plain"]]})
                await send({"type": "http.response.body", "body": b"External connections are disabled", "more_body": False})
                return
        await self.app(scope, receive, send)


class RateLimitMiddleware:
    def __init__(self, app, **kwargs) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] in ("POST", "PUT", "DELETE", "PATCH"):
            headers = {k.lower(): v.decode("latin1", errors="ignore") for k, v in scope.get("headers", [])}
            forwarded = headers.get(b"x-forwarded-for", "").split(",")[0].strip()
            client = scope.get("client")
            client_ip = forwarded or headers.get(b"x-real-ip", "").strip() or (client[0] if client else "unknown")
            now = time.time()
            _rate_limit_store.setdefault(client_ip, [t for t in _rate_limit_store.get(client_ip, []) if now - t < RATE_LIMIT_WINDOW])
            if len(_rate_limit_store[client_ip]) >= RATE_LIMIT_MAX:
                await send({"type": "http.response.start", "status": 429, "headers": [[b"content-type", b"text/plain"]]})
                await send({"type": "http.response.body", "body": b"Rate limit exceeded", "more_body": False})
                return
            _rate_limit_store[client_ip].append(now)
        await self.app(scope, receive, send)


app = FastAPI(title="DoubleTrouble", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(ExternalConnectionsMiddleware)
app.add_middleware(UploadSizeLimitMiddleware)
app.add_middleware(RateLimitMiddleware)

def _safe_media_part(value: str, fallback: str = "generated") -> str:
    safe = re.sub(r"[^\w\-. ]+", "_", value, flags=re.UNICODE).strip(" .")
    return safe or fallback


def _decode_base64_payload(value: str) -> bytes:
    payload = value.split(",", 1)[1] if value.startswith("data:") and "," in value else value
    try:
        return base64.b64decode(payload, validate=True)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid base64 payload") from error


@app.on_event("startup")
async def on_startup() -> None:
    storage.ensure_layout()
    session_service.get_or_create_session(DEFAULT_SESSION_ID)
    logging.getLogger("uvicorn.error").info("DoubleTrouble admin code: %s", config.auth.admin_code)

    env_access_pw = (os.environ.get("DOUBLE_TROUBLE_ACCESS_PASSWORD") or os.environ.get("ACCESS_PASSWORD") or "").strip()
    env_auth_req = (os.environ.get("DOUBLE_TROUBLE_AUTH_REQUIRED") or os.environ.get("AUTH_REQUIRED") or "").strip().lower()
    if env_access_pw or env_auth_req in {"1", "true", "yes", "on", "0", "false", "no", "off"}:
        sec_payload = settings_service.security_settings_payload()
        if env_access_pw and len(env_access_pw) >= 4:
            sec_payload.access_password = env_access_pw
            sec_payload.access_password_required = True
        if env_auth_req in {"1", "true", "yes", "on"}:
            sec_payload.auth_required = True
        elif env_auth_req in {"0", "false", "no", "off"}:
            sec_payload.auth_required = False
        settings_service.update_security_settings(sec_payload)

    # Bootstrap built-in default presets on first run (only if user has none yet)
    if not any(presets_service.list_presets("openai")):
        presets_service.import_directory(PROJECT_ROOT)

    # Activate the built-in Default OpenAI preset if no active preset is set
    if not settings_service.active_preset_settings().get("openai"):
        settings_service.set_active_preset("openai", "Default")
@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/version")
async def sillytavern_version() -> dict[str, str]:
    return {"agent": "DoubleTrouble", "pkgVersion": "1.12.13"}


@app.post("/api/settings/get")
async def sillytavern_settings_get(request: Request) -> dict[str, object]:
    _require_permission(request, "view_presets")
    ext_settings = extensions_service.get_settings()
    gen_settings = settings_service.generation_settings()
    return {
        "world_names": [book.name for book in lorebooks_service.list_books()],
        "settings": {**gen_settings, "extension_settings": ext_settings},
        "extension_settings": ext_settings,
    }


@app.post("/api/settings/save")
async def sillytavern_settings_save(payload: dict[str, Any], request: Request) -> dict[str, object]:
    ext_patch = payload.get("extension_settings") if isinstance(payload.get("extension_settings"), dict) else payload
    if isinstance(ext_patch, dict):
        extensions_service.save_settings(ext_patch, merge=True)
        await _broadcast_shared_settings("extension_settings")
    return {"ok": True}


@app.get("/api/extensions/settings")
async def get_extension_settings() -> dict[str, object]:
    return {"extension_settings": extensions_service.get_settings()}


@app.put("/api/extensions/settings")
async def put_extension_settings(payload: dict[str, Any], request: Request) -> dict[str, object]:
    patch = payload.get("extension_settings") if isinstance(payload.get("extension_settings"), dict) else payload
    merge = bool(payload.get("merge", True)) if isinstance(payload, dict) else True
    saved = extensions_service.save_settings(patch if isinstance(patch, dict) else {}, merge=merge)
    await _broadcast_shared_settings("extension_settings")
    return {"ok": True, "extension_settings": saved}


@app.get("/api/extensions/discover")
async def discover_extensions() -> list[dict[str, str]]:
    return extensions_service.discover_enabled()


@app.get("/api/extensions")
async def list_extensions(request: Request) -> dict[str, object]:
    _require_permission(request, "manage_extensions")
    return {"extensions": [extension.model_dump(mode="json") for extension in extensions_service.list_extensions()]}


@app.post("/api/extensions/install")
async def install_extension(payload: ExtensionInstallRequest, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_extensions")
    try:
        extension = await asyncio.to_thread(extensions_service.install, payload)
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail=f"Extension already exists: {error}") from error
    except (ValueError, FileNotFoundError, RuntimeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_shared_settings("extensions")
    await _broadcast_notification(f"установил расширение: {extension.name}", actor=_actor_from_request(request))
    return {"extension": extension.model_dump(mode="json")}


@app.post("/api/extensions/upload")
async def upload_extension_zip(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(""),
    overwrite: bool = Form(True),
) -> dict[str, object]:
    _require_permission(request, "manage_extensions")
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Only .zip extension archives are supported")
    content = await file.read()
    try:
        extension = await asyncio.to_thread(extensions_service.install_zip, file.filename, content, name, True, overwrite)
    except FileExistsError as error:
        raise HTTPException(status_code=409, detail=f"Extension already exists: {error}") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_shared_settings("extensions")
    await _broadcast_notification(f"загрузил расширение из ZIP: {extension.name}", actor=_actor_from_request(request))
    return {"extension": extension.model_dump(mode="json")}


@app.post("/api/extensions/{name}/update")
async def update_extension(name: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_extensions")
    try:
        extension = await asyncio.to_thread(extensions_service.update, name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Extension not found") from error
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_shared_settings("extensions")
    await _broadcast_notification(f"обновил расширение: {extension.name}", actor=_actor_from_request(request))
    return {"extension": extension.model_dump(mode="json")}


@app.put("/api/extensions/{name}/enabled")
async def set_extension_enabled(name: str, payload: dict[str, bool], request: Request) -> dict[str, object]:
    _require_permission(request, "manage_extensions")
    try:
        extension = extensions_service.set_enabled(name, bool(payload.get("enabled")))
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Extension not found") from error
    await _broadcast_shared_settings("extensions")
    await _broadcast_notification(f"{'включил' if extension.enabled else 'выключил'} расширение: {extension.name}", actor=_actor_from_request(request))
    return {"extension": extension.model_dump(mode="json")}


@app.delete("/api/extensions/{name}")
async def delete_extension(name: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_extensions")
    try:
        extensions_service.delete(name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Extension not found") from error
    await _broadcast_shared_settings("extensions")
    await _broadcast_notification(f"удалил расширение: {name}", actor=_actor_from_request(request))
    return {"ok": True}


@app.get("/scripts/extensions/{extension_path:path}")
@app.head("/scripts/extensions/{extension_path:path}")
async def extension_asset(extension_path: str) -> Response:
    if extension_path == "extensions.js":
        return await extension_compat_module()
    if extension_path == "regex/engine.js":
        return _compat_javascript("""
const dtRegex = () => globalThis.DoubleTroubleRegex || {};
export const regex_placement = { MD_DISPLAY: 0, RAW: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };
export const getRegexedString = (value, placement = 2, params = {}) => dtRegex().getRegexedString ? dtRegex().getRegexedString(String(value ?? ''), placement, params) : String(value ?? '');
export const runRegexScript = (script, value, params = {}) => dtRegex().runRegexScript ? dtRegex().runRegexScript(script, String(value ?? ''), params) : String(value ?? '');
""")
    try:
        path = extensions_service.file_path(extension_path)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Extension asset not found") from error
    return FileResponse(path)


@app.get("/scripts/extensions.js")
@app.get("/scripts/extensions/extensions.js")
async def extension_compat_module() -> Response:
    content = """
const ctx = () => globalThis.SillyTavern?.getContext?.() || {};
export const extension_settings = ctx().extensionSettings || {};
export const modules = [];
export const extensionTypes = { SYSTEM: 'system', LOCAL: 'local', GLOBAL: 'global', THIRD_PARTY: 'third-party' };
export const getContext = () => ctx();
export const getApiUrl = () => extension_settings.apiUrl || '';
export const ModuleWorkerWrapper = class { constructor(fn) { this.fn = fn; } update(...args) { return this.fn?.(...args); } };
export const renderExtensionTemplateAsync = async (extensionName, templateId, templateData = {}) => {
  if (ctx().renderExtensionTemplateAsync) return await ctx().renderExtensionTemplateAsync(extensionName, templateId, templateData);
  const cleanId = String(templateId || '').replace(/\\.html$/i, '');
  const response = await fetch(`/scripts/extensions/${extensionName}/${cleanId}.html`);
  return response.ok ? await response.text() : '';
};
export const renderExtensionTemplate = (extensionName, templateId, templateData = {}) => {
  if (ctx().renderExtensionTemplate) return ctx().renderExtensionTemplate(extensionName, templateId, templateData);
  return '';
};
export const saveMetadataDebounced = () => ctx().saveMetadataDebounced?.();
export const writeExtensionField = async (characterId, key, value) => ctx().writeExtensionField?.(characterId, key, value);
export const doExtrasFetch = (endpoint, args = {}) => fetch(endpoint, args);
""".strip()
    return Response(content=content, media_type="text/javascript; charset=utf-8")


def _compat_javascript(content: str) -> Response:
    return Response(content=content.strip(), media_type="text/javascript; charset=utf-8")


def _transparent_png() -> bytes:
    return base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=")


@app.get("/script.js")
async def script_compat_module(request: Request) -> Response:
    _, expected_bundle = _frontend_build_info()
    bundle_guard = f"""
const __dtExpectedBundle = {json.dumps(expected_bundle)};
if (__dtExpectedBundle && typeof document !== 'undefined' && !Array.from(document.scripts).some((s) => (s.src || '').includes(__dtExpectedBundle))) {{
  if (!globalThis.location?.search?.includes('_v=' + __dtExpectedBundle)) {{
    globalThis.location?.replace?.(globalThis.location.pathname + '?_v=' + encodeURIComponent(__dtExpectedBundle));
  }}
}}
""".strip()
    content = bundle_guard + "\n" + """
const ctx = () => globalThis.SillyTavern?.getContext?.() || {};
export const eventSource = ctx().eventSource;
export const event_types = ctx().event_types || ctx().eventTypes || {};
export const saveSettingsDebounced = (...args) => ctx().saveSettingsDebounced?.(...args);
export const saveSettings = saveSettingsDebounced;
export const getRequestHeaders = () => (ctx().getRequestHeaders ? ctx().getRequestHeaders() : { 'Content-Type': 'application/json' });
export const messageFormatting = (...args) => (ctx().messageFormatting ? ctx().messageFormatting(...args) : String(args[0] ?? ''));
export const saveChatConditional = () => (ctx().saveChat ? ctx().saveChat() : Promise.resolve());
export const saveChatDebounced = saveChatConditional;
export const chat = [];
export const characters = [];
export const personas = [];
export const chat_metadata = ctx().chatMetadata || {};
export const extension_prompts = ctx().extensionPrompts || {};
export let name1 = ctx().name1 || 'User';
export let name2 = ctx().name2 || 'Char';
export let this_chid = ctx().characterId ?? 0;
export let user_avatar = ctx().selectedPersona?.avatar || '';
const sync = () => {
  const c = ctx();
  chat.splice(0, chat.length, ...(c.chat || []));
  characters.splice(0, characters.length, ...(c.characters || []));
  personas.splice(0, personas.length, ...(c.personas || []));
  name1 = c.name1 || 'User';
  name2 = c.name2 || 'Char';
  this_chid = c.characterId ?? 0;
  user_avatar = c.selectedPersona?.avatar || '';
};
sync();
globalThis.setInterval?.(sync, 200);
export const system_avatar = 'system.png';
export const default_avatar = 'default.png';
export const is_send_press = false;
export const main_api = 'openai';
export const online_status = 'connected';
export const MAX_INJECTION_DEPTH = 1000;
export const system_message_types = { NARRATOR: 'narrator', COMMENT: 'comment', GENERIC: 'generic' };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2, AFTER_PROMPT: 3 };
export const getCurrentChatId = () => ctx().chatId || 'default';
export const getThumbnailUrl = (_type, file) => file?.startsWith?.('/') ? file : `/api/personas/avatars/${encodeURIComponent(file || 'default.png')}`;
export const reloadMarkdownProcessor = () => ({ makeHtml: (text) => messageFormatting(text) });
export const clearChat = async () => {};
export const printMessages = async () => {};
export const addOneMessage = async (mes, opts) => ctx().addOneMessage?.(mes, opts);
export const sendSystemMessage = async (type, text, extra) => ctx().sendSystemMessage?.(type, text, extra);
export const deleteLastMessage = async () => ctx().deleteLastMessage?.();
export const getPastCharacterChats = async () => [];
export const showSwipeButtons = () => {};
export const substituteParams = (text, ...rest) => ctx().substituteParams ? ctx().substituteParams(text, ...rest) : String(text ?? '').replaceAll('{{user}}', ctx().name1 || 'User').replaceAll('{{char}}', ctx().name2 || 'Char');
export const substituteParamsExtended = (text, ...rest) => ctx().substituteParamsExtended ? ctx().substituteParamsExtended(text, ...rest) : substituteParams(text);
export const saveMetadata = async () => ctx().saveMetadata?.();
export const saveCharacterDebounced = () => {};
export const getOneCharacter = (id) => characters[Number(id)] || characters[0] || null;
export const selectCharacterById = async () => {};
export const printCharacters = async () => {};
export const unshallowCharacter = async (character) => character;
export const deleteCharacter = async () => {};
export const getCharacters = async () => characters;
export const scrollChatToBottom = () => globalThis.scrollTo?.({ top: document.body.scrollHeight, behavior: 'smooth' });
export const reloadCurrentChat = async () => ctx().reloadCurrentChat?.();
export const activateSendButtons = () => {};
export const deactivateSendButtons = () => {};
export const setGenerationProgress = () => {};
export const setExtensionPrompt = (key, value, position = 1, depth = 4, scan = false, role = 0) => ctx().setExtensionPrompt ? ctx().setExtensionPrompt(key, value, position, depth, scan, role) : (extension_prompts[key] = { value, position, depth, scan, role });
export const baseChatReplace = (text) => substituteParams(text);
export const getCharacterCardFields = () => ({});
export const getBiasStrings = () => [];
export const getExtensionPromptRoleByName = (role) => extension_prompt_roles[String(role).toUpperCase()] ?? extension_prompt_roles.SYSTEM;
export const getMaxContextSize = () => ctx().maxContext || 8192;
export const getExtensionPromptByName = (name) => extension_prompts[name]?.value ?? extension_prompts[name] ?? '';
export const cleanUpMessage = (text) => String(text ?? '');
export const isOdd = (value) => Number(value) % 2 !== 0;
export const countOccurrences = (text, value) => String(text ?? '').split(String(value ?? '')).length - 1;
export const stopGeneration = async () => ctx().stopGeneration?.();
export const generateQuietPrompt = async (...args) => ctx().generateQuietPrompt ? await ctx().generateQuietPrompt(...args) : '';
export const generateRaw = async (...args) => ctx().generateRaw ? await ctx().generateRaw(...args) : '';
export const Generate = async (type, opts = {}) => ctx().Generate ? await ctx().Generate(type, opts) : await generateQuietPrompt(opts?.quiet_prompt || '');
export default {};
""".strip()
    resp = Response(content=content, media_type="text/javascript; charset=utf-8")
    _apply_cache_bust_headers(request, resp)
    return resp

@app.get("/scripts/{module_path:path}")
async def scripts_compat_module(module_path: str) -> Response:
    modules = {
        "personas.js": """
const ctx = () => globalThis.SillyTavern?.getContext?.() || {};
export const personas = {};
export const persona_names = [];
export const default_avatar = '';
export let user_avatar = '';
const avatarFileName = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text, globalThis.location?.origin || 'http://localhost');
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return decodeURIComponent(text.split(/[\\/]/).filter(Boolean).pop() || text);
  }
};
const avatarUrl = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('/') || /^(?:https?:|data:)/i.test(text)) return text;
  return `/User Avatars/${encodeURIComponent(text)}`;
};
const normalizePersona = (persona = {}) => ({
  id: String(persona.id || persona.name || ''),
  name: String(persona.name || ''),
  description: String(persona.description || ''),
  avatar: avatarFileName(persona.avatar || persona.avatar_url || ''),
  avatar_url: String(persona.avatar_url || avatarUrl(persona.avatar || '')),
  file: avatarFileName(persona.avatar || persona.avatar_url || ''),
  active: Boolean(persona.active),
});
export const syncPersonas = () => {
  const nextPersonas = (ctx().personas || []).map(normalizePersona).filter((persona) => persona.name);
  const selectedId = String(ctx().selectedPersonaId || '');
  const selected = nextPersonas.find((persona) => persona.id === selectedId) || nextPersonas.find((persona) => persona.active) || nextPersonas[0] || null;
  user_avatar = selected?.file || '';
  persona_names.splice(0, persona_names.length, ...nextPersonas.map((persona) => persona.name));
  Object.keys(personas).forEach((name) => delete personas[name]);
  nextPersonas.forEach((persona) => { personas[persona.name] = persona; });
  return nextPersonas;
};
export const getUserAvatars = async () => syncPersonas().map((persona) => persona.file).filter(Boolean);
export const getUserAvatar = (name) => {
  const avatarId = String(name || '').trim();
  const persona = syncPersonas().find((item) => item.file === avatarId || item.name === avatarId || item.id === avatarId);
  return persona?.avatar_url || avatarUrl(avatarId);
};
export const getPersonaAvatar = (name) => {
  const persona = syncPersonas().find((item) => item.name === name || item.id === name) || ctx().selectedPersona;
  return persona?.avatar_url || avatarUrl(persona?.avatar || persona?.file || '');
};
export const getPersonaDescription = (name) => {
  const persona = syncPersonas().find((item) => item.name === name || item.id === name) || ctx().selectedPersona;
  return persona?.description || '';
};
export const selectCurrentPersona = async () => ctx().selectedPersona || syncPersonas()[0] || null;
syncPersonas();
globalThis.setInterval?.(syncPersonas, 500);
export default personas;
""",
        "utils.js": """
export const uuidv4 = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const isDataURL = (value) => /^data:/i.test(String(value ?? ''));
export const getBase64Async = async (file) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
export const getImageSizeFromDataURL = async (dataUrl) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = reject; image.src = dataUrl; });
export const getStringHash = (value) => { let hash = 0; for (const char of String(value ?? '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0; return String(hash); };
export const getCharaFilename = (name) => String(name ?? '').replace(/[^\\w.-]+/g, '_');
export const ensureImageFormatSupported = async (file) => file;
export class Stopwatch { constructor() { this.start = performance.now(); } get elapsed() { return performance.now() - this.start; } }
export const download = (content, filename = 'download.txt', type = 'text/plain') => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = filename; a.click(); URL.revokeObjectURL(a.href); };
export const showFontAwesomePicker = async () => '';
export const getSanitizedFilename = (value) => String(value ?? 'file').replace(/[^\\w.-]+/g, '_');
""",
        "i18n.js": """
export const t = (strings, ...values) => Array.isArray(strings) && 'raw' in strings ? String.raw(strings, ...values) : String(strings ?? '');
export const getCurrentLocale = () => navigator.language || 'en-US';
""",
        "world-info.js": """
export const world_names = [];
export const selected_world_info = [];
export const world_info = {};
export const DEFAULT_WEIGHT = 100;
export const DEFAULT_DEPTH = 4;
export const world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };
export const world_info_position = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4 };
export const wi_anchor_position = world_info_position;
export const METADATA_KEY = 'world_info';
export const world_info_include_names = false;
export const newWorldInfoEntryTemplate = { uid: 0, key: [], keysecondary: [], comment: '', content: '', constant: false, selective: false, order: 100, position: world_info_position.after, disable: false };
export const saveWorldInfo = async () => {};
export const loadWorldInfo = async () => ({ entries: {} });
export const parseRegexFromString = (value) => new RegExp(String(value ?? ''));
export const createNewWorldInfo = async () => ({});
export const deleteWorldInfo = async () => {};
export const setWorldInfoButtonClass = () => {};
export const getWorldInfoSettings = () => ({});
export const getWorldInfoPrompt = async () => ({ worldInfoString: '', worldInfoBefore: '', worldInfoAfter: '' });
export const convertCharacterBook = (book) => book;
""",
        "preset-manager.js": """
const presets = [];
const preset_names = [];
export const getPresetManager = () => ({
  select: document.createElement('select'),
  getPresetList: () => ({ presets, preset_names }),
  getSelectedPreset: () => '0',
  getSelectedPresetName: () => 'in_use',
  getAllPresets: () => [...preset_names],
  findPreset: (name) => preset_names.includes(name) ? name : null,
  selectPreset: async () => {},
  savePreset: async (name, preset = {}) => { if (!preset_names.includes(name)) { preset_names.push(name); presets.push(preset); } },
  loadPreset: async () => ({}),
  deletePreset: async (name) => { const index = preset_names.indexOf(name); if (index >= 0) { preset_names.splice(index, 1); presets.splice(index, 1); return true; } return false; },
});
""",
        "openai.js": """
export const oai_settings = {};
export const proxies = [];
export class Message { constructor(role = 'user', content = '') { this.role = role; this.content = content; } }
export class MessageCollection extends Array {}
export class ChatCompletion {}
export const promptManager = {};
export const setOpenAIMessageExamples = () => {};
export const setOpenAIMessages = () => {};
export const prepareOpenAIMessages = () => [];
export const isImageInliningSupported = () => false;
export const setupChatCompletionPromptManager = () => {};
export const sendOpenAIRequest = async () => ({ choices: [] });
export const tryParseStreamingError = () => null;
export const getStreamingReply = async () => '';
export const getChatCompletionModel = () => '';
""",
        "macros.js": """
export const getLastMessageId = () => Math.max(0, (globalThis.SillyTavern?.getContext?.().chat?.length || 1) - 1);
const registeredMacros = new Map();
export class MacrosParser {
  static registerMacro(name, value) { registeredMacros.set(String(name), value); }
  static unregisterMacro(name) { registeredMacros.delete(String(name)); }
  registerMacro(name, value) { MacrosParser.registerMacro(name, value); }
  unregisterMacro(name) { MacrosParser.unregisterMacro(name); }
  parse(value) {
    return String(value ?? '').replace(/{{([^}]+)}}/g, (match, name) => {
      const macro = registeredMacros.get(String(name).trim());
      if (typeof macro === 'function') return String(macro());
      if (macro !== undefined) return String(macro);
      return match;
    });
  }
}
""",
        "RossAscends-mods.js": """
export const favsToHotswap = [];
export const isMobile = () => matchMedia('(max-width: 720px)').matches;
""",
        "power-user.js": """
export const power_user = {};
export const persona_description_positions = { IN_PROMPT: 0, AFTER_CHAR: 1 };
export const flushEphemeralStoppingStrings = () => {};
""",
        "user.js": "export const isAdmin = () => true;",
        "authors-note.js": """
export const NOTE_MODULE_NAME = 'authors_note';
export const metadata_keys = { prompt: 'note_prompt' };
export const shouldWIAddPrompt = () => false;
""",
        "PromptManager.js": """
export class Prompt { constructor(data = {}) { Object.assign(this, data); } }
export class PromptCollection extends Array {}
""",
        "sse-stream.js": "export const getEventSourceStream = async () => null;",
        "slash-commands.js": """
const ctx = () => globalThis.SillyTavern?.getContext?.() || {};
export const slashCommandRegistry = globalThis.__dtSlashCommands ?? (globalThis.__dtSlashCommands = new Map());
export const registerSlashCommand = (name, callback, aliases = [], helpString = '') => {
  if (ctx().registerSlashCommand) return ctx().registerSlashCommand(name, callback, aliases, helpString);
  slashCommandRegistry.set(String(name), { name, callback, aliases, helpString });
};
export const executeSlashCommands = async (text, ...rest) => ctx().executeSlashCommands ? await ctx().executeSlashCommands(text, ...rest) : String(text ?? '');
export const executeSlashCommandsWithOptions = async (text, opts = {}) => ctx().executeSlashCommandsWithOptions ? await ctx().executeSlashCommandsWithOptions(text, opts) : String(text ?? '');
""",
        "slash-commands/SlashCommand.js": """
export class SlashCommand { constructor(data = {}) { Object.assign(this, data); } static fromProps(data = {}) { return new SlashCommand(data); } }
""",
        "slash-commands/SlashCommandArgument.js": """
export const ARGUMENT_TYPE = { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', VARIABLE_NAME: 'variable_name', LIST: 'list', DICTIONARY: 'dictionary', SUBCOMMAND: 'subcommand' };
export class SlashCommandArgument { constructor(data = {}) { Object.assign(this, data); } static fromProps(data = {}) { return new SlashCommandArgument(data); } }
export class SlashCommandNamedArgument extends SlashCommandArgument {}
""",
        "slash-commands/SlashCommandCommonEnumsProvider.js": """
import { SlashCommandEnumValue, enumTypes } from './SlashCommandEnumValue.js';
export const enumIcons = { file: 'file', boolean: 'toggle-on', variable: 'at', character: 'user', world: 'book' };
export const commonEnumProviders = {
  boolean: () => () => [new SlashCommandEnumValue('true', 'true', enumTypes.enum, enumIcons.boolean), new SlashCommandEnumValue('false', 'false', enumTypes.enum, enumIcons.boolean)],
  variables: () => () => [],
  characters: () => () => [],
  worlds: () => () => [],
};
""",
        "slash-commands/SlashCommandEnumValue.js": """
export const enumTypes = { enum: 'enum', name: 'name', command: 'command' };
export class SlashCommandEnumValue { constructor(value, description = '', type = enumTypes.enum, icon = '') { this.value = value; this.description = description || ''; this.type = type; this.icon = icon || ''; } }
""",
        "slash-commands/SlashCommandParser.js": """
export class SlashCommandParser {
  static get commands() { globalThis.__dtSlashCommands ??= new Map(); return Object.fromEntries(globalThis.__dtSlashCommands); }
  static addCommandObject(command) {
    globalThis.__dtSlashCommands ??= new Map();
    const name = command?.name || command?.command;
    if (name) {
      globalThis.__dtSlashCommands.set(String(name), command);
      if (Array.isArray(command?.aliases)) {
        command.aliases.forEach((alias) => alias && globalThis.__dtSlashCommands.set(String(alias), command));
      }
    }
  }
  static parse(text) { return { command: String(text ?? ''), args: [] }; }
}
""",
        "popup.js": """
const ctx = () => globalThis.SillyTavern?.getContext?.() || {};
export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 };
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
export const callGenericPopup = async (content, type = 1, inputValue = '', options = {}) => {
  if (ctx().callGenericPopup) return await ctx().callGenericPopup(content, type, inputValue, options);
  if (type === POPUP_TYPE.CONFIRM) return globalThis.confirm?.(typeof content === 'string' ? content.replace(/<[^>]+>/g, '') : 'Confirm?') ? 1 : 0;
  if (type === POPUP_TYPE.INPUT) return globalThis.prompt?.(typeof content === 'string' ? content.replace(/<[^>]+>/g, '') : 'Input:', String(inputValue ?? ''));
  return 1;
};
export const callPopup = callGenericPopup;
export class Popup {
  constructor(content, type = 1, inputValue = '', options = {}) {
    this.content = content;
    this.type = type;
    this.inputValue = inputValue;
    this.options = options;
    this.value = inputValue;
    this.result = 1;
  }
  async show() {
    const out = await callGenericPopup(this.content, this.type, this.inputValue, this.options);
    this.value = out;
    this.result = out ? 1 : 0;
    return out;
  }
  static get util() { return { POPUP_TYPE, POPUP_RESULT }; }
}
""",
        "tokenizers.js": "export const getTokenCountAsync = async (text) => Math.ceil(String(text ?? '').length / 4); export const getTokenCount = (text) => Math.ceil(String(text ?? '').length / 4);",
        "templates.js": """
const ctx = () => globalThis.SillyTavern?.getContext?.() || {};
export const renderTemplateAsync = async (templateId, data = {}) => ctx().renderExtensionTemplateAsync ? await ctx().renderExtensionTemplateAsync('', templateId, data) : '';
export const renderTemplate = (templateId, data = {}) => ctx().renderExtensionTemplate ? ctx().renderExtensionTemplate('', templateId, data) : '';
""",
        "group-chats.js": "export const groups = []; export const selected_group = null; export const is_group_generating = false; export const getGroupAvatar = () => '';",
        "tags.js": "export const tags = []; export const tag_map = {}; export const getTagsList = () => [];",
        "chats.js": "export const saveChat = async () => globalThis.SillyTavern?.getContext?.().saveChat?.();",
        "char-data.js": "export const char_data = {};",
        "custom-request.js": "export class CustomRequest { async send() { return {}; } }",
    }
    if module_path in modules:
        return _compat_javascript(modules[module_path])
    if module_path.startswith("extensions/"):
        return await extension_asset(module_path.removeprefix("extensions/"))
    raise HTTPException(status_code=404, detail="Compatibility script not found")


@app.post("/api/images/upload")
async def upload_extension_image(payload: ExtensionImageUpload, request: Request) -> dict[str, str]:
    _require_permission(request, "edit_messages")
    image_format = payload.format.lower().strip().lstrip(".") or "png"
    if image_format not in {"png", "jpg", "jpeg", "webp", "gif"}:
        raise HTTPException(status_code=400, detail="Unsupported image format")
    directory_name = _safe_media_part(payload.ch_name)
    filename = f"{_safe_media_part(payload.filename, 'image')}.{image_format}"
    directory = storage.user_root / "user" / "images" / directory_name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / filename).write_bytes(_decode_base64_payload(payload.image))
    return {"path": f"/user/images/{quote(directory_name)}/{quote(filename)}"}


@app.post("/api/files/upload")
async def upload_extension_file(payload: ExtensionFileUpload, request: Request) -> dict[str, str]:
    _require_permission(request, "edit_messages")
    filename = _safe_media_part(Path(payload.name).name, "file.bin")
    directory = storage.user_root / "user" / "files"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / filename).write_bytes(_decode_base64_payload(payload.data))
    return {"path": f"/user/files/{quote(filename)}"}


@app.get("/user/images/{folder}/{filename}")
@app.head("/user/images/{folder}/{filename}")
async def extension_image(folder: str, filename: str, request: Request) -> FileResponse:
    path = storage.user_root / "user" / "images" / Path(folder).name / Path(filename).name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(path)


@app.get("/user/files/{filename}")
@app.head("/user/files/{filename}")
async def extension_file(filename: str) -> FileResponse:
    path = storage.user_root / "user" / "files" / Path(filename).name
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path)


@app.post("/api/backends/chat-completions/generate")
@app.post("/api/extensions/generate")
async def extension_chat_completions_generate(payload: dict[str, Any], request: Request) -> dict[str, object]:
    _require_permission(request, "generate")
    from backend.app.llm.base import ChatMessage
    raw_messages = payload.get("messages")
    chat_messages: list[ChatMessage] = []
    if isinstance(raw_messages, list) and raw_messages:
        for item in raw_messages:
            if isinstance(item, dict) and str(item.get("content") or "").strip():
                role = str(item.get("role") or "user").lower()
                if role not in {"system", "user", "assistant"}:
                    role = "user"
                chat_messages.append(ChatMessage(role=role, content=str(item.get("content"))))
    else:
        sys_prompt = str(payload.get("system_prompt") or payload.get("systemPrompt") or "").strip()
        if sys_prompt:
            chat_messages.append(ChatMessage(role="system", content=sys_prompt))
        prompt_text = str(payload.get("prompt") or payload.get("quiet_prompt") or payload.get("quietPrompt") or "").strip()
        if prompt_text:
            chat_messages.append(ChatMessage(role="user", content=prompt_text))
    if not chat_messages:
        raise HTTPException(status_code=400, detail="Prompt or messages are required")
    max_tokens_raw = payload.get("max_tokens") or payload.get("responseLength")
    max_tokens = int(max_tokens_raw) if isinstance(max_tokens_raw, (int, float)) and int(max_tokens_raw) > 0 else None
    temp_raw = payload.get("temperature")
    temperature = float(temp_raw) if isinstance(temp_raw, (int, float)) else None
    try:
        text = await generation_service.raw_generate(chat_messages, max_tokens=max_tokens, temperature=temperature)
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {
        "ok": True,
        "text": text,
        "content": text,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
    }


@app.post("/api/avatars/get")
async def extension_avatars(request: Request) -> list[str]:
    _require_permission(request, "view_personas")
    if not personas_service.avatars_dir.exists():
        return []
    return [path.name for path in sorted(personas_service.avatars_dir.iterdir()) if path.is_file()]


@app.get("/User Avatars/{filename:path}")
@app.head("/User Avatars/{filename:path}")
async def extension_user_avatar(filename: str, request: Request) -> Response:
    _require_permission(request, "view_personas")
    safe_name = Path(filename).name
    if not safe_name or safe_name in {"default.png", "default.jpg", "system.png"}:
        return Response(content=_transparent_png(), media_type="image/png")
    try:
        path = personas_service.avatar_path(safe_name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Persona avatar not found") from error
    return FileResponse(path)


@app.get("/api/config/public")
async def public_config(request: Request, response: Response) -> dict[str, object]:
    build_id = _apply_cache_bust_headers(request, response)
    return {
        "build_id": build_id,
        "server": {"public_url": config.server.public_url},
        "auth": {"mode": config.auth.mode, "required": settings_service.auth_required()},
        "registration_allowed": settings_service.registration_allowed(),
        "access_password_required": settings_service.access_password_required(),
        "default_session_id": DEFAULT_SESSION_ID,
    }

@app.post("/api/auth/register")
async def auth_register(payload: AuthRequest, request: Request, response: Response) -> dict[str, object]:
    _check_auth_rate_limit(_request_client_ip(request))
    _require_access_password(request)
    if not settings_service.registration_allowed():
        raise HTTPException(status_code=403, detail="Registration is disabled")
    try:
        user, token = auth_service.register(payload.username, payload.password)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    personas_service.list_personas(owner=user.username, is_admin=user.is_admin)
    response.set_cookie(
        "doubletrouble_auth_token",
        token,
        httponly=True,
        secure=config.security.cookie_secure,
        samesite=config.security.cookie_samesite,
        path="/",
    )
    return {"token": token, "user": auth_service.public_user(user)}

@app.post("/api/auth/login")
async def auth_login(payload: AuthRequest, request: Request, response: Response) -> dict[str, object]:
    _check_auth_rate_limit(_request_client_ip(request))
    _require_access_password(request)
    try:
        if not auth_service.state.users and settings_service.registration_allowed():
            user, token = auth_service.register(payload.username, payload.password)
            personas_service.list_personas(owner=user.username, is_admin=user.is_admin)
        else:
            user, token = auth_service.login(payload.username, payload.password)
    except ValueError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    response.set_cookie(
        "doubletrouble_auth_token",
        token,
        httponly=True,
        secure=config.security.cookie_secure,
        samesite=config.security.cookie_samesite,
        path="/",
    )
    return {"token": token, "user": auth_service.public_user(user)}


@app.get("/api/auth/me")
async def auth_me(request: Request) -> dict[str, object]:
    _require_access_password(request)
    return {"user": auth_service.public_user(_auth_user_from_request(request))}


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response) -> dict[str, object]:
    _require_access_password(request)
    auth_service.logout(_token_from_request(request))
    response.delete_cookie("doubletrouble_auth_token", path="/")
    response.delete_cookie("doubletrouble_access", path="/")
    return {"ok": True}


@app.post("/api/auth/claim-admin")
async def claim_admin(payload: AdminClaimRequest, request: Request) -> dict[str, object]:
    _require_access_password(request)
    try:
        user = auth_service.claim_admin(_token_from_request(request), payload.code, config.auth.admin_code)
    except PermissionError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"user": auth_service.public_user(user)}


@app.get("/api/security/permissions")
async def get_security_permissions() -> dict[str, object]:
    settings = settings_service.security_settings_payload()
    return {
        "auth_required": settings.auth_required,
        "registration_allowed": settings.registration_allowed,
        "bot_reply_allowed": settings.bot_reply_allowed,
        "access_password_required": settings.access_password_required,
        "access_password_configured": settings.access_password_configured,
        "permissions": settings.permissions.model_dump(mode="json"),
    }


@app.get("/api/security/config")
async def get_security_config(request: Request, response: Response) -> dict[str, object]:
    build_id = _apply_cache_bust_headers(request, response)
    return {
        "build_id": build_id,
        "cookie_auth": config.security.cookie_auth,
        "cookie_secure": config.security.cookie_secure,
        "cookie_samesite": config.security.cookie_samesite,
    }

@app.get("/api/security/access")
async def get_access_password_status(request: Request) -> dict[str, object]:
    required = settings_service.access_password_required()
    return {"required": required, "unlocked": not required or settings_service.verify_access_token(_access_token_from_request(request))}


@app.post("/api/security/access")
async def unlock_access_password(payload: AccessPasswordRequest, request: Request, response: Response) -> dict[str, object]:
    _check_auth_rate_limit(_request_client_ip(request))
    try:
        token = settings_service.verify_access_password(payload.password)
    except ValueError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    response.set_cookie(
        "doubletrouble_access",
        token,
        httponly=True,
        secure=config.security.cookie_secure,
        samesite=config.security.cookie_samesite,
        path="/",
    )
    return {"ok": True, "required": settings_service.access_password_required(), "token": token}


@app.put("/api/security/permissions")
async def update_security_permissions(payload: SecuritySettingsPayload, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_security")
    try:
        settings = settings_service.update_security_settings(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await connection_manager.broadcast(
        DEFAULT_SESSION_ID,
        {
            "type": "security.updated",
            "auth_required": settings.auth_required,
            "registration_allowed": settings.registration_allowed,
            "bot_reply_allowed": settings.bot_reply_allowed,
            "access_password_required": settings.access_password_required,
            "access_password_configured": settings.access_password_configured,
            "permissions": settings.permissions.model_dump(mode="json"),
        },
    )
    return {
        "auth_required": settings.auth_required,
        "registration_allowed": settings.registration_allowed,
        "bot_reply_allowed": settings.bot_reply_allowed,
        "access_password_required": settings.access_password_required,
        "access_password_configured": settings.access_password_configured,
        "permissions": settings.permissions.model_dump(mode="json"),
    }


@app.get("/api/keys")
async def list_managed_keys(request: Request) -> dict[str, object]:
    _require_permission(request, "manage_keys")
    return {"keys": _provider_key_payloads()}


@app.post("/api/keys")
async def create_managed_key(payload: KeyUpdateRequest, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_keys")
    name = payload.name.strip()
    value = payload.value.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Key name is required")
    if not value:
        raise HTTPException(status_code=400, detail="Key value is required")
    entries = _provider_key_registry()
    had_active_key = bool(_active_provider_key_id())
    key_id = f"provider_api_key:{uuid4()}"
    entries.append({"id": key_id, "name": name})
    _save_provider_key_registry(entries)
    secret_store.write(key_id, value)
    if not had_active_key:
        _set_active_provider_key(key_id)
    generation_service.update_config(settings_service.generation_config())
    await _broadcast_shared_settings("keys")
    return {"keys": _provider_key_payloads()}


@app.put("/api/keys/{key_id}")
async def update_managed_key(key_id: str, payload: KeyUpdateRequest, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_keys")
    entries = _provider_key_registry()
    entry = next((item for item in entries if item["id"] == key_id), None)
    if not entry:
        raise HTTPException(status_code=404, detail="Key not found")
    name = payload.name.strip()
    value = payload.value.strip()
    if name:
        entry["name"] = name
        _save_provider_key_registry(entries)
    if value:
        secret_store.write(key_id, value)
        if key_id == _active_provider_key_id():
            _set_active_provider_key(key_id)
    generation_service.update_config(settings_service.generation_config())
    await _broadcast_shared_settings("keys")
    return {"keys": _provider_key_payloads()}


@app.post("/api/keys/{key_id}/active")
async def activate_managed_key(key_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_keys")
    if not any(entry["id"] == key_id for entry in _provider_key_registry()):
        raise HTTPException(status_code=404, detail="Key not found")
    try:
        _set_active_provider_key(key_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    generation_service.update_config(settings_service.generation_config())
    await _broadcast_shared_settings("keys")
    return {"keys": _provider_key_payloads()}


@app.delete("/api/keys/{key_id}")
async def delete_managed_key(key_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_keys")
    entries = _provider_key_registry()
    if not any(entry["id"] == key_id for entry in entries):
        raise HTTPException(status_code=404, detail="Key not found")
    was_active = key_id == _active_provider_key_id()
    next_entries = [entry for entry in entries if entry["id"] != key_id]
    _save_provider_key_registry(next_entries)
    secret_store.delete(key_id)
    if was_active and next_entries:
        _set_active_provider_key(next_entries[0]["id"])
    elif was_active:
        secret_store.delete(PROVIDER_KEY_ACTIVE_SECRET)
        secret_store.delete("provider_api_key")
    generation_service.update_config(settings_service.generation_config())
    await _broadcast_shared_settings("keys")
    return {"keys": _provider_key_payloads()}


@app.get("/api/delete-locks")
async def get_delete_locks(request: Request) -> dict[str, object]:
    _require_permission(request, "view_chats")
    return {"delete_locks": settings_service.delete_locks().model_dump(mode="json")}


@app.put("/api/delete-locks")
async def update_delete_lock(payload: DeleteLockUpdate, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_security")
    item_id = payload.item_id.strip()
    if not item_id:
        raise HTTPException(status_code=400, detail="Delete lock item id is required")
    try:
        locks = settings_service.set_delete_lock(payload.category, item_id, payload.locked)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_delete_locks()
    await _broadcast_notification(
        f"{'заблокировал' if payload.locked else 'разблокировал'} удаление: {payload.category}/{item_id}",
        actor=_actor_from_request(request),
    )
    return {"delete_locks": locks.model_dump(mode="json")}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "view_chats")
    return session_service.snapshot(session_id)



@app.get("/api/rooms")
async def list_rooms(request: Request) -> dict[str, object]:
    _require_permission(request, "view_chats")
    return {"rooms": session_service.list_rooms()}

@app.post("/api/sessions/{session_id}/join")
async def join_session(session_id: str, request: JoinSessionRequest, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "edit_messages")
    participant = session_service.join_session(session_id, request.name, request.participant_id)
    await _broadcast_presence(session_id)
    return {"participant": participant.model_dump(mode="json"), "session": session_service.snapshot(session_id)}


@app.post("/api/sessions/{session_id}/messages")
async def send_message(session_id: str, request: SendMessageRequest, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "edit_messages")
    message = session_service.add_message(session_id, request)
    await connection_manager.broadcast(
        session_id,
        {"type": "session.updated", "session": session_service.snapshot(session_id), "message": message.model_dump(mode="json")},
    )
    return {"message": message.model_dump(mode="json")}


@app.get("/api/generation/status")
async def generation_status() -> dict[str, object]:
    return await generation_service.status()


@app.get("/api/generation/settings")
async def generation_settings() -> dict[str, object]:
    return settings_service.generation_settings()


@app.put("/api/generation/settings")
async def update_generation_settings(request: GenerationSettingsUpdate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "manage_presets")
    generation = settings_service.update_generation_settings(request)
    generation_service.update_config(generation)
    await _broadcast_shared_settings("generation")
    return settings_service.generation_settings()



@app.get("/api/settings/memory")
async def get_summary_memory_settings(request: Request) -> dict[str, object]:
    _require_permission(request, "view_presets")
    return settings_service.summary_memory_settings()


@app.put("/api/settings/memory")
async def update_summary_memory_settings(request: SummaryMemorySettingsUpdate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "manage_presets")
    settings_service.update_summary_memory_settings(request)
    await _broadcast_shared_settings("memory")
    return settings_service.summary_memory_settings()


@app.post("/api/settings/memory/models")
async def summary_memory_models(request: SummaryMemorySettingsUpdate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "manage_presets")
    base_url = request.base_url.strip()
    if base_url and not base_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="base_url must be http or https")
    source_id = request.chat_completion_source or resolve_source_id(request.provider or "openai-compatible")
    current_mem = settings_service.summary_memory_config()
    api_key = request.api_key.strip() or secret_store.read(current_mem.api_key_secret, "")
    if not api_key:
        source = get_source(source_id)
        if source and source.secret_key_name:
            api_key = secret_store.read(source.secret_key_name, source.api_key_env)
    provider = build_provider(
        source_id,
        base_url=base_url,
        api_key=api_key,
        timeout_seconds=30.0,
    )
    return await provider.status()

@app.get("/api/generation/presets")
async def generation_presets(request: Request) -> dict[str, object]:
    _require_permission(request, "view_presets")
    return {"presets": [preset.model_dump(mode="json") for preset in settings_service.generation_presets()], "active": settings_service.active_generation_preset()}


@app.post("/api/generation/presets")
async def save_generation_preset(request: GenerationPresetSave, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "manage_presets")
    try:
        preset = settings_service.save_generation_preset(request)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    generation_service.update_config(settings_service.generation_config())
    await _broadcast_shared_settings("generation")
    return {"preset": preset.model_dump(mode="json"), "settings": settings_service.generation_settings(), "active": settings_service.active_generation_preset()}


@app.post("/api/generation/presets/{name}/active")
async def apply_generation_connection_preset(name: str) -> dict[str, object]:
    try:
        generation = settings_service.apply_generation_preset(name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Preset not found") from error
    generation_service.update_config(generation)
    await _broadcast_shared_settings("generation")
    return {"settings": settings_service.generation_settings(), "active": settings_service.active_generation_preset()}


@app.delete("/api/generation/presets/{name}")
async def delete_generation_preset(name: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_presets")
    try:
        settings_service.delete_generation_preset(name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Preset not found") from error
    await _broadcast_shared_settings("generation")
    return {"ok": True, "active": settings_service.active_generation_preset()}


@app.get("/api/generation/sources")
async def generation_sources() -> dict[str, object]:
    return {"sources": list_sources_payload()}


@app.post("/api/generation/models")
async def generation_models(request: GenerationSettingsUpdate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "manage_keys")
    if request.provider == "disabled":
        return {"ok": False, "error": "generation provider is disabled"}
    base_url = request.base_url.strip()
    if base_url and not base_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="base_url must be http or https")
    source_id = request.chat_completion_source or resolve_source_id(request.provider)
    current = settings_service.generation_config()
    source = get_source(source_id)
    api_key = request.api_key.strip()
    if not api_key and source and source.secret_key_name:
        api_key = secret_store.read(source.secret_key_name, source.api_key_env)
    if not api_key:
        api_key = secret_store.read(current.api_key_secret, current.api_key_env)
    proxy_password = ""
    if request.reverse_proxy.strip():
        proxy_password = request.proxy_password.strip() or secret_store.read(current.proxy_password_secret, "")
    extra_settings = (request.source_settings or {}).get(source_id, {})
    provider = build_provider(
        source_id,
        base_url=request.base_url,
        api_key=api_key,
        timeout_seconds=request.timeout_seconds,
        extra_settings=extra_settings,
        reverse_proxy=request.reverse_proxy,
        proxy_password=proxy_password,
    )
    return await provider.status()


@app.post("/api/generation/test")
async def generation_test(request: GenerationSettingsUpdate, http_request: Request) -> dict[str, object]:
    """Quick connectivity check that exercises the same provider plumbing as live generation."""
    _require_permission(http_request, "manage_keys")
    if request.provider == "disabled":
        return {"ok": False, "error": "generation provider is disabled"}
    return await generation_models(request, http_request)


@app.post("/api/image-generation/models")
async def image_generation_models(payload: ImageModelsRequest, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_extensions")
    api_type = payload.api_type.strip().lower()
    if api_type == "naistera":
        return {"ok": True, "models": ["grok", "grok-pro", "nano banana 2", "novelai"]}

    endpoint = payload.endpoint.strip().rstrip("/")
    if not endpoint:
        return {"ok": False, "error": "Image endpoint is not configured"}

    headers: dict[str, str] = {}
    params: dict[str, str] = {}
    if payload.api_key.strip():
        headers["Authorization"] = f"Bearer {payload.api_key.strip()}"

    if api_type == "gemini":
        root = endpoint
        root = re.sub(r"/v1(?:beta)?/models(?:/.*)?$", "", root).rstrip("/")
        root = re.sub(r"/v1(?:beta)?$", "", root).rstrip("/")
        urls = [f"{root}/v1beta/models", f"{root}/v1/models"]
        if payload.api_key.strip():
            params["key"] = payload.api_key.strip()
    else:
        root = endpoint
        root = re.sub(r"/v1/images/generations$", "/v1", root).rstrip("/")
        root = re.sub(r"/images/generations$", "", root).rstrip("/")
        root = re.sub(r"/v1/models$", "/v1", root).rstrip("/")
        root = re.sub(r"/models$", "", root).rstrip("/")
        urls = [f"{root}/models" if root.endswith("/v1") else f"{root}/v1/models"]

    last_error: dict[str, object] | None = None
    try:
        async with httpx.AsyncClient(timeout=max(payload.timeout_seconds, 30.0)) as client:
            for url in urls:
                try:
                    response = await client.get(url, headers=headers, params=params)
                    response.raise_for_status()
                    return {"ok": True, "models": response.json()}
                except httpx.HTTPStatusError as error:
                    last_error = _image_models_provider_error(error.response, url)
                except ValueError:
                    last_error = {"status_code": response.status_code, "error": f"Провайдер вернул не-JSON ответ для списка моделей: {url}"}
        return {"ok": False, **(last_error or {"error": "Не удалось загрузить модели"})}
    except httpx.HTTPError as error:
        return {"ok": False, "error": str(error)}


def _image_models_provider_error(response: httpx.Response, url: str) -> dict[str, object]:
    content_type = response.headers.get("content-type", "").lower()
    detail = ""
    if "application/json" in content_type:
        try:
            parsed = response.json()
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            raw_detail = parsed.get("error") or parsed.get("detail") or parsed.get("message")
            if isinstance(raw_detail, dict):
                raw_detail = raw_detail.get("message") or raw_detail.get("error")
            detail = str(raw_detail or "").strip()
    if not detail and "html" not in content_type:
        detail = response.text.strip()[:300]
    if not detail:
        reason = response.reason_phrase or "HTTP error"
        detail = f"{response.status_code} {reason}"
    return {"status_code": response.status_code, "error": f"Провайдер не отдал список моделей ({detail}) для {url}"}


@app.post("/api/magic-translation/translate")
async def magic_translation_translate(payload: MagicTranslationRequest, request: Request) -> dict[str, object]:
    _require_permission(request, "generate")
    try:
        from backend.app.llm.base import ChatMessage
        from backend.app.config import GenerationConfig
        chat_messages = [ChatMessage(role="user", content=payload.text)]
        if payload.prompt:
            rendered = payload.prompt.replace("{{prompt}}", payload.text).replace("{{language}}", payload.target_language)
            if payload.chat_context:
                for i, ctx in enumerate(payload.chat_context[-3:]):
                    rendered = rendered.replace(f"{{chat_{i + 1}}}", ctx.get("mes", ""))
            rendered = rendered.replace("{{name}}", payload.message_name or "User")
            chat_messages = [ChatMessage(role="user", content=rendered)]
        if payload.provider:
            profile_config = GenerationConfig(
                provider=payload.provider,
                base_url=payload.base_url,
                model=payload.model,
                api_key_secret="magic_translation_api_key",
                api_key_env="",
                temperature=payload.temperature,
                max_tokens=payload.max_tokens,
                timeout_seconds=payload.timeout_seconds,
                source_settings=payload.source_settings,
            )
            if payload.api_key:
                secret_store.write("magic_translation_api_key", payload.api_key)
            response_text = await generation_service.raw_generate_with_config(chat_messages, profile_config)
        else:
            response_text = await generation_service.raw_generate(chat_messages, max_tokens=payload.max_tokens, temperature=payload.temperature)
        if payload.filter_code_block:
            code_block_match = re.search(r"^(?:[^`]*?)\n?```[\s\S]*?\n([\s\S]*?)```(?!\s*```)", response_text)
            if code_block_match:
                response_text = code_block_match.group(1).strip()
        return {"ok": True, "text": response_text}
    except httpx.HTTPStatusError as error:
        raise HTTPException(status_code=502, detail=f"Provider returned {error.response.status_code}: {error.response.text}") from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Provider error: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Translation failed: {error}") from error


@app.get("/api/presets/types")
async def preset_types(request: Request) -> dict[str, object]:
    _require_permission(request, "view_presets")
    return {"types": [preset_type.model_dump(mode="json") for preset_type in presets_service.types()]}


@app.get("/api/presets/active")
async def active_presets(request: Request) -> dict[str, object]:
    _require_permission(request, "view_presets")
    return {"active": settings_service.active_preset_settings()}


@app.get("/api/presets/{preset_type}")
async def list_presets(preset_type: str, request: Request) -> dict[str, object]:
    _require_permission(request, "view_presets")
    try:
        presets = presets_service.list_presets(preset_type)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Preset type not found") from error
    return {"presets": [preset.model_dump(mode="json") for preset in presets]}


@app.get("/api/presets/{preset_type}/active-draft")
async def active_preset_draft(preset_type: str, request: Request) -> dict[str, object]:
    _require_permission(request, "view_presets")
    if preset_type not in presets_service.TYPES:
        raise HTTPException(status_code=404, detail="Preset type not found")
    active = settings_service.active_preset_settings()
    name = str(active.get(preset_type) or "")
    preset = active_preset_overrides.get(preset_type)
    if preset is None and name:
        try:
            preset = presets_service.get_preset(preset_type, name)
        except (KeyError, FileNotFoundError):
            preset = {}
    return {"active": active, "name": name, "preset": preset or {}}


@app.get("/api/presets/{preset_type}/{name}")
async def get_preset(preset_type: str, name: str, request: Request) -> dict[str, object]:
    _require_permission(request, "view_presets")
    try:
        preset = presets_service.get_preset(preset_type, name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Preset type not found") from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Preset not found") from error
    return {"preset": preset}


@app.put("/api/presets/{preset_type}")
async def save_preset(preset_type: str, payload: PresetPayload, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_presets")
    try:
        preset = presets_service.save_preset(preset_type, payload)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Preset type not found") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_shared_settings("presets")
    await _broadcast_notification(f"сохранил пресет: {preset.name}", actor=_actor_from_request(request))
    return {"preset": preset.model_dump(mode="json")}


@app.post("/api/presets/{preset_type}/import")
async def import_preset(preset_type: str, request: Request, file: UploadFile = File(...)) -> dict[str, object]:
    _require_permission(request, "manage_presets")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Preset file is required")
    try:
        preset = presets_service.import_preset(preset_type, file.filename, await file.read())
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Preset type not found") from error
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_shared_settings("presets")
    await _broadcast_notification(f"импортировал пресет: {preset.name}", actor=_actor_from_request(request))
    return {"preset": preset.model_dump(mode="json")}


@app.delete("/api/presets/{preset_type}/{name}")
async def delete_preset(preset_type: str, name: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_presets")
    try:
        presets_service.delete_preset(preset_type, name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Preset type not found") from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Preset not found") from error
    await _broadcast_shared_settings("presets")
    await _broadcast_notification(f"удалил пресет: {name}", actor=_actor_from_request(request))
    return {"ok": True}


@app.get("/api/presets/{preset_type}/{name}/export")
async def export_preset(preset_type: str, name: str, request: Request) -> Response:
    _require_permission(request, "view_presets")
    try:
        filename, content = presets_service.export_preset(preset_type, name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Preset type not found") from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Preset not found") from error
    return Response(
        content=content,
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=preset.json; filename*=UTF-8''{quote(filename)}"},
    )


@app.post("/api/presets/{preset_type}/{name}/apply")
async def apply_preset(preset_type: str, name: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_presets")
    try:
        preset = presets_service.get_preset(preset_type, name)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Preset type not found") from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Preset not found") from error
    active = settings_service.set_active_preset(preset_type, name)
    active_preset_overrides[preset_type] = preset
    generation = _apply_generation_preset(preset_type, preset)
    if generation:
        generation_service.update_config(generation)
    await _broadcast_shared_settings("presets")
    await _broadcast_notification(f"изменил активный пресет: {name}", actor=_actor_from_request(request))
    return {"active": active, "settings": settings_service.generation_settings()}


@app.put("/api/presets/{preset_type}/active-draft")
async def update_active_preset_draft(preset_type: str, payload: PresetPayload, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_presets")
    if preset_type not in presets_service.TYPES:
        raise HTTPException(status_code=404, detail="Preset type not found")
    active_preset_overrides[preset_type] = payload.preset
    active = settings_service.set_active_preset(preset_type, payload.name.strip() or "unsaved")
    generation = _apply_generation_preset(preset_type, payload.preset)
    if generation:
        generation_service.update_config(generation)
    await _broadcast_shared_settings("presets")
    return {"active": active, "settings": settings_service.generation_settings()}


@app.post("/api/presets/import-sillytavern-defaults")
async def import_sillytavern_defaults(request: Request, source_root: str = Form("E:/ST/SillyTavern/default/content")) -> dict[str, object]:
    _require_permission(request, "manage_presets")
    copied = presets_service.import_directory(Path(source_root))
    await _broadcast_shared_settings("presets")
    await _broadcast_notification(f"импортировал дефолтные пресеты ST: {copied}", actor=_actor_from_request(request))
    return {"copied": copied}


@app.get("/api/lorebooks")
async def list_lorebooks(request: Request) -> dict[str, object]:
    _require_permission(request, "view_lorebooks")
    return {"lorebooks": [book.model_dump(mode="json") for book in lorebooks_service.list_books()], "bindings": [binding.model_dump(mode="json") for binding in lorebooks_service.bindings()]}


@app.post("/api/lorebooks/import")
async def import_lorebook(request: Request, file: UploadFile = File(...)) -> dict[str, object]:
    _require_permission(request, "manage_lorebooks")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Lorebook file is required")
    try:
        book = lorebooks_service.import_book(file.filename, await file.read())
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_shared_settings("lorebooks")
    await _broadcast_notification(f"импортировал лорбук: {book.name}", actor=_actor_from_request(request))
    return {"lorebook": book.model_dump(mode="json")}


@app.get("/api/lorebooks/{name}")
async def get_lorebook(name: str, request: Request) -> dict[str, object]:
    _require_permission(request, "view_lorebooks")
    try:
        return {"book": lorebooks_service.get_book(name)}
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Lorebook not found") from error


@app.put("/api/lorebooks")
async def save_lorebook(payload: LorebookPayload, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_lorebooks")
    try:
        book = lorebooks_service.save_book(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_shared_settings("lorebooks")
    await _broadcast_notification(f"сохранил лорбук: {book.name}", actor=_actor_from_request(request))
    return {"lorebook": book.model_dump(mode="json")}


@app.delete("/api/lorebooks/{name}")
async def delete_lorebook(name: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_lorebooks")
    try:
        lorebooks_service.delete_book(name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Lorebook not found") from error
    await _broadcast_shared_settings("lorebooks")
    await _broadcast_notification(f"удалил лорбук: {name}", actor=_actor_from_request(request))
    return {"ok": True}


@app.get("/api/lorebooks/{name}/export")
async def export_lorebook(name: str, request: Request) -> Response:
    _require_permission(request, "view_lorebooks")
    try:
        book = lorebooks_service.get_book(name)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Lorebook not found") from error
    filename = f"{name}.json"
    return Response(
        content=json.dumps(book, ensure_ascii=False, indent=4),
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=lorebook.json; filename*=UTF-8''{quote(filename)}"},
    )


@app.put("/api/lorebooks/bindings")
async def save_lorebook_bindings(payload: LorebookBindingPayload, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_lorebooks")
    bindings = lorebooks_service.save_bindings(payload.bindings)
    await _broadcast_shared_settings("lorebooks")
    await _broadcast_notification("обновил привязки лорбуков", actor=_actor_from_request(request))
    return {"bindings": [binding.model_dump(mode="json") for binding in bindings]}


@app.get("/api/cards")
async def list_character_cards(request: Request) -> dict[str, object]:
    _require_permission(request, "view_cards")
    return {"cards": [card.model_dump(mode="json") for card in character_cards_service.list_cards()]}


@app.post("/api/cards/import")
async def import_character_card(request: Request, file: UploadFile = File(...)) -> dict[str, object]:
    _require_permission(request, "edit_cards")
    if not file.filename or not file.filename.lower().endswith((".png", ".json")):
        raise HTTPException(status_code=400, detail="Only PNG or JSON character cards are supported")
    try:
        card = character_cards_service.import_card(file.filename, await file.read())
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    imported_regex_scripts: list[dict[str, Any]] = []
    try:
        card_data = character_cards_service.card_data(card.id)
        char_book = card_data.get("character_book")
        if isinstance(char_book, dict) and char_book.get("entries"):
            book_name = str(char_book.get("name") or f"{card.name}_Lorebook").strip()
            saved_book = lorebooks_service.save_book(LorebookPayload(name=book_name, book=char_book))
            existing_bindings = lorebooks_service.bindings()
            if not any(b.book == saved_book.name and b.target_type == "card" and b.target_id == card.id for b in existing_bindings):
                from backend.app.services.lorebooks_service import LorebookBinding
                lorebooks_service.save_bindings([*existing_bindings, LorebookBinding(book=saved_book.name, target_type="card", target_id=card.id)])
                await _broadcast_shared_settings("lorebooks")
        ext_data = card_data.get("extensions")
        if isinstance(ext_data, dict) and isinstance(ext_data.get("regex_scripts"), list):
            imported_regex_scripts = [item for item in ext_data["regex_scripts"] if isinstance(item, dict)]
            if imported_regex_scripts:
                ext_settings = extensions_service.get_settings()
                regex_store = ext_settings.get("__dt_regex_store") if isinstance(ext_settings.get("__dt_regex_store"), dict) else {}
                scoped_map = dict(regex_store.get("scoped")) if isinstance(regex_store.get("scoped"), dict) else {}
                scoped_map[card.id] = imported_regex_scripts
                allowed_list = list(regex_store.get("scopedAllowed")) if isinstance(regex_store.get("scopedAllowed"), list) else []
                if card.id not in allowed_list:
                    allowed_list.append(card.id)
                extensions_service.save_settings({"__dt_regex_store": {**regex_store, "scoped": scoped_map, "scopedAllowed": allowed_list}}, merge=True)
                await _broadcast_shared_settings("extension_settings")
    except Exception:
        pass
    await _broadcast_shared_settings("cards")
    await _broadcast_notification(f"импортировал карточку: {card.name}", actor=_actor_from_request(request))
    return {"card": card.model_dump(mode="json"), "regex_scripts": imported_regex_scripts}

@app.post("/api/cards")
async def create_character_card(
    http_request: Request,
    name: str = Form(...),
    description: str = Form(""),
    personality: str = Form(""),
    scenario: str = Form(""),
    first_message: str = Form(""),
    alternate_greetings: list[str] = Form(default=[]),
    message_example: str = Form(""),
    creator: str = Form(""),
    tags: str = Form(""),
    avatar: UploadFile | None = File(None),
) -> dict[str, object]:
    _require_permission(http_request, "edit_cards")
    payload = CharacterCardCreate(
        name=name,
        description=description,
        personality=personality,
        scenario=scenario,
        first_message=first_message,
        alternate_greetings=alternate_greetings,
        message_example=message_example,
        creator=creator,
        tags=[tag.strip() for tag in tags.split(",") if tag.strip()],
    )
    avatar_content = await avatar.read() if avatar and avatar.filename else None
    try:
        card = character_cards_service.create_card(payload, avatar_content)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_shared_settings("cards")
    await _broadcast_notification(f"создал карточку: {card.name}", actor=_actor_from_request(http_request))
    return {"card": card.model_dump(mode="json")}


@app.put("/api/cards/{card_id}")
async def update_character_card(card_id: str, payload: CharacterCardUpdate, request: Request) -> dict[str, object]:
    _require_permission(request, "edit_cards")
    try:
        card = character_cards_service.update_card(card_id, payload)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Card not found") from error
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    for chat_summary in bot_chats_service.list_chats(card_id):
        chat = bot_chats_service.get_chat(card_id, chat_summary.id)
        if not any(message.role == "user" for message in chat.messages):
            updated_chat = _ensure_card_first_message(card_id, chat.id)
            await _broadcast_chat(card_id, updated_chat.id)
    await _broadcast_shared_settings("cards")
    await _broadcast_notification(f"обновил карточку: {card.name}", actor=_actor_from_request(request))
    return {"card": card.model_dump(mode="json")}


@app.post("/api/cards/{card_id}/avatar")
async def update_character_card_avatar(card_id: str, request: Request, file: UploadFile = File(...)) -> dict[str, object]:
    _require_permission(request, "edit_cards")
    if not file.filename or not file.filename.lower().endswith(".png"):
        raise HTTPException(status_code=400, detail="Only PNG avatar files are supported")
    try:
        card = character_cards_service.update_card_avatar(card_id, await file.read())
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Card not found") from error
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_shared_settings("cards")
    await _broadcast_notification(f"обновил аватар карточки: {card.name}", actor=_actor_from_request(request))
    return {"card": card.model_dump(mode="json")}


@app.delete("/api/cards/{card_id}")
async def delete_character_card(card_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "delete_cards")
    _require_delete_unlocked("cards", card_id)
    _require_card_chats_unlocked(card_id)
    try:
        card = character_cards_service.delete_card(card_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Card not found") from error
    bot_chats_service.delete_card_chats(card_id)
    settings_service.clear_delete_lock("cards", card_id)
    settings_service.clear_chat_locks_for_card(card_id)
    await connection_manager.broadcast(DEFAULT_SESSION_ID, {"type": "card.deleted", "card_id": card_id})
    await _broadcast_delete_locks()
    await _broadcast_notification(f"удалил карточку: {card.name}", actor=_actor_from_request(request))
    return {"ok": True, "card": card.model_dump(mode="json")}


@app.get("/api/cards/{card_id}/chats")
async def list_bot_chats(card_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "view_chats")
    return {"chats": [chat.model_dump(mode="json") for chat in bot_chats_service.list_chats(card_id)]}


@app.post("/api/cards/{card_id}/chats/current")
async def current_bot_chat(card_id: str, request: ChatCreate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "view_chats")
    sid = _session_id_from_request(http_request)
    chat = bot_chats_service.current_or_create(card_id, request.character_name)
    chat = _ensure_card_first_message(card_id, chat.id)
    session_service.set_active_chat(sid, card_id, chat.id)
    return {"chat": chat.model_dump(mode="json")}


@app.post("/api/cards/{card_id}/chats")
async def create_bot_chat(card_id: str, request: ChatCreate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "manage_chats")
    sid = _session_id_from_request(http_request)
    chat = bot_chats_service.create_chat(card_id, request)
    chat = _ensure_card_first_message(card_id, chat.id)
    await _broadcast_chat(card_id, chat.id, switch_active=True, session_id=sid)
    return {"chat": chat.model_dump(mode="json")}

@app.get("/api/cards/{card_id}/chats/{chat_id}")
async def get_bot_chat(card_id: str, chat_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "view_chats")
    try:
        chat = _ensure_card_first_message(card_id, chat_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    return {"chat": chat.model_dump(mode="json")}


@app.put("/api/cards/{card_id}/chats/{chat_id}")
async def update_bot_chat(card_id: str, chat_id: str, request: ChatUpdate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "manage_chats")
    sid = _session_id_from_request(http_request)
    try:
        chat = bot_chats_service.update_chat(card_id, chat_id, request)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    await _broadcast_chat(card_id, chat_id, session_id=sid)
    return {"chat": chat.model_dump(mode="json")}

@app.post("/api/cards/{card_id}/chats/{chat_id}/copy")
async def copy_bot_chat(card_id: str, chat_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_chats")
    sid = _session_id_from_request(request)
    try:
        chat = bot_chats_service.copy_chat(card_id, chat_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    await _broadcast_chat(card_id, chat.id, switch_active=True, session_id=sid)
    return {"chat": chat.model_dump(mode="json")}


@app.post("/api/cards/{card_id}/chats/{chat_id}/branch")
async def branch_bot_chat(card_id: str, chat_id: str, payload: ChatBranchRequest, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_chats")
    sid = _session_id_from_request(request)
    try:
        chat = bot_chats_service.branch_chat(card_id, chat_id, payload.up_to_message_id, payload.title)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Message not found") from error
    await _broadcast_chat(card_id, chat.id, switch_active=True, session_id=sid)
    await _broadcast_notification(f"создал ветку сюжета: {chat.title}", session_id=sid, actor=_actor_from_request(request))
    return {"chat": chat.model_dump(mode="json")}

@app.delete("/api/cards/{card_id}/chats/{chat_id}")
async def delete_bot_chat(card_id: str, chat_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_chats")
    sid = _session_id_from_request(request)
    _require_delete_unlocked("chats", _chat_lock_key(card_id, chat_id))
    try:
        bot_chats_service.delete_chat(card_id, chat_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    settings_service.clear_delete_lock("chats", _chat_lock_key(card_id, chat_id))
    for target_sid in _target_sessions_for_chat(card_id, chat_id, sid, False):
        await connection_manager.broadcast(target_sid, {"type": "chat.deleted", "card_id": card_id, "chat_id": chat_id})
    await _broadcast_delete_locks()
    return {"ok": True}


@app.get("/api/cards/{card_id}/chats/{chat_id}/export/sillytavern")
async def export_bot_chat_sillytavern(card_id: str, chat_id: str, request: Request) -> Response:
    _require_permission(request, "view_chats")
    try:
        content = bot_chats_service.export_sillytavern_jsonl(card_id, chat_id)
        filename = bot_chats_service.sillytavern_export_filename(card_id, chat_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    return Response(
        content=content,
        media_type="application/jsonl; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=chat.jsonl; filename*=UTF-8''{quote(filename)}"},
    )


@app.post("/api/cards/{card_id}/chats/import")
async def import_bot_chat_sillytavern(card_id: str, request: Request, file: UploadFile = File(...)) -> dict[str, object]:
    _require_permission(request, "manage_chats")
    if not file.filename or not file.filename.lower().endswith((".jsonl", ".json")):
        raise HTTPException(status_code=400, detail="Only .jsonl or .json chat files are supported")
    try:
        card_data = character_cards_service.card_data(card_id)
        char_name = str(card_data.get("name") or "Character")
    except FileNotFoundError:
        char_name = "Character"
    try:
        raw_text = (await file.read()).decode("utf-8-sig")
        chat = bot_chats_service.import_sillytavern_chat(card_id, char_name, file.filename, raw_text)
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    sid = _session_id_from_request(request)
    await _broadcast_chat(card_id, chat.id, switch_active=True, session_id=sid)
    await _broadcast_notification(f"импортировал чат: {chat.title}", session_id=sid, actor=_actor_from_request(request))
    return {"chat": chat.model_dump(mode="json")}
@app.post("/api/cards/{card_id}/chats/{chat_id}/messages")
async def add_bot_chat_message(card_id: str, chat_id: str, request: ChatMessageCreate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "edit_messages")
    sid = _session_id_from_request(http_request)
    raw_trimmed = request.content.strip()
    try:
        if re.match(r"^/(?:roll|r)\b", raw_trimmed, flags=re.IGNORECASE):
            formula_part = re.sub(r"^/(?:roll|r)\s*", "", raw_trimmed, flags=re.IGNORECASE).strip() or "1d20"
            chat = bot_chats_service.roll_dice_message(
                card_id,
                chat_id,
                ChatDiceRollRequest(
                    author=request.author,
                    participant_id=request.participant_id,
                    avatar_url=request.avatar_url,
                    username=request.username,
                    is_admin=request.is_admin,
                    formula=formula_part,
                ),
            )
        else:
            chat = bot_chats_service.add_message(card_id, chat_id, request)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    last_msg = chat.messages[-1] if chat.messages else None
    all_ready = False
    if request.participant_id:
        if not (last_msg and last_msg.is_ooc):
            all_ready = session_service.advance_turn(sid, request.participant_id)
        await connection_manager.broadcast(
            sid,
            {"type": "typing.updated", "participant_id": request.participant_id, "name": request.author, "is_typing": False},
        )
        await _broadcast_presence(sid)
    await _broadcast_chat(card_id, chat_id, session_id=sid)
    if all_ready:
        await connection_manager.broadcast(
            sid,
            {"type": "round.all_ready", "card_id": card_id, "chat_id": chat_id, "trigger_participant_id": request.participant_id},
        )
    return {"chat": chat.model_dump(mode="json"), "all_ready": all_ready}


@app.post("/api/cards/{card_id}/chats/{chat_id}/roll")
async def roll_bot_chat_dice(card_id: str, chat_id: str, request: ChatDiceRollRequest, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "edit_messages")
    sid = _session_id_from_request(http_request)
    try:
        chat = bot_chats_service.roll_dice_message(card_id, chat_id, request)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    all_ready = False
    if request.participant_id:
        all_ready = session_service.advance_turn(sid, request.participant_id)
        await _broadcast_presence(sid)
    await _broadcast_chat(card_id, chat_id, session_id=sid)
    if all_ready:
        await connection_manager.broadcast(
            sid,
            {"type": "round.all_ready", "card_id": card_id, "chat_id": chat_id, "trigger_participant_id": request.participant_id},
        )
    return {"chat": chat.model_dump(mode="json"), "all_ready": all_ready}

@app.put("/api/cards/{card_id}/chats/{chat_id}/messages/{message_id}")
async def update_bot_chat_message(card_id: str, chat_id: str, message_id: str, request: ChatMessageUpdate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "edit_messages")
    try:
        chat = bot_chats_service.update_message(card_id, chat_id, message_id, request)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Message not found") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_chat(card_id, chat_id, session_id=_session_id_from_request(http_request))
    return {"chat": chat.model_dump(mode="json")}


@app.delete("/api/cards/{card_id}/chats/{chat_id}/messages/{message_id}")
async def delete_bot_chat_message(card_id: str, chat_id: str, message_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "delete_messages")
    try:
        chat = bot_chats_service.delete_message(card_id, chat_id, message_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Message not found") from error
    await _broadcast_chat(card_id, chat_id, session_id=_session_id_from_request(request))
    return {"chat": chat.model_dump(mode="json")}


@app.post("/api/cards/{card_id}/chats/{chat_id}/messages/{message_id}/swipe")
async def swipe_bot_chat_message(card_id: str, chat_id: str, message_id: str, request: ChatSwipeRequest, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "edit_messages")
    try:
        chat = bot_chats_service.swipe_bot_message(card_id, chat_id, message_id, request.direction)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Message not found") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_chat(card_id, chat_id, session_id=_session_id_from_request(http_request))
    return {"chat": chat.model_dump(mode="json")}



@app.post("/api/cards/{card_id}/chats/{chat_id}/messages/{message_id}/vote")
async def vote_bot_chat_swipe(card_id: str, chat_id: str, message_id: str, request: ChatSwipeVoteRequest, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "view_chats")
    sid = _session_id_from_request(http_request)
    voter = request.voter.strip() or _actor_from_request(http_request) or "Player"
    try:
        chat = bot_chats_service.toggle_swipe_vote(card_id, chat_id, message_id, voter, request.swipe_index)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Message not found") from error
    await _broadcast_chat(card_id, chat_id, session_id=sid)
    return {"chat": chat.model_dump(mode="json")}


@app.put("/api/cards/{card_id}/chats/{chat_id}/hud")
async def update_bot_chat_hud(card_id: str, chat_id: str, payload: PartyHudState, request: Request) -> dict[str, object]:
    _require_permission(request, "edit_messages")
    sid = _session_id_from_request(request)
    try:
        chat = bot_chats_service.update_party_hud(card_id, chat_id, payload)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    await _broadcast_chat(card_id, chat_id, session_id=sid)
    return {"chat": chat.model_dump(mode="json")}


@app.put("/api/cards/{card_id}/chats/{chat_id}/memory")
async def update_bot_chat_memory(card_id: str, chat_id: str, payload: ChatMemoryUpdate, request: Request) -> dict[str, object]:
    _require_permission(request, "edit_messages")
    sid = _session_id_from_request(request)
    try:
        chat = bot_chats_service.update_chat_memory(card_id, chat_id, payload.memory_summary, payload.memory_summarized_count)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    await _broadcast_chat(card_id, chat_id, session_id=sid)
    return {"chat": chat.model_dump(mode="json")}


async def _summarize_chat_now(card_id: str, chat_id: str, session_id: str = DEFAULT_SESSION_ID, force_full: bool = False) -> object:
    chat = bot_chats_service.get_chat(card_id, chat_id)
    mem_cfg = settings_service.summary_memory_config()
    visible_msgs = [m for m in chat.messages if not m.hidden and not getattr(m, "is_ooc", False)]
    start_idx = 0 if force_full else min(chat.memory_summarized_count, len(visible_msgs))
    slice_to_summarize = visible_msgs[start_idx:]
    if not slice_to_summarize and not force_full:
        slice_to_summarize = visible_msgs[-min(len(visible_msgs), max(4, mem_cfg.every_n_messages)):]
        existing = ""
    else:
        existing = "" if force_full else chat.memory_summary
    new_summary = await generation_service.generate_chat_summary(mem_cfg, existing, slice_to_summarize, chat.character_name)
    if new_summary:
        chat = bot_chats_service.update_chat_memory(card_id, chat_id, new_summary, len(visible_msgs))
        await _broadcast_chat(card_id, chat_id, session_id=session_id)
    return chat


@app.post("/api/cards/{card_id}/chats/{chat_id}/memory/summarize")
async def summarize_bot_chat_memory(card_id: str, chat_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "generate")
    sid = _session_id_from_request(request)
    try:
        chat = await _summarize_chat_now(card_id, chat_id, session_id=sid, force_full=False)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Summary generation failed: {error}") from error
    await _broadcast_notification("обновил хронику памяти чата (саммари)", session_id=sid, actor=_actor_from_request(request))
    return {"chat": chat.model_dump(mode="json")}

@app.post("/api/cards/{card_id}/chats/{chat_id}/bot/reply")
async def request_card_bot_reply(card_id: str, chat_id: str, http_request: Request, request: BotReplyRequest | None = None) -> dict[str, object]:
    _require_permission(http_request, "generate")
    sid = _session_id_from_request(http_request)
    req_user = _auth_user_from_request(http_request)
    if not settings_service.bot_reply_allowed() and not (req_user and req_user.is_admin) and not (request and request.replace_message_id):
        raise HTTPException(status_code=403, detail="Bot reply button is disabled")
    task_key = f"{card_id}:{chat_id}"
    if task_key in generation_tasks:
        raise HTTPException(status_code=409, detail="Generation is already running")
    try:
        chat = bot_chats_service.get_chat(card_id, chat_id)
        replace_message_id = request.replace_message_id if request else None
        reset_swipes = bool(request.reset_swipes) if request else False
        history = chat.messages
        if replace_message_id:
            target_index = next((index for index, message in enumerate(chat.messages) if message.id == replace_message_id and message.role == "assistant"), -1)
            if target_index < 0:
                raise KeyError(replace_message_id)
            history = chat.messages[:target_index]
        openai_preset = request.openai_preset if (request and isinstance(request.openai_preset, dict) and request.openai_preset) else _active_openai_preset()
        character_data = character_cards_service.card_data(card_id)
        persona_name, persona_description, multi_user_mode, persona_ids = _generation_persona_context(request, history)
        regex_scripts = request.regex_scripts if request else []
        user_name = persona_name or "Player"
        char_name = chat.character_name or "Bot"
        if regex_scripts:
            total_hist = len(history)
            history = [
                message.model_copy(update={"content": RegexService.get_regexed_string(
                    message.content,
                    RegexService.PLACEMENT_USER_INPUT if message.role == "user" else RegexService.PLACEMENT_AI_OUTPUT,
                    regex_scripts,
                    is_prompt=True,
                    depth=total_hist - 1 - idx,
                    user_name=user_name,
                    char_name=char_name,
                )})
                for idx, message in enumerate(history)
            ]
        char_book = character_data.get("character_book") if isinstance(character_data.get("character_book"), dict) else None
        lorebook_context = lorebooks_service.active_context([message.content for message in history if not message.hidden and not getattr(message, "is_ooc", False)], card_id, chat_id, persona_ids, character_book=char_book)
        if regex_scripts:
            lorebook_context = lorebook_context.model_copy(update={
                "worldInfoBefore": RegexService.get_regexed_string(lorebook_context.worldInfoBefore, RegexService.PLACEMENT_WORLD_INFO, regex_scripts, is_prompt=True, user_name=user_name, char_name=char_name),
                "worldInfoAfter": RegexService.get_regexed_string(lorebook_context.worldInfoAfter, RegexService.PLACEMENT_WORLD_INFO, regex_scripts, is_prompt=True, user_name=user_name, char_name=char_name),
                "depthPrompts": [
                    {
                        **dp,
                        "content": RegexService.get_regexed_string(str(dp.get("content", "")), RegexService.PLACEMENT_WORLD_INFO, regex_scripts, is_prompt=True, user_name=user_name, char_name=char_name),
                    }
                    for dp in lorebook_context.depthPrompts
                ],
            })
        world_info_payload = lorebook_context.model_dump(mode="json")
        extra_before: list[str] = []
        mem_cfg = settings_service.summary_memory_config()
        if mem_cfg.enabled and chat.memory_summary.strip():
            extra_before.append(f"[Story Chronicle / Memory so far:\n{chat.memory_summary.strip()}]")
        if chat.party_hud and chat.party_hud.enabled:
            hud = chat.party_hud
            hud_lines = ["[Current Party State (HUD):"]
            if hud.location.strip():
                hud_lines.append(f"- Location: {hud.location.strip()}")
            if hud.time_of_day.strip():
                hud_lines.append(f"- Time: {hud.time_of_day.strip()}")
            if hud.quest.strip():
                hud_lines.append(f"- Active Quest/Goal: {hud.quest.strip()}")
            if hud.notes.strip():
                hud_lines.append(f"- Notes: {hud.notes.strip()}")
            for pl in hud.players:
                if pl.name.strip():
                    details = ", ".join(p for p in [f"HP: {pl.hp}" if pl.hp else "", f"Status: {pl.status}" if pl.status else "", f"Inventory: {pl.inventory}" if pl.inventory else ""] if p)
                    hud_lines.append(f"- {pl.name.strip()}: {details or 'Active'}")
            hud_lines.append("]")
            if len(hud_lines) > 2:
                extra_before.append("\n".join(hud_lines))
        if extra_before:
            existing_wb = str(world_info_payload.get("worldInfoBefore") or "").strip()
            world_info_payload["worldInfoBefore"] = ("\n\n".join([*extra_before, existing_wb]) if existing_wb else "\n\n".join(extra_before))
        if request and request.extension_prompts:
            world_info_payload["extensionPrompts"] = request.extension_prompts
        sid = _session_id_from_request(http_request)
        session_service.reset_round_ready(sid)
        await _broadcast_presence(sid)

        last_stream_broadcast_at = 0.0

        async def broadcast_stream(content: str) -> None:
            nonlocal last_stream_broadcast_at
            now = time.monotonic()
            if now - last_stream_broadcast_at < 0.032:
                return
            last_stream_broadcast_at = now
            await _broadcast_generation_state(card_id, chat_id, "generation.stream", content, replace_message_id, session_id=sid)

        streaming_enabled = generation_service.should_stream_chat_reply(openai_preset)
        if streaming_enabled:
            task = asyncio.create_task(generation_service.generate_chat_reply_stream(chat.character_name, history, openai_preset, character_data, persona_name, persona_description, world_info_payload, multi_user_mode, broadcast_stream))
        else:
            task = asyncio.create_task(generation_service.generate_chat_reply(chat.character_name, history, openai_preset, character_data, persona_name, persona_description, world_info_payload, multi_user_mode))
        generation_tasks[task_key] = task
        await _broadcast_generation_state(card_id, chat_id, "generation.started", replace_message_id=replace_message_id, streaming=streaming_enabled, session_id=sid)
        reply = await task
        if streaming_enabled:
            await _broadcast_generation_state(card_id, chat_id, "generation.stream", reply, replace_message_id, session_id=sid)
        if regex_scripts:
            reply = RegexService.get_regexed_string(reply, RegexService.PLACEMENT_AI_OUTPUT, regex_scripts, is_prompt=False, user_name=user_name, char_name=char_name)
        if chat.party_hud and chat.party_hud.enabled:
            hud_matches = list(re.finditer(r"\[HUD:\s*([^\]]+)\]", reply, flags=re.IGNORECASE))
            if hud_matches:
                hud_copy = chat.party_hud.model_copy(deep=True)
                for hm in hud_matches:
                    for kv in hm.group(1).split("|"):
                        if "=" in kv:
                            k, v = [s.strip() for s in kv.split("=", 1)]
                            kl = k.lower()
                            if kl in {"location", "локация"}:
                                hud_copy.location = v
                            elif kl in {"time", "time_of_day", "время"}:
                                hud_copy.time_of_day = v
                            elif kl in {"quest", "квест", "цель"}:
                                hud_copy.quest = v
                            elif kl in {"notes", "заметки"}:
                                hud_copy.notes = v
                bot_chats_service.update_party_hud(card_id, chat_id, hud_copy)
                reply = re.sub(r"\[HUD:\s*[^\]]+\]\s*", "", reply, flags=re.IGNORECASE).strip() or reply
        avatar_url = _card_avatar_url(card_id)
        if replace_message_id:
            chat = bot_chats_service.replace_bot_message(card_id, chat_id, replace_message_id, chat.character_name, reply, avatar_url, reset_swipes)
        else:
            chat = bot_chats_service.add_bot_message(card_id, chat_id, chat.character_name, reply, avatar_url)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Message not found") from error
    except asyncio.CancelledError as error:
        await _broadcast_generation_state(card_id, chat_id, "generation.cancelled", "Генерация отменена", replace_message_id, session_id=sid)
        raise HTTPException(status_code=499, detail="Generation cancelled") from error
    except httpx.ReadTimeout as error:
        message = "Provider did not finish the response in time. Increase timeout or reduce max tokens/context."
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id, session_id=sid)
        raise HTTPException(status_code=504, detail=message) from error
    except httpx.RemoteProtocolError as error:
        message = f"Provider closed the connection before sending a response: {error}"
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id, session_id=sid)
        raise HTTPException(status_code=502, detail=message) from error
    except httpx.HTTPStatusError as error:
        try:
            response_text = error.response.text
        except httpx.ResponseNotRead:
            response_text = "<streaming response body was not read>"
        message = f"Provider returned {error.response.status_code}: {response_text}"
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id, session_id=sid)
        raise HTTPException(status_code=502, detail=message) from error
    except httpx.HTTPError as error:
        message = f"Provider request failed: {error}"
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id, session_id=sid)
        raise HTTPException(status_code=502, detail=message) from error
    except RuntimeError as error:
        message = str(error)
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id, session_id=sid)
        raise HTTPException(status_code=400, detail=message) from error
    finally:
        generation_tasks.pop(task_key, None)
    await _broadcast_chat(card_id, chat_id, session_id=sid)
    await _broadcast_generation_state(card_id, chat_id, "generation.finished", replace_message_id=replace_message_id, session_id=sid)
    mem_cfg = settings_service.summary_memory_config()
    if mem_cfg.enabled and mem_cfg.auto_summarize:
        visible_count = len([m for m in chat.messages if not m.hidden and not getattr(m, "is_ooc", False)])
        if visible_count - chat.memory_summarized_count >= max(2, mem_cfg.every_n_messages):
            async def _bg_summarize() -> None:
                try:
                    await _summarize_chat_now(card_id, chat_id, session_id=sid, force_full=False)
                    await _broadcast_notification("📜 память чата автоматически обновлена (авто-саммари)", session_id=sid)
                except Exception as exc:
                    logging.getLogger(__name__).warning("Auto-summarize failed: %s", exc)
            asyncio.create_task(_bg_summarize())
    return {"chat": chat.model_dump(mode="json")}


@app.post("/api/cards/{card_id}/chats/{chat_id}/bot/cancel")
async def cancel_card_bot_reply(card_id: str, chat_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "generate")
    sid = _session_id_from_request(request)
    task = generation_tasks.get(f"{card_id}:{chat_id}")
    if task and not task.done():
        task.cancel()
        await _broadcast_generation_state(card_id, chat_id, "generation.cancelled", "Генерация отменяется", session_id=sid)
        return {"cancelled": True}
    return {"cancelled": False}


@app.get("/api/cards/{card_id}/image")
async def character_card_image(card_id: str, request: Request) -> FileResponse:
    _require_permission(request, "view_cards")
    try:
        path = character_cards_service.image_path(card_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Card image not found") from error
    return FileResponse(path, media_type="image/png")


@app.get("/api/personas")
async def list_personas(request: Request) -> dict[str, object]:
    _require_permission(request, "view_personas")
    user = _auth_user_from_request(request)
    owner = user.username if user else ""
    is_admin = bool(user and user.is_admin)
    return {"personas": [persona.model_dump(mode="json") for persona in personas_service.list_personas(owner=owner, is_admin=is_admin)]}


@app.post("/api/personas")
async def create_persona(payload: PersonaCreate, request: Request) -> dict[str, object]:
    _require_permission(request, "edit_personas")
    user = _auth_user_from_request(request)
    persona = personas_service.create_persona(payload, owner=user.username if user else "")
    await _broadcast_shared_settings("personas")
    return {"persona": persona.model_dump(mode="json")}


@app.put("/api/personas/{persona_id}")
async def update_persona(persona_id: str, payload: PersonaUpdate, request: Request) -> dict[str, object]:
    _require_permission(request, "edit_personas")
    user = _auth_user_from_request(request)
    try:
        persona = personas_service.update_persona(persona_id, payload, owner=user.username if user else "", is_admin=bool(user and user.is_admin))
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Persona not found") from error
    await _broadcast_shared_settings("personas")
    return {"persona": persona.model_dump(mode="json")}


@app.delete("/api/personas/{persona_id}")
async def delete_persona(persona_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "delete_personas")
    _require_delete_unlocked("personas", persona_id)
    user = _auth_user_from_request(request)
    try:
        persona = personas_service.delete_persona(persona_id, owner=user.username if user else "", is_admin=bool(user and user.is_admin))
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Persona not found") from error
    settings_service.clear_delete_lock("personas", persona_id)
    await _broadcast_delete_locks()
    await _broadcast_shared_settings("personas")
    return {"ok": True, "persona": persona.model_dump(mode="json")}


@app.put("/api/personas/{persona_id}/active")
async def activate_persona(persona_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "edit_personas")
    user = _auth_user_from_request(request)
    try:
        persona = personas_service.activate_persona(persona_id, owner=user.username if user else "")
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Persona not found") from error
    await _broadcast_shared_settings("personas")
    return {"persona": persona.model_dump(mode="json")}
@app.post("/api/personas/{persona_id}/avatar")
async def upload_persona_avatar(persona_id: str, request: Request, file: UploadFile = File(...)) -> dict[str, object]:
    _require_permission(request, "edit_personas")
    if not file.filename:
        raise HTTPException(status_code=400, detail="Avatar file is required")
    try:
        persona = personas_service.set_avatar(persona_id, file.filename, await file.read())
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Persona not found") from error
    await _broadcast_shared_settings("personas")
    await _broadcast_notification(f"обновил аватар персоны: {persona.name}", actor=_actor_from_request(request))
    return {"persona": persona.model_dump(mode="json")}


@app.get("/api/personas/avatars/{filename}")
@app.head("/api/personas/avatars/{filename}")
async def persona_avatar(filename: str, request: Request) -> FileResponse:
    _require_permission(request, "view_personas")
    try:
        path = personas_service.avatar_path(filename)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Persona avatar not found") from error
    return FileResponse(path)


@app.post("/api/sessions/{session_id}/bot/reply")
async def request_bot_reply(session_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "generate")
    try:
        message = await generation_service.generate_reply(session_id)
    except httpx.HTTPStatusError as error:
        raise HTTPException(status_code=502, detail=f"Provider returned {error.response.status_code}: {error.response.text}") from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail=f"Provider request failed: {error}") from error
    except RuntimeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await connection_manager.broadcast(
        session_id,
        {"type": "session.updated", "session": session_service.snapshot(session_id), "message": message.model_dump(mode="json")},
    )
    return {"message": message.model_dump(mode="json")}


def _token_from_websocket(websocket: WebSocket) -> str:
    authorization = websocket.headers.get("authorization", "")
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return str(websocket.cookies.get("doubletrouble_auth_token") or "").strip() or str(websocket.query_params.get("auth") or "").strip()


def _require_websocket_auth(websocket: WebSocket) -> None:
    token = _token_from_websocket(websocket)
    user = auth_service.user_by_token(token)
    if settings_service.access_password_required():
        access_token = (
            websocket.headers.get("x-doubletrouble-access", "").strip()
            or str(websocket.query_params.get("access_token") or "").strip()
            or str(websocket.cookies.get("doubletrouble_access") or "").strip()
        )
        if not settings_service.verify_access_token(access_token):
            raise HTTPException(status_code=403, detail="Access password required")
    if settings_service.auth_required() and not user:
        raise HTTPException(status_code=401, detail="Authentication required")


@app.websocket("/ws/sessions/{session_id}")
async def session_websocket(websocket: WebSocket, session_id: str) -> None:
    await connection_manager.connect(session_id, websocket)
    try:
        _require_websocket_auth(websocket)
    except HTTPException:
        await websocket.close(code=1008)
        connection_manager.disconnect(session_id, websocket)
        return
    participant_id: str | None = None
    try:
        session_service.prune_disconnected(session_id, connection_manager.active_participant_ids(session_id))
        await websocket.send_json({
            "type": "session.snapshot",
            "session": session_service.snapshot(session_id),
            "active_generations": [key for key, task in generation_tasks.items() if not task.done()],
        })
        while True:
            raw_event = await websocket.receive_json()
            try:
                event = ClientEvent.model_validate(raw_event)
            except Exception:
                continue

            if event.type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if event.type in {"participant.join", "presence.update"}:
                ws_user = auth_service.user_by_token(_token_from_websocket(websocket))
                resolved_username = ws_user.username if ws_user else (event.username or "")
                resolved_is_admin = bool(ws_user.is_admin) if ws_user else bool(event.is_admin)
                incoming_pid = event.participant_id or participant_id
                participant = session_service.join_session(
                    session_id,
                    event.name or event.persona_name or "Player",
                    incoming_pid,
                    event.persona_id or "",
                    event.persona_name or "",
                    event.avatar_url or "",
                    resolved_username,
                    resolved_is_admin,
                )
                if incoming_pid and incoming_pid != participant.id:
                    connection_manager.rebind_participant(session_id, incoming_pid, participant.id)
                participant_id = participant.id
                connection_manager.bind_participant(session_id, websocket, participant.id)
                await _broadcast_presence(session_id)
            if event.type == "card.select" and event.name:
                if event.card_id:
                    session_service.set_active_chat(session_id, event.card_id, event.chat_id or "")
                    await connection_manager.broadcast(
                        session_id,
                        {
                            "type": "card.select",
                            "card_id": event.card_id,
                            "chat_id": event.chat_id or "",
                            "name": event.name,
                            "source_participant_id": event.participant_id or participant_id or "",
                        },
                    )
                actor = event.username or event.persona_name or event.name or ""
                await _broadcast_notification(f"выбрал карточку: {event.name}", session_id, actor)
            if event.type == "notification" and event.content:
                await _broadcast_notification(event.content, session_id, event.username or event.persona_name or event.name or "")

            if event.type == "typing.update" and (event.participant_id or participant_id):
                await connection_manager.broadcast(
                    session_id,
                    {
                        "type": "typing.updated",
                        "participant_id": event.participant_id or participant_id or "",
                        "name": event.persona_name or event.name or "Player",
                        "is_typing": bool(event.is_typing),
                    },
                )

            if event.type == "turn.mode" and event.turn_mode:
                session_service.set_turn_mode(session_id, event.turn_mode)
                await _broadcast_presence(session_id)

            if event.type == "turn.ready" and (event.participant_id or participant_id):
                pid = event.participant_id or participant_id or ""
                all_ready = session_service.mark_participant_ready(session_id, pid, ready=True if event.ready is None else bool(event.ready))
                await _broadcast_presence(session_id)
                if all_ready:
                    sess = session_service.get_or_create_session(session_id)
                    await connection_manager.broadcast(
                        session_id,
                        {"type": "round.all_ready", "card_id": event.card_id or sess.active_card_id, "chat_id": event.chat_id or sess.active_chat_id, "trigger_participant_id": pid},
                    )

            if event.type == "turn.pass" and (event.participant_id or participant_id):
                pid = event.participant_id or participant_id or ""
                all_ready = session_service.advance_turn(session_id, pid)
                await _broadcast_presence(session_id)
                if all_ready:
                    sess = session_service.get_or_create_session(session_id)
                    await connection_manager.broadcast(
                        session_id,
                        {"type": "round.all_ready", "card_id": event.card_id or sess.active_card_id, "chat_id": event.chat_id or sess.active_chat_id, "trigger_participant_id": pid},
                    )

            if event.type in {"image.pending", "image.done"}:
                await connection_manager.broadcast(
                    session_id,
                    {
                        "type": event.type,
                        "card_id": event.card_id,
                        "chat_id": event.chat_id,
                        "message_id": event.message_id,
                        "source_participant_id": event.source_participant_id or event.participant_id or "",
                    },
                )
            if event.type == "message.send" and event.participant_id and event.content:
                message = session_service.add_message(
                    session_id,
                    SendMessageRequest(participant_id=event.participant_id, content=event.content),
                )
                await connection_manager.broadcast(
                    session_id,
                    {"type": "session.updated", "session": session_service.snapshot(session_id), "message": message.model_dump(mode="json")},
                )
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        bound_pid = connection_manager.disconnect(session_id, websocket) or participant_id
        if bound_pid and not connection_manager.has_other_connections(session_id, bound_pid, websocket):
            session_service.disconnect_participant(session_id, bound_pid)
            await _broadcast_presence(session_id)

frontend_dist = PROJECT_ROOT / "frontend" / "dist"
if frontend_dist.exists():
    @app.get("/")
    @app.get("/index.html")
    async def serve_frontend_index(request: Request) -> Response:
        resp = Response(
            content=(frontend_dist / "index.html").read_bytes(),
            media_type="text/html; charset=utf-8",
        )
        _apply_cache_bust_headers(request, resp)
        return resp

    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
