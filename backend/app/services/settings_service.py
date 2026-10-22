from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from pathlib import Path
from typing import Any
from pydantic import BaseModel, Field
import yaml

from backend.app.config import GenerationConfig, SummaryMemoryConfig
from backend.app.llm.chat_completion_sources import resolve_source_id, get_source
from backend.app.secrets import SecretStore


class GenerationSettingsUpdate(BaseModel):
    provider: str = "disabled"
    chat_completion_source: str = ""
    base_url: str = ""
    model: str = ""
    bot_name: str = "Bot"
    system_prompt: str = "You are a collaborative roleplay assistant. Continue the scene naturally."
    temperature: float = Field(default=0.8, ge=0, le=2)
    max_tokens: int = Field(default=350, ge=1, le=32000)
    timeout_seconds: float = Field(default=60, ge=1, le=600)
    api_key: str = ""
    clear_api_key: bool = False
    reverse_proxy: str = ""
    proxy_password: str = ""
    clear_proxy_password: bool = False
    source_settings: dict[str, dict[str, Any]] = Field(default_factory=dict)
    parameters: dict[str, Any] = Field(default_factory=dict)


class GenerationConnectionPreset(BaseModel):
    name: str
    provider: str = "disabled"
    chat_completion_source: str = ""
    base_url: str = ""
    model: str = ""
    system_prompt: str = "You are a collaborative roleplay assistant. Continue the scene naturally."
    temperature: float = Field(default=0.8, ge=0, le=2)
    max_tokens: int = Field(default=350, ge=1, le=32000)
    timeout_seconds: float = Field(default=60, ge=1, le=600)
    reverse_proxy: str = ""
    source_settings: dict[str, dict[str, Any]] = Field(default_factory=dict)
    parameters: dict[str, Any] = Field(default_factory=dict)


class GenerationPresetSave(BaseModel):
    name: str
    settings: GenerationSettingsUpdate


class PermissionRule(BaseModel):
    mode: str = "everyone"
    users: list[str] = Field(default_factory=list)


class SecurityPermissions(BaseModel):
    view_cards: PermissionRule = Field(default_factory=PermissionRule)
    view_personas: PermissionRule = Field(default_factory=PermissionRule)
    view_chats: PermissionRule = Field(default_factory=PermissionRule)
    view_presets: PermissionRule = Field(default_factory=PermissionRule)
    view_lorebooks: PermissionRule = Field(default_factory=PermissionRule)
    view_reasoning: PermissionRule = Field(default_factory=PermissionRule)
    edit_cards: PermissionRule = Field(default_factory=PermissionRule)
    delete_cards: PermissionRule = Field(default_factory=PermissionRule)
    edit_personas: PermissionRule = Field(default_factory=PermissionRule)
    delete_personas: PermissionRule = Field(default_factory=PermissionRule)
    manage_chats: PermissionRule = Field(default_factory=PermissionRule)
    edit_messages: PermissionRule = Field(default_factory=PermissionRule)
    delete_messages: PermissionRule = Field(default_factory=PermissionRule)
    generate: PermissionRule = Field(default_factory=PermissionRule)
    manage_presets: PermissionRule = Field(default_factory=PermissionRule)
    manage_lorebooks: PermissionRule = Field(default_factory=PermissionRule)
    manage_extensions: PermissionRule = Field(default_factory=PermissionRule)
    manage_keys: PermissionRule = Field(default_factory=lambda: PermissionRule(mode="everyone"))
    manage_security: PermissionRule = Field(default_factory=lambda: PermissionRule(mode="admins"))


class SecuritySettingsPayload(BaseModel):
    auth_required: bool = False
    registration_allowed: bool = True
    bot_reply_allowed: bool = True
    access_password_required: bool = False
    access_password: str = ""
    access_password_configured: bool = False
    permissions: SecurityPermissions = Field(default_factory=SecurityPermissions)


