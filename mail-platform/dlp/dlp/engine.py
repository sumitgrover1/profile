"""
Policy engine: turn findings into a verdict.

Design decisions worth knowing before you change anything here:

* **Scoring, not booleans.** One PAN in an email to the company's own auditor
  is business as usual. Forty card numbers in a spreadsheet to a Gmail address
  is an incident. A binary rule can't tell those apart, so every finding adds
  weight and the total decides the action.

* **Direction matters more than content.** Internal-to-internal mail barely
  matters; the risk is data leaving the tenant. External recipients multiply
  the score, allow-listed ones divide it.

* **Bulk beats severity.** The real breach is rarely one card number in a
  sentence — it's a customer export attached to a mail. Repeat counts escalate
  super-linearly for exactly that reason.

* **Fail closed by default.** If inspection can't complete, `DEFER` tells
  Postfix to retry rather than letting the mail through unexamined. A DLP
  system that fails open is decoration.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Iterable, Sequence

from .detectors import BY_ID, Detector, Finding


class Action(str, Enum):
    ALLOW = "allow"          # deliver, nothing recorded beyond the audit line
    TAG = "tag"              # deliver, add X-DLP-* headers (monitor mode)
    QUARANTINE = "quarantine"  # hold for admin release
    BLOCK = "block"          # reject at SMTP time with a 5xx
    DEFER = "defer"          # 4xx, retry later (inspection failed)


#: SMTP responses. Keep them useful to the sender but free of detail an
#: attacker could probe with — never echo what matched.
SMTP_RESPONSES = {
    Action.BLOCK: (
        "550 5.7.1 Message blocked by data loss prevention policy. "
        "Contact your administrator, quoting id {incident_id}"
    ),
    Action.QUARANTINE: (
        "250 2.0.0 Message accepted and held for review (id {incident_id})"
    ),
    Action.DEFER: (
        "451 4.7.1 Data loss prevention check unavailable, please retry"
    ),
}


@dataclass
class RuleConfig:
    """Per-tenant tuning for one detector."""

    detector: str
    enabled: bool = True
    weight: float | None = None       # override the detector's default
    #: findings whose context keyword was missing are scaled by this
    no_context_factor: float = 0.35
    #: Hard ceiling so one noisy detector can't dominate the score.
    #: Keep this well above `block_at`: with a weight of 9 a cap of 40 means
    #: only ~4 hits ever count, which silently cancels bulk escalation — the
    #: rule that catches an actual data export. Lower it per-rule for noisy
    #: detectors, not globally.
    max_contribution: float = 100.0


@dataclass
class Policy:
    """A tenant's DLP policy."""

    tenant: str
    mode: str = "monitor"                       # monitor | enforce
    internal_domains: tuple[str, ...] = ()
    #: recipients that may legitimately receive sensitive data (auditor, bank)
    allowed_external_domains: tuple[str, ...] = ()
    #: senders exempt entirely (a payments service account, say)
    exempt_senders: tuple[str, ...] = ()
    rules: dict[str, RuleConfig] = field(default_factory=dict)

    # score thresholds, lowest first
    tag_at: float = 4.0
    quarantine_at: float = 12.0
    block_at: float = 25.0

    #: multiplier applied when any recipient is outside internal_domains
    external_multiplier: float = 2.0
    #: divisor applied when *every* external recipient is allow-listed
    allowed_divisor: float = 4.0
    #: findings of the same detector beyond this count escalate hard
    bulk_threshold: int = 5
    bulk_exponent: float = 1.35

    #: don't scan beyond this many bytes of extracted text per part
    max_scan_bytes: int = 2_000_000

    def rule(self, detector_id: str) -> RuleConfig:
        return self.rules.get(detector_id) or RuleConfig(detector=detector_id)

    def active_detectors(self) -> list[Detector]:
        out = []
        for det in BY_ID.values():
            if self.rule(det.id).enabled:
                out.append(det)
        return out


@dataclass
class Verdict:
    action: Action
    score: float
    incident_id: str
    findings: list[Finding]
    reasons: list[str] = field(default_factory=list)
    mode: str = "monitor"

    @property
    def smtp_response(self) -> str | None:
        template = SMTP_RESPONSES.get(self.action)
        return template.format(incident_id=self.incident_id) if template else None

    def headers(self) -> dict[str, str]:
        """Headers to stamp on the message (monitor mode's whole output)."""
        by_detector: dict[str, int] = {}
        for f in self.findings:
            by_detector[f.detector] = by_detector.get(f.detector, 0) + 1
        summary = ", ".join(f"{k}={v}" for k, v in sorted(by_detector.items()))
        return {
            "X-DLP-Incident": self.incident_id,
            "X-DLP-Score": f"{self.score:.1f}",
            "X-DLP-Action": self.action.value,
            "X-DLP-Mode": self.mode,
            "X-DLP-Findings": summary or "none",
        }

    def audit_record(self, envelope: "Envelope") -> dict:
        """The row you keep. Masked values only — never the raw match."""
        return {
            "incident_id": self.incident_id,
            "tenant": envelope.tenant,
            "sender": envelope.sender,
            "recipients": list(envelope.recipients),
            "subject": envelope.subject[:200],
            "message_id": envelope.message_id,
            "score": round(self.score, 2),
            "action": self.action.value,
            "mode": self.mode,
            "reasons": self.reasons,
            "findings": [f.as_dict() for f in self.findings],
        }


