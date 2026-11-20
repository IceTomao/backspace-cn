import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useContextMenuStore, CONTEXT_MENU_SURFACE_ATTR } from '../../../stores/contextMenuStore';
import { ContextMenuRenderer } from '../ContextMenuRenderer';

// ContextMenuRenderer reads isMobile from the UI store; force the desktop menu.
vi.mock('../../../stores/uiStore', () => ({
  useUIStore: (selector: (s: { isMobile: boolean }) => unknown) =>
    selector({ isMobile: false }),
}));

function openMenu() {
  useContextMenuStore.getState().open({ x: 40, y: 40 }, [
    { key: 'profile', type: 'action', label: 'View Profile', onClick: () => {} },
  ]);
}

beforeEach(() => {
  useContextMenuStore.getState().close();
  document.body.innerHTML = '';
});

describe('ContextMenu dismissal', () => {
  it('closes when a press lands outside the menu surface', () => {
    openMenu();
    render(<ContextMenuRenderer />);
    expect(useContextMenuStore.getState().menu).not.toBeNull();

    // A press on any element that is not marked as menu surface dismisses it,
    // even when that element (a profile card, a modal…) paints above the
    // menu's own backdrop and therefore never reaches it.
    fireEvent.pointerDown(document.body);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('stays open when the press lands inside the menu panel', () => {
    openMenu();
    render(<ContextMenuRenderer />);

    const panel = document.querySelector(`[${CONTEXT_MENU_SURFACE_ATTR}]`);
    expect(panel).not.toBeNull();
    fireEvent.pointerDown(panel as Element);

    expect(useContextMenuStore.getState().menu).not.toBeNull();
    expect(screen.getByText('View Profile')).toBeTruthy();
  });

  it('stays open when the press lands on a nested surface outside the panel', () => {
    openMenu();
    render(<ContextMenuRenderer />);

    // Screen-share quality popovers rendered from a menu item mark themselves
    // as menu surface without living inside the panel's DOM subtree.
    const nested = document.createElement('div');
    nested.setAttribute(CONTEXT_MENU_SURFACE_ATTR, '');
    const button = document.createElement('button');
    nested.appendChild(button);
    document.body.appendChild(nested);

    fireEvent.pointerDown(button);
    expect(useContextMenuStore.getState().menu).not.toBeNull();
  });

  it('closes when the window loses focus', () => {
    openMenu();
    render(<ContextMenuRenderer />);

    fireEvent.blur(window);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('closes when a press lands on the backdrop', () => {
    openMenu();
    render(<ContextMenuRenderer />);

    const backdrop = document.querySelector('div.fixed.inset-0');
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop as Element);

    expect(useContextMenuStore.getState().menu).toBeNull();
  });
});
