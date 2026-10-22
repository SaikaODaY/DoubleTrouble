from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ExtensionInstallRequest(BaseModel):
    source: str
    name: str = ""
    branch: str = ""
    enabled: bool = True
    overwrite: bool = False


class ExtensionRecord(BaseModel):
    name: str
    type: str = "local"
    enabled: bool = True
    source: str = ""
    branch: str = ""
    installed_at: str = Field(default_factory=utc_now)
    updated_at: str = Field(default_factory=utc_now)
class ExtensionSummary(BaseModel):
    name: str
    external_name: str
    type: str
    enabled: bool
    source: str
    manifest: dict[str, Any] = Field(default_factory=dict)
    installed_at: str
    updated_at: str


class ExtensionsService:
    def __init__(self, extensions_root: Path, registry_path: Path, built_in_root: Path | None = None) -> None:
        self.extensions_root = extensions_root
        self.registry_path = registry_path
        self.built_in_root = built_in_root
        self.settings_path = self.extensions_root / "extension_settings.json"

    def get_settings(self) -> dict[str, Any]:
        if not self.settings_path.exists():
            return {}
        try:
            data = json.loads(self.settings_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            return {}

    def save_settings(self, patch: dict[str, Any], merge: bool = True) -> dict[str, Any]:
        current = self.get_settings() if merge else {}
        for key, value in (patch or {}).items():
            if isinstance(value, dict) and isinstance(current.get(key), dict) and merge:
                current[key] = {**current[key], **value}
            else:
                current[key] = value
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        self.settings_path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
        return current

    def list_extensions(self) -> list[ExtensionSummary]:
        records = self._load_registry()
        records_by_name = {record.name: record for record in records}
        built_in_names = self._built_in_names()
        built_in = [self._built_in_summary(name, records_by_name.get(name)) for name in sorted(built_in_names)]
        user = [
            self._summary(record)
            for record in sorted(records, key=lambda item: item.name.lower())
            if record.name not in built_in_names and self.extension_dir(record.name).exists()
        ]
        return built_in + user

    def discover_enabled(self) -> list[dict[str, str]]:
        return [
            {"name": summary.external_name, "type": summary.type}
            for summary in self.list_extensions()
            if summary.enabled and summary.manifest
        ]

    def install(self, request: ExtensionInstallRequest) -> ExtensionSummary:
        source = request.source.strip()
        branch = request.branch.strip()
        if not source:
            raise ValueError("Extension source URL is required")
        if not self._looks_like_git_url(source):
            raise ValueError("Only HTTP(S) / Git repository URLs are allowed")
        name = self._safe_name(request.name.strip() or self._name_from_source(source))
        if not name or name in self._built_in_names():
            raise ValueError("Invalid or reserved extension name")

        target = self.extension_dir(name)
        if target.exists():
            if not request.overwrite:
                raise FileExistsError(name)
            shutil.rmtree(target, ignore_errors=True)

        target.parent.mkdir(parents=True, exist_ok=True)
        self._clone_or_download_git(source, target, branch)

        if not (target / "manifest.json").exists():
            shutil.rmtree(target, ignore_errors=True)
            raise ValueError("Extension must contain manifest.json")

        records = [record for record in self._load_registry() if record.name != name]
        records.append(ExtensionRecord(name=name, type="third-party", enabled=request.enabled, source=source, branch=branch))
        self._save_registry(records)
        return self._summary(records[-1])

    def install_zip(self, filename: str, content: bytes, name: str = "", enabled: bool = True, overwrite: bool = True) -> ExtensionSummary:
        if not content:
            raise ValueError("Archive is empty")
        stem = Path(filename or "extension.zip").stem
        safe_name = self._safe_name(name.strip() or stem)
        if not safe_name or safe_name in self._built_in_names():
            raise ValueError("Invalid or reserved extension name")
        target = self.extension_dir(safe_name)
        if target.exists():
            if not overwrite:
                raise FileExistsError(safe_name)
            shutil.rmtree(target, ignore_errors=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        self._extract_zip_to_target(content, target)
        if not (target / "manifest.json").exists():
            shutil.rmtree(target, ignore_errors=True)
            raise ValueError("Extension archive must contain manifest.json")
        records = [record for record in self._load_registry() if record.name != safe_name]
        records.append(ExtensionRecord(name=safe_name, type="third-party", enabled=enabled, source=f"zip:{Path(filename).name}"))
        self._save_registry(records)
        return self._summary(records[-1])

    def update(self, name: str) -> ExtensionSummary:
        safe_name = self._safe_name(name)
        records = self._load_registry()
        record = next((item for item in records if item.name == safe_name), None)
        if record is None or not self.extension_dir(safe_name).exists():
            raise KeyError(name)
        target = self.extension_dir(safe_name)
        if (target / ".git").exists():
            result = subprocess.run(["git", "-C", str(target), "pull", "--ff-only"], capture_output=True, text=True, timeout=120, check=False)
            if result.returncode != 0 and self._looks_like_git_url(record.source):
                shutil.rmtree(target, ignore_errors=True)
                self._clone_or_download_git(record.source, target, record.branch)
        elif self._looks_like_git_url(record.source):
            shutil.rmtree(target, ignore_errors=True)
            self._clone_or_download_git(record.source, target, record.branch)
        else:
            raise ValueError("Extension does not have an updatable Git source")
        record.updated_at = utc_now()
        self._save_registry(records)
        return self._summary(record)
    def set_enabled(self, name: str, enabled: bool) -> ExtensionSummary:
        safe_name = self._safe_name(name)
        records = self._load_registry()
        if safe_name in self._built_in_names():
            record = next((item for item in records if item.name == safe_name), None)
            if record is None:
                record = ExtensionRecord(name=safe_name, type="system", enabled=enabled, source="built-in")
                records.append(record)
            record.type = "system"
            record.enabled = enabled
            record.source = "built-in"
            record.updated_at = utc_now()
            self._save_registry(records)
            return self._built_in_summary(safe_name, record)
        for record in records:
            if record.name == safe_name:
                record.enabled = enabled
                record.updated_at = utc_now()
                self._save_registry(records)
                return self._summary(record)
        raise KeyError(name)

    def delete(self, name: str) -> None:
        safe_name = self._safe_name(name)
        records = self._load_registry()
        next_records = [record for record in records if record.name != safe_name]
        if len(next_records) == len(records):
            raise KeyError(name)
        shutil.rmtree(self.extension_dir(safe_name), ignore_errors=True)
        self._save_registry(next_records)

    def extension_dir(self, name: str) -> Path:
        return self.extensions_root / "third-party" / self._safe_name(name)

    def built_in_extension_dir(self, name: str) -> Path:
        if self.built_in_root is None:
            raise FileNotFoundError(name)
        return self.built_in_root / self._safe_name(name)

    def file_path(self, external_path: str) -> Path:
        parts = [part for part in Path(external_path.replace("\\", "/")).parts if part not in {"/", "..", "."}]
        if len(parts) >= 2 and parts[0] == "built-in":
            base = self.built_in_extension_dir(parts[1])
            path = base.joinpath(*parts[2:])
            root = self.built_in_root.resolve() if self.built_in_root is not None else base.resolve()
        elif len(parts) >= 2 and parts[0] == "third-party":
            base = self.extension_dir(parts[1])
            path = base.joinpath(*parts[2:])
            root = self.extensions_root.resolve()
        elif parts:
            if parts[0] in self._built_in_names():
                base = self.built_in_extension_dir(parts[0])
                root = self.built_in_root.resolve() if self.built_in_root is not None else base.resolve()
            else:
                base = self.extension_dir(parts[0])
                root = self.extensions_root.resolve()
            path = base.joinpath(*parts[1:])
        else:
            raise FileNotFoundError(external_path)
        resolved = path.resolve()
        if root not in resolved.parents and resolved != root:
            raise FileNotFoundError(external_path)
        if not resolved.exists() or not resolved.is_file():
            raise FileNotFoundError(external_path)
        return resolved

    def _summary(self, record: ExtensionRecord) -> ExtensionSummary:
        return ExtensionSummary(
            name=record.name,
            external_name=f"third-party/{record.name}",
            type=record.type,
            enabled=record.enabled,
            source=record.source,
            manifest=self._manifest(record.name),
            installed_at=record.installed_at,
            updated_at=record.updated_at,
        )

    def _built_in_summary(self, name: str, status: ExtensionRecord | None = None) -> ExtensionSummary:
        return ExtensionSummary(
            name=name,
            external_name=f"built-in/{name}",
            type="system",
            enabled=status.enabled if status else True,
            source="built-in",
            manifest=self._built_in_manifest(name),
            installed_at=status.installed_at if status else "built-in",
            updated_at=status.updated_at if status else "built-in",
        )

    def _manifest(self, name: str) -> dict[str, Any]:
        path = self.extension_dir(name) / "manifest.json"
        if not path.exists():
            return {}
        try:
            parsed = json.loads(path.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def _built_in_manifest(self, name: str) -> dict[str, Any]:
        try:
            path = self.built_in_extension_dir(name) / "manifest.json"
        except FileNotFoundError:
            return {}
        if not path.exists():
            return {}
        try:
            parsed = json.loads(path.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}

    def _built_in_names(self) -> set[str]:
        if self.built_in_root is None or not self.built_in_root.exists():
            return set()
        return {path.name for path in self.built_in_root.iterdir() if path.is_dir() and (path / "manifest.json").exists()}

    def _load_registry(self) -> list[ExtensionRecord]:
        if not self.registry_path.exists():
            return []
        with self.registry_path.open("r", encoding="utf-8") as registry_file:
            raw = yaml.safe_load(registry_file) or []
        return [ExtensionRecord.model_validate(item) for item in raw if isinstance(item, dict)]

    def _save_registry(self, records: list[ExtensionRecord]) -> None:
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        with self.registry_path.open("w", encoding="utf-8") as registry_file:
            yaml.safe_dump([record.model_dump(mode="json") for record in records], registry_file, sort_keys=False, allow_unicode=True)

    def _safe_name(self, value: str) -> str:
        return re.sub(r"[^\w\-.]+", "_", value, flags=re.UNICODE).strip("._-")[:80]

    def _name_from_source(self, source: str) -> str:
        cleaned = source.rstrip("/\\")
        name = Path(cleaned).name
        return name.removesuffix(".git")

    def _looks_like_git_url(self, source: str) -> bool:
        return source.startswith(("https://", "http://", "git@"))

    def _clone_or_download_git(self, source: str, target: Path, branch: str = "") -> None:
        cmd = ["git", "clone", "--depth", "1"]
        if branch:
            cmd.extend(["--branch", branch])
        cmd.extend([source, str(target)])
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
            if result.returncode == 0 and (target / "manifest.json").exists():
                return
            git_err = (result.stderr or result.stdout or "git clone failed").strip()
        except (OSError, subprocess.SubprocessError) as error:
            git_err = str(error)

        shutil.rmtree(target, ignore_errors=True)
        gh_match = re.match(r"^https?://github\.com/([^/]+)/([^/#?]+?)(?:\.git)?(?:/tree/([^/#?]+))?/?$", source.strip())
        if gh_match:
            owner, repo, url_branch = gh_match.group(1), gh_match.group(2), gh_match.group(3)
            candidates = [b for b in [branch, url_branch, "HEAD", "main", "master"] if b]
            for ref in dict.fromkeys(candidates):
                zip_url = f"https://codeload.github.com/{owner}/{repo}/zip/{ref}"
                try:
                    req = urllib.request.Request(zip_url, headers={"User-Agent": "DoubleTrouble/1.0"})
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        data = resp.read()
                    self._extract_zip_to_target(data, target)
                    if (target / "manifest.json").exists():
                        return
                except Exception:
                    shutil.rmtree(target, ignore_errors=True)
        raise RuntimeError(git_err)

    def _extract_zip_to_target(self, content: bytes, target: Path) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_root = Path(tmp_dir)
            try:
                with zipfile.ZipFile(io.BytesIO(content)) as archive:
                    for member in archive.infolist():
                        member_path = (tmp_root / member.filename).resolve()
                        if tmp_root.resolve() not in member_path.parents and member_path != tmp_root.resolve():
                            raise ValueError("Unsafe path in zip archive")
                        archive.extract(member, tmp_root)
            except zipfile.BadZipFile as error:
                raise ValueError("Invalid ZIP archive") from error

            source_dir = self._find_manifest_dir(tmp_root)
            if source_dir is None:
                raise ValueError("Extension archive must contain manifest.json")
            shutil.copytree(source_dir, target, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__"))

    def _find_manifest_dir(self, root: Path) -> Path | None:
        if (root / "manifest.json").exists():
            return root
        for candidate in sorted(root.rglob("manifest.json"), key=lambda item: len(item.parts)):
            if candidate.is_file():
                return candidate.parent
        return None
