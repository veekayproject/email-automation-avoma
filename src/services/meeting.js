import { config } from '../config.js';

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');
const emailOf = (person = {}) => first(person.email, person.email_address, person.address, person.user?.email);
const nameOf = (person = {}) => first(person.name, person.display_name, person.full_name, person.user?.name, emailOf(person)?.split('@')[0]);

export function normalizeWebhook(payload) {
  payload = unwrapEnvelope(payload);
  const root = payload.data?.meeting || payload.meeting || payload.data || payload;
  const participantsRaw = first(root.participants, root.attendees, root.meeting_participants, payload.participants, []) || [];
  const participants = participantsRaw.map((p) => ({
    name: nameOf(p) || 'Unknown participant',
    email: (emailOf(p) || '').toLowerCase(),
    company: first(p.company, p.organization?.name, p.company_name),
    isHost: Boolean(first(p.is_host, p.isHost, p.organizer, false))
  }));
  const owner = first(root.owner, root.organizer, root.host, payload.owner, {}) || {};
  const ownerEmail = (first(root.owner_email, root.organizer_email, emailOf(owner), payload.owner_email, payload.organizer_email) || '').toLowerCase();
  const external = participants.find((p) => p.email && !isInternalEmail(p.email, ownerEmail));
  return {
    id: String(first(mapped(payload, 'id'), root.id, root.meeting_id, root.uuid, payload.meeting_id, payload.id, '')),
    source: first(payload.source, 'avoma'),
    event: String(first(payload.event, root.event_type, root.event_label, payload.event_type, payload.event_label, payload.type, 'meeting.completed')).toLowerCase(),
    title: first(mapped(payload, 'title'), root.title, root.subject, root.name, 'Untitled meeting'),
    meetingDate: first(root.start_at, root.start_time, root.started_at, root.meeting_date, root.date),
    ownerName: first(mapped(payload, 'owner_name'), root.owner_name, root.organizer_name, nameOf(owner)),
    ownerEmail: first(mapped(payload, 'owner_email'), ownerEmail),
    prospectName: first(mapped(payload, 'prospect_name'), root.prospect_name, external?.name),
    prospectCompany: first(mapped(payload, 'company'), root.company_name, root.account?.name, external?.company),
    recipientEmail: first(mapped(payload, 'recipient_email'), root.recipient_email, external?.email),
    meetingUrl: first(mapped(payload, 'meeting_url'), root.meeting_url, root.url, root.web_url, root.avoma_url, root.recording_url),
    crmUrl: first(mapped(payload, 'crm_url'), root.crm_url, root.deal?.url, root.contact?.url),
    hubspotContactId: first(root.hubspot_contact_id, root.contact?.id, root.crm?.contact_id),
    hubspotCompanyId: first(root.hubspot_company_id, root.account?.id, root.crm?.company_id),
    hubspotDealId: first(root.hubspot_deal_id, root.deal?.id, root.crm?.deal_id),
    participants: Array.isArray(mapped(payload, 'participants')) ? mapped(payload, 'participants').map((p) => ({ name:nameOf(p)||'Unknown participant', email:(emailOf(p)||'').toLowerCase(), company:first(p.company,p.organization?.name,p.company_name), isHost:Boolean(first(p.is_host,p.isHost,p.organizer,false)) })) : participants,
    summary: first(mapped(payload, 'summary'), root.summary, root.ai_summary, root.overview, payload.summary),
    notes: first(mapped(payload, 'notes'), root.notes, root.ai_notes_txt, root.ai_notes, root.meeting_notes, payload.notes),
    transcript: first(mapped(payload, 'transcript'), root.transcript, root.transcript_text, payload.transcript),
    actionItems: first(mapped(payload, 'action_items'), root.action_items, root.actionItems, payload.action_items, []),
    keyTopics: first(root.key_topics, root.keyTopics, root.topics, []),
    raw: payload
  };
}

