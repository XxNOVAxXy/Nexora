from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .config import settings


class GeminiSettings:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or settings.gemini_settings_path

    def status(self) -> dict[str, Any]:
        values = self._read()
        api_key = values.get("apiKey", "")
        return {
            "configured": bool(api_key),
            "enabled": bool(api_key) and bool(values.get("enabled", False)),
            "model": values.get("model", os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")),
            "maskedKey": f"••••{api_key[-4:]}" if api_key else None,
        }

    def save(self, api_key: str | None, model: str) -> dict[str, Any]:
        values = self._read()
        key = api_key.strip() if api_key and api_key.strip() else values.get("apiKey", "")
        self._write({"apiKey": key, "model": model.strip(), "enabled": True})
        return self.status()

    def disable(self) -> dict[str, Any]:
        values = self._read()
        values["enabled"] = False
        self._write(values)
        return self.status()

    def _read(self) -> dict[str, Any]:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                return {}
        return {
            "apiKey": os.getenv("GOOGLE_GEMINI_API_KEY", os.getenv("GEMINI_API_KEY", "")),
            "model": os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite"),
            "enabled": False,
        }

    def _write(self, values: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(values, indent=2), encoding="utf-8")
