"""
Checksum validators for Indian and international identifiers.

This module is the difference between a usable DLP product and one the
customer switches off in week two. A regex for "12 digits" matches every
invoice number, order id and phone-with-country-code in the company's mail.
The checksum is what makes a hit mean something.

Every function here takes an already-normalised string (digits/uppercase, no
separators) and answers one question: could this actually be a real
identifier of this type?
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Luhn — payment card numbers (PCI DSS "PAN")
# ---------------------------------------------------------------------------


def luhn_valid(digits: str) -> bool:
    """Luhn (mod 10) check, used by every major card scheme.

    >>> luhn_valid("4111111111111111")   # classic Visa test number
    True
    >>> luhn_valid("4111111111111112")
    False
    """
    if not digits.isdigit() or not 12 <= len(digits) <= 19:
        return False
    total = 0
    # walk right-to-left, doubling every second digit
    for i, ch in enumerate(reversed(digits)):
        d = ord(ch) - 48
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


# Issuer ranges, coarse on purpose: enough to name the brand in a report,
# not a full BIN database.
_CARD_BRANDS: tuple[tuple[str, tuple[int, ...], tuple[str, ...]], ...] = (
    ("Visa", (13, 16, 19), ("4",)),
    ("Mastercard", (16,), tuple(str(p) for p in range(51, 56))),
    ("Amex", (15,), ("34", "37")),
    ("Discover", (16, 19), ("6011", "65")),
    ("JCB", (16, 17, 18, 19), ("35",)),
    ("Diners", (14, 16, 19), ("300", "301", "302", "303", "304", "305", "36", "38")),
    ("RuPay", (16,), ("60", "6521", "6522", "81", "82", "508")),
    ("Maestro", (12, 13, 14, 15, 16, 17, 18, 19), ("5018", "5020", "5038", "6304", "6759")),
)


def card_brand(digits: str) -> str | None:
    """Best-effort card brand from the issuer prefix, or None."""
    for name, lengths, prefixes in _CARD_BRANDS:
        if len(digits) in lengths and digits.startswith(prefixes):
            return name
    return None


# ---------------------------------------------------------------------------
# Verhoeff — Aadhaar
# ---------------------------------------------------------------------------

# Dihedral group D5 multiplication table
_VERHOEFF_D = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
    (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8),
    (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2),
    (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
    (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)

# Permutation table, applied cyclically by position
_VERHOEFF_P = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
    (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0),
    (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5),
    (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)

_VERHOEFF_INV = (0, 4, 3, 2, 1, 5, 6, 7, 8, 9)


def verhoeff_valid(digits: str) -> bool:
    """Verhoeff check digit validation (the last digit is the check digit)."""
    if not digits.isdigit() or not digits:
        return False
    c = 0
    for i, ch in enumerate(reversed(digits)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[i % 8][ord(ch) - 48]]
    return c == 0


def verhoeff_checksum(payload: str) -> int:
    """Check digit that would make `payload` a valid Verhoeff number."""
    c = 0
    for i, ch in enumerate(reversed(payload)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[(i + 1) % 8][ord(ch) - 48]]
    return _VERHOEFF_INV[c]


def aadhaar_valid(digits: str) -> bool:
    """Aadhaar: 12 digits, Verhoeff check digit, and never starts with 0 or 1.

    UIDAI excludes leading 0 and 1 so that Aadhaar numbers can't collide with
    older numbering schemes. That single rule removes a large slice of false
    positives from invoice and reference numbers.
    """
    return (
        len(digits) == 12
        and digits.isdigit()
        and digits[0] not in "01"
        and verhoeff_valid(digits)
    )


# ---------------------------------------------------------------------------
# Indian income-tax PAN
# ---------------------------------------------------------------------------

# 4th character encodes the holder type. Anything outside this set is not a
# real PAN, which kills most 5-letter/4-digit/1-letter coincidences.
PAN_HOLDER_TYPES = "ABCFGHJLPTKE"

_PAN_HOLDER_LABELS = {
    "P": "Individual",
    "C": "Company",
    "H": "HUF",
    "F": "Firm/LLP",
    "A": "Association of Persons",
    "T": "Trust",
    "B": "Body of Individuals",
    "L": "Local Authority",
    "J": "Artificial Juridical Person",
    "G": "Government",
    "K": "Krish (trust under old series)",
    "E": "LLP (newer series)",
}


def pan_valid(value: str) -> bool:
    """Income-tax PAN: AAAAA9999A with a valid holder-type character.

    There is no published check digit, so structure is all we have.
    """
    if len(value) != 10:
        return False
    head, digits, tail = value[:5], value[5:9], value[9]
    return (
        head.isalpha()
        and head.isupper()
        and digits.isdigit()
        and tail.isalpha()
        and tail.isupper()
        and head[3] in PAN_HOLDER_TYPES
    )


def pan_holder_type(value: str) -> str | None:
    return _PAN_HOLDER_LABELS.get(value[3]) if pan_valid(value) else None


# ---------------------------------------------------------------------------
# GSTIN
# ---------------------------------------------------------------------------

_GST_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# State codes in use; 97 is "other territory", 99 is centre jurisdiction.
_GST_STATE_CODES = {f"{n:02d}" for n in range(1, 39)} | {"97", "99"}


def gstin_valid(value: str) -> bool:
    """GSTIN: 15 chars, embedded PAN, and a mod-36 check character."""
    if len(value) != 15 or not value.isalnum() or value != value.upper():
        return False
    if value[:2] not in _GST_STATE_CODES:
        return False
    if not pan_valid(value[2:12]):
        return False
    return value[14] == gstin_check_char(value[:14])


def gstin_check_char(payload14: str) -> str:
    """The 15th character of a GSTIN, computed from the first 14."""
    total = 0
    for i, ch in enumerate(payload14):
        value = _GST_CHARSET.index(ch)
        factor = 2 if i % 2 else 1
        product = value * factor
        total += product // 36 + product % 36
    return _GST_CHARSET[(36 - total % 36) % 36]


# ---------------------------------------------------------------------------
# IFSC
# ---------------------------------------------------------------------------


def ifsc_valid(value: str) -> bool:
    """IFSC: 4 letters (bank), '0', then 6 alphanumerics (branch)."""
    return (
        len(value) == 11
        and value[:4].isalpha()
        and value[:4].isupper()
        and value[4] == "0"
        and value[5:].isalnum()
        and value[5:] == value[5:].upper()
    )


# ---------------------------------------------------------------------------
# IBAN (for customers with overseas counterparties)
# ---------------------------------------------------------------------------

_IBAN_LENGTHS = {
    "AE": 23, "AT": 20, "AU": 0, "BE": 16, "CH": 21, "DE": 22, "DK": 18,
    "ES": 24, "FI": 18, "FR": 27, "GB": 22, "IE": 22, "IL": 23, "IT": 27,
    "NL": 18, "NO": 15, "PL": 28, "PT": 25, "SA": 24, "SE": 24, "SG": 0,
    "TR": 26, "US": 0,
}


def iban_valid(value: str) -> bool:
    """IBAN mod-97 check (ISO 13616)."""
    value = value.replace(" ", "").upper()
    if len(value) < 15 or not value[:2].isalpha() or not value[2:4].isdigit():
        return False
    expected = _IBAN_LENGTHS.get(value[:2])
    if expected and len(value) != expected:
        return False
    rearranged = value[4:] + value[:4]
    digits = "".join(
        str(ord(c) - 55) if c.isalpha() else c for c in rearranged
    )
    if not digits.isdigit():
        return False
    return int(digits) % 97 == 1
