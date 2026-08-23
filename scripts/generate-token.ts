#!/usr/bin/env tsx
// Prints one new candidate bearer token for KNOTRACK_API_TOKENS
// (docs/TRD.md §4). Never written anywhere — stdout only.
import crypto from 'node:crypto';

function generateToken(): string {
  // 256 bits (32 bytes) of entropy per docs/PRD.md, encoded as 43 URL-safe
  // base64 characters, prefixed "kt_" — convention only, not enforced by
  // the auth check itself (TRD §4).
  const raw = crypto.randomBytes(32).toString('base64url'); // 32 bytes -> 43 base64url chars
  return `kt_${raw}`;
}

console.log(generateToken());
