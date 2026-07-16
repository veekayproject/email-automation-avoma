import { config } from '../config.js';

const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');
const emailOf = (person = {}) => first(person.email, person.email_address, person.address, person.user?.email);
const nameOf = (person = {}) => first(person.name, person.display_name, person.full_name, person.user?.name, emailOf(person)?.split('@')[0]);

export function normalizeWebhook(payload) {
  const root = payload.data?.meeting || payload.meeting || payload.data || payload;
  const participantsRaw = first(root.participants, root.attendees, root.meeting_participants, payload.participants, []) || [];
  const participants = participantsRaw.map((p) => ({
    name: nameOf(p) || 'Unknown participant',
    email: (emailOf(p) || '').toLowerCase(),
    company: first(p.company, p.organization?.name, p.company_name),
    isHost: Boolean(first(p.is_host, p.isHost, p.organizer, false))
  }));
  const owner = first(root.owner, root.organizer, root.host, payload.owner, {}) || {};
  const ownerEmail = (first(root.owner_email, emailOf(owner), payload.owner_email) || '').toLowerCase();
  const external = participants.find((p) => p.email && !isInternalEmail(p.email, ownerEmail));
  return {
    id: String(first(root.id, root.meeting_id, root.uuid, payload.meeting_id, payload.id, '')),
    source: first(payload.source, 'avoma'),
    event: String(first(payload.event, payload.event_type, payload.type, 'meeting.completed')).toLowerCase(),
    title: first(root.title, root.subject, root.name, 'Untitled meeting'),
    meetingDate: first(root.start_at, root.start_time, root.started_at, root.meeting_date, root.date),
    ownerName: first(root.owner_name, nameOf(owner)),
    ownerEmail,
    prospectName: first(root.prospect_name, external?.name),
    prospectCompany: first(root.company_name, root.account?.name, external?.company),
    recipientEmail: first(root.recipient_email, external?.email),
    meetingUrl: first(root.url, root.web_url, root.avoma_url, root.recording_url),
    crmUrl: first(root.crm_url, root.deal?.url, root.contact?.url),
    hubspotContactId: first(root.hubspot_contact_id, root.contact?.id, root.crm?.contact_id),
    hubspotCompanyId: first(root.hubspot_company_id, root.account?.id, root.crm?.company_id),
    hubspotDealId: first(root.hubspot_deal_id, root.deal?.id, root.crm?.deal_id),
    participants,
    summary: first(root.summary, root.ai_summary, root.overview, payload.summary),
    notes: first(root.notes, root.ai_notes, root.meeting_notes, payload.notes),
    transcript: first(root.transcript, root.transcript_text, payload.transcript),
    actionItems: first(root.action_items, root.actionItems, payload.action_items, []),
    keyTopics: first(root.key_topics, root.keyTopics, root.topics, []),
    raw: payload
  };
}

export function isInternalEmail(email, ownerEmail = '') {
  const domain = String(email).split('@')[1]?.toLowerCase();
  const ownerDomain = String(ownerEmail).split('@')[1]?.toLowerCase();
  return Boolean(domain && (config.internalDomains.includes(domain) || (ownerDomain && domain === ownerDomain)));
}

export function meetingEligibility(meeting) {
  if (!meeting.id) return { eligible: false, reason: 'Missing meeting ID' };
  const eventReady = !meeting.event || ['completed','ready','processed','notes','analysis'].some((word) => meeting.event.includes(word));
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
