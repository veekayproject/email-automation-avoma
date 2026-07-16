# FollowPilot

A human-in-the-loop post-meeting follow-up agent for Avoma, OpenAI, Slack, and Microsoft Outlook.

FollowPilot exposes a reusable webhook, enriches completed Avoma meetings, ignores internal or duplicate meetings, creates a grounded follow-up draft, and asks the account executive to review it in Slack. The email is only sent after approval, using the AE's own Microsoft account.

## What works

- Public `POST /api/webhooks/avoma` endpoint with shared-secret or HMAC verification
- Flexible payload adapter for Avoma and other meeting tools
- External-meeting filter and database-backed idempotency
- OpenAI structured email generation with strict no-invention rules
- Slack DM/channel review card, edit modal, cancel, regenerate, and send actions
- Slack file picker support for Outlook attachments
- Per-AE Microsoft OAuth and Graph `sendMail` integration
- Audit timeline, retry endpoint, dashboard, readiness checks, and Docker deployment

## Quick start

1. Install Node.js 22 or newer.
2. Copy `.env.example` to `.env` and fill in the required values.
3. Run `npm install` and `npm run dev`.
4. Open `http://localhost:3000`.
5. For local webhook testing, expose port 3000 using a secure tunnel and paste the displayed webhook URL into Avoma.

The app runs in demo mode until service credentials are added. In demo mode, a sample meeting can be submitted from the dashboard and a realistic draft is created without contacting third-party APIs.

See [SETUP.md](./SETUP.md) for the complete Avoma, Slack, Microsoft, OpenAI, and deployment checklist.

## Commands

```bash
npm run dev
npm test
npm start
```

## Deployment

Build with the included `Dockerfile`. A ready-to-use `render.yaml` is included; any Docker host with a persistent disk will work. For multiple app replicas, switch the storage adapter to a managed PostgreSQL database before scaling horizontally.

## Safety model

FollowPilot never auto-sends generated mail. Every draft must transition from `waiting_review` to `sending` through a signed Slack action by an authorized AE. Each meeting ID is unique in the database, and a second send is blocked both before and inside the database transaction.
