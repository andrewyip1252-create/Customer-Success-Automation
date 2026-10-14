/**
 * Secrets.gs
 * Fetches HUBSPOT_TOKEN, FATHOM_API_KEY, and ANTHROPIC_API_KEY from
 * Google Cloud Secret Manager at runtime, instead of Script Properties.
 * Keeps the exact same getProp(key) name every existing call site in
 * Code.gs already uses (8 places) — so nothing else needs to change.
 *
 * THIS REPLACES the old getProp() that used to live in Code.gs. That
 * one has already been deleted from your updated Code.gs — if you're
 * copying this into your OWN live project by hand instead, make sure
 * you delete the old one there too. Apps Script shares one global scope
 * across every file in a project, so two functions with the same name
 * silently collide — whichever one loads last wins, with no error at
 * all telling you it happened.
 *
 * SETUP REQUIRED:
 *  1. This Apps Script project must be linked to a Google Cloud project
 *     (Project Settings -> "Change project" in the editor) — already
 *     true if you set up the CloudStorage.gs bucket, since that needed
 *     the same link.
 *  2. GCP_PROJECT_ID below set to that Cloud project's Project ID (the
 *     string ID, e.g. "my-gcp-project" — NOT the numeric project
 *     number shown elsewhere in the console).
 *  3. Secret Manager API enabled on that Cloud project (Console -> APIs
 *     & Services -> Library -> search "Secret Manager API" -> Enable).
 *  4. Three secrets created there (Console -> Security -> Secret
 *     Manager -> Create Secret), named EXACTLY:
 *       HUBSPOT_TOKEN
 *       FATHOM_API_KEY
 *       ANTHROPIC_API_KEY
 *     with the same real values currently sitting in Script Properties.
 *
 *     If you've also set up the Fathom webhook relay (see
 *     fathom-webhook-relay/index.js), two more secrets are needed here
 *     too, same process:
 *       FATHOM_WEBHOOK_SECRET  — the "whsec_..." value Fathom gives you
 *                                 when you create the webhook
 *       WEBHOOK_RELAY_SECRET   — a long random string YOU generate (not
 *                                 provided by Fathom) — the SAME value
 *                                 must also exist in the Cloud
 *                                 Function's OWN Secret Manager access,
 *                                 since that's the shared secret proving
 *                                 a request to doPost() really came from
 *                                 the already-verified relay
 *  5. "Secret Manager Secret Accessor" granted to domain:example.com
 *     on EACH of those secrets INDIVIDUALLY (open each secret ->
 *     Permissions tab -> Grant Access) — NOT at the project IAM level.
 *     Granting at the project level would also expose any OTHER secrets
 *     living in this same GCP project (e.g. SALE's own Stripe/Slack/
 *     Gemini keys, if this is the same project SALE uses) to the whole
 *     domain, not just these three.
 *  6. "https://www.googleapis.com/auth/cloud-platform" added to
 *     appsscript.json's oauthScopes array. Broader than the
 *     devstorage.read_write scope added for the archive bucket — and
 *     actually covers that too, so devstorage.read_write can be removed
 *     once this is working (not required, just tidier either way).
 */

var GCP_PROJECT_ID = "YOUR_GCP_PROJECT_ID_HERE"; // the string Project ID, not the numeric project number

function getProp(key) {
  var url = "https://secretmanager.googleapis.com/v1/projects/" +
            GCP_PROJECT_ID + "/secrets/" + key + "/versions/latest:access";

  var response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(
      'Missing/unreachable secret "' + key + '" (HTTP ' +
      response.getResponseCode() + '): ' + response.getContentText() +
      '. Check that a secret named exactly "' + key + '" exists in ' +
      'Secret Manager, GCP_PROJECT_ID is correct, and this account has ' +
      'been granted Secret Manager Secret Accessor on that specific secret.'
    );
  }

  var payload = JSON.parse(response.getContentText());
  var base64Data = payload.payload.data;
  return Utilities.newBlob(Utilities.base64Decode(base64Data)).getDataAsString();
}
