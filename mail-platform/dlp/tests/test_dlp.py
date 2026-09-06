"""
mailstack DLP test suite.  Run:  python3 -m unittest discover -s tests -v

The tests that matter most here are not the happy paths — they are:

  * MaskingTests: a masking bug is a data leak. These assert that no masked
    value ever reproduces the raw one.
  * FalsePositiveFloorTests: pins the measured false-positive rate of the
    checksums, which is the documented reason Aadhaar requires a context
    keyword. If someone removes that requirement, this test explains why not.
  * EngineTests: monitor mode must never block, and failures must fail closed.
"""

from __future__ import annotations

import io
import random
import unittest
import zipfile
from email.message import EmailMessage

from dlp import checksums as ck
from dlp.config import policy_from_dict
from dlp.detectors import (
    ALL_DETECTORS,
    BY_ID,
    mask_email,
    mask_keep_edges,
    mask_keep_last,
    scan_text,
)
from dlp.engine import Action, Envelope, Policy, RuleConfig, evaluate
from dlp.extract import extract, html_to_text
from dlp.service import inspect_message
from dlp.config import PolicyStore


# ---------------------------------------------------------------------------
# checksums
# ---------------------------------------------------------------------------


class LuhnTests(unittest.TestCase):
    VALID = [
        "4111111111111111",      # Visa test
        "4012888888881881",
        "5555555555554444",      # Mastercard test
        "5105105105105100",
        "378282246310005",       # Amex test
        "371449635398431",
        "6011111111111117",      # Discover test
        "3530111333300000",      # JCB test
    ]

    def test_valid(self):
        for n in self.VALID:
            self.assertTrue(ck.luhn_valid(n), n)
            self.assertIsNotNone(ck.card_brand(n), n)

    def test_single_digit_change_always_detected(self):
        for n in self.VALID:
            for i in range(len(n)):
                for d in "0123456789":
                    if d == n[i]:
                        continue
                    self.assertFalse(ck.luhn_valid(n[:i] + d + n[i + 1:]))

    def test_rejects_non_digits_and_bad_lengths(self):
        for bad in ["", "41111", "4111-1111-1111-1111", "abcd", "1" * 25]:
            self.assertFalse(ck.luhn_valid(bad), bad)


class VerhoeffTests(unittest.TestCase):
    """Verhoeff's guarantee: it catches every single-digit error and every
    adjacent transposition. Zero misses is the proof the tables are right."""

    def setUp(self):
        random.seed(1234)
        self.numbers = []
        for _ in range(200):
            payload = "".join(random.choice("23456789") for _ in range(11))
            self.numbers.append(payload + str(ck.verhoeff_checksum(payload)))

    def test_round_trip(self):
        for n in self.numbers:
            self.assertTrue(ck.verhoeff_valid(n), n)

    def test_catches_every_single_digit_error(self):
        for n in self.numbers:
            for i in range(len(n)):
                for d in "0123456789":
                    if d == n[i]:
                        continue
                    self.assertFalse(ck.verhoeff_valid(n[:i] + d + n[i + 1:]))

    def test_catches_every_adjacent_transposition(self):
        for n in self.numbers:
            for i in range(len(n) - 1):
                if n[i] == n[i + 1]:
                    continue
                swapped = n[:i] + n[i + 1] + n[i] + n[i + 2:]
                self.assertFalse(ck.verhoeff_valid(swapped))


class AadhaarTests(unittest.TestCase):
    def test_leading_digit_rule(self):
        # UIDAI never issues numbers starting 0 or 1.
        for lead in "01":
            payload = lead + "".join("2" for _ in range(10))
            full = payload + str(ck.verhoeff_checksum(payload))
            self.assertTrue(ck.verhoeff_valid(full))
            self.assertFalse(ck.aadhaar_valid(full))

    def test_length_and_type(self):
        self.assertFalse(ck.aadhaar_valid("23456789012"))     # 11 digits
        self.assertFalse(ck.aadhaar_valid("2345678901234"))   # 13 digits
        self.assertFalse(ck.aadhaar_valid("23456789012a"))


