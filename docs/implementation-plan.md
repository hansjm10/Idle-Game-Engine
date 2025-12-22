---
title: Idle Engine Implementation Plan
---

# Idle Engine Implementation Plan

This document converts the design document into actionable engineering work. It spans the prototype milestone and sets up later phases so we do not write production code without agreed priorities, scope, and success criteria.

## Document Control
- **Title**: Idle Engine Implementation Plan - Prototype to Production
- **Authors**: TBD
- **Reviewers**: TBD
- **Status**: Draft
- **Last Updated**: 2025-12-21
- **Related Issues**: TBD
- **Execution Mode**: AI-led

## 1. Summary
This implementation plan establishes a phased approach to building the Idle Engine from prototype through production-ready state. The plan emphasizes prototype-first delivery with deterministic behaviors, shared tooling, incremental delivery via feature flags, and single-responsibility pull requests. Six phases (0-5) cover foundations, runtime core, content DSL, presentation shell integration, persistence/offline capabilities, and social features with authentication, culminating in a hardening and demo phase. The plan is designed for AI-orchestrated execution with clear task decomposition and exit criteria.

## 2. Context & Problem Statement
- **Background**: The Idle Engine project requires a structured implementation roadmap that converts design specifications into executable engineering work. The system must support deterministic gameplay mechanics, content authoring via DSL, social features, and offline progression.
- **Problem**: Without a clear implementation plan, work risks becoming uncoordinated, lacking clear priorities, and missing critical success criteria. The prototype milestone needs explicit scope boundaries and phase-based delivery to ensure core functionality is proven before expansion.
- **Forces**:
  - Must maintain deterministic behavior across all runtime operations
  - AI-orchestrated development requires explicit task decomposition and contracts
  - Monorepo architecture demands consistent tooling and testing
  - React 19/Vite 7/Express 5 beta dependencies introduce compatibility risks
  - Keycloak integration for authentication requires reliable local development setup

## 3. Goals & Non-Goals
### Goals
1. Ship a vertical slice proving runtime loop, content DSL, and social scaffolding in the prototype milestone
2. Establish deterministic, testable runtime core with profiling and observability hooks
3. Implement centralized tooling (linting, testing, validation) across monorepo packages
4. Enable incremental delivery with feature flags and single-responsibility PRs
5. Deliver working offline progression with 12-hour deterministic replay capability
6. Integrate authentication and social features (leaderboards, guilds) with Keycloak
7. Provide comprehensive documentation for onboarding, APIs, and operational runbooks

### Non-Goals
- Building production-scale features before prototype validation
- Expanding scope beyond defined phases without explicit approval
- Implementing advanced social features beyond leaderboard/guild stubs in prototype
- Production database optimization before Phase 5

## 4. Stakeholders, Agents & Impacted Surfaces
### Primary Stakeholders
- Core development team
- Content authors using the DSL
- End users playing the idle game

### Agent Roles
- **Runtime Implementation Agent**: Implements core runtime systems, state management, and deterministic scheduler
- **Content Pipeline Agent**: Develops DSL schemas, compiler, validation CLI, and sample content packs
- **UI Integration Agent**: Builds presentation shell, Worker bridge, and React components
- **Social Services Agent**: Implements authentication flows, leaderboard/guild APIs, and Keycloak integration
- **Tooling Automation Agent**: Manages CI/CD, lint/test configs, and monorepo infrastructure
- **Ops & Infrastructure Agent**: Handles Docker setup, IaC templates, and deployment automation

### Affected Packages/Services
- `@idle-engine/core` - Runtime state model, scheduler, systems framework
- `@idle-engine/content-schema` - Content DSL validation and compilation
- `@idle-engine/content-sample` - Sample content pack
- `@idle-engine/config-eslint` - Shared linting configuration
- `@idle-engine/config-vitest` - Shared testing setup
- Presentation shell (React/Vite application)
- Social service (Express API with Keycloak auth)

