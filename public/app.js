const $ = (selector) => document.querySelector(selector);
let config;

async function load() {
  try {
    const [configData, meetingData] = await Promise.all([api('/api/config'), api('/api/meetings')]);
    config = configData; renderConfig(); renderMeetings(meetingData.meetings);
  } catch (error) { toast(error.message); }
}

function renderConfig() {
  $('#webhook-url').textContent = config.webhookUrl;
  const names = { avoma:'Avoma', openai:'OpenAI', slack:'Slack', microsoft:'Outlook', demoMode:'Demo mode' };
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

async function api(url, init) { const response = await fetch(url, init); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request failed'); return data; }
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function relative(date) { const seconds = Math.round((new Date(date)-Date.now())/1000); const unit = Math.abs(seconds)>86400?'day':Math.abs(seconds)>3600?'hour':Math.abs(seconds)>60?'minute':'second'; const divisor = {day:86400,hour:3600,minute:60,second:1}[unit]; return new Intl.RelativeTimeFormat('en',{numeric:'auto'}).format(Math.round(seconds/divisor),unit); }

load(); setInterval(load, 15000);