class GstinTests(unittest.TestCase):
    # Published examples used in GST documentation.
    VALID = ["27AAPFU0939F1ZV", "29AAGCB7383J1Z4"]

    def test_valid(self):
        for g in self.VALID:
            self.assertTrue(ck.gstin_valid(g), g)

    def test_check_character_is_computed_not_assumed(self):
        for g in self.VALID:
            self.assertEqual(ck.gstin_check_char(g[:14]), g[14])

    def test_rejects_bad_check_char(self):
        for g in self.VALID:
            wrong = "X" if g[14] != "X" else "Y"
            self.assertFalse(ck.gstin_valid(g[:14] + wrong))

    def test_rejects_bad_state_code(self):
        self.assertFalse(ck.gstin_valid("00AAPFU0939F1ZV"))
        self.assertFalse(ck.gstin_valid("50AAPFU0939F1ZV"))

    def test_rejects_embedded_non_pan(self):
        # 4th char of the embedded PAN must be a valid holder type
        self.assertFalse(ck.gstin_valid("27AAPXU0939F1ZV"))


class PanTests(unittest.TestCase):
    def test_valid(self):
        for p in ["AAPFU0939F", "ABCPD1234E", "AAACG2115R"]:
            self.assertTrue(ck.pan_valid(p), p)
            self.assertIsNotNone(ck.pan_holder_type(p))

    def test_rejects_bad_holder_type(self):
        # X is not a holder type; this is what kills most 5-4-1 coincidences.
        self.assertFalse(ck.pan_valid("ABCXD1234E"))

    def test_rejects_lowercase_and_wrong_shape(self):
        for bad in ["abcpd1234e", "ABCPD1234", "ABCP01234E", "ABCPD12345"]:
            self.assertFalse(ck.pan_valid(bad), bad)


class IfscTests(unittest.TestCase):
    def test_valid(self):
        for i in ["HDFC0000123", "SBIN0011513", "ICIC0001234"]:
            self.assertTrue(ck.ifsc_valid(i), i)

    def test_fifth_char_must_be_zero(self):
        self.assertFalse(ck.ifsc_valid("HDFC1000123"))


class IbanTests(unittest.TestCase):
    def test_valid(self):
        for i in ["GB82WEST12345698765432", "DE89370400440532013000"]:
            self.assertTrue(ck.iban_valid(i), i)

    def test_rejects_bad_checksum(self):
        self.assertFalse(ck.iban_valid("GB82WEST12345698765433"))

    def test_rejects_wrong_length_for_country(self):
        self.assertFalse(ck.iban_valid("DE8937040044053201300"))


# ---------------------------------------------------------------------------
# masking — a bug here is a data leak
# ---------------------------------------------------------------------------


class MaskingTests(unittest.TestCase):
    SENSITIVE = [
        "4111111111111111", "234567890124", "AAPFU0939F", "HDFC0000123",
        "27AAPFU0939F1ZV", "AKIAIOSFODNN7EXAMPLE", "50100234567890",
    ]

    def test_masked_never_equals_raw(self):
        for value in self.SENSITIVE:
            for masked in (
                mask_keep_last(value, 4),
                mask_keep_last(value, 0),
                mask_keep_edges(value, 2, 2),
                mask_keep_edges(value, 4, 0),
                mask_keep_edges(value, 0, 4),
            ):
                self.assertNotEqual(masked, value, f"{value!r} was not masked")
                self.assertIn("*", masked)

    def test_zero_keep_masks_everything(self):
        # value[-0:] is the whole string in Python — the guard for this is the
        # difference between a masked log and a breach.
        self.assertEqual(mask_keep_last("HDFC0000123", 0), "*" * 11)
        self.assertEqual(mask_keep_edges("HDFC0000123", 0, 0), "*" * 11)

    def test_short_values_fully_masked(self):
        self.assertEqual(mask_keep_last("123", 4), "***")
        self.assertEqual(mask_keep_edges("AB", 4, 4), "**")

    def test_email_masking_keeps_domain_only(self):
        self.assertEqual(mask_email("sumit@acme.com"), "s****@acme.com")

    def test_no_finding_carries_a_raw_value(self):
        text = ("Card 4111111111111111 cvv 123, aadhaar 2345 6789 0124, "
                "PAN AAPFU0939F, A/c No. 50100234567890, key "
                "AKIAIOSFODNN7EXAMPLE")
        for f in scan_text(text):
            for secret in ["4111111111111111", "234567890124",
                           "50100234567890", "AKIAIOSFODNN7EXAMPLE"]:
                self.assertNotIn(secret, f.masked)


# ---------------------------------------------------------------------------
# the false-positive floor: why context is required
# ---------------------------------------------------------------------------


