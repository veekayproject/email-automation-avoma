import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';
import { approveAndSend } from '../src/services/processor.js';
import { getDraftByMeeting, getMeeting } from '../src/db.js';

let server; let base;
test.before(() => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

test('health endpoint is ready', async () => {
  const response = await fetch(`${base}/health`); assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
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

function externalMeeting(id) {
  return { event: 'meeting.analysis.ready', data: { meeting: {
    id, title: 'Discovery call', start_at: '2026-07-16T10:00:00Z',
    owner: { name: 'Avery AE', email: 'avery@company.test' },
    participants: [{ name: 'Avery AE', email: 'avery@company.test' }, { name: 'Casey Customer', email: 'customer@outside.test', company: 'Outside Co' }],
    summary: 'Casey wants a faster reviewed follow-up process.', action_items: ['Avery will share a pilot plan.']
  } } };
}
function request(payload) { return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }; }
async function waitFor(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('Timed out waiting for workflow');
}
