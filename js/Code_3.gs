/**
 * MONITORING REJECT — entry points
 * Deploy this project as a Web App (Execute as: Me, Who has access: Anyone).
 * All real traffic should come through the Cloudflare Worker, which is the
 * only holder of WORKER_SECRET — see /worker/worker.js.
 */

function doGet(e) {
  ensureBootstrap_();
  return jsonOutput_({ ok: true, message: 'Monitoring Reject backend is running' });
}

function doPost(e) {
  return handleRequest_(e);
}

function handleRequest_(e) {
  try {
    ensureBootstrap_();

    var params;
    try {
      params = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonOutput_({ ok: false, error: 'invalid_json' });
    }

    var expectedSecret = getScriptProp_('WORKER_SECRET');
    if (expectedSecret && params.secret !== expectedSecret) {
      return jsonOutput_({ ok: false, error: 'forbidden' });
    }

    var action = params.action;
    switch (action) {
      case 'register':
        return jsonOutput_(actionRegister_(params));
      case 'login':
        return jsonOutput_(actionLogin_(params));
      case 'listPendingUsers':
        return jsonOutput_(actionListPendingUsers_(params));
      case 'listUsers':
        return jsonOutput_(actionListUsers_(params));
      case 'approveUser':
        return jsonOutput_(actionApproveUser_(params));
      case 'rejectUser':
        return jsonOutput_(actionRejectUser_(params));
      case 'changePassword':
        return jsonOutput_(actionChangePassword_(params));
      case 'submitReject':
        return jsonOutput_(actionSubmitReject_(params));
      case 'getDashboardData':
        return jsonOutput_(actionGetDashboardData_(params));
      case 'getLineConfig':
        return jsonOutput_(actionGetLineConfig_());
      default:
        return jsonOutput_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    var msg = String((err && err.message) || err);
    if (msg.indexOf('unauthorized') !== -1) return jsonOutput_({ ok: false, error: 'unauthorized' });
    if (msg.indexOf('forbidden_not_admin') !== -1) return jsonOutput_({ ok: false, error: 'forbidden_not_admin' });
    return jsonOutput_({ ok: false, error: 'server_error', message: msg });
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