class FalsePositiveFloorTests(unittest.TestCase):
    """These numbers are the argument for layer 3 (context keywords).

    If a future change makes Aadhaar detection context-optional, this test is
    the record of what that costs: roughly one false hit per twelve 12-digit
    numbers in the customer's mail.
    """

    def test_aadhaar_checksum_alone_is_not_selective(self):
        random.seed(99)
        hits = sum(
            ck.aadhaar_valid("".join(random.choice("0123456789") for _ in range(12)))
            for _ in range(20000)
        )
        rate = hits / 20000
        # ~8%: 8/10 allowed leading digits x 1/10 checksum
        self.assertGreater(rate, 0.05, "unexpectedly selective — check the impl")
        self.assertLess(rate, 0.11)

    def test_context_requirement_removes_bare_numbers(self):
        aadhaar = "234567890124"
        self.assertTrue(ck.aadhaar_valid(aadhaar))
        # no keyword -> dropped entirely
        self.assertEqual(
            [f for f in scan_text(f"Invoice {aadhaar} dated today")
             if f.detector == "aadhaar"], [],
        )
        # with keyword -> detected
        self.assertTrue(
            [f for f in scan_text(f"Aadhaar number {aadhaar}")
             if f.detector == "aadhaar"]
        )

    def test_card_requires_valid_issuer_prefix(self):
        # Luhn-valid but no real issuer range -> not a card.
        self.assertTrue(ck.luhn_valid("9999999999999995"))
        self.assertIsNone(ck.card_brand("9999999999999995"))
        self.assertEqual(
            [f for f in scan_text("card 9999999999999995")
             if f.detector == "payment_card"], [],
        )


# ---------------------------------------------------------------------------
# detectors
# ---------------------------------------------------------------------------


class DetectorTests(unittest.TestCase):
    def found(self, text):
        return {f.detector for f in scan_text(text)}

    def test_card_with_separators(self):
        for text in ["card 4111 1111 1111 1111", "card 4111-1111-1111-1111",
                     "card:4111111111111111"]:
            self.assertIn("payment_card", self.found(text), text)

    def test_cvv_and_expiry(self):
        got = self.found("Card 4111111111111111, CVV: 737, expiry 04/27")
        self.assertEqual({"payment_card", "card_cvv", "card_expiry"}, got)

    def test_bank_account_is_keyword_driven(self):
        self.assertIn("bank_account", self.found("A/c No. 50100234567890"))
        self.assertIn("bank_account", self.found("account number: 123456789012"))
        # bare digits with no keyword are not an account number
        self.assertNotIn("bank_account", self.found("50100234567890"))

    def test_secrets(self):
        self.assertIn("private_key", self.found("-----BEGIN RSA PRIVATE KEY-----"))
        self.assertIn("private_key", self.found("-----BEGIN OPENSSH PRIVATE KEY-----"))
        self.assertIn("aws_access_key", self.found("AKIAIOSFODNN7EXAMPLE"))
        self.assertIn("generic_secret", self.found("api_key = abcdef1234567890"))

    def test_upi(self):
        self.assertIn("upi_id", self.found("pay me at sumit@okhdfcbank"))
        self.assertNotIn("upi_id", self.found("mail me at sumit@gmail.com"))

    def test_confidential_marking(self):
        self.assertIn("confidential_marking", self.found("INTERNAL USE ONLY"))
        self.assertIn("confidential_marking", self.found("Strictly Confidential"))

    def test_clean_text_is_clean(self):
        self.assertEqual(self.found(
            "Hi team, standup moved to 10am. Call 9876543210 if you're stuck."
        ), set())

    def test_every_detector_has_a_weight_and_mask(self):
        for det in ALL_DETECTORS:
            self.assertGreater(det.weight, 0, det.id)
            self.assertTrue(callable(det.mask), det.id)
            self.assertIn(det.id, BY_ID)

    def test_part_context_covers_a_whole_attachment(self):
        """A column header must supply context for the rows below it.

        Without this, a 5,000-row customer export is detected only in its first
        few rows — the exact case the product exists for.
        """
        cards = ["4111111111111111", "5555555555554444", "378282246310005",
                 "6011111111111117", "4012888888881881", "5105105105105100"]
        rows = "".join(f"user{i},{c},2345 6789 0124\n" for i, c in enumerate(cards))
        filler = "".join(f"filler{i},,\n" for i in range(400))
        late = "".join(f"late{i},{cards[i % 6]},2345 6789 0124\n" for i in range(6))
        csv_text = "name,card_number,aadhaar_no\n" + rows + filler + late

        in_body = [f for f in scan_text(csv_text, where="body")
                   if f.detector == "aadhaar"]
        in_attach = [f for f in scan_text(csv_text, where="attachment:dump.csv")
                     if f.detector == "aadhaar"]
        # 12 values carry a valid Aadhaar checksum in this CSV.
        self.assertEqual(len(in_attach), 12,
                         "attachment must inherit context from its header row")
        # The body path only sees values within context_window of the keyword,
        # so it necessarily finds fewer. Asserted as a property, not a magic
        # number, because the exact count depends on row width.
        self.assertGreater(len(in_body), 0)
        self.assertLess(len(in_body), len(in_attach),
                        "body must use local windows only, not part context")

    def test_body_context_is_not_widened(self):
        """One mention of "card" in a long email must not flag every number."""
        cards = ["4111111111111111", "5555555555554444", "378282246310005"]
        prose = "About the card programme.\n" + "\n".join(
            f"reference {c}\n" + "padding line\n" * 20 for c in cards
        )
        findings = [f for f in scan_text(prose, where="body")
                    if f.detector == "payment_card"]
        self.assertTrue(findings)
        self.assertFalse(all(f.context_ok for f in findings),
                         "distant matches should not inherit body context")

    def test_findings_record_location(self):
        findings = scan_text("card 4111111111111111", where="attachment:x.csv")
        self.assertTrue(findings)
        self.assertEqual(findings[0].where, "attachment:x.csv")


