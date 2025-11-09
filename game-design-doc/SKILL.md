---
name: game-design-doc
description: Expert skill for creating comprehensive game design documents following the project's established template. This skill should be used when tasked with writing design documents for game mechanics, systems, technical implementations, or when reviewing/improving existing design docs. Specializes in idle/incremental game design, data-driven architecture, and AI-first delivery workflows. Knows when to search for current best practices, frameworks, or competitive analysis.
---

# Game Design Document Expert

## Overview

This skill transforms Claude into an expert game design document author, equipped with deep knowledge of game design theory, idle/incremental game mechanics, technical system design, and the project's standardized documentation template. Use this skill to create, review, or enhance design documents that will guide AI-assisted implementation.

## When to Use This Skill

Invoke this skill when:
- **Creating new design documents** for features, systems, or mechanics
- **Retrofitting existing notes** into the standard template format
- **Reviewing design documents** for completeness, rigor, or alignment with best practices
- **Planning game systems** requiring balance analysis, progression design, or economic modeling
- **Documenting technical implementations** for game engines, content pipelines, or runtime systems

## Workflow: Creating a Design Document

Follow this sequential process when authoring design documents.

### Step 1: Understand Requirements & Context

Begin by gathering complete context before writing.

#### Questions to Resolve
1. **Scope**: What problem is being solved? Is this a new feature, refactor, or bug fix?
2. **Stakeholders**: Who will implement this? AI agents, human developers, or hybrid?
3. **Constraints**: Performance targets, timeline, backward compatibility requirements?
4. **Impact**: Which packages, services, or content modules are affected?

#### Context Gathering Actions
- **Search codebase** for related implementations, existing patterns, prior art
- **Read related design docs** using Grep to find documents in `docs/` matching keywords
- **Review project conventions** (commit styles, naming patterns, testing requirements)
- **Identify dependencies** (libraries, APIs, external services requiring research)

**When to search for updated information**:
- Referencing specific libraries/frameworks (check latest versions, APIs)
- Citing best practices (search "idle game [topic] 2024" for current patterns)
- Platform requirements (browser APIs, accessibility standards, store policies)
- Competitive analysis (recent successful implementations in similar games)

Load `references/game-design-principles.md` into context when designing game mechanics, progression systems, or economic balance. This reference contains idle game design fundamentals, MDA framework, flow theory, and balance formulas.

### Step 2: Use the Template

Every design document must follow the standard template located at `assets/design-document-template.md`.

#### Template Structure
The template includes 15 required sections plus appendices:
1. **Document Control**: Metadata (title, authors, status, execution mode)
2. **Summary**: One-paragraph executive overview
3. **Context & Problem Statement**: Background, problem, constraints
4. **Goals & Non-Goals**: Measurable outcomes and explicit exclusions
5. **Stakeholders, Agents & Impacted Surfaces**: Who implements, what's affected
6. **Current State**: Existing architecture and code references
7. **Proposed Solution**: Architecture, detailed design, operational considerations
8. **Work Breakdown & Delivery Plan**: Issue map, milestones, coordination
9. **Agent Guidance & Guardrails**: Context packets, constraints, validation hooks
10. **Alternatives Considered**: Competing approaches and trade-offs
11. **Testing & Validation Plan**: Unit, integration, performance, accessibility
12. **Risks & Mitigations**: Technical, operational, organizational concerns
13. **Rollout Plan**: Phased deployment, migrations, communication
14. **Open Questions**: Unresolved decisions requiring input
15. **Follow-Up Work**: Deferred scope, technical debt
16. **References**: Prior docs, code paths, external research
17. **Appendices**: Glossary, change log

#### Template Usage Instructions
1. **Read the template** at `assets/design-document-template.md` to understand structure
2. **Fill every section** or state explicitly why a section is not applicable
3. **Replace bracketed guidance** with project-specific detail
4. **Optimize for AI consumption** by including file paths, schemas, validation scripts
5. **Maintain searchability** by using consistent terminology and explicit references

### Step 3: Apply Game Design Expertise

Leverage game design knowledge to strengthen the document.

#### For Game Mechanics & Systems
- **Define core loop** interactions (how does this affect resource → upgrade → production cycle?)
- **Analyze progression** impact (does this create a wall, accelerate pacing, or enable new strategies?)
- **Evaluate balance** using formulas (exponential cost curves, multiplicative bonuses, prestige value)
- **Consider idle implications** (offline progress calculations, automation interactions)
- **Assess player psychology** (MDA aesthetics, flow state, Bartle type appeal)

