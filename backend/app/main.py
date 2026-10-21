from __future__ import annotations

import base64
import json
import asyncio
import logging
import os
import re
import time

import httpx
from pathlib import Path
from urllib.parse import quote, urlparse

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from backend.app.config import DEFAULT_CONFIG_PATH, PROJECT_ROOT, ensure_admin_code, load_config
from backend.app.models import ClientEvent, JoinSessionRequest, SendMessageRequest
from pydantic import BaseModel, Field

from backend.app.services.bot_chats_service import BotChatsService, ChatCreate, ChatMessageCreate, ChatMessageUpdate, ChatSwipeRequest, ChatUpdate
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
from backend.app.services.settings_service import GenerationPresetSave, GenerationSettingsUpdate, SecuritySettingsPayload, SettingsService
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


async def _broadcast_chat(card_id: str, chat_id: str) -> None:
    session_service.set_active_chat(DEFAULT_SESSION_ID, card_id, chat_id)
    chat = bot_chats_service.get_chat(card_id, chat_id)
    await connection_manager.broadcast(
        DEFAULT_SESSION_ID,
        {"type": "chat.updated", "card_id": card_id, "chat": chat.model_dump(mode="json")},
    )

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
    avatar_url = next((card.image_url for card in character_cards_service.list_cards() if card.id == card_id), "")
    return bot_chats_service.add_bot_message(card_id, chat_id, chat.character_name, first_message, avatar_url, greeting_swipes)


async def _broadcast_generation_state(card_id: str, chat_id: str, event_type: str, message: str = "", replace_message_id: str | None = None, streaming: bool | None = None) -> None:
    event: dict[str, object] = {"type": event_type, "card_id": card_id, "chat_id": chat_id, "replace_message_id": replace_message_id}
    if message:
        event["message"] = message
    if streaming is not None:
        event["streaming"] = streaming
    await connection_manager.broadcast(DEFAULT_SESSION_ID, event)


async def _broadcast_presence(session_id: str = DEFAULT_SESSION_ID) -> None:
    await connection_manager.broadcast(
        session_id,
        {"type": "presence.updated", "session": session_service.snapshot(session_id)},
    )


def _actor_from_request(request: Request) -> str:
    actor = request.headers.get("x-doubletrouble-actor", "").strip()
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
    permissions = settings_service.security_permissions().model_dump()
    rule = permissions.get(action, {"mode": "everyone", "users": []})
    mode = str(rule.get("mode") or "everyone")
    allowed_users = {str(username).lower() for username in rule.get("users", []) if str(username).strip()}
    if mode == "everyone":
        return
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    if mode == "admins" and user.is_admin:
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


def _generation_persona_context(request: BotReplyRequest | None) -> tuple[str | None, str | None, bool, str]:
    if request is None:
        return None, None, False, ""
    known_personas = {persona.id: persona for persona in personas_service.list_personas()}
    participants: list[GenerationParticipantRequest] = list(request.participants or [])
    if request.persona_id or request.persona_name or request.persona_description:
        participants.append(
            GenerationParticipantRequest(
                persona_id=request.persona_id or "",
                persona_name=request.persona_name or "",
                persona_description=request.persona_description or "",
            )
        )

    by_key: dict[str, tuple[str, str]] = {}
    primary_name = (request.persona_name or "").strip() or None
    primary_id = (request.persona_id or "").strip()
    for participant in participants:
        stored = known_personas.get(participant.persona_id)
        name = (participant.persona_name or stored.name if stored else participant.persona_name).strip()
        description = (participant.persona_description or stored.description if stored else participant.persona_description).strip()
        if not name:
            continue
        key = participant.persona_id.strip() or participant.participant_id.strip() or name.lower()
        by_key[key] = (name, description)
        if primary_id and participant.persona_id == primary_id:
            primary_name = name

    personas = list(by_key.values())
    if not personas:
        return primary_name, (request.persona_description or "").strip() or None, False, primary_id
    if len(personas) == 1:
        return primary_name or personas[0][0], personas[0][1], False, primary_id
    combined = "Active player personas in this DoubleTrouble chat:\n" + "\n".join(
        f"- {name}: {description or 'No persona description provided.'}" for name, description in personas
    )
    return primary_name or " and ".join(name for name, _ in personas), combined, True, primary_id


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
    return {
        "world_names": [book.name for book in lorebooks_service.list_lorebooks()],
        "settings": settings_service.generation_settings(),
    }


@app.get("/api/extensions/discover")
async def discover_extensions() -> list[dict[str, str]]:
    return extensions_service.discover_enabled()


