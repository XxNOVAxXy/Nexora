-- Nexora: esquema inicial de base de datos (MySQL 8.4 / MariaDB 10.11+)
-- Portable a PostgreSQL: solo tipos estándar (los equivalentes van comentados).
-- Tipos, estructuras y versiones siguen en JSON en disco (fase actual).
-- Fechas en UTC. Juego de caracteres utf8mb4 para acentos y ñ.
-- Alembic 0002 agregó: documentos.recepcion, eventos.origen y eventos.detalle.

CREATE DATABASE IF NOT EXISTS nexora
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE nexora;

-- 1. USUARIOS: login. Cada usuario tiene sus propias cuentas de correo.
CREATE TABLE usuarios (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,     -- PG: BIGSERIAL
  usuario         VARCHAR(80)  NOT NULL,
  nombre          VARCHAR(150) NOT NULL,
  correo          VARCHAR(255) NULL,
  hash_contrasena VARCHAR(255) NOT NULL,                 -- argon2, nunca la contraseña en texto plano
  rol             VARCHAR(20)  NOT NULL DEFAULT 'operador', -- admin | operador
  activo          BOOLEAN      NOT NULL DEFAULT TRUE,
  ultimo_acceso   DATETIME     NULL,                     -- PG: TIMESTAMPTZ
  creado          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT uq_usuarios_usuario UNIQUE (usuario)
);

-- 2. CUENTAS_CORREO: buzones de cada usuario, con la credencial cifrada.
CREATE TABLE cuentas_correo (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  usuario_id          BIGINT       NOT NULL,
  proveedor           VARCHAR(10)  NOT NULL,             -- gmail | imap
  correo              VARCHAR(255) NOT NULL,
  servidor_imap       VARCHAR(255) NULL,                 -- solo IMAP
  puerto_imap         INT          NULL,
  credencial_cifrada  TEXT         NOT NULL,             -- token OAuth o contraseña IMAP, cifrada con Fernet (llave en .env)
  automatico_activo   BOOLEAN      NOT NULL DEFAULT FALSE,
  ultima_revision     DATETIME     NULL,
  activo              BOOLEAN      NOT NULL DEFAULT TRUE,
  creado              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cuentas_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
  CONSTRAINT uq_cuentas_usuario_correo UNIQUE (usuario_id, correo)
);

-- 3. DOCUMENTOS: cada adjunto leído. El archivo vive en disco; aquí, su ruta y los datos.
CREATE TABLE documentos (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  cuenta_id        BIGINT       NOT NULL,
  message_id       VARCHAR(255) NOT NULL,                -- id del correo
  part_id          VARCHAR(100) NOT NULL,                -- id del adjunto dentro del correo
  remitente        VARCHAR(255) NULL,
  asunto           VARCHAR(500) NULL,
  fecha_correo     DATETIME     NULL,
  nombre_archivo   VARCHAR(255) NOT NULL,
  ruta_original    VARCHAR(500) NOT NULL,                -- storage/originales/<cuenta>/<aaaa>/<mm>/<sha256>.<ext>
  sha256           CHAR(64)     NOT NULL,
  tamano_bytes     BIGINT       NULL,
  tipo             VARCHAR(10)  NULL,                    -- EC | A | G | F | RF ...
  aseguradora      VARCHAR(150) NULL,
  estructura       VARCHAR(150) NULL,                    -- nombre/id de la estructura en JSON
  version          INT          NULL,                    -- versión de la estructura usada
  modo             VARCHAR(10)  NULL,                    -- manual | ia
  estado           VARCHAR(30)  NOT NULL DEFAULT 'leido',-- leido | extraido | requiere_revision | captura_manual | enviado | error
  motivo           VARCHAR(50)  NULL,                    -- pdf_protegido | pdf_danado | pdf_escaneado | formato_no_soportado ...
  datos            JSON         NULL,                    -- PG: JSONB. JSON de extracción (mismo formato que SaveData)
  creado           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actualizado      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  recepcion        JSON         NULL,                    -- PG: JSONB. attachment_id, mime, diagnostico, bandeja (Alembic 0002)
  CONSTRAINT fk_documentos_cuenta FOREIGN KEY (cuenta_id) REFERENCES cuentas_correo(id),
  CONSTRAINT uq_documentos_adjunto UNIQUE (cuenta_id, message_id, part_id)
);
CREATE INDEX ix_documentos_estado ON documentos (estado);
CREATE INDEX ix_documentos_sha256 ON documentos (sha256);
CREATE INDEX ix_documentos_tipo   ON documentos (tipo, aseguradora);

-- 4. ENVIOS: cada intento de envío a SaveData.
CREATE TABLE envios (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  documento_id    BIGINT      NOT NULL,
  usuario_id      BIGINT      NULL,                      -- NULL si fue automático
  origen          VARCHAR(15) NOT NULL,                  -- automatico | configurar | manual
  estado          VARCHAR(15) NOT NULL,                  -- enviado | pendiente | error | incierto | no_enviado
  intento         INT         NOT NULL DEFAULT 1,
  codigo_http     INT         NULL,
  respuesta       TEXT        NULL,
  datos_enviados  JSON        NULL,                      -- copia exacta de lo que se mandó
  fecha           DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_envios_documento FOREIGN KEY (documento_id) REFERENCES documentos(id),
  CONSTRAINT fk_envios_usuario   FOREIGN KEY (usuario_id)   REFERENCES usuarios(id)
);
CREATE INDEX ix_envios_documento ON envios (documento_id, fecha);
CREATE INDEX ix_envios_estado    ON envios (estado);

-- 5. EVENTOS: bitácora de todo el proceso, para revisar fallas y reprocesar.
CREATE TABLE eventos (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  documento_id  BIGINT      NULL,                        -- NULL en eventos de cuenta (ej. falla al conectar)
  cuenta_id     BIGINT      NULL,
  usuario_id    BIGINT      NULL,
  etapa         VARCHAR(15) NOT NULL,                    -- lectura | diagnostico | extraccion | envio | reproceso | login
  resultado     VARCHAR(10) NOT NULL,                    -- ok | error | aviso
  codigo        VARCHAR(50) NULL,                        -- pdf_protegido, sin_conexion, campo_faltante ...
  mensaje       VARCHAR(1000) NULL,
  fecha         DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  origen        VARCHAR(15) NULL,                        -- automatico | manual | reprocesar | configurar (Alembic 0002)
  detalle       JSON        NULL,                        -- PG: JSONB. Datos pequeños del evento (Alembic 0002)
  CONSTRAINT fk_eventos_documento FOREIGN KEY (documento_id) REFERENCES documentos(id),
  CONSTRAINT fk_eventos_cuenta    FOREIGN KEY (cuenta_id)    REFERENCES cuentas_correo(id),
  CONSTRAINT fk_eventos_usuario   FOREIGN KEY (usuario_id)   REFERENCES usuarios(id)
);
CREATE INDEX ix_eventos_documento ON eventos (documento_id, fecha);
CREATE INDEX ix_eventos_fecha     ON eventos (fecha);
CREATE INDEX ix_eventos_codigo    ON eventos (codigo);
