// Local, offline tests for Code.gs (no Google/GitHub/ntfy credentials needed).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
const start = Date.parse('2026-11-20T14:00:00Z');
let now = start;
let latestSuccess = 0;
let posts = [];
let triggers = [];
let failDispatch = false;
let props = new Map([
  ['GITHUB_TOKEN', 'fake-github-token'],
  ['NTFY_TOPIC', 'a-random-test-topic-1234567890'],
]);

class FakeDate extends Date {
  static now() { return now; }
}
const propertyObject = {
  getProperty: key => props.get(key) ?? null,
  setProperty: (key, value) => props.set(key, value),
  deleteProperty: key => props.delete(key),
};
const ctx = {
  Date: FakeDate,
  console: { log() {}, error() {} },
  PropertiesService: { getScriptProperties: () => propertyObject },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  ScriptApp: {
    getProjectTriggers: () => triggers,
    deleteTrigger: t => { triggers = triggers.filter(x => x !== t); },
    newTrigger: handler => ({
      timeBased: () => ({
        everyMinutes: mins => ({
          create() { triggers.push({ getHandlerFunction: () => handler, minutes: mins }); },
        }),
      }),
    }),
  },
  UrlFetchApp: {
    fetch(url, options) {
      posts.push({ url, options });
      if (url.includes('/actions/workflows/monitor.yml/runs?')) {
        return reply(200, JSON.stringify({ workflow_runs: latestSuccess ? [{
          event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
          updated_at: new Date(latestSuccess).toISOString(),
        }] : [] }));
      }
      if (url.includes('/dispatches')) {
        return reply(failDispatch ? 403 : 204, '');
      }
      if (url === 'https://ntfy.sh/') return reply(200, '{}');
      throw new Error('Unexpected URL: ' + url);
    },
  },
};
function reply(code, body) { return { getResponseCode: () => code, getContentText: () => body }; }

vm.runInNewContext(code, ctx, { filename: 'Code.gs' });

// Both self-tests should be explicitly labeled, and no production dispatch occurs.
ctx.testNtfyNotification();
ctx.testGitHubConnection();
assert.equal(posts.filter(x => x.url.endsWith('/dispatches')).length, 1);
assert.equal(JSON.parse(posts.find(x => x.url.endsWith('/dispatches')).options.payload).inputs.dry_run, 'true');
assert.match(posts.find(x => x.url === 'https://ntfy.sh/').options.payload, /テスト/);

// Setup is idempotent and schedules once every 15 minutes.
ctx.setupMonitor();
ctx.setupMonitor();
assert.equal(triggers.length, 1);
assert.equal(triggers[0].minutes, 15);

// Triggering calls GitHub with dry_run=false (required for real availability alerts).
posts = [];
ctx.monitorTick();
assert.equal(JSON.parse(posts.find(x => x.url.endsWith('/dispatches')).options.payload).inputs.dry_run, 'false');

// When no successful monitoring run has happened for >45 minutes, alert only once.
now = start + 46 * 60 * 1000;
posts = [];
ctx.monitorTick();
assert.equal(posts.filter(x => x.url === 'https://ntfy.sh/').length, 1);
posts = [];
ctx.monitorTick();
assert.equal(posts.filter(x => x.url === 'https://ntfy.sh/').length, 0);

// A fresh completed success clears alert state and sends one recovery message.
latestSuccess = now - 30 * 1000;
posts = [];
ctx.monitorTick();
assert.equal(posts.filter(x => x.url === 'https://ntfy.sh/').length, 1);
assert.equal(props.has('MONITOR_ALERTED'), false);

// GitHub rejection produces an independent alarm and propagates the failure.
failDispatch = true;
posts = [];
assert.throws(() => ctx.monitorTick(), /HTTP 403/);
assert.equal(posts.filter(x => x.url === 'https://ntfy.sh/').length, 1);
failDispatch = false;

// Expiry prevents dispatch and deletes all installed monitor triggers.
now = Date.parse('2027-01-11T00:00:00Z');
posts = [];
ctx.monitorTick();
assert.equal(triggers.length, 0);
assert.equal(posts.filter(x => x.url.endsWith('/dispatches')).length, 0);

console.log('GAS scheduler tests: PASS');