### Compatibility Considerations
- React 19 and Vite 7 Worker compatibility must be verified
- Express 5 beta API stability monitoring required
- Content DSL versioning and migration strategy needed
- Backward compatibility for save slot migrations

## 5. Current State
The project currently has:
- Basic monorepo structure with pnpm workspace
- Skeleton implementations of runtime core (tick accumulator)
- Social service scaffolding with basic routes
- Docker compose setup (requires dependency installation fixes)
- Lefthook pre-commit hooks for local development
- No CI/CD pipeline yet
- Incomplete test coverage across packages
- Keycloak integration in progress but missing realm bootstrap

Key gaps:
- Missing GitHub Actions CI pipeline
- Social service Docker build fails due to pnpm dependency issues
- No Keycloak realm bootstrap for local development
- Minimal Vitest coverage for existing code
- Content DSL and compiler not yet implemented
- Persistence layer not implemented

## 6. Proposed Solution
### 6.1 Architecture Overview
The implementation follows a six-phase approach, with each phase building on previous work and gated by clear deliverables. AI agents execute tasks within defined contracts, with human oversight at phase boundaries and architecture reviews when interfaces change.

**Workstreams:**
1. **Runtime Core**: Deterministic scheduler, state graph, systems framework
2. **Content Pipeline**: DSL schemas, compiler, validation CLI, sample content
3. **Presentation Shell**: Web UI consuming runtime snapshots via Worker bridge
4. **Social Services**: Leaderboards, guild API, Keycloak integration
5. **Tooling & QA**: Monorepo infrastructure, lint/test configs, CI/CD
6. **Delivery & Ops**: Docker, IaC, release management

### 6.2 Detailed Design

#### Runtime Changes
- Command queue with priority tiers (player, automation, system)
- `ResourceState` struct-of-arrays storage with mutation helpers
- Events subsystem with typed publish/subscribe
- `DiagnosticTimeline` for tick duration and system timing capture
- Serialized state snapshot/delta publisher for Worker messaging
- Offline catch-up processing with caps and deterministic replay

#### Data & Schemas
- Zod schemas for: metadata, resources, generators, upgrades, prestige, guild perks
- Compiler transforms JSON/YAML/TS modules into normalized engine definitions
- Content validation CLI with severity levels and actionable reporting
- Save slot manager with migration hooks
- Import/export capability with hashed integrity checks (dev flag)

#### APIs & Contracts
- Worker bridge postMessage contract between runtime and React shell
- Typed state/snapshot contract stubs (published Week 2 of Phase 1)
- Auth hooks/SDK bridge for token fetch/refresh
- Social service REST APIs: leaderboard ranking, guild roster (join/leave/invite)
- Rate limiting on social endpoints

#### Tooling & Automation
- `@idle-engine/config-eslint` shared linting
- `@idle-engine/config-vitest` shared test setup with `vitest-llm-reporter`
- Husky/lefthook pre-commit hooks
- `pnpm generate` for content validation and compilation
- Automated accessibility testing via axe-core/Playwright

### 6.3 Operational Considerations

#### Deployment
- GitHub Actions pipeline: install → lint → test → build matrix
- Docker compose including Postgres and Keycloak with config import
- Terraform module stubs for self-host deployment
- Release versioning policy and changelog process

#### Telemetry & Observability
- Profiling counters and event bus in diagnostics interface
- Devtools overlay for tick metrics and state diff inspection
- Request metrics and anomaly alerts on social service endpoints
- Performance profiling to confirm CPU/memory budgets

#### Security & Compliance
- Keycloak realm configuration with proper client/scopes/roles
- Token validation middleware on all protected routes
- Rate limiting on social API endpoints
- Audit logging for sensitive operations
- Security review checklist for auth flows

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

