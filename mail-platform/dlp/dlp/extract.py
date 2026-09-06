"""
Turn a raw RFC 5322 message into scannable text.

The leak that matters is almost never in the body — it's the attached
spreadsheet. So this module walks the MIME tree, decodes what it can, and
extracts text from the document types people actually attach.

Two hostile cases are handled deliberately:

* **Archive bombs.** A 200 KB zip can expand to gigabytes. Every extraction
  is bounded by declared size, extracted size, member count and nesting depth.

* **Encrypted attachments.** A password-protected zip cannot be inspected, and
  "send the data in an encrypted archive, password over WhatsApp" is a
  standard exfiltration route. That is reported as its own finding rather than
  silently passing.

Text extraction for PDF/DOCX/XLSX uses optional libraries. If they are not
installed the part is reported as `unscannable` instead of being skipped —
the policy decides whether unscannable content is acceptable, not this module.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
from dataclasses import dataclass, field
from email import message_from_bytes, policy as email_policy
from email.message import EmailMessage
from typing import Iterator

# --- limits (bytes / counts) ------------------------------------------------
MAX_PART_BYTES = 25 * 1024 * 1024
MAX_EXTRACTED_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 200
MAX_ARCHIVE_DEPTH = 2
MAX_ARCHIVE_RATIO = 200          # expanded / compressed

_TEXT_SUBTYPES = {"plain", "html", "csv", "xml", "json", "rfc822-headers"}
_TAG_RE = re.compile(r"<[^>]{1,2000}>")
_WS_RE = re.compile(r"[ \t\x0b\f\r]{2,}")


@dataclass
class Part:
    """One scannable piece of the message."""

    name: str                     # "body", "subject", "attachment:list.xlsx"
    text: str
    content_type: str = "text/plain"
    unscannable: bool = False
    reason: str = ""


@dataclass
class ExtractResult:
    parts: list[Part] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def unscannable(self) -> list[Part]:
        return [p for p in self.parts if p.unscannable]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def html_to_text(html: str) -> str:
    """Crude but adequate: strip tags, unescape entities, collapse runs."""
    import html as html_mod

    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", html)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", text)
    text = re.sub(r"(?i)</td>", "\t", text)
    text = _TAG_RE.sub(" ", text)
    text = html_mod.unescape(text)
    return _WS_RE.sub(" ", text)


def _decode(part: EmailMessage) -> bytes | None:
    try:
        payload = part.get_payload(decode=True)
    except Exception:
        return None
    if payload is None:
        return None
    return payload[:MAX_PART_BYTES]


def _as_text(data: bytes, charset: str | None) -> str:
    for enc in (charset, "utf-8", "cp1252", "latin-1"):
        if not enc:
            continue
        try:
            return data.decode(enc, errors="strict")
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# document extractors (optional dependencies)
# ---------------------------------------------------------------------------


def _extract_pdf(data: bytes) -> tuple[str, str]:
    try:
        import pdfplumber  # type: ignore
    except ImportError:
        return "", "pdfplumber not installed"
    try:
        out: list[str] = []
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page in pdf.pages:
                out.append(page.extract_text() or "")
                if sum(map(len, out)) > MAX_EXTRACTED_BYTES:
                    break
        return "\n".join(out), ""
    except Exception as exc:                       # encrypted, malformed…
        return "", f"pdf extraction failed: {type(exc).__name__}"


def _extract_docx(data: bytes) -> tuple[str, str]:
    try:
        import docx  # type: ignore
    except ImportError:
        return "", "python-docx not installed"
    try:
        document = docx.Document(io.BytesIO(data))
        chunks = [p.text for p in document.paragraphs]
        for table in document.tables:
            for row in table.rows:
                chunks.append("\t".join(c.text for c in row.cells))
        return "\n".join(chunks), ""
    except Exception as exc:
        return "", f"docx extraction failed: {type(exc).__name__}"


def _extract_xlsx(data: bytes) -> tuple[str, str]:
    try:
        import openpyxl  # type: ignore
    except ImportError:
        return "", "openpyxl not installed"
    try:
        wb = openpyxl.load_workbook(
            io.BytesIO(data), read_only=True, data_only=True, keep_links=False
        )
        out: list[str] = []
        size = 0
        for sheet in wb.worksheets:
            for row in sheet.iter_rows(values_only=True):
                line = "\t".join("" if v is None else str(v) for v in row)
                out.append(line)
                size += len(line)
                if size > MAX_EXTRACTED_BYTES:
                    out.append("[truncated]")
                    wb.close()
                    return "\n".join(out), ""
        wb.close()
        return "\n".join(out), ""
    except Exception as exc:
        return "", f"xlsx extraction failed: {type(exc).__name__}"


def _extract_csv(data: bytes, charset: str | None) -> tuple[str, str]:
    text = _as_text(data, charset)
    try:
        rows = list(csv.reader(io.StringIO(text)))
        return "\n".join("\t".join(r) for r in rows), ""
    except Exception:
        return text, ""


def _extract_zip(data: bytes, depth: int) -> tuple[str, str]:
    if depth > MAX_ARCHIVE_DEPTH:
        return "", "archive nested too deeply"
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except Exception as exc:
        return "", f"unreadable archive: {type(exc).__name__}"

    if any(info.flag_bits & 0x1 for info in zf.infolist()):
        return "", "password-protected archive — contents cannot be inspected"

    infos = zf.infolist()
    if len(infos) > MAX_ARCHIVE_MEMBERS:
        return "", f"archive has {len(infos)} members (limit {MAX_ARCHIVE_MEMBERS})"

    declared = sum(i.file_size for i in infos)
    compressed = max(sum(i.compress_size for i in infos), 1)
    if declared > MAX_EXTRACTED_BYTES or declared / compressed > MAX_ARCHIVE_RATIO:
        return "", (
            f"archive expands {declared / compressed:.0f}× to {declared} bytes "
            "— refusing to extract (possible archive bomb)"
        )

    chunks: list[str] = []
    total = 0
    for info in infos:
        if info.is_dir():
            continue
        try:
            member = zf.read(info)[:MAX_PART_BYTES]
        except Exception:
            continue
        text, _ = _extract_by_name(info.filename, member, None, depth + 1)
        if text:
            chunks.append(f"--- {info.filename} ---\n{text}")
            total += len(text)
            if total > MAX_EXTRACTED_BYTES:
                chunks.append("[truncated]")
                break
    return "\n".join(chunks), ""


def _extract_by_name(
    filename: str, data: bytes, charset: str | None, depth: int = 0
) -> tuple[str, str]:
    """Dispatch on file extension. Returns (text, unscannable_reason)."""
    lower = (filename or "").lower()
    if lower.endswith(".pdf"):
        return _extract_pdf(data)
    if lower.endswith((".docx", ".dotx")):
        return _extract_docx(data)
    if lower.endswith((".xlsx", ".xlsm", ".xltx")):
        return _extract_xlsx(data)
    if lower.endswith((".csv", ".tsv")):
        return _extract_csv(data, charset)
    if lower.endswith((".zip", ".xlsx.zip")):
        return _extract_zip(data, depth)
    if lower.endswith((".txt", ".log", ".json", ".xml", ".md", ".sql", ".yml",
                       ".yaml", ".ini", ".conf", ".env", ".pem", ".key", ".html")):
        return _as_text(data, charset), ""
    if lower.endswith((".doc", ".xls", ".ppt", ".rar", ".7z")):
        return "", f"legacy/unsupported format ({lower.rsplit('.', 1)[-1]})"
    # Unknown binary: sniff for text anyway — exfil often uses odd extensions.
    sample = data[:65536]
    printable = sum(32 <= b < 127 or b in (9, 10, 13) for b in sample)
    if sample and printable / len(sample) > 0.85:
        return _as_text(data, charset), ""
    return "", "binary content, not text-extractable"


# ---------------------------------------------------------------------------
# public entry point
# ---------------------------------------------------------------------------


def extract(raw: bytes) -> ExtractResult:
    """Parse a raw message and return every scannable part."""
    result = ExtractResult()
    try:
        msg: EmailMessage = message_from_bytes(raw, policy=email_policy.default)  # type: ignore[assignment]
    except Exception as exc:
        result.notes.append(f"could not parse message: {type(exc).__name__}")
        # Scan the raw bytes rather than giving up entirely.
        result.parts.append(
            Part("raw", _as_text(raw, None), "application/octet-stream")
        )
        return result

    subject = str(msg.get("Subject", "") or "")
    if subject:
        result.parts.append(Part("subject", subject, "text/plain"))

    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue

        filename = part.get_filename() or ""
        ctype = part.get_content_type()
        subtype = part.get_content_subtype()
        data = _decode(part)  # type: ignore[arg-type]
        if data is None:
            result.parts.append(
                Part(filename or "part", "", ctype, True, "could not decode part")
            )
            continue

        # inline body text
        if not filename and part.get_content_maintype() == "text" and subtype in _TEXT_SUBTYPES:
            text = _as_text(data, part.get_content_charset())
            if subtype == "html":
                text = html_to_text(text)
            result.parts.append(Part("body", text, ctype))
            continue

        name = f"attachment:{filename or 'unnamed'}"
        text, reason = _extract_by_name(filename, data, part.get_content_charset())
        if reason:
            result.parts.append(Part(name, text, ctype, True, reason))
        else:
            result.parts.append(Part(name, text, ctype))

    if not result.parts:
        result.notes.append("no scannable parts found")
    return result


def iter_scannable(result: ExtractResult, limit: int) -> Iterator[Part]:
    """Yield parts with text, each truncated to `limit` bytes."""
    for part in result.parts:
        if not part.text:
            continue
        yield Part(
            part.name,
            part.text[:limit],
            part.content_type,
            part.unscannable,
            part.reason,
        )
