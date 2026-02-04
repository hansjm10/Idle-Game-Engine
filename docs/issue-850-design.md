# Design: First-Class Input Events for Desktop Shell Controls

**Issue**: #850
**Status**: Draft - Classification Complete
**Feature Types**: Primary: API, Secondary: Workflow, Data Model

---

## 1. Scope

### Problem
The desktop shell currently forwards unmatched control/pointer events as an ad-hoc `SHELL_CONTROL_EVENT` runtime command with untyped metadata. This makes input handling harder to reason about, serialize, and replay deterministically.

### Goals
- [ ] Remove the implicit passthrough behavior and `SHELL_CONTROL_EVENT` usage from the desktop shell input pipeline.
- [ ] Keep pointer-driven UI interactions working in the test-game desktop shell.
- [ ] Define a well-typed, serializable payload shape for forwarded input events (including pointer events).

### Non-Goals
- Add support for every possible input device/event type (gamepad, multi-touch gestures, etc.) beyond what is needed to preserve existing pointer UI behavior.
- Redesign the renderer/UI system or change unrelated runtime command queue semantics.

### Boundaries
- **In scope**: `packages/shell-desktop` input capture and IPC flow, `@idle-engine/controls` event→command mapping behavior as needed, and any core/controls contracts required to represent input events deterministically.
- **Out of scope**: Replay file/container format changes, renderer contract changes, or new UI widgets/interaction patterns beyond maintaining current behavior.

---

## 2. Workflow
[To be completed in design_workflow phase]

## 3. Interfaces
[To be completed in design_api phase]

## 4. Data
[To be completed in design_data phase]

## 5. Tasks
[To be completed in design_plan phase]

## 6. Validation
[To be completed in design_plan phase]
