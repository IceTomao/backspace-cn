import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AndroidUpdatePrompt, AndroidUpdateSection } from './AndroidAppUpdates';
import { useAndroidUpdateStore } from '../../stores/androidUpdateStore';

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: vi.fn() }) } }));
vi.mock('../../platform/android', () => ({
  isAndroid: () => true,
  androidCall: (...args: unknown[]) => native.call(...args),
  onAndroid: () => () => {},
}));
const available = { currentVersion: '1.3.22', phase: 'available' as const, version: '1.3.23', dismissedVersion: null };
beforeEach(() => {
  useAndroidUpdateStore.setState({ snapshot: available });
  native.call.mockReset().mockResolvedValue(available);
});
afterEach(() => { cleanup(); useAndroidUpdateStore.setState({ snapshot: null }); });
it('shows the installed APK version and a working download action, with a disabled check while busy', async () => {
  render(<AndroidUpdateSection />);
  expect(screen.getByText('Current version: 1.3.22')).toBeInTheDocument();
  await waitFor(() => expect(native.call).toHaveBeenCalledWith('checkAppUpdate', { manual: false }));
  await userEvent.click(screen.getByRole('button', { name: 'Download update' }));
  expect(native.call).toHaveBeenCalledWith('downloadAppUpdate');
  let resolve: (value: unknown) => void = () => {};
  native.call.mockImplementation((action: string) => action === 'checkAppUpdate' ? new Promise(done => { resolve = done; }) : Promise.resolve(available));
  await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
  expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  await act(async () => resolve({ ...available, phase: 'up-to-date' }));
  expect(screen.getByText('You are up to date.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download update' })).toBeNull();
});
it('can dismiss a version reminder without removing the settings download entry', async () => {
  native.call.mockImplementation((action: string) => Promise.resolve({ ...available, dismissedVersion: action === 'dismissAppUpdate' ? '1.3.23' : null }));
  const view = render(<AndroidUpdatePrompt />);
  await waitFor(() => expect(screen.getByText('Version 1.3.23 is available')).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: 'Remind me later' }));
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<AndroidUpdateSection />);
  expect(screen.getByRole('button', { name: 'Download update' })).toBeInTheDocument();
});
