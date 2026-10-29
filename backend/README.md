# Nexora API

Backend local de Nexora con FastAPI. La primera integración implementada es Gmail mediante OAuth 2.0.

## Ejecutar

Desde la raíz del proyecto:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
python -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

El proyecto de Google Cloud debe tener habilitada la Gmail API y registrada esta URI de redirección:

`http://localhost:8000/api/auth/callback/google`

El token de la cuenta se guarda localmente en `backend/data/gmail_token.json` y nunca se envía al navegador. El botón **Conectar Gmail** de Configuración abre directamente `/api/auth/gmail/start`, que redirige a Google.
