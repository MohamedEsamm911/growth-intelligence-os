# Codex + ChatGPT Work Handoff

## Purpose

The owner does not want Codex or Work to execute as isolated assistants.
They should follow and extend the main ChatGPT conversation.

## ChatGPT Work role

Use Work / Computer Use as the external operations layer.

Work should:
- open the active ChatGPT conversation when instructed by the owner
- read the latest state and next task
- navigate Supabase, GitHub, Google Cloud, Cloudflare, Railway or other approved dashboards
- execute multi-step browser workflows
- download/upload artifacts when needed
- validate the real UI state rather than assuming it
- post concrete outcomes back into the same conversation

Work should not:
- invent a new architecture
- restart the project from scratch
- create a separate hidden plan
- delete or overwrite existing systems without an explicit instruction

## Codex role

Codex is the repository execution layer.

Repository:
`MohamedEsamm911/growth-intelligence-os`

Codex should:
- read `AGENTS.md`
- inspect the existing implementation before editing
- continue the latest task from the ChatGPT conversation
- use TDD / tests for behavioral changes
- keep production and zero-cost runtime contracts aligned
- run verification before claiming success
- keep migrations and deployed runtime code versioned in Git

## Communication protocol

When either Codex or Work finishes a step, return these four things to the main conversation:

1. What changed
2. Exact evidence it worked
3. What remains
4. The next executable step

When blocked, return the actual blocker instead of waiting.

## Current top unfinished sequence

1. Finish On-Demand Audience quality gates.
2. Reach a verified-company target rather than a raw-result target.
3. Add current decision-maker discovery.
4. Add public business contact verification.
5. Connect full entity resolution.
6. Connect scoring and Audience Builder.
7. Connect DNC/history/activation.
8. Build the full Command Center where the owner can request an audience directly.
9. Run the full worker in an internet-enabled runner and verify Scrapling/Playwright/Stagehand/Crawl4AI/Agent Reach/Jina MCP.
10. Keep Skill Up as first real workspace, then reuse the same engine for Vertex.
