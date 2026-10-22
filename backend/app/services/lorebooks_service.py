from __future__ import annotations

import json
import os
import random
import re
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


class LorebookSummary(BaseModel):
    name: str
    filename: str
    entry_count: int
    updated_at: float
    bindings: list[dict[str, str]] = Field(default_factory=list)


class LorebookPayload(BaseModel):
    name: str
    book: dict[str, Any] = Field(default_factory=lambda: {"entries": {}})


class LorebookBinding(BaseModel):
    book: str
    target_type: str = "global"
    target_id: str = ""


class LorebookBindingPayload(BaseModel):
    bindings: list[LorebookBinding] = Field(default_factory=list)


class LorebookContext(BaseModel):
    worldInfoBefore: str = ""
    worldInfoAfter: str = ""
    depthPrompts: list[dict[str, object]] = Field(default_factory=list)


class LorebooksService:
    def __init__(self, worlds_dir: Path, bindings_path: Path) -> None:
        self.worlds_dir = worlds_dir
        self.bindings_path = bindings_path
        self._cache: dict[Path, tuple[int, int, dict[str, Any]]] = {}

    def _read_cached_book(self, path: Path) -> dict[str, Any]:
        st = path.stat()
        cached = self._cache.get(path)
        if cached and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
            return cached[2]
        book = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(book, dict):
            self._cache[path] = (st.st_mtime_ns, st.st_size, book)
            return book
        return {}

    def list_books(self) -> list[LorebookSummary]:
        self.worlds_dir.mkdir(parents=True, exist_ok=True)
        bindings = self._load_bindings()
        summaries: list[LorebookSummary] = []
        for path in sorted(self.worlds_dir.glob("*.json"), key=lambda item: item.stem.lower()):
            try:
                book = self._read_cached_book(path)
                st = path.stat()
            except (json.JSONDecodeError, UnicodeDecodeError, OSError):
                continue
            entries = self._extract_entries(book)
            summaries.append(
                LorebookSummary(
                    name=path.stem,
                    filename=path.name,
                    entry_count=len(entries),
                    updated_at=st.st_mtime,
                    bindings=[binding.model_dump(mode="json") for binding in bindings if binding.book == path.stem],
                )
            )
        return summaries

    def get_book(self, name: str) -> dict[str, Any]:
        path = self._path(name)
        if not path.exists():
            raise FileNotFoundError(name)
        return self._read_cached_book(path)

    def _normalize_saved_entry(self, idx: int, item: dict[str, Any]) -> dict[str, Any]:
        entry = dict(item)
        entry.setdefault("uid", entry.get("id", idx))
        entry.setdefault("displayIndex", idx)
        if "key" not in entry and isinstance(entry.get("keys"), list):
            entry["key"] = entry["keys"]
        if "keysecondary" not in entry and isinstance(entry.get("secondary_keys"), list):
            entry["keysecondary"] = entry["secondary_keys"]
        if "comment" not in entry and entry.get("name"):
            entry["comment"] = str(entry["name"])
        if "disable" not in entry and "enabled" in entry:
            entry["disable"] = not bool(entry["enabled"])
        if "order" not in entry and "insertion_order" in entry:
            entry["order"] = entry["insertion_order"]
        pos = entry.get("position")
        if pos == "before_char":
            entry["position"] = 0
        elif pos == "after_char":
            entry["position"] = 1
        return entry

    def save_book(self, payload: LorebookPayload) -> LorebookSummary:
        name = self._safe_name(payload.name)
        if not name:
            raise ValueError("Lorebook name is required")
        book = dict(payload.book) if isinstance(payload.book, dict) else {"entries": {}}
        raw_entries = book.get("entries")
        if isinstance(raw_entries, list):
            book["entries"] = {
                str(idx): self._normalize_saved_entry(idx, item)
                for idx, item in enumerate(raw_entries)
                if isinstance(item, dict)
            }
        elif isinstance(raw_entries, dict):
            book["entries"] = {
                str(k): self._normalize_saved_entry(idx, item)
                for idx, (k, item) in enumerate(raw_entries.items())
                if isinstance(item, dict)
            }
        else:
            book["entries"] = {}
        self.worlds_dir.mkdir(parents=True, exist_ok=True)
        path = self.worlds_dir / f"{name}.json"
        tmp_path = self.worlds_dir / f".{name}.json.tmp"
        tmp_path.write_text(json.dumps(book, ensure_ascii=False, indent=4), encoding="utf-8")
        os.replace(tmp_path, path)
        self._cache.pop(path, None)
        return next(summary for summary in self.list_books() if summary.name == name)
    def import_book(self, filename: str, content: bytes) -> LorebookSummary:
        if not filename.lower().endswith(".json"):
            raise ValueError("Only JSON lorebooks are supported")
        parsed = json.loads(content.decode("utf-8-sig"))
        if not isinstance(parsed, dict):
            raise ValueError("Lorebook JSON must be an object")
        return self.save_book(LorebookPayload(name=Path(filename).stem, book=parsed))

    def delete_book(self, name: str) -> None:
        path = self._path(name)
        if not path.exists():
            raise FileNotFoundError(name)
        self._cache.pop(path, None)
        path.unlink()
        self.save_bindings([binding for binding in self._load_bindings() if binding.book != self._safe_name(name)])

    def bindings(self) -> list[LorebookBinding]:
        return self._load_bindings()

    def save_bindings(self, bindings: list[LorebookBinding]) -> list[LorebookBinding]:
        cleaned = [binding for binding in bindings if binding.book and binding.target_type in {"global", "card", "chat", "persona"}]
        self.bindings_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.bindings_path.with_suffix(".yaml.tmp")
        tmp_path.write_text(yaml.safe_dump([binding.model_dump(mode="json") for binding in cleaned], sort_keys=False, allow_unicode=True), encoding="utf-8")
        os.replace(tmp_path, self.bindings_path)
        return cleaned
    def _extract_entries(self, book: dict[str, Any] | None) -> list[dict[str, Any]]:
        if not isinstance(book, dict):
            return []
        entries = book.get("entries")
        if isinstance(entries, dict):
            return [item for item in entries.values() if isinstance(item, dict)]
        if isinstance(entries, list):
            return [item for item in entries if isinstance(item, dict)]
        return []

    def active_context(self, history: list[str], card_id: str = "", chat_id: str = "", persona_id: str | list[str] | set[str] | tuple[str, ...] = "", character_book: dict[str, Any] | None = None) -> LorebookContext:
        persona_ids = {persona_id} if isinstance(persona_id, str) and persona_id else ({str(p) for p in persona_id if str(p).strip()} if not isinstance(persona_id, str) else set())
        target_keys = {("global", ""), ("card", card_id), ("chat", chat_id), *(("persona", pid) for pid in persona_ids)}
        loaded_bindings = self._load_bindings()
        active_books = {binding.book for binding in loaded_bindings if (binding.target_type, binding.target_id) in target_keys or binding.target_type == "global"}
        has_card_bound_book = any(binding.target_type == "card" and binding.target_id == card_id and binding.book in active_books for binding in loaded_bindings)
        books_to_scan: list[dict[str, Any]] = []
        for book_name in sorted(active_books):
            try:
                books_to_scan.append(self.get_book(book_name))
            except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
                continue
        if not has_card_bound_book and isinstance(character_book, dict) and self._extract_entries(character_book):
            books_to_scan.append(character_book)
        if not books_to_scan:
            return LorebookContext()

        all_candidates: list[dict[str, Any]] = []
        for book in books_to_scan:
            for entry in sorted(
                self._extract_entries(book),
                key=lambda item: (
                    self._int_value(item.get("order", item.get("insertion_order")), 100),
                    self._int_value(item.get("displayIndex"), self._int_value(item.get("uid", item.get("id")), 0)),
                ),
            ):
                all_candidates.append(entry)

        activated_indices: set[int] = set()
        recent_history = [re.sub(r"<think(?:ing)?>[\s\S]*?</think(?:ing)?>", "", text, flags=re.IGNORECASE) for text in history[-16:]]
        scan_text = "\n".join(recent_history)
        for _pass in range(3):
            newly_added: list[str] = []
            for idx, entry in enumerate(all_candidates):
                if idx in activated_indices:
                    continue
                if _pass > 0 and entry.get("excludeRecursion") is True:
                    continue
                if self._entry_active(entry, scan_text):
                    activated_indices.add(idx)
                    content = str(entry.get("content") or "").strip()
                    if content and entry.get("preventRecursion") is not True:
                        newly_added.append(content)
            if not newly_added:
                break
            scan_text = scan_text + "\n" + "\n".join(newly_added)

        before: list[tuple[int, str]] = []
        after: list[tuple[int, str]] = []
        depth_prompts: list[dict[str, object]] = []
        seen_entries: set[tuple[int, int, str]] = set()
        for idx in sorted(activated_indices):
            entry = all_candidates[idx]
            content = str(entry.get("content") or "").strip()
            if not content:
                continue
            order = self._int_value(entry.get("order", entry.get("insertion_order")), 100)
            raw_pos = entry.get("position", 0)
            ext_pos = (entry.get("extensions") or {}).get("position") if isinstance(entry.get("extensions"), dict) else None
            position = self._int_value(ext_pos if ext_pos is not None else (1 if raw_pos == "after_char" else 0 if raw_pos == "before_char" else raw_pos), 0)
            dedup_key = (position, order, content)
            if dedup_key in seen_entries:
                continue
            seen_entries.add(dedup_key)
            if position in {1, 3, 6}:
                after.append((order, content))
            elif position == 4:
                ext_depth = (entry.get("extensions") or {}).get("depth") if isinstance(entry.get("extensions"), dict) else None
                ext_role = (entry.get("extensions") or {}).get("role") if isinstance(entry.get("extensions"), dict) else None
                depth_prompts.append({
                    "role": self._entry_role(entry.get("role", ext_role)),
                    "content": content,
                    "injection_depth": self._int_value(entry.get("depth", ext_depth), 4),
                    "injection_order": order,
                })
            else:
                before.append((order, content))
        return LorebookContext(
            worldInfoBefore="\n".join(content for _, content in sorted(before, key=lambda x: x[0])),
            worldInfoAfter="\n".join(content for _, content in sorted(after, key=lambda x: x[0])),
            depthPrompts=depth_prompts,
        )

    def _entry_active(self, entry: dict[str, Any], scan_text: str) -> bool:
        if entry.get("disable") is True or entry.get("enabled") is False:
            return False
        if entry.get("useProbability") is True and random.random() * 100 > self._float_value(entry.get("probability"), 100.0):
            return False
        if entry.get("constant") is True:
            return True
        primary_raw = entry.get("key") if entry.get("key") is not None else entry.get("keys")
        secondary_raw = entry.get("keysecondary") if entry.get("keysecondary") is not None else entry.get("secondary_keys")
        primary = [str(item) for item in (primary_raw or []) if str(item).strip()]
        secondary = [str(item) for item in (secondary_raw or []) if str(item).strip()]
        if not primary:
            return False
        matched_primary = any(self._keyword_matches(scan_text, key, entry) for key in primary)
        if not matched_primary:
            return False
        if entry.get("selective") is True and secondary:
            logic = self._int_value(entry.get("selectiveLogic"), 0)
            matches = [self._keyword_matches(scan_text, key, entry) for key in secondary]
            if logic == 1:  # NOT_ALL
                return not all(matches)
            if logic == 2:  # NOT_ANY
                return not any(matches)
            if logic == 3:  # AND_ALL
                return all(matches)
            return any(matches)
        return True

    def _keyword_matches(self, text: str, keyword: str, entry: dict[str, Any]) -> bool:
        case_sensitive = entry.get("caseSensitive") is True or entry.get("case_sensitive") is True
        flags = 0 if case_sensitive else re.IGNORECASE
        regex_match = re.match(r"^/(.*)/([gimsuy]*)$", keyword.strip())
        if regex_match:
            try:
                return re.search(regex_match.group(1), text, flags=flags) is not None
            except re.error:
                pass
        escaped = re.escape(keyword)
        pattern = rf"(?<!\w){escaped}(?!\w)" if entry.get("matchWholeWords") is True else escaped
        return re.search(pattern, text, flags=flags) is not None
    def _entry_role(self, value: Any) -> str:
        if value in (1, "1", "user"):
            return "user"
        if value in (2, "2", "assistant"):
            return "assistant"
        return "system"

    def _int_value(self, value: Any, fallback: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return fallback

    def _float_value(self, value: Any, fallback: float) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return fallback

    def _load_bindings(self) -> list[LorebookBinding]:
        if not self.bindings_path.exists():
            return []
        raw = yaml.safe_load(self.bindings_path.read_text(encoding="utf-8")) or []
        return [LorebookBinding.model_validate(item) for item in raw if isinstance(item, dict)]

    def _path(self, name: str) -> Path:
        return self.worlds_dir / f"{self._safe_name(name)}.json"

    def _safe_name(self, name: str) -> str:
        return re.sub(r"[\\/:*?\"<>|]+", "_", name).strip(" .")
