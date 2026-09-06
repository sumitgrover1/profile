"""
Policy loading.

One file per tenant in the policy directory, named `<domain>.yml` (or `.json`),
plus `default.yml` as the fallback for any domain without its own file. Files
are re-read when their mtime changes, so editing a policy takes effect without
a restart — a policy change you have to schedule a restart for is a policy
change nobody makes.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from .engine import Policy, RuleConfig

DEFAULT_POLICY_DIR = Path(
    os.environ.get("DLP_POLICY_DIR", "/etc/mailstack-dlp/policies")
)

_TUPLE_FIELDS = ("internal_domains", "allowed_external_domains", "exempt_senders")


def _load_file(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix in (".yml", ".yaml"):
        try:
            import yaml  # type: ignore
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                f"{path} is YAML but PyYAML is not installed. "
                "Install PyYAML or use a .json policy file."
            ) from exc
        return yaml.safe_load(text) or {}
    return json.loads(text or "{}")


def policy_from_dict(tenant: str, data: dict[str, Any]) -> Policy:
    rules: dict[str, RuleConfig] = {}
    for detector_id, cfg in (data.get("rules") or {}).items():
        if isinstance(cfg, bool):                 # `rules: {aadhaar: false}`
            rules[detector_id] = RuleConfig(detector=detector_id, enabled=cfg)
            continue
        cfg = cfg or {}
        rules[detector_id] = RuleConfig(
            detector=detector_id,
            enabled=bool(cfg.get("enabled", True)),
            weight=cfg.get("weight"),
            no_context_factor=float(cfg.get("no_context_factor", 0.35)),
            max_contribution=float(cfg.get("max_contribution", 100.0)),
        )

    kwargs: dict[str, Any] = {"tenant": tenant, "rules": rules}
    for key in (
        "mode", "tag_at", "quarantine_at", "block_at", "external_multiplier",
        "allowed_divisor", "bulk_threshold", "bulk_exponent", "max_scan_bytes",
    ):
        if key in data and data[key] is not None:
            kwargs[key] = data[key]
    for key in _TUPLE_FIELDS:
        if data.get(key):
            kwargs[key] = tuple(str(v) for v in data[key])

    return Policy(**kwargs)


class PolicyStore:
    """Thread-safe, mtime-cached policy loader."""

    def __init__(self, directory: Path | str = DEFAULT_POLICY_DIR):
        self.directory = Path(directory)
        self._cache: dict[str, tuple[float, Policy]] = {}
        self._lock = threading.Lock()

    def _candidates(self, tenant: str) -> list[Path]:
        names = []
        if tenant:
            names += [f"{tenant}.yml", f"{tenant}.yaml", f"{tenant}.json"]
        names += ["default.yml", "default.yaml", "default.json"]
        return [self.directory / n for n in names]

    def get(self, tenant: str) -> Policy:
        tenant = (tenant or "").lower()
        for path in self._candidates(tenant):
            if not path.is_file():
                continue
            mtime = path.stat().st_mtime
            with self._lock:
                cached = self._cache.get(str(path))
                if cached and cached[0] == mtime:
                    # A per-tenant policy file may be shared as the default;
                    # keep the tenant name accurate for audit records.
                    policy = cached[1]
                    if policy.tenant != tenant and tenant:
                        policy = policy_from_dict(tenant, _load_file(path))
                        self._cache[str(path)] = (mtime, policy)
                    return policy
            policy = policy_from_dict(tenant or path.stem, _load_file(path))
            with self._lock:
                self._cache[str(path)] = (mtime, policy)
            return policy

        # Nothing on disk: monitor-only defaults so a missing file can never
        # start blocking a customer's mail.
        return Policy(tenant=tenant or "default", mode="monitor")

    def tenants(self) -> list[str]:
        if not self.directory.is_dir():
            return []
        return sorted(
            p.stem for p in self.directory.iterdir()
            if p.suffix in (".yml", ".yaml", ".json") and p.stem != "default"
        )
