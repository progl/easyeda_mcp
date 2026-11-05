# Autoroute net context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Preserve complete native net metadata when an autoroute request omits its net list but excludes some nets.

**Architecture:** For this one request shape, collect a strict public native inventory of net names and component-pad/track/via membership. Store its canonical fingerprint in the prepared receipt, materialize all native net names as SDK RoutingNets, and independently compare membership before the single routing dispatch. Explicit net lists remain unchanged and receive a scope warning when exclusions are supplied.

**Tech Stack:** TypeScript, existing EasyEDA public APIs, MutationLifecycle, Vitest.

**Spec:** Approved narrow design in this session: default-empty nets plus nonempty ignoreNets; complete union proof and stale guard; no Source API, CAD calls during development, deployment, or routing-completion guarantees.

## Global Constraints

- No live CAD/CLI operations, deployment, restarts, publication, or version bump.
- Preserve existing autoroute behavior for empty exclusions and explicit net lists.
- Evidence covers net membership only, not geometric preservation or WASM clearance.
- Keep the existing routing lifecycle timeout and unknown/no-replay semantics.
- Native inventory failure must prevent implicit empty RoutingNets dispatch.

## Review Focus

- Names present only on pads, tracks, or vias must survive materialization.
- Missing native APIs, malformed data, duplicate IDs, and target drift must fail before routing.
- Same-count net renaming or membership edits must invalidate the prepared fingerprint.
- Read-only collection that times out must never dispatch routing later.
- Preview must distinguish complete metadata context from the effective routing selection.

### Task 1: Materialize and guard the default excluded-net context

**Files:** Create `extension/src/mutation/routingNetContext.ts` and `.test.ts`; modify `pcbRoutingMutations.ts`, `pcbRoutingMutations.test.ts`, and `docs/tools.md`.

- [x] Add failing collector and integration tests for union completeness, strict failure, default materialization, effective selection preview, and pre-dispatch staleness.
- [x] Run focused tests and confirm the expected failures.
- [x] Implement bounded public inventory collection with stable canonical membership fingerprint; do not include or claim geometric proof.
- [x] Materialize only the approved request shape and save the immutable context in the receipt; keep preview compact.
- [x] Independently reread the context before the one SDK call and fail stale/unverified contexts without writes.
- [x] Preserve explicit selection semantics; add an honest warning for explicit lists with exclusions.
- [x] Run focused tests, full suite, both TypeScript checks, and source ESLint.
- [x] Document the behavior and its limits; provide the reviewable source delta for independent review. Do not package or deploy.

Verification: 33 focused tests; 1,174 tests across102 files; both TypeScript checks; source ESLint; formatting and diff checks passed. Independent manual review remains pending. No build/package/deployment or CAD execution was performed.
