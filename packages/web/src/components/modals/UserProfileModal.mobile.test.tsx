import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';
import { UserProfileModal } from './UserProfileModal';
import { useUIStore } from '../../stores/uiStore';

const requests = vi.hoisted(() => ({ get: vi.fn(), mutuals: vi.fn() }));
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: Object.assign((selector: (value: any) => unknown) => selector({ addDmChannel: vi.fn() }), {
    getState: () => ({ upsertUserView: vi.fn(), findExistingDmForUser: () => null }),
  }),
  getApiForOrigin: () => ({ users: { get: requests.get }, uploads: { url: (key: string) => key } }),
  resolveUserOrigin: () => 'https://remote.example',
}));
vi.mock('../../utils/mutuals', () => ({ loadFederatedMutuals: requests.mutuals }));
vi.mock('../../stores/authStore', () => ({ useAuthStore: (selector: (value: any) => unknown) => selector({ user: null }) }));
vi.mock('../../stores/socialStore', () => ({ useSocialStore: (selector: (value: any) => unknown) => selector({ friends: [], requests: [] }) }));
vi.mock('../../components/ui/ProfileActivityDetails', () => ({ ProfileActivityDetails: () => null }));
vi.mock('../../api/client', () => ({ api: {} }));
const user = { id: 'alice', username: 'alice@remote.example', displayName: 'Alice', createdAt: 0, replicatedInstances: [] } as User;
beforeEach(() => {
  requests.get.mockReset();
  requests.mutuals.mockReset().mockResolvedValue({ mutualFriends: [{ ...user, id: 'friend', displayName: 'Friend', _instanceOrigin: 'https://friend.example' }], mutualSpaces: [] });
  useUIStore.setState({ isMobile: true, activeModal: null, mobileStack: [{ screen: 'user-profile', params: { userId: 'alice' } }] });
});
afterEach(() => { cleanup(); useUIStore.setState({ isMobile: false, mobileStack: [] }); vi.restoreAllMocks(); });
it('renders shared content as a page, pushes mutual friend context and uses history back', async () => {
  const back = vi.spyOn(history, 'back').mockImplementation(() => {});
  const view = render(<MemoryRouter><UserProfileModal mobile userId="alice" initialUser={user} origin="https://remote.example" /></MemoryRouter>);
  expect(await screen.findByText('Alice')).toBeInTheDocument();
  expect(view.container.querySelector('.fixed')).toBeNull();
  expect(useUIStore.getState().activeModal).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /Mutual Friends/ }));
  await userEvent.click((await screen.findByText('Friend')).closest('button')!);
  expect(useUIStore.getState().mobileStack.at(-1)?.params).toEqual({ userId: 'friend', origin: 'https://friend.example' });
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(back).toHaveBeenCalledOnce();
});
it('shows a returnable error and ignores a stale request after navigating to another user', async () => {
  let resolveOld: (value: User) => void = () => {};
  requests.get.mockImplementation((id: string) => id === 'old' ? new Promise(resolve => { resolveOld = resolve; }) : Promise.reject(new Error('offline')));
  const view = render(<MemoryRouter><UserProfileModal mobile userId="old" /></MemoryRouter>);
  view.rerender(<MemoryRouter><UserProfileModal mobile userId="new" /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  await act(async () => resolveOld(user));
  expect(screen.queryByText('Alice')).toBeNull();
  expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
});