#### Phase 0 – Foundations (Weeks 0-1)
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(tooling): add GitHub Actions CI pipeline | Install, lint, test across monorepo | Tooling Automation Agent | None | Pipeline runs on PR, mirrors lefthook |
| fix(social): update Docker build for pnpm | Fix dependency installation in container | Ops & Infrastructure Agent | None | `docker-compose build` succeeds |
| feat(social): add Keycloak realm bootstrap | Import script/seed container for JWKS | Social Services Agent | None | Local dev acquires JWKS |
| test(core): add tick accumulator coverage | Vitest tests for current skeleton | Runtime Implementation Agent | None | Tests green, coverage >80% |
| test(social): add route validator coverage | Vitest tests for route validation | Social Services Agent | None | Tests green, coverage >80% |
| feat(tooling): create shared ESLint config | `@idle-engine/config-eslint` package | Tooling Automation Agent | None | All workspaces consume config |
| feat(tooling): create shared Vitest config | `@idle-engine/config-vitest` with LLM reporter | Tooling Automation Agent | None | All workspaces use setup |
| feat(tooling): configure pre-commit hooks | Husky/lefthook lint/test/build | Tooling Automation Agent | Shared configs | Hooks prevent bad commits |
| docs(tooling): add .nvmrc and toolchain docs | Node/pnpm version standards | Tooling Automation Agent | None | Consistent versions across team |
| feat(tooling): automate project board updates | Auto-add issues, enforce PR keywords | Tooling Automation Agent | CI pipeline | Issues auto-tracked |

#### Phase 1 – Runtime Skeleton (Weeks 1-3)
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): implement command queue | Priority tiers (player/automation/system) | Runtime Implementation Agent | Phase 0 | Tests cover priority ordering |
| feat(core): define ResourceState storage | Struct-of-arrays with mutation helpers | Runtime Implementation Agent | Phase 0 | Unit tests green |
| feat(core): create events subsystem | Typed publish/subscribe | Runtime Implementation Agent | Phase 0 | Integration tests pass |
| feat(core): add DiagnosticTimeline | Capture tick/system timings | Runtime Implementation Agent | Events subsystem | Profiling data accessible |
| feat(core): implement snapshot publisher | Serialized state/delta for Worker | Runtime Implementation Agent | ResourceState | Contract docs published |
| test(core): tick accumulator unit tests | Catch-up, clamping, zero-delta | Runtime Implementation Agent | Command queue | Coverage >90% |
| docs(core): publish API contract stubs | Typed state/snapshot contracts | Runtime Implementation Agent | Snapshot publisher | Docs freeze by Week 2 |

#### Phase 2 – Content DSL & Sample Pack (Weeks 2-4)
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(content): define Zod schemas | Metadata, resources, generators, etc. | Content Pipeline Agent | Phase 1 contract freeze | Schemas validate sample data |
| feat(content): build compiler | TS/JSON/YAML → normalized definitions | Content Pipeline Agent | Zod schemas | Deterministic output ordering |
| feat(content): add validation CLI | Severity levels, actionable output | Content Pipeline Agent | Compiler | CLI rejects invalid samples |
| feat(content): create extended sample pack | 10 resources, 6 generators, 3 upgrades, prestige, guild stub | Content Pipeline Agent | Compiler | `@idle-engine/content-sample` builds |
| test(content): property-based formula tests | Stats never negative, etc. | Content Pipeline Agent | Compiler | Fast-check tests pass |
| docs(content): DSL usage guidelines | Naming, versioning, compatibility | Content Pipeline Agent | Validation CLI | Contributors can author content |
| feat(content): integrate pnpm generate | Workspace validation, machine-readable output | Content Pipeline Agent | Validation CLI | Post-edit workflow documented |

