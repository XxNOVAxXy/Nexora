"""Extracción por reglas, sin IA (modo manual): reescritura de ``singularity/backend/app/extraction.py``.

Del proyecto anterior se toman ``FIELD_DEFINITIONS`` (etiquetas y si el campo es obligatorio), ``_rules_fields``
(buscar la etiqueta y tomar el valor que la sigue) y ``SPECIFIC_KEYS_BY_POLICY`` (qué campos son de qué tipo de póliza).
Aquí las reglas ya no están fijas en código: salen de los **campos configurados** de cada tipo de documento (nombre,
sinónimos, regex opcional y obligatorio). Lo de ``FIELD_DEFINITIONS`` queda como sinónimos y obligatorios por
defecto de los campos de las plantillas.

Lectura del PDF solo con pdfplumber (MIT) y pypdf (BSD): nunca PyMuPDF (AGPL) ni Poppler/pdf2image (GPL). Para OCR,
la página se dibuja con pypdfium2 (Apache/BSD, lo trae pdfplumber) y se lee con pytesseract si Tesseract está
instalado (``ocr_disponible``).

Resultado: la misma forma que el de Gemini (``resultados_campos``, ``transacciones``, ``resumen``…) para que el
borrador, la validación contable y el envío a SaveData no cambien. Además: ``metodo="reglas"``, ``encontrados``,
``total_campos`` y ``faltantes`` (obligatorios que no se encontraron).
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import shutil
import unicodedata
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger("nexora.reglas")

MAX_VALOR = 500
MAX_SINONIMOS = 10
MAX_REGEX = 300
MODELO_REGLAS = "reglas"

# --- Lo que viene del proyecto anterior (FIELD_DEFINITIONS y SPECIFIC_KEYS_BY_POLICY) --------------------
# clave anterior → (nombre del campo en Nexora, sinónimos, obligatorio). Los nombres son los de plantillas_tipos.
FIELD_DEFINITIONS: tuple[tuple[str, str, tuple[str, ...], bool], ...] = (
    ("policyNumber", "Número de póliza", ("póliza", "no. de póliza", "número de póliza", "póliza no", "policy"), True),
    ("insurer", "Aseguradora", ("aseguradora", "compañía de seguros", "afianzadora"), True),
    ("client", "Contratante", ("contratante", "tomador", "asegurado titular", "titular", "cliente", "fiado"), True),
    ("startDate", "Vigencia desde", ("vigencia desde", "fecha de inicio", "inicio de vigencia", "vigencia inicial", "desde"), True),
    ("endDate", "Vigencia hasta", ("vigencia hasta", "fecha de vencimiento", "fin de vigencia", "vencimiento", "vigencia final", "hasta"), True),
    ("premium", "Prima total", ("prima total", "importe total", "total a pagar"), True),
    ("netPremium", "Prima neta", ("prima neta",), False),
    ("currency", "Moneda", ("moneda", "currency"), False),
    ("paymentMethod", "Forma de pago", ("forma de pago", "frecuencia de pago", "periodicidad"), False),
    ("vehicleBrand", "Marca", ("marca", "marca y modelo"), True),
    ("vehiclePlates", "Placas", ("placas", "matrícula"), True),
    ("vehicleVin", "Número de serie", ("número de serie", "no. de serie", "serie", "vin", "niv"), False),
    ("vehicleEngine", "Motor", ("motor", "no. de motor"), False),
    ("sumInsured", "Suma asegurada", ("suma asegurada", "límite asegurado", "monto asegurado"), True),
    ("deductible", "Deducible", ("deducible", "deductible"), False),
    ("coinsurance", "Coaseguro", ("coaseguro",), False),
    ("beneficiaries", "Beneficiarios", ("beneficiarios", "beneficiario"), False),
    ("coverageLevel", "Plan", ("plan", "nivel de cobertura", "tipo de cobertura", "paquete"), False),
    ("bondType", "Tipo de fianza", ("tipo de fianza", "ramo"), True),
    ("bondedAmount", "Monto afianzado", ("monto afianzado", "importe afianzado", "monto de la fianza"), True),
    ("propertyAddress", "Dirección", ("dirección", "domicilio", "ubicación del inmueble"), False),
    ("receiptPeriod", "Periodo", ("periodo del recibo", "periodo"), False),
    ("paidAmount", "Importe pagado", ("importe pagado", "monto pagado", "total pagado"), True),
    ("agentName", "Agente", ("nombre del agente", "agente"), False),
    ("agencyCode", "Clave de agente", ("clave de agente", "clave de agencia", "código de agencia"), False),
    ("issueDate", "Fecha de emisión", ("fecha de emisión", "emisión", "fecha de expedición"), False),
    ("rfc", "RFC", ("rfc", "r.f.c."), False),
    ("observations", "Observaciones", ("observaciones", "notas", "remarks"), False),
)

# Campos específicos de cada tipo de póliza (claves de arriba) → código del tipo de documento en Nexora.
SPECIFIC_KEYS_BY_POLICY: dict[str, set[str]] = {
    "A": {"vehicleBrand", "vehiclePlates", "vehicleVin", "vehicleEngine", "sumInsured", "deductible"},
    "G": {"sumInsured", "deductible", "coinsurance", "beneficiaries", "coverageLevel"},
    "F": {"bondType", "bondedAmount"},
    "RF": {"receiptPeriod", "paidAmount"},
}


def comparable(texto: str) -> str:
    sin_acentos = "".join(c for c in unicodedata.normalize("NFKD", texto or "") if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", sin_acentos).strip().lower()


_BASE = {comparable(nombre): (clave, sinonimos, obligatorio) for clave, nombre, sinonimos, obligatorio in FIELD_DEFINITIONS}
_ESPECIFICAS = {clave for claves in SPECIFIC_KEYS_BY_POLICY.values() for clave in claves}


def sinonimos_base(nombre: str) -> list[str]:
    base = _BASE.get(comparable(nombre))
    return list(base[1]) if base else []


def obligatorio_base(nombre: str, codigo_tipo: str | None = None) -> bool:
    """Obligatorio por defecto: el ``required`` del proyecto anterior; un campo específico (placas, monto afianzado…)
    solo lo es en su tipo de póliza (``SPECIFIC_KEYS_BY_POLICY``)."""
    base = _BASE.get(comparable(nombre))
    if base is None or not base[2]:
        return False
    clave = base[0]
    if clave in _ESPECIFICAS:
        return clave in SPECIFIC_KEYS_BY_POLICY.get((codigo_tipo or "").upper(), set())
    return True


def etiquetas(campo: dict[str, Any]) -> list[str]:
    """Nombre del campo + sinónimos configurados (o los de la plantilla si no se configuraron), sin repetidos."""
    propios = [s for s in campo.get("sinonimos") or [] if isinstance(s, str) and s.strip()]
    vistos: list[str] = []
    for texto in [campo.get("nombre") or "", *(propios or sinonimos_base(campo.get("nombre") or ""))]:
        limpio = comparable(texto).rstrip(":").strip()
        if limpio and limpio not in vistos:
            vistos.append(limpio)
    # Las más largas primero: "vigencia desde" antes que "desde".
    return sorted(vistos, key=len, reverse=True)


def es_obligatorio(campo: dict[str, Any], codigo_tipo: str | None = None) -> bool:
    valor = campo.get("obligatorio")
    return bool(valor) if isinstance(valor, bool) else obligatorio_base(campo.get("nombre") or "", codigo_tipo)


def validar_regex(patron: str | None) -> str | None:
    """Regex de un campo: compila, tiene como máximo un grupo y no pasa de ``MAX_REGEX`` caracteres."""
    if patron is None or not patron.strip():
        return None
    patron = patron.strip()
    if len(patron) > MAX_REGEX:
        raise ValueError(f"La regex admite hasta {MAX_REGEX} caracteres.")
    try:
        compilada = re.compile(patron)
    except re.error as error:
        raise ValueError(f"La regex no es valida: {error}") from error
    if compilada.groups > 1:
        raise ValueError("La regex debe tener como maximo un grupo (el valor).")
    return patron


# --- OCR -------------------------------------------------------------------------------------------

RUTAS_TESSERACT_WINDOWS = (r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe")


def ruta_tesseract() -> str | None:
    """Tesseract instalado: ``TESSERACT_CMD``, el PATH o la carpeta de instalación de Windows."""
    configurada = os.getenv("TESSERACT_CMD", "").strip()
    if configurada and Path(configurada).is_file():
        return configurada
    encontrada = shutil.which("tesseract")
    if encontrada:
        return encontrada
    return next((ruta for ruta in RUTAS_TESSERACT_WINDOWS if Path(ruta).is_file()), None)


def ocr_disponible() -> bool:
    """OCR solo si están pytesseract y el programa Tesseract (si no, un escaneado va a la bandeja)."""
    if ruta_tesseract() is None:
        return False
    try:
        import pytesseract  # noqa: F401
    except ImportError:
        return False
    return True


def _ocr_imagen(imagen: Any) -> str:
    import pytesseract

    pytesseract.pytesseract.tesseract_cmd = ruta_tesseract() or "tesseract"
    idioma = os.getenv("NEXORA_OCR_IDIOMA", "spa").strip() or "spa"
    try:
        return pytesseract.image_to_string(imagen, lang=idioma)
    except Exception:
        # Sin el idioma español instalado se lee en inglés (mejor que nada).
        return pytesseract.image_to_string(imagen, lang="eng")


# --- Lectura del documento -------------------------------------------------------------------------

def leer_documento(data: bytes, mime_type: str, *, usar_ocr: bool | None = None) -> dict[str, Any]:
    """Texto por página y tablas (pdfplumber; pypdf de respaldo). Páginas sin texto: OCR si está disponible.

    Devuelve ``{"paginas": [texto], "tablas": [[fila]], "ocr": bool, "paginas_sin_texto": int}``."""
    ocr = ocr_disponible() if usar_ocr is None else usar_ocr
    if not data.startswith(b"%PDF-"):
        # Imagen (PNG/JPG/WebP): solo con OCR.
        if not ocr:
            return {"paginas": [""], "tablas": [], "ocr": False, "paginas_sin_texto": 1}
        from PIL import Image

        return {"paginas": [_ocr_imagen(Image.open(io.BytesIO(data)))], "tablas": [], "ocr": True, "paginas_sin_texto": 0}
    paginas: list[str] = []
    tablas: list[list[list[str]]] = []
    usado_ocr = False
    sin_texto = 0
    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for pagina in pdf.pages:
                texto = pagina.extract_text() or ""
                if not texto.strip():
                    if ocr:
                        # pypdfium2 dibuja la página (sin Poppler); Tesseract la lee.
                        texto = _ocr_imagen(pagina.to_image(resolution=300).original)
                        usado_ocr = True
                    else:
                        sin_texto += 1
                paginas.append(texto)
                for tabla in pagina.extract_tables() or []:
                    tablas.append([[_limpiar(celda) for celda in fila] for fila in tabla if fila])
    except Exception as error:
        logger.info("pdfplumber no pudo leer el PDF (%s); se usa pypdf", error.__class__.__name__)
        try:
            from pypdf import PdfReader

            lector = PdfReader(io.BytesIO(data))
            paginas = [pagina.extract_text() or "" for pagina in lector.pages]
            sin_texto = sum(1 for texto in paginas if not texto.strip())
        except Exception as otro_error:
            # Ilegible: sin texto (el diagnóstico ya lo habría mandado a la bandeja si estuviera dañado).
            logger.info("pypdf tampoco pudo leer el PDF (%s)", otro_error.__class__.__name__)
            paginas, tablas, sin_texto = [""], [], 1
    return {"paginas": paginas, "tablas": tablas, "ocr": usado_ocr, "paginas_sin_texto": sin_texto}


def _limpiar(valor: Any) -> str:
    texto = re.sub(r"\s+", " ", str(valor or "")).strip(" :;|\t\r\n")
    return texto[:MAX_VALOR]


# --- Búsqueda de etiquetas -------------------------------------------------------------------------

def _normalizado(texto: str) -> str:
    """Mismo largo que el original (1 a 1), sin acentos y en minúsculas: las posiciones sirven para los dos."""
    salida = []
    for caracter in texto:
        base = unicodedata.normalize("NFKD", caracter)
        letra = next((c for c in base if not unicodedata.combining(c)), caracter)
        salida.append(letra.lower() if len(letra) == 1 else caracter.lower()[:1] or " ")
    return "".join(salida)


def _patron_etiqueta(etiqueta: str) -> str:
    partes = [re.escape(parte) for parte in etiqueta.split(" ")]
    return r"(?<![a-z0-9])" + r"\s+".join(partes) + r"(?![a-z0-9])"


def _valor_tras_etiqueta(linea_original: str, linea_normal: str, fin: int, otras: list[str]) -> str:
    """Lo que sigue a la etiqueta en la misma línea, hasta la siguiente etiqueta conocida."""
    resto_normal = linea_normal[fin:]
    corte = len(resto_normal)
    for etiqueta in otras:
        coincidencia = re.search(_patron_etiqueta(etiqueta) + r"\s*[:#]", resto_normal)
        if coincidencia and coincidencia.start() > 0:
            corte = min(corte, coincidencia.start())
    valor = linea_original[fin:fin + corte]
    valor = re.sub(r"^\s*(?:no\.?|num\.?|n[uú]m\.?|#)?\s*[:#\-]?\s*", "", valor, flags=re.IGNORECASE)
    return _limpiar(valor)


def buscar_valor(campo: dict[str, Any], paginas: list[str], tablas: list[list[list[str]]], otras_etiquetas: list[str]) -> tuple[str | None, int | None]:
    """(valor, página) de un campo "Una vez": regex propia; si no, etiqueta (o sinónimo) seguida de su valor en el
    texto o en una tabla de dos columnas (etiqueta | valor). Nunca inventa: si no aparece, None."""
    patron = campo.get("regex")
    if patron:
        compilada = re.compile(patron, re.IGNORECASE | re.MULTILINE)
        for numero, texto in enumerate(paginas, start=1):
            encontrado = compilada.search(texto)
            if encontrado:
                valor = _limpiar(encontrado.group(1) if compilada.groups else encontrado.group(0))
                if valor:
                    return valor, numero
        return None, None
    propias = etiquetas(campo)
    ajenas = [etiqueta for etiqueta in otras_etiquetas if etiqueta not in propias]
    # Primero "Etiqueta:" (o "#"), de la etiqueta más larga a la más corta; después la etiqueta sin separador. Así
    # "No. de póliza: X" gana a un título como "PÓLIZA DE AUTOS" que aparece antes.
    for con_separador in (True, False):
        for etiqueta in propias:
            patron = _patron_etiqueta(etiqueta) + (r"\s*(?:no\.?\s*)?[:#]" if con_separador else "")
            for numero, texto in enumerate(paginas, start=1):
                lineas = texto.splitlines()
                for indice, linea in enumerate(lineas):
                    normal = _normalizado(linea)
                    coincidencia = re.search(patron, normal)
                    if not coincidencia:
                        continue
                    valor = _valor_tras_etiqueta(linea, normal, coincidencia.end(), ajenas)
                    if not valor and indice + 1 < len(lineas) and normal.strip().rstrip(":#").strip() == etiqueta:
                        # Etiqueta sola en su línea: el valor va en la siguiente.
                        valor = _limpiar(lineas[indice + 1])
                    if valor:
                        return valor, numero
    for tabla in tablas:
        for fila in tabla:
            for posicion, celda in enumerate(fila[:-1]):
                if comparable(celda).rstrip(":") in propias and _limpiar(fila[posicion + 1]):
                    return _limpiar(fila[posicion + 1]), None
    return None, None


def _huella(*partes: str) -> str:
    texto = "|".join(re.sub(r"\s+", " ", (parte or "").strip().casefold()) for parte in partes)
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()[:16]


def leer_seccion(campos_fila: list[dict[str, Any]], tablas: list[list[list[str]]]) -> list[dict[str, str]]:
    """Sección repetible (Coberturas, Asegurados…): la tabla cuyo encabezado tiene más columnas de los campos por
    fila; sus filas (y las de sus continuaciones con el mismo encabezado en otras páginas) son las filas."""
    if not campos_fila:
        return []
    mejor: tuple[int, int, dict[str, int]] | None = None  # (coincidencias, índice de tabla, campo id → columna)
    for indice, tabla in enumerate(tablas):
        for numero_fila, fila in enumerate(tabla[:3]):
            columnas: dict[str, int] = {}
            for posicion, celda in enumerate(fila):
                texto = comparable(celda).rstrip(":")
                for campo in campos_fila:
                    if campo["id"] not in columnas and texto and texto in etiquetas(campo):
                        columnas[campo["id"]] = posicion
                        break
            if columnas and (mejor is None or len(columnas) > mejor[0]):
                mejor = (len(columnas), indice, {**columnas, "__fila__": numero_fila})
    # Con dos o más campos por fila hacen falta al menos dos columnas reconocidas (una sola puede ser casualidad).
    if mejor is None or (len(campos_fila) >= 2 and mejor[0] < 2):
        return []
    columnas = mejor[2]
    encabezado_fila = columnas.pop("__fila__")
    encabezado = [comparable(c) for c in tablas[mejor[1]][encabezado_fila]]
    filas: list[dict[str, str]] = []
    for indice, tabla in enumerate(tablas):
        if indice != mejor[1] and not (tabla and [comparable(c) for c in tabla[0]] == encabezado):
            continue
        inicio = encabezado_fila + 1 if indice == mejor[1] else 1
        for fila in tabla[inicio:]:
            valores = {campo_id: _limpiar(fila[columna]) if columna < len(fila) else "" for campo_id, columna in columnas.items()}
            if any(valores.values()):
                filas.append(valores)
    return filas


# --- Estado de cuenta (validación contable): resumen y movimientos ---------------------------------

RESUMEN_EC: dict[str, tuple[str, ...]] = {
    "banco": ("banco", "institucion"),
    "titular": ("titular", "cliente", "nombre del cliente"),
    "cuenta": ("numero de cuenta", "no. de cuenta", "cuenta", "clabe"),
    "periodo": ("periodo", "periodo del", "fecha de corte"),
    "moneda": ("moneda", "divisa"),
    "saldo_inicial": ("saldo inicial", "saldo anterior", "saldo al inicio"),
    "total_cargos": ("total de cargos", "total cargos", "retiros", "total retiros"),
    "total_abonos": ("total de abonos", "total abonos", "depositos", "total depositos"),
    "saldo_final": ("saldo final", "saldo actual", "saldo al corte"),
}
COLUMNAS_EC: dict[str, tuple[str, ...]] = {
    "fecha": ("fecha", "fecha oper", "fecha de operacion", "dia"),
    "concepto": ("concepto", "descripcion", "detalle", "movimiento"),
    "referencia": ("referencia", "folio", "ref"),
    "cargo": ("cargo", "cargos", "retiro", "retiros", "debito", "debitos"),
    "abono": ("abono", "abonos", "deposito", "depositos", "credito", "creditos"),
    "saldo": ("saldo",),
}


def _resumen_ec(paginas: list[str], tablas: list[list[list[str]]]) -> dict[str, str]:
    nombres = [etiqueta for sinonimos in RESUMEN_EC.values() for etiqueta in sinonimos]
    resumen: dict[str, str] = {}
    for clave, sinonimos in RESUMEN_EC.items():
        valor, _ = buscar_valor({"nombre": clave, "sinonimos": list(sinonimos)}, paginas, tablas, nombres)
        resumen[clave] = valor or ""
    return resumen


def _movimientos_ec(tablas: list[list[list[str]]]) -> list[dict[str, Any]]:
    campos = [{"id": clave, "nombre": clave, "sinonimos": list(sinonimos)} for clave, sinonimos in COLUMNAS_EC.items()]
    filas = leer_seccion(campos, tablas)
    movimientos = []
    for fila in filas:
        movimiento = {clave: fila.get(clave, "") for clave in COLUMNAS_EC}
        if not (movimiento["fecha"] or movimiento["concepto"]) or not any(movimiento[c] for c in ("cargo", "abono", "saldo")):
            continue
        movimiento.update(huella=_huella(movimiento["fecha"], movimiento["concepto"], movimiento["referencia"], movimiento["cargo"], movimiento["abono"]), dudosos=[])
        movimientos.append(movimiento)
    return movimientos


# --- Extracción completa ---------------------------------------------------------------------------

def detectar_aseguradora(texto: str, aseguradoras: Iterable[str]) -> str:
    normal = comparable(texto)
    mejor = ""
    for nombre in aseguradoras:
        clave = comparable(nombre)
        if clave and re.search(rf"(?<![a-z0-9]){re.escape(clave)}(?![a-z0-9])", normal) and len(clave) > len(comparable(mejor)):
            mejor = nombre
    return mejor


def extraer_por_reglas(data: bytes, mime_type: str, filename: str, campos: list[dict[str, Any]], *, seccion: str | None, contable: bool,
                       codigo_tipo: str | None = None, aseguradoras: Iterable[str] = (), lectura: dict[str, Any] | None = None) -> dict[str, Any]:
    """Extrae con las reglas de los campos configurados. Nunca llama a Gemini."""
    lectura = lectura or leer_documento(data, mime_type)
    paginas, tablas = lectura["paginas"], lectura["tablas"]
    una_vez = [campo for campo in campos if campo.get("alcance") == "documento"]
    por_fila = [campo for campo in campos if campo.get("alcance") != "documento"]
    todas = [etiqueta for campo in campos for etiqueta in etiquetas(campo)]
    if contable:
        todas += [etiqueta for sinonimos in RESUMEN_EC.values() for etiqueta in sinonimos]

    resultados: list[dict[str, Any]] = []
    for campo in una_vez:
        valor, pagina = buscar_valor(campo, paginas, tablas, todas)
        resultado: dict[str, Any] = {"nombre": campo["nombre"], "clave": campo.get("id"), "encontrado": bool(valor), "valores": [], "pagina": pagina}
        if valor:
            resultado["valor_documento"] = valor
        resultados.append(resultado)

    transacciones: list[dict[str, Any]] = []
    if contable:
        transacciones = _movimientos_ec(tablas)
    valores_por_campo: dict[str, list[dict[str, str]]] = {campo["id"]: [] for campo in por_fila}
    if por_fila and (seccion or contable):
        filas = leer_seccion(por_fila, tablas)
        if contable:
            # Columnas adicionales del estado de cuenta: por posición de fila (misma tabla de movimientos).
            for movimiento, fila in zip(transacciones, filas):
                for campo in por_fila:
                    if fila.get(campo["id"]):
                        valores_por_campo[campo["id"]].append({"huella": movimiento["huella"], "valor": fila[campo["id"]]})
        else:
            for numero, fila in enumerate(filas, start=1):
                huella = _huella("", f"fila {numero}", "", "", "")
                transacciones.append({"fecha": "", "concepto": "", "referencia": "", "cargo": "", "abono": "", "saldo": "", "dudosos": [], "huella": huella})
                for campo in por_fila:
                    if fila.get(campo["id"]):
                        valores_por_campo[campo["id"]].append({"huella": huella, "valor": fila[campo["id"]]})
    for campo in por_fila:
        valores = valores_por_campo.get(campo["id"]) or []
        resultados.append({"nombre": campo["nombre"], "clave": campo.get("id"), "encontrado": bool(valores), "valores": valores})

    encontrados = sum(1 for resultado in resultados if resultado["encontrado"])
    por_nombre = {resultado["nombre"]: resultado for resultado in resultados}
    faltantes = [campo["nombre"] for campo in campos if es_obligatorio(campo, codigo_tipo) and not por_nombre.get(campo["nombre"], {}).get("encontrado")]
    avisos = []
    if lectura.get("paginas_sin_texto"):
        avisos.append(f"{lectura['paginas_sin_texto']} pagina(s) sin texto: no se pudieron leer sin OCR.")
    resumen: dict[str, Any] = {"banco": "", "titular": "", "cuenta": "", "periodo": "", "moneda": "", "saldo_inicial": "", "total_cargos": "",
                               "total_abonos": "", "saldo_final": "", "dudosos": []}
    if contable:
        resumen.update(_resumen_ec(paginas, tablas))
    return {
        "filename": filename,
        "model": MODELO_REGLAS,
        "metodo": "reglas",
        "prompt_version": None,
        "formato_numerico": None,
        "resumen": resumen,
        "transacciones": transacciones,
        "validacion": {"cuadra": None, "aplica": contable, "comprobaciones": [], "importes_invalidos": []},
        "aseguradora": detectar_aseguradora("\n".join(paginas), aseguradoras),
        "seccion": seccion or None,
        "tabla_sin_seccion": None,
        "sugerencias_campos": [],
        "resultados_campos": resultados,
        "warnings": avisos,
        "encontrados": encontrados,
        "total_campos": len(resultados),
        "faltantes": faltantes,
        "ocr": bool(lectura.get("ocr")),
    }


def texto_de(lectura: dict[str, Any]) -> str:
    return "\n".join(lectura.get("paginas") or [])
