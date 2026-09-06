# mailstack — open-source multi-tenant mail platform bootstrap

One script that turns a fresh VPS into a working, multi-tenant email hosting
platform. Every component is open source; there are no licence fees.

| Layer | Component | Licence |
|---|---|---|
| Tenants, domains, mailboxes, quotas, DKIM, DMARC reports | **Modoboa** | ISC |
| SMTP | **Postfix** | IPL / EPL-2.0 |
| IMAP + quotas | **Dovecot CE** | MIT / LGPL-2.1 |
| Spam filtering | **Rspamd** | Apache-2.0 |
| Antivirus | **ClamAV** | GPL-2.0 |
| Webmail + calendar + contacts + **ActiveSync** | **SOGo** | GPL-2.0 |
| Lighter mail-only webmail (optional) | **Roundcube** | GPL-3.0 |
| Per-mailbox outbound rate limiting | **postfwd** | GPL |
| Firewall / intrusion blocking | **ufw**, **fail2ban** | GPL |
| Backups | **restic** | BSD-2 |

## Quick start

```bash
git clone <this-repo> && cd mail-platform
cp mailstack.conf.example mailstack.conf
nano mailstack.conf                 # set MAIL_HOSTNAME, PRIMARY_DOMAIN, ADMIN_EMAIL

sudo ./bootstrap.sh --dry-run       # shows every action, changes nothing
sudo ./bootstrap.sh                 # install (15–30 min)
```

After it finishes, read `/root/mailstack-dns-records.txt` — it contains every
DNS record you need to publish, generated for your domain.

## Before you run it

Get these right first; the script checks them and refuses to pretend they
don't matter.

1. **A fresh VPS.** Ubuntu 24.04 / 22.04 or Debian 12. 4 GB RAM minimum
   (2 GB will OOM once ClamAV and Rspamd are both resident), 40 GB+ disk.
   Do not run this on a box that already serves other things.
2. **An A record** for your `MAIL_HOSTNAME` pointing at the server's public
   IPv4, already propagated. Let's Encrypt fails without it.
3. **A PTR (reverse DNS) record** for the server's IP set to that same
   hostname. Only your VPS provider can set this. Without it Gmail and
   Outlook will reject or spam-folder everything you send.
4. **Outbound port 25 open.** AWS, GCP, Azure, DigitalOcean and Oracle block
   it by default. Confirm with your provider *before* building anything —
   with port 25 blocked you cannot deliver a single message. Hetzner and OVH
   open it on request; ask an Indian DC in writing before signing.

## Flags

```
--dry-run           print every action, change nothing
--yes               skip confirmation prompts (for unattended runs)
--force             re-run phases already marked complete
--only PHASE        run one phase: preflight system modoboa pwscheme
                    sogo roundcube postfwd firewall ops verify
--skip-preflight    skip DNS/PTR/port-25 validation (not recommended)
--config FILE       config file (default ./mailstack.conf)
```

The script is **idempotent**. Completed phases are recorded in
`/var/lib/mailstack/state` and skipped on re-runs, so if it fails halfway you
fix the cause and run it again. Every file it replaces is backed up next to
the original as `*.mailstack-bak.<timestamp>`.

## What the phases do

| Phase | Action |
|---|---|
| `preflight` | Root/OS/RAM/disk checks, sets the hostname, verifies A record, PTR, **outbound port 25**, free ports, MX |
| `system` | Timezone, base packages, 2 GB swap, unattended *security* upgrades only |
| `modoboa` | Clones `modoboa-installer`, writes `installer.cfg` (Rspamd on, amavis/SpamAssassin off, Radicale off when SOGo is used), runs it — this brings Postfix, Dovecot, nginx, PostgreSQL, certbot |
| `pwscheme` | Forces Modoboa's password scheme to `sha512crypt` and verifies the value round-trips — see the warning below |
| `sogo` | Installs SOGo, creates its database, builds the `sogo_users` SQL view over Modoboa's tables, writes `sogo.conf`, wires nginx including the 1-hour ActiveSync proxy timeouts |
| `roundcube` | Optional second webmail at `/webmail` on PHP-FPM |
| `postfwd` | Per-mailbox outbound rate limits, hooked into Postfix |
| `firewall` | ufw ruleset + fail2ban jails for sshd, Postfix, Postfix-SASL, Dovecot, nginx |
| `ops` | `mailstack-healthcheck` and `mailstack-rbl-check` on cron, restic backup script |
| `verify` | Checks services, ports, SMTP banner, IMAPS, the ActiveSync endpoint, then writes the DNS file and a next-steps summary |

