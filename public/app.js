const $ = (selector) => document.querySelector(selector);
let config;
let settingsLoaded = false;
let lastTestPayload = null;
let lastTestDraft = null;

const noPricingPayload = {
  event:'meeting.analysis.ready', data:{ meeting:{ id:'test-no-pricing', title:'Calliope <> Vieu | Post Meeting', start_at:new Date().toISOString(), owner:{name:'Shivang Sood',email:'shivang@vieu.com'}, participants:[{name:'Shivang Sood',email:'shivang@vieu.com'},{name:'Craig',email:'craig@calliope.example',company:'Calliope'}], summary:'Discussed a custom demo and the information needed to configure target-account connections.', notes:'Craig will share ideal target-account criteria, important signals, and a list of introducers. Pricing was not discussed.', action_items:['Craig to share target account criteria and introducer LinkedIn URLs'], url:'https://app.avoma.com/meetings/example-no-pricing' } }
};
const pricingPayload = {
  event:'meeting.analysis.ready', data:{ meeting:{ id:'test-pricing', title:'Gail <> Vieu | Post Meeting', start_at:new Date().toISOString(), owner:{name:'Shivang Sood',email:'shivang@vieu.com'}, participants:[{name:'Shivang Sood',email:'shivang@vieu.com'},{name:'Vlad',email:'vlad@gail.example',company:'Gail'}], summary:'Discussed the custom demo, Vieu Core pricing of $12.5K per year for 1000 accounts, and the onboarding plan.', notes:'Vlad will share the ICP persona, target-account criteria, and top introducers.', action_items:['Vlad to share ICP and introducer LinkedIn URLs'], url:'https://app.avoma.com/meetings/example-pricing' } }
};

async function load() {
  try {
    const [configData, meetingData] = await Promise.all([api('/api/config'), api('/api/meetings')]);
    config = configData; renderConfig(); renderMeetings(meetingData.meetings);
  } catch (error) { toast(error.message); }
}

function renderConfig() {
  $('#webhook-url').textContent = config.webhookUrl;
  const names = { avoma:'Avoma', openai:'OpenAI', slack:'Slack', microsoft:'Outlook', hubspot:'HubSpot', demoMode:'Demo mode' };
  $('#integrations').innerHTML = Object.entries(config.integrations).map(([key, ready]) => `<div class="integration ${ready ? key === 'demoMode' ? 'demo' : 'ready' : ''}"><span>${names[key]}</span><i></i></div>`).join('');
  $('#account-list').innerHTML = config.accounts.length ? config.accounts.map((a) => `<span class="account-pill">✓ ${escapeHtml(a.email)}</span>`).join('') : '<p class="muted">No Outlook accounts connected yet.</p>';
}

function renderMeetings(meetings) {
  $('#review-count').textContent = meetings.filter((m) => ['waiting_review','edited'].includes(m.status)).length;
  $('#meeting-list').innerHTML = meetings.length ? meetings.map((m) => `<article class="meeting-row" data-id="${escapeHtml(m.id)}"><div class="meeting-main"><strong>${escapeHtml(m.title)}</strong><small>${escapeHtml(m.prospect_company || m.owner_name || 'Meeting received')}</small></div><span>${escapeHtml(m.draft_recipient || m.recipient_email || 'Missing email')}</span><span class="badge ${escapeHtml(m.status)}">${escapeHtml(m.status.replaceAll('_',' '))}</span><span>${relative(m.created_at)}</span></article>`).join('') : '<div class="empty">No meetings yet. Run the sample or send your first webhook.</div>';
  document.querySelectorAll('.meeting-row').forEach((row) => row.addEventListener('click', () => showDetail(row.dataset.id)));
}

