#!/usr/bin/env bash
# ============================================================================
#  mailstack bootstrap — one-shot multi-tenant mail platform installer
#
#  Stack (all open source):
#    Modoboa (ISC)      tenants, domains, mailboxes, quotas, DKIM, DMARC UI
#    Postfix / Dovecot  SMTP + IMAP (installed and wired by Modoboa)
#    Rspamd             spam filtering
#    SOGo (GPL-2)       webmail + calendar + contacts + ActiveSync
#    Roundcube (GPL-3)  optional lighter mail-only webmail
#    postfwd (GPL)      per-mailbox outbound rate limiting
#    restic (BSD)       backups
#
#  Target: a FRESH Ubuntu 24.04 / 22.04 or Debian 12 VPS, run as root.
#
#  Usage:
#    cp mailstack.conf.example mailstack.conf && nano mailstack.conf
#    ./bootstrap.sh --dry-run          # show what would happen, change nothing
#    ./bootstrap.sh                    # do it
#    ./bootstrap.sh --only sogo        # re-run a single phase
#
#  The script is idempotent: completed phases are recorded in
#  /var/lib/mailstack/state and skipped on re-runs (--force re-runs them).
# ============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="/var/lib/mailstack"
STATE_FILE="$STATE_DIR/state"
LOG_FILE="/var/log/mailstack-bootstrap.log"
CRED_FILE="/root/.mailstack-credentials"
DNS_FILE="/root/mailstack-dns-records.txt"
INSTALLER_DIR="/opt/modoboa-installer"

PHASES=(preflight system modoboa pwscheme sogo roundcube postfwd firewall ops verify)

DRY_RUN=false
ASSUME_YES=false
FORCE=false
SKIP_PREFLIGHT=false
ONLY_PHASE=""
CONFIG_FILE="$SCRIPT_DIR/mailstack.conf"

# ----------------------------------------------------------------------------
# output helpers
# ----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""
fi

WARNINGS=()

log()  { printf '%s  %s\n' "$(date '+%H:%M:%S')" "$*"; }
info() { printf '%s  %s%s%s\n' "$(date '+%H:%M:%S')" "$C_BLUE" "$*" "$C_RESET"; }
ok()   { printf '%s  %s✔%s %s\n' "$(date '+%H:%M:%S')" "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s  %s⚠ %s%s\n' "$(date '+%H:%M:%S')" "$C_YELLOW" "$*" "$C_RESET"; WARNINGS+=("$*"); }
err()  { printf '%s  %s✘ %s%s\n' "$(date '+%H:%M:%S')" "$C_RED" "$*" "$C_RESET" >&2; }
die()  { err "$*"; exit 1; }

banner() {
  printf '\n%s%s══ %s %s%s\n' "$C_BOLD" "$C_BLUE" "$*" \
    "$(printf '═%.0s' $(seq 1 $((60 - ${#1} > 0 ? 60 - ${#1} : 3))))" "$C_RESET"
}

on_error() {
  local line=$1
  err "Failed at line $line. Full log: $LOG_FILE"
  err "Fix the cause and re-run — completed phases are skipped automatically."
}
trap 'on_error $LINENO' ERR

confirm() {
  $ASSUME_YES && return 0
  local reply
  read -r -p "$(printf '%s%s%s [y/N] ' "$C_YELLOW" "$1" "$C_RESET")" reply || true
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ----------------------------------------------------------------------------
# execution helpers (dry-run aware)
# ----------------------------------------------------------------------------
run() {
  if $DRY_RUN; then
    printf '           %s[dry-run]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"
    return 0
  fi
  "$@"
}

# run a shell string (needed for pipes / redirection)
run_sh() {
  if $DRY_RUN; then
    printf '           %s[dry-run]%s sh -c %s\n' "$C_YELLOW" "$C_RESET" "$1"
    return 0
  fi
  bash -c "$1"
}

# write_file <path> [mode]  — content on stdin, backs up any existing file
write_file() {
  local path="$1" mode="${2:-0644}" content
  content="$(cat)"
  if $DRY_RUN; then
    printf '           %s[dry-run]%s write %s (%s bytes, mode %s)\n' \
      "$C_YELLOW" "$C_RESET" "$path" "${#content}" "$mode"
    return 0
  fi
  mkdir -p "$(dirname "$path")"
  if [[ -f "$path" ]]; then
    cp -a "$path" "${path}.mailstack-bak.$(date +%Y%m%d%H%M%S)"
  fi
  printf '%s\n' "$content" >"$path"
  chmod "$mode" "$path"
}

gen_password() {
  openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 28
}

# edit an ini file safely (used for modoboa installer.cfg)
ini_set() {
  local file="$1" section="$2" key="$3" value="$4"
  if $DRY_RUN; then
    local shown="$value"
    [[ "$key" == *pass* || "$key" == *secret* ]] && shown="********"
    printf '           %s[dry-run]%s ini_set %s [%s] %s=%s\n' \
      "$C_YELLOW" "$C_RESET" "$file" "$section" "$key" "$shown"
    return 0
  fi
  python3 - "$file" "$section" "$key" "$value" <<'PY'
import configparser, sys
path, section, key, value = sys.argv[1:5]
cp = configparser.RawConfigParser()
cp.optionxform = str
cp.read(path)
if not cp.has_section(section):
    cp.add_section(section)
cp.set(section, key, value)
with open(path, "w") as fh:
    cp.write(fh)
PY
}

phase_done()    { grep -qxF "$1" "$STATE_FILE" 2>/dev/null; }
mark_done()     { $DRY_RUN || { mkdir -p "$STATE_DIR"; grep -qxF "$1" "$STATE_FILE" 2>/dev/null || echo "$1" >>"$STATE_FILE"; }; }
should_run() {
  local p="$1"
  [[ -n "$ONLY_PHASE" ]] && { [[ "$ONLY_PHASE" == "$p" ]]; return; }
  $FORCE && return 0
  ! phase_done "$p"
}

# ----------------------------------------------------------------------------
# argument parsing
# ----------------------------------------------------------------------------
usage() {
  cat <<EOF
mailstack bootstrap

  --dry-run           print what would happen, change nothing
  --yes               don't prompt for confirmations
  --force             re-run phases already marked complete
  --only PHASE        run a single phase: ${PHASES[*]}
  --skip-preflight    skip DNS/port/PTR validation (NOT recommended)
  --config FILE       config file (default: ./mailstack.conf)
  -h, --help          this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=true ;;
    --yes|-y)         ASSUME_YES=true ;;
    --force)          FORCE=true ;;
    --only)           ONLY_PHASE="${2:?--only needs a phase name}"; shift ;;
    --skip-preflight) SKIP_PREFLIGHT=true ;;
    --config)         CONFIG_FILE="${2:?--config needs a path}"; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "Unknown argument: $1 (try --help)" ;;
  esac
  shift
done

if [[ -n "$ONLY_PHASE" ]]; then
  # shellcheck disable=SC2076
  [[ " ${PHASES[*]} " =~ " $ONLY_PHASE " ]] || die "Unknown phase '$ONLY_PHASE'. Valid: ${PHASES[*]}"
fi

# ----------------------------------------------------------------------------
# config loading
# ----------------------------------------------------------------------------
[[ -f "$CONFIG_FILE" ]] || die "Config not found: $CONFIG_FILE
  cp mailstack.conf.example mailstack.conf  &&  edit it first."

# shellcheck source=/dev/null
source "$CONFIG_FILE"

: "${MAIL_HOSTNAME:?MAIL_HOSTNAME is required in $CONFIG_FILE}"
: "${PRIMARY_DOMAIN:?PRIMARY_DOMAIN is required in $CONFIG_FILE}"
: "${ADMIN_EMAIL:?ADMIN_EMAIL is required in $CONFIG_FILE}"

