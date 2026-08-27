import { describe, expect, it } from 'vitest';
import { isQueryCanceled, QUERY_CANCELED_SQLSTATE } from '../../src/mcp/tools/render-roadmap.js';

// kt_render_roadmap's statement_timeout-based degradation (see
// render-roadmap.ts's top-of-file comment, adversarial-review P1) relies
// on correctly classifying a Postgres "query_canceled" error so it can be
// treated as a truncation signal rather than propagated as a 500. The
// timeout behavior itself is timing-dependent and reasoned about rather
// than integration-tested, but this classifier is pure and deterministic.
describe('isQueryCanceled', () => {
  it('recognizes a Postgres DatabaseError-shaped object with the query_canceled SQLSTATE', () => {
    expect(isQueryCanceled({ code: QUERY_CANCELED_SQLSTATE, message: 'canceling statement' })).toBe(
      true,
    );
  });

  it('rejects an unrelated Postgres error code', () => {
    expect(isQueryCanceled({ code: '23505', message: 'unique_violation' })).toBe(false);
  });

  it('rejects a plain Error with no .code', () => {
    expect(isQueryCanceled(new Error('boom'))).toBe(false);
  });

  it('rejects non-object values without throwing', () => {
    expect(isQueryCanceled(null)).toBe(false);
    expect(isQueryCanceled(undefined)).toBe(false);
    expect(isQueryCanceled('57014')).toBe(false);
  });
});
