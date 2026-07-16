import crypto from 'node:crypto';
import express from 'express';
import { config, integrationStatus } from './config.js';
import { audit, getDraftByMeeting, getDraftByToken, getMeeting, listAudit, listMeetings, updateDraft, updateMeeting } from './db.js';
import { safeEqual } from './lib/crypto.js';
import { acceptWebhook, approveAndSend, cancelMeeting, editDraft, processMeeting } from './services/processor.js';
import { demoMeeting } from './services/meeting.js';
import { createMicrosoftAuthUrl, completeMicrosoftAuth, listMicrosoftAccounts } from './services/microsoft.js';
import { downloadSlackFiles, extractModalValues, openEditModal, verifySlackRequest } from './services/slack.js';
import { loadStoredSettings, publicSettings, saveSettings, webhookUrl } from './settings.js';

loadStoredSettings();

export const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'same-origin'); next(); });

app.get('/health', (_req, res) => res.json({ ok: true, service: 'followpilot', time: new Date().toISOString() }));
app.get('/ready', (_req, res) => res.json({ ok: true, integrations: integrationStatus() }));

app.post('/api/webhooks/avoma', express.raw({ type: 'application/json', limit: '5mb' }), async (req, res) => {
  try {
    const raw = req.body.toString('utf8');
    if (!verifyWebhook(req, raw)) return res.status(401).json({ error: 'Invalid webhook secret or signature' });
    const result = await acceptWebhook(JSON.parse(raw));
    res.status(result.duplicate ? 200 : 202).json({ accepted: true, duplicate: result.duplicate, meetingId: result.meeting.id, status: result.meeting.status });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/slack/interactions', express.raw({ type: 'application/x-www-form-urlencoded', limit: '2mb' }), async (req, res) => {
  const raw = req.body.toString('utf8');
  if (!verifySlackRequest(raw, req.get('x-slack-request-timestamp'), req.get('x-slack-signature'))) return res.status(401).send('Invalid Slack signature');
  let payload;
  try { payload = JSON.parse(new URLSearchParams(raw).get('payload')); } catch { return res.status(400).send('Invalid payload'); }
  res.status(200).send('');
  handleSlack(payload).catch((error) => payload.user?.id && audit(null, 'slack_action_failed', { error: error.message }, payload.user.id));
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/auth/microsoft/start', adminAuth, (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email.includes('@')) return res.status(400).send('Add a valid ?email= address');
    res.redirect(createMicrosoftAuthUrl(email));
  } catch (error) { res.status(400).send(pageMessage('Could not start Microsoft sign-in', error.message)); }
});
app.get('/auth/microsoft/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const account = await completeMicrosoftAuth(String(req.query.code || ''), String(req.query.state || ''));
    res.send(pageMessage('Microsoft account connected', `${account.displayName || account.email} can now send approved follow-ups.`));
  } catch (error) { res.status(400).send(pageMessage('Microsoft sign-in failed', error.message)); }
});

