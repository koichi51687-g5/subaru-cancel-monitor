/**
 * SUBARU factory tour cancellation monitor: external GitHub Actions scheduler.
 * Create a private, standalone Google Apps Script project and paste this file.
 * Store GITHUB_TOKEN and ALERT_EMAIL in Project Settings > Script properties.
 */

const SUBARU = Object.freeze({
  owner: 'koichi51687-g5',
  repo: 'subaru-cancel-monitor',
  workflow: 'monitor.yml',
  branch: 'main',
  endUtc: Date.parse('2027-01-11T00:00:00Z'), // 2027-01-11 09:00 JST
  maxWithoutSuccessMs: 45 * 60 * 1000,
  runFunction: 'monitorTick',
});

const PROPS = Object.freeze({
  token: 'GITHUB_TOKEN',
  email: 'ALERT_EMAIL',
  start: 'MONITOR_STARTED_AT',
  alerted: 'MONITOR_ALERTED',
});

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(PROPS.token) || '';
  const email = (props.getProperty(PROPS.email) || '').trim();
  if (!token) throw new Error('Script property GITHUB_TOKEN is missing');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Script property ALERT_EMAIL is missing or invalid');
  }
  return { props, token, email };
}

function github_(token, path, method, payload) {
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
  };
  if (payload !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  const url = 'https://api.github.com/repos/' + SUBARU.owner + '/' + SUBARU.repo + path;
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    // Do not print headers or the token: error responses are sufficient.
    throw new Error('GitHub API ' + method.toUpperCase() + ' failed: HTTP ' + code);
  }
  return res.getContentText();
}

function dispatchRun_(token, dryRun) {
  github_(token, '/actions/workflows/' + SUBARU.workflow + '/dispatches', 'post', {
    ref: SUBARU.branch,
    // The GitHub workflow defaults to dry_run=true. Production MUST send false.
    inputs: { dry_run: dryRun ? 'true' : 'false' },
  });
}

function lastGoodRun_(token) {
  const json = github_(token, '/actions/workflows/' + SUBARU.workflow + '/runs?per_page=30', 'get');
  const data = JSON.parse(json);
  if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid GitHub runs response');
  const runs = data.workflow_runs.filter(function (run) {
    return (run.event === 'workflow_dispatch' || run.event === 'schedule') &&
      run.status === 'completed' && run.conclusion === 'success';
  });
  return runs.reduce(function (latest, run) {
    const finished = Date.parse(run.updated_at || run.created_at);
    return Number.isFinite(finished) ? Math.max(latest, finished) : latest;
  }, 0);
}

/** Send only monitoring-health messages by Gmail; booking alerts stay in GitHub Actions. */
function mail_(cfg, title, message) {
  MailApp.sendEmail({
    to: cfg.email,
    subject: title,
    body: message + '\n実行履歴: https://github.com/' + SUBARU.owner + '/' + SUBARU.repo + '/actions',
    name: 'SUBARU空席監視',
  });
}

function alertOnce_(cfg, reason) {
  if (cfg.props.getProperty(PROPS.alerted) === '1') return;
  mail_(cfg, 'SUBARU空席監視：異常', reason);
  cfg.props.setProperty(PROPS.alerted, '1');
}

/** Alert failures must never prevent the next real reservation check. */
function safeAlert_(cfg, reason) {
  try {
    alertOnce_(cfg, reason);
  } catch (e) {
    console.error('Health email could not be delivered: ' + e.message);
  }
}

function clearAlert_(cfg) {
  if (cfg.props.getProperty(PROPS.alerted) !== '1') return;
  cfg.props.deleteProperty(PROPS.alerted);
  try {
    mail_(cfg, 'SUBARU空席監視：復旧', '監視ジョブの正常終了を再び確認しました。');
  } catch (e) {
    console.error('Recovery email could not be delivered: ' + e.message);
  }
}

/** Test GitHub authorization without sending an availability notification. */
function testGitHubConnection() {
  const cfg = getConfig_();
  if (Date.now() >= SUBARU.endUtc) throw new Error('Monitoring period has expired');
  dispatchRun_(cfg.token, true);
  console.log('Dry-run dispatched. Check the GitHub Actions run log for CLOSED / OPEN.');
}

/** Send a clearly labeled monitoring-health test email. It is NOT an availability alert. */
function testEmailNotification() {
  const cfg = getConfig_();
  mail_(cfg, 'SUBARU空席監視：Gmailテスト（空席ではありません）',
        'Apps Scriptからの障害通知テストです。空席が発生したという意味ではありません。');
  console.log('Health test email sent');
}

/** Run once manually after both Gmail and GitHub tests succeed. Does not create duplicate triggers. */
function setupMonitor() {
  getConfig_();
  if (Date.now() >= SUBARU.endUtc) throw new Error('Monitoring period has expired');
  const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === SUBARU.runFunction;
  });
  if (existing.length) {
    console.log('15-minute trigger already exists. No changes made.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty(PROPS.start, String(Date.now()));
  ScriptApp.newTrigger(SUBARU.runFunction).timeBased().everyMinutes(15).create();
  console.log('15-minute trigger created. First run will be automatic.');
}

/** Installed 15-minute trigger. Checks health and requests a real availability check. */
function monitorTick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    if (Date.now() >= SUBARU.endUtc) {
      stopMonitor();
      console.log('Monitoring ended automatically at 2027-01-11 09:00 JST');
      return;
    }

    const cfg = getConfig_();
    try {
      const now = Date.now();
      const started = Number(cfg.props.getProperty(PROPS.start)) || now;
      const latestSuccess = lastGoodRun_(cfg.token);
      const lastRelevantSuccess = latestSuccess >= started ? latestSuccess : 0;

      if (lastRelevantSuccess && now - lastRelevantSuccess <= SUBARU.maxWithoutSuccessMs) {
        clearAlert_(cfg);
      } else if (now - Math.max(started, lastRelevantSuccess) >= SUBARU.maxWithoutSuccessMs) {
        safeAlert_(cfg, '45分以上、空席確認ジョブの正常終了を確認できません。');
      }

      dispatchRun_(cfg.token, false);
      console.log('Production monitoring run requested at ' + new Date(now).toISOString());
    } catch (e) {
      // This notification originates outside GitHub, so even a GitHub outage is visible.
      safeAlert_(cfg, '監視ジョブを起動・確認できません: ' + e.message);
      throw e;
    }
  } finally {
    lock.releaseLock();
  }
}

/** Run manually to pause, or automatically after the tour start time. */
function stopMonitor() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === SUBARU.runFunction) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  console.log('SUBARU 15-minute GAS triggers removed');
}