TIMEZONE="${TIMEZONE:-UTC}"
DEFAULT_LANGUAGE="${DEFAULT_LANGUAGE:-English}"
INSTALL_SOGO="${INSTALL_SOGO:-yes}"
INSTALL_ROUNDCUBE="${INSTALL_ROUNDCUBE:-no}"
INSTALL_POSTFWD="${INSTALL_POSTFWD:-yes}"
INSTALL_FIREWALL="${INSTALL_FIREWALL:-yes}"
INSTALL_OPS_TOOLS="${INSTALL_OPS_TOOLS:-yes}"
OUTBOUND_MSGS_PER_HOUR="${OUTBOUND_MSGS_PER_HOUR:-100}"
OUTBOUND_MSGS_PER_DAY="${OUTBOUND_MSGS_PER_DAY:-500}"
OUTBOUND_RCPT_PER_DAY="${OUTBOUND_RCPT_PER_DAY:-1000}"
CERTIFICATE_TYPE="${CERTIFICATE_TYPE:-letsencrypt}"
MODOBOA_PASSWORD_SCHEME="${MODOBOA_PASSWORD_SCHEME:-sha512crypt}"
SOGO_REPO_URL="${SOGO_REPO_URL:-https://packages.sogo.nu/nightly/5/ubuntu/}"
SOGO_REPO_KEY_URL="${SOGO_REPO_KEY_URL:-https://keys.openpgp.org/vks/v1/by-fingerprint/74FFC6D72B925A34B5D356BDF8A27B36A6E2EAE9}"
SOGO_REPO_SUITE="${SOGO_REPO_SUITE:-}"
BACKUP_REPO="${BACKUP_REPO:-}"
BACKUP_PASSWORD="${BACKUP_PASSWORD:-}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
BACKUP_KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-6}"
SSH_PORT="${SSH_PORT:-22}"

[[ "$MAIL_HOSTNAME" == *.*.* || "$MAIL_HOSTNAME" == *.* ]] \
  || die "MAIL_HOSTNAME must be a fully-qualified name like mail.example.com"

