import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ParticipantEqItem } from './voiceMenuItems';
import { useVoiceStore } from '../../stores/voiceStore';

const REMOTE_ID = 'remote-user';
const BAND_LABELS = ['Low', 'Low-mid', 'Mid', 'Presence', 'High'];

function storedEq() {
  return useVoiceStore.getState().participantEqs.get(REMOTE_ID);
}

function slider(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

beforeEach(() => {
  useVoiceStore.setState({ participantEqs: new Map() });
});

describe('ParticipantEqItem', () => {
  it('starts on the original curve with every band flat', () => {
    render(<ParticipantEqItem userId={REMOTE_ID} />);

    expect(screen.getByRole('button', { name: 'Original' })).toHaveAttribute('aria-pressed', 'true');
    for (const label of BAND_LABELS) expect(slider(label).value).toBe('0');
    expect(screen.getAllByText('0 dB')).toHaveLength(BAND_LABELS.length);
    expect(storedEq()).toBeUndefined();
  });

  it('applies the bass preset to the store and the sliders', () => {
    render(<ParticipantEqItem userId={REMOTE_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Bass' }));

    expect(storedEq()).toEqual({
      preset: 'bass',
      gains: { low: 8, lowMid: 3, mid: 0, presence: -1, high: -3 },
    });
    expect(slider('Low').value).toBe('8');
    expect(slider('Presence').value).toBe('-1');
    expect(screen.getByText('+8 dB')).toBeInTheDocument();
    expect(screen.getByText('-1 dB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bass' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the other bands and flips to custom when one slider moves', () => {
    render(<ParticipantEqItem userId={REMOTE_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Voice' }));
    fireEvent.change(slider('Low'), { target: { value: '6' } });

    expect(storedEq()).toEqual({
      preset: 'custom',
      gains: { low: 6, lowMid: -2, mid: 1, presence: 4, high: 2 },
    });
    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('+6 dB')).toBeInTheDocument();
    expect(slider('Presence').value).toBe('4');
  });

  it('resets the participant back to the original curve', () => {
    render(<ParticipantEqItem userId={REMOTE_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Bass' }));
    expect(storedEq()).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(storedEq()).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Original' })).toHaveAttribute('aria-pressed', 'true');
    for (const label of BAND_LABELS) expect(slider(label).value).toBe('0');
  });

  it('keeps two participants on independent curves', () => {
    render(<ParticipantEqItem userId={REMOTE_ID} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bass' }));

    const { unmount } = render(<ParticipantEqItem userId="someone-else" />);
    expect(screen.getAllByRole('button', { name: 'Original' }).filter(
      (button) => button.getAttribute('aria-pressed') === 'true',
    )).toHaveLength(1);
    expect(useVoiceStore.getState().participantEqs.get('someone-else')).toBeUndefined();
    unmount();

    expect(storedEq()?.preset).toBe('bass');
  });
});
