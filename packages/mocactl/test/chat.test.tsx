import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BLOCKS, addUser, reduceFrame } from '../src/render/blocks.js';
import { Chat } from '../src/views/Chat.js';
import { withTheme } from './helpers/ink.js';

describe('Chat', () => {
  it('renders settled history, the live block, the input and the status line', () => {
    let s = addUser(EMPTY_BLOCKS, 'hello');
    s = reduceFrame(s, { type: 'text', delta: 'streaming now' });
    // <Static> output is written separately from the live frame, so read every frame written.
    const { frames } = render(
      withTheme(
        <Chat
          blocks={s}
          details={false}
          thinking
          width={80}
          rows={40}
          staticKey={0}
          statusFields={[{ key: 'turn', text: 'streaming 1.0s' }]}
          inputActive
          history={[]}
          onSubmit={vi.fn()}
          onHelp={vi.fn()}
        />,
      ),
    );
    const f = frames.join('\n');
    expect(f).toContain('› hello');
    expect(f).toContain('streaming now');
    expect(f).toContain('type a message');
    expect(f).toContain('streaming 1.0s');
  });

  it('renders an overlay between the transcript and the input', () => {
    const { lastFrame } = render(
      withTheme(
        <Chat
          blocks={EMPTY_BLOCKS}
          details={false}
          thinking
          width={80}
          rows={40}
          staticKey={0}
          statusFields={[]}
          inputActive={false}
          history={[]}
          onSubmit={vi.fn()}
          onHelp={vi.fn()}
          overlay={<Text>OVERLAY</Text>}
        />,
      ),
    );
    expect(lastFrame()).toContain('OVERLAY');
  });

  it('prints the banner above the settled history, so it scrolls away with it', () => {
    const { frames } = render(
      withTheme(
        <Chat
          blocks={addUser(EMPTY_BLOCKS, 'hello')}
          details={false}
          thinking
          width={80}
          rows={40}
          staticKey={0}
          statusFields={[]}
          inputActive
          history={[]}
          onSubmit={vi.fn()}
          onHelp={vi.fn()}
          banner={{
            mocactlVersion: '0.5.2',
            cpVersion: '0.5.1',
            harnessVersion: '0.5.0',
            cwd: '~/w',
          }}
        />,
      ),
    );
    const f = frames.join('\n');
    expect(f).toContain('control plane 0.5.1');
    // The banner is the first thing <Static> prints, ahead of any settled block.
    expect(f.indexOf('› hello')).toBeGreaterThan(f.indexOf('control plane 0.5.1'));
  });

  it('caps a tall streaming reply to the window: newest lines, then the input and status line', () => {
    let s = addUser(EMPTY_BLOCKS, 'hello');
    const reply = Array.from({ length: 50 }, (_, i) => `reply line ${i}`).join('\n');
    s = reduceFrame(s, { type: 'text', delta: reply });
    const { lastFrame } = render(
      withTheme(
        <Chat
          blocks={s}
          details={false}
          thinking
          width={80}
          rows={10}
          staticKey={0}
          statusFields={[{ key: 'turn', text: 'streaming 1.0s' }]}
          inputActive
          history={[]}
          onSubmit={vi.fn()}
          onHelp={vi.fn()}
        />,
      ),
    );
    // ink-testing-library prepends the <Static> output (the settled `› hello`) to the live frame.
    const all = (lastFrame() ?? '').split('\n');
    const lines = all.slice(all.findIndex((l) => l.includes('› hello')) + 1);
    // A row short of the window, so Ink redraws in place instead of clearing the screen.
    expect(lines.length).toBeLessThanOrEqual(9);
    expect(lines.at(-1)).toContain('streaming 1.0s');
    expect(lines.at(-2)).toMatch(/^╰/);
    expect(lines.join('\n')).toContain('reply line 49');
    expect(lines.join('\n')).not.toMatch(/reply line 0\b/);
  });
});