async function showDetail(id) {
  try {
    const { meeting, draft, audit } = await api(`/api/meetings/${encodeURIComponent(id)}`);
    $('#detail-content').innerHTML = `<p class="eyebrow">${escapeHtml(meeting.status.replaceAll('_',' '))}</p><h2>${escapeHtml(meeting.title)}</h2><p class="muted">${escapeHtml(meeting.prospect_name || 'Unknown prospect')} · ${escapeHtml(meeting.prospect_company || 'Unknown company')} · ${escapeHtml(meeting.recipient_email || 'No recipient')}</p>${meeting.status_reason ? `<p class="notice">${escapeHtml(meeting.status_reason)}</p>` : ''}${draft ? `<h3>${escapeHtml(draft.subject)}</h3><div class="draft-preview">${escapeHtml(draft.body)}</div><p class="muted">To ${escapeHtml(draft.recipient)}${draft.sent_at ? ` · Sent ${new Date(draft.sent_at).toLocaleString()}` : ''}</p>` : ''}<div class="timeline"><p class="eyebrow">AUDIT TIMELINE</p>${audit.map((item) => `<div class="timeline-item"><p><strong>${escapeHtml(item.event.replaceAll('_',' '))}</strong></p><small>${new Date(item.created_at).toLocaleString()} · ${escapeHtml(item.actor || 'system')}</small></div>`).join('')}</div>`;
    $('#detail-dialog').showModal();
  } catch (error) { toast(error.message); }
}

$('#copy-webhook').addEventListener('click', async () => { await navigator.clipboard.writeText(config.webhookUrl); toast('Webhook URL copied'); });
$('#refresh-button').addEventListener('click', load);
$('#demo-button').addEventListener('click', async () => { try { $('#demo-button').disabled = true; await api('/api/demo', { method:'POST' }); toast('Sample meeting received'); setTimeout(load, 900); } catch (e) { toast(e.message); } finally { $('#demo-button').disabled = false; } });
$('#connect-form').addEventListener('submit', (event) => { event.preventDefault(); location.href = `/auth/microsoft/start?email=${encodeURIComponent($('#ae-email').value)}`; });
$('.dialog-close').addEventListener('click', () => $('#detail-dialog').close());

document.querySelectorAll('.nav-button').forEach((button) => button.addEventListener('click', async () => {
  document.querySelectorAll('.nav-button').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `${button.dataset.tab}-panel`));
  if (button.dataset.tab === 'settings' && !settingsLoaded) await loadSettings();
  if (button.dataset.tab === 'test' && !$('#test-payload').value) setTestPayload(noPricingPayload);
}));

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    const form = $('#settings-form');
    for (const [key, value] of Object.entries(data.values)) {
      const field = form.elements.namedItem(key); if (!field) continue;
      if (field.type === 'checkbox') field.checked = value === 'true'; else field.value = value;
    }
    for (const [key, saved] of Object.entries(data.configuredSecrets)) {
      const field = form.elements.namedItem(key); if (!field || !saved) continue;
      field.placeholder = 'Saved securely — leave blank to keep'; field.classList.add('secret-saved');
    }
    $('#live-mode').checked = data.values.DEMO_MODE === 'false';
    updateModeLabel(); updateSettingsUrls(data.values.APP_BASE_URL);
    $('#settings-account-list').innerHTML = data.accounts.length ? data.accounts.map((a) => `<span class="account-pill">✓ ${escapeHtml(a.email)}</span>`).join('') : '<p class="muted">No Outlook accounts connected yet.</p>';
    settingsLoaded = true;
  } catch (error) { toast(error.message); }
}

$('#live-mode').addEventListener('change', updateModeLabel);
function updateModeLabel() { $('#mode-description').textContent = $('#live-mode').checked ? 'Real integrations enabled after save' : 'Safe sample data only'; }
function updateSettingsUrls(base) {
  const clean = String(base || '').replace(/\/$/, '');
  $('#slack-url').textContent = clean ? `${clean}/api/slack/interactions` : 'Save your public app URL first';
  const redirect = $('#settings-form').elements.namedItem('MICROSOFT_REDIRECT_URI');
  if (clean && (!redirect.value || redirect.value.includes('localhost'))) redirect.value = `${clean}/auth/microsoft/callback`;
}

$('#settings-form').elements.namedItem('APP_BASE_URL').addEventListener('input', (event) => updateSettingsUrls(event.target.value));
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#save-settings'); button.disabled = true; $('#save-state').textContent = 'Saving encrypted settings…';
  try {
    const form = new FormData(event.currentTarget); const payload = Object.fromEntries(form.entries());
    payload.DEMO_MODE = String(!$('#live-mode').checked); payload.HUBSPOT_ENABLED = String(event.currentTarget.elements.namedItem('HUBSPOT_ENABLED').checked);
    const result = await api('/api/settings', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) });
    config.integrations = result.integrations; renderConfig(); $('#save-state').textContent = 'Saved — changes are active'; toast('Settings saved securely');
    settingsLoaded = false; if (result.reauthenticate) setTimeout(() => location.reload(), 1100);
  } catch (error) { $('#save-state').textContent = 'Could not save settings'; toast(error.message); }
  finally { button.disabled = false; }
});

