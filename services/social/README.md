# @idle-engine/social-service

Reference social backend providing placeholder endpoints for leaderboards and guilds. Authentication is enforced via Keycloak-issued OIDC tokens. Responses are stubbed until a persistence layer is implemented.

## Environment Variables
- `PORT` (default `4000`)
- `KEYCLOAK_ISSUER` – base issuer URL for the Keycloak realm
- `KEYCLOAK_AUDIENCE` – expected audience/client id for tokens

## Getting Started
```
pnpm install
pnpm --filter @idle-engine/social-service dev
```
