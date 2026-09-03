# `SEND_EMAIL` workflow step

Sends an email from a deployment-level mailbox via the **Gmail API**. Available
as an `ACTION` step in the workflow builder once the Gmail env vars are set.

---

## How it's wired

The transport is hidden behind a small interface so the step stays pure and
testable, and so the auth flavor can be swapped without touching the step.

```
.env (GMAIL_*)
   │  read once at startup
   ▼
createGmailService()                 services/gmail.service.ts
   │  builds an authenticated Gmail client (OAuth2 refresh-token flow)
   ▼
ServiceRegistry.register("gmail", …) app/workflows/runtime.ts
   │
   ▼
SendEmailStep  (requiredServices: ["gmail"])   steps/send-email.step.ts
   │  ctx.services.get("gmail") → builds MIME → users.messages.send
   ▼
StepRegistry.register(new SendEmailStep())     app/workflows/runtime.ts
   │  exposed to the UI via the /schema route
   ▼
"Send Email" appears in the builder's Add Step list
```

Registration is **guarded** — if any required env var is missing, the service
and step are not registered and the server logs a warning instead. This keeps
workflows from referencing an unconfigured transport.

| File | Role |
| --- | --- |
| `services/gmail.service.ts` | Builds the authenticated Gmail client + `send()` helper |
| `steps/send-email.step.ts` | The `SEND_EMAIL` step: config schema, MIME builder, `execute()` |
| `runtime.ts` | Reads env, registers the `gmail` service + the step (guarded) |
| `tests/sendEmailStep.test.ts` | Unit tests (MIME correctness + execution, no network) |

---

## What you need to start (Option A — OAuth2 refresh token)

This flow sends as **one fixed mailbox** (the account that grants consent).
Works with personal `@gmail.com` or a Workspace mailbox.

### 1. OAuth client (Google Cloud Console)
- Enable the **Gmail API** on the project.
- **APIs & Services → Credentials → OAuth client ID → type "Web application"**.
- Copy the **Client ID** and **Client secret**.
  (An existing Web-application client can be reused.)

### 2. Refresh token (one-time consent)
Use the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
1. In Cloud Console, add `https://developers.google.com/oauthplayground` as an
   **Authorized redirect URI** on the OAuth client. (Save; wait ~1 min.)
2. Playground → ⚙️ gear → **"Use your own OAuth credentials"** → paste Client
   ID + secret.
3. Left panel scope: `https://www.googleapis.com/auth/gmail.send`
4. **Authorize APIs** → sign in **as the sender mailbox** → approve.
5. **Exchange authorization code for tokens** → copy the **Refresh token**.

> Access token is short-lived (~1h) — ignore it. Only the **refresh token** is
> stored; the server mints access tokens from it automatically.

### 3. Env vars (`server/.env`)
All four are required, or the step won't register:

```bash
GMAIL_CLIENT_ID=<oauth client id>
GMAIL_CLIENT_SECRET=<oauth client secret>
GMAIL_REFRESH_TOKEN=<from the Playground>
GMAIL_SENDER=<the mailbox you consented as>   # also the From: address
```

`.env` is read **once at startup** — restart `bun run dev:v2` after editing.
Confirm with the log line:

```
Workflow: SEND_EMAIL step registered (Gmail sender: <addr>)
```

### Gotchas
- `GMAIL_SENDER` **must equal** the consented mailbox — Gmail sends as the
  authenticated account; you can't spoof a different From:.
- A **Testing** OAuth consent screen expires refresh tokens after ~7 days —
  **Publish** the app for production.
- Scope must be exactly `gmail.send`.

---

## Step config & output

### Config
| Field | Type | Notes |
| --- | --- | --- |
| `to` | string \| string[] | required; accepts a `{{ref}}` |
| `cc`, `bcc` | string \| string[] | optional |
| `subject` | string | supports templates: `"Invoice {{x.output.vendor}}"` |
| `body` | string | plain text or HTML |
| `isHtml` | boolean | default `false`; switches text/plain ↔ text/html |
| `attachments` | Attachment[] | optional; bytes read via the storage adapter |

### Output (`{{<step>.output}}`)
```jsonc
{
  "messageId": "…",                 // convenience (= gmail.id)
  "threadId":  "…",
  "to": ["a@x.com"],
  "gmail": { "id": "…", "threadId": "…", "labelIds": ["SENT"] },  // raw Gmail Message resource
  "input": {                         // echo of the resolved input (self-documenting)
    "to": ["a@x.com"], "cc": [], "bcc": [],
    "subject": "…", "body": "…", "isHtml": false,
    "attachments": [{ "name": "…", "mimeType": "…" }]
  }
}
```
The Gmail send API only returns `id` / `threadId` / `labelIds`; the `input`
echo is added by this step so the output is useful on its own.

### Referencing fields (e.g. in a Conditional)
Point conditions at a **specific field**, not the whole `.output` object:
```
{{send_email_x.output.messageId}}          exists       (was it sent?)
{{send_email_x.output.gmail.labelIds}}     contains  SENT
{{send_email_x.output.to}}                 contains  a@x.com
{{send_email_x.output.to.0}}               equals    a@x.com   (index into arrays)
{{send_email_x.output.input.subject}}      equals    Hello
```
Arrays use `contains` (or index with `.0`); `equals` against a whole array/object
won't match. Note: if a send **fails** the step throws and the workflow stops
unless its `settings.onError` is `continue`.

---

## Switching to a service account (Option B, later)

For sending as **any mailbox in a Google Workspace domain** (domain-wide
delegation). **Only `gmail.service.ts` + `runtime.ts` change** — the step,
tests, and UI are untouched.

- Service account uses a **JWT client with `subject` impersonation** instead of
  a refresh token (`google.auth.JWT({ email, key, scopes, subject })`).
- Google setup: create a service account, enable domain-wide delegation, and in
  **Workspace Admin → Security → API controls → Domain-wide delegation**
  authorize its Client ID for scope `gmail.send`.
- Env: `GMAIL_SA_CLIENT_EMAIL`, `GMAIL_SA_PRIVATE_KEY`, `GMAIL_SENDER`.
- Does **not** work for personal `@gmail.com` — Workspace only.
