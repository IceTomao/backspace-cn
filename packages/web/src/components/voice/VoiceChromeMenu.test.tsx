import { useRef } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { VoiceChromeMenu } from './VoiceChromeMenu';
import { useVoiceStore } from '../../stores/voiceStore';

function Harness({ open }: { open: boolean }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef} type="button">gear</button>
      <VoiceChromeMenu open={open} onClose={() => {}} anchorRef={anchorRef} />
    </>
  );
}

beforeEach(() => {
  useVoiceStore.getState().resetFullscreenChrome();
});

describe('VoiceChromeMenu fill viewport switch', () => {
  it('renders the switch off by default and turns it on when pressed', () => {
    render(<Harness open />);

    const fill = screen.getByRole('switch', { name: 'Fill the viewport' });
    expect(fill).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByText('Hides the member strip, Grid button and member-list toggle'),
    ).toBeInTheDocument();

    fireEvent.click(fill);

    expect(useVoiceStore.getState().fullscreenChrome.fillViewport).toBe(true);
    expect(fill).toHaveAttribute('aria-checked', 'true');
  });

  it('clears the setting again through Show all', () => {
    useVoiceStore.getState().setFullscreenChrome({ fillViewport: true });
    render(<Harness open />);

    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));

    expect(useVoiceStore.getState().fullscreenChrome.fillViewport).toBe(false);
  });
});
