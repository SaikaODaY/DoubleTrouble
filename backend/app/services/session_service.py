from __future__ import annotations

from backend.app.models import Message, Participant, ParticipantRole, SendMessageRequest, Session, utc_now
from backend.app.storage.file_storage import FileStorage


DEFAULT_SESSION_ID = "default"


class SessionService:
    def __init__(self, storage: FileStorage) -> None:
        self.storage = storage
        self.sessions: dict[str, Session] = {}

    def get_or_create_session(self, session_id: str = DEFAULT_SESSION_ID) -> Session:
        if session_id not in self.sessions:
            self.sessions[session_id] = Session(
                id=session_id,
                title="Default Session",
                messages=self.storage.load_messages(session_id),
            )
        return self.sessions[session_id]

    def join_session(
        self,
        session_id: str,
        name: str,
        participant_id: str | None = None,
        persona_id: str = "",
        persona_name: str = "",
        avatar_url: str = "",
        username: str = "",
        is_admin: bool = False,
    ) -> Participant:
        session = self.get_or_create_session(session_id)
        normalized_name = name.strip() or "Player"

        if participant_id and participant_id in session.participants:
            participant = session.participants[participant_id]
            next_persona_id = persona_id.strip()
            next_persona_name = persona_name.strip()
            next_avatar_url = avatar_url.strip()
            if not next_persona_id and not next_persona_name and not next_avatar_url and participant.persona_id:
                normalized_name = participant.name
            if not participant.connected:
                participant.connected_at = utc_now()
            participant.name = normalized_name
            participant.connected = True
            if next_persona_id or next_persona_name or next_avatar_url or not participant.persona_id:
                participant.persona_id = next_persona_id
                participant.persona_name = next_persona_name
                participant.avatar_url = next_avatar_url
            participant.username = username.strip()
            participant.is_admin = is_admin
            return participant

        participant = Participant(id=participant_id, name=normalized_name) if participant_id else Participant(name=normalized_name)
        participant.persona_id = persona_id.strip()
        participant.persona_name = persona_name.strip()
        participant.avatar_url = avatar_url.strip()
        participant.username = username.strip()
        participant.is_admin = is_admin
        session.participants[participant.id] = participant
        if participant.id not in session.turn.order:
            session.turn.order.append(participant.id)
        if session.turn.current_participant_id is None:
            session.turn.current_participant_id = participant.id
        return participant

    def update_presence(
        self,
        session_id: str,
        participant_id: str,
        name: str,
        persona_id: str = "",
        persona_name: str = "",
        avatar_url: str = "",
        username: str = "",
        is_admin: bool = False,
    ) -> Participant:
        return self.join_session(session_id, name, participant_id, persona_id, persona_name, avatar_url, username, is_admin)

    def disconnect_participant(self, session_id: str, participant_id: str) -> None:
        session = self.get_or_create_session(session_id)
        participant = session.participants.get(participant_id)
        if participant:
            participant.connected = False

    def add_message(self, session_id: str, request: SendMessageRequest) -> Message:
        session = self.get_or_create_session(session_id)
        participant = session.participants.get(request.participant_id)
        if participant is None:
            participant = self.join_session(session_id, "Player", request.participant_id)

        message = Message(
            session_id=session_id,
            participant_id=participant.id,
            participant_name=participant.name,
            role=participant.role,
            content=request.content.strip(),
        )
        session.messages.append(message)
        self.storage.append_message(message)
        self._advance_turn(session, participant.id)
        return message

    def add_bot_message(self, session_id: str, bot_name: str, content: str) -> Message:
        session = self.get_or_create_session(session_id)
        bot = next((participant for participant in session.participants.values() if participant.role == ParticipantRole.BOT and participant.name == bot_name), None)
        if bot is None:
            bot = Participant(name=bot_name, role=ParticipantRole.BOT, connected=True)
            session.participants[bot.id] = bot

        message = Message(
            session_id=session_id,
            participant_id=bot.id,
            participant_name=bot.name,
            role=ParticipantRole.BOT,
            content=content.strip(),
        )
        session.messages.append(message)
        self.storage.append_message(message)
        return message

    def set_active_chat(self, session_id: str, card_id: str, chat_id: str = "") -> None:
        session = self.get_or_create_session(session_id)
        if card_id:
            session.active_card_id = card_id
        if chat_id:
            session.active_chat_id = chat_id
        elif not card_id:
            session.active_chat_id = ""

    def snapshot(self, session_id: str) -> dict[str, object]:
        session = self.get_or_create_session(session_id)
        return session.model_dump(mode="json")

    def _advance_turn(self, session: Session, participant_id: str) -> None:
        if not session.turn.order:
            session.turn.current_participant_id = participant_id
            return

        try:
            current_index = session.turn.order.index(participant_id)
        except ValueError:
            session.turn.order.append(participant_id)
            current_index = len(session.turn.order) - 1

        next_index = (current_index + 1) % len(session.turn.order)
        session.turn.current_participant_id = session.turn.order[next_index]
