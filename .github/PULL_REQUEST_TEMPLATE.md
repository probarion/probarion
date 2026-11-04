<!--
Title: one plain sentence that a stranger understands, with no task or review ids (they go below).
Base branch: dev. Only the promotion PR targets main.
-->

## Summary

<!-- What this PR does, in one or two sentences. -->

## Why

<!-- The problem or the goal. Link the issue, spec section or runbook it serves, and put any task or review ids here. -->

## What changed

<!-- The behaviour and the files that changed, as a short list. -->

## Safety

<!--
What can this change about funds, keys, mandates, the ledger or anyone's authority (owner, approver,
agent key, ledger key, factory owner), and what stops it going wrong: a contract check, a test, a pin?
When nothing applies, write "none" and the reason, for example "none: docs only".
-->

## Tests

<!--
The commands you ran and their results, for example "pnpm verify: all pass".
Name the CI jobs that cover what a local run cannot (sandbox, reproducible).
-->

## Docs

<!-- README, CHANGELOG `## Unreleased`, specs and runbooks touched, or "none" and why. -->

## Review

<!--
The independent review rounds that ran, and the findings raised, confirmed and fixed.
If there was no review, say so plainly.
-->

## Checklist

- [ ] One focused change.
- [ ] `pnpm verify` passes, or the CI jobs that cover what it cannot are named under Tests.
- [ ] A contract change has its code hash recorded from the CI reproducible build in `contracts/code-hashes.json`, or names the follow-up that records it (a hash comes from a CI push run, never from a pull request run).
- [ ] No secrets, keys or local paths.
- [ ] The PR title is a sentence a stranger understands, with no task ids.
- [ ] No mainnet value was moved by an agent: the OWNER signs every mainnet transaction.
