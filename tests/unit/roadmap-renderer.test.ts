import { describe, expect, it } from 'vitest';
import {
  renderMarkdownRoadmap,
  renderMermaidRoadmap,
  buildTruncationNotice,
  appendTruncationNotice,
} from '../../src/domain/roadmap-renderer.js';

describe('renderMarkdownRoadmap', () => {
  it('matches TRD §3.13 example exactly for a single track', () => {
    const generatedAt = new Date('2026-08-23T14:30:00.000Z');
    const tracks = [{ id: 't1', title: 'Auth overhaul', status: 'on_track' }];
    const itemsByTrackId = new Map([
      [
        't1',
        [
          { title: 'Add refresh endpoint', status: 'done' },
          { title: 'Add rotation tests', status: 'pending' },
        ],
      ],
    ]);

    const result = renderMarkdownRoadmap('KnoTrack Demo', generatedAt, tracks, itemsByTrackId);

    expect(result).toBe(
      '# Roadmap: KnoTrack Demo\n' +
        '_Generated 2026-08-23T14:30:00.000Z_\n' +
        '\n' +
        '## Auth overhaul — on_track\n' +
        '- [x] Add refresh endpoint\n' +
        '- [ ] Add rotation tests\n',
    );
  });

  it('renders multiple tracks separated by a blank line, in the given (already topological) order', () => {
    const generatedAt = new Date('2026-08-23T14:30:00.000Z');
    const tracks = [
      { id: 't1', title: 'Auth overhaul', status: 'on_track' },
      { id: 't2', title: 'Billing sync', status: 'blocked' },
    ];
    const itemsByTrackId = new Map([
      ['t1', [{ title: 'Add refresh endpoint', status: 'done' }]],
      ['t2', [{ title: 'Define webhook contract', status: 'pending' }]],
    ]);

    const result = renderMarkdownRoadmap('KnoTrack Demo', generatedAt, tracks, itemsByTrackId);

    expect(result).toBe(
      '# Roadmap: KnoTrack Demo\n' +
        '_Generated 2026-08-23T14:30:00.000Z_\n' +
        '\n' +
        '## Auth overhaul — on_track\n' +
        '- [x] Add refresh endpoint\n' +
        '\n' +
        '## Billing sync — blocked\n' +
        '- [ ] Define webhook contract\n',
    );
  });

  it('renders all four checkbox variants', () => {
    const tracks = [{ id: 't1', title: 'T', status: 'on_track' }];
    const itemsByTrackId = new Map([
      [
        't1',
        [
          { title: 'done item', status: 'done' },
          { title: 'pending item', status: 'pending' },
          { title: 'in-progress item', status: 'in_progress' },
          { title: 'blocked item', status: 'blocked' },
        ],
      ],
    ]);

    const result = renderMarkdownRoadmap(
      'P',
      new Date('2026-01-01T00:00:00.000Z'),
      tracks,
      itemsByTrackId,
    );

    expect(result).toContain('- [x] done item');
    expect(result).toContain('- [ ] pending item');
    expect(result).toContain('- [~] in-progress item');
    expect(result).toContain('- [!] blocked item');
  });

  it('renders a track with zero items as a heading with no checklist lines', () => {
    const tracks = [{ id: 't1', title: 'Empty track', status: 'on_track' }];
    const result = renderMarkdownRoadmap(
      'P',
      new Date('2026-01-01T00:00:00.000Z'),
      tracks,
      new Map(),
    );
    expect(result).toBe(
      '# Roadmap: P\n_Generated 2026-01-01T00:00:00.000Z_\n\n## Empty track — on_track\n',
    );
  });
});

