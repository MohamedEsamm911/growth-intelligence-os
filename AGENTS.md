# Growth Intelligence OS — Agent Operating Contract

## Read this first

This repository is the canonical codebase for **Growth Intelligence OS**.
Do not restart planning from scratch. Continue from the existing implementation and live runtime state.

## Human intent

The owner wants ChatGPT, Codex and ChatGPT Work to operate as one coordinated system.

- **ChatGPT conversation = command center / source of current intent.**
- **Codex = code executor and verifier.**
- **ChatGPT Work = browser/computer-use operator and multi-step external executor.**
- Do not create a parallel independent plan that diverges from the current chat.
- Before doing substantial work, read the latest user instruction in the active ChatGPT conversation and this file.

## Coordination model

1. Read the current ChatGPT conversation.
2. Determine the latest confirmed state and next unfinished task.
3. Continue from that exact point.
4. Execute work using the appropriate surface:
   - repository/code/tests -> Codex
   - browser / dashboards / connected apps / external multi-step UI -> Work
   - architectural review / prioritization / decision review -> ChatGPT
5. Feed concrete results back into the same conversation.
6. Never report success without evidence.

## Current product architecture

Standalone **Growth Intelligence OS**, with separate workspaces:
- Skill Up is the first operational workspace.
- Vertex is a second workspace.
- Do not embed research workers into Vertex production.

Core flow:

Discovery
-> Source Policy / Router
-> Fetch / Browser / Crawl
-> Structured Extraction
-> Verification
-> Evidence Graph
-> Entity Resolution
-> Enrichment
-> Temporal / Contradiction Resolution
-> Signals
-> Scoring
-> Activation Eligibility
-> Audience
-> Governed Publish

Research and Activation are separate. FOUND != CONTACTABLE.

## Current live zero-cost runtime

The current live runtime is temporarily hosted inside the existing Supabase sandbox using isolated `growth_live_*` tables/functions.

Important:
- Do not modify or delete existing Vertex sandbox tables.
- Do not touch Vertex Production.
- `growth_live_*` is isolated launch infrastructure.
- Fresh web data is the operational source.
- Historical datasets are retained for identity matching, comparison, and dedupe only; they must not masquerade as current truth.

Live capabilities already proven:
- Fresh discovery
- Watch sources
- Automated discovery cron
- Automated research cron
- Direct HTTP
- Jina Reader fallback
- Jina Search
- Google Places New IDs-only discovery
- Evidence
- Organizations
- Signals with confidence
- Public business-contact extraction with domain affinity guard
- Retry/backoff/failure visibility
- Public live status dashboard

## On-demand discovery target

The system must support requests such as:

"Find 100 logistics companies in Saudi Arabia"

Expected pipeline:
- generate several queries
- Jina Search
- Google Places IDs-only coverage
- remove directories/listicles/non-company results
- dedupe by canonical domain/entity
- verify official company sites
- research current evidence
- discover current decision makers
- discover public business contacts
- verify contacts
- score for Skill Up ICP
- build a reproducible audience

Do not count raw search results as companies.

## Full worker capability set

The full worker is intended to support:
- Scrapling
- Playwright
- Stagehand
- Crawl4AI
- Agent Reach
- Jina MCP
- SearXNG-compatible search

These are capability adapters, not the source of truth.
Core value remains Router + Evidence Graph + Entity Resolution + Policies + Signals + Scoring.

## Automation policy

There is no mandatory human-review queue.

Use:
retry -> alternate source -> alternate extractor -> browser escalation -> verification -> quarantine/dead-letter.

Unknown is not false.
Missing is not negative.
One source is not verified.
Old evidence is not current truth.

## Safety / operational boundaries

- No invented contacts.
- No blind merge based on name similarity alone.
- No raw email accepted as belonging to an organization unless ownership/domain evidence supports it.
- No automatic outbound messaging merely because a lead was discovered.
- Do not expose secrets in logs, commits, artifacts, or chat.
- Do not use paid providers by default.
- Preserve kill switches and fail-closed behavior.

## Verification

Before claiming completion:
- run the relevant unit/integration tests
- run project release verifier
- inspect live/runtime state where applicable
- report exact passed/failed/skipped counts and remaining limitations

## If blocked

Do not silently stop.
Return to the active ChatGPT conversation with:
- exact blocking condition
- exact task that was in progress
- evidence/log/error
- safest next executable step

If Work is available, Work should continue external/browser tasks.
If Codex is available, Codex should continue repository tasks.
