# Game Design Principles Reference

This reference provides foundational game design knowledge to inform design document creation. Use these principles when analyzing requirements, proposing solutions, and evaluating design trade-offs.

## Idle & Incremental Game Design

### Core Loop Fundamentals
- **Primary Loop**: Resource accumulation → Upgrades → Faster accumulation
- **Retention Mechanics**: Offline progress, prestige systems, achievement hunting
- **Progression Pacing**: Early exponential growth, mid-game wall, prestige breakthrough
- **Automation Philosophy**: Manual → Semi-automated → Fully automated progression

### Key Design Principles
1. **Numbers Go Up**: Clear, satisfying numerical feedback (visible growth)
2. **Meaningful Decisions**: Upgrades should present trade-offs, not always-optimal choices
3. **Compounding Systems**: Multiplicative effects create satisfying late-game scaling
4. **Respec Friction**: Balance between experimentation and commitment
5. **Prestige Design**: Reset cost must be justified by permanent meta-progression gains

### Common Pitfalls
- **Wall of Text**: Too many simultaneous upgrade options creates decision paralysis
- **Linear Scaling**: Additive bonuses become irrelevant; use multiplicative or exponential
- **Idle Fallacy**: "Idle" doesn't mean no interaction; design active engagement moments
- **Prestige Too Early/Late**: First prestige around 30-60 minutes; subsequent ones follow rhythm
- **Opaque Formulas**: Players should understand why numbers change

## General Game Design Theory

### MDA Framework (Mechanics, Dynamics, Aesthetics)
- **Mechanics**: Rules and systems (resource generation, upgrade costs)
- **Dynamics**: Runtime behavior from mechanics interaction (economic balance, pacing)
- **Aesthetics**: Emotional response (satisfaction, discovery, mastery)

Apply when: Analyzing how a proposed mechanic creates desired player experience.

### Flow Theory (Csikszentmihalyi)
- **Flow State**: Challenge matches skill; clear goals; immediate feedback
- **Application**: Difficulty curves, tutorial pacing, skill ceiling design
- **Anti-Flow**: Anxiety (too hard), boredom (too easy), apathy (unclear goals)

Apply when: Evaluating progression difficulty, onboarding flows, endgame content.

### Bartle's Player Types (adapted for idle games)
- **Achievers**: Completionists (achievements, milestones, 100% goals)
- **Explorers**: Discovery-oriented (hidden mechanics, easter eggs, experimentation)
- **Socializers**: Community-focused (cooperative play, sharing strategies)
- **Killers**: Competition-driven (time trials, speed-run challenges)

Apply when: Designing retention features and achievement structures.

### Koster's Theory of Fun
- **Fun is Learning**: Patterns, mastery, optimization discovery
- **Boredom is Failure**: When systems become fully understood with no depth left
- **Meta-game Depth**: Optimal strategy discovery, theorycrafting, spreadsheet gaming

Apply when: Evaluating whether systems have sufficient depth, replayability.

## System Design Best Practices

### Data-Driven Design
- **Separation of Concerns**: Engine logic vs. game content
- **Tuning Without Deploys**: Content updates via configuration
- **Validation Early**: Schema enforcement prevents runtime errors
- **Versioned Content**: Migrations for save compatibility

### Deterministic Simulation
- **Fixed Timesteps**: Predictable offline progression calculations
- **Reproducible Results**: Same inputs → same outputs (critical for fairness)
- **Bounded Computation**: Cap catch-up calculations to prevent hangs
- **Floating Point Caution**: Use integer math or fixed-point for currency/resources

### Performance Considerations
- **Big-O Awareness**: O(n²) loops acceptable for n < 100, unacceptable for n > 1000
- **Lazy Evaluation**: Don't recalculate unchanged derived stats every tick
- **Memory Bounds**: Unbounded arrays are bugs; cap event logs, history buffers
- **Web Worker Isolation**: Keep heavy computation off main thread

### Testing Philosophy
- **Property-Based Testing**: Generate random sequences; verify invariants hold
- **Simulation Testing**: Run 10,000 ticks; check balance, no crashes
- **Migration Testing**: Old save → new version → verify state integrity
- **Accessibility Testing**: Keyboard nav, screen readers, colorblind modes

## Balance & Progression