app.post('/api/demo', adminAuth, async (_req, res) => {
  try { const result = await acceptWebhook(demoMeeting()); res.status(202).json(result); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/config', adminAuth, (_req, res) => res.json({
  appBaseUrl: config.APP_BASE_URL, webhookUrl: webhookUrl(),
  integrations: integrationStatus(), internalDomains: config.internalDomains, accounts: listMicrosoftAccounts()
}));
app.get('/api/settings', adminAuth, (_req, res) => res.json({ ...publicSettings(), accounts: listMicrosoftAccounts() }));
app.post('/api/settings', adminAuth, (req, res) => {
  try {
    const result = saveSettings(req.body, 'dashboard');
    res.json({ ...result, accounts: listMicrosoftAccounts(), reauthenticate: Boolean(req.body.ADMIN_PASSWORD) });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/meetings', adminAuth, (_req, res) => res.json({ meetings: listMeetings() }));
app.get('/api/meetings/:id', adminAuth, (req, res) => {
  const meeting = getMeeting(req.params.id); if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  res.json({ meeting, draft: getDraftByMeeting(meeting.id), audit: listAudit(meeting.id) });
});
app.post('/api/meetings/:id/retry', adminAuth, async (req, res) => {
  try { await processMeeting(req.params.id, { regenerate: Boolean(req.body.regenerate) }); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/audit', adminAuth, (_req, res) => res.json({ audit: listAudit() }));

app.get('/review/:token', (req, res) => {
  const draft = getDraftByToken(req.params.token); if (!draft) return res.status(404).send(pageMessage('Link not found', 'This review link is invalid or expired.'));
  const meeting = getMeeting(draft.meeting_id); res.send(reviewPage(meeting, draft));
});
app.post('/review/:token/save', async (req, res) => {
  try {
    const draft = getDraftByToken(req.params.token); if (!draft) throw new Error('Review link not found');
    await editDraft(draft.meeting_id, { subject: req.body.subject, body: req.body.body, recipient: req.body.recipient, cc: split(req.body.cc), bcc: split(req.body.bcc) }, 'web reviewer');
    res.redirect(`/review/${req.params.token}?saved=1`);
  } catch (error) { res.status(400).send(pageMessage('Could not save draft', error.message)); }
});
app.post('/review/:token/send', async (req, res) => {
  try { const draft = getDraftByToken(req.params.token); if (!draft) throw new Error('Review link not found'); await approveAndSend(draft.meeting_id, 'web reviewer'); res.redirect(`/review/${req.params.token}`); }
  catch (error) { res.status(400).send(pageMessage('Could not send email', error.message)); }
});

app.use('/assets', express.static(new URL('../public', import.meta.url).pathname, { maxAge: config.NODE_ENV === 'production' ? '1h' : 0 }));
app.get('/', adminAuth, (_req, res) => res.sendFile(new URL('../public/index.html', import.meta.url).pathname));
app.use((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: config.NODE_ENV === 'production' ? 'Unexpected server error' : error.message }); });

async function handleSlack(payload) {
  if (payload.type === 'view_submission' && payload.view.callback_id === 'edit_draft') {
    const meetingId = payload.view.private_metadata; const values = extractModalValues(payload.view);
    const attachments = await downloadSlackFiles(values.fileIds);
    await editDraft(meetingId, { recipient: values.recipient, cc: values.cc, bcc: values.bcc, subject: values.subject, body: values.body, attachments }, payload.user.id);
    return;
  }
  if (payload.type !== 'block_actions') return;
  const action = payload.actions[0]; const meetingId = action.value; const actor = payload.user?.id || 'slack';
  const meeting = getMeeting(meetingId); const draft = getDraftByMeeting(meetingId);
  if (!meeting || !draft) throw new Error('Draft not found');
  if (action.action_id === 'edit_draft') return openEditModal(payload.trigger_id, meeting, draft);
  if (action.action_id === 'send_email') return approveAndSend(meetingId, actor);
  if (action.action_id === 'regenerate') return processMeeting(meetingId, { regenerate: true });
  if (action.action_id === 'cancel') return cancelMeeting(meetingId, actor);
}

function verifyWebhook(req, raw) {
  if (!config.AVOMA_WEBHOOK_SECRET) return config.demoMode;
  const supplied = req.query.secret || req.get('x-webhook-secret') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (safeEqual(supplied, config.AVOMA_WEBHOOK_SECRET)) return true;
  const signature = req.get('x-avoma-signature') || req.get('x-webhook-signature');
  const expected = crypto.createHmac('sha256', config.AVOMA_WEBHOOK_SECRET).update(raw).digest('hex');
  return safeEqual(String(signature || '').replace(/^sha256=/, ''), expected);
}
function adminAuth(req, res, next) {
  if (!config.ADMIN_PASSWORD) return next();
  const auth = Buffer.from((req.get('authorization') || '').replace('Basic ', ''), 'base64').toString().split(':');
  if (safeEqual(auth[1], config.ADMIN_PASSWORD)) return next();
  res.set('WWW-Authenticate', 'Basic realm="FollowPilot"'); res.status(401).send('Authentication required');
}
const split = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
const esc = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' })[c]);
const pageMessage = (title, message) => `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/assets/styles.css"><main class="center-card"><div class="logo">F</div><h1>${esc(title)}</h1><p>${esc(message)}</p><a class="button" href="/">Return to dashboard</a></main>`;
function reviewPage(meeting, draft) {
  const final = ['sent','cancelled'].includes(meeting.status);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Review · FollowPilot</title><link rel="stylesheet" href="/assets/styles.css"></head><body><main class="review-shell"><p class="eyebrow">FOLLOWPILOT · ${esc(meeting.status.replaceAll('_',' '))}</p><h1>Review follow-up to ${esc(meeting.prospect_name || draft.recipient)}</h1><p class="muted">${esc(meeting.title)} · ${esc(meeting.owner_name || meeting.owner_email)}</p><form method="post" action="/review/${esc(draft.review_token)}/save"><label>To<input name="recipient" value="${esc(draft.recipient)}" required></label><div class="row"><label>CC<input name="cc" value="${esc(draft.cc.join(', '))}"></label><label>BCC<input name="bcc" value="${esc(draft.bcc.join(', '))}"></label></div><label>Subject<input name="subject" value="${esc(draft.subject)}" required></label><label>Message<textarea name="body" rows="16" required>${esc(draft.body)}</textarea></label><div class="actions"><button ${final?'disabled':''}>Save changes</button></div></form><form method="post" action="/review/${esc(draft.review_token)}/send" class="send-form"><button class="primary" ${final?'disabled':''}>Send through Outlook</button></form><p class="notice">Email will only send when you press the send button. ${draft.attachments.length ? `${draft.attachments.length} attachment(s) included.` : ''}</p></main></body></html>`;
}
