from __future__ import annotations

import base64
import hashlib
import json
import re
import zlib
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
FALLBACK_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


class CharacterCardSummary(BaseModel):
    id: str
    filename: str
    name: str
    description: str = ""
    personality: str = ""
    scenario: str = ""
    first_message: str = ""
    alternate_greetings: list[str] = Field(default_factory=list)
    message_example: str = ""
    creator: str = ""
    tags: list[str] = Field(default_factory=list)
    spec: str = ""
    spec_version: str = ""
    image_url: str


class CharacterCardCreate(BaseModel):
    name: str
    description: str = ""
    personality: str = ""
    scenario: str = ""
    first_message: str = ""
    alternate_greetings: list[str] = Field(default_factory=list)
    message_example: str = ""
    creator: str = ""
    tags: list[str] = Field(default_factory=list)


class CharacterCardUpdate(CharacterCardCreate):
    pass


class CharacterCardsService:
    def __init__(self, characters_dir: Path) -> None:
        self.characters_dir = characters_dir
        self._cache: dict[Path, tuple[int, int, dict[str, Any], CharacterCardSummary]] = {}
        self._id_to_path: dict[str, Path] = {}

    def list_cards(self) -> list[CharacterCardSummary]:
        self.characters_dir.mkdir(parents=True, exist_ok=True)
        cards: list[CharacterCardSummary] = []
        paths_with_mtime: list[tuple[float, Path]] = []
        for path in self.characters_dir.glob("*.png"):
            try:
                paths_with_mtime.append((path.stat().st_mtime, path))
            except OSError:
                continue
        paths_with_mtime.sort(key=lambda item: item[0], reverse=True)
        for _, path in paths_with_mtime:
            try:
                cards.append(self._summary_from_file(path))
            except (ValueError, json.JSONDecodeError, UnicodeDecodeError, OSError):
                continue
        return cards

    def get_card(self, card_id: str) -> CharacterCardSummary:
        path = self._path_from_card_id(card_id)
        if path is None:
            raise FileNotFoundError(card_id)
        return self._summary_from_file(path)

    def import_card(self, filename: str, content: bytes) -> CharacterCardSummary:
        metadata = self._read_json_metadata(content) if filename.lower().endswith(".json") else self.read_card_metadata(content)
        data = self._card_data(metadata)
        name = str(data.get("name") or metadata.get("name") or Path(filename).stem or "Character")
        target = self._unique_path(self._safe_filename(name), ".png")
        target.write_bytes(self._write_card_metadata(FALLBACK_PNG, metadata) if filename.lower().endswith(".json") else content)
        return self._store_cache(target, metadata)

    def create_card(self, request: CharacterCardCreate, avatar_content: bytes | None = None) -> CharacterCardSummary:
        name = request.name.strip() or "Character"
        metadata = self._create_v2_metadata(request, name)
        source_png = avatar_content or FALLBACK_PNG
        if not source_png.startswith(PNG_SIGNATURE):
            raise ValueError("Avatar must be a PNG file")

        target = self._unique_path(self._safe_filename(name), ".png")
        target.write_bytes(self._write_card_metadata(source_png, metadata))
        return self._store_cache(target, metadata)
    def update_card(self, card_id: str, request: CharacterCardUpdate) -> CharacterCardSummary:
        path = self._path_from_card_id(card_id)
        if path is None:
            raise FileNotFoundError(card_id)
        content = path.read_bytes()
        metadata = self.read_card_metadata(content)
        data = self._card_data(metadata)
        data.update(
            {
                "name": request.name.strip() or "Character",
                "description": request.description,
                "personality": request.personality,
                "scenario": request.scenario,
                "first_mes": request.first_message,
                "alternate_greetings": [greeting for greeting in request.alternate_greetings if greeting.strip()],
                "mes_example": request.message_example,
                "creator": request.creator,
                "tags": request.tags,
            }
        )
        if isinstance(metadata.get("data"), dict):
            metadata["data"] = data
        else:
            metadata.update(data)
        path.write_bytes(self._write_card_metadata(content, metadata))
        return self._store_cache(path, metadata)

    def update_card_avatar(self, card_id: str, avatar_content: bytes) -> CharacterCardSummary:
        path = self._path_from_card_id(card_id)
        if path is None:
            raise FileNotFoundError(card_id)
        if not avatar_content.startswith(PNG_SIGNATURE):
            raise ValueError("Avatar must be a PNG file")
        metadata = self.read_card_metadata(path.read_bytes())
        path.write_bytes(self._write_card_metadata(avatar_content, metadata))
        return self._store_cache(path, metadata)
    def delete_card(self, card_id: str) -> CharacterCardSummary:
        path = self._path_from_card_id(card_id)
        if path is None:
            raise FileNotFoundError(card_id)
        summary = self._summary_from_file(path)
        self._cache.pop(path, None)
        self._id_to_path.pop(card_id, None)
        path.unlink()
        return summary

    def image_path(self, card_id: str) -> Path:
        path = self._path_from_card_id(card_id)
        if path is None:
            raise FileNotFoundError(card_id)
        return path

    def card_data(self, card_id: str) -> dict[str, Any]:
        path = self._path_from_card_id(card_id)
        if path is None:
            raise FileNotFoundError(card_id)
        metadata, _ = self._cached_from_file(path)
        return self._card_data(metadata)
    def read_card_metadata(self, content: bytes) -> dict[str, Any]:
        text_chunks = self._read_png_text_chunks(content)
        encoded = text_chunks.get("ccv3") or text_chunks.get("chara")
        if not encoded:
            raise ValueError("PNG card has no chara/ccv3 metadata")
        decoded = base64.b64decode(encoded).decode("utf-8")
        return json.loads(decoded)

    def _read_json_metadata(self, content: bytes) -> dict[str, Any]:
        metadata = json.loads(content.decode("utf-8"))
        if not isinstance(metadata, dict):
            raise ValueError("JSON card must be an object")
        data = self._card_data(metadata)
        if not str(data.get("name") or metadata.get("name") or "").strip():
            raise ValueError("JSON card has no character name")
        return metadata

    def _store_cache(self, path: Path, metadata: dict[str, Any]) -> CharacterCardSummary:
        st = path.stat()
        summary = self._summary_from_metadata(path, metadata, st.st_mtime)
        self._cache[path] = (st.st_mtime_ns, st.st_size, metadata, summary)
        self._id_to_path[summary.id] = path
        return summary

    def _cached_from_file(self, path: Path) -> tuple[dict[str, Any], CharacterCardSummary]:
        st = path.stat()
        cached = self._cache.get(path)
        if cached and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
            return cached[2], cached[3]
        metadata = self._read_card_metadata_from_path(path)
        summary = self._summary_from_metadata(path, metadata, st.st_mtime)
        self._cache[path] = (st.st_mtime_ns, st.st_size, metadata, summary)
        self._id_to_path[summary.id] = path
        return metadata, summary
    def _summary_from_file(self, path: Path) -> CharacterCardSummary:
        _, summary = self._cached_from_file(path)
        return summary
    def _summary_from_metadata(self, path: Path, metadata: dict[str, Any], mtime: float | None = None) -> CharacterCardSummary:
        data = self._card_data(metadata)
        tags = data.get("tags") or metadata.get("tags") or []
        resolved_mtime = int(mtime if mtime is not None else path.stat().st_mtime)
        return CharacterCardSummary(
            id=self._card_id(path),
            filename=path.name,
            name=str(data.get("name") or metadata.get("name") or path.stem),
            description=str(data.get("description") or metadata.get("description") or ""),
            personality=str(data.get("personality") or metadata.get("personality") or ""),
            scenario=str(data.get("scenario") or metadata.get("scenario") or ""),
            first_message=str(data.get("first_mes") or metadata.get("first_mes") or ""),
            alternate_greetings=self._alternate_greetings(data, metadata),
            message_example=str(data.get("mes_example") or metadata.get("mes_example") or ""),
            creator=str(data.get("creator") or metadata.get("creator") or ""),
            tags=[str(tag) for tag in tags] if isinstance(tags, list) else [],
            spec=str(metadata.get("spec") or ""),
            spec_version=str(metadata.get("spec_version") or ""),
            image_url=f"/api/cards/{self._card_id(path)}/image?v={resolved_mtime}",
        )

    def _card_data(self, metadata: dict[str, Any]) -> dict[str, Any]:
        data = metadata.get("data")
        return data if isinstance(data, dict) else metadata

    def _alternate_greetings(self, data: dict[str, Any], metadata: dict[str, Any]) -> list[str]:
        raw = data.get("alternate_greetings", metadata.get("alternate_greetings", []))
        if isinstance(raw, list):
            return [str(item) for item in raw if str(item).strip()]
        if isinstance(raw, str) and raw.strip():
            return [raw]
        return []

    def _read_card_metadata_from_path(self, path: Path) -> dict[str, Any]:
        chunks: dict[str, str] = {}
        with path.open("rb") as f:
            if f.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
                raise ValueError("Not a PNG file")
            while True:
                header = f.read(8)
                if len(header) < 8:
                    break
                length = int.from_bytes(header[:4], "big")
                chunk_type = header[4:8].decode("ascii", errors="replace")
                if chunk_type in {"tEXt", "zTXt", "iTXt"} and length <= 16 * 1024 * 1024:
                    chunk_data = f.read(length)
                    f.seek(4, 1)
                    self._parse_text_chunk(chunk_type, chunk_data, chunks)
                elif chunk_type == "IEND":
                    break
                else:
                    f.seek(length + 4, 1)
        encoded = chunks.get("ccv3") or chunks.get("chara")
        if not encoded:
            raise ValueError("PNG card has no chara/ccv3 metadata")
        decoded = base64.b64decode(encoded).decode("utf-8")
        return json.loads(decoded)

    def _parse_text_chunk(self, chunk_type: str, chunk_data: bytes, chunks: dict[str, str]) -> None:
        if b"\x00" not in chunk_data:
            return
        if chunk_type == "tEXt":
            keyword, text = chunk_data.split(b"\x00", 1)
            chunks[keyword.decode("latin-1", errors="ignore").lower()] = text.decode("latin-1", errors="ignore")
        elif chunk_type == "zTXt":
            keyword, rest = chunk_data.split(b"\x00", 1)
            if len(rest) > 1 and rest[0] == 0:
                try:
                    decompressed = zlib.decompress(rest[1:])
                    chunks[keyword.decode("latin-1", errors="ignore").lower()] = decompressed.decode("latin-1", errors="ignore")
                except zlib.error:
                    pass
        elif chunk_type == "iTXt":
            keyword, rest = chunk_data.split(b"\x00", 1)
            if len(rest) >= 2:
                comp_flag = rest[0]
                parts = rest[2:].split(b"\x00", 2)
                if len(parts) == 3:
                    raw_text = parts[2]
                    try:
                        if comp_flag == 1:
                            raw_text = zlib.decompress(raw_text)
                        chunks[keyword.decode("latin-1", errors="ignore").lower()] = raw_text.decode("utf-8", errors="ignore")
                    except zlib.error:
                        pass

    def _read_png_text_chunks(self, content: bytes) -> dict[str, str]:
        if not content.startswith(PNG_SIGNATURE):
            raise ValueError("Not a PNG file")

        chunks: dict[str, str] = {}
        offset = len(PNG_SIGNATURE)
        while offset + 8 <= len(content):
            length = int.from_bytes(content[offset:offset + 4], "big")
            chunk_type = content[offset + 4:offset + 8].decode("ascii", errors="replace")
            data_start = offset + 8
            data_end = data_start + length
            if data_end + 4 > len(content):
                break

            chunk_data = content[data_start:data_end]
            if chunk_type in {"tEXt", "zTXt", "iTXt"}:
                self._parse_text_chunk(chunk_type, chunk_data, chunks)
            if chunk_type == "IEND":
                break
            offset = data_end + 4
        return chunks
    def _write_card_metadata(self, content: bytes, metadata: dict[str, Any]) -> bytes:
        chunks = self._split_png_chunks(content)
        metadata_json = json.dumps(metadata, ensure_ascii=False)
        ccv3 = dict(metadata)
        ccv3["spec"] = "chara_card_v3"
        ccv3["spec_version"] = "3.0"

        text_chunks = [
            self._make_text_chunk("chara", base64.b64encode(metadata_json.encode("utf-8")).decode("ascii")),
            self._make_text_chunk("ccv3", base64.b64encode(json.dumps(ccv3, ensure_ascii=False).encode("utf-8")).decode("ascii")),
        ]

        output = bytearray(PNG_SIGNATURE)
        inserted = False
        for chunk_type, chunk_data in chunks:
            if chunk_type == "tEXt":
                keyword = chunk_data.split(b"\x00", 1)[0].decode("latin-1", errors="ignore").lower()
                if keyword in {"chara", "ccv3"}:
                    continue
            if chunk_type == "IEND" and not inserted:
                for text_chunk_type, text_chunk_data in text_chunks:
                    output.extend(self._encode_chunk(text_chunk_type, text_chunk_data))
                inserted = True
            output.extend(self._encode_chunk(chunk_type, chunk_data))
        return bytes(output)

    def _split_png_chunks(self, content: bytes) -> list[tuple[str, bytes]]:
        if not content.startswith(PNG_SIGNATURE):
            raise ValueError("Not a PNG file")
        chunks: list[tuple[str, bytes]] = []
        offset = len(PNG_SIGNATURE)
        while offset + 8 <= len(content):
            length = int.from_bytes(content[offset:offset + 4], "big")
            chunk_type = content[offset + 4:offset + 8].decode("ascii", errors="replace")
            data_start = offset + 8
            data_end = data_start + length
            if data_end + 4 > len(content):
                break
            chunks.append((chunk_type, content[data_start:data_end]))
            offset = data_end + 4
            if chunk_type == "IEND":
                break
        return chunks

    def _make_text_chunk(self, keyword: str, text: str) -> tuple[str, bytes]:
        return "tEXt", keyword.encode("latin-1") + b"\x00" + text.encode("latin-1")

    def _encode_chunk(self, chunk_type: str, chunk_data: bytes) -> bytes:
        chunk_type_bytes = chunk_type.encode("ascii")
        crc = zlib.crc32(chunk_type_bytes + chunk_data) & 0xFFFFFFFF
        return len(chunk_data).to_bytes(4, "big") + chunk_type_bytes + chunk_data + crc.to_bytes(4, "big")

    def _create_v2_metadata(self, request: CharacterCardCreate, name: str) -> dict[str, Any]:
        return {
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": {
                "name": name,
                "description": request.description,
                "personality": request.personality,
                "scenario": request.scenario,
                "first_mes": request.first_message,
                "mes_example": request.message_example,
                "creator_notes": "Created in DoubleTrouble",
                "system_prompt": "",
                "post_history_instructions": "",
                "alternate_greetings": [greeting for greeting in request.alternate_greetings if greeting.strip()],
                "tags": request.tags,
                "creator": request.creator,
                "character_version": "1.0",
                "extensions": {},
            },
        }

    def _safe_filename(self, name: str) -> str:
        safe = re.sub(r"[^\w\-. ]+", "_", name, flags=re.UNICODE).strip(" .")
        return safe or "Character"

    def _card_id(self, path: Path) -> str:
        digest = hashlib.sha1(path.name.encode("utf-8")).hexdigest()[:16]
        return f"card_{digest}"

    def _path_from_card_id(self, card_id: str) -> Path | None:
        cached_path = self._id_to_path.get(card_id)
        if cached_path is not None and cached_path.exists():
            return cached_path
        self.characters_dir.mkdir(parents=True, exist_ok=True)
        for path in self.characters_dir.glob("*.png"):
            cid = self._card_id(path)
            self._id_to_path[cid] = path
            if cid == card_id or path.name == card_id:
                return path
        return None
    def _unique_path(self, stem: str, suffix: str) -> Path:
        self.characters_dir.mkdir(parents=True, exist_ok=True)
        path = self.characters_dir / f"{stem}{suffix}"
        counter = 2
        while path.exists():
            path = self.characters_dir / f"{stem}_{counter}{suffix}"
            counter += 1
        return path
