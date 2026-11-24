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
    automatico_path: Path = PROJECT_ROOT / "backend" / "data" / "automatico"
    plantilla_campos_path: Path = PROJECT_ROOT / "backend" / "data" / "plantilla_campos"
    tipos_documento_path: Path = PROJECT_ROOT / "backend" / "data" / "tipos_documento"
    # Repositorios en JSON (después, la base de datos): documentos recibidos y eventos del proceso.
    documentos_path: Path = PROJECT_ROOT / "backend" / "data" / "documentos"
    eventos_path: Path = PROJECT_ROOT / "backend" / "data" / "eventos"
    # Archivos originales: storage/originales/<cuenta>/<aaaa>/<mm>/<sha256>.<ext> (fuera de git).
    originales_path: Path = PROJECT_ROOT / "storage" / "originales"
    # Opcional: minutos entre revisiones de la extracción automática (por defecto 20).
    intervalo_minutos: str = os.getenv("NEXORA_INTERVALO_MINUTOS", "")
    # URL del servicio SaveData; el frontend nunca la llama directamente.
    savedata_url: str = os.getenv("SAVEDATA_URL", "")
    # Almacenamiento de documentos, eventos y envíos: "json" (por defecto) o "db" (DATABASE_URL).
    almacen: str = os.getenv("NEXORA_ALMACEN", "json").strip().lower() or "json"
    # mysql+pymysql://usuario:contrasena@localhost:3306/nexora?charset=utf8mb4 (o postgresql+psycopg://...).
    database_url: str = os.getenv("DATABASE_URL", "").strip()
    # Llave Fernet para cuentas_correo.credencial_cifrada; obligatoria con NEXORA_ALMACEN=db.
    llave_cifrado: str = os.getenv("NEXORA_LLAVE_CIFRADO", "").strip()


settings = Settings()