$('#settings-connect-outlook').addEventListener('click', () => {
  const email = $('#settings-ae-email').value.trim(); if (!email.includes('@')) return toast('Enter the AE email first');
  location.href = `/auth/microsoft/start?email=${encodeURIComponent(email)}`;
});

$('#refresh-models').addEventListener('click', async () => {
  const button = $('#refresh-models'); button.disabled = true;
  try {
    const result = await api('/api/openai/models');
    $('#model-options').innerHTML = result.models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>`).join('');
    $('#model-help').textContent = result.source === 'openai' ? 'Showing models available to your saved OpenAI key.' : 'Save an OpenAI key to load models available to your account.';
    toast(`${result.models.length} models loaded`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$('#preset-no-pricing').addEventListener('click', () => setTestPayload(noPricingPayload));
$('#preset-pricing').addEventListener('click', () => setTestPayload(pricingPayload));
function setTestPayload(payload) { $('#test-payload').value = JSON.stringify(payload, null, 2); }

$('#generate-test').addEventListener('click', async () => {
  const button = $('#generate-test'); button.disabled = true; button.textContent = 'Generating…';
  try {
    lastTestPayload = JSON.parse($('#test-payload').value);
    const result = await api('/api/test/preview', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({payload:lastTestPayload}) });
    lastTestDraft = result.draft; renderTestResult(result);
    $('#send-slack-test').disabled = !(result.integrations.slack && !result.integrations.demoMode);
    toast('Test draft generated — edit any field');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Map payload & generate preview'; }
});

function renderTestResult(result) {
  $('#mapping-results').innerHTML = Object.entries(result.mapping).map(([key,value]) => `<div class="mapping-row"><span>${escapeHtml(key.replaceAll('_',' '))}</span><code>${escapeHtml(value === undefined || value === null || value === '' ? 'Not mapped' : typeof value === 'object' ? JSON.stringify(value) : value)}</code></div>`).join('');
  const pricing = result.pricing.discussed; $('#template-result').textContent = pricing ? 'Pricing discussed template' : 'No-pricing template';
  $('#model-result').textContent = result.model; $('#pricing-evidence').classList.toggle('pricing', pricing);
  $('#pricing-evidence').innerHTML = pricing ? `<strong>Pricing evidence found</strong><br>${result.pricing.evidence.map(escapeHtml).join('<br>')}` : '<strong>No explicit pricing evidence</strong><br>Pricing and onboarding details will not be included.';
  $('#test-recipient').value = result.draft.recipient || ''; $('#test-cc').value = (result.draft.cc || []).join(', '); $('#test-bcc').value = (result.draft.bcc || []).join(', ');
  $('#test-subject').value = result.draft.subject || ''; $('#test-body').value = result.draft.body || '';
}

$('#send-slack-test').addEventListener('click', async () => {
  if (!lastTestPayload || !lastTestDraft) return toast('Generate a preview first');
  const button = $('#send-slack-test'); button.disabled = true;
  try {
    const draft = { ...lastTestDraft, recipient:$('#test-recipient').value, cc:splitEmails($('#test-cc').value), bcc:splitEmails($('#test-bcc').value), subject:$('#test-subject').value, body:$('#test-body').value };
    await api('/api/test/slack', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({payload:lastTestPayload,draft}) });
    toast('Editable test sent to Slack');
  } catch (error) { toast(error.message); button.disabled = false; }
});

async function api(url, init) { const response = await fetch(url, init); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data; }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function relative(date) { const seconds = Math.round((new Date(date)-Date.now())/1000); const unit = Math.abs(seconds)>86400?'day':Math.abs(seconds)>3600?'hour':Math.abs(seconds)>60?'minute':'second'; const divisor = {day:86400,hour:3600,minute:60,second:1}[unit]; return new Intl.RelativeTimeFormat('en',{numeric:'auto'}).format(Math.round(seconds/divisor),unit); }
function splitEmails(value) { return String(value || '').split(',').map((item) => item.trim()).filter(Boolean); }

load(); setInterval(load, 15000);
