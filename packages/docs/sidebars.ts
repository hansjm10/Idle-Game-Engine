import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  developerSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: ['index', 'contributor-handbook', 'role-index', 'design-document-template'],
    },
    {
      type: 'category',
      label: 'Core Runtime',
      items: [
        'idle-engine-design',
        'runtime-step-lifecycle',
        'runtime-command-queue-design',
        'controls-contract-design-issue-705',
        'desktop-shell-webgpu-renderer-replay-design-issue-778',
        'runtime-event-pubsub-design',
        'runtime-event-bus-decisions',
        'runtime-event-manifest-authoring',
        'tick-accumulator-coverage-design',
        'resource-state-storage-design',
        'diagnostic-timeline-design',
      ],
    },
    {
      type: 'category',
      label: 'Content Pipeline',
      items: [
        'content-dsl-schema-design',
        'content-dsl-usage-guidelines',
        'content-schema-reference',
        'content-compiler-design',
        'content-schema-rollout-decisions',
        'content-validation-cli-design',
      ],
    },
    {
      type: 'category',
      label: 'Diagnostics & Quality',
      items: ['coverage/index', 'performance/index'],
    },
    {
      type: 'category',
      label: 'Operations & Process',
      items: ['implementation-plan', 'project-board-workflow'],
    },
  ],
};

export default sidebars;