class DeleteLocks(BaseModel):
    cards: list[str] = Field(default_factory=list)
    personas: list[str] = Field(default_factory=list)
    chats: list[str] = Field(default_factory=list)



class SummaryMemorySettingsUpdate(BaseModel):
    enabled: bool = False
    auto_summarize: bool = True
    every_n_messages: int = Field(default=20, ge=2, le=500)
    use_separate_api: bool = False
    provider: str = "openai-compatible"
    chat_completion_source: str = "custom"
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    clear_api_key: bool = False
    temperature: float = Field(default=0.3, ge=0, le=2)
    max_tokens: int = Field(default=800, ge=100, le=8000)
    prompt: str = (
        "Summarize the key events, character relationships, important decisions, inventory/state changes, "
        "and current situation from the roleplay conversation. Integrate with any existing chronicle seamlessly. "
        "Write a concise, well-structured chronicle in the same language as the chat."
    )

class UserSettings(BaseModel):
    generation: GenerationConfig = Field(default_factory=GenerationConfig)
    generation_presets: list[GenerationConnectionPreset] = Field(default_factory=list)
    active_generation_preset: str = ""
    active_presets: dict[str, str] = Field(default_factory=dict)
    auth_required: bool = Field(
        default_factory=lambda: os.environ.get("DOUBLE_TROUBLE_AUTH_REQUIRED", os.environ.get("DOUBLE_TROUBLE_ALLOW_EXTERNAL", "false")).strip().lower() in {"1", "true", "yes", "on"}
    )
    registration_allowed: bool = True
    bot_reply_allowed: bool = True
    access_password_required: bool = False
    access_password_salt: str = ""
    access_password_hash: str = ""
    access_token: str = ""
    security_permissions: SecurityPermissions = Field(default_factory=SecurityPermissions)
    delete_locks: DeleteLocks = Field(default_factory=DeleteLocks)
    summary_memory: SummaryMemoryConfig = Field(default_factory=SummaryMemoryConfig)

