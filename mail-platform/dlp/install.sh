#!/usr/bin/env bash
# ============================================================================
#  Install mailstack DLP onto a server that already runs the mailstack
#  bootstrap (Modoboa + Postfix + Rspamd).
#
#  Installs in MONITOR MODE. Nothing is blocked or held until you edit a
#  policy and set `mode: enforce`. That is deliberate — see README.md.
#
#  Usage:
#    sudo ./install.sh --dry-run
#    sudo ./install.sh
# ============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_DIR=/opt/mailstack-dlp
CONF_DIR=/etc/mailstack-dlp
POLICY_DIR="$CONF_DIR/policies"
LOG_DIR=/var/log/mailstack-dlp
SERVICE_USER=mailstack-dlp
PORT="${DLP_PORT:-11333}"

DRY_RUN=false
ENABLE_QUARANTINE=true

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi
ok()   { printf '%s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s⚠ %s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
die()  { printf '%s✘ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)          DRY_RUN=true ;;
    --no-quarantine)    ENABLE_QUARANTINE=false ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

run() {
  if $DRY_RUN; then printf '   [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}
run_sh() {
  if $DRY_RUN; then printf '   [dry-run] sh -c %s\n' "$1"; return 0; fi
  bash -c "$1"
}
write() {
  local path="$1" mode="${2:-0644}" content
  content="$(cat)"
  if $DRY_RUN; then printf '   [dry-run] write %s (mode %s)\n' "$path" "$mode"; return 0; fi
  mkdir -p "$(dirname "$path")"
  [[ -f "$path" ]] && cp -a "$path" "$path.bak.$(date +%Y%m%d%H%M%S)"
  printf '%s\n' "$content" >"$path"
  chmod "$mode" "$path"
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "run as root"
command -v python3 >/dev/null || die "python3 not found"

python3 - <<'PY' || die "Python 3.10+ required (dataclasses + PEP 604 unions)"
import sys
sys.exit(0 if sys.version_info >= (3, 10) else 1)
PY

for svc in postfix rspamd; do
  if ! systemctl list-unit-files 2>/dev/null | grep -q "^${svc}.service"; then
    warn "$svc is not installed — DLP needs the mailstack bootstrap first"
  fi
done

# ---------------------------------------------------------------------------
# application
# ---------------------------------------------------------------------------
echo "Installing application to $APP_DIR"
run mkdir -p "$APP_DIR" "$POLICY_DIR" "$LOG_DIR"
run_sh "cp -r '$SCRIPT_DIR/dlp' '$APP_DIR/'"
run_sh "cp -r '$SCRIPT_DIR/tests' '$APP_DIR/' 2>/dev/null || true"

# PyYAML for policy files; the document extractors are optional but you want
# them — the leak is almost always the attached spreadsheet.
run_sh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    python3-yaml python3-openpyxl python3-docx 2>/dev/null || \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-yaml"

if ! $DRY_RUN; then
  for mod in yaml openpyxl docx pdfplumber; do
    if python3 -c "import $mod" 2>/dev/null; then
      ok "extractor available: $mod"
    else
      warn "$mod not installed — matching attachments will be reported as unscannable"
    fi
  done
fi

# ---------------------------------------------------------------------------
# policies
# ---------------------------------------------------------------------------
if [[ -f "$POLICY_DIR/default.yml" ]]; then
  ok "keeping existing $POLICY_DIR/default.yml"
else
  run_sh "cp '$SCRIPT_DIR/policies/default.yml' '$POLICY_DIR/default.yml'"
  ok "installed default policy (monitor mode)"
fi
run_sh "cp '$SCRIPT_DIR/policies/example-fintech.yml' '$POLICY_DIR/example-fintech.yml.sample'"

# ---------------------------------------------------------------------------
# service user + systemd
# ---------------------------------------------------------------------------
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  run useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "created user $SERVICE_USER"
fi
run chown -R root:root "$APP_DIR"
run chown -R "$SERVICE_USER:$SERVICE_USER" "$LOG_DIR"
run chmod 0750 "$LOG_DIR"
run chown -R root:"$SERVICE_USER" "$CONF_DIR"
run chmod -R o-rwx "$CONF_DIR"

write /etc/systemd/system/mailstack-dlp.service 0644 <<EOF
[Unit]
Description=mailstack DLP inspection service
Documentation=file://$APP_DIR/README.md
After=network.target
Before=rspamd.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=PYTHONUNBUFFERED=1
Environment=DLP_POLICY_DIR=$POLICY_DIR
Environment=DLP_AUDIT_LOG=$LOG_DIR/audit.jsonl
ExecStart=/usr/bin/python3 -m dlp.service --host 127.0.0.1 --port $PORT
Restart=always
RestartSec=2

# The service reads message content, so lock it down.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ReadWritePaths=$LOG_DIR
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
# Inspection is CPU-bound; don't let a pathological attachment eat the box.
CPUQuota=200%
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF

write /etc/logrotate.d/mailstack-dlp 0644 <<EOF
$LOG_DIR/audit.jsonl {
    daily
    rotate 2555
    compress
    delaycompress
    missingok
    notifempty
    create 0640 $SERVICE_USER $SERVICE_USER
}
EOF
# 2555 days ~= 7 years. Set this to whatever your customer's retention
# obligation actually is — the audit trail IS the compliance product.

run systemctl daemon-reload
run systemctl enable mailstack-dlp
run systemctl restart mailstack-dlp

if ! $DRY_RUN; then
  sleep 2
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    ok "service healthy on 127.0.0.1:$PORT"
  else
    die "service did not come up — journalctl -u mailstack-dlp -n 50"
  fi
fi

# ---------------------------------------------------------------------------
# rspamd plugin
# ---------------------------------------------------------------------------
if [[ -d /etc/rspamd ]]; then
  run mkdir -p /etc/rspamd/plugins /etc/rspamd/local.d
  run_sh "cp '$SCRIPT_DIR/rspamd/dlp.lua' /etc/rspamd/plugins/dlp.lua"
  run_sh "sed 's|http://127.0.0.1:11333/inspect|http://127.0.0.1:$PORT/inspect|' \
      '$SCRIPT_DIR/rspamd/dlp.conf' > /etc/rspamd/local.d/dlp.conf"
  if $DRY_RUN; then
    printf '   [dry-run] rspamd -t && systemctl restart rspamd\n'
  else
    if rspamd -t >/dev/null 2>&1; then
      systemctl restart rspamd
      ok "rspamd plugin installed and rspamd restarted"
    else
      warn "rspamd config test failed — removing the plugin so mail keeps flowing"
      rm -f /etc/rspamd/plugins/dlp.lua /etc/rspamd/local.d/dlp.conf
      rspamd -t || true
      die "fix the rspamd error above, then re-run"
    fi
  fi
else
  warn "/etc/rspamd not found — install the plugin by hand (see rspamd/)"
fi

# ---------------------------------------------------------------------------
# postfix quarantine -> hold queue
# ---------------------------------------------------------------------------
if $ENABLE_QUARANTINE && command -v postconf >/dev/null 2>&1; then
  write /etc/postfix/dlp_header_checks 0644 <<'EOF'
# Turn a DLP quarantine verdict into Postfix's own hold queue.
# Release with:  postsuper -H <queue_id>       Delete with: postsuper -d <queue_id>
/^X-DLP-Action:\s*quarantine/     HOLD DLP quarantine - see X-DLP-Incident header
EOF

  if $DRY_RUN; then
    printf '   [dry-run] add regexp:/etc/postfix/dlp_header_checks to header_checks\n'
  else
    current="$(postconf -h header_checks 2>/dev/null | tr -d '\n' || echo "")"
    if [[ "$current" == *"dlp_header_checks"* ]]; then
      ok "postfix header_checks already wired"
    else
      cp -a /etc/postfix/main.cf "/etc/postfix/main.cf.dlp-bak.$(date +%Y%m%d%H%M%S)"
      if [[ -z "$current" ]]; then
        postconf -e "header_checks = regexp:/etc/postfix/dlp_header_checks"
      else
        postconf -e "header_checks = $current, regexp:/etc/postfix/dlp_header_checks"
      fi
      if postfix check 2>&1 | grep -qi error; then
        warn "postfix check failed — reverting header_checks"
        postconf -e "header_checks = $current"
      else
        systemctl reload postfix
        ok "quarantine verdicts will now HOLD in the Postfix queue"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------
cat <<EOF

${C_GREEN}mailstack DLP installed — MONITOR MODE${C_RESET}

  Service     systemctl status mailstack-dlp        (127.0.0.1:$PORT)
  Policies    $POLICY_DIR/
  Audit log   $LOG_DIR/audit.jsonl
  Logs        journalctl -u mailstack-dlp -f

Nothing is blocked or held yet. Every outbound message is inspected, scored
and stamped with X-DLP-* headers, and every hit is written to the audit log.

NEXT
  1. Send yourself a test mail containing a card test number and confirm the
     X-DLP-* headers appear:
       printf 'Subject: t\\n\\ncard 4111111111111111 cvv 737\\n' | sendmail you@elsewhere.com
       tail -f $LOG_DIR/audit.jsonl

  2. Leave it in monitor mode for 2–4 WEEKS per tenant. Read the audit log,
     find the false positives in that tenant's real mail, tune weights and
     thresholds in their policy file.

  3. Only then create $POLICY_DIR/<their-domain>.yml with mode: enforce.
     Start with block_at high, quarantine first, block later.

     A DLP rollout that blocks real business mail in week one is a DLP
     rollout the customer switches off in week two.

  4. Decide the failure posture. Default is on_error = "defer" in
     /etc/rspamd/local.d/dlp.conf: if inspection is down, mail waits. That is
     correct for a compliance control and it means a DLP outage becomes a mail
     outage — so monitor this service like you monitor Postfix.
EOF
