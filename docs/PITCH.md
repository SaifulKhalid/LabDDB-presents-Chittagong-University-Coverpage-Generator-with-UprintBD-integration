# The Pitch — LabDDB × UprintBD

A one-page case for the UprintBD authority, backed by a working prototype.

---

## The problem

LabDDB already generates cover pages for every EEE student at Chittagong University.
But to *print* one today, a student must:

1. Generate the cover page on LabDDB.
2. Leave LabDDB, open `uprintbd.com`, and log in.
3. Upload the PDF and choose print options.
4. Copy the OTP.
5. Enter it at a CU kiosk.

Steps 2–4 are friction that happen **off** LabDDB, on a separate site, with a separate
login. Every extra step loses students between "I made a cover page" and "I printed it."

## The solution

One button — **"Get Kiosk OTP"** — on LabDDB. The student clicks it and immediately gets
a real, kiosk-ready OTP. No second site, no separate login, no manual upload.

Behind that button, a small server logs in with **one institutional account** and drives
UprintBD's **existing** website to create the job and produce the OTP — the same requests
a student would make by hand, done in under a second.

## Why this needs nothing from UprintBD

You said: *"We won't give you an API. Build something that works with our existing
system, and we'll sign the contract."*

That's exactly what this is. It uses your current pages, in the current order, with the
current payloads. **No new endpoint, no code on your side, no maintenance for your team.**
It already works against the live site today.

## Proof it works (live)

The prototype was verified end-to-end against `uprintbd.com`, minting genuine OTPs and
cleaning up after itself:

```
POST /api/print → { ok:true, otp:"415340", recordId:"13697",
                    pages:1, copies:2, color:false, cost:6, currency:"BDT",
                    validForSeconds:3600 }
```

- Real 6-digit OTPs, valid ~1 hour, printable at any Uprint kiosk. **Confirmed at a CU
  kiosk** — the code was entered and the page came out.
- The declared cost follows your own `calculateCost()`: `pages × copies × unit`
  (3 Tk mono / 5 Tk colour) — here 1 × 2 × 3 = 6 Tk. Your outlet then bills the
  institutional account its own rate (2.00 Tk for a 1-page mono job, per
  `transaction_history`), which is exactly as it should be — we declare, you price.
- Students are charged **only for pages that actually printed.** We reserve on mint and
  settle from `print_history`, mirroring your own behaviour: your ledger debits ~37 s
  *after* a print completes, not when the code is issued. An OTP that is never used costs
  the student nothing.
- Every test job deleted; the account queue confirmed empty afterward.

(Full evidence: [TESTING.md](TESTING.md); how it works: [UPRINT-PROTOCOL.md](UPRINT-PROTOCOL.md).)

## What's in it for UprintBD

1. **More print volume, less friction.** Every cover page LabDDB generates becomes a
   one-click print job funnelled straight to your kiosks — starting with
   *Dept. of EEE_CU_Uprint* and the CU hall outlets.
2. **Zero build, zero maintenance.** Nothing to develop or operate on your side.
3. **Legitimate, contained traffic.** One institutional account, real balance, real jobs
   — not scraping, not abuse. Rate limiting and authentication are already in place on our
   end: every student signs in with Google before a code can be minted, and per-user caps
   bound open holds, jobs per hour, pages and copies.
4. **A clean upgrade path.** If you ever want a formal integration, our entire
   UprintBD-facing code is a single file behind a stable contract. Ship an API and we
   swap it in with no disruption to students.

## What we ask

- A **blessed institutional account** for CU printing (with print balance).
- A note to your ops/monitoring team to **allow-list** this traffic, so a healthy burst
  of student prints isn't mistaken for abuse.
- The **contract**, per your standing offer, once you're satisfied it works with your
  system.

## What we commit to

- Authenticated, rate-limited access on the LabDDB side (only real students trigger
  prints).
- Locked-down CORS and TLS in production.
- Spend caps and monitoring against the institutional balance.
- Prompt updates if your markup changes (isolated to one file), and immediate migration
  to an official API if/when one exists.

---

**Bottom line:** students get their prints in one click, you get more kiosk volume with
no engineering cost, and the door is open to a deeper integration whenever you want it —
all built to the exact brief you set.
