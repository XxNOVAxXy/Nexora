"""Cifrado de credenciales (Fernet) y hash de contraseñas (argon2).

- ``Cifrador``: cifra y descifra ``cuentas_correo.credencial_cifrada`` con la llave ``NEXORA_LLAVE_CIFRADO``.
- ``hash_contrasena`` / ``verificar_contrasena``: para ``usuarios.hash_contrasena``. El login (pantalla, sesión,
  endpoints) no está aquí: lo hace otra persona; solo se deja la función de hash.
"""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.fernet import Fernet, InvalidToken


class LlaveCifradoInvalida(ValueError):
    """Falta NEXORA_LLAVE_CIFRADO o no es una llave Fernet válida."""


class CredencialIlegible(ValueError):
    """La credencial no se puede descifrar con esta llave (otra llave o dato dañado)."""


class Cifrador:
    def __init__(self, llave: str) -> None:
        if not llave:
            raise LlaveCifradoInvalida(
                "Falta NEXORA_LLAVE_CIFRADO en el .env (obligatoria con NEXORA_ALMACEN=db). Genera una con: "
                'python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"')
        try:
            self._fernet = Fernet(llave.encode("ascii"))
        except (ValueError, UnicodeEncodeError) as error:
            raise LlaveCifradoInvalida("NEXORA_LLAVE_CIFRADO no es una llave Fernet valida (32 bytes en base64 url-safe, 44 caracteres).") from error

    def cifrar(self, texto: str) -> str:
        return self._fernet.encrypt(texto.encode("utf-8")).decode("ascii")

    def descifrar(self, token: str) -> str:
        try:
            return self._fernet.decrypt(token.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeError) as error:
            raise CredencialIlegible("La credencial no se puede descifrar con NEXORA_LLAVE_CIFRADO (¿cambió la llave?).") from error


_hasher = PasswordHasher()


def hash_contrasena(contrasena: str) -> str:
    """Hash argon2id (con sal) para ``usuarios.hash_contrasena``. Nunca se guarda la contraseña en texto plano."""
    return _hasher.hash(contrasena)


def verificar_contrasena(hash_guardado: str, contrasena: str) -> bool:
    try:
        return _hasher.verify(hash_guardado, contrasena)
    except (VerificationError, InvalidHashError):
        return False
