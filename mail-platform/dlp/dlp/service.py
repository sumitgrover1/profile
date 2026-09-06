"""
The inspection service.

Stdlib HTTP only — no framework. This runs on a mail server, listens on
loopback, and is called once per outbound message; adding a dependency tree to
it buys nothing and breaks on the next distro upgrade.

    POST /inspect      body = raw RFC5322 message
                       envelope passed as X-DLP-* request headers
                       -> JSON verdict
    GET  /healthz      -> {"status": "ok"}
    GET  /policies     -> tenants with a policy file

Audit records are appended as JSON Lines. They contain masked values only.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import DEFAULT_POLICY_DIR, PolicyStore
from .detectors import Finding
from .engine import Action, Envelope, Verdict, evaluate
from .extract import extract, iter_scannable
from .detectors import scan_text

LOG = logging.getLogger("mailstack-dlp")

MAX_BODY_BYTES = int(os.environ.get("DLP_MAX_BODY_BYTES", 50 * 1024 * 1024))
AUDIT_PATH = Path(os.environ.get("DLP_AUDIT_LOG", "/var/log/mailstack-dlp/audit.jsonl"))

_audit_lock = threading.Lock()


def write_audit(record: dict) -> None:
    """Append one audit line. Never raises — a logging failure must not
    become a mail failure, but it is logged loudly."""
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **record}
    try:
        AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        with _audit_lock:
            with AUDIT_PATH.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except Exception as exc:
        LOG.error("AUDIT WRITE FAILED (%s): %s", type(exc).__name__, exc)


def inspect_message(
    raw: bytes,
    envelope: Envelope,
    store: PolicyStore,
) -> Verdict:
    """Extract, scan, score. The whole pipeline for one message."""
    tenant = envelope.tenant or envelope.sender_domain
    envelope.tenant = tenant
    policy = store.get(tenant)
    detectors = policy.active_detectors()

    extracted = extract(raw)
    findings: list[Finding] = []
    for part in iter_scannable(extracted, policy.max_scan_bytes):
        findings.extend(scan_text(part.text, where=part.name, detectors=detectors))

    verdict = evaluate(findings, envelope, policy)

    # Parts we could not read are a policy question, not a silent pass. The
    # classic exfil trick is a password-protected archive.
    for part in extracted.unscannable:
        verdict.reasons.append(f"unscannable: {part.name} — {part.reason}")

    return verdict


class Handler(BaseHTTPRequestHandler):
    server_version = "mailstack-dlp/0.1"
    protocol_version = "HTTP/1.1"
    store: PolicyStore                     # injected below

    # keep the default access log out of syslog; we do our own
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        LOG.debug("%s - %s", self.address_string(), fmt % args)

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._json(200, {"status": "ok", "version": self.server_version})
        elif self.path == "/policies":
            self._json(200, {
                "policy_dir": str(self.store.directory),
                "tenants": self.store.tenants(),
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/inspect":
            self._json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._json(400, {"error": "bad Content-Length"})
            return
        if length <= 0:
            self._json(400, {"error": "empty body"})
            return
        if length > MAX_BODY_BYTES:
            # Too big to inspect. Say so honestly and let the policy decide;
            # never pretend a message was clean because it was large.
            self._json(200, {
                "action": Action.DEFER.value,
                "score": 0.0,
                "incident_id": "dlp-oversize",
                "reasons": [f"message is {length} bytes, above DLP_MAX_BODY_BYTES"],
                "headers": {},
                "smtp_response": "451 4.7.1 Message too large for DLP inspection",
            })
            return

        raw = self.rfile.read(length)

        envelope = Envelope(
            sender=(self.headers.get("X-DLP-Sender") or "").strip(),
            recipients=[
                r.strip() for r in (self.headers.get("X-DLP-Rcpt") or "").split(",")
                if r.strip()
            ],
            subject="",
            message_id=(self.headers.get("X-DLP-Message-Id") or "").strip(),
            tenant=(self.headers.get("X-DLP-Tenant") or "").strip().lower(),
            queue_id=(self.headers.get("X-DLP-Queue-Id") or "").strip(),
            client_ip=(self.headers.get("X-DLP-Client-Ip") or "").strip(),
        )

        started = time.monotonic()
        try:
            verdict = inspect_message(raw, envelope, self.store)
        except Exception as exc:
            # Fail closed. An inspection crash must not become a free pass.
            LOG.exception("inspection failed")
            self._json(200, {
                "action": Action.DEFER.value,
                "score": 0.0,
                "incident_id": "dlp-error",
                "reasons": [f"inspection error: {type(exc).__name__}"],
                "headers": {},
                "smtp_response": "451 4.7.1 Data loss prevention check failed, retry later",
            })
            return

        elapsed_ms = (time.monotonic() - started) * 1000

        record = verdict.audit_record(envelope)
        record["elapsed_ms"] = round(elapsed_ms, 1)
        record["client_ip"] = envelope.client_ip
        if verdict.findings or verdict.action is not Action.ALLOW:
            write_audit(record)

        LOG.info(
            "%s tenant=%s from=%s rcpt=%d score=%.1f action=%s findings=%d %.0fms",
            verdict.incident_id, envelope.tenant, envelope.sender,
            len(envelope.recipients), verdict.score, verdict.action.value,
            len(verdict.findings), elapsed_ms,
        )

        self._json(200, {
            "action": verdict.action.value,
            "score": round(verdict.score, 2),
            "incident_id": verdict.incident_id,
            "mode": verdict.mode,
            "reasons": verdict.reasons,
            "headers": verdict.headers(),
            "smtp_response": verdict.smtp_response,
            "findings": [f.as_dict() for f in verdict.findings],
            "elapsed_ms": round(elapsed_ms, 1),
        })


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="mailstack DLP inspection service")
    ap.add_argument("--host", default=os.environ.get("DLP_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("DLP_PORT", 11333)))
    ap.add_argument("--policy-dir", default=str(DEFAULT_POLICY_DIR))
    ap.add_argument("--log-level", default=os.environ.get("DLP_LOG_LEVEL", "INFO"))
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )

    Handler.store = PolicyStore(args.policy_dir)

    if args.host not in ("127.0.0.1", "::1", "localhost"):
        LOG.warning(
            "Binding to %s. This service accepts unauthenticated message "
            "content — keep it on loopback or firewall it.", args.host,
        )

    with Server((args.host, args.port), Handler) as httpd:
        LOG.info(
            "listening on %s:%s  policies=%s  tenants=%s",
            args.host, args.port, args.policy_dir,
            Handler.store.tenants() or "[default only]",
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            LOG.info("shutting down")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
