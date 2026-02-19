---
title: "renderer-webgpu: investigate writeBuffer size validation error (Issue 847)"
sidebar_position: 99
---

# renderer-webgpu: investigate writeBuffer size validation error (Issue 847)

## Document Control
- **Title**: Investigate root cause of WebGPU `writeBuffer` "Number of bytes to write is too large" error
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-02-19
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/847
- **Execution Mode**: AI-led

## 1. Summary
Issue #847 reports intermittent WebGPU device loss with:
`Failed to execute 'writeBuffer' on 'GPUQueue': Number of bytes to write is too large`.

The root cause is unit mismatch in `GPUQueue.writeBuffer(...)` arguments when uploading instance data from a `Float32Array`. The renderer passed `usedBytes` as `size`, but for typed-array uploads WebGPU interprets `size` in **elements**, not bytes. This could request 4x more data than intended on `Float32Array`.

## 2. Findings
- Upload path: `packages/renderer-webgpu/src/webgpu-renderer.ts` `#flushQuadBatch()`.
- Previous call shape:
  - `queue.writeBuffer(instanceBuffer, 0, batchBufferFloat32, 0, usedBytes)`
- With `Float32Array`, that means:
  - intended bytes: `usedBytes`
  - interpreted bytes: `usedBytes * Float32Array.BYTES_PER_ELEMENT`
- Example from existing quad tests:
  - 22 instances => `usedBytes = 22 * 52 = 1144`
  - incorrect interpreted write size => `1144 * 4 = 4576` bytes
  - destination GPU instance buffer may be smaller (e.g. 2048 bytes), which triggers the exact validation error.

## 3. Decision
- Keep the typed-array upload path (no per-frame allocation/copy).
- Pass `lengthFloats` (element count) as `size` for `Float32Array` uploads.
- Add regression coverage that simulates strict validation semantics and fails if byte counts are passed as element counts.

This is a targeted, long-term fix and avoids the extra allocation overhead of converting every upload into a new exact-size `ArrayBuffer`.

## 4. Design Alignment
- `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md` expects robust renderer behavior under WebGPU runtime variance and device-loss scenarios.
- `docs/issue-846-design.md` favors explicit handling of backend validation differences and regression tests to prevent recurrence.

The Issue #847 fix aligns with both by encoding API semantics directly in the upload path and test suite.

## 5. Verification Plan
- Unit tests in `@idle-engine/renderer-webgpu`:
  - validate instance upload argument semantics,
  - preserve batching behavior and instance payload correctness.
- Standard package checks:
  - `pnpm --filter @idle-engine/renderer-webgpu test`
  - `pnpm --filter @idle-engine/renderer-webgpu lint`
  - `pnpm --filter @idle-engine/renderer-webgpu build`

## 6. Follow-Up
- If future code paths use typed-array `writeBuffer` with explicit `size`, enforce the same element/byte rule in helper utilities or shared upload wrappers.
- Keep a focused regression test around this API contract to avoid reintroducing byte/element confusion.

## 7. References
- Issue #847: https://github.com/hansjm10/Idle-Game-Engine/issues/847
- WebGPU `GPUQueue.writeBuffer` semantics (typed-array `size` unit): https://www.w3.org/TR/2022/WD-webgpu-20220608/#dom-gpuqueue-writebuffer
- Renderer file: `packages/renderer-webgpu/src/webgpu-renderer.ts`
