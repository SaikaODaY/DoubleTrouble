from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from backend.app.llm.base import GenerationRequest


class OpenAICompatibleProvider:
    def __init__(
        self,
        base_url: str,
        api_key: str = "",
        timeout_seconds: float = 60.0,
        *,
        chat_path: str = "/chat/completions",
        models_path: str = "/models",
        extra_headers: dict[str, str] | None = None,
        extra_query: dict[str, str] | None = None,
        extra_body: dict[str, Any] | None = None,
        auth_header: str = "Authorization",
        auth_format: str = "Bearer {api_key}",
        send_auth: bool = True,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self.chat_path = chat_path if chat_path.startswith("/") else f"/{chat_path}"
        self.models_path = models_path if models_path.startswith("/") else f"/{models_path}"
        self.extra_headers = dict(extra_headers or {})
        self.extra_query = dict(extra_query or {})
        self.extra_body = dict(extra_body or {})
        self.auth_header = auth_header
        self.auth_format = auth_format
        self.send_auth = send_auth

    async def status(self) -> dict[str, Any]:
        if not self.base_url:
            return {"ok": False, "error": "base_url is not configured"}

        headers = self._headers()
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            try:
                response = await client.get(f"{self.base_url}{self.models_path}", headers=headers, params=self.extra_query or None)
            except httpx.HTTPError as error:
                return {"ok": False, "error": str(error)}
            if response.status_code >= 400:
                return {"ok": False, "status_code": response.status_code, "error": response.text}
            return {"ok": True, "models": response.json()}

    async def generate(self, request: GenerationRequest) -> str:
        if not self.base_url:
            raise RuntimeError("LLM provider base_url is not configured")
        if not request.model:
            raise RuntimeError("LLM model is not configured")

        body = self._request_body(request, stream=False)
        async with httpx.AsyncClient(timeout=self._timeout()) as client:
            response = await client.post(
                f"{self.base_url}{self.chat_path}",
                headers=self._headers(),
                json=body,
                params=self.extra_query or None,
            )
            response.raise_for_status()
            data = response.json()

        show_thoughts = request.parameters.get("__show_thoughts", True) is not False
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        content = message.get("content") or choice.get("text") or ""
        reasoning = (message.get("reasoning_content") or message.get("reasoning") or "") if show_thoughts else ""
        if isinstance(reasoning, str) and reasoning.strip() and "<think>" not in str(content):
            content = f"<think>\n{reasoning.strip()}\n</think>\n\n{content or ''}"
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("LLM provider returned an empty response")
        return content.strip()

    async def generate_stream(self, request: GenerationRequest) -> AsyncIterator[str]:
        if not self.base_url:
            raise RuntimeError("LLM provider base_url is not configured")
        if not request.model:
            raise RuntimeError("LLM model is not configured")

        body = self._request_body(request, stream=True)
        stream_headers = {
            **self._headers(),
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache",
        }
        async with httpx.AsyncClient(timeout=self._timeout()) as client:
            async with client.stream(
                "POST",
                f"{self.base_url}{self.chat_path}",
                headers=stream_headers,
                json=body,
                params=self.extra_query or None,
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                response.raise_for_status()
                show_thoughts = request.parameters.get("__show_thoughts", True) is not False
                emitted = False
                in_reasoning = False
                raw_lines: list[str] = []
                async for line in response.aiter_lines():
                    raw_lines.append(line)
                    stripped = line.strip()
                    if not stripped or stripped.startswith(":"):
                        continue
                    r_tok, c_tok = self._stream_parts(stripped)
                    if show_thoughts and r_tok:
                        if not in_reasoning:
                            in_reasoning = True
                            yield "<think>\n"
                        emitted = True
                        yield r_tok
                    if c_tok:
                        if in_reasoning:
                            in_reasoning = False
                            yield "\n</think>\n\n"
                        emitted = True
                        yield c_tok
                if in_reasoning:
                    in_reasoning = False
                    yield "\n</think>\n\n"
                if not emitted and raw_lines:
                    joined = "\n".join(raw_lines)
                    for event in self._remaining_stream_events(joined):
                        token = self._stream_token(event)
                        if token:
                            emitted = True
                            yield token
                    if not emitted:
                        content = self._content_from_non_stream_payload(joined)
                        if content:
                            yield content
    def _request_body(self, request: GenerationRequest, stream: bool) -> dict[str, Any]:
        parameters = dict(request.parameters)
        parameters.pop("__show_thoughts", None)
        excluded_body_keys = {str(key) for key in parameters.pop("__exclude_body_keys", [])}
        body: dict[str, Any] = {
            "model": request.model,
            "messages": [self._message_to_dict(message) for message in request.messages],
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
        }
        body.update(parameters)
        for key, value in self.extra_body.items():
            body[key] = value
        body["stream"] = stream
        for key in excluded_body_keys:
            body.pop(key, None)
        return body

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.timeout_seconds,
            write=self.timeout_seconds,
            read=max(self.timeout_seconds, 300.0),
            pool=self.timeout_seconds,
        )

    def _split_sse_events(self, text: str) -> tuple[list[str], str]:
        events: list[str] = []
        start = 0
        index = 0
        while index < len(text):
            separator_length = 0
            if text.startswith("\r\n\r\n", index):
                separator_length = 4
            elif text.startswith("\n\n", index) or text.startswith("\r\r", index):
                separator_length = 2
            if separator_length:
                events.append(text[start:index])
                index += separator_length
                start = index
                continue
            index += 1
        return events, text[start:]

    def _split_line_events(self, text: str) -> tuple[list[str], str]:
        if not text:
            return [], text

        events: list[str] = []
        lines = text.splitlines(keepends=True)
        complete_count = len(lines)
        if lines and not lines[-1].endswith(("\n", "\r")):
            complete_count -= 1
        for index, line in enumerate(lines[:complete_count]):
            stripped = line.strip()
            if not stripped:
                continue
            if self._is_complete_stream_event(stripped):
                events.append(stripped)
                continue
            return events, "".join(lines[index:])
        return events, "".join(lines[complete_count:])

    def _is_complete_stream_event(self, event: str) -> bool:
        payload = self._event_data(event)
        if not payload or payload == "[DONE]":
            return True
        try:
            json.loads(payload)
        except json.JSONDecodeError:
            return False
        return True

    def _remaining_stream_events(self, text: str) -> list[str]:
        stripped = text.strip()
        if not stripped:
            return []
        if "data:" in stripped or stripped.startswith("event:"):
            return [stripped]
        return stripped.splitlines()

    def _stream_token(self, event: str) -> str:
        payload = self._event_data(event)
        if not payload or payload == "[DONE]":
            return ""
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return ""
        return self._stream_content(data)

    def _event_data(self, event: str) -> str:
        data_lines: list[str] = []
        raw_lines = event.splitlines()
        for line in raw_lines:
            stripped = line.strip()
            if not stripped or stripped.startswith(":"):
                continue
            if stripped.startswith("data:"):
                data_lines.append(stripped[5:].strip())
        if data_lines:
            return "\n".join(data_lines).strip()
        return event.strip()

    def _stream_parts(self, event: str) -> tuple[str, str]:
        payload = self._event_data(event)
        if not payload or payload == "[DONE]":
            return "", ""
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return "", ""
        choice = (data.get("choices") or [{}])[0]
        choice = choice if isinstance(choice, dict) else {}
        delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
        reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
        reasoning_str = reasoning if isinstance(reasoning, str) else ""
        return reasoning_str, self._stream_content(data)

    def _stream_content(self, data: dict[str, Any]) -> str:
        choice = (data.get("choices") or [{}])[0]
        choice = choice if isinstance(choice, dict) else {}
        delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
        root_delta = data.get("delta") if isinstance(data.get("delta"), dict) else {}
        delta_message = root_delta.get("message") if isinstance(root_delta.get("message"), dict) else {}
        delta_message_content = delta_message.get("content") if isinstance(delta_message.get("content"), dict) else {}
        content = (
            delta.get("content")
            or delta.get("text")
            or root_delta.get("text")
            or delta_message_content.get("text")
            or delta_message.get("tool_plan")
            or choice.get("message", {}).get("content")
            or choice.get("text")
            or data.get("text")
            or self._candidate_text(data)
            or ""
        )
        if isinstance(content, list):
            return "".join(str(item.get("text") or "") if isinstance(item, dict) else str(item) for item in content)
        return content if isinstance(content, str) else ""
    def _candidate_text(self, data: dict[str, Any]) -> str:
        parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
        return "".join(str(part.get("text") or "") for part in parts if isinstance(part, dict) and not part.get("thought"))

    def _content_from_non_stream_payload(self, text: str) -> str:
        payload = text.strip()
        if not payload:
            return ""
        if payload.startswith("data:"):
            payload = "\n".join(line[5:].strip() for line in payload.splitlines() if line.startswith("data:") and line[5:].strip() != "[DONE]")
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return ""
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        content = message.get("content") or choice.get("text") or data.get("text") or self._candidate_text(data)
        return content if isinstance(content, str) else ""

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.send_auth and self.api_key:
            headers[self.auth_header] = self.auth_format.format(api_key=self.api_key)
        for key, value in self.extra_headers.items():
            headers[key] = value
        return headers

    def _message_to_dict(self, message: Any) -> dict[str, str]:
        data = {"role": message.role, "content": message.content}
        if message.name:
            data["name"] = message.name
        return data
