from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from uuid import uuid4

from pydantic import BaseModel, Field


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ParticipantRole(StrEnum):
    PLAYER = "player"
    BOT = "bot"


class Participant(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    role: ParticipantRole = ParticipantRole.PLAYER
    connected: bool = True
    connected_at: datetime = Field(default_factory=utc_now)
    persona_id: str = ""
    persona_name: str = ""
    avatar_url: str = ""
    username: str = ""
    is_admin: bool = False


class Message(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    session_id: str
    participant_id: str
    participant_name: str
    role: ParticipantRole = ParticipantRole.PLAYER
    content: str
    created_at: datetime = Field(default_factory=utc_now)


class TurnState(BaseModel):
    current_participant_id: str | None = None
    order: list[str] = Field(default_factory=list)
    mode: str = "free"
    ready_participant_ids: list[str] = Field(default_factory=list)

class Session(BaseModel):
    id: str
    title: str
    participants: dict[str, Participant] = Field(default_factory=dict)
    messages: list[Message] = Field(default_factory=list)
    turn: TurnState = Field(default_factory=TurnState)
    active_card_id: str = ""
    active_chat_id: str = ""

class JoinSessionRequest(BaseModel):
    participant_id: str | None = None
    name: str


class SendMessageRequest(BaseModel):
    participant_id: str
    content: str


class ClientEvent(BaseModel):
    type: str
    participant_id: str | None = None
    source_participant_id: str | None = None
    card_id: str | None = None
    chat_id: str | None = None
    message_id: str | None = None
    name: str | None = None
    content: str | None = None
    persona_id: str | None = None
    persona_name: str | None = None
    avatar_url: str | None = None
    username: str | None = None
    is_admin: bool | None = None
    is_typing: bool | None = None
    turn_mode: str | None = None
    ready: bool | None = None
