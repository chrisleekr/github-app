---
hide:
  - toc
---

# GitHub App

A GitHub App that responds to `@chrisleekr-bot` mentions on pull requests and issues, powered by the Claude Agent SDK. Every webhook is acknowledged in under ten seconds and handed to the daemon fleet over WebSocket; when triage flags the job as heavy or the queue backs up, the orchestrator spawns an ephemeral daemon Pod on Kubernetes so the same image scales on demand.

## Three doors

<div class="grid cards" markdown>

-   :material-account-voice:{ .lg .middle } __Use the bot__

    ---

    Trigger workflows from comments, labels, or natural language. See what each `bot:*` command does and how to stop one mid-flight.

    [:octicons-arrow-right-24: Start with invocation](use/invoking.md)

-   :material-server:{ .lg .middle } __Run the service__

    ---

    Get from `git clone` to a webhook receiving production traffic. Configuration, deployment, observability, and runbooks for the most common Day-2 issues.

    [:octicons-arrow-right-24: Start with setup](operate/setup.md)

-   :material-code-braces:{ .lg .middle } __Build on it__

    ---

    Architecture, request flow, and how to add a new workflow or MCP server. Conventions and contribution rules.

    [:octicons-arrow-right-24: Start with architecture](build/architecture.md)

</div>

This site tracks the `main` branch. Release history lives in the [changelog](changelog.md).
