/**
 * fathom-webhook-relay
 * =====================================================================
 * Receives Fathom's "new meeting content ready" webhook, verifies its
 * HMAC-SHA256 signature, and writes the meeting as a JSON object into
 * the same Cloud Storage bucket CSA already uses for trace-log
 * archiving. CSA's checkFathomWebhookCache_() reads those objects
 * BEFORE it ever makes a live Fathom API call.
 *
 *   Fathom --(POST, signed)--> THIS Cloud Function --> GCS bucket
 *                                                          ^
 *                                                          |
 *                          CSA's checkFathomWebhookCache_()
 *                          lists/reads recent objects first,
 *                          skipping the slow, rate-limited
 *                          live Fathom search entirely
 *
 * WHY GCS RATHER THAN A SPREADSHEET TAB:
 * An earlier version wrote rows into a "Fathom Webhook Cache" tab in
 * CSA's own tracking spreadsheet. That worked, but put machine-written
 * data inside a sheet the Customer Success team actively owns and edits
 * — an invitation for someone to sort, filter or "tidy" it and silently
 * break the cache. GCS is where this project already archives its other
 * machine-generated data (see CloudStorage.gs), has no per-cell size
 * limit to bump against, and supports lifecycle rules for automatic
 * expiry of stale entries.
 *
 * WHY NOT POST TO APPS SCRIPT:
 * A Cloud Function authenticates as a service account, which has no
 * Workspace user identity, so Google rejects it with a 401 login page
 * before any Apps Script doPost() would run while that web app stays
 * restricted to the organization. Writing to GCS avoids that entirely
 * and keeps the web app's domain restriction fully intact.
 *
 * SETUP:
 *  1. Secret Manager (same GCP project) must contain:
 *       FATHOM_WEBHOOK_SECRET — the "whsec_..." value shown next to your
 *                                API key in Fathom's API Access settings
 *     This function's runtime service account needs "Secret Manager
 *     Secret Accessor" on that secret.
 *  2. That same service account needs "Storage Object Creator" on the
 *     bucket (Console -> Cloud Storage -> bucket -> Permissions).
 *  3. Deploy with these environment variables:
 *       GCP_PROJECT_ID  — this GCP project's string Project ID
 *       GCS_BUCKET_NAME — the same bucket CloudStorage.gs uses
 *       GCS_ENV         — optional; defaults to "production". Matches
 *                          the GCS_ENV prefix in CloudStorage.gs.
 *     SHEET_ID and APPS_SCRIPT_WEBHOOK_URL are no longer used and can
 *     be removed.
 *
 * OBJECT PATH (mirrors CloudStorage.gs's own convention):
 *   <env>/fathom-webhook/<yyyy>/<yyyy-MM-dd>/<HHmmss>.<ms>-<recordingId>.json
 */

const crypto = require("crypto");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const { Storage } = require("@google-cloud/storage");

const secretClient = new SecretManagerServiceClient();

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const GCS_ENV = process.env.GCS_ENV || "production";

// Cached across warm invocations of the same instance.
let cachedFathomWebhookSecret = null;
const storage = new Storage();

async function getSecretValue(secretName) {
  const [version] = await secretClient.accessSecretVersion({
    name: `projects/${GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`,
  });
  return version.payload.data.toString("utf8");
}