#### Phase 3 – Presentation Shell Integration (Weeks 3-5)
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(ui): create Worker bridge | PostMessage contract with runtime | UI Integration Agent | Phase 1 snapshot API | Init, command, snapshot channels work |
| feat(ui): implement React context provider | Engine state subscriptions | UI Integration Agent | Worker bridge | Components consume state |
| feat(ui): build ResourcePanel component | Display resource state | UI Integration Agent | Context provider | Renders dynamic data |
| feat(ui): build GeneratorGrid component | Generator cards with actions | UI Integration Agent | Context provider | Buy/sell interactions work |
| feat(ui): build UpgradeDialog component | Upgrade modal with purchase | UI Integration Agent | Context provider | Modal shows, processes purchase |
| feat(ui): build GuildPanel component | Guild placeholder UI | UI Integration Agent | Context provider | Displays stub data |
| feat(ui): add devtools overlay | Tick metrics, state diff inspection | UI Integration Agent | DiagnosticTimeline | Hotkey toggles overlay |
| test(ui): Playwright smoke tests | Load, buy generator, observe increase | UI Integration Agent | All UI components | End-to-end test passes |
| test(ui): accessibility checks | Axe-core integration in CI | UI Integration Agent | Shared tooling | No critical a11y violations |

#### Phase 4 – Persistence & Offline (Weeks 4-6)
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): implement save slot manager | IndexedDB/localStorage with migrations | Runtime Implementation Agent | Phase 1 | Save/load works across sessions |
| feat(core): add offline catch-up processing | Caps, deterministic replay | Runtime Implementation Agent | Save slot manager | 12-hour offline test passes |
| feat(core): build offline soak test harness | Automated 12-hour replay | Runtime Implementation Agent | Catch-up processing | Reports shared with QA |
| feat(core): add import/export capability | Debug feature with integrity check | Runtime Implementation Agent | Save slot manager | Behind dev flag, hashed |
| test(core): migration fixture tests | Verify save migrations | Runtime Implementation Agent | Save slot manager | Old saves load correctly |

#### Phase 5 – Social Stub & Auth (Weeks 5-7)
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(social): configure Keycloak realm | Automate provisioning script | Social Services Agent | Phase 0 bootstrap | Realm script idempotent |
| feat(social): extend social service routes | In-memory persistence, validation | Social Services Agent | Keycloak realm | CRUD operations work |
| feat(social): implement leaderboard ranking | Deterministic tie-breaking | Social Services Agent | Routes extended | Rankings correct |
| feat(social): implement guild roster endpoints | Join/leave/invite with rate limits | Social Services Agent | Routes extended | Rate limits enforced |
| feat(ui): integrate token fetch/refresh | Auth hooks/SDK bridge | UI Integration Agent | Keycloak realm | Token lifecycle managed |
| feat(ui): display leaderboard in shell | Connect to stub backend | UI Integration Agent | Token integration | Shows rankings |
| feat(ui): display guild info in shell | Connect to stub backend | UI Integration Agent | Token integration | Shows guild roster |
| test(social): end-to-end auth test | Post score, display ranking, deny invalid token | Social Services Agent | All social features | E2E test green |
| feat(social): add request metrics | Instrumentation and anomaly alerts | Social Services Agent | Routes extended | Metrics observable |

#### Phase 6 – Hardening & Demo (Weeks 7-8)
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| perf(core): performance profiling | Identify hotspots, confirm budgets | Runtime Implementation Agent | All phases complete | CPU/memory within targets |
| security(social): auth flow review | Checklist for auth, rate limits, audit logs | Social Services Agent | Phase 5 | Security checklist passed |
| docs: onboarding guide | Developer setup instructions | Tooling Automation Agent | All phases | New dev can start in `<30min` |
| docs: API references | Runtime, content, social APIs | Content Pipeline Agent | All phases | API docs complete |
| docs: operational runbooks | Health checks, log inspection, restart | Ops & Infrastructure Agent | All phases | On-call runbook ready |
| docs: partner briefing deck | Demo materials and overview | TBD | All phases | Stakeholder presentation ready |
| milestone: demo & retrospective | Lock next phase priorities | All agents | All tasks | Retro action items captured |

### 7.2 Milestones

**Phase 0 – Foundations (Weeks 0-1)**
- **Deliverables**: CI pipeline, shared tooling configs, Docker fixes, Keycloak bootstrap, basic test coverage
- **Timeline**: 1 week
- **Gating Criteria**: All Phase 0 tasks green; CI runs successfully on PRs

