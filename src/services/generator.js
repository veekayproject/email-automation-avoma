import crypto from 'node:crypto';
import OpenAI from 'openai';
import { config } from '../config.js';

const schema = {
  type: 'object', additionalProperties: false,
  required: ['subject','body','template_type','pricing_evidence','grounding'],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    template_type: { type: 'string', enum: ['pricing_discussed','no_pricing'] },
    pricing_evidence: { type: 'array', items: { type: 'string' } },
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
  const pricing = detectPricingDiscussion(meeting);
  if (config.demoMode || !config.OPENAI_API_KEY) return demoDraft(meeting);
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const source = {
    title: meeting.title, date: meeting.meetingDate, accountExecutive: meeting.ownerName,
    recipient: meeting.prospectName, company: meeting.prospectCompany,
    summary: meeting.summary, notes: meeting.notes, keyTopics: meeting.keyTopics,
    actionItems: meeting.actionItems, transcript: truncate(meeting.transcript, 14000),
    pricingDiscussed: pricing.discussed, pricingEvidence: pricing.evidence,
    approvedPricingText: pricing.discussed ? config.APPROVED_PRICING_TEXT : undefined
  };
  const selectedTemplate = pricing.discussed ? config.EMAIL_TEMPLATE_PRICING : config.EMAIL_TEMPLATE_NO_PRICING;
  const response = await client.responses.create({
    model: config.OPENAI_MODEL,
    input: [
      { role: 'system', content: `You write natural post-meeting follow-up emails for account executives. Use only facts in SOURCE. Never invent names, dates, requirements, commitments, pricing, or claims. Do not reveal internal/confidential notes. Do not mention AI, transcripts, or meeting notes. The server has already selected the template type from explicit source evidence; return exactly that template_type. Never add pricing when pricingDiscussed is false. When it is true, pricing can come only from SOURCE or approvedPricingText. Be ${config.EMAIL_TONE}. Stay under ${config.EMAIL_MAX_WORDS} words unless the approved pricing block makes that impossible. Use plain text. If a fact is uncertain, omit it. Return valid structured JSON.` },
      { role: 'user', content: `GENERAL WRITING RULES:\n${config.EMAIL_TEMPLATE}\n\nSELECTED CONDITIONAL TEMPLATE:\n${selectedTemplate}\n\nREQUIRED TEMPLATE TYPE: ${pricing.discussed ? 'pricing_discussed' : 'no_pricing'}\n\nSOURCE:\n${JSON.stringify(source, null, 2)}` }
    ],
    text: { format: { type: 'json_schema', name: 'follow_up_email', schema, strict: true } }
  });
  const result = JSON.parse(response.output_text);
  return { ...result, template_type: pricing.discussed ? 'pricing_discussed' : 'no_pricing', pricing_evidence: pricing.evidence, model: config.OPENAI_MODEL, responseId: response.id };
}

function demoDraft(meeting) {
  const pricing = detectPricingDiscussion(meeting);
  const name = meeting.prospectName?.split(' ')[0] || 'there';
  const actionItems = Array.isArray(meeting.actionItems) ? meeting.actionItems : [];
  const steps = actionItems.length ? `\n\nNext steps:\n${actionItems.map((item) => `• ${typeof item === 'string' ? item : item.text || item.title}`).join('\n')}` : '';
  const summary = meeting.summary || meeting.notes || 'It was helpful to learn more about your priorities.';
  const demoRequest = pricing.discussed
    ? `\n\nFor the custom demo, could you share:\n• Your ICP persona\n• Your ideal target-account criteria\n• Your top 10 introducers and their LinkedIn profile URLs\n\nOnce shared, we’ll configure 15-20 real-world connections to the target accounts.`
    : `\n\nFor the custom demo, could you share:\n• Your ideal target-account criteria\n• The signals that make an account a good target\n• 10-30 introducers and their LinkedIn profile URLs\n\nOnce shared, we’ll configure 10-15 real-world connections to the target accounts.`;
  const pricingBlock = pricing.discussed && config.APPROVED_PRICING_TEXT ? `\n\n${config.APPROVED_PRICING_TEXT}` : '';
  return {
    subject: `Next steps from ${meeting.title}`,
    body: `Hi ${name},\n\nIt was great speaking with you. Thank you for your time.\n\n${summary}${demoRequest}${steps}${meeting.meetingUrl ? `\n\nHere’s our call recording: ${meeting.meetingUrl}` : ''}${pricingBlock}\n\nPlease let me know if you need anything else. I’ll look forward to the details.\n\nBest,\n${meeting.ownerName || 'Your account executive'}`,
    template_type: pricing.discussed ? 'pricing_discussed' : 'no_pricing', pricing_evidence: pricing.evidence,
    grounding: { used_facts: [summary, ...actionItems.map(String)], omitted_sensitive_details: [] },
    model: 'demo', responseId: `demo_${crypto.randomUUID()}`
  };
}

export function detectPricingDiscussion(meeting) {
  const parts = [meeting.summary, meeting.notes, meeting.transcript, ...(Array.isArray(meeting.actionItems) ? meeting.actionItems.map((item) => typeof item === 'string' ? item : item?.text || item?.title) : [])].filter(Boolean).map(String);
  const pricingSignal = /(?:\bpricing\b|\bprice\b|\bcost\b|\bbudget\b|\bcommercials?\b|\bquote\b|\bsubscription\b|\$\s?\d|\d[\d,.]*\s?(?:usd|dollars?|\/year|annually))/i;
  const explicitNegation = /(?:pricing|price|cost|budget|commercials?)\s+(?:was|were|is|are|has|have)?\s*(?:not|never)\s+(?:discussed|covered|mentioned|shared)|(?:did\s+not|didn't|no)\s+(?:discuss|cover|mention|share|provide)?\s*(?:any\s+)?(?:pricing|price|cost|budget|commercials?)/i;
  const evidence = parts.filter((text) => pricingSignal.test(text) && !explicitNegation.test(text)).slice(0, 3).map((text) => truncate(text, 240));
  return { discussed: evidence.length > 0, evidence };
}

export async function listAvailableModels() {
  const curated = [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna — efficient, recommended for high-volume follow-ups' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra — balanced quality and cost' },
    { id: 'gpt-5.6', label: 'GPT-5.6 — highest capability' },
    { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini — compatibility option' }
  ];
  if (!config.OPENAI_API_KEY) return { models: curated, source: 'recommended' };
  const response = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Could not load models for this OpenAI API key');
  const data = await response.json();
  const available = new Set((data.data || []).map((model) => model.id));
  return { models: [...curated.filter((model) => available.has(model.id)), ...[...available].filter((id) => /^gpt-(?:5|4\.1)/.test(id) && !curated.some((model) => model.id === id)).sort().map((id) => ({ id, label: id }))], source: 'openai' };
}

const truncate = (value, max) => typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value;
