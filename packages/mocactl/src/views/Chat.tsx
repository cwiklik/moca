import { Box, Static } from 'ink';
import type { ReactNode } from 'react';
import type { BannerInfo } from '../core/banner.js';
import { splitStatic, type Block, type BlockState } from '../render/blocks.js';
import { Banner } from './Banner.js';
import { BlockView } from './BlockView.js';
import { InputBox } from './InputBox.js';
import { StatusLine } from './StatusLine.js';
import type { StatusField } from './status.js';

interface Props {
  blocks: BlockState;
  details: boolean;
  thinking: boolean;
  width: number;
  /** Terminal height: the live region is capped to it so Ink never falls back to a full repaint. */
  rows: number;
  staticKey: number;
  statusFields: StatusField[];
  inputActive: boolean;
  history: string[];
  onSubmit: (text: string) => void;
  onHelp: () => void;
  prefill?: { text: string; nonce: number };
  overlay?: ReactNode;
  /** Collected at startup; printed as the FIRST <Static> item, so it scrolls away with history. */
  banner?: BannerInfo;
}

// Settled blocks are printed once through <Static> and never re-rendered, so a long transcript
// costs no more per token than a short one (spec §6.1).
export function Chat({
  blocks,
  details,
  thinking,
  width,
  rows,
  staticKey,
  statusFields,
  inputActive,
  history,
  onSubmit,
  onHelp,
  prefill,
  overlay,
  banner,
}: Props) {
  const { settled, live } = splitStatic(blocks.blocks);
  // Ink's <Static> prints append-only, so the banner rides in as the first item rather than
  // around the region; it arrives after mount once the remote versions have been collected.
  const items: Array<{ banner: BannerInfo } | Block> = banner ? [{ banner }, ...settled] : settled;
  const view = (item: { banner: BannerInfo } | Block) =>
    'banner' in item ? (
      <Banner key="banner" info={item.banner} />
    ) : (
      <BlockView key={item.id} block={item} details={details} thinking={thinking} width={width} />
    );
  // A live frame as tall as the terminal makes Ink clear and repaint the screen on every update
  // (the input box jumps), so the live region stays a row short of it. A streaming reply that
  // outgrows the space is clipped from the top — newest lines stay in view — and reaches history
  // in full through <Static> once it settles; the overlay, input box and status line never shrink.
  // Only the live blocks give way, so if those three alone outgrow the window the cap cannot hold
  // and Ink is back to full repaints (overlays are expected to be short).
  return (
    <>
      <Static key={staticKey} items={items}>
        {view}
      </Static>
      <Box flexDirection="column" maxHeight={Math.max(1, rows - 1)}>
        <Box flexDirection="column" flexShrink={1} overflowY="hidden" justifyContent="flex-end">
          {live.map((b) => (
            <Box key={b.id} flexDirection="column" flexShrink={0}>
              <BlockView block={b} details={details} thinking={thinking} width={width} />
            </Box>
          ))}
        </Box>
        {overlay ? (
          <Box marginTop={1} flexDirection="column" flexShrink={0}>
            {overlay}
          </Box>
        ) : null}
        <Box flexDirection="column" flexShrink={0}>
          <InputBox
            active={inputActive}
            history={history}
            onSubmit={onSubmit}
            onHelp={onHelp}
            prefill={prefill}
          />
        </Box>
        <Box flexShrink={0}>
          <StatusLine fields={statusFields} width={width} />
        </Box>
      </Box>
    </>
  );
}
