# mailstack DLP — outbound email data-loss prevention

Multi-tenant DLP for the mailstack platform. Inspects every authenticated
outbound message before it leaves the queue, scores what it finds against the
tenant's policy, and tags, holds or blocks it.

Built for the Indian regulated market: Aadhaar (Verhoeff), income-tax PAN,
GSTIN, IFSC, bank accounts, UPI, alongside payment cards (Luhn + issuer
ranges), IBAN, and credential leaks.

**This is the product you sell.** A mailbox is a ₹300 commodity; "we can show
an auditor that card and KYC data cannot leave this company by email, and here
is the seven-year audit trail" is a different price bracket.

```
Submission (587) ──► Postfix ──► Rspamd milter ──► dlp.lua
                                                     │  POST /inspect (loopback)
                                                     ▼
                                        ┌──────────────────────────┐
                                        │ mailstack-dlp service    │
                                        │  MIME + attachment text  │
                                        │  detectors + checksums   │
                                        │  per-tenant policy score │
                                        └────────────┬─────────────┘
                                                     ▼
   block ──► 550 at SMTP time        quarantine ──► X-DLP-Action header
   tag   ──► X-DLP-* headers                        └─► Postfix HOLD queue
   defer ──► 451, retry                                 postsuper -H to release
```

## Install

Run on a server that already has the mailstack bootstrap (Modoboa + Postfix +
Rspamd):

```bash
cd mail-platform/dlp
sudo ./install.sh --dry-run     # show every action
sudo ./install.sh               # install, in MONITOR MODE
```

Verify:

```bash
systemctl status mailstack-dlp
curl -s localhost:11333/healthz
printf 'Subject: t\n\ncard 4111111111111111 cvv 737\n' | sendmail you@elsewhere.com
tail -f /var/log/mailstack-dlp/audit.jsonl
```

Tests (no dependencies, no running service needed):

```bash
python3 -m unittest discover -s tests -t . -v      # 66 tests
```

## Monitor first. This is not optional.

The installer puts every tenant in `mode: monitor`: messages are inspected,
scored, stamped with `X-DLP-*` headers and written to the audit log, and then
**delivered normally**. Nothing is held or blocked.

Leave it there for **2–4 weeks per tenant**. Read the audit log. Find the false
positives in *that tenant's real mail* — every company has some legitimate
pattern that trips a rule. Tune their policy. Then move to
`quarantine`-level enforcement, and only later to blocking.

A DLP rollout that blocks real business mail in week one is a DLP rollout the
customer switches off in week two, and you don't get a second attempt.

## Detection: three layers, all necessary

| Layer | What it does |
|---|---|
| **1. Regex** | Cheap candidate extraction |
| **2. Checksum / structure** | Luhn, Verhoeff, GSTIN mod-36, IBAN mod-97, PAN holder-type, IFSC shape |
| **3. Context** | Supporting keywords near the match |

Layer 3 is where most DLP products fall over, so here is the measurement that
justifies it. The Aadhaar Verhoeff check digit only removes 9 candidates in 10,
and UIDAI's "never starts with 0 or 1" rule removes 2 in 10 — so **roughly 8%
of random 12-digit numbers look like a valid Aadhaar number**. In a mailbox
full of invoice numbers, order ids and reference numbers that is unusable.

`tests/test_dlp.py::FalsePositiveFloorTests` asserts that 8% figure. It exists
so that whoever later wonders "why does Aadhaar need a keyword nearby?" gets
the answer from a failing test rather than from an angry customer.

Consequently:

- **Aadhaar requires** a nearby keyword (`aadhaar`, `uid`, `kyc`, `आधार`, …).
  No keyword, no finding.
- **Payment cards require** a recognised issuer prefix as well as Luhn.
  `9999999999999995` passes Luhn but is not a card.
- **Bank account numbers** have no checksum at all, so the keyword *is* the
  detection (`A/c No.`, `account number`).
- Everything else scores lower without context rather than being dropped
  (`no_context_factor`, default 0.35).

### Attachments get column-level context

A CSV of 5,000 customers has the word "aadhaar" exactly once — in the header
row, hundreds of kilobytes from most of the values it labels. With only a
±120-character window, the export you most need to catch is detected in its
first few rows and nowhere else.

So for **attachments only**, keywords in the first 2 KB apply to the whole
part. Body text keeps local windows, because widening it there would let one
mention of "card" flag every number in a long email. Both behaviours are
pinned by tests.

## Scoring

Not booleans. One PAN in a mail to the company's own auditor is business as
usual; forty card numbers in a spreadsheet to a Gmail address is an incident.