# ----------------------------------------------------------------------------
# credentials
# ----------------------------------------------------------------------------
load_or_generate_credentials() {
  if [[ -f "$CRED_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$CRED_FILE"
    info "Reusing credentials from $CRED_FILE"
  fi
  DB_PASSWORD="${DB_PASSWORD:-$(gen_password)}"
  SOGO_DB_PASSWORD="${SOGO_DB_PASSWORD:-$(gen_password)}"
  ROUNDCUBE_DB_PASSWORD="${ROUNDCUBE_DB_PASSWORD:-$(gen_password)}"

  if ! $DRY_RUN; then
    umask 077
    cat >"$CRED_FILE" <<EOF
# mailstack generated credentials — keep this file safe, mode 0600
# Generated $(date -Is) on $(hostname -f 2>/dev/null || hostname)
DB_PASSWORD="$DB_PASSWORD"
SOGO_DB_PASSWORD="$SOGO_DB_PASSWORD"
ROUNDCUBE_DB_PASSWORD="$ROUNDCUBE_DB_PASSWORD"
EOF
    chmod 0600 "$CRED_FILE"
  fi
}

# ============================================================================
#  PHASE 1 — preflight
# ============================================================================
phase_preflight() {
  banner "PREFLIGHT"

  [[ $EUID -eq 0 ]] || die "Run as root (sudo ./bootstrap.sh)"

  # --- OS ---
  local os_id os_ver
  os_id="$(. /etc/os-release && echo "$ID")"
  os_ver="$(. /etc/os-release && echo "$VERSION_ID")"
  info "OS: $os_id $os_ver"
  case "$os_id:$os_ver" in
    ubuntu:24.04|ubuntu:22.04|debian:12) ok "Supported OS" ;;
    *) warn "Untested OS ($os_id $os_ver). Modoboa officially supports Ubuntu 22.04/24.04 and Debian 12."
       confirm "Continue anyway?" || die "Aborted." ;;
  esac

  # --- required tools ---
  local missing=()
  for cmd in curl dig git python3 openssl systemctl ss; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if ((${#missing[@]})); then
    info "Installing prerequisites: ${missing[*]}"
    run_sh "DEBIAN_FRONTEND=noninteractive apt-get update -qq"
    run_sh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl dnsutils git python3 openssl iproute2 ca-certificates"
  fi

  # --- resources ---
  local ram_mb disk_gb
  ram_mb=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 ))
  disk_gb=$(( $(df -BG --output=avail / | tail -1 | tr -dc '0-9') ))
  info "RAM: ${ram_mb}MB   Free disk on /: ${disk_gb}GB"
  (( ram_mb >= 3500 )) || warn "Less than 4GB RAM. Rspamd + ClamAV + PostgreSQL will be tight; expect OOM under load."
  (( disk_gb >= 30 ))  || warn "Less than 30GB free. Mailbox storage will fill fast."

  # --- hostname ---
  local current_fqdn
  current_fqdn="$(hostname -f 2>/dev/null || echo "")"
  if [[ "$current_fqdn" != "$MAIL_HOSTNAME" ]]; then
    info "Setting system hostname to $MAIL_HOSTNAME (was: ${current_fqdn:-unset})"
    run hostnamectl set-hostname "$MAIL_HOSTNAME"
    local short="${MAIL_HOSTNAME%%.*}"
    if ! grep -q "$MAIL_HOSTNAME" /etc/hosts 2>/dev/null; then
      run_sh "printf '127.0.1.1 %s %s\n' '$MAIL_HOSTNAME' '$short' >> /etc/hosts"
    fi
  else
    ok "Hostname already $MAIL_HOSTNAME"
  fi

  $SKIP_PREFLIGHT && { warn "Skipping network validation (--skip-preflight)"; mark_done preflight; return 0; }

  # --- public IP ---
  local pub_ip=""
  for svc in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
    pub_ip="$(curl -4 -fsS --max-time 8 "$svc" 2>/dev/null | tr -d '[:space:]')" && [[ -n "$pub_ip" ]] && break
  done
  [[ -n "$pub_ip" ]] || die "Could not determine this server's public IPv4. Check outbound HTTPS."
  info "Public IPv4: $pub_ip"

  # --- A record ---
  local a_rec
  a_rec="$(dig +short A "$MAIL_HOSTNAME" @1.1.1.1 2>/dev/null | tail -1)"
  if [[ "$a_rec" == "$pub_ip" ]]; then
    ok "A record $MAIL_HOSTNAME → $pub_ip"
  else
    err "A record mismatch: $MAIL_HOSTNAME resolves to '${a_rec:-NOTHING}', server IP is $pub_ip"
    err "Let's Encrypt will fail. Fix DNS, wait for propagation, then re-run."
    confirm "Continue anyway (cert issuance will likely fail)?" || die "Aborted."
  fi

  # --- PTR / reverse DNS ---
  local ptr
  ptr="$(dig +short -x "$pub_ip" @1.1.1.1 2>/dev/null | sed 's/\.$//' | tail -1)"
  if [[ "$ptr" == "$MAIL_HOSTNAME" ]]; then
    ok "PTR $pub_ip → $MAIL_HOSTNAME"
  else
    warn "PTR is '${ptr:-NOT SET}', expected '$MAIL_HOSTNAME'."
    warn "Gmail and Outlook reject or spam-folder mail from hosts without matching reverse DNS."
    warn "Set it in your VPS provider's control panel — this is not something the server can do."
  fi

  # --- outbound port 25: the single most common blocker ---
  info "Testing outbound port 25 …"
  if timeout 10 bash -c "exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25" 2>/dev/null; then
    ok "Outbound port 25 is open"
  else
    err "Outbound port 25 is BLOCKED."
    err "Your VPS provider blocks SMTP by default (AWS, GCP, Azure, DigitalOcean, Oracle all do)."
    err "You cannot deliver any mail until this is unblocked — open a support ticket,"
    err "or use a provider that allows SMTP (Hetzner, OVH, or an Indian DC after asking)."
    confirm "Continue installing anyway (mail will not send)?" || die "Aborted. Get port 25 opened first."
  fi

  # --- local ports free ---
  local busy=()
  while read -r port; do
    if ss -tlnH "sport = :$port" 2>/dev/null | grep -q .; then busy+=("$port"); fi
  done <<<"25
80
443
465
587
993
5432"
  if ((${#busy[@]})); then
    warn "Ports already in use: ${busy[*]}"
    warn "If Apache, another mail server, or a stray Postgres is running, remove it first."
    confirm "Continue anyway?" || die "Aborted."
  else
    ok "Required ports are free"
  fi

  # --- MX (informational) ---
  local mx
  mx="$(dig +short MX "$PRIMARY_DOMAIN" @1.1.1.1 2>/dev/null | awk '{print $2}' | sed 's/\.$//' | tr '\n' ' ')"
  if [[ "$mx" == *"$MAIL_HOSTNAME"* ]]; then
    ok "MX for $PRIMARY_DOMAIN → $MAIL_HOSTNAME"
  else
    warn "MX for $PRIMARY_DOMAIN is '${mx:-not set}'. Add it after install (records printed at the end)."
  fi

  mark_done preflight
}

# ============================================================================
#  PHASE 2 — base system
# ============================================================================
phase_system() {
  banner "SYSTEM PREP"

  run timedatectl set-timezone "$TIMEZONE"
  ok "Timezone: $TIMEZONE"

  run_sh "DEBIAN_FRONTEND=noninteractive apt-get update -qq"
  run_sh "DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq"
  run_sh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      ca-certificates curl dnsutils git gnupg lsb-release \
      python3 python3-pip python3-venv \
      unattended-upgrades bsd-mailx jq rsync openssl \
      apt-transport-https software-properties-common"
  ok "Base packages installed"

  # swap: mail stacks OOM on small VPSes without it
  if [[ ! -f /swapfile ]] && ! swapon --show | grep -q .; then
    info "Creating a 2GB swapfile (no swap configured)"
    run fallocate -l 2G /swapfile
    run chmod 600 /swapfile
    run mkswap /swapfile
    run swapon /swapfile
    run_sh "grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab"
    ok "Swap enabled"
  fi

  # unattended security upgrades only (never auto-upgrade the mail stack)
  write_file /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  ok "Unattended security upgrades enabled"

  mark_done system
}

# ============================================================================
#  PHASE 3 — Modoboa (brings Postfix, Dovecot, Rspamd, nginx, PostgreSQL)
# ============================================================================
phase_modoboa() {
  banner "MODOBOA"

  if [[ -d "$INSTALLER_DIR/.git" ]]; then
    info "Updating modoboa-installer"
    run_sh "cd '$INSTALLER_DIR' && git pull --ff-only"
  else
    info "Cloning modoboa-installer"
    run git clone --depth 1 https://github.com/modoboa/modoboa-installer "$INSTALLER_DIR"
  fi

  local cfg="$INSTALLER_DIR/installer.cfg"

  # First pass generates a default installer.cfg without installing anything.
  if [[ ! -f "$cfg" ]] && ! $DRY_RUN; then
    info "Generating installer.cfg"
    ( cd "$INSTALLER_DIR" && ./run.py --stop-after-configfile-check "$PRIMARY_DOMAIN" ) || true
  fi

  if [[ -f "$cfg" ]] || $DRY_RUN; then
    info "Applying our settings to installer.cfg"
    ini_set "$cfg" general hostname        "$MAIL_HOSTNAME"
    ini_set "$cfg" general nb_workers      "3"
    ini_set "$cfg" certificate generate    "true"
    ini_set "$cfg" certificate type        "$CERTIFICATE_TYPE"
    ini_set "$cfg" letsencrypt email       "$ADMIN_EMAIL"
    ini_set "$cfg" database engine         "postgres"
    ini_set "$cfg" modoboa dbpassword      "$DB_PASSWORD"
    ini_set "$cfg" modoboa timezone        "$TIMEZONE"
    ini_set "$cfg" modoboa devmode         "false"
    # Rspamd instead of the heavier amavis/spamassassin chain
    ini_set "$cfg" rspamd enabled          "true"
    ini_set "$cfg" amavis enabled          "false"
    ini_set "$cfg" spamassassin enabled    "false"
    ini_set "$cfg" clamav enabled          "true"
    ini_set "$cfg" automatic_updates enabled "false"
    # SOGo provides CalDAV/CardDAV; Radicale would duplicate it
    if [[ "$INSTALL_SOGO" == "yes" ]]; then
      ini_set "$cfg" radicale enabled "false"
    fi
  else
    die "installer.cfg was not created. Run manually to see why:
  cd $INSTALLER_DIR && ./run.py --stop-after-configfile-check $PRIMARY_DOMAIN"
  fi

  info "Running the Modoboa installer (this takes 5–15 minutes)…"
  if $DRY_RUN; then
    printf '           %s[dry-run]%s cd %s && ./run.py --force %s\n' \
      "$C_YELLOW" "$C_RESET" "$INSTALLER_DIR" "$PRIMARY_DOMAIN"
  else
    ( cd "$INSTALLER_DIR" && ./run.py --force "$PRIMARY_DOMAIN" ) \
      || die "Modoboa installer failed. Its own log is under $INSTALLER_DIR — read it before re-running."
  fi

  ok "Modoboa installed"
  mark_done modoboa
}

# ============================================================================
#  PHASE 4 — force the password scheme SOGo can read
# ============================================================================
phase_pwscheme() {
  banner "PASSWORD SCHEME"

  info "Forcing Modoboa password scheme to '$MODOBOA_PASSWORD_SCHEME'"
  info "(SOGo cannot authenticate against argon2/pbkdf2 hashes)"

  if $DRY_RUN; then
    printf '           %s[dry-run]%s set core.password_scheme = %s via Modoboa shell\n' \
      "$C_YELLOW" "$C_RESET" "$MODOBOA_PASSWORD_SCHEME"
    return 0
  fi

  local instance="/srv/modoboa/instance"
  local venv="/srv/modoboa/env/bin/python"
  if [[ ! -x "$venv" || ! -d "$instance" ]]; then
    warn "Modoboa instance not found at $instance — set the scheme manually:"
    warn "  Modoboa UI → Parameters → General → Password scheme → sha512crypt"
    return 0
  fi

  # This touches Modoboa's parameter store directly. Verified below; if the
  # internal layout changed with your Modoboa version, set it in the UI.
  local pw_out
  pw_out="$(sudo -u modoboa "$venv" "$instance/manage.py" shell -c "
from modoboa.core.models import LocalConfig
lc = LocalConfig.objects.first()
store = getattr(lc, '_parameters', None)
if store is None:
    store = lc.parameters
store.setdefault('core', {})['password_scheme'] = '$MODOBOA_PASSWORD_SCHEME'
lc.save()
lc.refresh_from_db()
back = (getattr(lc, '_parameters', None) or lc.parameters).get('core', {}).get('password_scheme')
print('OK' if back == '$MODOBOA_PASSWORD_SCHEME' else 'MISMATCH:%s' % back)
" 2>/dev/null || true)"

  if grep -q '^OK$' <<<"$pw_out"; then
    ok "Password scheme set to $MODOBOA_PASSWORD_SCHEME"
  else
    warn "Could not set the password scheme programmatically."
    warn "DO THIS BEFORE CREATING ANY MAILBOX:"
    warn "  Modoboa UI → Parameters → General → Password scheme → sha512crypt"
    warn "Changing it later invalidates every existing password."
  fi

  mark_done pwscheme
}

# ============================================================================
#  PHASE 5 — SOGo (webmail + calendar + contacts + ActiveSync)
# ============================================================================
phase_sogo() {
  [[ "$INSTALL_SOGO" == "yes" ]] || { info "SOGo disabled in config, skipping"; return 0; }
  banner "SOGo"

  local suite="${SOGO_REPO_SUITE:-$(lsb_release -cs 2>/dev/null || echo stable)}"

  # --- repository ---
  info "Adding the SOGo repository (suite: $suite)"
  if ! $DRY_RUN; then
    mkdir -p /usr/share/keyrings
    if curl -fsSL --max-time 20 "$SOGO_REPO_KEY_URL" 2>/dev/null \
         | gpg --dearmor --yes -o /usr/share/keyrings/sogo-archive-keyring.gpg 2>/dev/null; then
      echo "deb [signed-by=/usr/share/keyrings/sogo-archive-keyring.gpg] $SOGO_REPO_URL $suite $suite" \
        >/etc/apt/sources.list.d/sogo.list
      apt-get update -qq 2>/dev/null || true
    else
      warn "Could not fetch the SOGo signing key from $SOGO_REPO_KEY_URL"
      rm -f /etc/apt/sources.list.d/sogo.list
    fi

    if ! apt-cache policy sogo 2>/dev/null | grep -q 'Candidate: [0-9]'; then
      warn "SOGo not available from the custom repo — falling back to the distro package."
      warn "Check current repo details at https://www.sogo.nu/support.html#/downloads"
      rm -f /etc/apt/sources.list.d/sogo.list
      apt-get update -qq
      apt-cache policy sogo | grep -q 'Candidate: [0-9]' \
        || die "No 'sogo' package available at all. Fix the repository and re-run: ./bootstrap.sh --only sogo"
    fi
  fi

  run_sh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sogo sogo-activesync memcached || \
          DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sogo memcached"
  ok "SOGo packages installed"

  # --- database ---
  info "Creating the SOGo database"
  run_sh "sudo -u postgres psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='sogo'\" | grep -q 1 || \
          sudo -u postgres psql -c \"CREATE USER sogo WITH PASSWORD '$SOGO_DB_PASSWORD';\""
  run_sh "sudo -u postgres psql -tAc \"SELECT 1 FROM pg_database WHERE datname='sogo'\" | grep -q 1 || \
          sudo -u postgres createdb -O sogo sogo"
  ok "Database 'sogo' ready"

  # --- the SQL view SOGo authenticates against ---
  # Modoboa keeps the local part in admin_mailbox.address and the domain in
  # admin_domain.name, and prefixes hashes with {SCHEME} — strip it for SOGo.
  info "Creating the sogo_users view over Modoboa's tables"
  if $DRY_RUN; then
    printf '           %s[dry-run]%s CREATE VIEW sogo_users in the modoboa database\n' "$C_YELLOW" "$C_RESET"
  else
    sudo -u postgres psql -d modoboa <<SQL
CREATE OR REPLACE VIEW sogo_users AS
SELECT
    (mb.address || '@' || d.name)                     AS c_uid,
    (mb.address || '@' || d.name)                     AS c_name,
    CASE WHEN position('}' in u.password) > 0
         THEN substring(u.password from position('}' in u.password) + 1)
         ELSE u.password
    END                                               AS c_password,
    COALESCE(
      NULLIF(btrim(u.first_name || ' ' || u.last_name), ''),
      mb.address || '@' || d.name
    )                                                 AS c_cn,
    (mb.address || '@' || d.name)                     AS mail,
    d.name                                            AS domain
FROM admin_mailbox mb
JOIN admin_domain d ON d.id = mb.domain_id
JOIN core_user     u ON u.id = mb.user_id
WHERE u.is_active = true;

GRANT SELECT ON sogo_users TO sogo;
SQL
    local view_rows
    view_rows="$(sudo -u postgres psql -d modoboa -tAc 'SELECT count(*) FROM sogo_users' 2>/dev/null || echo ERR)"
    if [[ "$view_rows" == "ERR" ]]; then
      warn "sogo_users view could not be queried. Modoboa's schema may differ in your version."
      warn "Inspect it with:  sudo -u postgres psql -d modoboa -c '\\d admin_mailbox'"
    else
      ok "sogo_users view created ($view_rows mailboxes visible)"
    fi
  fi

  # --- sogo.conf ---
  info "Writing /etc/sogo/sogo.conf"
  write_file /etc/sogo/sogo.conf 0640 <<EOF
{
  /* ---- SOGo's own database ---- */
  SOGoProfileURL            = "postgresql://sogo:$SOGO_DB_PASSWORD@127.0.0.1:5432/sogo/sogo_user_profile";
  OCSFolderInfoURL          = "postgresql://sogo:$SOGO_DB_PASSWORD@127.0.0.1:5432/sogo/sogo_folder_info";
  OCSSessionsFolderURL      = "postgresql://sogo:$SOGO_DB_PASSWORD@127.0.0.1:5432/sogo/sogo_sessions_folder";
  OCSEMailAlarmsFolderURL   = "postgresql://sogo:$SOGO_DB_PASSWORD@127.0.0.1:5432/sogo/sogo_alarms_folder";
  OCSCacheFolderURL         = "postgresql://sogo:$SOGO_DB_PASSWORD@127.0.0.1:5432/sogo/sogo_cache_folder";

  /* ---- users come from Modoboa via the sogo_users view ---- */
  SOGoUserSources = (
    {
      type                  = sql;
      id                    = modoboa;
      viewURL               = "postgresql://sogo:$SOGO_DB_PASSWORD@127.0.0.1:5432/modoboa/sogo_users";
      canAuthenticate       = YES;
      isAddressBook         = YES;
      userPasswordAlgorithm = sha512-crypt;
    }
  );

  /* ---- mail plumbing (loopback; Dovecot/Postfix are local) ---- */
  SOGoIMAPServer            = "imaps://127.0.0.1:993/?tlsVerifyMode=none";
  SOGoSieveServer           = "sieve://127.0.0.1:4190/?tlsVerifyMode=none";
  SOGoSMTPServer            = "smtp://127.0.0.1:587/?tls=YES&tlsVerifyMode=none";
  SOGoMailDomain            = "$PRIMARY_DOMAIN";
  SOGoMailingMechanism      = smtp;
  SOGoForceExternalLoginWithEmail = YES;
  SOGoIMAPAclConformsToIMAPExt    = YES;
  SOGoMailSpoolPath         = "/var/spool/sogo";

  /* ---- locale ---- */
  SOGoLanguage              = $DEFAULT_LANGUAGE;
  SOGoTimeZone              = "$TIMEZONE";
  SOGoFirstDayOfWeek        = 1;
  SOGoSuperUsernames        = ();

  /* ---- calendar ---- */
  SOGoEnableEMailAlarms     = YES;
  SOGoAppointmentSendEMailNotifications = YES;

  /* ---- ActiveSync (Outlook / iPhone / Android native sync) ----
     These MUST stay below the nginx proxy_read_timeout or long-lived Ping
     requests get cut and phones fall back to slow polling. */
  SOGoMaximumPingInterval     = 3540;
  SOGoMaximumSyncInterval     = 3540;
  SOGoInternalSyncInterval    = 30;
  SOGoMaximumSyncWindowSize   = 100;
  SOGoMaximumSyncResponseSize = 2048;

  /* ---- performance ---- */
  SOGoMemcachedHost         = "127.0.0.1";
  WOWorkersCount            = 8;
  SOGoCacheCleanupInterval   = 300;
  SxVMemLimit               = 512;
  WOPidFile                 = "/var/run/sogo/sogo.pid";
  SOGoZipPath               = "/usr/bin/zip";
}
EOF
  run chown sogo:sogo /etc/sogo/sogo.conf
  run chmod 0640 /etc/sogo/sogo.conf

  run mkdir -p /var/spool/sogo /var/run/sogo
  run chown sogo:sogo /var/spool/sogo /var/run/sogo

  # memcached on loopback only
  if [[ -f /etc/memcached.conf ]] && ! $DRY_RUN; then
    grep -q '^-l 127.0.0.1' /etc/memcached.conf || echo '-l 127.0.0.1' >>/etc/memcached.conf
    systemctl restart memcached || true
  fi

  run systemctl enable --now memcached
  run systemctl enable sogo
  run systemctl restart sogo
  ok "SOGo service started"

  # --- nginx wiring ---
  configure_nginx_sogo

  # --- email alarms / vacation cron ---
  write_file /etc/cron.d/sogo 0644 <<'EOF'
# SOGo housekeeping — email alarms and vacation message expiry
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
*/1 * * * * sogo /usr/sbin/sogo-ealarms-notify >/dev/null 2>&1
0 0 * * * sogo /usr/sbin/sogo-tool update-autoreply -p /etc/sogo/sieve.creds >/dev/null 2>&1
EOF

  mark_done sogo
}

# Insert a SOGo location block into the Modoboa nginx vhost.
configure_nginx_sogo() {
  info "Wiring SOGo into nginx"

  write_file /etc/nginx/snippets/sogo.conf <<EOF
# ---- SOGo (added by mailstack bootstrap) ----
location = /SOGo         { rewrite ^ /SOGo/ permanent; }
location = /sogo         { rewrite ^ /SOGo/ permanent; }
location = /webmail-full { rewrite ^ /SOGo/ permanent; }

location ^~ /SOGo {
    proxy_pass            http://127.0.0.1:20000;
    proxy_redirect        default;
    proxy_http_version    1.1;
    proxy_buffering       off;
    client_max_body_size  100m;
    client_body_buffer_size 128k;

    proxy_set_header  Host              \$host;
    proxy_set_header  X-Real-IP         \$remote_addr;
    proxy_set_header  X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header  X-Forwarded-Proto \$scheme;
    proxy_set_header  x-webobjects-server-protocol HTTP/1.0;
    proxy_set_header  x-webobjects-remote-host     \$remote_addr;
    proxy_set_header  x-webobjects-server-name     \$server_name;
    proxy_set_header  x-webobjects-server-url      \$scheme://\$host;
    proxy_set_header  x-webobjects-server-port     \$server_port;

    proxy_connect_timeout 90s;
    proxy_send_timeout    90s;
    proxy_read_timeout    90s;
}

location ^~ /SOGo.woa/WebServerResources/ {
    alias /usr/lib/GNUstep/SOGo/WebServerResources/;
    allow all;
    expires 30d;
}
location ^~ /SOGo/WebServerResources/ {
    alias /usr/lib/GNUstep/SOGo/WebServerResources/;
    allow all;
    expires 30d;
}
location ~ ^/SOGo/so/ControlPanel/Products/([^/]*)/Resources/(.*)\$ {
    alias /usr/lib/GNUstep/SOGo/\$1.SOGo/Resources/\$2;
    expires 30d;
}

# ---- ActiveSync: long-lived Ping requests need a ~1h timeout ----
location ^~ /Microsoft-Server-ActiveSync {
    proxy_pass            http://127.0.0.1:20000/SOGo/Microsoft-Server-ActiveSync;
    proxy_redirect        default;
    proxy_buffering       off;
    client_max_body_size  100m;

    proxy_set_header  Host              \$host;
    proxy_set_header  X-Real-IP         \$remote_addr;
    proxy_set_header  X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header  X-Forwarded-Proto \$scheme;
    proxy_set_header  x-webobjects-server-protocol HTTP/1.0;
    proxy_set_header  x-webobjects-remote-host     \$remote_addr;
    proxy_set_header  x-webobjects-server-name     \$server_name;
    proxy_set_header  x-webobjects-server-url      \$scheme://\$host;

    proxy_connect_timeout 3600s;
    proxy_send_timeout    3600s;
    proxy_read_timeout    3600s;
}

# ---- autodiscover so Outlook/phones configure themselves ----
location ~* ^/[Aa]utodiscover/[Aa]utodiscover.xml\$ {
    proxy_pass http://127.0.0.1:20000/SOGo/Microsoft-Server-ActiveSync;
    proxy_set_header Host \$host;
    proxy_read_timeout 60s;
}
EOF

  nginx_insert_include "include /etc/nginx/snippets/sogo.conf;"
}

# Idempotently add an include line inside the TLS server block of the vhost.
nginx_insert_include() {
  local include_line="$1"
  local vhost=""

  for candidate in \
      "/etc/nginx/sites-available/${MAIL_HOSTNAME}" \
      "/etc/nginx/sites-available/modoboa" \
      "/etc/nginx/conf.d/${MAIL_HOSTNAME}.conf"; do
    [[ -f "$candidate" ]] && { vhost="$candidate"; break; }
  done

  if [[ -z "$vhost" ]]; then
    vhost="$(grep -rl "server_name .*${MAIL_HOSTNAME}" /etc/nginx/sites-available /etc/nginx/conf.d 2>/dev/null | head -1 || true)"
  fi

  if [[ -z "$vhost" ]]; then
    warn "Could not find the nginx vhost for $MAIL_HOSTNAME."
    warn "Add this line inside its 'listen 443' server block yourself:"
    warn "  $include_line"
    return 0
  fi

  info "Patching $vhost"

  if $DRY_RUN; then
    printf '           %s[dry-run]%s insert "%s" into %s\n' "$C_YELLOW" "$C_RESET" "$include_line" "$vhost"
    return 0
  fi

  if grep -qF "$include_line" "$vhost"; then
    ok "nginx already includes $(basename "${include_line##*/}")"
    return 0
  fi

  cp -a "$vhost" "${vhost}.mailstack-bak.$(date +%Y%m%d%H%M%S)"

  awk -v inc="    $include_line" '
    !inserted && /listen[[:space:]]+.*443/ { print; print inc; inserted=1; next }
    { print }
    END { if (!inserted) exit 9 }
  ' "$vhost" >"${vhost}.new" || {
    # no 443 block yet (self-signed / pre-certbot) — fall back to server_name
    awk -v inc="    $include_line" '
      !inserted && /^[[:space:]]*server_name/ { print; print inc; inserted=1; next }
      { print }
      END { if (!inserted) exit 9 }
    ' "$vhost" >"${vhost}.new" || {
      rm -f "${vhost}.new"
      warn "Could not patch $vhost automatically. Add manually inside the server block:"
      warn "  $include_line"
      return 0
    }
  }

  mv "${vhost}.new" "$vhost"

  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    ok "nginx reloaded"
  else
    err "nginx config test FAILED — restoring the backup"
    local newest
    newest="$(ls -1t "${vhost}".mailstack-bak.* 2>/dev/null | head -1)"
    [[ -n "$newest" ]] && cp -a "$newest" "$vhost"
    nginx -t || true
    warn "Add this line manually inside the server block of $vhost:"
    warn "  $include_line"
  fi
}

# ============================================================================
#  PHASE 6 — Roundcube (optional second webmail at /webmail)
# ============================================================================
phase_roundcube() {
  [[ "$INSTALL_ROUNDCUBE" == "yes" ]] || { info "Roundcube disabled in config, skipping"; return 0; }
  banner "ROUNDCUBE"

  info "Installing PHP-FPM and Roundcube from the distro repository"
  run_sh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      php-fpm php-pgsql php-intl php-mbstring php-zip php-curl php-xml php-gd || true"

  # preseed dbconfig-common so the install is non-interactive
  if ! $DRY_RUN; then
    debconf-set-selections <<EOF
roundcube-core roundcube/dbconfig-install boolean true
roundcube-core roundcube/database-type select pgsql
roundcube-core roundcube/db/dbname string roundcube
roundcube-core roundcube/db/app-user string roundcube
roundcube-core roundcube/pgsql/app-pass password $ROUNDCUBE_DB_PASSWORD
roundcube-core roundcube/app-password-confirm password $ROUNDCUBE_DB_PASSWORD
roundcube-core roundcube/pgsql/authmethod-user select password
roundcube-core roundcube/pgsql/admin-user string postgres
roundcube-core roundcube/pgsql/authmethod-admin select ident
roundcube-core roundcube/mysql/method select unix socket
EOF
  fi

  run_sh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq roundcube roundcube-core roundcube-plugins" \
    || { warn "Roundcube package install failed — skipping (SOGo already provides webmail)"; return 0; }

  info "Configuring Roundcube against local Dovecot/Postfix"
  write_file /etc/roundcube/config.inc.php.d/90-mailstack.inc.php <<EOF
<?php
// added by mailstack bootstrap
\$config['imap_host']    = 'ssl://127.0.0.1:993';
\$config['smtp_host']    = 'tls://127.0.0.1:587';
\$config['smtp_user']    = '%u';
\$config['smtp_pass']    = '%p';
\$config['product_name'] = 'Webmail';
\$config['support_url']  = '';
\$config['des_key']      = '$(openssl rand -base64 24 | head -c 24)';
\$config['plugins']      = ['archive', 'zipdownload', 'managesieve', 'password'];
\$config['managesieve_host'] = '127.0.0.1';
\$config['managesieve_port'] = 4190;
\$config['imap_conn_options'] = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false]];
\$config['smtp_conn_options'] = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false]];
EOF

  # Some Roundcube builds read a single config.inc.php only.
  if ! $DRY_RUN && [[ -f /etc/roundcube/config.inc.php ]] \
     && ! grep -q 'mailstack' /etc/roundcube/config.inc.php; then
    if ! grep -q 'config.inc.php.d' /etc/roundcube/config.inc.php; then
      cat >>/etc/roundcube/config.inc.php <<'EOF'

