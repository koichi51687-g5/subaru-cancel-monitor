/**
 * SUBARU factory tour cancellation monitor: external GitHub Actions scheduler.
 * Create a private, standalone Google Apps Script project and paste this file.
 * Store GITHUB_TOKEN and NTFY_TOPIC in Project Settings > Script properties.
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
  topic: 'NTFY_TOPIC',
  start: 'MONITOR_STARTED_AT',
  alerted: 'MONITOR_ALERTED',
});

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty(PROPS.token) || '';
  const topic = props.getProperty(PROPS.topic) || '';
  if (!token) throw new Error('Script property GITHUB_TOKEN is missing');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(topic)) {
    throw new Error('Script property NTFY_TOPIC is missing or invalid');
  }
  return { props, token, topic };
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

function ntfy_(topic, title, message, priority) {
  const res = UrlFetchApp.fetch('https://ntfy.sh/', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      topic: topic,
      title: title,
      message: message,
      priority: priority,
      click: 'https://github.com/' + SUBARU.owner + '/' + SUBARU.repo + '/actions',
    }),
  });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    throw new Error('ntfy alert failed: HTTP ' + res.getResponseCode());
  }
}

function alertOnce_(cfg, reason) {
  if (cfg.props.getProperty(PROPS.alerted) === '1') return;
  ntfy_(cfg.topic, 'SUBARU空席監視：異常', reason + '\nGitHubの実行履歴を確認してください。', 4);
  cfg.props.setProperty(PROPS.alerted, '1');
}

function clearAlert_(cfg) {
  if (cfg.props.getProperty(PROPS.alerted) !== '1') return;
  cfg.props.deleteProperty(PROPS.alerted);
  try {
    ntfy_(cfg.topic, 'SUBARU空席監視：復旧', '監視ジョブの正常終了を再び確認しました。', 3);
  } catch (e) {
    console.error('Recovery alert could not be delivered: ' + e.message);
  }
}

/** Test GitHub authorization without sending an availability notification. */
function testGitHubConnection() {
  const cfg = getConfig_();
  if (Date.now() >= SUBARU.endUtc) throw new Error('Monitoring period has expired');
  dispatchRun_(cfg.token, true);
  console.log('Dry-run dispatched. Check the GitHub Actions run log for CLOSED / OPEN.');
}

/** Send a clearly labeled test notification to the same ntfy topic as the monitor. */
function testNtfyNotification() {
  const cfg = getConfig_();
  ntfy_(cfg.topic, 'SUBARU監視：テスト', 'GASからの異常通知テストです。空席発生ではありません。', 3);
  console.log('Test alert sent');
}

/** Run once manually after both tests succeed. Does not create duplicate triggers. */
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
        alertOnce_(cfg, '45分以上、空席確認ジョブの正常終了を確認できません。');
      }

      dispatchRun_(cfg.token, false);
      console.log('Production monitoring run requested at ' + new Date(now).toISOString());
    } catch (e) {
      // This notification originates outside GitHub, so even a GitHub outage is visible.
      try { alertOnce_(cfg, '監視ジョブを起動・確認できません: ' + e.message); }
      catch (notifyError) { console.error('Failed to alert: ' + notifyError.message); }
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