**Phase 1 – Runtime Skeleton (Weeks 1-3)**
- **Deliverables**: Command queue, ResourceState, events, diagnostics, snapshot API, contract docs
- **Timeline**: 2 weeks
- **Gating Criteria**: API contract freeze by Week 2; all tests green; docs published

**Phase 2 – Content DSL & Sample Pack (Weeks 2-4)**
- **Deliverables**: Zod schemas, compiler, validation CLI, extended sample pack, DSL docs
- **Timeline**: 2 weeks (starts after Phase 1 Week 2 contract freeze)
- **Gating Criteria**: `pnpm generate` workflow documented; sample pack builds and validates

**Phase 3 – Presentation Shell Integration (Weeks 3-5)**
- **Deliverables**: Worker bridge, React components, devtools overlay, Playwright tests, a11y checks
- **Timeline**: 2 weeks
- **Gating Criteria**: End-to-end smoke test passes; no critical accessibility violations

**Phase 4 – Persistence & Offline (Weeks 4-6)**
- **Deliverables**: Save slot manager, offline catch-up, 12-hour soak test, import/export
- **Timeline**: 2 weeks
- **Gating Criteria**: 12-hour offline simulation automated test passes; migrations verified

**Phase 5 – Social Stub & Auth (Weeks 5-7)**
- **Deliverables**: Keycloak realm, social routes, leaderboard/guild logic, token integration, E2E auth test
- **Timeline**: 2 weeks
- **Gating Criteria**: End-to-end test posts score, displays ranking, denies invalid token

**Phase 6 – Hardening & Demo (Weeks 7-8)**
- **Deliverables**: Performance profiling, security review, comprehensive docs, demo, retrospective
- **Timeline**: 1 week
- **Gating Criteria**: All documentation complete; demo scenario successful; retro action items logged

### 7.3 Coordination Notes

**Hand-off Package**: Each agent receives:
- Relevant design doc sections
- API contract specifications (when dependencies published)
- Test coverage requirements (>80% for new code)
- Commit message conventions (conventional commits)
- Link to this implementation plan

**Communication Cadence**:
- Weekly status summaries from AI orchestration (burn-down, risks, decisions)
- Architecture reviews when contracts change (automated alerts for human audit)
- Project board auto-updates from task completion
- Phase boundary reviews before proceeding to next phase

**Escalation Path**:
- Blockers surfaced immediately in weekly summary
- Architecture conflicts trigger human review
- Scope change requests require explicit approval

## 8. Agent Guidance & Guardrails

### Context Packets
Agents must load before execution:
- This implementation plan
- Relevant design documents from `docs/` directory
- API contract specifications (published in Phase 1 Week 2)
- Shared tooling configurations (`@idle-engine/config-eslint`, `@idle-engine/config-vitest`)
- Repository README and contribution guidelines

### Prompting & Constraints