// The webhook-signature header carries one or more space-separated
// signatures, each prefixed with a version identifier (e.g. "v1,<sig>").
function extractSignatures(webhookSignatureHeader) {
  return webhookSignatureHeader.split(" ").map(function (sig) {
    const parts = sig.split(",");
    return parts.length > 1 ? parts[1] : parts[0];
  });
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Writes one verified meeting to GCS as a single JSON object.
//
// Stores the payload EXACTLY as Fathom sent it, unmodified — CSA's
// checkFathomWebhookCache_() reconstructs it into a meeting-like object
// and runs it through the identical classification functions the live
// Fathom tiers use (isOnboardingMeeting, contactMatchesMeeting,
// extractSummary...). Verified against a real payload: the webhook body
// has the same shape as a live /meetings API response, so no reshaping
// is needed or wanted here — any transformation would risk diverging
// from what those functions expect.
//
// Path mirrors CloudStorage.gs's own convention so the bucket stays
// browsable as it grows. Milliseconds plus the recording ID make the
// name unique even if two webhooks land in the same second.
async function writeMeetingToGCS(payload) {
  const meetingObj = payload.data || payload;
  const now = new Date();
  const iso = now.toISOString();
  const yearPart = iso.slice(0, 4);
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 19).replace(/:/g, "");
  const msPart = ("00" + (now.getTime() % 1000)).slice(-3);

  const recordingId = meetingObj.recording_id
    ? String(meetingObj.recording_id).replace(/[^a-zA-Z0-9_-]/g, "")
    : "unknown";

  const objectName =
    GCS_ENV + "/fathom-webhook/" + yearPart + "/" + datePart + "/" +
    timePart + "." + msPart + "-" + recordingId + ".json";

  await storage
    .bucket(GCS_BUCKET_NAME)
    .file(objectName)
    .save(JSON.stringify(payload), { contentType: "application/json" });

  const title = meetingObj.meeting_title || meetingObj.title || "(untitled)";
  const host = (meetingObj.recorded_by && meetingObj.recorded_by.name) || "unknown";
  console.log(
    'Wrote meeting to GCS: "' + title + '" (host: ' + host + ') -> gs://' +
    GCS_BUCKET_NAME + "/" + objectName
  );
}

exports.fathomWebhookRelay = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  try {
    if (!cachedFathomWebhookSecret) {
      cachedFathomWebhookSecret = await getSecretValue("FATHOM_WEBHOOK_SECRET");
    }

    const webhookId = req.get("webhook-id");
    const webhookTimestamp = req.get("webhook-timestamp");
    const webhookSignature = req.get("webhook-signature");

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      console.warn("Rejected: missing one or more verification headers");
      res.status(400).send("Missing verification headers");
      return;
    }

    // Replay-attack protection, per Fathom's documented 5-minute tolerance.
    const timestampSec = parseInt(webhookTimestamp, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!timestampSec || Math.abs(nowSec - timestampSec) > 300) {
      console.warn("Rejected: webhook timestamp outside 5-minute tolerance");
      res.status(400).send("Timestamp outside tolerance");
      return;
    }

    // MUST be the untouched raw bytes exactly as Fathom sent them — a
    // re-serialized JSON.stringify of a parsed object would not
    // byte-for-byte match what Fathom signed, and verification would
    // fail even for a genuine request.
    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : "";

    const signedContent = webhookId + "." + webhookTimestamp + "." + rawBody;
    const secretBytes = Buffer.from(
      cachedFathomWebhookSecret.split("_")[1],
      "base64"
    );
    const expectedSignature = crypto
      .createHmac("sha256", secretBytes)
      .update(signedContent)
      .digest("base64");

    const candidateSignatures = extractSignatures(webhookSignature);
    const isValid = candidateSignatures.some(function (sig) {
      try {
        return safeEqual(expectedSignature, sig);
      } catch (e) {
        return false;
      }
    });

    if (!isValid) {
      console.warn("Rejected: signature verification failed");
      res.status(401).send("Invalid signature");
      return;
    }

    let parsedPayload;
    try {
      parsedPayload = JSON.parse(rawBody);
    } catch (e) {
      console.error("Verified request had unparseable JSON body:", e.message);
      res.status(400).send("Invalid JSON body");
      return;
    }

    await writeMeetingToGCS(parsedPayload);

    res.status(200).send("OK");
  } catch (err) {
    console.error("Unhandled error in webhook relay:", err);
    res.status(500).send("Internal error");
  }
};