**Use references/game-design-principles.md for**:
- Cost curve formulas (linear, exponential, polynomial, hybrid)
- Progression metrics (time to milestone, prestige value calculations)
- Common pitfalls (linear scaling, prestige timing, decision paralysis)
- Balance checklist (offline progression, late-game scaling, automation)

#### For Technical Implementations
- **Document performance characteristics** (Big-O complexity, memory bounds, tick budget)
- **Guarantee determinism** (fixed timesteps, reproducible results, no unbounded randomness)
- **Plan schema migrations** (versioned saves, forward compatibility, rollback safety)
- **Specify telemetry** (metrics for A/B testing, analytics hooks, diagnostics)

**Search for current information when**:
- Referencing browser APIs or platform features (check MDN, caniuse.com)
- Citing performance benchmarks (verify with recent profiling data)
- Recommending libraries (confirm version compatibility, maintenance status)

### Step 4: Structure for AI-First Delivery

Optimize the document for AI agent execution.

#### Section 7: Work Breakdown & Delivery Plan
Decompose work into discrete, automatable issues:

```markdown
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): add resource multiplier system | Implement multiplier calculation in ResourceManager | Runtime Implementation Agent | Schema approval | Unit tests pass; multipliers apply correctly; docs updated |
| test(core): property-based multiplier tests | Generate random multiplier sequences; verify invariants | Testing Agent | Implementation complete | 1000 test cases pass; edge cases documented |
```

**Characteristics of good issue decomposition**:
- **Atomic scope**: Each issue is independently testable
- **Clear acceptance**: Criteria are measurable and automatable
- **Explicit dependencies**: Blocking relationships visible upfront
- **Agent-appropriate**: Tasks match agent capabilities (avoid ambiguity)

#### Section 8: Agent Guidance & Guardrails
Provide explicit instructions and safety rails for AI agents:

**Context Packets**: List files, schemas, environment variables agents must read
```markdown
- Load `packages/core/src/resource-manager.ts` for existing implementation
- Reference `docs/content-dsl-schema-design.md` for schema conventions
- Use `.env.example` for required environment variables
```

**Prompting & Constraints**: Canonical instructions, commit styles, naming patterns
```markdown
- Use imperative commit messages: "feat(scope): add feature" not "Added feature"
- Follow existing naming: `calculateDerivedStats()` not `getDerivedStats()`
- Maintain 100% test coverage for new public APIs
```

**Safety Rails**: Forbidden actions, data privacy, rollback procedures
```markdown
- NEVER reset git history or force push to main
- DO NOT commit `.env` files or credentials
- ALWAYS run `npm run validate` before marking tasks complete
```

**Validation Hooks**: Scripts agents must execute
```markdown
- Run `npm test` and verify zero failures
- Execute `npm run build` and confirm no type errors
- Run `npm run lint:fix` and commit formatting changes
```

### Step 5: Validate Completeness

Before finalizing, verify the document meets quality standards.

#### Completeness Checklist
- [ ] **Problem clearly stated** with quantitative evidence or user feedback
- [ ] **Proposed solution** addresses root cause, not just symptoms
- [ ] **Alternatives documented** with explicit trade-off analysis
- [ ] **Testing plan** includes unit, integration, and domain-specific validation
- [ ] **Migration strategy** for existing saves/content (if applicable)
- [ ] **Work breakdown** into discrete, testable issues
- [ ] **Agent guardrails** specified with validation scripts
- [ ] **All sections** filled or marked "Not Applicable" with justification

#### Game Design Specifics
- [ ] **Offline progression** impact documented
- [ ] **Balance verified** via simulation (not just theoretical formulas)
- [ ] **Prestige/reset** interactions considered
- [ ] **Automation** implications addressed (how does this change idle vs active play?)
- [ ] **Late-game scaling** verified (numbers tested up to 1e100+)

#### Technical Rigor
- [ ] **Performance characteristics** documented (Big-O, memory usage, tick budget)
- [ ] **Determinism guaranteed** (reproducible results, no uncontrolled randomness)
- [ ] **Schema migrations** planned for data model changes
- [ ] **Telemetry hooks** identified for monitoring and experimentation

### Step 6: Format & Reference Standards

Ensure the document follows project conventions.

#### File References
Use explicit file paths with line numbers when referencing code:
```markdown
The multiplier system is implemented in `packages/core/src/resource-manager.ts:142-186`.
```

#### Cross-Document Links
Reference related design docs using relative paths:
```markdown
See [Content DSL Schema Design](./content-dsl-schema-design.md) for schema conventions.
```

