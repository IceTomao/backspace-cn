// packages/web/src/stores/contextMenuStore.ts
import { create } from 'zustand';
import type { ReactNode } from 'react';

// ── Item types ────────────────────────────────────────────────────────────

interface ContextMenuItemBase {
  key: string;
  hidden?: boolean;
}

export interface ContextMenuAction extends ContextMenuItemBase {
  type: 'action';
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface ContextMenuCheckbox extends ContextMenuItemBase {
  type: 'checkbox';
  label: string;
  subscribe: (onStoreChange: () => void) => () => void;
  getChecked: () => boolean;
  onChange: (checked: boolean) => void;
}

export interface ContextMenuCustom extends ContextMenuItemBase {
  type: 'custom';
  render: () => ReactNode;
}

export interface ContextMenuSeparator extends ContextMenuItemBase {
  type: 'separator';
}

export type ContextMenuLeafItem =
  | ContextMenuAction
  | ContextMenuCheckbox
  | ContextMenuCustom
  | ContextMenuSeparator;

export interface ContextMenuSubmenu extends ContextMenuItemBase {
  type: 'submenu';
  label: string;
  icon?: ReactNode;
  children: ContextMenuLeafItem[];
}

export type ContextMenuItem =
  | ContextMenuAction
  | ContextMenuCheckbox
  | ContextMenuSubmenu
  | ContextMenuCustom
  | ContextMenuSeparator;

// ── Store ─────────────────────────────────────────────────────────────────

/**
 * Marks every element that belongs to an open menu's surface (the panel, its
 * submenu flyouts, and nested popovers a menu item renders).
 *
 * Dismissal cannot rely on a full-screen backdrop alone: profile cards, modals
 * and the screen-share setup overlay all paint above it, so a press that lands
 * on one of them never reaches the backdrop and the menu stays open. The menu
 * listens for presses at the document level instead and treats everything
 * outside these markers as "outside".
 */
export const CONTEXT_MENU_SURFACE_ATTR = 'data-context-menu-surface';

/**
 * Marks the top-level menu panel itself (submenu flyouts do not carry it).
 *
 * Its only consumer is test code that needs a stable handle on the menu, so
 * suites stop hard-coding the panel's z-index utility class.
 */
export const CONTEXT_MENU_PANEL_ATTR = 'data-context-menu-panel';

interface ContextMenuState {
  menu: {
    position: { x: number; y: number };
    items: ContextMenuItem[];
  } | null;
  openSubmenuKey: string | null;

  open: (position: { x: number; y: number }, items: ContextMenuItem[]) => void;
  close: () => void;
  setOpenSubmenu: (key: string | null) => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  menu: null,
  openSubmenuKey: null,

  open: (position, items) =>
    set({ menu: { position, items }, openSubmenuKey: null }),

  close: () =>
    set({ menu: null, openSubmenuKey: null }),

  setOpenSubmenu: (key) =>
    set({ openSubmenuKey: key }),
}));

// ── Utility: filter hidden items and collapse separators ──────────────────

export function filterMenuItems<T extends ContextMenuItemBase & { type: string }>(
  items: T[],
): T[] {
  // 1. Remove hidden items
  const visible = items.filter((item) => !item.hidden);

  // 2. Collapse adjacent separators + strip leading/trailing separators
  const result: T[] = [];
  for (const item of visible) {
    if (item.type === 'separator') {
      if (result.length === 0) continue; // leading
      if (result[result.length - 1]!.type === 'separator') continue; // adjacent
    }
    result.push(item);
  }
  // trailing
  while (result.length > 0 && result[result.length - 1]!.type === 'separator') {
    result.pop();
  }
  return result;
}
