# Creating the GitHub App

Step-by-step guide for registering, configuring, and installing the `@chrisleekr-bot` GitHub App. For local development after the App exists, see [`setup.md`](setup.md).

## 1. Register the App

### 1.1 Open the registration form

Personal account: **Settings → Developer settings → GitHub Apps → New GitHub App**.
Organization: **Org settings → Developer settings → GitHub Apps → New GitHub App**.

Direct link: <https://github.com/settings/apps/new>.

> A user or organization can register up to 100 GitHub Apps. Source: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

### 1.2 Basic information

| Field           | Value                                                                                 | Notes                                                            |
| --------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| GitHub App name | `chrisleekr-bot`                                                                      | Globally unique, ≤ 34 chars, slugified to lowercase-with-dashes. |
| Homepage URL    | `https://github.com/chrisleekr/github-app-playground`                                 | Required; any valid HTTPS URL.                                   |
| Description     | `AI-powered code review bot, responds to @chrisleekr-bot mentions on PRs and issues.` | Optional.                                                        |

### 1.3 Webhook configuration

| Field            | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| Active           | ✅                                                                 |
| Webhook URL      | `https://<your-public-host>/api/github/webhooks`                   |
| SSL verification | Enabled (default, keep it).                                        |
| Webhook secret   | Output of `openssl rand -hex 32`. Save as `GITHUB_WEBHOOK_SECRET`. |

The path `/api/github` is set by `pathPrefix` in `createNodeMiddleware` (`src/app.ts`). Don't change the path unless you also change the source.

For local dev, set the Webhook URL to a [smee.io](https://smee.io) channel and relay it to your local server:

```bash
# SMEE_URL=https://smee.io/<channel> in .env, then:
bun run dev:smee
```

### 1.4 OAuth, Setup, post-install

Leave all OAuth, callback URL, Device Flow, and Setup URL fields empty/unchecked. This App uses **installation tokens only** (server-to-server) and never acts on behalf of an individual user. See [About authentication with a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app).

### 1.5 Permissions

Repository permissions:

| Permission    | Setting      | Why                                                                   |
| ------------- | ------------ | --------------------------------------------------------------------- |
| Actions       | Read-only    | Read workflow run state for `bot:resolve` CI fixes.                   |
| Contents      | Read & Write | Clone repos and push commits via the git CLI.                         |
| Issues        | Read & Write | Read issue body / comments; post bot replies.                         |
| Pull requests | Read & Write | Read PR diff and context; post review comments and replies.           |
| Metadata      | Read-only    | Auto-granted; required for all GitHub Apps.                           |
| Workflows     | Read & Write | Modify `.github/workflows/*.yml` when an `implement` task touches CI. |

Leave all organisation and account permissions at **No access**. Principle of least privilege, see [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app).

### 1.6 Subscribe to events

| Checkbox                     | Actions handled                                                 | Handler                                |
| ---------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| Issue comments               | `issue_comment.created`                                         | `src/webhook/events/issue-comment.ts`  |
| Issues                       | `issues.labeled`, `issues.unlabeled`                            | `src/webhook/events/issues.ts`         |
| Pull requests                | `pull_request.opened` / `.labeled` / `.synchronize` / `.closed` | `src/webhook/events/pull-request.ts`   |
| Pull request reviews         | `pull_request_review.submitted`                                 | `src/webhook/events/review.ts`         |
| Pull request review comments | `pull_request_review_comment.created` / `.edited` / `.deleted`  | `src/webhook/events/review-comment.ts` |
| Pull request review threads  | `pull_request_review_thread.resolved` / `.unresolved`           | `src/webhook/events/review-thread.ts`  |
| Check runs                   | `check_run.completed`                                           | `src/webhook/events/check-run.ts`      |
| Check suites                 | `check_suite.completed`                                         | `src/webhook/events/check-suite.ts`    |

The shepherding reactor uses `synchronize`, `closed`, `edited`, `deleted`, `check_run`, and `check_suite` to early-wake active sessions on `Valkey ZADD ship:tickle`. Every subscribed event you do not handle still hits your webhook URL, keep this list tight.

> GitHub does not emit a `pull_request_review_thread.created` action. The only valid actions for that event are `resolved` and `unresolved`.

### 1.7 Install scope

| Option               | Use when                                                 |
| -------------------- | -------------------------------------------------------- |
| Only on this account | Personal or single-org private deployment (recommended). |
| Any account          | You plan to share the App publicly.                      |

Click **Create GitHub App**. GitHub assigns the **App ID** and redirects to the App's General settings.

## 2. Generate a private key

On the App's General settings:

1. Scroll to **Private keys**.
2. Click **Generate a private key**, GitHub immediately downloads `chrisleekr-bot.YYYY-MM-DD.private-key.pem`.
3. Move it to a password manager or secrets vault. **Never commit it.**

The full PEM (including `-----BEGIN…` / `-----END…` lines) is the value of `GITHUB_APP_PRIVATE_KEY`. Single-line `.env` form:

```bash
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n<KEY>\n-----END RSA PRIVATE KEY-----\n"
```

Or read from disk:

```bash
export GITHUB_APP_PRIVATE_KEY="$(awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' chrisleekr-bot.private-key.pem)"
```

See [Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps) for rotation.

## 3. Note the App ID

On the General settings page, the **About** section shows the numeric **App ID** (e.g. `123456`). Save it as `GITHUB_APP_ID`.

## 4. Install on repositories

In the App settings sidebar, click **Install App**, then **Install** next to the target account. Choose:

| Option                   | Effect                                                        |
| ------------------------ | ------------------------------------------------------------- |
| All repositories         | Access to every current and future repository on the account. |
| Only select repositories | Limited to repositories you explicitly choose (recommended).  |

After installation, the bot only responds to mentions in repositories where the App is installed.

## 5. Verify

1. **Settings → Developer settings → GitHub Apps → your app → Advanced**, redeliver a recent webhook.
2. Open an issue in an installed repository and post `@chrisleekr-bot triage this` (or `@chrisleekr-bot-dev` locally).
3. The bot posts a tracking comment within seconds.

If it doesn't, see the troubleshooting table in [`setup.md`](setup.md#testing-webhook-delivery).
