from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal

import secrets

from pydantic import AliasChoices, BaseModel, Field
import yaml


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _resolve_data_root() -> Path:
    app_data = PROJECT_ROOT / "data"
    if app_data.exists() and os.path.ismount(app_data):
        return app_data
    for name in ("DOUBLE_TROUBLE_DATA_ROOT", "DATA_ROOT"):
        val = os.environ.get(name, "").strip()
        if val:
            return Path(val)
    return app_data


def _resolve_config_path() -> Path:
    app_config_dir = PROJECT_ROOT / "config"
    if app_config_dir.exists() and os.path.ismount(app_config_dir):
        return app_config_dir / "config.yaml"
    for name in ("DOUBLE_TROUBLE_CONFIG_PATH", "CONFIG_PATH"):
        val = os.environ.get(name, "").strip()
        if val:
            p = Path(val)
            data_root = _resolve_data_root()
            if p.as_posix().startswith("/data/") and data_root != Path("/data"):
                return data_root / p.name
            return p
    data_root = _resolve_data_root()
    if (data_root / "config.yaml").exists():
        return data_root / "config.yaml"
    if (app_config_dir / "config.yaml").exists():
        return app_config_dir / "config.yaml"
    return data_root / "config.yaml"


DEFAULT_CONFIG_PATH = _resolve_config_path()
class ServerConfig(BaseModel):
    listen_ip: str = Field(default="127.0.0.1", validation_alias=AliasChoices("listen_ip", "host"))
    listen_port: int = Field(default=8017, validation_alias=AliasChoices("listen_port", "port"))
    public_url: str | None = None
    open_browser_on_start: bool = True


class StorageConfig(BaseModel):
    data_root: Path = Field(default=PROJECT_ROOT / "data")
    default_user: str = "default-user"


class AuthConfig(BaseModel):
    mode: Literal["disabled", "room_password", "users"] = "disabled"
    frontend_password: str = ""
    admin_code: str = "123456"


class GenerationConfig(BaseModel):
    provider: str = "disabled"
    chat_completion_source: str = ""
    base_url: str = ""
    model: str = ""
    api_key_secret: str = "provider_api_key"
    api_key_env: str = "DOUBLE_TROUBLE_API_KEY"
    bot_name: str = "Bot"
    system_prompt: str = "You are a collaborative roleplay assistant. Continue the scene naturally."
    temperature: float = 0.8
    max_tokens: int = 350
    timeout_seconds: float = 60.0
    parameters: dict[str, Any] = Field(default_factory=dict)
    reverse_proxy: str = ""
    proxy_password_secret: str = "provider_proxy_password"
    source_settings: dict[str, dict[str, Any]] = Field(default_factory=dict)



class SummaryMemoryConfig(BaseModel):
    enabled: bool = False
    auto_summarize: bool = True
    every_n_messages: int = Field(default=20, ge=2, le=500)
    use_separate_api: bool = False
    provider: str = "openai-compatible"
    chat_completion_source: str = "custom"
    base_url: str = ""
    model: str = ""
    api_key_secret: str = "summary_api_key"
    temperature: float = 0.3
    max_tokens: int = 800
    prompt: str = (
        "Summarize the key events, character relationships, important decisions, inventory/state changes, "
        "and current situation from the roleplay conversation. Integrate with any existing chronicle seamlessly. "
        "Write a concise, well-structured chronicle in the same language as the chat."
    )

class SecurityConfig(BaseModel):
    allow_key_checking: bool = True
    allow_external_connections: bool = False
    cookie_auth: bool = True
    cookie_secure: bool = False
    cookie_samesite: Literal["strict", "lax", "none"] = "lax"

class AppConfig(BaseModel):
    server: ServerConfig = Field(default_factory=ServerConfig)
    storage: StorageConfig = Field(default_factory=StorageConfig)
    auth: AuthConfig = Field(default_factory=AuthConfig)
    security: SecurityConfig = Field(default_factory=SecurityConfig)


def _env_bool(names: tuple[str, ...]) -> bool | None:
    for name in names:
        val = os.environ.get(name)
        if val is not None and val.strip() != "":
            return val.strip().lower() in {"1", "true", "yes", "on"}
    return None


def _env_str(names: tuple[str, ...]) -> str | None:
    for name in names:
        val = os.environ.get(name)
        if val is not None and val.strip() != "":
            return val.strip()
    return None


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> AppConfig:
    if path.exists():
        with path.open("r", encoding="utf-8") as config_file:
            raw_config = yaml.safe_load(config_file) or {}
        config = AppConfig.model_validate(raw_config)
    else:
        config = AppConfig()

    env_host = _env_str(("DOUBLE_TROUBLE_HOST", "LISTEN_IP", "HOST"))
    if env_host:
        config.server.listen_ip = env_host

    env_port = _env_str(("DOUBLE_TROUBLE_PORT", "LISTEN_PORT", "PORT"))
    if env_port and env_port.isdigit():
        config.server.listen_port = int(env_port)

    env_public_url = _env_str(("DOUBLE_TROUBLE_PUBLIC_URL", "PUBLIC_URL"))
    if env_public_url:
        config.server.public_url = env_public_url

    env_open_browser = _env_bool(("DOUBLE_TROUBLE_OPEN_BROWSER", "OPEN_BROWSER_ON_START"))
    if env_open_browser is not None:
        config.server.open_browser_on_start = env_open_browser

    resolved_root = _resolve_data_root()
    if os.environ.get("DOUBLE_TROUBLE_DATA_ROOT") or os.environ.get("DATA_ROOT") or os.path.ismount(resolved_root):
        config.storage.data_root = resolved_root
    elif not config.storage.data_root.is_absolute():
        config.storage.data_root = PROJECT_ROOT / config.storage.data_root
    env_allow_ext = _env_bool(("DOUBLE_TROUBLE_ALLOW_EXTERNAL", "ALLOW_EXTERNAL_CONNECTIONS"))
    if env_allow_ext is not None:
        config.security.allow_external_connections = env_allow_ext

    env_cookie_auth = _env_bool(("DOUBLE_TROUBLE_COOKIE_AUTH", "COOKIE_AUTH"))
    if env_cookie_auth is not None:
        config.security.cookie_auth = env_cookie_auth

    env_cookie_secure = _env_bool(("DOUBLE_TROUBLE_COOKIE_SECURE", "COOKIE_SECURE"))
    if env_cookie_secure is not None:
        config.security.cookie_secure = env_cookie_secure

    env_admin_code = _env_str(("DOUBLE_TROUBLE_ADMIN_CODE", "ADMIN_CODE"))
    if env_admin_code:
        config.auth.admin_code = env_admin_code

    return config

def save_config(config: AppConfig, path: Path = DEFAULT_CONFIG_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = config.model_dump(mode="json")
    data["storage"]["data_root"] = _relative_to_project(Path(config.storage.data_root))

    with path.open("w", encoding="utf-8") as config_file:
        yaml.safe_dump(data, config_file, sort_keys=False, allow_unicode=True)


def ensure_admin_code(config: AppConfig, path: Path = DEFAULT_CONFIG_PATH) -> str | None:
    if config.auth.admin_code and config.auth.admin_code != "123456":
        return None
    new_code = secrets.token_urlsafe(12)
    config.auth.admin_code = new_code
    save_config(config, path)
    return new_code


def _relative_to_project(path: Path) -> str:
    try:
        return path.relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        return path.as_posix()