// added by mailstack bootstrap
foreach (glob('/etc/roundcube/config.inc.php.d/*.inc.php') as $f) { include $f; }
EOF
    fi
  fi

  local fpm_sock
  fpm_sock="$(ls /run/php/php*-fpm.sock 2>/dev/null | head -1 || echo /run/php/php-fpm.sock)"
  info "PHP-FPM socket: $fpm_sock"

  write_file /etc/nginx/snippets/roundcube.conf <<EOF
# ---- Roundcube (added by mailstack bootstrap) ----
location ^~ /webmail {
    alias /usr/share/roundcube/;
    index index.php;

    location ~ ^/webmail/(.+\\.php)\$ {
        alias /usr/share/roundcube/\$1;
        fastcgi_pass unix:$fpm_sock;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME /usr/share/roundcube/\$1;
    }
    location ~ ^/webmail/(.+\\.(?:css|js|jpg|png|gif|svg|woff2?|ico))\$ {
        alias /usr/share/roundcube/\$1;
        expires 30d;
    }
    location ~ ^/webmail/(config|temp|logs)/ { deny all; }
}
EOF

  nginx_insert_include "include /etc/nginx/snippets/roundcube.conf;"
  run systemctl restart "php$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;' 2>/dev/null)-fpm" 2>/dev/null || \
    run_sh "systemctl restart 'php*-fpm' 2>/dev/null || true"

  ok "Roundcube available at https://$MAIL_HOSTNAME/webmail"
  mark_done roundcube
}