# ---------------------------------------------------------------------------
# engine
# ---------------------------------------------------------------------------

CARD_TEXT = "Cardholder data: 4111111111111111 cvv 737 expiry 04/27"


def enforce_policy(**kw) -> Policy:
    base = dict(
        tenant="acme.com",
        mode="enforce",
        internal_domains=("acme.com",),
    )
    base.update(kw)
    return Policy(**base)


class EngineTests(unittest.TestCase):
    def verdict(self, text, policy, sender="a@acme.com", rcpt=("b@gmail.com",)):
        return evaluate(scan_text(text), Envelope(sender, list(rcpt)), policy)

    def test_monitor_mode_never_blocks_or_quarantines(self):
        policy = Policy(tenant="acme.com", mode="monitor",
                        internal_domains=("acme.com",))
        v = self.verdict(CARD_TEXT * 20, policy)
        self.assertIn(v.action, (Action.ALLOW, Action.TAG))
        self.assertTrue(any("monitor mode" in r for r in v.reasons))

    def test_enforce_blocks_high_score(self):
        v = self.verdict(CARD_TEXT, enforce_policy())
        self.assertEqual(v.action, Action.BLOCK)
        self.assertIn("550", v.smtp_response)
        self.assertIn(v.incident_id, v.smtp_response)

    def test_internal_recipients_scored_down(self):
        internal = self.verdict(CARD_TEXT, enforce_policy(), rcpt=("b@acme.com",))
        external = self.verdict(CARD_TEXT, enforce_policy(), rcpt=("b@gmail.com",))
        self.assertLess(internal.score, external.score)
        self.assertTrue(any("internal" in r for r in internal.reasons))

    def test_allowlisted_external_scored_down(self):
        policy = enforce_policy(allowed_external_domains=(".hdfcbank.com",))
        allowed = self.verdict(CARD_TEXT, policy, rcpt=("ops@net.hdfcbank.com",))
        other = self.verdict(CARD_TEXT, policy, rcpt=("x@gmail.com",))
        self.assertLess(allowed.score, other.score)

    def test_subdomain_matching_needs_the_leading_dot(self):
        with_dot = enforce_policy(allowed_external_domains=(".hdfcbank.com",))
        without = enforce_policy(allowed_external_domains=("hdfcbank.com",))
        r = ("ops@net.hdfcbank.com",)
        self.assertLess(
            self.verdict(CARD_TEXT, with_dot, rcpt=r).score,
            self.verdict(CARD_TEXT, without, rcpt=r).score,
        )

    def test_exempt_sender_short_circuits(self):
        policy = enforce_policy(exempt_senders=("bot@acme.com",))
        v = self.verdict(CARD_TEXT, policy, sender="bot@acme.com")
        self.assertEqual(v.action, Action.ALLOW)
        self.assertEqual(v.findings, [])

    def test_bulk_escalates_superlinearly(self):
        # High cap so this measures the bulk curve, not the ceiling.
        policy = enforce_policy(
            bulk_threshold=3, bulk_exponent=1.5,
            rules={"payment_card": RuleConfig("payment_card",
                                              max_contribution=1000.0)},
        )
        one = self.verdict("card 4111111111111111", policy).score
        many = self.verdict(
            " ".join(["card 4111111111111111", "card 5555555555554444",
                      "card 378282246310005", "card 6011111111111117",
                      "card 4012888888881881", "card 5105105105105100",
                      "card 371449635398431", "card 3530111333300000"]),
            policy,
        ).score
        self.assertGreater(many, one * 8)

    def test_card_plus_cvv_boost(self):
        policy = enforce_policy()
        no_cvv = self.verdict("card 4111111111111111", policy).score
        with_cvv = self.verdict("card 4111111111111111 cvv 737", policy).score
        self.assertGreater(with_cvv, no_cvv * 1.5)

    def test_no_findings_is_allow(self):
        v = self.verdict("lunch at 1pm?", enforce_policy())
        self.assertEqual(v.action, Action.ALLOW)
        self.assertEqual(v.score, 0.0)

    def test_missing_context_scores_lower(self):
        policy = enforce_policy()
        # same card number, once with card words nearby and once without
        with_ctx = self.verdict("please charge card 4111111111111111", policy).score
        no_ctx = self.verdict("reference 4111111111111111 shipped", policy).score
        self.assertGreater(with_ctx, no_ctx)
        self.assertGreater(no_ctx, 0.0)

    def test_max_contribution_caps_one_detector(self):
        policy = enforce_policy(
            rules={"payment_card": RuleConfig("payment_card", max_contribution=10.0)},
            bulk_threshold=100,
        )
        v = self.verdict(" ".join(["card 4111111111111111"] * 50), policy)
        # 10 capped, x1.5 no (no cvv), x2 external = 20
        self.assertLessEqual(v.score, 20.0001)

    def test_headers_and_audit_record_are_masked(self):
        v = self.verdict(CARD_TEXT, enforce_policy())
        env = Envelope("a@acme.com", ["b@gmail.com"], subject="hi")
        record = v.audit_record(env)
        blob = repr(record) + repr(v.headers())
        self.assertNotIn("4111111111111111", blob)
        self.assertIn("X-DLP-Incident", v.headers())
        self.assertEqual(record["action"], "block")

    def test_incident_ids_are_unique(self):
        ids = {self.verdict(CARD_TEXT, enforce_policy()).incident_id
               for _ in range(50)}
        self.assertEqual(len(ids), 50)


