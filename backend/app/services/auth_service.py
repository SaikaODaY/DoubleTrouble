from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from pathlib import Path

import yaml
from pydantic import BaseModel, Field


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AuthUser(BaseModel):
    username: str
    password_hash: str
    salt: str
    is_admin: bool = False
    created_at: str = Field(default_factory=utc_now)


class AuthSession(BaseModel):
    token: str
    username: str
    created_at: str = Field(default_factory=utc_now)


class AuthState(BaseModel):
    users: list[AuthUser] = Field(default_factory=list)
    sessions: list[AuthSession] = Field(default_factory=list)


class AuthService:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.state = self._load()

    def register(self, username: str, password: str) -> tuple[AuthUser, str]:
        username = self._normalize_username(username)
        if len(password) < 3:
            raise ValueError("Password is too short")
        if self._find_user(username):
            raise ValueError("User already exists")
        salt = secrets.token_hex(16)
        user = AuthUser(username=username, salt=salt, password_hash=self._hash_password(password, salt), is_admin=not self.state.users)
        self.state.users.append(user)
        token = self._create_session(username)
        self._save()
        return user, token

    def login(self, username: str, password: str) -> tuple[AuthUser, str]:
        username = self._normalize_username(username)
        user = self._find_user(username)
        if not user or not hmac.compare_digest(user.password_hash, self._hash_password(password, user.salt)):
            raise ValueError("Invalid username or password")
        token = self._create_session(username)
        self._save()
        return user, token

    def user_by_token(self, token: str) -> AuthUser | None:
        if not token:
            return None
        session = next((item for item in self.state.sessions if hmac.compare_digest(item.token, token)), None)
        if not session:
            return None
        return self._find_user(session.username)

    def logout(self, token: str) -> None:
        self.state.sessions = [session for session in self.state.sessions if session.token != token]
        self._save()

    def claim_admin(self, token: str, code: str, admin_code: str) -> AuthUser:
        user = self.user_by_token(token)
        if not user:
            raise PermissionError("Authentication required")
        if not admin_code or not hmac.compare_digest(code.strip(), admin_code):
            raise ValueError("Invalid admin code")
        user.is_admin = True
        self._save()
        return user

    def public_user(self, user: AuthUser | None) -> dict[str, object] | None:
        if not user:
            return None
        return {"username": user.username, "is_admin": user.is_admin}

    def _create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(32)
        user_lower = username.lower()
        user_sessions = [s for s in self.state.sessions if s.username.lower() == user_lower]
        if len(user_sessions) >= 15:
            oldest_tokens = {s.token for s in user_sessions[:-14]}
            self.state.sessions = [s for s in self.state.sessions if s.token not in oldest_tokens]
        self.state.sessions.append(AuthSession(token=token, username=username))
        return token
    def _find_user(self, username: str) -> AuthUser | None:
        normalized = self._normalize_username(username)
        return next((user for user in self.state.users if user.username.lower() == normalized.lower()), None)

    def _normalize_username(self, username: str) -> str:
        username = username.strip()
        if not username:
            raise ValueError("Username is required")
        return username[:48]

    def _hash_password(self, password: str, salt: str) -> str:
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("ascii"), 120_000).hex()

    def _load(self) -> AuthState:
        if not self.path.exists():
            return AuthState()
        with self.path.open("r", encoding="utf-8") as auth_file:
            raw = yaml.safe_load(auth_file) or {}
        return AuthState.model_validate(raw)

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(".yaml.tmp")
        with tmp_path.open("w", encoding="utf-8") as auth_file:
            yaml.safe_dump(self.state.model_dump(mode="json"), auth_file, sort_keys=False, allow_unicode=True)
        os.replace(tmp_path, self.path)