## ⚠️ The password-scheme trap

SOGo authenticates directly against Modoboa's user table and only understands
classic `crypt` hashes. If Modoboa is left on a modern scheme (argon2,
pbkdf2), **every SOGo login fails**.

The script sets `sha512crypt` before any mailbox exists. Confirm it yourself
in the UI — *Parameters → General → Password scheme* — before creating users.
Changing it later invalidates every existing password.

## How SOGo sees Modoboa's users

There is no connector; SOGo reads a view. Modoboa stores the local part in
`admin_mailbox.address`, the domain in `admin_domain.name`, and prefixes the
hash with `{SCHEME}`, which SOGo must not see. The view stitches those
together and strips the prefix:

```
c_uid / c_name / mail   →  mb.address || '@' || d.name
c_password              →  everything after the '}' in core_user.password
c_cn                    →  "First Last", falling back to the email address
WHERE                      core_user.is_active = true   (disabled users cannot log in)
```

This has been tested against a mock Modoboa schema: prefixed hashes are
stripped, unprefixed hashes pass through untouched, blank names fall back to
the address, and inactive users are excluded. If your Modoboa version changed
these table names, inspect and adjust:

```bash
sudo -u postgres psql -d modoboa -c '\d admin_mailbox'
sudo -u postgres psql -d modoboa -c 'SELECT count(*) FROM sogo_users'
```

## After install — do these in order

1. **Change the Modoboa admin password** (default `admin` / `password`) and
   enable 2FA on it.
2. Confirm the password scheme is `sha512crypt`.
3. Add your domain in Modoboa, enable DKIM for it, publish everything in
   `/root/mailstack-dns-records.txt`.
4. Create one test mailbox and verify all four paths: webmail login, send to
   Gmail (**check it lands in Inbox, not Spam**), receive from Gmail, and add
   the account to real Outlook and a real phone over ActiveSync.
5. Score yourself on <https://www.mail-tester.com> — get to 10/10 before you
   sell anything.
6. Enrol the IP in **Google Postmaster Tools** and **Microsoft SNDS/JMRP**.
   Outlook delivery is materially worse without JMRP.
7. **Warm the IP up.** A brand-new IP that suddenly sends thousands of
   messages gets blocked. Dozens per day in week one, then ramp.
8. Configure `BACKUP_REPO` and **do a restore drill**. Replication is not a
   backup and an untested backup is not a backup.

## Operating it

```bash
mailstack-healthcheck        # services, ports, queue depth, disk, cert expiry
mailstack-rbl-check          # is our IP on Spamhaus/Barracuda/SpamCop/…?
mailstack-backup             # manual backup run

postqueue -p                 # mail queue
tail -f /var/log/mail.log
journalctl -u sogo -f
systemctl reload postfwd     # after editing /etc/postfwd.cf
```

`mailstack-healthcheck` runs every 15 minutes and only emails you when
something fails. `mailstack-rbl-check` runs twice a day — **treat a listing as
an incident, not a notification.** It usually means a customer mailbox has
been compromised and is sending spam right now.

## Raising a customer's sending limit

Defaults are deliberately strict (100/hour, 500/day per mailbox). A real
business user never hits them; a compromised account hits them immediately,
which is the point. To exempt one mailbox, add a rule *above* the generic ones
in `/etc/postfwd.cf`:

```
id=VIP_BULK
  sasl_username==newsletter@customer.com
  action=rate(sasl_username/2000/86400/451 4.7.1 limit reached)
```

## Licence position (if you are selling this as a service)

Not legal advice — get a lawyer to confirm for your entity — but the shape of
it is:

