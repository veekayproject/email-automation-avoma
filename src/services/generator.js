import crypto from 'node:crypto';
import OpenAI from 'openai';
import { config } from '../config.js';

const schema = {
  type: 'object', additionalProperties: false,
  required: ['subject','body','grounding'],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    grounding: {
      type: 'object', additionalProperties: false,
      required: ['used_facts','omitted_sensitive_details'],
      properties: {
        used_facts: { type: 'array', items: { type: 'string' } },
        omitted_sensitive_details: { type: 'array', items: { type: 'string' } }
      }
    }
  }
};

export async function generateEmail(meeting) {
  if (config.demoMode || !config.OPENAI_API_KEY) return demoDraft(meeting);
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const source = {
    title: meeting.title, date: meeting.meetingDate, accountExecutive: meeting.ownerName,
    recipient: meeting.prospectName, company: meeting.prospectCompany,
    summary: meeting.summary, notes: meeting.notes, keyTopics: meeting.keyTopics,
    actionItems: meeting.actionItems, transcript: truncate(meeting.transcript, 14000)
  };
  const response = await client.responses.create({
    model: config.OPENAI_MODEL,
    input: [
      { role: 'system', content: `You write natural post-meeting follow-up emails for account executives. Use only facts in SOURCE. Never invent names, dates, requirements, commitments, pricing, or claims. Do not reveal internal/confidential notes. Do not mention AI, transcripts, or meeting notes. Be ${config.EMAIL_TONE}. Stay under ${config.EMAIL_MAX_WORDS} words. Use plain text. If a fact is uncertain, omit it. Return valid structured JSON.` },
      { role: 'user', content: `TEMPLATE GUIDANCE:\n${config.EMAIL_TEMPLATE}\n\nSOURCE:\n${JSON.stringify(source, null, 2)}` }
    ],
    text: { format: { type: 'json_schema', name: 'follow_up_email', schema, strict: true } }
  });
  const result = JSON.parse(response.output_text);
  return { ...result, model: config.OPENAI_MODEL, responseId: response.id };
}

function demoDraft(meeting) {
  const name = meeting.prospectName?.split(' ')[0] || 'there';
  const actionItems = Array.isArray(meeting.actionItems) ? meeting.actionItems : [];
  const steps = actionItems.length ? `\n\nNext steps:\n${actionItems.map((item) => `• ${typeof item === 'string' ? item : item.text || item.title}`).join('\n')}` : '';
  const summary = meeting.summary || meeting.notes || 'It was helpful to learn more about your priorities.';
  return {
    subject: `Next steps from ${meeting.title}`,
    body: `Hi ${name},\n\nThanks for the thoughtful conversation. ${summary}${steps}\n\nDoes this capture the plan correctly? I’m happy to adjust anything I missed.\n\nBest,\n${meeting.ownerName || 'Your account executive'}`,
    grounding: { used_facts: [summary, ...actionItems.map(String)], omitted_sensitive_details: [] },
    model: 'demo', responseId: `demo_${crypto.randomUUID()}`
  };
}

const truncate = (value, max) => typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value;