function unwrapEnvelope(payload) {
  const value = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
  if (value?.body && typeof value.body === 'object' && (value.headers || value.params || value.query)) return value.body;
  return value || {};
}

export function mappingSummary(meeting) {
  return {
    meeting_id: meeting.id, title: meeting.title, owner_email: meeting.ownerEmail,
    prospect_name: meeting.prospectName, recipient_email: meeting.recipientEmail,
    company: meeting.prospectCompany, summary: meeting.summary, notes: meeting.notes,
    transcript: meeting.transcript ? `${String(meeting.transcript).slice(0, 180)}${String(meeting.transcript).length > 180 ? '…' : ''}` : '',
    action_items: meeting.actionItems, meeting_url: meeting.meetingUrl, crm_url: meeting.crmUrl,
    participant_count: meeting.participants.length
  };
}

function mapped(payload, key) {
  const path = config.webhookFieldMap?.[key];
  if (!path) return undefined;
  return String(path).split('.').reduce((value, part) => value?.[part], payload);
}

export function isInternalEmail(email, ownerEmail = '') {
  const domain = String(email).split('@')[1]?.toLowerCase();
  const ownerDomain = String(ownerEmail).split('@')[1]?.toLowerCase();
  return Boolean(domain && (config.internalDomains.includes(domain) || (ownerDomain && domain === ownerDomain)));
}

export function meetingEligibility(meeting) {
  if (!meeting.id) return { eligible: false, reason: 'Missing meeting ID' };
  const eventReady = !meeting.event || ['completed','ready','processed','note','analysis','ainote'].some((word) => meeting.event.includes(word));
  if (!eventReady) return { eligible: false, reason: `Event is not a completed/ready event: ${meeting.event}` };
  const external = meeting.participants.filter((p) => p.email && !isInternalEmail(p.email, meeting.ownerEmail));
  if (!external.length && !meeting.recipientEmail) return { eligible: false, reason: 'No external participant was found' };
  if (!meeting.recipientEmail) return { eligible: false, reason: 'External recipient email is missing' };
  return { eligible: true };
}

export async function enrichFromAvoma(meeting) {
  if (!config.AVOMA_API_KEY || config.demoMode) return meeting;
  const headers = { Authorization: `Bearer ${config.AVOMA_API_KEY}`, Accept: 'application/json' };
  const urls = [
    `${config.AVOMA_API_BASE_URL}/meetings/${encodeURIComponent(meeting.id)}`,
    `${config.AVOMA_API_BASE_URL}/meetings/${encodeURIComponent(meeting.id)}/transcription`
  ];
  const results = await Promise.allSettled(urls.map(async (url) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Avoma request failed (${response.status})`);
    return response.json();
  }));
  const merged = results.filter((r) => r.status === 'fulfilled').reduce((acc, r) => ({ ...acc, ...r.value }), meeting.raw);
  return { ...meeting, ...normalizeWebhook({ data: { meeting: merged }, source: 'avoma', event: meeting.event }), raw: merged };
}

export const demoMeeting = () => ({
  event: 'meeting.analysis.ready', source: 'demo', data: { meeting: {
    id: `demo-${Date.now()}`, title: 'Quarterly workflow review', start_at: new Date().toISOString(),
    owner: { name: 'Alex Morgan', email: 'alex@yourcompany.com' },
    participants: [
      { name: 'Alex Morgan', email: 'alex@yourcompany.com', is_host: true },
      { name: 'Jordan Lee', email: 'jordan@northstar.example', company: 'Northstar Labs' }
    ],
    summary: 'Jordan wants to reduce manual follow-up work after customer calls while keeping an AE approval step.',
    notes: 'The team uses Outlook and Slack. They asked for a pilot next week and emphasized that emails must never send automatically.',
    action_items: ['Alex will share the pilot checklist by Friday', 'Jordan will confirm the three pilot users'],
    url: 'https://app.avoma.com/meetings/demo', crm_url: 'https://app.hubspot.com/contacts/demo'
  } }
});
