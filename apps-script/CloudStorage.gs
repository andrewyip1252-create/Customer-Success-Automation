/**
 * CloudStorage.gs
 * Archives every CSA pull, sheet write, task creation, and email send —
 * success AND failure alike — to Google Cloud Storage as plain JSON.
 * Same pattern as SALE's own EOW_CloudStorage.gs: archival only, never a
 * cache, and a failed archive must never break the real flow it wraps.
 *
 * RENE is deliberately left out of this file — it isn't live for anyone
 * yet, so nothing to wrap there. Add rene_pullCompanyContacts /
 * rene_pullDealContacts wrappers the same way, later, when it ships.
 *
 * WHY ONE FILE COVERS BOTH "keep a record of everything" AND "catch
 * failures": every wrapped function already returns { ok: true, ... }
 * or { ok: false, error, trace }. Archiving that object as-is, tagged
 * -ok or -fail in the filename, gives you both for free.
 *
 * SETUP — do these once, in order:
 *   1. Cloud Storage API enabled on this project's linked GCP project.
 *   2. The account this script runs as granted "Storage Object Creator"
 *      on the bucket ITSELF (not just project-level IAM).
 *   3. GCS_BUCKET_NAME below filled in with your real bucket name.
 *   4. This OAuth scope added to appsscript.json's oauthScopes array:
 *        "https://www.googleapis.com/auth/devstorage.read_write"
 *   5. Run debugTestGCSUpload() and confirm the test file shows up in
 *      the bucket before trusting this for anything real.
 */

var GCS_BUCKET_NAME = "YOUR_GCS_BUCKET_NAME_HERE";
var GCS_ENV = "production";

/**
 * Uploads a JSON-serializable object to the configured GCS bucket.
 * Never throws — returns { success: true, gcsPath } or
 * { success: false, error }.
 */
function uploadJsonToGCS_(objectName, dataObject) {
  if (!GCS_BUCKET_NAME || GCS_BUCKET_NAME.indexOf("YOUR_") === 0) {
    return { success: false, error: "GCS_BUCKET_NAME is not set yet — fill in your real bucket name first." };
  }

  var url = "https://storage.googleapis.com/upload/storage/v1/b/" +
    encodeURIComponent(GCS_BUCKET_NAME) + "/o?uploadType=media&name=" + encodeURIComponent(objectName);

  try {
    var response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(dataObject),
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      return { success: false, error: "GCS upload failed (" + response.getResponseCode() + "): " + response.getContentText() };
    }
    return { success: true, gcsPath: "gs://" + GCS_BUCKET_NAME + "/" + objectName };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * Archives ONE result — success or failure alike — under a path that
 * stays browsable as the bucket grows:
 *   production/<area>/<yyyy>/<yyyy-MM-dd>/<HHmmss>-<key>-<ok|fail>.json
 * e.g. production/csa-pull/2026/2026-08-28/143022-198765201-ok.json
 */
function archiveResult_(area, key, result) {
  try {
    var now = new Date();
    var yearPart = Utilities.formatDate(now, "America/Denver", "yyyy");
    var datePart = Utilities.formatDate(now, "America/Denver", "yyyy-MM-dd");
    var timePart = Utilities.formatDate(now, "America/Denver", "HHmmss");
    // Zero-padded milliseconds PLUS a full UUID — together these make
    // every archived object name unique, even when many calls land in
    // the exact same wall-clock second. Confirmed real risk without
    // this: a Suite pull creates 15 tasks in a tight sequential loop,
    // all archived under "csa-task" keyed only by contactId — two
    // tasks landing in the same second would generate the IDENTICAL
    // object name, and the second upload would silently overwrite the
    // first, with no error and no warning, quietly losing that task's
    // archive record.
    var msPart = ("00" + (now.getTime() % 1000)).slice(-3);
    var uniqueId = Utilities.getUuid();
    var safeKey = String(key || "unknown").replace(/[^a-zA-Z0-9_.@-]/g, "_").slice(0, 80);
    var status = (result && result.ok === false) ? "fail" : "ok";

    var objectName = GCS_ENV + "/" + area + "/" + yearPart + "/" + datePart + "/" +
      timePart + "." + msPart + "-" + safeKey + "-" + uniqueId + "-" + status + ".json";

    var upload = uploadJsonToGCS_(objectName, {
      archivedAt: now.toISOString(),
      env: GCS_ENV,
      area: area,
      key: key,
      result: result
    });

    if (!upload.success) {
      Logger.log("⚠ Could not archive " + area + " (" + key + ") to GCS: " + upload.error);
    }
  } catch (e) {
    Logger.log("⚠ archiveResult_ itself threw: " + (e.message || String(e)));
  }
}

// ── Wrappers ──────────────────────────────────────────────────────────
// Each wraps the real implementation (renamed to *_impl in Code.gs) so
// every call gets archived without touching the tested logic inside
// those functions.

function pullContactData(input) {
  var result = pullContactData_impl(input);
  archiveResult_("csa-pull", (result && result.contactId) || input, result);
  return result;
}

function resolveFathomAndFinalize(contactId, ctx) {
  var result = resolveFathomAndFinalize_impl(contactId, ctx);
  archiveResult_("csa-fathom", contactId, result);
  return result;
}

function insertRow(row, targetRow) {
  var result = insertRow_impl(row, targetRow);
  archiveResult_("csa-insert-row", (row && row.userEmail) || targetRow, result);
  return result;
}

function createWorkflowTask(contactId, title, sopType, dueDateIso, assigneeKind, onboarderName, salespersonName, notes) {
  var result = createWorkflowTask_impl(contactId, title, sopType, dueDateIso, assigneeKind, onboarderName, salespersonName, notes);
  archiveResult_("csa-task", contactId, result);
  return result;
}

function sendPostOnboardEmail(toEmail, subject, htmlBody, attachmentKeys, ccEmail, bccAddress) {
  var result = sendPostOnboardEmail_impl(toEmail, subject, htmlBody, attachmentKeys, ccEmail, bccAddress);
  archiveResult_("csa-email", toEmail, result);
  return result;
}

/**
 * DIAGNOSTIC — run this first, from the Apps Script editor (select
 * debugTestGCSUpload in the function dropdown at the top, then press
 * Run), to confirm the bucket name, IAM permission, and OAuth scope are
 * all working before trusting this for anything real.
 */
function debugTestGCSUpload() {
  var result = uploadJsonToGCS_(GCS_ENV + "/test/connection-check.json", {
    message: "If you can see this file in your bucket, the connection works.",
    testedAt: new Date().toISOString()
  });

  if (result.success) {
    Logger.log("✓ Success — uploaded to " + result.gcsPath);
    Logger.log("Check your bucket for a file at: " + GCS_ENV + "/test/connection-check.json");
  } else {
    Logger.log("✗ Failed: " + result.error);
  }
}