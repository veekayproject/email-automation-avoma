# FollowPilot setup and publishing guide

This guide takes the app from local demo to a production webhook. The workflow is intentionally human-in-the-loop: generated content is never sent until an AE presses **Send email** in Slack or the signed review page.

## 1. Decide the email policy

The defaults are warm, concise, plain-text emails under 220 words. Configure these values in the deployment environment:

- `EMAIL_TEMPLATE`: required structure, phrases, sign-off rules, and CTA guidance.
- `EMAIL_TONE`: voice guidance such as “direct, friendly, no sales jargon”.
- `EMAIL_MAX_WORDS`: maximum length.
- `DEFAULT_CC`: comma-separated addresses that should start on every draft.
- `INTERNAL_DOMAINS`: comma-separated domains whose attendees must never count as prospects.

The prompt always forbids invented facts, unsupported claims, internal notes, and references to AI or transcripts.

## 2. Run the safe local demo

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`, press **Run sample meeting**, and open the created row. Demo mode does not contact OpenAI, Slack, Microsoft, or HubSpot.

## 3. Configure Avoma or another meeting source

Deploy the app first or expose local port 3000 with a secure HTTPS tunnel. Copy **Your inbound webhook** from the dashboard and register it for Avoma's meeting-analysis/notes-ready event.

The adapter accepts common payload shapes. The minimum body is:

```json
{
  "event": "meeting.analysis.ready",
  "data": {
    "meeting": {
      "id": "unique-meeting-id",
      "title": "Discovery call",
      "owner": { "name": "Alex", "email": "alex@yourcompany.com" },
      "participants": [
        { "name": "Alex", "email": "alex@yourcompany.com" },
        { "name": "Customer", "email": "customer@example.com", "company": "Example" }
      ],
      "summary": "AI summary",
      "notes": "AI notes",
      "action_items": ["Alex will send the proposal"],
      "url": "https://app.avoma.com/..."
    }
  }
}
```

Authentication can be supplied through the `?secret=` URL, `X-Webhook-Secret`, `Authorization: Bearer`, or a hexadecimal HMAC-SHA256 signature in `X-Avoma-Signature`. The secret is `AVOMA_WEBHOOK_SECRET`.

If the webhook carries only a meeting ID, set `AVOMA_API_KEY`; the app attempts to enrich the meeting through the configurable `AVOMA_API_BASE_URL`. If your Avoma plan exposes different resource paths, update `src/services/meeting.js` in one place.

## 4. Configure OpenAI

Set `OPENAI_API_KEY`, `OPENAI_MODEL`, `EMAIL_TEMPLATE`, and `EMAIL_TONE`. Set `DEMO_MODE=false`. The generator requests strict structured output and records the model response ID plus grounding metadata in the draft audit record.

## 5. Create the Slack review app

Create a Slack app for your workspace:

1. Add bot scopes `chat:write`, `im:write`, and `files:read`.
2. Install the app and copy its bot token to `SLACK_BOT_TOKEN`.
3. Copy the signing secret to `SLACK_SIGNING_SECRET`.
4. Enable Interactivity and use `https://YOUR-DOMAIN/api/slack/interactions` as the request URL.
5. Set `AE_SLACK_MAP` to a JSON object mapping each meeting-owner email to a Slack user ID. Optionally set `SLACK_FALLBACK_CHANNEL`.

The review card supports edit, regenerate, cancel, and send. The edit modal changes To/CC/BCC/subject/body and can select up to five Slack files. Attachments are limited to 3 MB each and 8 MB total before being attached to the Graph email.

## 6. Connect each AE's Outlook account

Register an app in Microsoft Entra ID:

1. Add the Web redirect URI `https://YOUR-DOMAIN/auth/microsoft/callback`.
2. Add delegated Microsoft Graph permissions `User.Read` and `Mail.Send`; `offline_access`, `openid`, `profile`, and `email` are requested during sign-in.
3. Create a client secret.
4. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, and the exact `MICROSOFT_REDIRECT_URI`.
5. In FollowPilot, enter each AE's email under **Connect Outlook** and have that AE finish Microsoft sign-in.

Tokens are encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY`. The account email must match the meeting owner, ensuring mail is sent through the correct AE and saved to their Sent folder.

## 7. Optional HubSpot logging

Set `HUBSPOT_ENABLED=true` and `HUBSPOT_ACCESS_TOKEN`. When the meeting payload includes `hubspot_contact_id` (or `contact.id`), FollowPilot creates a sent-email object associated with that contact. HubSpot logging failures are audited but do not incorrectly mark a successfully sent Outlook email as failed.

## 8. Publish

### Render

1. Push this repository to your own GitHub repository.
2. In Render, create a Blueprint from `render.yaml`.
3. Enter the secret values requested by the Blueprint.
4. Confirm the persistent disk is mounted at `/app/data`.
5. Set `APP_BASE_URL` and `MICROSOFT_REDIRECT_URI` to the final HTTPS domain.
6. Visit `/health` and `/ready`, then send one sample webhook before enabling the Avoma subscription.

### Any Docker host

Build the included `Dockerfile`, expose port 3000, persist `/app/data`, and provide the environment variables from `.env.example`. Use one app replica with SQLite. Before horizontal scaling, replace SQLite with managed PostgreSQL and a durable job queue.

## Operations checklist

- Keep `ADMIN_PASSWORD`, webhook secret, encryption key, and provider secrets in the host's secret manager.
- Back up the persistent database; it contains drafts, final messages, provider references, and the audit trail.
- Rotate provider credentials periodically. Changing `APP_ENCRYPTION_KEY` without re-encrypting tokens disconnects Microsoft accounts.
- Review ignored and failed meetings in the dashboard. Retry only after correcting the reported reason.
- Do not add automatic sending: the database send claim and Slack signature check are deliberate safety boundaries.
- For high volume, move processing to a persistent queue and use PostgreSQL uniqueness constraints before adding more replicas.

## Data model

- `meetings`: normalized source data, owner/prospect metadata, status, and failure reason.
- `drafts`: generated and final text, recipients, attachments, Slack reference, approval, and Outlook reference.
- `oauth_accounts`: encrypted per-AE Microsoft refresh/access tokens.
- `audit_logs`: append-only events for ingestion, exclusion, drafting, editing, approval, send, failure, and CRM logging.

No separate setup is required per meeting. A new AE only needs a Slack mapping and a one-time Microsoft connection.
