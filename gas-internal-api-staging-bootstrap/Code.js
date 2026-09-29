/**
 * One-time staging bootstrap. This source is pushed only to the isolated
 * staging Script ID and is replaced by gas-internal-api before web deployment.
 * It never creates a trigger and never reads or modifies Production data.
 */
function initializeStagingEnvironment() {
  if (ScriptApp.getProjectTriggers().length !== 0) {
    throw new Error('staging bootstrap refuses to run while triggers exist');
  }

  const properties = PropertiesService.getScriptProperties();
  const existingSpreadsheetId = properties.getProperty('CALENDAR_SPREADSHEET_ID');
  const existingMarker = properties.getProperty('STAGING_ENVIRONMENT');
  if (existingSpreadsheetId && existingMarker === 'danpro-calendar-internal-staging') {
    return { ok: true, created: false, triggerCount: 0 };
  }

  const spreadsheet = SpreadsheetApp.create('danpro-calendar-internal-staging-data');
  const sheet = spreadsheet.getSheets()[0];
  sheet.setName('検証用スケジュール');
  const values = Array.from({ length: 5 }, () => Array(15).fill(''));
  values[1][13] = '2026/10/01';
  values[1][14] = '2026/10/02';
  values[2][4] = '検証顧客A';
  values[2][7] = '検証商品A';
  values[2][12] = 'AM';
  values[2][13] = '印刷';
  values[3][4] = '検証顧客B';
  values[3][7] = '検証商品B';
  values[3][12] = 'PM';
  values[3][14] = '梱包';
  values[4][0] = '案件数';
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);

  properties.setProperties({
    INTERNAL_GAS_SIGNING_SECRET: createStagingSecret_('request-signing'),
    ACCESS_POLICY_HMAC_SECRET: createStagingSecret_('access-policy'),
    CALENDAR_SPREADSHEET_ID: spreadsheet.getId(),
    STAGING_ENVIRONMENT: 'danpro-calendar-internal-staging',
  }, false);
  return { ok: true, created: true, triggerCount: 0 };
}

function getStagingEnvironmentStatus() {
  const properties = PropertiesService.getScriptProperties();
  return {
    ok: true,
    configured: properties.getProperty('STAGING_ENVIRONMENT')
      === 'danpro-calendar-internal-staging',
    hasSigningSecret: Boolean(properties.getProperty('INTERNAL_GAS_SIGNING_SECRET')),
    hasAccessPolicySecret: Boolean(properties.getProperty('ACCESS_POLICY_HMAC_SECRET')),
    hasSpreadsheet: Boolean(properties.getProperty('CALENDAR_SPREADSHEET_ID')),
    triggerCount: ScriptApp.getProjectTriggers().length,
  };
}

function createStagingSecret_(purpose) {
  const material = [
    purpose,
    Utilities.getUuid(),
    Utilities.getUuid(),
    Utilities.getUuid(),
    new Date().toISOString(),
  ].join(':');
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    material,
    Utilities.Charset.UTF_8,
  )).replace(/=+$/, '');
}