# ============================================================================
#  PHASE 7 — postfwd outbound rate limiting
# ============================================================================
phase_postfwd() {
  [[ "$INSTALL_POSTFWD" == "yes" ]] || { info "postfwd disabled in config, skipping"; return 0; }
  banner "OUTBOUND RATE LIMITS"

  run_sh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postfwd"

  write_file /etc/postfwd.cf <<EOF
# ============================================================================
#  postfwd — per-mailbox outbound limits
#
#  This is your primary anti-abuse control. One compromised mailbox sending
#  50k spam messages will blacklist the whole server's IP; these caps make
#  that impossible. Raise limits per customer only on request.
#
#  Reload after edits:  systemctl reload postfwd
# ============================================================================

# Only authenticated senders (i.e. your own customers) are rate limited.
# Inbound mail from the internet has no sasl_username and is untouched.

id=HOURLY_MSGS
  sasl_username=~/^(.+)\$
  action=rate(sasl_username/$OUTBOUND_MSGS_PER_HOUR/3600/451 4.7.1 Hourly sending limit reached, try again later)

id=DAILY_MSGS
  sasl_username=~/^(.+)\$
  action=rate(sasl_username/$OUTBOUND_MSGS_PER_DAY/86400/451 4.7.1 Daily sending limit reached, contact support)

id=DAILY_RCPTS
  sasl_username=~/^(.+)\$
  action=rcpt(sasl_username/$OUTBOUND_RCPT_PER_DAY/86400/451 4.7.1 Daily recipient limit reached, contact support)

# Anything not matched above passes through.
id=DEFAULT
  action=DUNNO
EOF

  if [[ -f /etc/default/postfwd ]] && ! $DRY_RUN; then
    sed -i 's/^STARTUP=.*/STARTUP=1/' /etc/default/postfwd
    grep -q '^STARTUP=' /etc/default/postfwd || echo 'STARTUP=1' >>/etc/default/postfwd
  fi

  run systemctl enable postfwd
  run systemctl restart postfwd

  if ! $DRY_RUN; then
    sleep 2
    if ss -tlnH 'sport = :10040' | grep -q .; then
      ok "postfwd listening on 127.0.0.1:10040"
    else
      warn "postfwd is not listening on 10040 — check: journalctl -u postfwd -n 50"
      warn "Skipping the Postfix hook so mail delivery is not broken."
      mark_done postfwd
      return 0
    fi
  fi

  # Hook into Postfix. In Postfix >= 2.10 relay control lives in
  # smtpd_relay_restrictions, so adding only a policy service to
  # smtpd_recipient_restrictions is safe and cannot open an open relay.
  info "Hooking postfwd into Postfix"
  if $DRY_RUN; then
    printf '           %s[dry-run]%s postconf smtpd_recipient_restrictions += check_policy_service inet:127.0.0.1:10040\n' \
      "$C_YELLOW" "$C_RESET"
  else
    local current new
    current="$(postconf -h smtpd_recipient_restrictions 2>/dev/null | tr -d '\n' || echo "")"
    if [[ "$current" == *"127.0.0.1:10040"* ]]; then
      ok "Postfix already calls postfwd"
    else
      if [[ -z "$current" ]]; then
        new="check_policy_service inet:127.0.0.1:10040"
      else
        new="${current}, check_policy_service inet:127.0.0.1:10040"
      fi
      cp -a /etc/postfix/main.cf "/etc/postfix/main.cf.mailstack-bak.$(date +%Y%m%d%H%M%S)"
      postconf -e "smtpd_recipient_restrictions=$new"
      if postfix check 2>&1 | grep -qi error; then
        err "postfix check reported errors — reverting"
        postconf -e "smtpd_recipient_restrictions=$current"
      else
        systemctl reload postfix
        ok "Rate limiting active: ${OUTBOUND_MSGS_PER_HOUR}/hour, ${OUTBOUND_MSGS_PER_DAY}/day per mailbox"
      fi
    fi
  fi

  mark_done postfwd
}

