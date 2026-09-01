---
name: AI provider integration
about: Request or propose support for a new AI provider
labels: provider
---

## Provider name

Which AI provider are you proposing support for?

## API style

Is the provider's API OpenAI-compatible, a native/proprietary API, or a local runtime (for example Ollama)?

## Auth model

How does a caller authenticate with this provider (API key, OAuth, local socket, none)? Where would the credential come from, keeping in mind Loreline reads provider credentials from environment variables only and never persists them to artifacts or logs.

## Data residency notes

Where does the provider process and store data, and does that matter for the kinds of organizational knowledge Loreline captures?

## Why the shared provider layer cannot already express this

Loreline's pluggable AI provider support (tracked in #1) is meant to express providers through a shared, provider-neutral layer. Explain what about this provider does not fit that shared layer today, so we can decide whether to extend the shared layer or add provider-specific handling.
