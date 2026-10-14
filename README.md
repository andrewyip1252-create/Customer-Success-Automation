# CSA — Customer Success Onboarding Automation

A Google Apps Script web app that automates post-onboarding task creation for a B2B SaaS
customer success team. It reads a customer's CRM record, verifies who actually ran their
onboarding call against call-recording data, calculates a full schedule of SOP-driven
follow-up tasks, and writes them back into the CRM.

Done manually, that process takes roughly 45–70 minutes per customer. CSA reduces it to a
few minutes of review-and-confirm.

> **Note on redaction.** This is a public copy of an internal tool. All company, customer,
> and employee identifiers have been replaced with placeholders — see
> [Redaction](#redaction) below. The product is referred to throughout as the fictional
> "Vantage CRE". The logic, architecture, and comments are otherwise unmodified.

---

## What it does

1. **Resolve the contact.** Accepts a CRM contact ID, record URL, or email. Resolves the
   company from the CRM's *primary* company association rather than the flat text field,
   which goes stale independently of the real relationship.
2. **Determine who ran the onboarding.** The CRM records who *booked* a meeting, which is
   frequently not who actually ran it. CSA verifies against the call-recording platform's
   own `recorded_by` host and prefers that.
3. **Calculate the task schedule.** Three product workflows with different task sets
   (15 / 16 / 9 tasks). Due dates derive from either the onboarding date or the
   subscription date depending on the task, and never land on a weekend.
4. **Create the tasks.** Each with the correct type, due date, assignee, and pre-filled
   notes or call script. A human reviews and can edit every field before anything is written.

---

## Architecture

There are two separate flows. **Flow A** runs on its own in the background. **Flow B** runs
when someone actually uses the tool.

### Flow A — Caching meetings as they happen (automatic, no human involved)

```
  Call platform          Cloud Function              Cloud Storage
  ─────────────          ──────────────              ─────────────
   call ends    ──[1]──▶  verify signature  ──[2]──▶  save meeting
                          (reject if fake)             as JSON
```

1. A call finishes and the recording platform sends a webhook to a Google Cloud Function.
2. The function checks the request's signature to confirm it genuinely came from the
   platform, then saves the meeting to Cloud Storage.

That's it. This runs 24/7 whether or not anyone is using the app. Its only purpose is so
Flow B has a local copy of recent meetings and can skip a slow API search.

### Flow B — Building a customer's task list (what a user actually does)

```
   User
    │
    │ [1] paste a contact
    ▼
  ┌─────────────────────────────────────────────────┐
  │                 Apps Script app                 │
  │                                                 │
  │  [2] look up contact ──────────▶ CRM            │
  │  [3] who ran the call?                          │
  │        ├─ check cache ─────────▶ Cloud Storage  │
  │        └─ if incomplete ───────▶ Call platform  │
  │  [4] calculate dates           (internal)       │
  │  [5] show for review ─────────▶ User            │
  │  [6] create tasks ─────────────▶ CRM            │
  │  [7] log the customer ─────────▶ Google Sheets  │
  └─────────────────────────────────────────────────┘
```

1. **User pastes a contact.** A CRM contact ID, a record URL, or an email address.
2. **Look up the contact in the CRM.** Name, company, deal, and any meetings already logged
   against them.
3. **Work out who actually ran the onboarding call.** Check the Cloud Storage cache first,
   because it's instant. Only fall back to a live call-platform search if the cache doesn't
   have everything the CRM says should exist.
4. **Calculate the task schedule.** Three product workflows with different task sets
   (15 / 16 / 9 tasks). Each due date is based on either the onboarding date or the
   subscription date, and is pushed off weekends.
5. **Show everything to the user for review.** Every field is editable. Nothing has been
   written anywhere yet.
6. **User confirms, and the tasks are created in the CRM** — each with its type, due date,
   assignee, and pre-filled notes.
7. **Log the customer to the tracking sheet.**

Step 3 is where most of the complexity lives, and where most of the bugs in the next
section came from.

### Files

| File | Role |
|---|---|
| `apps-script/Code.gs` | Backend. Steps 2, 3, 4, 6 and 7 above. |
| `apps-script/Index.html` | Frontend. Steps 1 and 5 — search box, review screen, email composer. |
| `apps-script/CloudStorage.gs` | Wraps five backend functions so every operation is archived to Cloud Storage for audit. |
| `apps-script/Secrets.gs` | Fetches API credentials from Secret Manager at runtime. |
| `apps-script/EmailAttachments.gs` | Attachments for the post-onboarding email. |
| `cloud-function/` | All of Flow A — signature verification and cache writes. |

---

## Problems worth reading the code for

Most of the interesting logic exists because a reasonable-looking first approach failed
against real data. The comments document each case.

**Substring collisions in name matching.** Matching a contact to a call by searching for
their name in the call text used plain `indexOf`. A surname like "Hart" matches inside the
ordinary word "chart", so unrelated calls were being attributed to the wrong person. Fixed
with word-boundary matching.

**Stale history on reused CRM records.** A contact record reused across a multi-year gap
carried onboarding-titled meetings from a previous, unrelated engagement. Taking the
earliest one produced a first-onboard date years off, and widened the search window enough
to make false matches more likely. Fixed by clustering meetings and discarding anything
separated from the recent cluster by more than 90 days.

**Rate limiting under a fallback scan.** When fast filters miss, the fallback scans each
rep's recordings. Doing that one rep at a time burned through the API's per-minute budget
and incurred 49-second backoffs. The endpoint accepts repeated `recorded_by[]` parameters,
so all reps are now queried in a single batched request.

**A cache that answered too confidently.** The webhook cache originally returned as soon as
it found *any* matching meeting — but the cache only contains meetings recorded since the
webhook was configured, so "incomplete" is its normal state. It reported one call for a
contact who had three. It now has to satisfy the CRM's own known call count before it is
allowed to skip the live search.

**Out-of-order async responses.** The live-search box fired a request per keystroke pause.
A broad early query ("Ann") takes longer server-side than a narrower later one
("Contact A"), so the stale broad result would land last and overwrite the correct one.
Fixed with a request-token guard.

**Service accounts cannot call Apps Script.** The webhook receiver was originally an Apps
Script `doPost()` endpoint. A Cloud Function authenticates as a service account, which has
no Workspace user identity, so Google rejects it with a login page before the handler runs —
and Apps Script cannot read the custom HTTP headers that signature verification requires
anyway. The Cloud Function writes to Cloud Storage directly instead, which keeps the web
app's domain restriction intact.

---

## Setup

Apps Script shares one global scope across all `.gs` files in a project, so all four backend
files live in the same project and call each other directly.

1. Create an Apps Script project; add the files from `apps-script/`.
2. Link it to a Google Cloud project; enable Secret Manager and Cloud Storage.
3. Create secrets for the CRM token, call-platform key, and model API key. Grant
   `Secret Manager Secret Accessor` per-secret, not at project level.
4. Replace every `YOUR_*_HERE` placeholder (sheet ID, portal ID, owner ID, project ID,
   bucket name).
5. Deploy as a web app.
6. Deploy `cloud-function/` separately, grant it `Storage Object Creator` on the bucket, and
   point the call platform's webhook at its URL.

---

## Redaction

Replaced with placeholders in this public copy:

- Employee names and email addresses → `Rep A`–`Rep L`, `rep.a@example.com`
- Customer and prospect names → `Contact A`–`Contact O`
- Customer company names → `Company A`
- Company and product names → the fictional "Vantage CRE" / "Vantage Suite" /
  "Vantage Prospects" / "Pipeline View"
- Google Sheet ID, CRM portal ID, CRM owner ID, GCP project ID, storage bucket name
- Links to internal training documents
- The base64-embedded email attachment templates in `EmailAttachments.gs` — the file's
  structure and logic are intact, the document bytes are stripped

No API keys, tokens, or credentials were ever present in these files. All are fetched from
Secret Manager at runtime.