@dataclass
class Envelope:
    """What we know about the message under inspection."""

    sender: str
    recipients: Sequence[str]
    subject: str = ""
    message_id: str = ""
    tenant: str = ""
    queue_id: str = ""
    client_ip: str = ""

    @property
    def sender_domain(self) -> str:
        return self.sender.rpartition("@")[2].lower()

    def recipient_domains(self) -> list[str]:
        return [r.rpartition("@")[2].lower() for r in self.recipients]


def _domain_matches(domain: str, patterns: Iterable[str]) -> bool:
    """Match a domain against a list, honouring a leading dot for subdomains."""
    domain = domain.lower()
    for p in patterns:
        p = p.lower().lstrip("*")
        if p.startswith("."):
            if domain == p[1:] or domain.endswith(p):
                return True
        elif domain == p:
            return True
    return False


def _new_incident_id(envelope: Envelope) -> str:
    """Short, sortable, and safe to print in an SMTP reply."""
    import hashlib
    import time

    seed = f"{time.time_ns()}|{envelope.queue_id}|{envelope.message_id}|{envelope.sender}"
    return "dlp-" + hashlib.sha256(seed.encode()).hexdigest()[:12]


def evaluate(
    findings: Sequence[Finding],
    envelope: Envelope,
    policy: Policy,
) -> Verdict:
    """Score the findings and choose an action."""
    incident_id = _new_incident_id(envelope)
    reasons: list[str] = []

    # --- exemptions ---------------------------------------------------------
    if policy.exempt_senders and (
        envelope.sender.lower() in {s.lower() for s in policy.exempt_senders}
        or _domain_matches(envelope.sender_domain, policy.exempt_senders)
    ):
        return Verdict(
            action=Action.ALLOW,
            score=0.0,
            incident_id=incident_id,
            findings=[],
            reasons=["sender is exempt from DLP policy"],
            mode=policy.mode,
        )

    if not findings:
        return Verdict(Action.ALLOW, 0.0, incident_id, [], ["no findings"], policy.mode)

    # --- base score, per detector, with bulk escalation ---------------------
    grouped: dict[str, list[Finding]] = {}
    for f in findings:
        grouped.setdefault(f.detector, []).append(f)

    score = 0.0
    for detector_id, group in grouped.items():
        rule = policy.rule(detector_id)
        base = rule.weight if rule.weight is not None else BY_ID[detector_id].weight

        contribution = 0.0
        for f in group:
            contribution += base * (1.0 if f.context_ok else rule.no_context_factor)

        # Bulk: 40 card numbers is not 40x one card number, it's worse.
        n = len(group)
        if n > policy.bulk_threshold:
            factor = (n / policy.bulk_threshold) ** (policy.bulk_exponent - 1.0)
            contribution *= factor
            reasons.append(
                f"{n} × {detector_id} — bulk escalation ×{factor:.2f}"
            )

        contribution = min(contribution, rule.max_contribution)
        score += contribution

    # --- proximity boost: card + CVV together is card-present data ----------
    if "payment_card" in grouped and ("card_cvv" in grouped or "card_expiry" in grouped):
        score *= 1.5
        reasons.append("card number with CVV/expiry — full card data ×1.5")

    # --- direction ----------------------------------------------------------
    rcpt_domains = envelope.recipient_domains()
    external = [d for d in rcpt_domains if not _domain_matches(d, policy.internal_domains)]

    if not external:
        score *= 0.25
        reasons.append("all recipients internal ×0.25")
    else:
        unapproved = [
            d for d in external
            if not _domain_matches(d, policy.allowed_external_domains)
        ]
        if unapproved:
            score *= policy.external_multiplier
            reasons.append(
                f"external recipients ({', '.join(sorted(set(unapproved))[:3])}) "
                f"×{policy.external_multiplier}"
            )
        else:
            score /= policy.allowed_divisor
            reasons.append(
                f"all external recipients allow-listed ÷{policy.allowed_divisor}"
            )

    # --- threshold ----------------------------------------------------------
    if score >= policy.block_at:
        action = Action.BLOCK
    elif score >= policy.quarantine_at:
        action = Action.QUARANTINE
    elif score >= policy.tag_at:
        action = Action.TAG
    else:
        action = Action.ALLOW

    # Monitor mode never interferes with delivery. Run every new tenant and
    # every new rule here for weeks before switching to enforce — a DLP
    # rollout that blocks real business mail on day one gets switched off.
    if policy.mode != "enforce" and action in (Action.BLOCK, Action.QUARANTINE):
        reasons.append(f"monitor mode: would have been {action.value}")
        action = Action.TAG

    return Verdict(
        action=action,
        score=score,
        incident_id=incident_id,
        findings=list(findings),
        reasons=reasons,
        mode=policy.mode,
    )
