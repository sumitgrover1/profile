# Turning `quarantine` into a real hold queue

The DLP service can return `quarantine`, meaning *accept the message but do
not deliver it until a human reviews it*. Rspamd cannot hold a message, but
Postfix already has a hold queue — so use it.

## 1. Add the header check

`/etc/postfix/dlp_header_checks`:

```
/^X-DLP-Action:\s*quarantine/     HOLD DLP quarantine, see X-DLP-Incident
```

Build and wire it:

```bash
postconf -e "header_checks = regexp:/etc/postfix/dlp_header_checks"
# if header_checks is already set, append rather than replace:
#   postconf -h header_checks
systemctl reload postfix
```

> Rspamd adds the header before the queue, and `header_checks` runs during
> `cleanup`, so the HOLD applies to the same message. Order matters: this only
> works because the DLP plugin is a *prefilter*.

## 2. Review the hold queue

```bash
mailq | grep -i hold                  # what's held
postcat -q <queue_id> | head -40      # headers, including X-DLP-Incident
```

Cross-reference the incident id against the audit log:

```bash
grep '<incident_id>' /var/log/mailstack-dlp/audit.jsonl | python3 -m json.tool
```

## 3. Release or delete

```bash
postsuper -H <queue_id>      # release: deliver it
postsuper -d <queue_id>      # delete: never delivers
```

Log every release decision with who approved it and why. For an RBI or PCI
audit, "the message was held" is half the answer; "and here is who released
it, when, and on what grounds" is the other half — and it is the half that is
usually missing.

## 4. What to tell the sender

Nothing automatic. A bounce that says "your message contained card data" tells
an attacker exactly what the rules are. The `250 ... held for review` response
the service returns is deliberately vague; the admin contacts the sender out
of band.
