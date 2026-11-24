# Base de datos de Nexora (Fase 2)

El esquema es `nexora_esquema_mysql.sql`, sin cambios. Las tablas ya existen en tu MySQL: nada de esto las recrea ni las borra.

## 1. Dependencias

```powershell
.\.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
```

## 2. Variables en `.env` (ver `.env.example`)

```
NEXORA_ALMACEN=json          # json (por defecto) | db
DATABASE_URL=mysql+pymysql://nexora_app:<contraseña>@localhost:3306/nexora?charset=utf8mb4
NEXORA_LLAVE_CIFRADO=<llave Fernet>
```

Genera la llave **una sola vez** y guárdala fuera del repo. Si se pierde, las credenciales cifradas ya no se pueden leer:

```powershell
.\.venv\Scripts\python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

## 3. Marcar la base con Alembic (sin tocar las tablas)

```powershell
.\.venv\Scripts\alembic -c backend\alembic.ini stamp head     # crea solo la tabla alembic_version
.\.venv\Scripts\alembic -c backend\alembic.ini current        # 0001_baseline (head)
.\.venv\Scripts\alembic -c backend\alembic.ini check          # compara los modelos con tu base
```

La baseline (`0001`) solo se marca con `stamp`. Si alguien la ejecuta sobre una base que ya tiene las tablas, se detiene sin tocar nada, y su `downgrade` nunca borra tablas. Las migraciones siguientes (`0002`…) sí se aplican con `upgrade head`.

## 3b. Aplicar las migraciones nuevas (0002: `documentos.recepcion`, `eventos.origen`, `eventos.detalle`)

```powershell
.\.venv\Scripts\alembic -c backend\alembic.ini upgrade head     # solo agrega columnas; no toca las existentes
```

## 4. Importar lo que hay en JSON

```powershell
.\.venv\Scripts\python scripts\importar_json_a_db.py --simular   # muestra qué haría y lo deshace
.\.venv\Scripts\python scripts\importar_json_a_db.py             # importa (una sola transacción)
.\.venv\Scripts\python scripts\importar_json_a_db.py             # otra vez: no duplica
```

## 5. Encender el modo db

Pon `NEXORA_ALMACEN=db` en el `.env`, reinicia el backend y abre `http://localhost:8000/api/salud/db`.

Para volver a JSON, pon `NEXORA_ALMACEN=json`: los archivos de `backend/data` siguen ahí.

## Qué va en cada tabla

| Tabla | Qué se guarda |
|---|---|
| `usuarios` | Solo el usuario `sistema`: está inactivo y su contraseña es aleatoria. Es dueño de las cuentas hasta que exista el login. |
| `cuentas_correo` | Una por correo. `credencial_cifrada` lleva el token de Gmail cifrado con Fernet. El importador la deja vacía, aunque cifrada. |
| `documentos` | Un renglón por adjunto (cuenta + message_id + part_id). La recepción (`attachment_id`, `mime`, `diagnostico`, `bandeja`) va en la columna `recepcion`; `datos` queda para la extracción. |
| `envios` | Un renglón por intento (`intento` = 1, 2, 3…). El detalle completo sigue en el JSON de la extracción. |
| `eventos` | Bitácora por etapa. `resultado` (ok, aviso o error) se deduce del código; `origen` y `detalle` en sus columnas. |

Las fechas se guardan en UTC: la conexión fija `time_zone = '+00:00'`. La interfaz las muestra en hora de México.
