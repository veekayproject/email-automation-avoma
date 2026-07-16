import { config } from '../config.js';

export async function logSentEmailToHubSpot(meeting, draft, sentAt) {
  if (!config.hubspotEnabled || !config.HUBSPOT_ACCESS_TOKEN) return { skipped: true };
  const source = meeting.sourcePayload?.data?.meeting || meeting.sourcePayload?.meeting || meeting.sourcePayload || {};
  const contactId = source.hubspot_contact_id || source.contact?.id || source.crm?.contact_id;
  if (!contactId) return { skipped: true, reason: 'No HubSpot contact ID on meeting' };
  const payload = {
    properties: {
      hs_timestamp: sentAt, hs_email_direction: 'EMAIL', hs_email_status: 'SENT',
      hs_email_subject: draft.subject, hs_email_text: draft.body,
      hs_email_to_email: draft.recipient, hs_email_from_email: meeting.owner_email || ''
    },
    associations: [{ to: { id: String(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 198 }] }]
  };
  const response = await fetch(`${config.HUBSPOT_API_BASE_URL}/crm/v3/objects/emails`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.HUBSPOT_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'HubSpot email logging failed');
  return { id: result.id };
}