class SettingsService:
    def __init__(self, settings_path: Path, secret_store: SecretStore) -> None:
        self.settings_path = settings_path
        self.secret_store = secret_store
        self.settings = self._load_settings()

    def generation_config(self) -> GenerationConfig:
        return self.settings.generation

    def generation_settings(self) -> dict[str, object]:
        generation = self.settings.generation
        source_id = self._effective_source_id(generation)
        source_api_key_secret = self._source_api_key_secret(source_id) or generation.api_key_secret
        source_api_key_env = self._source_api_key_env(source_id) or generation.api_key_env
        return {
            "provider": generation.provider,
            "chat_completion_source": source_id,
            "base_url": generation.base_url,
            "model": generation.model,
            "bot_name": generation.bot_name,
            "system_prompt": generation.system_prompt,
            "temperature": generation.temperature,
            "max_tokens": generation.max_tokens,
            "timeout_seconds": generation.timeout_seconds,
            "api_key_configured": self.secret_store.exists(generation.api_key_secret, generation.api_key_env)
            or self.secret_store.exists(source_api_key_secret, source_api_key_env),
            "api_key_env": source_api_key_env,
            "reverse_proxy": generation.reverse_proxy,
            "proxy_password_configured": self.secret_store.exists(generation.proxy_password_secret, ""),
            "source_settings": dict(generation.source_settings),
            "parameters": dict(generation.parameters),
        }


    def summary_memory_config(self) -> SummaryMemoryConfig:
        return self.settings.summary_memory

    def summary_memory_settings(self) -> dict[str, object]:
        cfg = self.settings.summary_memory
        return {
            "enabled": cfg.enabled,
            "auto_summarize": cfg.auto_summarize,
            "every_n_messages": cfg.every_n_messages,
            "use_separate_api": cfg.use_separate_api,
            "provider": cfg.provider,
            "chat_completion_source": cfg.chat_completion_source,
            "base_url": cfg.base_url,
            "model": cfg.model,
            "api_key_configured": self.secret_store.exists(cfg.api_key_secret, ""),
            "temperature": cfg.temperature,
            "max_tokens": cfg.max_tokens,
            "prompt": cfg.prompt,
        }

    def update_summary_memory_settings(self, request: SummaryMemorySettingsUpdate) -> SummaryMemoryConfig:
        current = self.settings.summary_memory
        if request.clear_api_key:
            self.secret_store.clear(current.api_key_secret)
        elif request.api_key.strip():
            self.secret_store.write(current.api_key_secret, request.api_key.strip())
        self.settings.summary_memory = SummaryMemoryConfig(
            enabled=request.enabled,
            auto_summarize=request.auto_summarize,
            every_n_messages=max(2, min(500, int(request.every_n_messages))),
            use_separate_api=request.use_separate_api,
            provider=request.provider.strip() or "openai-compatible",
            chat_completion_source=request.chat_completion_source.strip() or "custom",
            base_url=request.base_url.strip().rstrip("/"),
            model=request.model.strip(),
            api_key_secret=current.api_key_secret,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            prompt=request.prompt.strip() or current.prompt,
        )
        self._save_settings()
        return self.settings.summary_memory
    @staticmethod
    def _effective_source_id(generation: GenerationConfig) -> str:
        if generation.chat_completion_source:
            return generation.chat_completion_source
        if generation.provider in ("", "disabled"):
            return generation.provider or ""
        return resolve_source_id(generation.provider)

    @staticmethod
    def _source_api_key_secret(source_id: str) -> str:
        source = get_source(source_id)
        return source.secret_key_name if source else ""

    @staticmethod
    def _source_api_key_env(source_id: str) -> str:
        source = get_source(source_id)
        return source.api_key_env if source else ""

    def generation_presets(self) -> list[GenerationConnectionPreset]:
        return sorted(self.settings.generation_presets, key=lambda preset: preset.name.lower())

    def active_generation_preset(self) -> str:
        active = self.settings.active_generation_preset
        if any(preset.name == active for preset in self.settings.generation_presets):
            return active
        return ""

    def save_generation_preset(self, request: GenerationPresetSave) -> GenerationConnectionPreset:
        name = request.name.strip()
        if not name:
            raise ValueError("Preset name is required")
        preset = GenerationConnectionPreset(
            name=name,
            provider=request.settings.provider,
            chat_completion_source=request.settings.chat_completion_source,
            base_url=request.settings.base_url.strip().rstrip("/"),
            model=request.settings.model.strip(),
            system_prompt=request.settings.system_prompt.strip(),
            temperature=request.settings.temperature,
            max_tokens=request.settings.max_tokens,
            timeout_seconds=request.settings.timeout_seconds,
            reverse_proxy=request.settings.reverse_proxy.strip(),
            source_settings=dict(request.settings.source_settings),
            parameters=dict(request.settings.parameters),
        )
        self.settings.generation_presets = [existing for existing in self.settings.generation_presets if existing.name.lower() != name.lower()]
        self.settings.generation_presets.append(preset)
        self.settings.active_generation_preset = name
        self.update_generation_settings(request.settings)
        return preset

    def apply_generation_preset(self, name: str) -> GenerationConfig:
        preset = next((item for item in self.settings.generation_presets if item.name == name), None)
        if not preset:
            raise KeyError(name)
        current = self.settings.generation
        self.settings.generation = GenerationConfig(
            provider=preset.provider,
            chat_completion_source=preset.chat_completion_source or resolve_source_id(preset.provider),
            base_url=preset.base_url.strip().rstrip("/"),
            model=preset.model.strip(),
            api_key_secret=current.api_key_secret,
            api_key_env=current.api_key_env,
            bot_name=current.bot_name,
            system_prompt=preset.system_prompt.strip(),
            temperature=preset.temperature,
            max_tokens=preset.max_tokens,
            timeout_seconds=preset.timeout_seconds,
            parameters=dict(preset.parameters) or current.parameters,
            reverse_proxy=preset.reverse_proxy.strip(),
            proxy_password_secret=current.proxy_password_secret,
            source_settings=dict(preset.source_settings),
        )
        self.settings.active_generation_preset = name
        self._save_settings()
        return self.settings.generation

    def delete_generation_preset(self, name: str) -> None:
        before = len(self.settings.generation_presets)
        self.settings.generation_presets = [preset for preset in self.settings.generation_presets if preset.name != name]
        if len(self.settings.generation_presets) == before:
            raise KeyError(name)
        if self.settings.active_generation_preset == name:
            self.settings.active_generation_preset = ""
        self._save_settings()

    def active_preset_settings(self) -> dict[str, str]:
        return dict(self.settings.active_presets)

    def set_active_preset(self, preset_type: str, name: str) -> dict[str, str]:
        self.settings.active_presets[preset_type] = name
        self._save_settings()
        return self.active_preset_settings()

    def security_permissions(self) -> SecurityPermissions:
        return self.settings.security_permissions

    def auth_required(self) -> bool:
        return self.settings.auth_required

    def registration_allowed(self) -> bool:
        return self.settings.registration_allowed

    def bot_reply_allowed(self) -> bool:
        return self.settings.bot_reply_allowed

    def access_password_required(self) -> bool:
        return self.settings.access_password_required and bool(self.settings.access_password_hash)

    def access_password_configured(self) -> bool:
        return bool(self.settings.access_password_hash)

    def verify_access_password(self, password: str) -> str:
        if not self.access_password_required():
            return ""
        if not self.settings.access_password_salt or not self.settings.access_password_hash:
            raise ValueError("Access password is not configured")
        password_hash = self._hash_access_password(password, self.settings.access_password_salt)
        if not hmac.compare_digest(password_hash, self.settings.access_password_hash):
            raise ValueError("Invalid access password")
        if not self.settings.access_token:
            self.settings.access_token = secrets.token_urlsafe(32)
            self._save_settings()
        return self.settings.access_token

    def verify_access_token(self, token: str) -> bool:
        if not self.access_password_required():
            return True
        return bool(token) and bool(self.settings.access_token) and hmac.compare_digest(token, self.settings.access_token)

    def update_security_settings(self, payload: SecuritySettingsPayload) -> SecuritySettingsPayload:
        self.settings.auth_required = payload.auth_required
        self.settings.registration_allowed = payload.registration_allowed
        self.settings.bot_reply_allowed = payload.bot_reply_allowed
        next_password = payload.access_password.strip()
        if next_password:
            if len(next_password) < 4:
                raise ValueError("Access password must be at least 4 characters")
            self.settings.access_password_salt = secrets.token_hex(16)
            self.settings.access_password_hash = self._hash_access_password(next_password, self.settings.access_password_salt)
            self.settings.access_token = secrets.token_urlsafe(32)
        if payload.access_password_required and not self.settings.access_password_hash:
            raise ValueError("Set an access password before enabling the access lock")
        self.settings.access_password_required = payload.access_password_required
        self.settings.security_permissions = payload.permissions
        self._save_settings()
        return SecuritySettingsPayload(
            auth_required=self.settings.auth_required,
            registration_allowed=self.settings.registration_allowed,
            bot_reply_allowed=self.settings.bot_reply_allowed,
            access_password_required=self.settings.access_password_required,
            access_password_configured=self.access_password_configured(),
            permissions=self.settings.security_permissions,
        )

    def security_settings_payload(self) -> SecuritySettingsPayload:
        return SecuritySettingsPayload(
            auth_required=self.settings.auth_required,
            registration_allowed=self.settings.registration_allowed,
            bot_reply_allowed=self.settings.bot_reply_allowed,
            access_password_required=self.settings.access_password_required,
            access_password_configured=self.access_password_configured(),
            permissions=self.settings.security_permissions,
        )

    def delete_locks(self) -> DeleteLocks:
        return self.settings.delete_locks

    def set_delete_lock(self, category: str, item_id: str, locked: bool) -> DeleteLocks:
        locks = self.settings.delete_locks
        if category not in {"cards", "personas", "chats"}:
            raise ValueError("Unsupported delete lock category")
        current = set(getattr(locks, category))
        if locked:
            current.add(item_id)
        else:
            current.discard(item_id)
        setattr(locks, category, sorted(current))
        self._save_settings()
        return locks

    def is_delete_locked(self, category: str, item_id: str) -> bool:
        if category not in {"cards", "personas", "chats"}:
            return False
        return item_id in set(getattr(self.settings.delete_locks, category))

    def clear_delete_lock(self, category: str, item_id: str) -> DeleteLocks:
        return self.set_delete_lock(category, item_id, False)

    def clear_chat_locks_for_card(self, card_id: str) -> DeleteLocks:
        prefix = f"{card_id}:"
        self.settings.delete_locks.chats = [item for item in self.settings.delete_locks.chats if not item.startswith(prefix)]
        self._save_settings()
        return self.settings.delete_locks

    def update_generation_settings(self, request: GenerationSettingsUpdate) -> GenerationConfig:
        current = self.settings.generation
        new_source = request.chat_completion_source or resolve_source_id(request.provider)
        merged_source_settings = dict(current.source_settings)
        for key, value in (request.source_settings or {}).items():
            if isinstance(value, dict):
                merged_source_settings[key] = dict(value)
        self.settings.generation = GenerationConfig(
            provider=request.provider,
            chat_completion_source=new_source,
            base_url=request.base_url.strip().rstrip("/"),
            model=request.model.strip(),
            api_key_secret=current.api_key_secret,
            api_key_env=current.api_key_env,
            bot_name=request.bot_name.strip() or "Bot",
            system_prompt=request.system_prompt.strip(),
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            timeout_seconds=request.timeout_seconds,
            parameters=dict(request.parameters) if request.parameters else current.parameters,
            reverse_proxy=request.reverse_proxy.strip(),
            proxy_password_secret=current.proxy_password_secret,
            source_settings=merged_source_settings,
        )

        # General API key (legacy + active source).
        if request.clear_api_key:
            self.secret_store.delete(current.api_key_secret)
            source_secret = self._source_api_key_secret(new_source)
            if source_secret:
                self.secret_store.delete(source_secret)
        elif request.api_key.strip():
            self.secret_store.write(current.api_key_secret, request.api_key.strip())
            source_secret = self._source_api_key_secret(new_source)
            if source_secret and source_secret != current.api_key_secret:
                self.secret_store.write(source_secret, request.api_key.strip())

        if request.clear_proxy_password:
            self.secret_store.delete(current.proxy_password_secret)
        elif request.proxy_password.strip():
            self.secret_store.write(current.proxy_password_secret, request.proxy_password.strip())

        self._save_settings()
        return self.settings.generation

    def _load_settings(self) -> UserSettings:
        env_auth = os.environ.get("DOUBLE_TROUBLE_AUTH_REQUIRED", os.environ.get("DOUBLE_TROUBLE_ALLOW_EXTERNAL", "")).strip().lower() in {"1", "true", "yes", "on"}
        if not self.settings_path.exists():
            settings = UserSettings()
            if env_auth:
                settings.auth_required = True
            return settings

        with self.settings_path.open("r", encoding="utf-8") as settings_file:
            raw_settings = yaml.safe_load(settings_file) or {}
        settings = UserSettings.model_validate(raw_settings)
        users_path = self.settings_path.parent / "users.yaml"
        if env_auth and not users_path.exists():
            settings.auth_required = True
        return settings
    def _save_settings(self) -> None:
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.settings_path.with_suffix(".yaml.tmp")
        with tmp_path.open("w", encoding="utf-8") as settings_file:
            yaml.safe_dump(self.settings.model_dump(mode="json"), settings_file, sort_keys=False, allow_unicode=True)
        os.replace(tmp_path, self.settings_path)
    @staticmethod
    def _hash_access_password(password: str, salt: str) -> str:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), 120_000).hex()
