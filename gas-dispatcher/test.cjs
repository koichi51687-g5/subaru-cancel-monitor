// Offline tests of Code.gs. No real GitHub, Google, or Gmail credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
const start = Date.parse('2026-11-20T14:00:00Z');
let now = start, latestSuccess = 0, failDispatch = false, failMail = false;
let posts = [], emails = [], triggers = [];
const props = new Map([['GITHUB_TOKEN', 'dummy-token'], ['ALERT_EMAIL', 'me@example.com']]);

class FakeDate extends Date { static now() { return now; } }
const propertyObject = {
  getProperty: key => props.get(key) ?? null,
  setProperty: (key, value) => props.set(key, value),
  deleteProperty: key => props.delete(key),
};
function reply(code, body) {
  return { getResponseCode: () => code, getContentText: () => body };
}
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
  MailApp: {
    sendEmail(message) {
      if (failMail) throw Error('simulated email service failure');
      emails.push(message);
    },
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
      if (url.includes('/dispatches')) return reply(failDispatch ? 403 : 204, '');
      throw Error('Unexpected URL: ' + url);
    },
  },
};
vm.runInNewContext(code, ctx, { filename: 'Code.gs' });

ctx.testEmailNotification();
assert.equal(emails.length, 1);
assert.match(emails[0].subject, /Gmailテスト/);
assert.equal(emails[0].to, 'me@example.com');
ctx.testGitHubConnection();
assert.equal(posts.filter(x => x.url.endsWith('/dispatches')).length, 1);
assert.equal(JSON.parse(posts.find(x => x.url.endsWith('/dispatches')).options.payload).inputs.dry_run, 'true');

ctx.setupMonitor();
ctx.setupMonitor();
assert.equal(triggers.length, 1);
assert.equal(triggers[0].minutes, 15);

posts = [];
ctx.monitorTick();
assert.equal(JSON.parse(posts.find(x => x.url.endsWith('/dispatches')).options.payload).inputs.dry_run, 'false');

now = start + 46 * 60 * 1000;
posts = []; emails = [];
ctx.monitorTick();
assert.equal(emails.length, 1);
assert.match(emails[0].subject, /異常/);
assert.equal(posts.filter(x => x.url.endsWith('/dispatches')).length, 1);

posts = []; emails = [];
ctx.monitorTick();
assert.equal(emails.length, 0);

latestSuccess = now - 30 * 1000;
posts = []; emails = [];
ctx.monitorTick();
assert.equal(emails.length, 1);
assert.match(emails[0].subject, /復旧/);
assert.equal(props.has('MONITOR_ALERTED'), false);

failDispatch = true;
posts = []; emails = [];
assert.throws(() => ctx.monitorTick(), /HTTP 403/);
assert.equal(emails.length, 1);
assert.match(emails[0].subject, /異常/);
failDispatch = false;

// Regression: a Gmail outage must not prevent a real availability check.
props.delete('MONITOR_ALERTED');
latestSuccess = 0;
now = start + 47 * 60 * 1000;
failMail = true;
posts = [];
assert.doesNotThrow(() => ctx.monitorTick());
assert.equal(posts.filter(x => x.url.endsWith('/dispatches')).length, 1);
failMail = false;

now = Date.parse('2027-01-11T00:00:00Z');
posts = [];
ctx.monitorTick();
assert.equal(triggers.length, 0);
assert.equal(posts.filter(x => x.url.endsWith('/dispatches')).length, 0);

console.log('GAS scheduler tests: PASS');