```
score = Σ (detector weight × context factor)      per detector, capped
      × 1.5   if a card number appears with CVV or expiry (full card data)
      × bulk escalation  (n/threshold)^(exponent-1) when repeats exceed threshold
      × 2.0   if any recipient is external and not allow-listed
      ÷ 4.0   if every external recipient IS allow-listed
      × 0.25  if all recipients are internal
```

Then: `>= tag_at` tag · `>= quarantine_at` hold · `>= block_at` reject.

Two of these deserve attention:

- **Direction beats content.** The risk is data *leaving*. Internal mail is
  scaled to a quarter; the tenant's auditor and sponsor bank are allow-listed
  and scaled down further.
- **Bulk beats severity.** The breach is rarely one card number in a sentence —
  it's a customer export. Repeats escalate super-linearly, which is why
  `max_contribution` defaults to 100 rather than something near `block_at`: a
  low cap silently cancels bulk escalation, which is the rule that catches the
  leak that actually matters.

## Policies

One YAML file per tenant in `/etc/mailstack-dlp/policies/`, named
`<domain>.yml`, with `default.yml` as the fallback. Files are re-read when
their mtime changes — no restart.

```yaml
mode: enforce                       # monitor | enforce
internal_domains: [fintechco.in, .fintechco.in]
allowed_external_domains:           # leading dot = subdomains
  - .hdfcbank.com                   # sponsor bank
  - auditors-llp.in
exempt_senders: [settlement-bot@fintechco.in]

tag_at: 3.0
quarantine_at: 8.0
block_at: 16.0
bulk_threshold: 3
bulk_exponent: 1.5

rules:
  payment_card: {weight: 14.0, max_contribution: 80.0}
  aadhaar:      {weight: 12.0}
  gstin:        {weight: 3.0}       # a GSTIN on an invoice is normal
  upi_id:       false               # switch a detector off entirely
```

See `policies/default.yml` (documented) and `policies/example-fintech.yml`
(the shape you sell to an RBI-regulated customer).

**If no policy file exists at all, the tenant gets monitor mode.** A missing
or mistyped filename can never start blocking a customer's mail.

## Detectors

| id | Validation |
|---|---|
| `payment_card` | Luhn + issuer prefix (Visa, Mastercard, Amex, Discover, JCB, Diners, RuPay, Maestro) |
| `card_cvv`, `card_expiry` | Keyword-anchored; boost the card score ×1.5 |
| `aadhaar` | Verhoeff + leading digit 2–9 + **keyword required** |
| `pan_india` | AAAAA9999A + valid holder-type character |
| `gstin` | State code + embedded PAN + mod-36 check character |
| `ifsc` | 4 letters + `0` + 6 alphanumerics |
| `bank_account` | Keyword-anchored, 9–18 digits |
| `iban` | ISO 13616 mod-97 + per-country length |
| `upi_id` | Known PSP handle suffixes |
| `private_key` | PEM private-key blocks |
| `aws_access_key` | AKIA/ASIA/ABIA/ACCA + 16 chars |
| `generic_secret` | `password:`/`api_key=` style assignments |
| `confidential_marking` | The customer's own classification labels |

## Never log the PII you detect

Every `Finding` stores a **masked** value only:

```
4111111111111111  ->  ************1111
234567890124      ->  ********0124
AAPFU0939F        ->  AA******3F
```

The audit log, the `X-DLP-*` headers and the SMTP responses all carry masked
values and an incident id, never the match. If your DLP logs contain the card
numbers you found, your log store is now the breach — and it is a log store
with far weaker access control than the mailbox was.

`MaskingTests` asserts no masked form ever reproduces its raw value. That test
earned its place: it caught `mask_keep_edges(value, 4, 0)` returning the value
completely unmasked, because `value[-0:]` is the whole string in Python.

## Quarantine uses Postfix's own hold queue

No custom quarantine store. A `quarantine` verdict sets `X-DLP-Action:
quarantine`, and a Postfix `header_checks` rule turns that into `HOLD`:

```bash
mailq | grep -i hold
postcat -q <queue_id> | head -40          # read X-DLP-Incident
grep '<incident_id>' /var/log/mailstack-dlp/audit.jsonl | python3 -m json.tool
postsuper -H <queue_id>                   # release
postsuper -d <queue_id>                   # delete
```

Log who released what and why. For an audit, "the message was held" is half
the answer; "here is who released it, when, and on what grounds" is the half
that is usually missing — and the half you're being paid for.

