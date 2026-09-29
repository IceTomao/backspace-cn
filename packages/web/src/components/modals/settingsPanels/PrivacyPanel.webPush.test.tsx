import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';
import i18n from '../../../i18n';
import { WebPushSetupError } from '../../../platform/notifications';
import { useAuthStore } from '../../../stores/authStore';
import { PrivacyPanel } from './PrivacyPanel';

const syncWebPushSubscription = vi.hoisted(() => vi.fn());
vi.mock('../../../platform/notifications', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../platform/notifications')>(),
  syncWebPushSubscription,
}));

class GrantedNotification {
  static permission = 'granted';
  static requestPermission = vi.fn().mockResolvedValue('granted');
}

beforeEach(() => {
  vi.stubGlobal('Notification', GrantedNotification);
  syncWebPushSubscription.mockResolvedValue(false);
  useAuthStore.setState({ user: { id: 'signed-in-user' } as User });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('does not show enabled based only on browser notification permission', async () => {
  render(<PrivacyPanel />);

  const toggle = screen.getByRole('switch', {
    name: i18n.t('settings:privacy.webPush.label'),
  });
  await waitFor(() => expect(syncWebPushSubscription).toHaveBeenCalledOnce());
  expect(toggle).toHaveAttribute('aria-checked', 'false');
});

it('shows the browser error name and diagnostic stage', async () => {
  syncWebPushSubscription.mockRejectedValue(new WebPushSetupError('subscriptionFailed', {
    stage: 'subscribe',
    errorName: 'NotAllowedError',
    errorMessage: 'Push service rejected the request',
  }));
  render(<PrivacyPanel />);

  await waitFor(() => {
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/NotAllowedError: Push service rejected the request/)).toBeInTheDocument();
  });
});
