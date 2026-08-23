// Bearer-token preHandler hook — docs/TRD.md §4. Registered on POST /mcp
// only; never on GET /health or GET /info.
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KtErrorEnvelope } from '../mcp/errors.js';

function sha256(input: string): Buffer {
  return crypto.createHash('sha256').update(input, 'utf8').digest();
}

/** Constant-time membership check across the whole token pool — every
 * configured token is compared (not short-circuited) so unauthorized
 * request timing doesn't leak "which token almost matched". */
export function isAuthorizedToken(presented: string, configured: string[]): boolean {
  const presentedHash = sha256(presented);
  let authorized = false;
  for (const token of configured) {
    const tokenHash = sha256(token);
    if (crypto.timingSafeEqual(presentedHash, tokenHash)) {
      authorized = true;
    }
  }
  return authorized;
}

const UNAUTHORIZED_ENVELOPE: KtErrorEnvelope = {
  error: {
    code: 'UNAUTHORIZED',
    http_status_equivalent: 401,
    message: 'missing or invalid bearer token',
  },
};

export function createAuthPreHandler(apiTokens: string[]) {
  return function authPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ): void {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      reply.code(401).send(UNAUTHORIZED_ENVELOPE);
      return;
    }
    // Exactly "Bearer <token>" — a single space, case-sensitive scheme.
    const spaceIndex = header.indexOf(' ');
    const scheme = header.slice(0, spaceIndex);
    const token = header.slice(spaceIndex + 1);
    if (scheme !== 'Bearer' || token.length === 0 || token.includes(' ')) {
      reply.code(401).send(UNAUTHORIZED_ENVELOPE);
      return;
    }
    if (!isAuthorizedToken(token, apiTokens)) {
      reply.code(401).send(UNAUTHORIZED_ENVELOPE);
      return;
    }
    done();
  };
}
