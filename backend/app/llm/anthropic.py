from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from backend.app.llm.base import GenerationRequest


class AnthropicProvider:
    """Adapter for Anthropic Claude `/v1/messages`."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout_seconds: float = 60.0,
        *,
        anthropic_version: str = "2023-06-01",
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/") or "https://api.anthropic.com/v1"
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self.anthropic_version = anthropic_version
        self.extra_headers = dict(extra_headers or {})

    async def status(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            try:
                response = await client.get(f"{self.base_url}/models", headers=self._headers())
            except httpx.HTTPError as error:
                return {"ok": False, "error": str(error)}
            if response.status_code >= 400:
                return {"ok": False, "status_code": response.status_code, "error": response.text}
            return {"ok": True, "models": response.json()}

    async def generate(self, request: GenerationRequest) -> str:
        body = self._request_body(request, stream=False)
        async with httpx.AsyncClient(timeout=self._timeout()) as client:
            response = await client.post(f"{self.base_url}/messages", headers=self._headers(), json=body)
            response.raise_for_status()
            data = response.json()
        content = self._extract_text(data)
        if not content.strip():
            raise RuntimeError("Anthropic returned an empty response")
        return content.strip()

    async def generate_stream(self, request: GenerationRequest) -> AsyncIterator[str]:
        body = self._request_body(request, stream=True)
        async with httpx.AsyncClient(timeout=self._timeout()) as client:
            async with client.stream("POST", f"{self.base_url}/messages", headers=self._headers(), json=body) as response:
                if response.status_code >= 400:
                    await response.aread()
                response.raise_for_status()
                data_lines: list[str] = []
                async for raw_line in response.aiter_lines():
                    stripped = raw_line.strip()
                    if not stripped:
                        if data_lines:
                            for token in self._tokens_from_data("\n".join(data_lines)):
                                yield token
                            data_lines.clear()
                        continue
                    if stripped.startswith(":") or stripped.startswith("event:"):
                        continue
                    if stripped.startswith("data:"):
                        data_lines.append(stripped[5:].strip())
                if data_lines:
                    for token in self._tokens_from_data("\n".join(data_lines)):
                        yield token

    def _request_body(self, request: GenerationRequest, stream: bool) -> dict[str, Any]:
        system_parts: list[str] = []
        messages: list[dict[str, Any]] = []
        for message in request.messages:
            if message.role == "system":
                if message.content.strip():
                    system_parts.append(message.content)
                continue
            role = "user" if message.role == "user" else "assistant"
            content = message.content or ""
            if not content.strip():
                continue
            if messages and messages[-1]["role"] == role:
                messages[-1]["content"] = f"{messages[-1]['content']}\n\n{content}"
            else:
                messages.append({"role": role, "content": content})

        # Anthropic requires non-empty user messages list
        if not messages or messages[0]["role"] != "user":
            messages.insert(0, {"role": "user", "content": "."})
        body: dict[str, Any] = {
            "model": request.model,
            "messages": messages,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "stream": stream,
        }
        if system_parts:
            body["system"] = "\n\n".join(system_parts)
        parameters = dict(request.parameters)
        for key in ("top_p", "top_k", "stop_sequences", "metadata"):
            if key in parameters and parameters[key] is not None:
                body[key] = parameters[key]
        return body

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {
            "Content-Type": "application/json",
            "anthropic-version": self.anthropic_version,
        }
        if self.api_key:
            headers["x-api-key"] = self.api_key
        for key, value in self.extra_headers.items():
            headers[key] = value
        return headers

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            connect=self.timeout_seconds,
            write=self.timeout_seconds,
            read=max(self.timeout_seconds, 300.0),
            pool=self.timeout_seconds,
        )

    def _tokens_from_data(self, payload: str) -> list[str]:
        if not payload or payload == "[DONE]":
            return []
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return []
        if data.get("type") == "content_block_delta":
            delta = data.get("delta") or {}
            text = delta.get("text") or delta.get("thinking") or delta.get("partial_json") or ""
            return [text] if isinstance(text, str) and text else []
        if data.get("type") == "message_delta":
            delta = data.get("delta") or {}
            text = delta.get("text") or ""
            return [text] if isinstance(text, str) and text else []
        return []
    def _extract_text(self, data: dict[str, Any]) -> str:
        parts = data.get("content") or []
        if isinstance(parts, list):
            chunks: list[str] = []
            for part in parts:
                if isinstance(part, dict) and part.get("type") in {"text", None}:
                    text = part.get("text") or ""
                    if isinstance(text, str):
                        chunks.append(text)
            return "".join(chunks)
        return ""