#### Code Samples
Use fenced code blocks with language hints:
````markdown
```typescript
interface ResourceMultiplier {
  id: string;
  multiplier: number;
  source: 'upgrade' | 'prestige' | 'event';
}
```
````

#### Diagrams
Embed ASCII diagrams for simple flows; link to external tools (Mermaid, Excalidraw) for complex architectures:
```
Resource Generation Flow:
  BaseRate → [Multipliers] → [Automation] → NetGeneration
     ↓            ↓              ↓              ↓
  Config      Upgrades      Generators      Player
```

## Common Scenarios

### Creating a New Game Mechanic Document
1. Invoke this skill
2. Read `assets/design-document-template.md` for structure
3. Load `references/game-design-principles.md` for design theory
4. Search codebase for related implementations (Grep for keywords)
5. Search web for current best practices if needed ("idle game [mechanic] design 2024")
6. Fill template sections sequentially (Summary → Problem → Solution → Breakdown)
7. Validate completeness using checklists above
8. Write the document to `docs/[feature-name]-design.md`

### Retrofitting Existing Notes
1. Invoke this skill
2. Read the existing notes/document
3. Read `assets/design-document-template.md`
4. Map existing content to template sections (identify gaps)
5. Fill missing sections by analyzing codebase and context
6. Restructure narrative to follow template headings
7. Add work breakdown and agent guidance sections (critical for AI-first)
8. Update change log with migration note

### Reviewing a Design Document
1. Invoke this skill
2. Read the document under review
3. Check completeness against validation checklists
4. Verify game design principles (load `references/game-design-principles.md` if needed)
5. Assess technical rigor (performance, determinism, migrations)
6. Evaluate work breakdown (are issues atomic, testable, agent-appropriate?)
7. Suggest improvements with specific references to template sections

## When to Search for Updated Information

### Always Search For
- **Library/framework versions**: "TypeScript 5.x new features", "React 18 best practices"
- **Platform requirements**: "WCAG 2.2 changes", "Chrome 120 new APIs"
- **Current best practices**: "idle game prestige design 2024", "incremental game economy balance"
- **Competitive analysis**: "recent successful idle games", "popular progression mechanics 2024"

### Never Search For (Use References Instead)
- **Fundamental game design theory**: MDA, Flow, Bartle types (timeless concepts)
- **Math and algorithms**: Big-O notation, exponential growth, statistics
- **Project-specific context**: Use codebase, existing docs, established patterns

### Red Flags Requiring Research
- Citing benchmarks older than 2 years
- Referencing deprecated APIs or sunset features
- Recommending libraries without version compatibility check
- Using "common" formulas without source attribution

## Key Principles

### Design Document Philosophy
- **AI-first optimization**: Documents are onboarding guides for AI agents, not just human readers
- **Executable specificity**: Acceptance criteria must be measurable and automatable
- **Context completeness**: Agents have no implicit knowledge; provide all context explicitly
- **Safety by default**: Guardrails prevent destructive actions; validation hooks ensure quality

### Game Design Philosophy
- **Data-driven design**: Separate engine logic from game content for rapid iteration
- **Deterministic simulation**: Reproducible results are non-negotiable for fairness
- **Player-centric balance**: Design for emotional response (satisfaction, discovery) not just math
- **Depth over breadth**: Systems should reward mastery and optimization discovery

### Writing Style
- **Imperative and concise**: "Implement X" not "You should implement X"
- **Quantitative evidence**: Cite metrics, profiling data, user feedback
- **Explicit trade-offs**: Never present solutions as obvious; acknowledge costs
- **Progressive disclosure**: Summary → Detail → Appendix (skim-friendly structure)

## Resources

### assets/
**design-document-template.md**: The canonical template for all design documents in this project. Copy this template when creating new design docs. Contains 15 required sections optimized for AI-first delivery.

### references/
**game-design-principles.md**: Comprehensive game design knowledge covering:
- Idle/incremental game design (core loops, progression, prestige systems)
- General game design theory (MDA, Flow, Bartle types, Koster's fun theory)
- System design best practices (data-driven, deterministic, performance)
- Balance and progression (cost curves, economic modeling, scaling)
- When to search for updated information (red flags, search-worthy topics)

Load this reference when designing game mechanics, analyzing balance, or evaluating player experience.

---

**Note**: This skill emphasizes the unique aspects of this project's design documentation: AI-first delivery workflows, agent guidance sections, and idle game domain expertise. When in doubt, prioritize completeness, specificity, and actionability—documents should enable autonomous execution with minimal human clarification.
