from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from pydantic import BaseModel, Field


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class BotChatMessage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    role: str = "user"
    author: str = "Player"
    participant_id: str = ""
    avatar_url: str = ""
    username: str = ""
    is_admin: bool = False
    content: str
    display_text: str = ""
    swipe_display_texts: dict[str, str] = Field(default_factory=dict)
    hidden: bool = False
    swipes: list[str] = Field(default_factory=list)
    active_swipe_index: int = 0
    created_at: str = Field(default_factory=utc_now)
    updated_at: str = Field(default_factory=utc_now)

class BotChat(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    card_id: str
    character_name: str
    title: str = "New Chat"
    created_at: str = Field(default_factory=utc_now)
    updated_at: str = Field(default_factory=utc_now)
    messages: list[BotChatMessage] = Field(default_factory=list)


class BotChatSummary(BaseModel):
    id: str
    title: str
    filename: str
    message_count: int
    created_at: str
    updated_at: str


class ChatCreate(BaseModel):
    character_name: str = "Character"
    title: str = "New Chat"


class ChatUpdate(BaseModel):
    title: str


class ChatMessageCreate(BaseModel):
    author: str = "Player"
    participant_id: str = ""
    avatar_url: str = ""
    username: str = ""
    is_admin: bool = False
    role: str = "user"
    content: str


class ChatMessageUpdate(BaseModel):
    content: str | None = None
    display_text: str | None = None
    hidden: bool | None = None


class ChatSwipeRequest(BaseModel):
    direction: int = 1


class BotChatsService:
    def __init__(self, chats_dir: Path) -> None:
        self.chats_dir = chats_dir
        self._summary_cache: dict[Path, tuple[int, int, BotChatSummary]] = {}

    def list_chats(self, card_id: str) -> list[BotChatSummary]:
        directory = self._card_chat_dir(card_id)
        if not directory.exists():
            return []
        summaries: list[BotChatSummary] = []
        for path in sorted(directory.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                summaries.append(self._summary(path))
            except (json.JSONDecodeError, UnicodeDecodeError, ValueError, OSError):
                continue
        return summaries
    def get_chat(self, card_id: str, chat_id: str) -> BotChat:
        path = self._chat_path(card_id, chat_id)
        if not path.exists():
            raise FileNotFoundError(chat_id)
        return BotChat.model_validate(json.loads(path.read_text(encoding="utf-8")))

    def current_or_create(self, card_id: str, character_name: str) -> BotChat:
        chats = self.list_chats(card_id)
        if chats:
            return self.get_chat(card_id, chats[0].id)
        return self.create_chat(card_id, ChatCreate(character_name=character_name))

    def create_chat(self, card_id: str, request: ChatCreate) -> BotChat:
        directory = self._card_chat_dir(card_id)
        directory.mkdir(parents=True, exist_ok=True)
        chat = BotChat(card_id=card_id, character_name=request.character_name.strip() or "Character", title=request.title.strip() or "New Chat")
        self._save(chat)
        return chat

    def update_chat(self, card_id: str, chat_id: str, request: ChatUpdate) -> BotChat:
        chat = self.get_chat(card_id, chat_id)
        chat.title = request.title.strip() or "New Chat"
        chat.updated_at = utc_now()
        self._save(chat)
        return chat

    def copy_chat(self, card_id: str, chat_id: str) -> BotChat:
        source = self.get_chat(card_id, chat_id)
        now = utc_now()
        copied = source.model_copy(deep=True)
        copied.id = str(uuid4())
        copied.title = f"{source.title} copy"
        copied.created_at = now
        copied.updated_at = now
        copied.messages = [message.model_copy(deep=True) for message in source.messages]
        self._save(copied)
        return copied

    def delete_chat(self, card_id: str, chat_id: str) -> None:
        path = self._chat_path(card_id, chat_id)
        if not path.exists():
            raise FileNotFoundError(chat_id)
        self._summary_cache.pop(path, None)
        path.unlink()

    def delete_card_chats(self, card_id: str) -> None:
        directory = self._card_chat_dir(card_id)
        if not directory.exists():
            return
        for path in directory.glob("*.json"):
            self._summary_cache.pop(path, None)
            path.unlink()
        try:
            directory.rmdir()
        except OSError:
            pass

    def sillytavern_export_filename(self, card_id: str, chat_id: str) -> str:
        chat = self.get_chat(card_id, chat_id)
        timestamp = self._st_filename_timestamp(chat.created_at)
        safe_name = self._safe_path_part(chat.character_name or chat.card_id or "Character")
        return f"{safe_name} - {timestamp}.jsonl"

    def export_sillytavern_jsonl(self, card_id: str, chat_id: str) -> str:
        chat = self.get_chat(card_id, chat_id)
        metadata = {
            "chat_metadata": {
                "source": "DoubleTrouble",
                "integrity": chat.id,
                "card_id": chat.card_id,
                "title": chat.title,
                "created_at": chat.created_at,
            },
            "user_name": self._first_user_name(chat),
            "character_name": chat.character_name or "unused",
        }
        rows = [metadata]
        for message in chat.messages:
            row: dict[str, object] = {
                "name": message.author or ("System" if message.role == "system" else chat.character_name),
                "is_user": message.role == "user",
                "is_system": message.role == "system",
                "send_date": self._st_send_date(message.created_at),
                "mes": message.content,
            }
            if message.role == "assistant":
                swipes = message.swipes or [message.content]
                row["swipe_id"] = max(0, min(message.active_swipe_index, len(swipes) - 1))
                row["swipes"] = swipes
                row["swipe_info"] = [{"send_date": self._st_send_date(message.created_at)} for _ in swipes]
            if message.hidden:
                row["extra"] = {"doubletrouble_hidden": True}
            rows.append(row)
        return "\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows) + "\n"

    def import_sillytavern_chat(self, card_id: str, character_name: str, filename: str, content_text: str) -> BotChat:
        stripped = content_text.strip()
        if not stripped:
            raise ValueError("Chat file is empty")
        title = Path(filename or "Imported Chat").stem
        messages: list[BotChatMessage] = []
        if stripped.startswith("{") and "\n" not in stripped:
            try:
                parsed_single = json.loads(stripped)
                if isinstance(parsed_single, dict) and isinstance(parsed_single.get("messages"), list):
                    chat = BotChat.model_validate({**parsed_single, "id": str(uuid4()), "card_id": card_id, "character_name": character_name or parsed_single.get("character_name") or "Character"})
                    self._save(chat)
                    return chat
            except (json.JSONDecodeError, ValueError):
                pass
        for line in stripped.splitlines():
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                continue
            if "chat_metadata" in row and "mes" not in row:
                meta = row.get("chat_metadata")
                if isinstance(meta, dict) and str(meta.get("title") or "").strip():
                    title = str(meta["title"]).strip()
                continue
            mes = str(row.get("mes") or "").strip()
            if not mes:
                continue
            is_system = bool(row.get("is_system"))
            is_user = bool(row.get("is_user"))
            role = "system" if is_system else "user" if is_user else "assistant"
            author = str(row.get("name") or ("System" if is_system else "Player" if is_user else character_name or "Bot"))
            swipes_raw = row.get("swipes")
            swipes = [str(s) for s in swipes_raw if str(s).strip()] if isinstance(swipes_raw, list) else ([mes] if role == "assistant" else [])
            swipe_id = int(row.get("swipe_id") or 0) if isinstance(row.get("swipe_id"), (int, float)) else 0
            active_swipe_index = max(0, min(swipe_id, len(swipes) - 1)) if swipes else 0
            extra = row.get("extra") if isinstance(row.get("extra"), dict) else {}
            hidden = bool(extra.get("doubletrouble_hidden") or row.get("is_hidden"))
            messages.append(
                BotChatMessage(
                    role=role,
                    author=author,
                    content=swipes[active_swipe_index] if role == "assistant" and swipes else mes,
                    swipes=swipes,
                    active_swipe_index=active_swipe_index,
                    hidden=hidden,
                )
            )
        chat = BotChat(card_id=card_id, character_name=character_name or "Character", title=title, messages=messages)
        self._save(chat)
        return chat

    def add_message(self, card_id: str, chat_id: str, request: ChatMessageCreate) -> BotChat:
        chat = self.get_chat(card_id, chat_id)
        content = request.content.strip()
        if not content:
            raise ValueError("Message content is required")
        role = request.role if request.role in {"user", "assistant", "system"} else "user"
        swipes = [content] if role == "assistant" else []
        chat.messages.append(BotChatMessage(role=role, author=request.author.strip() or "Player", participant_id=request.participant_id.strip(), avatar_url=request.avatar_url.strip(), username=request.username.strip(), is_admin=request.is_admin, content=content, swipes=swipes))
        chat.updated_at = utc_now()
        self._save(chat)
        return chat

    def update_message(self, card_id: str, chat_id: str, message_id: str, request: ChatMessageUpdate) -> BotChat:
        chat = self.get_chat(card_id, chat_id)
        for message in chat.messages:
            if message.id == message_id:
                swipe_key = str(max(0, message.active_swipe_index))
                if request.content is not None:
                    content = request.content.strip()
                    if not content:
                        raise ValueError("Message content is required")
                    message.content = content
                    if message.role == "assistant":
                        if message.swipes and 0 <= message.active_swipe_index < len(message.swipes):
                            message.swipes[message.active_swipe_index] = content
                        else:
                            message.swipes = [content]
                            message.active_swipe_index = 0
                    if request.display_text is None:
                        message.display_text = ""
                        message.swipe_display_texts.pop(swipe_key, None)
                if request.display_text is not None:
                    cleaned_display = request.display_text.strip()
                    message.display_text = cleaned_display
                    if cleaned_display:
                        message.swipe_display_texts[swipe_key] = cleaned_display
                    else:
                        message.swipe_display_texts.pop(swipe_key, None)
                if request.hidden is not None:
                    message.hidden = request.hidden
                message.updated_at = utc_now()
                chat.updated_at = utc_now()
                self._save(chat)
                return chat
        raise KeyError(message_id)

    def delete_message(self, card_id: str, chat_id: str, message_id: str) -> BotChat:
        chat = self.get_chat(card_id, chat_id)
        messages = [message for message in chat.messages if message.id != message_id]
        if len(messages) == len(chat.messages):
            raise KeyError(message_id)
        chat.messages = messages
        chat.updated_at = utc_now()
        self._save(chat)
        return chat

    def add_bot_message(self, card_id: str, chat_id: str, author: str, content: str, avatar_url: str = "", swipes: list[str] | None = None) -> BotChat:
        chat = self.get_chat(card_id, chat_id)
        cleaned_swipes = [swipe.strip() for swipe in (swipes or []) if swipe.strip()]
        first_content = content.strip() or (cleaned_swipes[0] if cleaned_swipes else "")
        if not first_content:
            raise ValueError("Message content is required")
        if not cleaned_swipes:
            cleaned_swipes = [first_content]
        chat.messages.append(BotChatMessage(role="assistant", author=author.strip() or "Bot", avatar_url=avatar_url.strip(), content=first_content, swipes=cleaned_swipes, active_swipe_index=0))
        chat.updated_at = utc_now()
        self._save(chat)
        return chat

    def sync_first_assistant_swipes(self, card_id: str, chat_id: str, swipes: list[str]) -> BotChat:
        chat = self.get_chat(card_id, chat_id)
        if any(message.role == "user" for message in chat.messages):
            return chat
        first_assistant = next((message for message in chat.messages if message.role == "assistant"), None)
        cleaned_swipes = [swipe.strip() for swipe in swipes if swipe.strip()]
        if first_assistant is None or not cleaned_swipes:
            return chat
        current_content = first_assistant.content.strip()
        active_index = cleaned_swipes.index(current_content) if current_content in cleaned_swipes else 0
        if first_assistant.swipes == cleaned_swipes and first_assistant.active_swipe_index == active_index:
            return chat
        first_assistant.swipes = cleaned_swipes
        first_assistant.active_swipe_index = active_index
        first_assistant.content = cleaned_swipes[active_index]
        first_assistant.updated_at = utc_now()
        chat.updated_at = utc_now()
        self._save(chat)
        return chat

    def replace_bot_message(self, card_id: str, chat_id: str, message_id: str, author: str, content: str, avatar_url: str = "", reset_swipes: bool = False) -> BotChat:
        chat = self.get_chat(card_id, chat_id)
        for message in chat.messages:
            if message.id == message_id and message.role == "assistant":
                swipes = [content] if reset_swipes else [*(message.swipes or [message.content]), content]
                message.swipes = swipes
                message.active_swipe_index = len(swipes) - 1
                if reset_swipes:
                    message.swipe_display_texts = {}
                message.display_text = ""
                message.author = author.strip() or message.author
                message.avatar_url = avatar_url.strip() or message.avatar_url
                message.content = content
                message.updated_at = utc_now()
                chat.updated_at = utc_now()
                self._save(chat)
                return chat
        raise KeyError(message_id)

    def swipe_bot_message(self, card_id: str, chat_id: str, message_id: str, direction: int) -> BotChat:
        chat = self.get_chat(card_id, chat_id)
        for message in chat.messages:
            if message.id == message_id and message.role == "assistant":
                swipes = message.swipes or [message.content]
                if not swipes:
                    raise ValueError("Message has no swipes")
                message.swipes = swipes
                message.active_swipe_index = (message.active_swipe_index + (1 if direction >= 0 else -1)) % len(swipes)
                message.content = swipes[message.active_swipe_index]
                message.display_text = message.swipe_display_texts.get(str(message.active_swipe_index), "")
                message.updated_at = utc_now()
                chat.updated_at = utc_now()
                self._save(chat)
                return chat
        raise KeyError(message_id)

    def _card_chat_dir(self, card_id: str) -> Path:
        safe_id = self._safe_path_part(card_id)
        return self.chats_dir / safe_id

    def _chat_path(self, card_id: str, chat_id: str) -> Path:
        safe_id = self._safe_path_part(chat_id) or chat_id
        return self._card_chat_dir(card_id) / f"{safe_id}.json"

    def _safe_path_part(self, value: str) -> str:
        return re.sub(r"[^\w\-. ]+", "_", value, flags=re.UNICODE).strip(" .") or "Character"

    def _first_user_name(self, chat: BotChat) -> str:
        return next((message.author for message in chat.messages if message.role == "user" and message.author), "unused")

    def _st_send_date(self, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            parsed = datetime.now(timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _st_filename_timestamp(self, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            parsed = datetime.now(timezone.utc)
        utc_value = parsed.astimezone(timezone.utc)
        return utc_value.strftime("%Y-%m-%d@%Hh%Mm%Ss") + f"{utc_value.microsecond // 1000:03d}ms"

    def _save(self, chat: BotChat) -> None:
        directory = self._card_chat_dir(chat.card_id)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{chat.id}.json"
        tmp_path = directory / f".{chat.id}.{uuid4().hex[:8]}.tmp"
        tmp_path.write_text(json.dumps(chat.model_dump(mode="json"), ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp_path, path)
        st = path.stat()
        self._summary_cache[path] = (
            st.st_mtime_ns,
            st.st_size,
            BotChatSummary(
                id=chat.id,
                title=chat.title,
                filename=path.name,
                message_count=len(chat.messages),
                created_at=chat.created_at,
                updated_at=chat.updated_at,
            ),
        )

    def _summary(self, path: Path) -> BotChatSummary:
        st = path.stat()
        cached = self._summary_cache.get(path)
        if cached and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
            return cached[2]
        chat = BotChat.model_validate(json.loads(path.read_text(encoding="utf-8")))
        summary = BotChatSummary(
            id=chat.id,
            title=chat.title,
            filename=path.name,
            message_count=len(chat.messages),
            created_at=chat.created_at,
            updated_at=chat.updated_at,
        )
        self._summary_cache[path] = (st.st_mtime_ns, st.st_size, summary)
        return summary
