"""
Detectors: regex candidates + validation + masking.

Three layers, and all three matter:

  1. regex        cheap candidate extraction
  2. validator    checksum / structure — throws away most coincidences
  3. context      nearby keywords — throws away the rest

Layer 3 is not optional. A Verhoeff check digit only removes 9 in 10
candidates, so ~8% of *random* 12-digit numbers pass as valid Aadhaar (see
tests/test_detectors.py, which asserts this floor). On a mailbox full of
invoice numbers and order ids that is unusable on its own. Requiring a nearby
keyword is what turns it into a signal.

Findings never carry the raw value. Every finding stores a masked form only —
if your DLP logs contain the card numbers you detected, your log store is now
the breach.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Iterable, Iterator, Pattern

from . import checksums as ck

# ---------------------------------------------------------------------------
# masking
# ---------------------------------------------------------------------------


def mask_keep_last(value: str, keep: int = 4, char: str = "*") -> str:
    """`4111111111111111` -> `************1111`

    Note the `keep > 0` guard: `value[-0:]` is the whole string in Python, so
    a keep of 0 without it would return the value unmasked — a masking bug is
    a data leak, not a formatting nit.
    """
    if keep <= 0:
        return char * len(value)
    if len(value) <= keep:
        return char * len(value)
    return char * (len(value) - keep) + value[-keep:]


def mask_keep_edges(value: str, head: int = 2, tail: int = 2, char: str = "*") -> str:
    """`AAPFU0939F` -> `AA******3F`  (enough to recognise, not to reuse)"""
    head = max(head, 0)
    tail = max(tail, 0)
    if len(value) <= head + tail:
        return char * len(value)
    tail_part = value[-tail:] if tail else ""
    head_part = value[:head] if head else ""
    return head_part + char * (len(value) - head - tail) + tail_part


def mask_all(value: str, char: str = "*") -> str:
    return char * len(value)


def mask_email(value: str) -> str:
    local, _, domain = value.partition("@")
    return f"{local[:1]}{'*' * max(len(local) - 1, 1)}@{domain}"


# ---------------------------------------------------------------------------
# findings
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Finding:
    """One validated match. Deliberately holds no raw sensitive value."""

    detector: str
    label: str
    masked: str
    offset: int
    length: int
    where: str = "body"          # body | subject | attachment:<name> | header:<name>
    detail: str | None = None    # e.g. card brand, PAN holder type
    context_ok: bool = True      # did a supporting keyword appear nearby?

    def as_dict(self) -> dict:
        return {
            "detector": self.detector,
            "label": self.label,
            "masked": self.masked,
            "offset": self.offset,
            "length": self.length,
            "where": self.where,
            "detail": self.detail,
            "context_ok": self.context_ok,
        }


# ---------------------------------------------------------------------------
# detector definition
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Detector:
    id: str
    label: str
    pattern: Pattern[str]
    weight: float
    #: strip separators before validating (e.g. "4111 1111" -> "41111111")
    normalise: Callable[[str], str] = lambda s: s
    #: return True if the normalised candidate is plausibly real
    validator: Callable[[str], bool] = lambda s: True
    #: how the value appears in reports and logs
    mask: Callable[[str], str] = mask_keep_last
    #: extra human-readable detail (brand, holder type…)
    describe: Callable[[str], str | None] = lambda s: None
    #: keywords that must appear near the match for it to count
    context_keywords: tuple[str, ...] = ()
    #: how far either side of the match to look for those keywords
    context_window: int = 120
    #: if True, a match with no nearby keyword is dropped entirely rather
    #: than merely scored lower. Use for high-false-positive patterns.
    context_required: bool = False

    def scan(
        self,
        text: str,
        where: str = "body",
        part_context: str | None = None,
    ) -> Iterator[Finding]:
        """Find validated matches in `text`.

        `part_context` is text whose keywords apply to the *whole* part rather
        than to a nearby window — a spreadsheet's header row, typically. In a
        CSV of 5,000 rows the word "aadhaar" appears once, in the column
        header, hundreds of kilobytes away from most of the values it labels.
        Without part-level context a context-required detector finds only the
        first few rows of the very export it exists to catch.
        """
        lowered = text.lower() if self.context_keywords else ""
        part_hit = False
        if self.context_keywords and part_context:
            lowered_part = part_context.lower()
            part_hit = any(k in lowered_part for k in self.context_keywords)

        for m in self.pattern.finditer(text):
            raw = m.group(0)
            candidate = self.normalise(raw)
            if not self.validator(candidate):
                continue
            context_ok = True
            if self.context_keywords:
                start = max(0, m.start() - self.context_window)
                end = min(len(text), m.end() + self.context_window)
                window = lowered[start:end]
                context_ok = part_hit or any(k in window for k in self.context_keywords)
                if not context_ok and self.context_required:
                    continue
            yield Finding(
                detector=self.id,
                label=self.label,
                masked=self.mask(candidate),
                offset=m.start(),
                length=len(raw),
                where=where,
                detail=self.describe(candidate),
                context_ok=context_ok,
            )


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

_only_digits = re.compile(r"\D")
_only_alnum = re.compile(r"[^0-9A-Za-z]")


def digits_only(s: str) -> str:
    return _only_digits.sub("", s)


def alnum_upper(s: str) -> str:
    return _only_alnum.sub("", s).upper()


# ---------------------------------------------------------------------------
# the detectors
# ---------------------------------------------------------------------------

# Payment cards. Separators allowed because that's how humans paste them.
# Luhn plus a recognised issuer prefix; without the brand check, 10% of random
# 16-digit strings would pass.
CARD = Detector(
    id="payment_card",
    label="Payment card number",
    pattern=re.compile(r"(?<![0-9])(?:\d[ -]?){12,18}\d(?![0-9])"),
    weight=9.0,
    normalise=digits_only,
    validator=lambda s: ck.luhn_valid(s) and ck.card_brand(s) is not None,
    mask=lambda s: mask_keep_last(s, 4),
    describe=ck.card_brand,
    context_keywords=(
        "card", "credit", "debit", "visa", "master", "amex", "rupay", "maestro",
        "cvv", "cvc", "expiry", "exp date", "valid thru", "pan", "cardholder",
        "payment", "txn", "transaction",
    ),
)

# CVV only means something next to a card number; on its own "123" is noise.
# Scored low and used as a proximity booster by the engine.
CVV = Detector(
    id="card_cvv",
    label="Card CVV",
    pattern=re.compile(
        r"(?i)\b(?:cvv|cvc|cvv2|csc|security\s+code)\b\s*[:=#-]?\s*(\d{3,4})\b"
    ),
    weight=3.0,
    normalise=digits_only,
    mask=mask_all,
)

CARD_EXPIRY = Detector(
    id="card_expiry",
    label="Card expiry date",
    pattern=re.compile(
        r"(?i)\b(?:exp(?:iry|ires|\.)?|valid\s+thru|valid\s+till)\b\s*[:=]?\s*"
        r"(0[1-9]|1[0-2])\s*[/\-]\s*(\d{2}|\d{4})\b"
    ),
    weight=2.0,
    mask=lambda s: "expiry **/**",
)

# Aadhaar. context_required=True on purpose: the checksum alone leaves an ~8%
# false-positive rate on random 12-digit numbers, which would bury the
# customer in alerts about invoice numbers.
AADHAAR = Detector(
    id="aadhaar",
    label="Aadhaar number",
    pattern=re.compile(r"(?<![0-9])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![0-9])"),
    weight=9.0,
    normalise=digits_only,
    validator=ck.aadhaar_valid,
    mask=lambda s: mask_keep_last(s, 4),
    context_keywords=(
        "aadhaar", "aadhar", "adhaar", "आधार", "uid", "uidai", "ekyc", "e-kyc",
        "kyc", "identity", "id proof", "biometric", "vid",
    ),
    context_required=True,
)

PAN_INDIA = Detector(
    id="pan_india",
    label="Indian PAN (tax ID)",
    pattern=re.compile(r"(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])"),
    weight=7.0,
    validator=ck.pan_valid,
    mask=lambda s: mask_keep_edges(s, 2, 2),
    describe=ck.pan_holder_type,
)

GSTIN = Detector(
    id="gstin",
    label="GSTIN",
    pattern=re.compile(r"(?<![A-Z0-9])\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}(?![A-Z0-9])"),
    weight=5.0,
    validator=ck.gstin_valid,
    mask=lambda s: mask_keep_edges(s, 4, 2),
)

IFSC = Detector(
    id="ifsc",
    label="IFSC code",
    pattern=re.compile(r"(?<![A-Z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Z0-9])"),
    weight=3.0,
    validator=ck.ifsc_valid,
    mask=lambda s: mask_keep_edges(s, 4, 0),
)

# Bank account numbers have no checksum and no fixed length, so this is
# purely contextual: the keyword IS the detection.
BANK_ACCOUNT = Detector(
    id="bank_account",
    label="Bank account number",
    pattern=re.compile(
        r"(?i)\b(?:a/?c|acc(?:ount)?|khata)\.?\s*(?:no\.?|number|#)?\s*[:=]?\s*"
        r"(\d[\d -]{7,20}\d)\b"
    ),
    weight=6.0,
    normalise=digits_only,
    validator=lambda s: 9 <= len(s) <= 18,
    mask=lambda s: mask_keep_last(s, 4),
)

IBAN = Detector(
    id="iban",
    label="IBAN",
    pattern=re.compile(r"(?<![A-Z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Z0-9])"),
    weight=5.0,
    normalise=alnum_upper,
    validator=ck.iban_valid,
    mask=lambda s: mask_keep_edges(s, 4, 2),
)

UPI_ID = Detector(
    id="upi_id",
    label="UPI ID",
    pattern=re.compile(
        r"(?<![\w.])[\w.\-]{3,}@(?:okhdfcbank|okicici|oksbi|okaxis|ybl|paytm|"
        r"apl|axl|ibl|upi|pthdfc|jupiteraxis|fam|naviaxis|axisb)(?![\w.])"
    ),
    weight=2.0,
    mask=mask_email,
)

# Credentials and keys. These are unambiguous, so no context needed and the
# weight is high — a leaked private key is worse than a leaked PAN.
PRIVATE_KEY = Detector(
    id="private_key",
    label="Private key material",
    pattern=re.compile(
        r"-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED)?\s*PRIVATE KEY(?:\s+BLOCK)?-----"
    ),
    weight=12.0,
    mask=lambda s: "-----BEGIN … PRIVATE KEY-----",
)

AWS_KEY = Detector(
    id="aws_access_key",
    label="AWS access key id",
    pattern=re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Z0-9])"),
    weight=10.0,
    mask=lambda s: s[:4] + mask_keep_last(s[4:], 4),
)

GENERIC_SECRET = Detector(
    id="generic_secret",
    label="Credential in plain text",
    pattern=re.compile(
        r"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|"
        r"client[_-]?secret|private[_-]?key)\b\s*[:=]\s*\S{8,}"
    ),
    weight=6.0,
    mask=lambda s: s.split(":")[0].split("=")[0].strip() + "=********",
)

# Classification markings the customer's own policy puts on documents.
CONFIDENTIAL_MARKING = Detector(
    id="confidential_marking",
    label="Confidentiality marking",
    pattern=re.compile(
        r"(?i)\b(?:strictly\s+confidential|confidential\s*[-–—]\s*internal|"
        r"internal\s+use\s+only|do\s+not\s+distribute|restricted\s*[-–—]\s*"
        r"do\s+not\s+forward|company\s+confidential)\b"
    ),
    weight=4.0,
    mask=lambda s: s,
)

#: Registry. The policy file selects from these by id.
ALL_DETECTORS: tuple[Detector, ...] = (
    CARD,
    CVV,
    CARD_EXPIRY,
    AADHAAR,
    PAN_INDIA,
    GSTIN,
    IFSC,
    BANK_ACCOUNT,
    IBAN,
    UPI_ID,
    PRIVATE_KEY,
    AWS_KEY,
    GENERIC_SECRET,
    CONFIDENTIAL_MARKING,
)

BY_ID: dict[str, Detector] = {d.id: d for d in ALL_DETECTORS}


#: How much of an attachment counts as its "header" for part-level context.
#: A CSV/XLSX column header sits in the first line or two; this is generous
#: enough to cover a title row plus a header row.
PART_CONTEXT_BYTES = 2000


def part_context_for(text: str, where: str) -> str | None:
    """Part-level context text, or None if the part shouldn't get any.

    Only attachments qualify. Body prose has real local context around each
    value, so widening it there would turn one mention of "card" into a
    licence to flag every number in a long email.
    """
    if not where.startswith("attachment:"):
        return None
    return text[:PART_CONTEXT_BYTES]


def scan_text(
    text: str,
    where: str = "body",
    detectors: Iterable[Detector] | None = None,
    part_context: str | None = None,
) -> list[Finding]:
    """Run detectors over one piece of text."""
    if part_context is None:
        part_context = part_context_for(text, where)
    out: list[Finding] = []
    for det in detectors if detectors is not None else ALL_DETECTORS:
        out.extend(det.scan(text, where=where, part_context=part_context))
    return out