@app.get("/api/extensions")
async def list_extensions(request: Request) -> dict[str, object]:
    _require_permission(request, "manage_extensions")
    return {"extensions": [extension.model_dump(mode="json") for extension in extensions_service.list_extensions()]}


@app.post("/api/extensions/install")
async def install_extension(_payload: ExtensionInstallRequest, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_extensions")
    raise HTTPException(status_code=403, detail="Extension installation is temporarily disabled")


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
async def extension_asset(extension_path: str, request: Request) -> Response:
    _require_permission(request, "manage_extensions")
    if extension_path == "extensions.js":
        return await extension_compat_module()
    if extension_path == "regex/engine.js":
        return _compat_javascript("""
export const regex_placement = { RAW: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3 };
export const getRegexedString = (value) => String(value ?? '');
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
export const ModuleWorkerWrapper = class {};
export const renderExtensionTemplateAsync = async (extensionName, templateId) => {
  const response = await fetch(`/scripts/extensions/${extensionName}/${templateId}.html`);
  return response.ok ? await response.text() : '';
};
export const renderExtensionTemplate = () => '';
export const saveMetadataDebounced = () => {};
export const writeExtensionField = async () => {};
export const doExtrasFetch = (endpoint, args = {}) => fetch(endpoint, args);
""".strip()
    return Response(content=content, media_type="text/javascript; charset=utf-8")


def _compat_javascript(content: str) -> Response:
    return Response(content=content.strip(), media_type="text/javascript; charset=utf-8")


def _transparent_png() -> bytes:
    return base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=")


@app.get("/script.js")
async def script_compat_module() -> Response:
    content = """
const ctx = () => globalThis.SillyTavern?.getContext?.() || {};
export const eventSource = ctx().eventSource;
export const event_types = ctx().event_types || ctx().eventTypes || {};
export const saveSettingsDebounced = ctx().saveSettingsDebounced || (() => {});
export const saveSettings = saveSettingsDebounced;
export const getRequestHeaders = ctx().getRequestHeaders || (() => ({}));
export const messageFormatting = ctx().messageFormatting || ((text) => text);
export const saveChatConditional = ctx().saveChat || (async () => {});
export const chat = [];
export const characters = [];
export const personas = [];
export const chat_metadata = {};
export const extension_prompts = {};
const sync = () => {
  chat.splice(0, chat.length, ...(ctx().chat || []));
  characters.splice(0, characters.length, ...(ctx().characters || []));
  personas.splice(0, personas.length, ...(ctx().personas || []));
};
sync();
globalThis.setInterval?.(sync, 250);
export const name1 = ctx().name1 || 'User';
export const name2 = ctx().name2 || 'Char';
export const this_chid = ctx().characterId ?? 0;
export const user_avatar = ctx().selectedPersona?.avatar || '';
export const system_avatar = 'system.png';
export const default_avatar = 'default.png';
export const is_send_press = false;
export const main_api = 'openai';
export const online_status = 'connected';
export const MAX_INJECTION_DEPTH = 1000;
export const system_message_types = { NARRATOR: 'narrator', COMMENT: 'comment' };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const extension_prompt_types = { IN_CHAT: 0, BEFORE_PROMPT: 1, IN_PROMPT: 2, AFTER_PROMPT: 3 };
export const getCurrentChatId = () => 'default';
export const getThumbnailUrl = (_type, file) => file?.startsWith?.('/') ? file : `/api/personas/avatars/${encodeURIComponent(file || 'default.png')}`;
export const reloadMarkdownProcessor = () => ({ makeHtml: (text) => String(text ?? '') });
export const clearChat = async () => {};
export const printMessages = async () => {};
export const addOneMessage = async () => {};
export const getPastCharacterChats = async () => [];
export const showSwipeButtons = () => {};
export const substituteParams = (text) => String(text ?? '').replaceAll('{{user}}', ctx().name1 || 'User').replaceAll('{{char}}', ctx().name2 || 'Char');
export const substituteParamsExtended = substituteParams;
export const saveMetadata = async () => {};
export const saveCharacterDebounced = () => {};
export const getOneCharacter = (id) => characters[Number(id)] || characters[0] || null;
export const selectCharacterById = async () => {};
export const printCharacters = async () => {};
export const unshallowCharacter = async (character) => character;
export const deleteCharacter = async () => {};
export const getCharacters = async () => characters;
export const scrollChatToBottom = () => globalThis.scrollTo?.({ top: document.body.scrollHeight, behavior: 'smooth' });
export const reloadCurrentChat = async () => {};
export const activateSendButtons = () => {};
export const deactivateSendButtons = () => {};
export const setGenerationProgress = () => {};
export const setExtensionPrompt = (name, value) => { extension_prompts[name] = value; };
export const baseChatReplace = (text) => text;
export const getCharacterCardFields = () => ({});
export const getBiasStrings = () => [];
export const getExtensionPromptRoleByName = (role) => extension_prompt_roles[String(role).toUpperCase()] ?? extension_prompt_roles.SYSTEM;
export const getMaxContextSize = () => 8192;
export const getExtensionPromptByName = (name) => extension_prompts[name] || '';
export const cleanUpMessage = (text) => String(text ?? '');
export const isOdd = (value) => Number(value) % 2 !== 0;
export const countOccurrences = (text, value) => String(text ?? '').split(String(value ?? '')).length - 1;
export const stopGeneration = async () => {};
export const Generate = async () => '';
export default {};
""".strip()
    return Response(content=content, media_type="text/javascript; charset=utf-8")


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
export const slashCommandRegistry = new Map();
export const executeSlashCommandsWithOptions = async (text) => String(text ?? '');
""",
        "slash-commands/SlashCommand.js": """
export class SlashCommand { constructor(data = {}) { Object.assign(this, data); } static fromProps(data = {}) { return new SlashCommand(data); } }
""",
        "slash-commands/SlashCommandArgument.js": """
export const ARGUMENT_TYPE = { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', VARIABLE_NAME: 'variable_name' };
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
export const enumTypes = { enum: 'enum' };
export class SlashCommandEnumValue { constructor(value, description = '', type = enumTypes.enum, icon = '') { this.value = value; this.description = description || ''; this.type = type; this.icon = icon || ''; } }
""",
        "slash-commands/SlashCommandParser.js": """
export class SlashCommandParser { static addCommandObject(command) { globalThis.__dtSlashCommands ??= new Map(); globalThis.__dtSlashCommands.set(command?.name || command?.command || String(globalThis.__dtSlashCommands.size), command); } static parse(text) { return { command: String(text ?? ''), args: [] }; } }
""",
        "popup.js": """
export const POPUP_TYPE = { TEXT: 0, CONFIRM: 1, INPUT: 2, DISPLAY: 3 };
export const callGenericPopup = async (content, _type, _input, options = {}) => { if (options?.okButton) return true; return content; };
""",
        "tokenizers.js": "export const getTokenCountAsync = async (text) => Math.ceil(String(text ?? '').length / 4);",
    }
    if module_path in modules:
        return _compat_javascript(modules[module_path])
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
async def extension_file(filename: str, request: Request) -> FileResponse:
    path = storage.user_root / "user" / "files" / Path(filename).name
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path)


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
async def public_config() -> dict[str, object]:
    return {
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
async def get_security_config() -> dict[str, object]:
    return {
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
    await _broadcast_shared_settings("cards")
    await _broadcast_notification(f"импортировал карточку: {card.name}", actor=_actor_from_request(request))
    return {"card": card.model_dump(mode="json")}


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
    chat = bot_chats_service.current_or_create(card_id, request.character_name)
    chat = _ensure_card_first_message(card_id, chat.id)
    session_service.set_active_chat(DEFAULT_SESSION_ID, card_id, chat.id)
    return {"chat": chat.model_dump(mode="json")}


@app.post("/api/cards/{card_id}/chats")
async def create_bot_chat(card_id: str, request: ChatCreate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "manage_chats")
    chat = bot_chats_service.create_chat(card_id, request)
    chat = _ensure_card_first_message(card_id, chat.id)
    await _broadcast_chat(card_id, chat.id)
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
    try:
        chat = bot_chats_service.update_chat(card_id, chat_id, request)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    await _broadcast_chat(card_id, chat_id)
    return {"chat": chat.model_dump(mode="json")}


@app.post("/api/cards/{card_id}/chats/{chat_id}/copy")
async def copy_bot_chat(card_id: str, chat_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_chats")
    try:
        chat = bot_chats_service.copy_chat(card_id, chat_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    await _broadcast_chat(card_id, chat.id)
    return {"chat": chat.model_dump(mode="json")}


@app.delete("/api/cards/{card_id}/chats/{chat_id}")
async def delete_bot_chat(card_id: str, chat_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "manage_chats")
    _require_delete_unlocked("chats", _chat_lock_key(card_id, chat_id))
    try:
        bot_chats_service.delete_chat(card_id, chat_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    settings_service.clear_delete_lock("chats", _chat_lock_key(card_id, chat_id))
    await connection_manager.broadcast(DEFAULT_SESSION_ID, {"type": "chat.deleted", "card_id": card_id, "chat_id": chat_id})
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


@app.post("/api/cards/{card_id}/chats/{chat_id}/messages")
async def add_bot_chat_message(card_id: str, chat_id: str, request: ChatMessageCreate, http_request: Request) -> dict[str, object]:
    _require_permission(http_request, "edit_messages")
    try:
        chat = bot_chats_service.add_message(card_id, chat_id, request)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    await _broadcast_chat(card_id, chat_id)
    return {"chat": chat.model_dump(mode="json")}


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
    await _broadcast_chat(card_id, chat_id)
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
    await _broadcast_chat(card_id, chat_id)
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
    await _broadcast_chat(card_id, chat_id)
    return {"chat": chat.model_dump(mode="json")}


@app.post("/api/cards/{card_id}/chats/{chat_id}/bot/reply")
async def request_card_bot_reply(card_id: str, chat_id: str, http_request: Request, request: BotReplyRequest | None = None) -> dict[str, object]:
    _require_permission(http_request, "generate")
    if not settings_service.bot_reply_allowed() and not (request and request.replace_message_id):
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
        openai_preset = request.openai_preset if request and isinstance(request.openai_preset, dict) else _active_openai_preset()
        character_data = character_cards_service.card_data(card_id)
        persona_name, persona_description, multi_user_mode, persona_id = _generation_persona_context(request)
        regex_scripts = request.regex_scripts if request else []
        user_name = persona_name or "Player"
        char_name = chat.character_name or "Bot"
        if regex_scripts:
            history = [
                message.model_copy(update={"content": RegexService.get_regexed_string(message.content, RegexService.PLACEMENT_AI_OUTPUT, regex_scripts, is_prompt=True, user_name=user_name, char_name=char_name)})
                for message in history
            ]
        lorebook_context = lorebooks_service.active_context([message.content for message in history if not message.hidden], card_id, chat_id, persona_id or "")
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
        async def broadcast_stream(content: str) -> None:
            await _broadcast_generation_state(card_id, chat_id, "generation.stream", content, replace_message_id)

        streaming_enabled = generation_service.should_stream_chat_reply(openai_preset)
        if streaming_enabled:
            task = asyncio.create_task(generation_service.generate_chat_reply_stream(chat.character_name, history, openai_preset, character_data, persona_name, persona_description, lorebook_context.model_dump(mode="json"), multi_user_mode, broadcast_stream))
        else:
            task = asyncio.create_task(generation_service.generate_chat_reply(chat.character_name, history, openai_preset, character_data, persona_name, persona_description, lorebook_context.model_dump(mode="json"), multi_user_mode))
        generation_tasks[task_key] = task
        await _broadcast_generation_state(card_id, chat_id, "generation.started", replace_message_id=replace_message_id, streaming=streaming_enabled)
        reply = await task
        if streaming_enabled:
            await _broadcast_generation_state(card_id, chat_id, "generation.stream", reply, replace_message_id)
        if regex_scripts:
            reply = RegexService.get_regexed_string(reply, RegexService.PLACEMENT_AI_OUTPUT, regex_scripts, is_prompt=False, user_name=user_name, char_name=char_name)
        avatar_url = next((card.image_url for card in character_cards_service.list_cards() if card.id == card_id), "")
        if replace_message_id:
            chat = bot_chats_service.replace_bot_message(card_id, chat_id, replace_message_id, chat.character_name, reply, avatar_url, reset_swipes)
        else:
            chat = bot_chats_service.add_bot_message(card_id, chat_id, chat.character_name, reply, avatar_url)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Chat not found") from error
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Message not found") from error
    except asyncio.CancelledError as error:
        await _broadcast_generation_state(card_id, chat_id, "generation.cancelled", "Генерация отменена", replace_message_id)
        raise HTTPException(status_code=499, detail="Generation cancelled") from error
    except httpx.ReadTimeout as error:
        message = "Provider did not finish the response in time. Increase timeout or reduce max tokens/context."
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id)
        raise HTTPException(status_code=504, detail=message) from error
    except httpx.RemoteProtocolError as error:
        message = f"Provider closed the connection before sending a response: {error}"
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id)
        raise HTTPException(status_code=502, detail=message) from error
    except httpx.HTTPStatusError as error:
        try:
            response_text = error.response.text
        except httpx.ResponseNotRead:
            response_text = "<streaming response body was not read>"
        message = f"Provider returned {error.response.status_code}: {response_text}"
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id)
        raise HTTPException(status_code=502, detail=message) from error
    except httpx.HTTPError as error:
        message = f"Provider request failed: {error}"
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id)
        raise HTTPException(status_code=502, detail=message) from error
    except RuntimeError as error:
        message = str(error)
        await _broadcast_generation_state(card_id, chat_id, "generation.failed", message, replace_message_id)
        raise HTTPException(status_code=400, detail=message) from error
    finally:
        generation_tasks.pop(task_key, None)
    await _broadcast_chat(card_id, chat_id)
    await _broadcast_generation_state(card_id, chat_id, "generation.finished", replace_message_id=replace_message_id)
    return {"chat": chat.model_dump(mode="json")}


@app.post("/api/cards/{card_id}/chats/{chat_id}/bot/cancel")
async def cancel_card_bot_reply(card_id: str, chat_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "generate")
    task = generation_tasks.get(f"{card_id}:{chat_id}")
    if task and not task.done():
        task.cancel()
        await _broadcast_generation_state(card_id, chat_id, "generation.cancelled", "Генерация отменяется")
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
    return {"personas": [persona.model_dump(mode="json") for persona in personas_service.list_personas()]}


@app.post("/api/personas")
async def create_persona(payload: PersonaCreate, request: Request) -> dict[str, object]:
    _require_permission(request, "edit_personas")
    persona = personas_service.create_persona(payload)
    await _broadcast_shared_settings("personas")
    await _broadcast_notification(f"создал персону: {persona.name}", actor=_actor_from_request(request))
    return {"persona": persona.model_dump(mode="json")}


@app.put("/api/personas/{persona_id}")
async def update_persona(persona_id: str, payload: PersonaUpdate, request: Request) -> dict[str, object]:
    _require_permission(request, "edit_personas")
    try:
        persona = personas_service.update_persona(persona_id, payload)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Persona not found") from error
    await _broadcast_shared_settings("personas")
    await _broadcast_notification(f"обновил персону: {persona.name}", actor=_actor_from_request(request))
    return {"persona": persona.model_dump(mode="json")}


@app.delete("/api/personas/{persona_id}")
async def delete_persona(persona_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "delete_personas")
    _require_delete_unlocked("personas", persona_id)
    try:
        persona = personas_service.delete_persona(persona_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Persona not found") from error
    settings_service.clear_delete_lock("personas", persona_id)
    await _broadcast_delete_locks()
    await _broadcast_shared_settings("personas")
    await _broadcast_notification(f"удалил персону: {persona.name}", actor=_actor_from_request(request))
    return {"ok": True, "persona": persona.model_dump(mode="json")}


@app.put("/api/personas/{persona_id}/active")
async def activate_persona(persona_id: str, request: Request) -> dict[str, object]:
    _require_permission(request, "edit_personas")
    try:
        persona = personas_service.activate_persona(persona_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Persona not found") from error
    await _broadcast_shared_settings("personas")
    await _broadcast_notification(f"изменил активную персону: {persona.name}", actor=_actor_from_request(request))
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
        await websocket.send_json({"type": "session.snapshot", "session": session_service.snapshot(session_id)})
        while True:
            raw_event = await websocket.receive_json()
            event = ClientEvent.model_validate(raw_event)

            if event.type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if event.type == "participant.join":
                participant = session_service.join_session(
                    session_id,
                    event.name or event.persona_name or "Player",
                    event.participant_id,
                    event.persona_id or "",
                    event.persona_name or "",
                    event.avatar_url or "",
                    event.username or "",
                    bool(event.is_admin),
                )
                participant_id = participant.id
                await _broadcast_presence(session_id)

            if event.type == "presence.update" and event.participant_id:
                participant = session_service.update_presence(
                    session_id,
                    event.participant_id,
                    event.name or event.persona_name or "Player",
                    event.persona_id or "",
                    event.persona_name or "",
                    event.avatar_url or "",
                    event.username or "",
                    bool(event.is_admin),
                )
                participant_id = participant.id
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

            if event.type in {"image_generation.pending", "image_generation.finished"} and event.card_id and event.chat_id and event.message_id:
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
    except WebSocketDisconnect:
        if participant_id:
            session_service.disconnect_participant(session_id, participant_id)
            await _broadcast_presence(session_id)
    finally:
        connection_manager.disconnect(session_id, websocket)


frontend_dist = PROJECT_ROOT / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