- **Modoboa is ISC**: permissive. Your panel, glue code and modifications stay
  entirely yours.
- **Roundcube (GPL-3) and SOGo (GPL-2)**: GPL obligations trigger on
  *distribution*, not on running a network service. Selling access to a hosted
  instance does **not** oblige you to publish your modifications.
- **Shipping an on-prem appliance or VM to a customer is distribution.** Then
  you must provide the source of your modifications to those components. If
  on-prem enterprise deals are in your plan, decide this now, not later.
- Never strip copyright headers from source files. Rebranding the UI is fine;
  removing the notices in the code is not.
- **Trademarks are separate from licences.** Don't put "Roundcube" or "SOGo"
  in your product name.
- Everything else here (Postfix, Dovecot, Rspamd, postfwd, restic) is
  permissive or GPL with no SaaS obligation.

## Known limitations — read before selling mailboxes

This script builds a solid **single-box** platform: correct for your first
customers, a staging environment, or proving the product. It is deliberately
not the final production topology.

1. **One server, no HA.** Inbound filtering, mailbox storage, outbound
   delivery and webmail all share one machine and one IP. In production, split
   them — the outbound host in particular must be separate so that a
   spamming customer cannot poison the reputation of everything else.
2. **No probation IP pool.** The single most valuable thing to build next:
   route new signups through a separate outbound IP pool for their first 30
   days, so one bad customer cannot blacklist your paying ones.
3. **No compromised-account detection.** Rate limits cap the damage but don't
   detect it. Add alerting on volume spikes, logins from many IPs, and new
   geographies, with automatic suspension of sending.
4. **No billing or self-serve signup.** Add FOSSBilling, Lago or your own
   panel on top of Modoboa's REST API.
5. **No migration wizard.** `doveadm backup -R imapc:` does the work; the
   self-serve UI around it is what actually wins deals against Google/Zoho.
6. **MTA-STS policy file isn't served.** The DNS records are generated for
   you; hosting `https://mta-sts.<domain>/.well-known/mta-sts.txt` needs its
   own vhost and certificate.
7. **The Modoboa installer's `installer.cfg` is rewritten with configparser**,
   which drops that file's comments. Harmless, but don't be surprised.

None of these is a software problem, and that's the real lesson: the platform
is the easy half. IP reputation, abuse handling, support and backups are what
make or break an email hosting business.

## Troubleshooting

**Modoboa installer failed** — its own log lives under
`/opt/modoboa-installer`. Read it, fix the cause, then
`sudo ./bootstrap.sh` (finished phases are skipped).

**SOGo package not found** — the repo details in `mailstack.conf` may be
stale. Check <https://www.sogo.nu/support.html#/downloads>, update
`SOGO_REPO_URL` / `SOGO_REPO_KEY_URL` / `SOGO_REPO_SUITE`, then
`sudo ./bootstrap.sh --only sogo`. The script falls back to your distro's
`sogo` package (older, but functional) and tells you when it does.

**SOGo loads but no one can log in** — the password scheme. Check what a hash
looks like:
```bash
sudo -u postgres psql -d modoboa -c "SELECT c_uid, left(c_password, 4) FROM sogo_users LIMIT 3"
```
`$6$` is correct. Anything else means the scheme is wrong and those users need
their passwords reset after you fix it.

**ActiveSync returns 404** — the nginx snippet wasn't included. Confirm
`include /etc/nginx/snippets/sogo.conf;` sits inside the `listen 443` server
block of the vhost for your hostname, then `nginx -t && systemctl reload nginx`.

**Phones sync slowly / drop off** — an ActiveSync timeout mismatch. nginx's
`proxy_read_timeout` for `/Microsoft-Server-ActiveSync` must stay *above*
`SOGoMaximumPingInterval` (3600 vs 3540 here). Don't lower one without the
other.

**Mail sends but lands in Spam** — almost always DNS or reputation, not the
server. In order: PTR record, SPF, DKIM signing actually enabled on the
domain, DMARC published, then IP warmup. Run it through mail-tester.com and
fix what it reports.