**Commit Message Format**:
```
<type>(<scope>): <description>

[optional body]

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `ci`

**Naming Conventions**:
- Packages: `@idle-engine/<name>` (lowercase, hyphenated)
- Components: PascalCase
- Functions/variables: camelCase
- Constants: UPPER_SNAKE_CASE
- Files: kebab-case for source, PascalCase for components

**Code Style**:
- Use shared ESLint/Prettier configs
- TypeScript strict mode enabled
- Prefer explicit types over inference for public APIs
- Document exported functions/classes with TSDoc

### Safety Rails

**Forbidden Actions**:
- Do not reset git history on main/shared branches
- Do not commit secrets, credentials, or `.env` files
- Do not disable linting/testing without documented justification
- Do not modify published API contracts without architecture review
- Do not skip migration scripts for breaking schema changes

**Data Privacy**:
- No PII in logs or diagnostics
- Audit logs must not expose sensitive user data
- Token/credential handling follows security review checklist

**Rollback Procedures**:
- Feature flags protect WIP functionality
- Database migrations include down scripts
- Docker images tagged with git SHA for rollback
- CI prevents deployment if tests fail

### Validation Hooks

Before marking task complete, agents must:
1. Run `pnpm lint` - no errors
2. Run `pnpm test` - all tests pass
3. Run `pnpm build` - builds successfully
4. For content changes: `pnpm generate` - validation passes
5. For UI changes: Playwright smoke tests pass
6. For API changes: Contract docs updated
7. Commit follows conventional commit format
8. PR description includes acceptance criteria verification

## 9. Alternatives Considered

### Monolith vs. Microservices
**Rejected**: Full microservices architecture for prototype
**Rationale**: Overhead of service coordination not justified for prototype scale. Monorepo with modular packages provides flexibility to extract services later if needed.
**Trade-offs**: Faster initial development but potential refactor cost if scaling requires extraction.

### Build Tools: Vite vs. Webpack
**Selected**: Vite
**Rationale**: Better DX, faster HMR, native ESM support aligns with modern React practices.
**Trade-offs**: Vite 7 compatibility risks vs. Webpack's mature ecosystem.

### Testing: Jest vs. Vitest
**Selected**: Vitest
**Rationale**: Native ESM support, faster execution, Vite integration, AI-friendly reporting via `vitest-llm-reporter`.
**Trade-offs**: Smaller community than Jest but better DX and performance.

### Auth: Custom JWT vs. Keycloak
**Selected**: Keycloak
**Rationale**: Industry-standard OAuth2/OIDC, reduces security burden, supports federated identity future expansion.
**Trade-offs**: Additional infrastructure complexity vs. custom auth simplicity.

### Content Format: Pure JSON vs. TypeScript DSL
**Selected**: TypeScript DSL compiled to JSON
**Rationale**: Better DX with type safety and IDE support for content authors; validation at compile time.
**Trade-offs**: Requires build step but provides stronger guarantees.

### State Management: Redux vs. Custom
**Selected**: Custom runtime state with React Context for UI
**Rationale**: Game state logic differs from typical UI state management; custom solution avoids Redux boilerplate.
**Trade-offs**: Less ecosystem tooling but tailored to deterministic requirements.

## 10. Testing & Validation Plan

### Unit / Integration
- **Coverage Expectation**: >80% for all new code, >90% for runtime core
- **Frameworks**: Vitest with jsdom for UI, node for backend
- **Test Suites**:
  - Runtime: Tick accumulator, command queue, catch-up, zero-delta, state mutations
  - Content: Schema validation, compiler determinism, formula property tests (fast-check)
  - Social: Auth middleware, route validation, leaderboard ranking logic
  - UI: Component rendering, Worker bridge messaging, state subscriptions

### Performance
- **Benchmarks**: Tick processing time `<16ms` for 60 FPS target
- **Profiling Methodology**: DiagnosticTimeline captures per-system timing; hotspot analysis via profiler
- **Success Thresholds**:
  - Memory: `<100MB` steady-state runtime
  - CPU: `<50%` single core during active gameplay
  - Offline catch-up: 12-hour simulation completes in `<5 seconds`

### Tooling / A11y
- **Playwright Coverage**: Smoke tests for core user flows (load, buy generator, observe progression, leaderboard interaction)
- **Accessibility**: Axe-core integration in CI; no critical violations allowed; WCAG 2.1 AA target
- **Manual QA**: Devtools overlay validation, cross-browser testing (Chrome, Firefox, Safari)

### Validation Cadence
- Unit/integration tests run on every commit via lefthook
- Full test suite + a11y checks run in CI on every PR
- Performance benchmarks run weekly or on-demand for perf-related PRs
- 12-hour soak test runs before each phase gate

## 11. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| React 19 / Vite 7 Worker incompatibility | High - blocks UI integration | Medium | Verify compatibility in Phase 0; fallback to React 18 if issues arise |
| Express 5 beta API instability | Medium - social service disruption | Medium | Monitor stability; pin to specific commit or revert to Express 4 LTS |
| Keycloak local dev reliability | Medium - blocks auth work | Low | Container health checks; realm export for quick recovery; document troubleshooting |
| Offline catch-up performance | High - poor UX on return | Medium | Early instrumentation; cap catch-up iterations; progressive disclosure if slow |
| Tooling drift across packages | Medium - inconsistent quality | High | Shared config packages enforced via CI; automated updates |
| Team capacity / coordination | High - delays delivery | Medium | Clear ownership per workstream; weekly status summaries; escalation path |
| Scope creep into prototype | High - missed milestone | Medium | Explicit approval required for scope changes; feature flags for experimental work |
| Content DSL breaking changes | Medium - invalidates authored content | Low | Versioning strategy; migration tooling; changelog process |
| Security vulnerability in auth flow | High - data breach risk | Low | Security review checklist; external audit before production; rate limiting |

## 12. Rollout Plan

### Milestones
See Section 7.2 for detailed phase milestones. High-level rollout:
1. **Phase 0 (Week 1)**: Foundations - CI, tooling, fixes
2. **Phase 1 (Weeks 1-3)**: Runtime skeleton - core systems, contract freeze
3. **Phase 2 (Weeks 2-4)**: Content DSL - schemas, compiler, sample pack
4. **Phase 3 (Weeks 3-5)**: UI integration - Worker bridge, components, tests
5. **Phase 4 (Weeks 4-6)**: Persistence - offline catch-up, save system
6. **Phase 5 (Weeks 5-7)**: Social - auth, leaderboards, guilds
7. **Phase 6 (Weeks 7-8)**: Hardening - profiling, security, docs, demo

### Migration Strategy
- **Feature Flags**: All WIP features behind flags; enabled per-environment
- **Content Versioning**: DSL version field in metadata; compiler validates compatibility
- **Save Migrations**: Migration hooks in save slot manager; fixture tests verify old saves load
- **API Versioning**: Social service APIs versioned (`/api/v1/`); deprecation notices before breaking changes
- **Database Migrations**: Start with in-memory (Phase 5); plan Postgres migrations with up/down scripts

### Communication
- **Release Announcements**: Weekly progress updates during prototype phase; changelog for each phase completion
- **Partner Updates**: Briefing deck prepared in Phase 6; demo session scheduled post-hardening
- **Runbooks**: Operational runbooks delivered in Phase 6; on-call training materials included

## 13. Open Questions
1. **Content Authoring Workflow**: Should content authors work in separate repo with CI validation, or monorepo packages? (Decision needed by Phase 2 Week 1)
2. **Production Database**: PostgreSQL confirmed for social service, but what about game state persistence - continue with IndexedDB client-side or cloud sync? (Decision deferred to post-prototype)
3. **Hosting Strategy**: Self-hosted Kubernetes, managed PaaS (Render, Railway), or hybrid? (Terraform stubs in Phase 6, but final decision deferred)
4. **Telemetry Backend**: Where do metrics/logs aggregate - self-hosted (Grafana/Loki) or SaaS (Datadog, New Relic)? (Decision needed by Phase 6)
5. **Prestige Mechanics**: Exact reset behavior and carry-over bonuses need content design input (impacts Phase 2 schema design)
6. **Guild Persistence**: In-memory stub sufficient for prototype, but what's the data model for production guilds? (Design needed post-Phase 5)
7. **Versioning Policy**: Semantic versioning for engine packages, but how to handle content pack versions and compatibility matrix? (Decision by Phase 2 Week 2)

## 14. Follow-Up Work
Items explicitly deferred out of prototype scope:
1. **Production Database Migration**: Move from in-memory to Postgres for social service (Owner: Ops Agent, Timing: Post-demo)
2. **Advanced Social Features**: Guild wars, chat, friend lists (Owner: Social Services Agent, Timing: Phase 2 roadmap)
3. **Content Editor UI**: Visual content authoring tool (Owner: UI Agent, Timing: Post-prototype)
4. **Mobile Client**: React Native or PWA optimization (Owner: UI Agent, Timing: Q2 2026)
5. **Multiplayer Events**: Time-limited competitions, seasonal content (Owner: Runtime + Social Agents, Timing: Post-persistence cloud sync decision)
6. **Analytics Dashboard**: Player behavior tracking and visualization (Owner: Tooling Agent, Timing: After telemetry backend selection)
7. **Localization**: i18n framework and initial translations (Owner: UI Agent, Timing: Pre-public launch)
8. **Performance Optimization**: WASM for hot paths, Worker pool scaling (Owner: Runtime Agent, Timing: If profiling reveals bottlenecks)
9. **Security Hardening**: Penetration testing, DDoS protection, rate limiting refinement (Owner: Social Services + Ops Agents, Timing: Pre-production)
10. **Documentation Site**: Full Docusaurus deployment with tutorials, API explorer (Owner: Docs Agent, Timing: Post-prototype milestone)

## 15. References
- [Design Document Template](./design-document-template.md) - Template this plan follows
- [Idle Engine Design Document](TBD) - Core architecture and design decisions
- [Content DSL Specification](TBD) - Detailed content schema reference
- [API Contract Documentation](TBD) - Published in Phase 1 Week 2
- [Conventional Commits](https://www.conventionalcommits.org/) - Commit message standard
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/) - Accessibility standards
- [Keycloak Documentation](https://www.keycloak.org/documentation) - Auth integration reference
- [Vitest Documentation](https://vitest.dev/) - Testing framework guide

## Appendix A — Glossary
- **DSL**: Domain-Specific Language - the content authoring format for defining game resources, generators, upgrades, etc.
- **Tick**: Single iteration of the game loop, typically 16-33ms for 30-60 FPS
- **Catch-up**: Offline progression calculation when player returns after closing the game
- **Prestige**: Game mechanic that resets progress in exchange for permanent bonuses
- **Generator**: Game entity that produces resources over time
- **Upgrade**: Purchasable improvement that modifies generator or resource behavior
- **Guild**: Social feature allowing players to form groups for shared benefits
- **Leaderboard**: Ranked list of player scores or achievements
- **Snapshot**: Serialized copy of runtime state for UI consumption
- **Worker**: Web Worker executing game runtime in background thread
- **Deterministic**: Behavior that produces identical results given identical inputs (critical for replay/validation)
- **Soak Test**: Long-running test simulating extended usage (e.g., 12-hour offline progression)
- **Feature Flag**: Configuration toggle enabling/disabling WIP functionality
- **Hand-off Package**: Context bundle provided to agents when starting work

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-21 | TBD    | Migrated from original format to design document template structure |
| TBD        | TBD    | Original implementation plan created |

---

## Guiding Principles
The following principles guide all execution within this plan:

1. **Prototype-first**: Ship a vertical slice proving the runtime loop, content DSL, and social scaffolding before expanding scope.
2. **Deterministic behaviors over features**: Correctness, profiling hooks, and observability trump new content until the engine core is trusted.
3. **Shared tooling**: Linting, testing, and content validation are centralized so packages stay consistent as the monorepo grows.
4. **Incremental delivery**: Every workstream maintains mergeable branches with behind-feature flags.
5. **Single-responsibility pull requests**: Each task is expected to ship in its own PR so reviews stay focused and staging remains incremental.

## Exit Criteria for Prototype Milestone
The prototype milestone is considered complete when:
1. All Phase 0-6 tasks complete or explicitly deferred with rationale
2. **Demo scenario successful**: New user loads web shell, plays 5 minutes, closes tab, returns after 8 hours with correct offline progression, posts to leaderboard, sees guild placeholder
3. Documentation updated: README, design doc cross-links, developer onboarding guide
4. Retrospective captured with action items feeding Phase 2 (beyond prototype) backlog

**Note**: This plan should be revisited at the end of each phase. Automated agents can surface recommendations, but scope changes require explicit approval to prevent unplanned work from slipping into the prototype milestone.
