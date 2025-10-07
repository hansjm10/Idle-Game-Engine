import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8080/realms/idle';
const AUDIENCE = process.env.KEYCLOAK_AUDIENCE ?? 'idle-engine-social';
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`));

export function createAuthMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') {
      return next();
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const token = authHeader.slice('Bearer '.length);
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: ISSUER,
        audience: AUDIENCE
      });
      req.user = {
        id: String(payload.sub ?? 'anonymous'),
        preferredUsername: String(payload.preferred_username ?? 'anonymous')
      };
      return next();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Token verification failed', error);
      return res.status(401).json({ error: 'unauthorized' });
    }
  };
}