See `rspamd/postfix-header_checks.md`.

## Failure posture: closed

If the service is down, times out, crashes, or the message is too large, the
plugin returns `451` and the sender's MTA retries. Data does not leave
un-inspected.

The cost is real: **a DLP outage becomes a mail outage.** Monitor
`mailstack-dlp` exactly as closely as you monitor Postfix. `on_error = "allow"`
in `/etc/rspamd/local.d/dlp.conf` flips it to fail-open for a monitoring-only
pilot; it stamps `X-DLP-Action: not-inspected` so the gap stays visible in the
audit trail rather than becoming an invisible hole.

## What has and hasn't been tested

**Tested here** — 66 unit tests, all passing, plus a live end-to-end run of the
service over HTTP:

- Luhn, Verhoeff, GSTIN, PAN, IFSC, IBAN validators. The Verhoeff tables are
  verified against the algorithm's mathematical guarantee: zero misses across
  108,000 single-digit errors and 9,642 adjacent transpositions.
- GSTIN check characters recomputed from two independently published GSTINs.
- Masking: no masked value ever equals its raw form, at any keep-length.
- Engine: monitor mode never blocks, exemptions short-circuit, internal and
  allow-listed recipients score down, subdomain matching needs the leading
  dot, bulk escalates super-linearly, per-detector caps hold, incident ids are
  unique, audit records and headers are free of raw values.
- Extraction: body, HTML, CSV, readable zip, and refusal of both archive bombs
  and password-protected archives without leaking their content.
- End to end: clean mail allowed; card to Gmail blocked (score 57); the same
  mail to an allow-listed bank only tagged (7.1); a 6-card + Aadhaar CSV export
  to a personal Gmail blocked at 216.5; an unknown tenant falling back to
  monitor mode and *not* blocking. Inspection took 1.5–8 ms per message, and
  the audit log contained zero raw values.

**Not tested** — no live Postfix or Rspamd in the build environment, so the
milter path is unproven end to end:

1. The Rspamd Lua plugin has never run inside Rspamd. Review it, then test on
   a throwaway VM before any customer sees it. `rspamd -t` is checked by the
   installer, which removes the plugin again if the config fails.
2. The `header_checks` → `HOLD` path is the documented Postfix mechanism but
   has not been executed here.
3. PDF/DOCX/XLSX extractors were not exercised (the libraries aren't installed
   in the build environment). CSV and zip were.

## Known limitations

1. **No admin UI.** Policies are YAML files, quarantine is `postsuper`, reports
   are `jq` over JSON Lines. That is fine for you and not fine for a customer —
   the quarantine-review and reporting UI is what makes this sellable, and it
   is the next thing to build.
2. **No OCR.** A card number in a photographed document passes. If that
   matters, add Tesseract to the extraction stage.
3. **No legacy Office formats** (`.doc`, `.xls`), and no RAR or 7z — reported
   as unscannable, so the policy sees them rather than missing them.
4. **Inbound is not inspected.** By design: this is an exfiltration control.
   Inbound phishing is Rspamd's job.
5. **English + Devanagari keywords only.** Add regional-language keyword sets
   per tenant as you find them in monitor mode.
6. **Body context is windowed, attachment context is part-wide.** A card
   number 500 characters from any card-related word in a long body scores at
   `no_context_factor` rather than full weight.
7. **Scanning happens on the mail path.** Budget CPU for it, and keep
   `max_scan_bytes` and `DLP_MAX_BODY_BYTES` sane on a busy server.

## Legal and privacy — read before selling this

DLP means reading the content of your customers' employees' email. That is
lawful and normal for a company inspecting its own corporate mail, and it is
your customer's decision to make, not yours. But your product has to support
it properly:

- The customer needs their **own employee notice / acceptable-use policy**
  telling staff their outbound mail is inspected. You are the processor; they
  are the controller. Get that written into the contract.
- You need a **DPA** with each customer covering this processing, and under the
  DPDP Act you need to be able to answer what you store, where, and for how
  long.
- **Store the minimum.** Detector id, masked value, offset, part name. Not the
  match, not the message body, not the attachment.
- **Restrict who can read the audit log and the hold queue.** Those two
  surfaces are a concentrated view of the customer's most sensitive data flows.
  Access to them should be logged too.
- **Retention is a policy decision, not a default.** The logrotate rule ships
  at ~7 years because that is a common Indian financial-records horizon; set it
  to what each customer's obligation actually is, and be able to prove
  deletion afterwards.

Not legal advice — have a lawyer paper this before your first regulated
customer signs.
