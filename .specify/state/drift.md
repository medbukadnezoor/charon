# Drift Report

Updated: 2026-05-13 17:55 +0700

## Latest summary
- Status: pass
- health overview: pass
- health summary: All 8 repo-owned health surfaces pass.
- health subsystems: command/help/docs=pass, manifest=pass, mirror-lock/shim=pass, memory=pass, continuity-state=pass, roots=pass, role-contract=pass, docs-health=pass
- sync needed: no
- default-root operations safe: yes
- pre-hermes readiness: pre-hermes-foundation-ready
- command/help/docs consistency: pass
- command/help/docs root: <workflow-manager>
- command/help/docs summary: CLI commands, wrapper guidance, help text, and repo docs align with the current v2 model.
- role-contract health: pass
- role-contract path: ./ROLES.md
- role-contract summary: Canonical role contract, reserved Tester slot, and local pointer are aligned.
- docs-health: pass
- docs-health root: .
- docs-health summary: All 13 governed documentation files are within budget and aligned.
- manifest health: pass
- manifest path: ./.workflow/workflow.json
- manifest summary: Manifest matches the current v2 repo model.
- mirror-lock/shim health: pass
- mirror-lock/shim path: ./.workflow/mirror-lock.json
- mirror-lock/shim summary: Mirror lock, AGENTS.md, generated shims, and managed adapters are aligned.
- workflow sync needed: no
- memory health: pass
- memory root: ./.specify/memory
- memory summary: All 5 memory files are structurally healthy.
- continuity-state health: pass
- continuity-state root: ./.specify/state
- continuity-state summary: All 5 continuity-state files are structurally healthy.
- roots health: pass
- roots config: <workflow-manager>/.workflow/roots.json
- roots summary: All 2 configured roots are usable.
- default root operations: safe
- git: dirty (43 paths changed)
- legacy coexistence: none detected

## Health overview
- Overall health: pass
- Summary: All 8 repo-owned health surfaces pass.
- Subsystems: command/help/docs=pass, manifest=pass, mirror-lock/shim=pass, memory=pass, continuity-state=pass, roots=pass, role-contract=pass, docs-health=pass
- Sync needed: no
- Default-root operations safe: yes
- Pre-Hermes readiness: pre-hermes-foundation-ready

## Command/help/docs consistency
- Status: pass
- Path: `<workflow-manager>`
- Summary: CLI commands, wrapper guidance, help text, and repo docs align with the current v2 model.

## Manifest health
- Status: pass
- Path: `./.workflow/workflow.json`
- Summary: Manifest matches the current v2 repo model.

## Role-contract health
- Status: pass
- Path: `./ROLES.md`
- Summary: Canonical role contract, reserved Tester slot, and local pointer are aligned.
- Canonical roles: architect, coder, verifier
- Reserved roles: tester

## Docs health
- Status: pass
- Path: `.`
- Summary: All 13 governed documentation files are within budget and aligned.

## Mirror-lock/shim health
- Status: pass
- Path: `./.workflow/mirror-lock.json`
- Summary: Mirror lock, AGENTS.md, generated shims, and managed adapters are aligned.
- Sync needed: no

## Memory health
- Status: pass
- Path: `./.specify/memory`
- Summary: All 5 memory files are structurally healthy.

## Continuity-state health
- Status: pass
- Path: `./.specify/state`
- Summary: All 5 continuity-state files are structurally healthy.

## Roots health
- Status: pass
- Config path: `<workflow-manager>/.workflow/roots.json`
- Summary: All 2 configured roots are usable.
- Default root-based operations safe: yes