# ============================================================================
#  PHASE 8 — firewall + fail2ban
# ============================================================================
phase_firewall() {
  [[ "$INSTALL_FIREWALL" == "yes" ]] || { info "Firewall disabled in config, skipping"; return 0; }
  banner "FIREWALL & FAIL2BAN"

  run_sh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw fail2ban"

  info "Configuring ufw (SSH port $SSH_PORT stays open)"
  run ufw --force reset
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw allow "$SSH_PORT/tcp"    comment 'ssh'
  run ufw allow 25/tcp             comment 'smtp'
  run ufw allow 80/tcp             comment 'http / acme'
  run ufw allow 443/tcp            comment 'https'
  run ufw allow 465/tcp            comment 'smtps'
  run ufw allow 587/tcp            comment 'submission'
  run ufw allow 993/tcp            comment 'imaps'
  run ufw allow 4190/tcp           comment 'managesieve'
  run_sh "ufw --force enable"
  ok "ufw enabled"

  write_file /etc/fail2ban/jail.d/mailstack.local <<EOF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
port    = $SSH_PORT

[postfix]
enabled = true

[postfix-sasl]
enabled = true

[dovecot]
enabled = true

[nginx-http-auth]
enabled = true
EOF

  run systemctl enable fail2ban
  run systemctl restart fail2ban
  ok "fail2ban active"

  mark_done firewall
}

