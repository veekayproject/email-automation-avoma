import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { approveAndSend } from '../src/services/processor.js';
import { detectPricingDiscussion } from '../src/services/generator.js';
import { normalizeWebhook } from '../src/services/meeting.js';
import { db, getDraftByMeeting, getMeeting } from '../src/db.js';

let server; let base;
test.before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

test('health endpoint is ready', async () => {
  const response = await fetch(`${base}/health`); assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('dashboard assets use relative paths for reverse-proxy path hosting', async () => {
  const response = await fetch(`${base}/`); const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<base href="\.\/">/);
  assert.match(html, /src="assets\/app\.js"/);
  assert.doesNotMatch(html, /src="\/assets\/app\.js"/);
});

test('server-generated pages honor the configured public path', async () => {
  const previous = config.basePath; config.basePath = '/followpilot';
  const response = await fetch(`${base}/review/missing-token`); const html = await response.text();
  config.basePath = previous;
  assert.equal(response.status, 404);
  assert.match(html, /href="\/followpilot\/assets\/styles\.css"/);
  assert.match(html, /href="\/followpilot\/"/);
});

test('webhook creates one grounded review draft and rejects duplicates', async () => {
  const payload = externalMeeting('meeting-duplicate');
  const first = await fetch(`${base}/api/webhooks/avoma`, request(payload));
  assert.equal(first.status, 202);
  await waitFor(() => getMeeting(payload.data.meeting.id)?.status === 'waiting_review');
  const duplicate = await fetch(`${base}/api/webhooks/avoma`, request(payload));
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  const draft = getDraftByMeeting(payload.data.meeting.id);
  assert.match(draft.subject, /Next steps/);
  assert.equal(draft.recipient, 'customer@outside.test');
});

test('internal-only meetings are ignored', async () => {
  const payload = externalMeeting('meeting-internal');
  payload.data.meeting.participants[1].email = 'colleague@company.test';
  await fetch(`${base}/api/webhooks/avoma`, request(payload));
  await waitFor(() => getMeeting(payload.data.meeting.id)?.status === 'ignored');
  assert.match(getMeeting(payload.data.meeting.id).status_reason, /No external participant/);
  assert.equal(getDraftByMeeting(payload.data.meeting.id), null);
});

test('email cannot send twice and records approval in demo mode', async () => {
  const id = 'meeting-send'; const payload = externalMeeting(id);
  await fetch(`${base}/api/webhooks/avoma`, request(payload));
  await waitFor(() => getMeeting(id)?.status === 'waiting_review');
  await approveAndSend(id, 'test-reviewer');
  assert.equal(getMeeting(id).status, 'sent');
  assert.ok(getDraftByMeeting(id).sent_at);
  await assert.rejects(() => approveAndSend(id, 'second-reviewer'), /cannot be sent/);
});

test('dashboard settings persist secrets without returning plaintext', async () => {
  const saved = await fetch(`${base}/api/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ OPENAI_API_KEY: 'test-secret-key', EMAIL_TONE: 'clear and friendly' })
  });
  assert.equal(saved.status, 200);
  const response = await fetch(`${base}/api/settings`); const settings = await response.json();
  assert.equal(settings.values.EMAIL_TONE, 'clear and friendly');
  assert.equal(settings.configuredSecrets.OPENAI_API_KEY, true);
  assert.equal(JSON.stringify(settings).includes('test-secret-key'), false);
  const stored = db.prepare('SELECT value FROM app_settings WHERE key=?').get('OPENAI_API_KEY');
  assert.equal(stored.value.includes('test-secret-key'), false);
});

test('pricing router ignores explicit no-pricing language and detects actual commercials', () => {
  assert.deepEqual(detectPricingDiscussion({ notes: 'Pricing was not discussed in this meeting.' }), { discussed: false, evidence: [] });
  const priced = detectPricingDiscussion({ summary: 'We discussed Vieu Core at $12.5K/year for 1,000 accounts.' });
  assert.equal(priced.discussed, true);
  assert.match(priced.evidence[0], /12\.5K\/year/);
});

test('custom webhook paths map a non-Avoma payload', () => {
  const previous = config.webhookFieldMap;
  config.webhookFieldMap = { id: 'call.uuid', recipient_email: 'call.customer.email', summary: 'call.ai.summary' };
  const meeting = normalizeWebhook({ event: 'call.completed', call: { uuid: 'mapped-1', customer: { email: 'buyer@example.com' }, ai: { summary: 'Mapped summary' } } });
  assert.equal(meeting.id, 'mapped-1');
  assert.equal(meeting.recipientEmail, 'buyer@example.com');
  assert.equal(meeting.summary, 'Mapped summary');
  config.webhookFieldMap = previous;
});

test('Test Lab returns mapped fields and an editable conditional draft', async () => {
  const payload = externalMeeting('meeting-preview');
  payload.data.meeting.notes = 'Pricing was not discussed.';
  const response = await fetch(`${base}/api/test/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload })
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.mapping.recipient_email, 'customer@outside.test');
  assert.equal(preview.pricing.discussed, false);
  assert.equal(preview.draft.template_type, 'no_pricing');
  assert.match(preview.draft.body, /Hi Casey/);
});

test('Slack Test Lab is not blocked by Demo mode', async () => {
  const response = await fetch(`${base}/api/test/slack`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: externalMeeting('meeting-slack-test'), draft: {} })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Save the Slack bot token and signing secret first');
});

function externalMeeting(id) {
  return { event: 'meeting.analysis.ready', data: { meeting: {
    id, title: 'Discovery call', start_at: '2026-07-16T10:00:00Z',
    owner: { name: 'Avery AE', email: 'avery@company.test' },
    participants: [{ name: 'Avery AE', email: 'avery@company.test' }, { name: 'Casey Customer', email: 'customer@outside.test', company: 'Outside Co' }],
    summary: 'Casey wants a faster reviewed follow-up process.', action_items: ['Avery will share a pilot plan.']
  } } };
}
function request(payload) { return { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': config.AVOMA_WEBHOOK_SECRET }, body: JSON.stringify(payload) }; }
async function waitFor(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('Timed out waiting for workflow');
}
