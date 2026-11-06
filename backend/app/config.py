from dataclasses import dataclass
from pathlib import Path
import os

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    google_client_id: str = os.getenv("GOOGLE_CLIENT_ID", "")
    google_client_secret: str = os.getenv("GOOGLE_CLIENT_SECRET", "")
    google_redirect_uri: str = os.getenv(
        "GOOGLE_REDIRECT_URI",
        "http://localhost:8000/api/auth/callback/google",
    )
    frontend_url: str = os.getenv("FRONTEND_URL", "http://localhost:5173")
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8000"))
    token_path: Path = PROJECT_ROOT / "backend" / "data" / "gmail_token.json"
    gemini_settings_path: Path = PROJECT_ROOT / "backend" / "data" / "gemini_settings.json"
    extracciones_path: Path = PROJECT_ROOT / "backend" / "data" / "extracciones"
    savedata_settings_path: Path = PROJECT_ROOT / "backend" / "data" / "savedata_settings.json"
    configuracion_path: Path = PROJECT_ROOT / "backend" / "data" / "configuracion"
    clasificaciones_path: Path = PROJECT_ROOT / "backend" / "data" / "clasificaciones"
    # URL del servicio SaveData; el frontend nunca la llama directamente.
    savedata_url: str = os.getenv("SAVEDATA_URL", "")


settings = Settings()
