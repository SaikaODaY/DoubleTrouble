from __future__ import annotations

from functools import lru_cache
import re
from typing import Any

class RegexService:
    PLACEMENT_MD_DISPLAY = 0
    PLACEMENT_USER_INPUT = 1
    PLACEMENT_AI_OUTPUT = 2
    PLACEMENT_SLASH_COMMAND = 3
    PLACEMENT_WORLD_INFO = 5
    PLACEMENT_REASONING = 6

    SUBSTITUTE_NONE = 0
    SUBSTITUTE_RAW = 1
    SUBSTITUTE_ESCAPED = 2

    @staticmethod
    @lru_cache(maxsize=1024)
    def regex_from_string(pattern: str) -> re.Pattern[str]:
        match = re.match(r"^/(.*)/([gimsuyx]*)$", pattern, flags=re.DOTALL)
        if match:
            body = match.group(1)
            flags_str = match.group(2) or ""
            flags = 0
            flag_map = {
                "i": re.IGNORECASE,
                "m": re.MULTILINE,
                "s": re.DOTALL,
                "x": re.VERBOSE,
                "u": re.UNICODE,
            }
            for ch in flags_str:
                if ch in flag_map:
                    flags |= flag_map[ch]
            body = body.replace("[^]", r"[\s\S]").replace(r"\/", "/")
            return re.compile(body, flags)
        return re.compile(pattern.replace("[^]", r"[\s\S]").replace(r"\/", "/"))
    @staticmethod
    def _substitute_params(text: str, user_name: str = "Player", char_name: str = "Bot") -> str:
        return (
            text.replace("{{user}}", user_name)
            .replace("{{char}}", char_name)
            .replace("{user}", user_name)
            .replace("{char}", char_name)
        )

    @staticmethod
    def _sanitize_regex_macro(value: str) -> str:
        def replacer(s: re.Match[str]) -> str:
            ch = s.group(0)
            mapping = {
                "\n": "\\n",
                "\r": "\\r",
                "\t": "\\t",
                "\v": "\\v",
                "\f": "\\f",
                "\0": "\\0",
            }
            return mapping.get(ch, "\\" + ch)

        return re.sub(r"[\n\r\t\v\f\0.^$*+?{}\[\]\\\\/|()]", replacer, value)

    @staticmethod
    def _get_regex_string(script: dict[str, Any], user_name: str, char_name: str) -> str:
        substitute = int(script.get("substituteRegex", 0))
        find_regex = str(script.get("findRegex", ""))
        if substitute == RegexService.SUBSTITUTE_NONE:
            return find_regex
        if substitute == RegexService.SUBSTITUTE_RAW:
            return RegexService._substitute_params(find_regex, user_name, char_name)
        if substitute == RegexService.SUBSTITUTE_ESCAPED:
            escaped_user = RegexService._sanitize_regex_macro(user_name)
            escaped_char = RegexService._sanitize_regex_macro(char_name)
            return (
                find_regex.replace("{{user}}", escaped_user)
                .replace("{{char}}", escaped_char)
                .replace("{user}", escaped_user)
                .replace("{char}", escaped_char)
            )
        return find_regex

    @staticmethod
    def run_regex_script(
        script: dict[str, Any],
        raw_string: str,
        user_name: str = "Player",
        char_name: str = "Bot",
    ) -> str:
        if not script or script.get("disabled") or not script.get("findRegex") or not raw_string:
            return raw_string

        regex_string = RegexService._get_regex_string(script, user_name, char_name)
        try:
            find_regex = RegexService.regex_from_string(regex_string)
        except re.error:
            return raw_string

        trim_strings = script.get("trimStrings") or []

        def replace_func(match: re.Match[str]) -> str:
            replace_str = str(script.get("replaceString", ""))
            replace_str = replace_str.replace("{{match}}", match.group(0))
            replace_str = replace_str.replace("$0", match.group(0))

            def group_replacer(m: re.Match[str]) -> str:
                num = m.group(1)
                name = m.group(2)
                matched = ""
                if num is not None:
                    idx = int(num)
                    if idx < len(match.groups()) + 1:
                        matched = match.group(idx) or ""
                elif name is not None:
                    try:
                        matched = match.group(name) or ""
                    except IndexError:
                        matched = ""
                for trim in trim_strings:
                    sub_trim = RegexService._substitute_params(trim, user_name, char_name)
                    matched = matched.replace(sub_trim, "")
                return matched

            replace_str = re.sub(r"\$(\d+)|\$<([^>]+)>", group_replacer, replace_str)
            return RegexService._substitute_params(replace_str, user_name, char_name)

        return find_regex.sub(replace_func, raw_string)

    @staticmethod
    def get_regexed_string(
        raw_string: str,
        placement: int,
        scripts: list[dict[str, Any]],
        is_prompt: bool = False,
        is_markdown: bool = False,
        is_edit: bool = False,
        depth: int | None = None,
        user_name: str = "Player",
        char_name: str = "Bot",
    ) -> str:
        if not isinstance(raw_string, str):
            return ""
        final_string = raw_string
        if not raw_string or placement is None:
            return final_string

        for script in scripts:
            markdown_only = bool(script.get("markdownOnly"))
            prompt_only = bool(script.get("promptOnly"))
            if (markdown_only and is_markdown) or (prompt_only and is_prompt) or (
                not markdown_only and not prompt_only and not is_markdown and not is_prompt
            ):
                if is_edit and not script.get("runOnEdit"):
                    continue
                if depth is not None:
                    min_depth = script.get("minDepth")
                    max_depth = script.get("maxDepth")
                    if min_depth is not None and not (isinstance(min_depth, float) and min_depth != min_depth) and min_depth >= -1 and depth < min_depth:
                        continue
                    if max_depth is not None and not (isinstance(max_depth, float) and max_depth != max_depth) and max_depth >= 0 and depth > max_depth:
                        continue
                placements = script.get("placement", [])
                if placement in placements:
                    final_string = RegexService.run_regex_script(script, final_string, user_name, char_name)
        return final_string

    @staticmethod
    def apply_to_messages(
        messages: list[dict[str, Any]],
        placement: int,
        scripts: list[dict[str, Any]],
        is_prompt: bool = False,
        user_name: str = "Player",
        char_name: str = "Bot",
    ) -> list[dict[str, Any]]:
        return [
            {
                **msg,
                "content": RegexService.get_regexed_string(
                    str(msg.get("content", "")),
                    placement,
                    scripts,
                    is_prompt=is_prompt,
                    depth=None,
                    user_name=user_name,
                    char_name=char_name,
                ),
            }
            for msg in messages
        ]
