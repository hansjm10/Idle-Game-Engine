Runtime Bridge Contracts

Canonical TypeScript schemas for the runtime↔React worker bridge.

Usage
- Install via workspace dependency and import from the package:
  - import { WORKER_MESSAGE_SCHEMA_VERSION, type RuntimeWorkerInboundMessage, type RuntimeWorkerOutboundMessage } from '@idle-engine/runtime-bridge-contracts';

Versioning
- Bump WORKER_MESSAGE_SCHEMA_VERSION when changing envelope shapes.
- Update downstream imports and refresh tests that assert the version to avoid silent drift.

Validating changes
- Run pnpm test --filter @idle-engine/runtime-bridge-contracts to verify the schema version guard test.
- Run pnpm test --filter @idle-engine/shell-web to ensure the worker and bridge compile against the schema.

