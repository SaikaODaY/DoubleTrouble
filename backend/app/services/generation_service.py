from __future__ import annotations

from datetime import datetime
import json
import random
import re
from collections.abc import Awaitable, Callable
from typing import Any
import yaml

from backend.app.config import GenerationConfig, SummaryMemoryConfig
from backend.app.llm.base import ChatMessage, GenerationRequest
from backend.app.llm.chat_completion_sources import build_provider, get_source, resolve_source_id
from backend.app.llm.openai_compatible import OpenAICompatibleProvider
from backend.app.models import Message, ParticipantRole
from backend.app.secrets import SecretStore
from backend.app.services.session_service import SessionService
from backend.app.services.bot_chats_service import BotChatMessage


class GenerationService:
    def __init__(self, config: GenerationConfig, secret_store: SecretStore, session_service: SessionService) -> None:
        self.config = config
        self.secret_store = secret_store
        self.session_service = session_service

    def is_enabled(self) -> bool:
        return self.config.provider != "disabled"

    def update_config(self, config: GenerationConfig) -> None:
        self.config = config

    async def status(self) -> dict[str, Any]:
        if not self.is_enabled():
            return {"ok": False, "provider": self.config.provider, "error": "generation provider is disabled"}
        return await self._provider().status()

    async def raw_generate(self, messages: list[ChatMessage], max_tokens: int | None = None, temperature: float | None = None) -> str:
        if not self.is_enabled():
            raise RuntimeError("Generation provider is disabled. Configure it in the frontend settings first.")

        request = GenerationRequest(
            model=self.config.model,
            messages=messages,
            temperature=temperature if temperature is not None else self.config.temperature,
            max_tokens=max_tokens if max_tokens is not None else self.config.max_tokens,
            parameters=self.config.parameters,
        )
        return await self._provider().generate(request)

    async def raw_generate_with_config(self, messages: list[ChatMessage], config: GenerationConfig) -> str:
        request = GenerationRequest(
            model=config.model,
            messages=messages,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
            parameters=config.parameters,
        )
        provider = self._build_provider_for_config(config)
        return await provider.generate(request)

    def _build_provider_for_config(self, config: GenerationConfig):
        if config.provider == "disabled":
            raise RuntimeError("Unsupported generation provider: disabled")
        source_id = config.chat_completion_source or resolve_source_id(config.provider)
        source = get_source(source_id)
        api_key = ""
        if config.api_key_secret and config.api_key_secret != "provider_api_key":
            api_key = self.secret_store.read(config.api_key_secret, config.api_key_env)
        if not api_key and source and source.secret_key_name:
            api_key = self.secret_store.read(source.secret_key_name, source.api_key_env)
        if not api_key:
            api_key = self.secret_store.read(config.api_key_secret, config.api_key_env)
        proxy_password = self.secret_store.read(config.proxy_password_secret, "") if config.reverse_proxy else ""
        return build_provider(
            source_id,
            base_url=config.base_url,
            api_key=api_key,
            timeout_seconds=config.timeout_seconds,
            extra_settings=(config.source_settings or {}).get(source_id, {}),
            reverse_proxy=config.reverse_proxy,
            proxy_password=proxy_password,
        )


    async def generate_chat_summary(
        self,
        memory_config: SummaryMemoryConfig,
        existing_summary: str,
        messages_to_summarize: list[BotChatMessage],
        character_name: str,
    ) -> str:
        lines: list[str] = []
        for msg in messages_to_summarize:
            if msg.hidden or getattr(msg, "is_ooc", False):
                continue
            speaker = character_name if msg.role == "assistant" else (msg.author or "Player")
            prefix = f"[Secret] {speaker}" if getattr(msg, "is_secret", False) else speaker
            lines.append(f"{prefix}: {msg.content.strip()}")
        transcript = "\n\n".join(lines).strip()
        if not transcript and not existing_summary.strip():
            return ""
        sys_prompt = (memory_config.prompt or "").strip() or (
            "Summarize the key events, character relationships, important decisions, inventory/state changes, "
            "and current situation from the roleplay conversation. Write in the same language as the chat."
        )
        user_parts: list[str] = []
        if existing_summary.strip():
            user_parts.append(f"Existing chronicle / memory so far:\n{existing_summary.strip()}")
        if transcript:
            user_parts.append(f"New roleplay messages to integrate into the chronicle:\n{transcript}")
        user_parts.append("Provide only the updated, unified chronicle without meta-commentary.")
        prompt_messages = [
            ChatMessage(role="system", content=sys_prompt),
            ChatMessage(role="user", content="\n\n---\n\n".join(user_parts)),
        ]
        if memory_config.use_separate_api:
            sum_config = GenerationConfig(
                provider=memory_config.provider or "openai-compatible",
                chat_completion_source=memory_config.chat_completion_source or "custom",
                base_url=memory_config.base_url,
                model=memory_config.model or self.config.model,
                api_key_secret=memory_config.api_key_secret or "summary_api_key",
                api_key_env="",
                temperature=memory_config.temperature,
                max_tokens=memory_config.max_tokens,
                timeout_seconds=self.config.timeout_seconds,
            )
            return (await self.raw_generate_with_config(prompt_messages, sum_config)).strip()
        if not self.is_enabled():
            raise RuntimeError("Generation provider is disabled.")
        request = GenerationRequest(
            model=memory_config.model.strip() or self.config.model,
            messages=prompt_messages,
            temperature=memory_config.temperature,
            max_tokens=memory_config.max_tokens,
            parameters={},
        )
        return (await self._provider().generate(request)).strip()
    async def generate_reply(self, session_id: str) -> Message:
        if not self.is_enabled():
            raise RuntimeError("Generation provider is disabled. Configure it in the frontend settings first.")

        session = self.session_service.get_or_create_session(session_id)
        messages = self._build_messages(session.messages)
        request = GenerationRequest(
            model=self.config.model,
            messages=messages,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            parameters=self.config.parameters,
        )
        reply = await self._provider().generate(request)
        return self.session_service.add_bot_message(session_id, self.config.bot_name, reply)

    async def generate_chat_reply(self, character_name: str, history: list[BotChatMessage], openai_preset: dict[str, Any] | None = None, character_data: dict[str, Any] | None = None, persona_name: str | None = None, persona_description: str | None = None, world_info: dict[str, Any] | None = None, multi_user_mode: bool = False) -> str:
        if not self.is_enabled():
            raise RuntimeError("Generation provider is disabled. Configure it in the frontend settings first.")

        request = GenerationRequest(
            model=self._preset_model(openai_preset) or self.config.model,
            messages=self._with_assistant_prefill(self._build_bot_chat_messages(character_name, history, openai_preset, character_data, persona_name, persona_description, world_info, multi_user_mode), openai_preset),
            temperature=self._number_from_preset(openai_preset, "temperature", self.config.temperature),
            max_tokens=self._int_from_preset(openai_preset, "openai_max_tokens", self._int_from_preset(openai_preset, "max_tokens", self.config.max_tokens)),
            parameters={**self.config.parameters, **self._parameters_from_openai_preset(openai_preset)},
        )
        reply = await self._provider().generate(request)
        prefill = self._assistant_prefill(openai_preset)
        if prefill and not reply.startswith(prefill):
            return f"{prefill}{reply}"
        return reply

    def should_stream_chat_reply(self, openai_preset: dict[str, Any] | None = None) -> bool:
        return self._bool_from_preset(openai_preset, "stream_openai", True)
    async def generate_chat_reply_stream(self, character_name: str, history: list[BotChatMessage], openai_preset: dict[str, Any] | None, character_data: dict[str, Any] | None, persona_name: str | None, persona_description: str | None, world_info: dict[str, Any] | None, multi_user_mode: bool, on_update: Callable[[str], Awaitable[None]]) -> str:
        if not self.is_enabled():
            raise RuntimeError("Generation provider is disabled. Configure it in the frontend settings first.")

        request = GenerationRequest(
            model=self._preset_model(openai_preset) or self.config.model,
            messages=self._with_assistant_prefill(self._build_bot_chat_messages(character_name, history, openai_preset, character_data, persona_name, persona_description, world_info, multi_user_mode), openai_preset),
            temperature=self._number_from_preset(openai_preset, "temperature", self.config.temperature),
            max_tokens=self._int_from_preset(openai_preset, "openai_max_tokens", self._int_from_preset(openai_preset, "max_tokens", self.config.max_tokens)),
            parameters={**self.config.parameters, **self._parameters_from_openai_preset(openai_preset)},
        )
        chunks: list[str] = []
        async for token in self._provider().generate_stream(request):
            chunks.append(token)
            await on_update("".join(chunks))
        reply = "".join(chunks).strip()
        if not reply:
            raise RuntimeError("LLM provider returned an empty response")
        prefill = self._assistant_prefill(openai_preset)
        if prefill and not reply.startswith(prefill):
            reply = f"{prefill}{reply}"
            await on_update(reply)
        return reply

    def _provider(self):
        if self.config.provider == "disabled":
            raise RuntimeError("Unsupported generation provider: disabled")
        source_id = self.config.chat_completion_source or resolve_source_id(self.config.provider)
        source = get_source(source_id)
        api_key = ""
        if source and source.secret_key_name:
            api_key = self.secret_store.read(source.secret_key_name, source.api_key_env)
        if not api_key:
            api_key = self.secret_store.read(self.config.api_key_secret, self.config.api_key_env)
        proxy_password = self.secret_store.read(self.config.proxy_password_secret, "") if self.config.reverse_proxy else ""
        return build_provider(
            source_id,
            base_url=self.config.base_url,
            api_key=api_key,
            timeout_seconds=self.config.timeout_seconds,
            extra_settings=(self.config.source_settings or {}).get(source_id, {}),
            reverse_proxy=self.config.reverse_proxy,
            proxy_password=proxy_password,
        )

    def _preset_model(self, preset: dict[str, Any] | None) -> str:
        if not isinstance(preset, dict):
            return ""
        for key in ("custom_model", "openai_model", "openrouter_model", "claude_model", "google_model", "mistralai_model", "chutes_model", "electronhub_model", "ai21_model", "vertexai_model"):
            value = str(preset.get(key) or "").strip()
            if value and value != "OR_Website":
                return value
        return ""

    def _number_from_preset(self, preset: dict[str, Any] | None, key: str, fallback: float) -> float:
        if not isinstance(preset, dict) or preset.get(key) in (None, ""):
            return fallback
        try:
            return float(preset[key])
        except (TypeError, ValueError):
            return fallback

    def _int_from_preset(self, preset: dict[str, Any] | None, key: str, fallback: int) -> int:
        if not isinstance(preset, dict) or preset.get(key) in (None, ""):
            return fallback
        try:
            return int(preset[key])
        except (TypeError, ValueError):
            return fallback

    def _bool_from_preset(self, preset: dict[str, Any] | None, key: str, fallback: bool) -> bool:
        if not isinstance(preset, dict) or preset.get(key) in (None, ""):
            return fallback
        value = preset[key]
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    def _parameters_from_openai_preset(self, preset: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(preset, dict):
            return {}
        parameters: dict[str, Any] = {}
        for key in ("frequency_penalty", "presence_penalty", "top_p", "top_k", "top_a", "min_p", "repetition_penalty", "stop", "response_format"):
            if preset.get(key) not in (None, ""):
                parameters[key] = preset[key]
        if self._int_from_preset(preset, "seed", -1) >= 0:
            parameters["seed"] = self._int_from_preset(preset, "seed", -1)
        if self._int_from_preset(preset, "n", 1) > 1:
            parameters["n"] = self._int_from_preset(preset, "n", 1)
        for key in ("reasoning_effort", "verbosity"):
            value = str(preset.get(key) or "").strip()
            if value and value not in {"auto", "disabled"}:
                parameters[key] = value
        custom_body = self._custom_body(preset.get("custom_include_body"))
        if custom_body:
            parameters.update(custom_body)
        excluded = self._excluded_body_keys(preset.get("custom_exclude_body"))
        if excluded:
            parameters["__exclude_body_keys"] = excluded
        return parameters

    def _custom_body(self, raw_value: Any) -> dict[str, Any]:
        if isinstance(raw_value, dict):
            return raw_value
        if not isinstance(raw_value, str) or not raw_value.strip():
            return {}
        try:
            parsed = json.loads(raw_value)
        except json.JSONDecodeError:
            try:
                parsed = yaml.safe_load(raw_value)
            except yaml.YAMLError:
                return {}
        return parsed if isinstance(parsed, dict) else {}

    def _excluded_body_keys(self, raw_value: Any) -> list[str]:
        if isinstance(raw_value, list):
            return [str(item).strip() for item in raw_value if str(item).strip()]
        if not isinstance(raw_value, str) or not raw_value.strip():
            return []
        try:
            parsed = json.loads(raw_value)
        except json.JSONDecodeError:
            try:
                parsed = yaml.safe_load(raw_value)
            except yaml.YAMLError:
                parsed = raw_value.split(",")
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
        if isinstance(parsed, str):
            return [item.strip() for item in parsed.split(",") if item.strip()]
        return []

    def _build_messages(self, history: list[Message]) -> list[ChatMessage]:
        messages = [ChatMessage(role="system", content=self.config.system_prompt)] if self.config.system_prompt else []
        visible_history = [message for message in history if not message.hidden]
        for message in visible_history[-40:]:
            role = "assistant" if message.role == ParticipantRole.BOT else "user"
            content = f"{message.participant_name}: {message.content}" if role == "user" else message.content
            messages.append(ChatMessage(role=role, content=content))
        if len(messages) == 1:
            messages.append(ChatMessage(role="user", content="Begin the scene."))
        return messages

    def _build_bot_chat_messages(self, character_name: str, history: list[BotChatMessage], openai_preset: dict[str, Any] | None = None, character_data: dict[str, Any] | None = None, persona_name: str | None = None, persona_description: str | None = None, world_info: dict[str, Any] | None = None, multi_user_mode: bool = False) -> list[ChatMessage]:
        visible_history = [message for message in history if not message.hidden and not getattr(message, "is_ooc", False)]
        persona_name = persona_name or next((message.author for message in reversed(visible_history) if message.role == "user" and message.author), "User")
        history_messages = self._history_messages(visible_history, openai_preset, multi_user_mode, character_name, persona_name)
        messages = self._tavern_openai_messages(openai_preset, character_name, persona_name, persona_description or "", character_data or {}, history_messages, world_info or {})
        if not messages:
            messages = self._default_prompt_assembly(character_name, persona_name, persona_description or "", character_data or {}, history_messages, world_info or {})
        if len(messages) == 1 and not history_messages:
            messages.append(ChatMessage(role="user", content="Begin the scene."))
        if isinstance(openai_preset, dict) and bool(openai_preset.get("squash_system_messages")):
            messages = self._squash_system_messages(messages)
        return self._pack_tavern_messages(messages)

    def _default_prompt_assembly(self, character_name: str, persona_name: str, persona_description: str, character_data: dict[str, Any], history_messages: list[ChatMessage], world_info: dict[str, Any]) -> list[ChatMessage]:
        result: list[ChatMessage] = []
        parts: list[str] = []
        char_sys = self._substitute_prompt(str(character_data.get("system_prompt") or "").strip(), character_name, persona_name)
        description = self._substitute_prompt(str(character_data.get("description") or "").strip(), character_name, persona_name)
        personality = self._substitute_prompt(str(character_data.get("personality") or "").strip(), character_name, persona_name)
        scenario = self._substitute_prompt(str(character_data.get("scenario") or "").strip(), character_name, persona_name)
        substituted_persona = self._substitute_prompt(persona_description, character_name, persona_name)
        if char_sys:
            parts.append(char_sys)
        if description:
            parts.append(description)
        if personality:
            parts.append(personality)
        if scenario:
            parts.append(scenario)
        if substituted_persona:
            parts.append(substituted_persona)
        world_before = self._substitute_prompt(str(world_info.get("worldInfoBefore") or "").strip(), character_name, persona_name)
        if world_before:
            parts.append(world_before)
        if parts:
            result.append(ChatMessage(role="system", content="\n\n".join(parts)))
        examples = self._dialogue_example_messages(character_data, {}, character_name, persona_name)
        result.extend(examples)
        result.extend(history_messages)
        world_after = self._substitute_prompt(str(world_info.get("worldInfoAfter") or "").strip(), character_name, persona_name)
        if world_after:
            result.append(ChatMessage(role="system", content=world_after))
        post_hist = self._substitute_prompt(str(character_data.get("post_history_instructions") or "").strip(), character_name, persona_name)
        if post_hist:
            result.append(ChatMessage(role="system", content=post_hist))
        return result

    def _history_messages(self, history: list[BotChatMessage], preset: dict[str, Any] | None = None, force_user_names: bool = False, character_name: str = "", persona_name: str = "") -> list[ChatMessage]:
        messages: list[ChatMessage] = []
        names_behavior = self._int_from_preset(preset, "names_behavior", 0)
        max_context = self._int_from_preset(preset, "openai_max_context", 0)
        max_gen = self._int_from_preset(preset, "openai_max_tokens", self._int_from_preset(preset, "max_tokens", self.config.max_tokens))
        char_budget = max(2000, int((max_context - max_gen - 900) * 3.5)) if max_context > 0 else 0
        selected_history: list[BotChatMessage] = []
        used_chars = 0
        for message in reversed(history[-200:]):
            msg_len = len(message.content or "") + len(message.author or "") + 8
            if char_budget > 0 and selected_history and (used_chars + msg_len > char_budget):
                break
            selected_history.append(message)
            used_chars += msg_len
            if char_budget == 0 and len(selected_history) >= 60:
                break
        selected_history.reverse()
        for message in selected_history:
            role = "assistant" if message.role == "assistant" else "user"
            msg_user = (message.author or persona_name) if role == "user" else persona_name
            content = self._substitute_prompt(message.content, character_name, msg_user)
            name = None
            if getattr(message, "is_secret", False) and not getattr(message, "secret_revealed", False) and role == "user":
                content = f"[Secret action by {message.author or 'Player'} (hidden from other players): {content}]"
            elif getattr(message, "is_dice_roll", False) and role == "user":
                content = f"[Dice Roll] {content}"
            elif (force_user_names or names_behavior == 2) and role == "user" and message.author:
                prefix = f"{message.author}:"
                if not content.startswith(prefix):
                    content = f"{message.author}: {content}"
            elif names_behavior == 1 and message.author:
                name = self._sanitize_openai_name(message.author)
            messages.append(ChatMessage(role=role, content=content, name=name))
        return messages
    def _tavern_openai_messages(self, preset: dict[str, Any] | None, character_name: str, persona_name: str, persona_description: str, character_data: dict[str, Any], history_messages: list[ChatMessage], world_info: dict[str, Any]) -> list[ChatMessage]:
        if not isinstance(preset, dict):
            return []

        prompts = self._prompt_collection(preset, character_data, persona_description)
        if not prompts:
            return []

        messages: list[ChatMessage] = []
        absolute_prompts = [prompt for prompt in prompts if self._int_value(prompt.get("injection_position"), 0) == 1 and self._prompt_content(prompt, character_name, persona_name, persona_description, character_data, preset, world_info)]
        for prompt in world_info.get("depthPrompts") or []:
            if isinstance(prompt, dict) and str(prompt.get("content") or "").strip():
                absolute_prompts.append({"role": prompt.get("role") or "system", "content": prompt.get("content"), "injection_position": 1, "injection_depth": prompt.get("injection_depth") if prompt.get("injection_depth") is not None else 4, "injection_order": prompt.get("injection_order") or 100})
        char_ext = character_data.get("extensions") if isinstance(character_data.get("extensions"), dict) else {}
        depth_prompt = char_ext.get("depth_prompt") if isinstance(char_ext, dict) else None
        if isinstance(depth_prompt, dict) and str(depth_prompt.get("prompt") or "").strip():
            dp_role = str(depth_prompt.get("role") or "system").lower()
            if dp_role not in {"system", "user", "assistant"}:
                dp_role = "system"
            absolute_prompts.append({"role": dp_role, "content": str(depth_prompt.get("prompt")).strip(), "injection_position": 1, "injection_depth": self._int_value(depth_prompt.get("depth"), 4), "injection_order": 100})
        for ext_prompt in world_info.get("extensionPrompts") or []:
            if isinstance(ext_prompt, dict) and str(ext_prompt.get("value") or ext_prompt.get("content") or "").strip():
                ep_text = str(ext_prompt.get("value") or ext_prompt.get("content")).strip()
                ep_role_raw = ext_prompt.get("role", 0)
                ep_role = "user" if ep_role_raw in (1, "1", "user") else "assistant" if ep_role_raw in (2, "2", "assistant") else "system"
                ep_pos = self._int_value(ext_prompt.get("position"), 0)
                if ep_pos == 1:  # BEFORE_PROMPT
                    messages.append(ChatMessage(role=ep_role, content=self._substitute_prompt(ep_text, character_name, persona_name)))
                else:
                    absolute_prompts.append({"role": ep_role, "content": ep_text, "injection_position": 1, "injection_depth": self._int_value(ext_prompt.get("depth"), 4), "injection_order": 100})
        inserted_history = False
        for prompt in prompts:
            identifier = str(prompt.get("identifier") or "")
            if self._int_value(prompt.get("injection_position"), 0) == 1:
                continue
            if identifier == "chatHistory":
                messages.extend(self._with_tavern_in_chat_injections(history_messages, absolute_prompts, character_name, persona_name, persona_description, character_data, preset, world_info))
                inserted_history = True
                continue
            if identifier == "dialogueExamples":
                messages.extend(self._dialogue_example_messages(character_data, preset, character_name, persona_name))
                continue
            content = self._prompt_content(prompt, character_name, persona_name, persona_description, character_data, preset, world_info)
            if content:
                messages.append(ChatMessage(role=self._prompt_role(prompt), content=content))

        if not inserted_history:
            messages.extend(self._with_tavern_in_chat_injections(history_messages, absolute_prompts, character_name, persona_name, persona_description, character_data, preset, world_info))
        return messages

    def _prompt_collection(self, preset: dict[str, Any], character_data: dict[str, Any], persona_description: str) -> list[dict[str, Any]]:
        raw_prompts = [dict(prompt) for prompt in preset.get("prompts", []) if isinstance(prompt, dict)]
        prompt_by_id = {str(prompt.get("identifier") or ""): prompt for prompt in raw_prompts}
        order = self._prompt_order(preset.get("prompt_order"))
        collection: list[dict[str, Any]] = []

        if order:
            ordered_ids: set[str] = set()
            for entry in order:
                identifier = str(entry.get("identifier") or "")
                if identifier:
                    ordered_ids.add(identifier)
                prompt = dict(prompt_by_id.get(identifier) or {})
                if not prompt:
                    continue
                if entry.get("enabled") is not False and self._should_trigger(prompt):
                    collection.append(prompt)
                elif identifier == "main":
                    prompt["content"] = ""
                    collection.append(prompt)
            for prompt in raw_prompts:
                identifier = str(prompt.get("identifier") or "")
                if identifier and identifier not in ordered_ids and prompt.get("enabled") is not False and self._should_trigger(prompt):
                    collection.append(prompt)
        else:
            collection = [prompt for prompt in raw_prompts if prompt.get("enabled") is not False and self._should_trigger(prompt)]

        known_markers = {
            "charDescription": str(character_data.get("description") or ""),
            "charPersonality": self._format_template(str(preset.get("personality_format") or "{{personality}}"), "personality", str(character_data.get("personality") or "")),
            "scenario": self._format_template(str(preset.get("scenario_format") or "{{scenario}}"), "scenario", str(character_data.get("scenario") or "")),
            "personaDescription": persona_description,
            "worldInfoBefore": "",
            "worldInfoAfter": "",
            "dialogueExamples": str(character_data.get("mes_example") or ""),
        }
        existing_ids = {str(prompt.get("identifier") or "") for prompt in collection}
        for identifier, content in known_markers.items():
            if identifier not in existing_ids:
                collection.append({"identifier": identifier, "role": "system", "content": content, "system_prompt": True, "marker": True})
        if "chatHistory" not in existing_ids:
            collection.append({"identifier": "chatHistory", "role": "system", "content": "", "system_prompt": True, "marker": True})
        return collection

    def _should_trigger(self, prompt: dict[str, Any]) -> bool:
        triggers = prompt.get("injection_trigger")
        if not isinstance(triggers, list) or not triggers:
            return True
        return "normal" in {str(trigger).lower() for trigger in triggers}

    def _prompt_content(self, prompt: dict[str, Any], character_name: str, persona_name: str, persona_description: str, character_data: dict[str, Any], preset: dict[str, Any], world_info: dict[str, Any] | None = None) -> str:
        identifier = str(prompt.get("identifier") or "")
        if prompt.get("marker") is True:
            content = self._marker_content(identifier, character_data, persona_description, preset, world_info or {})
        else:
            content = str(prompt.get("content") or "")
        return self._substitute_prompt(content.strip(), character_name, persona_name)

    def _dialogue_example_messages(self, character_data: dict[str, Any], preset: dict[str, Any], character_name: str, persona_name: str) -> list[ChatMessage]:
        raw_examples = str(character_data.get("mes_example") or "").strip()
        if not raw_examples:
            return []
        messages = [ChatMessage(role="system", content=self._substitute_prompt(str(preset.get("new_example_chat_prompt") or "[Example Chat]"), character_name, persona_name))]
        parsed = self._parse_dialogue_examples(raw_examples, character_name, persona_name)
        if parsed:
            messages.extend(parsed)
        else:
            messages.append(ChatMessage(role="system", content=self._substitute_prompt(raw_examples, character_name, persona_name)))
        return messages

    def _parse_dialogue_examples(self, raw_examples: str, character_name: str, persona_name: str) -> list[ChatMessage]:
        messages: list[ChatMessage] = []
        current_role = ""
        current_lines: list[str] = []

        def flush() -> None:
            nonlocal current_role, current_lines
            content = "\n".join(current_lines).strip()
            if content and current_role:
                messages.append(ChatMessage(role="system", content=self._substitute_prompt(content, character_name, persona_name), name=f"example_{current_role}"))
            current_role = ""
            current_lines = []

        for line in raw_examples.replace("\r", "").split("\n"):
            stripped = line.strip()
            if not stripped or stripped.upper().startswith("<START>"):
                continue
            if stripped.startswith(f"{persona_name}:") or stripped.startswith("{{user}}:"):
                flush()
                current_role = "user"
                current_lines.append(stripped.split(":", 1)[1].strip())
            elif stripped.startswith(f"{character_name}:") or stripped.startswith("{{char}}:"):
                flush()
                current_role = "assistant"
                current_lines.append(stripped.split(":", 1)[1].strip())
            else:
                current_lines.append(stripped)
        flush()
        return messages

    def _with_tavern_in_chat_injections(self, history_messages: list[ChatMessage], prompts: list[dict[str, Any]], character_name: str, persona_name: str, persona_description: str, character_data: dict[str, Any], preset: dict[str, Any], world_info: dict[str, Any] | None = None) -> list[ChatMessage]:
        newest_first = list(reversed(history_messages))
        total_inserted = 0
        max_depth = max((self._int_value(prompt.get("injection_depth"), 0) for prompt in prompts), default=-1)
        for depth in range(max_depth + 1):
            depth_prompts = [prompt for prompt in prompts if self._int_value(prompt.get("injection_depth"), 0) == depth]
            role_messages: list[ChatMessage] = []
            order_groups: dict[int, list[dict[str, Any]]] = {}
            for prompt in depth_prompts:
                order_groups.setdefault(self._int_value(prompt.get("injection_order"), 100), []).append(prompt)
            for order in sorted(order_groups, reverse=True):
                for role in ("system", "user", "assistant"):
                    contents = [self._prompt_content(prompt, character_name, persona_name, persona_description, character_data, preset, world_info or {}) for prompt in order_groups[order] if self._prompt_role(prompt) == role]
                    joint = "\n".join(content for content in contents if content).strip()
                    if joint:
                        role_messages.append(ChatMessage(role=role, content=joint))
            if role_messages:
                index = min(depth + total_inserted, len(newest_first))
                newest_first[index:index] = role_messages
                total_inserted += len(role_messages)
        return list(reversed(newest_first))

    def _squash_system_messages(self, messages: list[ChatMessage]) -> list[ChatMessage]:
        squashed: list[ChatMessage] = []
        for message in messages:
            if not message.content:
                continue
            if squashed and squashed[-1].role == "system" and message.role == "system" and not squashed[-1].name and not message.name:
                squashed[-1] = ChatMessage(role="system", content=f"{squashed[-1].content}\n{message.content}")
            else:
                squashed.append(message)
        return squashed

    def _pack_tavern_messages(self, messages: list[ChatMessage]) -> list[ChatMessage]:
        packed: list[ChatMessage] = []
        for message in messages:
            if not message.content:
                continue
            if packed and packed[-1].role == message.role and not packed[-1].name and not message.name:
                packed[-1] = ChatMessage(role=message.role, content=f"{packed[-1].content}\n\n{message.content}")
            else:
                packed.append(message)
        return packed

    def _int_value(self, value: Any, fallback: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return fallback

    def _sanitize_openai_name(self, value: str) -> str:
        sanitized = "".join(character if character.isalnum() or character in {"_", "-"} else "_" for character in value.strip())
        return (sanitized or "user")[:64]

    def _preset_messages(self, preset: dict[str, Any] | None, character_name: str, persona_name: str, persona_description: str, character_data: dict[str, Any], history_messages: list[ChatMessage]) -> list[ChatMessage]:
        if not isinstance(preset, dict):
            return []
        prompts = [prompt for prompt in preset.get("prompts", []) if isinstance(prompt, dict)]
        order = self._prompt_order(preset.get("prompt_order"))
        if not order:
            order = [{"identifier": str(prompt.get("identifier") or ""), "enabled": True} for prompt in prompts]
        prompt_by_id = {str(prompt.get("identifier") or ""): prompt for prompt in prompts}
        result: list[ChatMessage] = []
        in_chat_prompts: list[dict[str, Any]] = []
        inserted_history = False
        for order_item in order:
            if order_item.get("enabled") is False:
                continue
            identifier = str(order_item.get("identifier") or "")
            prompt = prompt_by_id.get(identifier)
            if not prompt:
                continue
            if int(prompt.get("injection_position") or 0) == 1:
                in_chat_prompts.append(prompt)
                continue
            if prompt.get("marker") is True:
                if identifier == "chatHistory":
                    result.extend(self._with_in_chat_injections(history_messages, in_chat_prompts, character_name, persona_name))
                    inserted_history = True
                else:
                    marker_content = self._marker_content(identifier, character_data, persona_description, preset)
                    if marker_content:
                        result.append(ChatMessage(role=self._prompt_role(prompt), content=self._substitute_prompt(marker_content, character_name, persona_name)))
                continue
            content = str(prompt.get("content") or "").strip()
            if not content:
                continue
            result.append(ChatMessage(role=self._prompt_role(prompt), content=self._substitute_prompt(content, character_name, persona_name)))
        if not inserted_history:
            result.extend(self._with_in_chat_injections(history_messages, in_chat_prompts, character_name, persona_name))
        return result

    def _with_in_chat_injections(self, history_messages: list[ChatMessage], prompts: list[dict[str, Any]], character_name: str, persona_name: str) -> list[ChatMessage]:
        messages = list(history_messages)
        for prompt in sorted(prompts, key=lambda item: (int(item.get("injection_depth") or 0), -int(item.get("injection_order") or 100))):
            content = str(prompt.get("content") or "").strip()
            if not content:
                continue
            depth = max(0, int(prompt.get("injection_depth") or 0))
            index = max(0, len(messages) - depth)
            messages.insert(index, ChatMessage(role=self._prompt_role(prompt), content=self._substitute_prompt(content, character_name, persona_name)))
        return messages

    def _marker_content(self, identifier: str, character_data: dict[str, Any], persona_description: str, preset: dict[str, Any], world_info: dict[str, Any] | None = None) -> str:
        match identifier:
            case "charDescription":
                return str(character_data.get("description") or "")
            case "charPersonality":
                return self._format_template(str(preset.get("personality_format") or "{{personality}}"), "personality", str(character_data.get("personality") or ""))
            case "scenario":
                return self._format_template(str(preset.get("scenario_format") or "{{scenario}}"), "scenario", str(character_data.get("scenario") or ""))
            case "dialogueExamples":
                return str(character_data.get("mes_example") or "")
            case "personaDescription":
                return persona_description
            case "worldInfoBefore":
                return str((world_info or {}).get("worldInfoBefore") or "")
            case "worldInfoAfter":
                return str((world_info or {}).get("worldInfoAfter") or "")
            case _:
                return ""

    def _format_template(self, template: str, key: str, value: str) -> str:
        if not value:
            return ""
        return template.replace(f"{{{{{key}}}}}", value).replace(f"{{{key}}}", value).replace("{0}", value)

    def _prompt_role(self, prompt: dict[str, Any]) -> str:
        role = str(prompt.get("role") or "system")
        return role if role in {"system", "user", "assistant"} else "system"

    def _with_assistant_prefill(self, messages: list[ChatMessage], preset: dict[str, Any] | None) -> list[ChatMessage]:
        prefill = self._assistant_prefill(preset)
        return [*messages, ChatMessage(role="assistant", content=prefill)] if prefill else messages

    def _assistant_prefill(self, preset: dict[str, Any] | None) -> str:
        if not isinstance(preset, dict):
            return ""
        return str(preset.get("assistant_prefill") or "")

    def _prompt_order(self, raw_order: Any) -> list[dict[str, Any]]:
        if not isinstance(raw_order, list):
            return []
        preferred = next((entry for entry in raw_order if isinstance(entry, dict) and str(entry.get("character_id")) == "100001" and isinstance(entry.get("order"), list)), None)
        first = preferred or next((entry for entry in raw_order if isinstance(entry, dict) and isinstance(entry.get("order"), list)), None)
        if not isinstance(first, dict):
            return []
        return [entry for entry in first.get("order", []) if isinstance(entry, dict)]

    def _substitute_prompt(self, content: str, character_name: str, persona_name: str) -> str:
        if not content:
            return ""
        text = (
            content
            .replace("{{char}}", character_name)
            .replace("{{Char}}", character_name)
            .replace("{{CHAR}}", character_name)
            .replace("{{user}}", persona_name)
            .replace("{{User}}", persona_name)
            .replace("{{USER}}", persona_name)
            .replace("{char}", character_name)
            .replace("{user}", persona_name)
            .replace("<BOT>", character_name)
            .replace("<CHAR>", character_name)
            .replace("<USER>", persona_name)
        )
        if "{{" not in text:
            return text
        text = re.sub(r"\{\{//[\s\S]*?\}\}", "", text)
        text = re.sub(r"\n?\{\{trim\}\}\n?", "", text, flags=re.IGNORECASE)
        text = (
            text.replace("{{newline}}", "\n")
            .replace("{{noop}}", "")
        )
        if "{{" not in text:
            return text
        now = datetime.now()
        text = (
            text.replace("{{time}}", now.strftime("%H:%M"))
            .replace("{{date}}", now.strftime("%Y-%m-%d"))
            .replace("{{weekday}}", now.strftime("%A"))
            .replace("{{isotime}}", now.strftime("%H:%M:%S"))
            .replace("{{isodate}}", now.strftime("%Y-%m-%d"))
        )

        def _random_replacer(m: re.Match[str]) -> str:
            body = m.group(1)
            items = [item.strip() for item in (body.split("::") if "::" in body else body.split(",")) if item.strip()]
            return random.choice(items) if items else ""

        def _roll_replacer(m: re.Match[str]) -> str:
            spec = m.group(1).strip().lower()
            rm = re.match(r"^(\d*)d(\d+)([+-]\d+)?$", spec)
            if not rm:
                try:
                    return str(random.randint(1, max(1, int(spec))))
                except ValueError:
                    return m.group(0)
            count = min(100, max(1, int(rm.group(1) or "1")))
            sides = max(1, int(rm.group(2)))
            mod = int(rm.group(3) or "0")
            return str(sum(random.randint(1, sides) for _ in range(count)) + mod)

        text = re.sub(r"\{\{(?:random|pick):(?::)?([\s\S]*?)\}\}", _random_replacer, text, flags=re.IGNORECASE)
        text = re.sub(r"\{\{roll:([^}]+)\}\}", _roll_replacer, text, flags=re.IGNORECASE)
        return text