# ---------------------------------------------------------------------------
# extraction
# ---------------------------------------------------------------------------


def build_message(body="", attachments=(), subject="hello"):
    msg = EmailMessage()
    msg["From"] = "a@acme.com"
    msg["To"] = "b@gmail.com"
    msg["Subject"] = subject
    msg.set_content(body or "see attached")
    for name, data, (maintype, subtype) in attachments:
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    return msg.as_bytes()


class ExtractTests(unittest.TestCase):
    def test_body_and_subject(self):
        result = extract(build_message("card 4111111111111111", subject="urgent"))
        names = {p.name for p in result.parts}
        self.assertIn("body", names)
        self.assertIn("subject", names)
        self.assertTrue(any("4111111111111111" in p.text for p in result.parts))

    def test_html_to_text(self):
        text = html_to_text(
            "<html><style>p{}</style><body><p>card 4111111111111111</p>"
            "<script>x=1</script>&amp; more</body></html>"
        )
        self.assertIn("4111111111111111", text)
        self.assertNotIn("<p>", text)
        self.assertNotIn("x=1", text)
        self.assertIn("&", text)

    def test_csv_attachment_is_extracted(self):
        csv_bytes = b"name,card\nA,4111111111111111\nB,5555555555554444\n"
        result = extract(build_message(attachments=[
            ("dump.csv", csv_bytes, ("text", "csv")),
        ]))
        blob = "\n".join(p.text for p in result.parts)
        self.assertIn("4111111111111111", blob)

    def test_password_protected_zip_is_reported_not_ignored(self):
        # Python's zipfile cannot *write* encrypted archives, so set the
        # encryption bit by hand. It must be set in BOTH the local file header
        # and the central directory: infolist() reads the central directory,
        # so patching only the local header proves nothing.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("secret.txt", "card 4111111111111111")
        data = bytearray(buf.getvalue())
        local = data.find(b"PK\x03\x04")          # flags at +6
        central = data.find(b"PK\x01\x02")        # flags at +8
        self.assertNotEqual(local, -1)
        self.assertNotEqual(central, -1)
        data[local + 6] |= 0x01
        data[central + 8] |= 0x01

        # sanity: zipfile now agrees the member is encrypted
        self.assertTrue(
            any(i.flag_bits & 0x1 for i in zipfile.ZipFile(io.BytesIO(bytes(data))).infolist())
        )

        result = extract(build_message(attachments=[
            ("locked.zip", bytes(data), ("application", "zip")),
        ]))
        reasons = " ".join(p.reason for p in result.unscannable)
        self.assertIn("password-protected", reasons)
        # and no content leaked out of it
        self.assertNotIn("4111111111111111",
                         "".join(p.text for p in result.parts))

    def test_archive_bomb_is_refused(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("big.txt", "A" * (60 * 1024 * 1024))
        result = extract(build_message(attachments=[
            ("bomb.zip", buf.getvalue(), ("application", "zip")),
        ]))
        reasons = " ".join(p.reason for p in result.unscannable)
        self.assertTrue("archive" in reasons or "expands" in reasons, reasons)

    def test_readable_zip_is_extracted(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("inner.csv", "card,4111111111111111\n")
        result = extract(build_message(attachments=[
            ("ok.zip", buf.getvalue(), ("application", "zip")),
        ]))
        blob = "\n".join(p.text for p in result.parts)
        self.assertIn("4111111111111111", blob)

    def test_unparseable_input_still_scanned(self):
        result = extract(b"\x00\x01 not a message card 4111111111111111")
        self.assertTrue(result.parts)


# ---------------------------------------------------------------------------
# end to end
# ---------------------------------------------------------------------------


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.store = PolicyStore("/nonexistent-policy-dir")

    def test_default_store_is_monitor_only(self):
        """A missing policy directory must never start blocking mail."""
        raw = build_message("card 4111111111111111 cvv 737 " * 30)
        v = inspect_message(
            raw, Envelope("a@acme.com", ["b@gmail.com"]), self.store
        )
        self.assertIn(v.action, (Action.ALLOW, Action.TAG))

    def test_enforce_policy_from_dict_blocks_export(self):
        store = PolicyStore("/nonexistent")
        policy = policy_from_dict("acme.com", {
            "mode": "enforce",
            "internal_domains": ["acme.com"],
            "block_at": 16,
            "bulk_threshold": 3,
        })
        store._cache["forced"] = (0.0, policy)
        store.get = lambda tenant: policy  # type: ignore[assignment]

        csv_bytes = b"name,card\n" + b"".join(
            f"user{i},4111111111111111\n".encode() for i in range(20)
        )
        raw = build_message(
            "attached as requested",
            attachments=[("customers.csv", csv_bytes, ("text", "csv"))],
        )
        v = inspect_message(raw, Envelope("a@acme.com", ["x@gmail.com"]), store)
        self.assertEqual(v.action, Action.BLOCK)
        self.assertTrue(any("bulk" in r for r in v.reasons))
        self.assertNotIn("4111111111111111", repr(v.audit_record(
            Envelope("a@acme.com", ["x@gmail.com"])
        )))

    def test_clean_mail_is_allowed(self):
        raw = build_message("Standup at 10. Bring the roadmap.")
        v = inspect_message(raw, Envelope("a@acme.com", ["b@acme.com"]), self.store)
        self.assertEqual(v.action, Action.ALLOW)


class PolicyLoadingTests(unittest.TestCase):
    def test_bool_shorthand_disables_a_rule(self):
        p = policy_from_dict("x.com", {"rules": {"aadhaar": False}})
        self.assertFalse(p.rule("aadhaar").enabled)
        self.assertNotIn("aadhaar", [d.id for d in p.active_detectors()])

    def test_unknown_keys_are_ignored(self):
        p = policy_from_dict("x.com", {"mode": "enforce", "nonsense": 1})
        self.assertEqual(p.mode, "enforce")

    def test_shipped_default_policy_is_monitor_mode(self):
        """Ship-safe default: the bundled policy must not block anything."""
        from pathlib import Path
        path = Path(__file__).resolve().parent.parent / "policies" / "default.yml"
        if not path.is_file():
            self.skipTest("policies/default.yml not present")
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML not installed")
        data = yaml.safe_load(path.read_text())
        self.assertEqual(policy_from_dict("default", data).mode, "monitor")


if __name__ == "__main__":
    unittest.main(verbosity=2)