describe('renderMermaidRoadmap', () => {
  it('matches TRD §3.13 example: node ids, labels, and edge direction', () => {
    const tracks = [
      { id: '8b2e1a10-0000-0000-0000-000000000000', title: 'Auth overhaul', status: 'on_track' },
      { id: '9c3d4e5f-0000-0000-0000-000000000000', title: 'Billing sync', status: 'blocked' },
    ];
    // Billing sync depends on Auth overhaul.
    const edges = [
      {
        from: '9c3d4e5f-0000-0000-0000-000000000000',
        to: '8b2e1a10-0000-0000-0000-000000000000',
      },
    ];

    const result = renderMermaidRoadmap(tracks, edges);

    expect(result).toBe(
      'graph TD\n' +
        '  t_8b2e1a10["Auth overhaul (on_track)"]\n' +
        '  t_9c3d4e5f["Billing sync (blocked)"]\n' +
        '  t_9c3d4e5f --> t_8b2e1a10\n',
    );
  });

  it('replaces double quotes with single quotes and strips newlines in labels', () => {
    const tracks = [
      {
        id: '11111111-0000-0000-0000-000000000000',
        title: 'Say "hi"\nnewline',
        status: 'on_track',
      },
    ];

    const result = renderMermaidRoadmap(tracks, []);

    expect(result).toBe('graph TD\n  t_11111111["Say \'hi\'newline (on_track)"]\n');
    expect(result).not.toContain('"hi"');
  });

  it('declares all nodes before any edge', () => {
    const tracks = [
      { id: '11111111-0000-0000-0000-000000000000', title: 'A', status: 'on_track' },
      { id: '22222222-0000-0000-0000-000000000000', title: 'B', status: 'on_track' },
    ];
    const edges = [
      {
        from: '22222222-0000-0000-0000-000000000000',
        to: '11111111-0000-0000-0000-000000000000',
      },
    ];

    const lines = renderMermaidRoadmap(tracks, edges).split('\n');

    expect(lines[0]).toBe('graph TD');
    expect(lines[1]).toContain('t_11111111[');
    expect(lines[2]).toContain('t_22222222[');
    expect(lines[3]).toContain('-->');
  });

  it('renders with no edges when the project has no track dependencies', () => {
    const tracks = [{ id: '11111111-0000-0000-0000-000000000000', title: 'A', status: 'on_track' }];
    expect(renderMermaidRoadmap(tracks, [])).toBe('graph TD\n  t_11111111["A (on_track)"]\n');
  });
});

describe('buildTruncationNotice', () => {
  it("matches TRD §6.3's example text exactly when both clauses apply (format prefix is appendTruncationNotice's job)", () => {
    const notice = buildTruncationNotice([
      'showing 200 of 341 tracks',
      'some tracks omit items beyond the first 100',
    ]);
    expect(notice).toBe(
      'Roadmap truncated: showing 200 of 341 tracks. Some tracks omit items beyond the first 100.',
    );
  });

  it('renders a single clause without a spurious second sentence', () => {
    expect(buildTruncationNotice(['showing 5 of 10 tracks'])).toBe(
      'Roadmap truncated: showing 5 of 10 tracks.',
    );
  });
});

describe('appendTruncationNotice', () => {
  it('appends a markdown blockquote notice as trailing lines, preserving the original content', () => {
    const content = '# Roadmap: P\n_Generated x_\n\n## T — on_track\n- [ ] item\n';
    const notice = 'Roadmap truncated: showing 1 of 2 tracks.';

    const result = appendTruncationNotice(content, notice, 'markdown');

    expect(result.startsWith(content)).toBe(true);
    expect(result.endsWith(`> ${notice}\n`)).toBe(true);
  });

  it('appends a mermaid %% comment notice, not a markdown blockquote, so the diagram stays parseable', () => {
    const content = 'graph TD\n  t_1["A (on_track)"]\n';
    const notice = 'Roadmap truncated: showing 1 of 2 tracks.';

    const result = appendTruncationNotice(content, notice, 'mermaid');

    expect(result.startsWith(content)).toBe(true);
    expect(result.endsWith(`%% ${notice}\n`)).toBe(true);
    expect(result).not.toContain('> Roadmap truncated');
  });
});
