from __future__ import annotations

from backend.app.models import Message, Participant, ParticipantRole, SendMessageRequest, Session, utc_now
from backend.app.storage.file_storage import FileStorage


DEFAULT_SESSION_ID = "default"


class SessionService:
    def __init__(self, storage: FileStorage) -> None:
        self.storage = storage
        self.sessions: dict[str, Session] = {}

    def get_or_create_session(self, session_id: str = DEFAULT_SESSION_ID) -> Session:
        clean_id = (session_id or DEFAULT_SESSION_ID).strip() or DEFAULT_SESSION_ID
        if clean_id not in self.sessions:
            self.sessions[clean_id] = Session(
                id=clean_id,
                title="Default Room" if clean_id == DEFAULT_SESSION_ID else f"Room: {clean_id}",
                messages=self.storage.load_messages(clean_id),
            )
        return self.sessions[clean_id]

    def list_rooms(self) -> list[dict[str, object]]:
        self.get_or_create_session(DEFAULT_SESSION_ID)
        rooms: list[dict[str, object]] = []
        for sid, sess in self.sessions.items():
            online_players = [
                p.persona_name or p.name
                for p in sess.participants.values()
                if p.connected and p.role == ParticipantRole.PLAYER
            ]
            rooms.append({
                "id": sid,
                "title": sess.title,
                "online_count": len(online_players),
                "online_players": online_players,
                "active_card_id": sess.active_card_id,
                "active_chat_id": sess.active_chat_id,
                "turn_mode": sess.turn.mode,
            })
        return rooms
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
        clean_username = username.strip()

        existing_by_username: Participant | None = None
        if clean_username:
            existing_by_username = next(
                (
                    p for p in session.participants.values()
                    if p.role == ParticipantRole.PLAYER and p.username and p.username.lower() == clean_username.lower()
                ),
                None,
            )

        target_id = participant_id
        if existing_by_username is not None:
            target_id = existing_by_username.id

        if target_id and target_id in session.participants:
            participant = session.participants[target_id]
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
            if clean_username or not participant.username:
                participant.username = clean_username
            participant.is_admin = is_admin
        else:
            participant = Participant(id=target_id, name=normalized_name) if target_id else Participant(name=normalized_name)
            participant.persona_id = persona_id.strip()
            participant.persona_name = persona_name.strip()
            participant.avatar_url = avatar_url.strip()
            participant.username = clean_username
            participant.is_admin = is_admin
            session.participants[participant.id] = participant

        # Remove any duplicate entries for the same logged-in username or superseded participant_id
        duplicate_ids: list[str] = []
        if participant_id and participant_id != participant.id and participant_id in session.participants:
            duplicate_ids.append(participant_id)
        if clean_username:
            for pid, p in list(session.participants.items()):
                if pid != participant.id and p.role == ParticipantRole.PLAYER and p.username and p.username.lower() == clean_username.lower():
                    if pid not in duplicate_ids:
                        duplicate_ids.append(pid)
        for dup_id in duplicate_ids:
            session.participants.pop(dup_id, None)
            while dup_id in session.turn.order:
                session.turn.order.remove(dup_id)
            while dup_id in session.turn.ready_participant_ids:
                session.turn.ready_participant_ids.remove(dup_id)
            if session.turn.current_participant_id == dup_id:
                session.turn.current_participant_id = participant.id

        if participant.id not in session.turn.order:
            session.turn.order.append(participant.id)
        cur = session.turn.current_participant_id
        if cur is None or not session.participants.get(cur) or not session.participants[cur].connected:
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
        if participant_id in session.turn.ready_participant_ids:
            session.turn.ready_participant_ids.remove(participant_id)
        if session.turn.current_participant_id == participant_id:
            self._advance_turn(session, participant_id)


    def prune_disconnected(self, session_id: str, active_pids: set[str]) -> None:
        session = self.get_or_create_session(session_id)
        for pid, p in list(session.participants.items()):
            if p.role == ParticipantRole.PLAYER and p.connected and pid not in active_pids:
                self.disconnect_participant(session_id, pid)
        seen_usernames: dict[str, str] = {}
        for pid, p in list(session.participants.items()):
            if p.role != ParticipantRole.PLAYER or not p.username:
                continue
            uname = p.username.lower()
            if uname in seen_usernames:
                keep_pid = seen_usernames[uname]
                if p.connected and not session.participants[keep_pid].connected:
                    session.participants.pop(keep_pid, None)
                    seen_usernames[uname] = pid
                else:
                    session.participants.pop(pid, None)
            else:
                seen_usernames[uname] = pid
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

    def advance_turn(self, session_id: str, participant_id: str, mark_ready: bool = False) -> bool:
        session = self.get_or_create_session(session_id)
        self._advance_turn(session, participant_id)
        if mark_ready:
            return self.mark_participant_ready(session_id, participant_id, ready=True)
        return False
    def set_turn_mode(self, session_id: str, mode: str) -> None:
        session = self.get_or_create_session(session_id)
        session.turn.mode = "round_ready" if mode == "round_ready" else "free"
        session.turn.ready_participant_ids = []

    def reset_round_ready(self, session_id: str) -> None:
        session = self.get_or_create_session(session_id)
        session.turn.ready_participant_ids = []

    def mark_participant_ready(self, session_id: str, participant_id: str, ready: bool = True) -> bool:
        session = self.get_or_create_session(session_id)
        if session.turn.mode != "round_ready" or not participant_id:
            return False
        if ready:
            if participant_id not in session.turn.ready_participant_ids:
                session.turn.ready_participant_ids.append(participant_id)
        else:
            if participant_id in session.turn.ready_participant_ids:
                session.turn.ready_participant_ids.remove(participant_id)
            return False
        connected_players = [
            pid for pid, p in session.participants.items()
            if p.connected and p.role == ParticipantRole.PLAYER
        ]
        if connected_players and all(pid in session.turn.ready_participant_ids for pid in connected_players):
            session.turn.ready_participant_ids = []
            return True
        return False

    def _advance_turn(self, session: Session, participant_id: str) -> None:
        if participant_id and participant_id not in session.turn.order:
            session.turn.order.append(participant_id)
        connected_order = [
            pid for pid in session.turn.order
            if pid in session.participants and session.participants[pid].connected and session.participants[pid].role == ParticipantRole.PLAYER
        ]
        if not connected_order:
            session.turn.current_participant_id = None
            return
        if participant_id in connected_order:
            next_index = (connected_order.index(participant_id) + 1) % len(connected_order)
            session.turn.current_participant_id = connected_order[next_index]
            return
        if participant_id in session.turn.order:
            start_idx = session.turn.order.index(participant_id)
            for offset in range(1, len(session.turn.order) + 1):
                candidate = session.turn.order[(start_idx + offset) % len(session.turn.order)]
                if candidate in connected_order:
                    session.turn.current_participant_id = candidate
                    return
        session.turn.current_participant_id = connected_order[0]
