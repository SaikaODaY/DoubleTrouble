from __future__ import annotations
import os
from pathlib import Path
from uuid import uuid4
from pydantic import BaseModel, Field
import yaml


class Persona(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    description: str = ""
    avatar: str = ""
    avatar_url: str = ""
    active: bool = False
    owner: str = ""


class PersonaCreate(BaseModel):
    name: str
    description: str = ""
    avatar: str = ""


class PersonaUpdate(BaseModel):
    name: str
    description: str = ""


class PersonasService:
    def __init__(self, path: Path, avatars_dir: Path) -> None:
        self.path = path
        self.avatars_dir = avatars_dir

    def list_all_personas(self) -> list[Persona]:
        return self._load()

    def list_personas(self, owner: str = "", is_admin: bool = False) -> list[Persona]:
        personas = self._load()
        clean_owner = owner.strip()
        if not clean_owner:
            unowned = [p for p in personas if not p.owner.strip()]
            return unowned if unowned else personas

        owner_lower = clean_owner.lower()
        owned = [p for p in personas if p.owner.strip().lower() == owner_lower]
        if not owned and is_admin:
            unowned = [p for p in personas if not p.owner.strip()]
            if unowned:
                for p in unowned:
                    p.owner = clean_owner
                self._save(personas)
                return unowned

        if not owned:
            default_persona = Persona(
                name=clean_owner,
                description="",
                owner=clean_owner,
                active=True,
            )
            personas.append(default_persona)
            self._save(personas)
            return [default_persona]
        return owned

    def create_persona(self, request: PersonaCreate, owner: str = "") -> Persona:
        personas = self._load()
        clean_owner = owner.strip()
        owner_lower = clean_owner.lower()
        user_personas = [
            p for p in personas
            if (p.owner.strip().lower() == owner_lower if clean_owner else not p.owner.strip())
        ]
        persona = Persona(
            name=request.name.strip() or "Persona",
            description=request.description.strip(),
            avatar=request.avatar.strip(),
            owner=clean_owner,
            active=not user_personas,
        )
        personas.append(persona)
        self._save(personas)
        return persona

    def activate_persona(self, persona_id: str, owner: str = "") -> Persona:
        personas = self._load()
        target = next((p for p in personas if p.id == persona_id), None)
        if target is None:
            raise KeyError(persona_id)
        scope_owner = (owner.strip() or target.owner.strip()).lower()
        for persona in personas:
            if persona.owner.strip().lower() == scope_owner:
                persona.active = persona.id == persona_id
        self._save(personas)
        return target

    def update_persona(self, persona_id: str, request: PersonaUpdate, owner: str = "", is_admin: bool = False) -> Persona:
        personas = self._load()
        selected: Persona | None = None
        clean_owner = owner.strip().lower()
        for persona in personas:
            if persona.id == persona_id:
                if clean_owner and persona.owner.strip() and persona.owner.strip().lower() != clean_owner and not is_admin:
                    raise KeyError(persona_id)
                persona.name = request.name.strip() or "Persona"
                persona.description = request.description.strip()
                selected = persona
                break
        if selected is None:
            raise KeyError(persona_id)
        self._save(personas)
        return selected

    def delete_persona(self, persona_id: str, owner: str = "", is_admin: bool = False) -> Persona:
        personas = self._load()
        selected = next((persona for persona in personas if persona.id == persona_id), None)
        if selected is None:
            raise KeyError(persona_id)
        clean_owner = owner.strip().lower()
        if clean_owner and selected.owner.strip() and selected.owner.strip().lower() != clean_owner and not is_admin:
            raise KeyError(persona_id)
        remaining = [persona for persona in personas if persona.id != persona_id]
        scope_owner = selected.owner.strip().lower()
        scope_remaining = [p for p in remaining if p.owner.strip().lower() == scope_owner]
        if selected.active and scope_remaining:
            scope_remaining[0].active = True
        if selected.avatar:
            avatar_path = self.avatars_dir / Path(selected.avatar).name
            if avatar_path.exists():
                avatar_path.unlink()
        self._save(remaining)
        return selected
    def set_avatar(self, persona_id: str, filename: str, content: bytes) -> Persona:
        suffix = Path(filename).suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
            raise ValueError("Unsupported avatar format")
        personas = self._load()
        selected: Persona | None = None
        self.avatars_dir.mkdir(parents=True, exist_ok=True)
        for old_file in self.avatars_dir.glob(f"{persona_id}.*"):
            if old_file.suffix.lower() != suffix:
                try:
                    old_file.unlink()
                except OSError:
                    pass
        avatar_filename = f"{persona_id}{suffix}"
        avatar_path = self.avatars_dir / avatar_filename
        avatar_path.write_bytes(content)
        mtime = int(avatar_path.stat().st_mtime)
        for persona in personas:
            if persona.id == persona_id:
                persona.avatar = avatar_filename
                persona.avatar_url = f"/api/personas/avatars/{avatar_filename}?v={mtime}"
                selected = persona
                break
        if selected is None:
            raise KeyError(persona_id)
        self._save(personas)
        return selected

    def avatar_path(self, filename: str) -> Path:
        safe_name = Path(filename).name
        path = self.avatars_dir / safe_name
        if not path.exists():
            raise FileNotFoundError(safe_name)
        return path

    def _load(self) -> list[Persona]:
        if not self.path.exists():
            return []
        with self.path.open("r", encoding="utf-8") as personas_file:
            raw = yaml.safe_load(personas_file) or []
        personas = [Persona.model_validate(item) for item in raw if isinstance(item, dict)]
        for persona in personas:
            if persona.avatar:
                avatar_file = self.avatars_dir / Path(persona.avatar).name
                mtime = int(avatar_file.stat().st_mtime) if avatar_file.exists() else 0
                base_url = f"/api/personas/avatars/{Path(persona.avatar).name}"
                persona.avatar_url = f"{base_url}?v={mtime}" if mtime else base_url
        return personas

    def _save(self, personas: list[Persona]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(".yaml.tmp")
        with tmp_path.open("w", encoding="utf-8") as personas_file:
            yaml.safe_dump([persona.model_dump(mode="json") for persona in personas], personas_file, sort_keys=False, allow_unicode=True)
        os.replace(tmp_path, self.path)
