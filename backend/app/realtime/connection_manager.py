from __future__ import annotations

import asyncio
from collections import defaultdict

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[str, set[WebSocket]] = defaultdict(set)
        self.socket_participants: dict[tuple[str, WebSocket], str] = {}

    async def connect(self, session_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections[session_id].add(websocket)

    def bind_participant(self, session_id: str, websocket: WebSocket, participant_id: str) -> None:
        if participant_id:
            self.socket_participants[(session_id, websocket)] = participant_id

    def rebind_participant(self, session_id: str, old_participant_id: str, new_participant_id: str) -> None:
        if not old_participant_id or not new_participant_id or old_participant_id == new_participant_id:
            return
        for key, pid in list(self.socket_participants.items()):
            if key[0] == session_id and pid == old_participant_id:
                self.socket_participants[key] = new_participant_id

    def active_participant_ids(self, session_id: str) -> set[str]:
        active: set[str] = set()
        for ws in list(self.connections.get(session_id, ())):
            pid = self.socket_participants.get((session_id, ws))
            if pid:
                active.add(pid)
        return active

    def has_other_connections(self, session_id: str, participant_id: str, exclude_websocket: WebSocket | None = None) -> bool:
        if not participant_id:
            return False
        for ws in list(self.connections.get(session_id, ())):
            if ws is exclude_websocket:
                continue
            if self.socket_participants.get((session_id, ws)) == participant_id:
                return True
        return False
    def disconnect(self, session_id: str, websocket: WebSocket) -> str | None:
        participant_id = self.socket_participants.pop((session_id, websocket), None)
        if session_id in self.connections:
            self.connections[session_id].discard(websocket)
            if not self.connections[session_id]:
                del self.connections[session_id]
        return participant_id

    async def _send_one(self, session_id: str, websocket: WebSocket, event: dict[str, object]) -> WebSocket | None:
        try:
            await asyncio.wait_for(websocket.send_json(event), timeout=1.5)
            return None
        except Exception:
            return websocket

    async def broadcast(self, session_id: str, event: dict[str, object]) -> None:
        sockets = list(self.connections.get(session_id, ()))
        if not sockets:
            return
        results = await asyncio.gather(*(self._send_one(session_id, ws, event) for ws in sockets), return_exceptions=True)
        for result in results:
            if isinstance(result, WebSocket):
                self.disconnect(session_id, result)