# ============================================================================
#  PHASE 9 — ops tooling: healthcheck, DNSBL watch, backups
# ============================================================================
phase_ops() {
  [[ "$INSTALL_OPS_TOOLS" == "yes" ]] || { info "Ops tools disabled in config, skipping"; return 0; }
  banner "OPS TOOLING"

  # ---------------- healthcheck ----------------
  write_file /usr/local/sbin/mailstack-healthcheck 0755 <<'EOF'
#!/usr/bin/env bash
# mailstack healthcheck — exits non-zero if anything is wrong.
# Run by cron; also useful by hand:  mailstack-healthcheck
set -uo pipefail
FAIL=0
say() { printf '%s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*"; FAIL=1; }

for svc in postfix dovecot nginx postgresql rspamd; do
  systemctl is-active --quiet "$svc" || bad "service $svc is not running"
done
for svc in sogo memcached postfwd; do
  systemctl list-unit-files | grep -q "^${svc}.service" || continue
  systemctl is-active --quiet "$svc" || bad "service $svc is not running"
done

for port in 25 587 993 443; do
  ss -tlnH "sport = :$port" | grep -q . || bad "nothing listening on port $port"
done

QUEUE=$(find /var/spool/postfix/deferred -type f 2>/dev/null | wc -l)
say "deferred queue: $QUEUE"
[ "$QUEUE" -gt 500 ] && bad "deferred queue is large ($QUEUE) — delivery problem?"

USE=$(df --output=pcent / | tail -1 | tr -dc '0-9')
say "disk usage on /: ${USE}%"
[ "$USE" -gt 85 ] && bad "disk usage ${USE}%"

MEM=$(free | awk '/Mem:/{printf "%d", $3*100/$2}')
say "memory usage: ${MEM}%"

CERT=$(find /etc/letsencrypt/live -name fullchain.pem 2>/dev/null | head -1)
if [ -n "$CERT" ]; then
  END=$(date -d "$(openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)" +%s)
  DAYS=$(( (END - $(date +%s)) / 86400 ))
  say "TLS certificate expires in ${DAYS} days"
  [ "$DAYS" -lt 10 ] && bad "certificate expires in ${DAYS} days"
fi

[ "$FAIL" -eq 0 ] && say "ALL OK"
exit "$FAIL"
EOF

  # ---------------- DNSBL watch ----------------
  write_file /usr/local/sbin/mailstack-rbl-check 0755 <<EOF
#!/usr/bin/env bash
# Check this server's public IP against the DNSBLs that actually matter.
# A listing means mail is being rejected RIGHT NOW — treat it as an incident.
set -uo pipefail
IP="\$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null)"
[ -n "\$IP" ] || { echo "could not determine public IP"; exit 2; }
REV="\$(echo "\$IP" | awk -F. '{print \$4"."\$3"."\$2"."\$1}')"
LISTED=""
for BL in zen.spamhaus.org b.barracudacentral.org bl.spamcop.net \\
          dnsbl.sorbs.net psbl.surriel.com bl.mailspike.net; do
  if [ -n "\$(dig +short +time=3 +tries=1 "\$REV.\$BL" A 2>/dev/null)" ]; then
    LISTED="\$LISTED \$BL"
  fi
done
if [ -n "\$LISTED" ]; then
  MSG="ALERT: \$IP (\$(hostname -f)) is listed on:\$LISTED

Mail delivery is degraded. Check for a compromised mailbox:
  postqueue -p | tail -50
  grep 'sasl_username' /var/log/mail.log | awk '{print \\\$NF}' | sort | uniq -c | sort -rn | head
Then request delisting on each blocklist's site."
  echo "\$MSG"
  command -v mail >/dev/null && echo "\$MSG" | mail -s "[mailstack] IP blacklisted: \$IP" "$ADMIN_EMAIL" || true
  logger -t mailstack-rbl "\$IP listed on\$LISTED"
  exit 1
fi
echo "\$IP is not listed on any checked DNSBL"
EOF

  write_file /etc/cron.d/mailstack 0644 <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
MAILTO=$ADMIN_EMAIL

# healthcheck every 15 minutes (only mails you when something fails)
*/15 * * * * root /usr/local/sbin/mailstack-healthcheck >/dev/null || /usr/local/sbin/mailstack-healthcheck
# blacklist watch twice a day
17 */12 * * * root /usr/local/sbin/mailstack-rbl-check >/dev/null
EOF
  ok "healthcheck + DNSBL monitoring installed"

  # ---------------- backups ----------------
  run_sh "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq restic"

  write_file /usr/local/sbin/mailstack-backup 0755 <<'EOF'
#!/usr/bin/env bash
# mailstack backup — PostgreSQL dumps + maildirs + configs, via restic.
# Restore test:  restic snapshots  &&  restic restore latest --target /tmp/restore
set -Eeuo pipefail
[ -f /etc/mailstack/backup.env ] || { echo "no /etc/mailstack/backup.env — backups not configured"; exit 0; }
# shellcheck source=/dev/null
source /etc/mailstack/backup.env
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD:?}"
export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

DUMP=/var/backups/mailstack
mkdir -p "$DUMP"; chmod 700 "$DUMP"

for db in $(sudo -u postgres psql -tAc \
      "SELECT datname FROM pg_database WHERE datistemplate=false AND datname<>'postgres'"); do
  sudo -u postgres pg_dump -Fc "$db" >"$DUMP/${db}.dump"
done

restic snapshots >/dev/null 2>&1 || restic init

restic backup \
  "$DUMP" \
  /srv/vmail /var/vmail /home/vmail \
  /etc/postfix /etc/dovecot /etc/sogo /etc/nginx /etc/letsencrypt \
  /etc/rspamd /var/lib/rspamd/dkim /etc/postfwd.cf /etc/mailstack \
  --exclude-caches --tag mailstack 2>&1 | tail -5

restic forget --prune --tag mailstack \
  --keep-daily "${KEEP_DAILY:-7}" \
  --keep-weekly "${KEEP_WEEKLY:-4}" \
  --keep-monthly "${KEEP_MONTHLY:-6}" 2>&1 | tail -3

rm -f "$DUMP"/*.dump
echo "backup completed $(date -Is)"
EOF

  if [[ -n "$BACKUP_REPO" && -n "$BACKUP_PASSWORD" ]]; then
    write_file /etc/mailstack/backup.env 0600 <<EOF
RESTIC_REPOSITORY="$BACKUP_REPO"
RESTIC_PASSWORD="$BACKUP_PASSWORD"
AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"
KEEP_DAILY="$BACKUP_KEEP_DAILY"
KEEP_WEEKLY="$BACKUP_KEEP_WEEKLY"
KEEP_MONTHLY="$BACKUP_KEEP_MONTHLY"
EOF
    write_file /etc/cron.d/mailstack-backup 0644 <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
MAILTO=$ADMIN_EMAIL
30 2 * * * root /usr/local/sbin/mailstack-backup
EOF
    ok "Nightly restic backup configured → $BACKUP_REPO"
    warn "Backups are worthless until you have restored from them. Do a restore drill this week."
  else
    warn "BACKUP_REPO not set — restic installed but NO backups are running."
    warn "Configure /etc/mailstack/backup.env and add a cron entry. Do not sell mailboxes without backups."
  fi

  mark_done ops
}

# ============================================================================
#  PHASE 10 — verify + print DNS records
# ============================================================================
phase_verify() {
  banner "VERIFICATION"

  if $DRY_RUN; then
    info "[dry-run] would verify services, ports and TLS, then print DNS records"
    return 0
  fi

  local svc_fail=0
  for svc in postfix dovecot nginx postgresql rspamd; do
    if systemctl is-active --quiet "$svc"; then ok "$svc running"
    else err "$svc NOT running"; svc_fail=1; fi
  done
  if [[ "$INSTALL_SOGO" == "yes" ]]; then
    if systemctl is-active --quiet sogo; then ok "sogo running"
    else err "sogo NOT running — journalctl -u sogo -n 50"; svc_fail=1; fi
  fi

  for port in 25 587 993 443; do
    if ss -tlnH "sport = :$port" | grep -q .; then ok "listening on $port"
    else err "nothing on port $port"; svc_fail=1; fi
  done

  # SMTP banner
  if timeout 8 bash -c "exec 3<>/dev/tcp/127.0.0.1/25; head -1 <&3" 2>/dev/null | grep -q 220; then
    ok "SMTP banner OK"
  else
    warn "No SMTP banner on localhost:25"
  fi

  # IMAP TLS
  if echo QUIT | timeout 10 openssl s_client -connect 127.0.0.1:993 -quiet 2>/dev/null | grep -q OK; then
    ok "IMAPS responding"
  else
    warn "IMAPS did not respond as expected"
  fi

  # ActiveSync endpoint should demand auth (401), not 404
  if [[ "$INSTALL_SOGO" == "yes" ]]; then
    local as_code
    as_code="$(curl -s -o /dev/null -w '%{http_code}' -k --max-time 10 \
      "https://127.0.0.1/Microsoft-Server-ActiveSync" -H "Host: $MAIL_HOSTNAME" || echo 000)"
    case "$as_code" in
      401|403) ok "ActiveSync endpoint reachable (HTTP $as_code — auth required, correct)" ;;
      404)     err "ActiveSync returns 404 — the nginx snippet is not included. Check /etc/nginx/snippets/sogo.conf" ;;
      *)       warn "ActiveSync returned HTTP $as_code — verify by hand" ;;
    esac
  fi

  generate_dns_file

  # ---- summary ----
  local pub_ip
  pub_ip="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo '<unknown>')"

  cat <<EOF

${C_BOLD}${C_GREEN}════════════════════════════════════════════════════════════════════${C_RESET}
${C_BOLD}  mailstack is installed${C_RESET}
${C_BOLD}${C_GREEN}════════════════════════════════════════════════════════════════════${C_RESET}

  Admin panel     https://$MAIL_HOSTNAME/
                  default login: admin / password  ← CHANGE THIS NOW
EOF
  [[ "$INSTALL_SOGO" == "yes" ]] && echo "  Webmail+calendar https://$MAIL_HOSTNAME/SOGo/"
  [[ "$INSTALL_ROUNDCUBE" == "yes" ]] && echo "  Webmail (light)  https://$MAIL_HOSTNAME/webmail"
  cat <<EOF

  Server IP       $pub_ip
  Credentials     $CRED_FILE       (mode 0600)
  DNS records     $DNS_FILE
  Install log     $LOG_FILE
  Healthcheck     mailstack-healthcheck
  Blacklist check mailstack-rbl-check

${C_BOLD}NEXT STEPS — in this order${C_RESET}

  1. Change the Modoboa admin password. Enable 2FA on it.
  2. Confirm  Parameters → General → Password scheme = sha512crypt
     BEFORE creating any mailbox (SOGo logins depend on it).
  3. Add your domain in Modoboa, enable DKIM for it, then publish every
     record listed in $DNS_FILE.
  4. Create one test mailbox. Verify:
       - webmail login
       - send to a Gmail address, check it lands in Inbox not Spam
       - receive from Gmail
       - add the account to Outlook and to a phone via ActiveSync
  5. Run through https://www.mail-tester.com — aim for 10/10 before selling.
  6. Enrol the IP in Google Postmaster Tools and Microsoft SNDS/JMRP.
  7. Warm the IP up: a few dozen mails/day for the first week, then ramp.
     A brand new IP that suddenly sends thousands gets blocked.
  8. Configure backups and DO A RESTORE DRILL.

EOF

  if ((${#WARNINGS[@]})); then
    printf '%s%s  %d WARNING(S) — read these:%s\n' "$C_BOLD" "$C_YELLOW" "${#WARNINGS[@]}" "$C_RESET"
    local w; for w in "${WARNINGS[@]}"; do printf '   %s•%s %s\n' "$C_YELLOW" "$C_RESET" "$w"; done
    echo
  fi

  (( svc_fail == 0 )) || warn "Some services are down — the install is NOT complete. Check the errors above."
  mark_done verify
}

generate_dns_file() {
  local pub_ip dkim_txt
  pub_ip="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo 'YOUR.SERVER.IP')"

  dkim_txt="$(find /var/lib/rspamd/dkim /var/lib/dkim /etc/rspamd -name '*.pub' 2>/dev/null | head -1)"
  local dkim_note="Generate the DKIM key in Modoboa: Domains → $PRIMARY_DOMAIN → edit → enable DKIM,
    then copy the TXT record shown there."
  if [[ -n "$dkim_txt" && -r "$dkim_txt" ]]; then
    dkim_note="Public key found at $dkim_txt:
    $(tr -d '\n' <"$dkim_txt")"
  fi

  write_file "$DNS_FILE" 0644 <<EOF
================================================================================
  DNS records for $PRIMARY_DOMAIN   (mail host: $MAIL_HOSTNAME, IP: $pub_ip)
  Generated $(date -Is) by mailstack bootstrap
================================================================================

REQUIRED — mail does not work without these
--------------------------------------------------------------------------------
$MAIL_HOSTNAME.        IN A      $pub_ip
$PRIMARY_DOMAIN.       IN MX  10 $MAIL_HOSTNAME.

SPF — only this server may send for the domain
  $PRIMARY_DOMAIN.     IN TXT    "v=spf1 mx -all"
  ("-all" is a hard fail. Use "~all" only while testing.)

DKIM — per domain, generated by Modoboa
  $dkim_note
  Record name is usually:  <selector>._domainkey.$PRIMARY_DOMAIN

DMARC — start at p=none, read reports for 2–4 weeks, then move to p=reject
  _dmarc.$PRIMARY_DOMAIN.  IN TXT  "v=DMARC1; p=none; rua=mailto:dmarc@$PRIMARY_DOMAIN; ruf=mailto:dmarc@$PRIMARY_DOMAIN; fo=1; pct=100"
  Then, once reports are clean:
  _dmarc.$PRIMARY_DOMAIN.  IN TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@$PRIMARY_DOMAIN; fo=1; pct=100"

REVERSE DNS — set by your VPS provider, not by this server
--------------------------------------------------------------------------------
  PTR for $pub_ip  must be  $MAIL_HOSTNAME
  Without it, Gmail and Outlook will reject or spam-folder your mail.

CLIENT AUTOCONFIGURATION — makes Outlook/phones set themselves up
--------------------------------------------------------------------------------
  autodiscover.$PRIMARY_DOMAIN.  IN CNAME  $MAIL_HOSTNAME.
  autoconfig.$PRIMARY_DOMAIN.    IN CNAME  $MAIL_HOSTNAME.
  _autodiscover._tcp.$PRIMARY_DOMAIN.  IN SRV  0 0 443 $MAIL_HOSTNAME.
  _imaps._tcp.$PRIMARY_DOMAIN.         IN SRV  0 1 993 $MAIL_HOSTNAME.
  _submission._tcp.$PRIMARY_DOMAIN.    IN SRV  0 1 587 $MAIL_HOSTNAME.

RECOMMENDED — transport security signalling
--------------------------------------------------------------------------------
  _mta-sts.$PRIMARY_DOMAIN.   IN TXT  "v=STSv1; id=$(date +%Y%m%d)000000;"
  _smtp._tls.$PRIMARY_DOMAIN. IN TXT  "v=TLSRPTv1; rua=mailto:tlsrpt@$PRIMARY_DOMAIN"
  MTA-STS also needs https://mta-sts.$PRIMARY_DOMAIN/.well-known/mta-sts.txt
  serving:
      version: STSv1
      mode: enforce
      mx: $MAIL_HOSTNAME
      max_age: 604800

CLIENT SETTINGS to give your customers
--------------------------------------------------------------------------------
  IMAP    $MAIL_HOSTNAME   port 993   SSL/TLS
  SMTP    $MAIL_HOSTNAME   port 587   STARTTLS  (or 465 with SSL/TLS)
  Sieve   $MAIL_HOSTNAME   port 4190
  Username is the full email address.
  ActiveSync (Outlook / iPhone / Android): server $MAIL_HOSTNAME

VERIFY EVERYTHING
--------------------------------------------------------------------------------
  https://www.mail-tester.com          send a mail, aim for 10/10
  https://mxtoolbox.com/SuperTool.aspx  check MX, SPF, DKIM, DMARC, blacklists
  https://internet.nl/mail/             thorough standards check
================================================================================
EOF
  ok "DNS records written to $DNS_FILE"
}

# ============================================================================
#  main
# ============================================================================
main() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  : >>"$LOG_FILE" 2>/dev/null || LOG_FILE=/dev/null

  cat <<EOF

${C_BOLD}mailstack bootstrap${C_RESET}  —  Modoboa + Postfix + Dovecot + Rspamd$([[ "$INSTALL_SOGO" == yes ]] && echo " + SOGo")$([[ "$INSTALL_ROUNDCUBE" == yes ]] && echo " + Roundcube")
  host    $MAIL_HOSTNAME
  domain  $PRIMARY_DOMAIN
  config  $CONFIG_FILE
  mode    $($DRY_RUN && echo "DRY RUN (nothing will change)" || echo "LIVE")
EOF

  if ! $DRY_RUN && [[ -z "$ONLY_PHASE" ]] && ! phase_done modoboa; then
    warn "This installs and reconfigures a mail server on this machine."
    warn "Run it on a FRESH VPS, not on a box with other services."
    confirm "Proceed?" || die "Aborted."
  fi

  load_or_generate_credentials

  local p
  for p in "${PHASES[@]}"; do
    if should_run "$p"; then
      "phase_$p"
    elif [[ -n "$ONLY_PHASE" ]]; then
      : # --only was given; silently skip everything else
    else
      info "Phase '$p' already done — skipping (use --force to re-run)"
    fi
  done

  if $DRY_RUN; then
    echo
    ok "Dry run complete. Nothing was changed. Re-run without --dry-run to install."
  fi
}

# tee everything to the log
if [[ "${MAILSTACK_LOGGING:-}" != "1" ]] && [[ -w "$(dirname "$LOG_FILE")" ]]; then
  export MAILSTACK_LOGGING=1
  exec > >(tee -a "$LOG_FILE") 2>&1
fi

main "$@"