### Cost Curves
- **Linear**: Cost = base × level (shallow, quick to cap)
- **Exponential**: Cost = base × (multiplier ^ level) (standard for idle games)
- **Polynomial**: Cost = base × (level ^ exponent) (middle ground)
- **Hybrid**: Different curves per tier (early linear, late exponential)

### Progression Metrics
- **Time to Next Milestone**: Should decrease logarithmically (feels faster despite exponential costs)
- **Prestige Value**: Meta-currency gain should justify time investment (2x production minimum)
- **Upgrade Unlocks**: Stagger unlocks to avoid overwhelming players (1-3 new options per milestone)

### Economic Balance
- **Sinks & Faucets**: Resources must have both generation and consumption
- **Inflation Control**: Prestige resets prevent runaway exponential growth
- **Opportunity Cost**: Multiple viable paths; suboptimal choices should be ~80% as efficient
- **Late-Game Scaling**: Plan for 1e308 numbers (JavaScript MAX_SAFE_INTEGER is 2^53)

## When to Search for Updated Information

### Search-Worthy Topics
1. **Current Best Practices**: "idle game progression design 2024", "incremental game balance patterns"
2. **Library/Framework Updates**: When referencing specific tools (React, Vitest, TypeScript)
3. **Platform Requirements**: Web standards, browser API changes, store policies
4. **Accessibility Standards**: WCAG updates, ARIA pattern changes
5. **Competitive Analysis**: Recent successful idle games, emerging mechanics

### Red Flags Requiring Research
- **Citing Years-Old Benchmarks**: Performance claims older than 2 years
- **Deprecated APIs**: Browser features with known sunset dates
- **Unverified Formulas**: "Common" balance formulas without source attribution
- **Tool Version Conflicts**: Recommending libraries without checking compatibility

### When NOT to Search
- **Fundamental Principles**: MDA, Flow, Bartle types are timeless
- **Math & Algorithms**: Big-O, exponential growth, statistical methods
- **Project-Specific Context**: Use existing docs, codebase patterns, established conventions
- **Time-Sensitive Drafts**: During rapid iteration; flag for later verification

## Design Document Checklist

Before finalizing a design doc, verify:

### Completeness
- [ ] Problem clearly stated with quantitative evidence
- [ ] Proposed solution addresses root cause, not symptoms
- [ ] Alternatives considered with explicit trade-off analysis
- [ ] Testing plan includes unit, integration, and balance verification
- [ ] Migration strategy for existing saves (if applicable)

### Idle Game Specifics
- [ ] Offline progression impact documented
- [ ] Balance tested via simulation (not just theory)
- [ ] Prestige/reset interactions considered
- [ ] Automation implications addressed
- [ ] Late-game scaling verified (1e100+ numbers)

### Technical Rigor
- [ ] Performance characteristics documented (Big-O, memory usage)
- [ ] Determinism guaranteed (no random seeds, clock dependencies without controls)
- [ ] Schema migrations planned for content changes
- [ ] Telemetry hooks identified for A/B testing

### AI-First Delivery
- [ ] Work breakdown into discrete, testable issues
- [ ] Agent guardrails specified (forbidden actions, validation scripts)
- [ ] Context packets identified (files, schemas, credentials agents need)
- [ ] Acceptance criteria measurable and automatable

## Glossary of Common Terms

- **DPS**: Damage Per Second (resource generation rate in idle games)
- **Prestige**: Voluntary reset for permanent meta-progression bonuses
- **Soft Cap**: Exponential cost scaling that slows but doesn't stop progression
- **Hard Cap**: Maximum value enforced by game rules
- **Meta-Currency**: Persistent resources retained through prestige resets
- **Tick**: Discrete simulation step (typically 100ms for idle games)
- **Delta**: Change in value per unit time (Δ resources/tick)
- **Offline Progression**: Resource accumulation while game is closed
- **Active Play**: Mechanics requiring player interaction (clicking, timing)
- **Wall**: Point where progression slows significantly; triggers prestige decision

## References & Further Reading

- *Game Design Workshop* by Tracy Fullerton (methodology, playtesting)
- *The Art of Game Design* by Jesse Schell (lenses, holistic thinking)
- *Designing Games* by Tynan Sylvester (systems thinking, emergence)
- *A Theory of Fun* by Raph Koster (learning, boredom, fun)
- Gamasutra/Game Developer postmortems (real-world case studies)
- r/incremental_games wiki (community knowledge, formula repositories)
