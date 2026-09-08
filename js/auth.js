/**
 * MONITORING REJECT — Auth: password hashing, HMAC tokens, account actions
 */

function sha256Hex_(input) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  return raw
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    })
    .join('');
}

// Salted + peppered + stretched hash. Not bcrypt, but a large step up from
// plain SHA-256, and keeps the backend dependency-free (Apps Script has no
// native bcrypt/scrypt).
function hashPassword_(password, salt) {
  var pepper = getScriptProp_('HMAC_SECRET') || 'fallback-pepper';
  var value = salt + ':' + password + ':' + pepper;
  for (var i = 0; i < 2000; i++) {
    value = sha256Hex_(value + i);
  }
  return value;
}

function createToken_(username, role) {
  var payload = { u: username, r: role, exp: Date.now() + 12 * 3600 * 1000 };
  var payloadStr = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  var sig = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payloadStr, getScriptProp_('HMAC_SECRET'))
  );
  return payloadStr + '.' + sig;
}

function verifyToken_(token) {
  if (!token || typeof token !== 'string') return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  var payloadStr = parts[0];
  var sig = parts[1];
  var expectedSig = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payloadStr, getScriptProp_('HMAC_SECRET'))
  );
  if (sig !== expectedSig) return null;
  var payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadStr)).getDataAsString());
  } catch (e) {
    return null;
  }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function requireAuth_(p) {
  var payload = verifyToken_(p.token);
  if (!payload) throw new Error('unauthorized');
  return payload;
}

function requireAdmin_(p) {
  var payload = requireAuth_(p);
  if (payload.r !== 'admin') throw new Error('forbidden_not_admin');
  return payload;
}

function actionRegister_(p) {
  var username = normalizeUsername_(p.username);
  var password = p.password || '';
  if (!username || username.length < 3) return { ok: false, error: 'invalid_username' };
  if (!password || password.length < 6) return { ok: false, error: 'password_too_short' };

  var sheet = getOrCreateSheet_(USERS_SHEET, USERS_HEADERS);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username) {
      return { ok: false, error: 'username_taken' };
    }
  }
  var salt = Utilities.getUuid();
  var hash = hashPassword_(password, salt);
  sheet.appendRow([username, salt, hash, 'user', 'pending', new Date(), '', '']);
  return { ok: true, message: 'registered_pending' };
}

function actionLogin_(p) {
  var username = normalizeUsername_(p.username);
  var password = p.password || '';
  var sheet = getOrCreateSheet_(USERS_SHEET, USERS_HEADERS);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (String(row[0]).toLowerCase() === username) {
      var salt = row[1];
      var hash = row[2];
      var role = row[3];
      var status = row[4];
      var computed = hashPassword_(password, salt);
      if (computed !== hash) return { ok: false, error: 'invalid_credentials' };
      if (status === 'pending') return { ok: false, error: 'account_pending' };
      if (status === 'rejected') return { ok: false, error: 'account_rejected' };
      var token = createToken_(row[0], role);
      return { ok: true, token: token, username: row[0], role: role };
    }
  }
  return { ok: false, error: 'invalid_credentials' };
}

function actionListPendingUsers_(p) {
  requireAdmin_(p);
  var sheet = getOrCreateSheet_(USERS_SHEET, USERS_HEADERS);
  var data = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][4] === 'pending') {
      list.push({ username: data[i][0], createdAt: data[i][5] instanceof Date ? formatDate_(data[i][5]) : String(data[i][5]) });
    }
  }
  return { ok: true, users: list };
}

function actionListUsers_(p) {
  requireAdmin_(p);
  var sheet = getOrCreateSheet_(USERS_SHEET, USERS_HEADERS);
  var data = sheet.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    list.push({
      username: r[0],
      role: r[3],
      status: r[4],
      createdAt: r[5] instanceof Date ? formatDate_(r[5]) : String(r[5]),
      approvedBy: r[6],
      approvedAt: r[7] instanceof Date ? formatDate_(r[7]) : String(r[7])
    });
  }
  return { ok: true, users: list };
}

function actionApproveUser_(p) {
  var admin = requireAdmin_(p);
  var sheet = getOrCreateSheet_(USERS_SHEET, USERS_HEADERS);
  var data = sheet.getDataRange().getValues();
  var username = normalizeUsername_(p.username);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username) {
      sheet.getRange(i + 1, 5).setValue('approved');
      sheet.getRange(i + 1, 7).setValue(admin.u);
      sheet.getRange(i + 1, 8).setValue(new Date());
      return { ok: true };
    }
  }
  return { ok: false, error: 'user_not_found' };
}

function actionChangePassword_(p) {
  var user = requireAuth_(p);
  var oldPassword = p.oldPassword || '';
  var newPassword = p.newPassword || '';
  if (!newPassword || newPassword.length < 6) return { ok: false, error: 'password_too_short' };

  var sheet = getOrCreateSheet_(USERS_SHEET, USERS_HEADERS);
  var data = sheet.getDataRange().getValues();
  var username = normalizeUsername_(user.u);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username) {
      var salt = data[i][1];
      var hash = data[i][2];
      if (hashPassword_(oldPassword, salt) !== hash) return { ok: false, error: 'invalid_old_password' };
      var newSalt = Utilities.getUuid();
      var newHash = hashPassword_(newPassword, newSalt);
      sheet.getRange(i + 1, 2).setValue(newSalt);
      sheet.getRange(i + 1, 3).setValue(newHash);
      return { ok: true };
    }
  }
  return { ok: false, error: 'user_not_found' };
}

function actionRejectUser_(p) {
  var admin = requireAdmin_(p);
  var sheet = getOrCreateSheet_(USERS_SHEET, USERS_HEADERS);
  var data = sheet.getDataRange().getValues();
  var username = normalizeUsername_(p.username);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === username) {
      sheet.getRange(i + 1, 5).setValue('rejected');
      sheet.getRange(i + 1, 7).setValue(admin.u);
      sheet.getRange(i + 1, 8).setValue(new Date());
      return { ok: true };
    }
  }
  return { ok: false, error: 'user_not_found' };
}
