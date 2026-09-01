# Security Policy

Loreline is local-first: it reads your repository and writes artifacts under `.loreline/` on your own machine, and it does not transmit anything off that machine unless you explicitly opt in. This policy explains how to report a vulnerability, what Loreline's trust boundaries are, and what a release must do before it adds any outbound transmission.

## Supported versions

Loreline is pre-1.0. Only the latest published 0.x minor version receives security fixes.

| Version | Supported |
| --- | --- |
| Latest 0.x minor | Yes |
| Older 0.x minors | No |

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Report it privately using GitHub's private vulnerability reporting at:

https://github.com/tysoncung/loreline/security/advisories/new

You should receive an acknowledgement within 72 hours and a status update at least every 7 days while the report is investigated. We follow coordinated disclosure: details are published only after a fix has been released.

## Threat model and trust boundaries

Loreline's design goal is that organizational knowledge stays under your control. There are three trust boundaries to be aware of:

1. **The scanned repository content.** `loreline scan` and `loreline interview` read files from the repository you point Loreline at. This content stays on your machine; it is not sent anywhere by the scan or interview commands themselves.
2. **Generated `.loreline/` artifacts.** `readiness.json`, `readiness.md`, interview records, `context.md`, `context.json`, and `verification.json` can contain sensitive organizational knowledge, including anything captured during an interview. These artifacts should be access-controlled the same way you would control access to source code, for example by keeping them out of public repositories or restricting who can read them in private ones.
3. **Future opt-in AI provider transmissions.** Planned pluggable AI provider integrations (tracked in #1 and #8) will only transmit repository or interview content off the local machine when a user explicitly passes an `--ai` flag, and only after showing a preview of what would be sent. Nothing is transmitted implicitly.

Provider credentials, when AI provider support lands, are read from environment variables only. Loreline must never write credentials into generated artifacts or into log output.

## Release security checklist

Any release that adds a new outbound transmission path (for example, the AI provider integrations above) must confirm the following before publishing:

- **Secret scan coverage:** repository and interview content that could be sent is scanned for likely secrets and credentials before transmission.
- **Preview accuracy:** the preview shown to the user before transmission matches exactly what is sent, with no undisclosed additions.
- **No-credential-persistence test:** an automated test confirms provider credentials are never written to `.loreline/` artifacts or to log output.
- **Documented data handling:** the release notes and relevant documentation describe what data leaves the machine, when, and to which provider.
