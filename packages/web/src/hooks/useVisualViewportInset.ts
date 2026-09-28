import { useSyncExternalStore } from 'react';
import { layoutPixels } from '../platform/interfaceScale';
import { isAndroid } from '../platform/android';

export interface VisualViewportInset {
  value: string;
  keyboardOpen: boolean;
  keyboardVisible: boolean;
  textInputFocused: boolean;
  height: number | null;
  offsetTop: number | null;
}

const FALLBACK: VisualViewportInset = {
  value: 'var(--safe-bottom)',
  keyboardOpen: false,
  keyboardVisible: false,
  textInputFocused: false,
  height: null,
  offsetTop: null,
};

const listeners = new Set<() => void>();
let snapshot = FALLBACK;
let stop: (() => void) | null = null;

function isIosStandalone(): boolean {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches)
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && standalone;
}

function publish(next: VisualViewportInset) {
  if (Object.keys(next).every((key) => next[key as keyof VisualViewportInset] === snapshot[key as keyof VisualViewportInset])) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function start(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};

  const root = document.documentElement;
  const standalone = isIosStandalone();
  const shell = () => document.querySelector<HTMLElement>('[data-mobile-shell]');
  const isEditable = (target: Element | null) => target instanceof HTMLElement && (
    target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
  );
  let focused = isEditable(document.activeElement);
  let closedInnerHeight = window.innerHeight;
  let closedOcclusion = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
  let closedShellHeight = shell()?.getBoundingClientRect().height ?? window.innerHeight;
  let closedShellTop = shell()?.getBoundingClientRect().top ?? 0;
  let shellOffset = 0;
  let raf = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let scrollResetAttempted = false;
  let focusPendingUntil = 0;
  let orientationSettlingUntil = 0;
  let orientationTimer: ReturnType<typeof setTimeout> | null = null;

  const measure = () => {
    const innerHeight = window.innerHeight;
    const occlusion = Math.max(0, innerHeight - vv.offsetTop - vv.height);
    const layoutShrink = closedInnerHeight - innerHeight;
    // A closed PWA can leave a safe-area-sized visual viewport gap.
    const keyboardOpen = focused && occlusion > closedOcclusion + 16;
    const keyboardVisible = focused && (keyboardOpen || layoutShrink > 80 || performance.now() < focusPendingUntil);

    if (!keyboardVisible && innerHeight >= closedInnerHeight - 16) {
      closedInnerHeight = Math.max(closedInnerHeight, innerHeight);
      closedOcclusion = occlusion;
    }

    root.style.setProperty('--visual-viewport-height', `${layoutPixels(vv.height)}px`);
    root.style.setProperty('--visual-viewport-top', `${layoutPixels(vv.offsetTop)}px`);
    root.style.setProperty('--keyboard-occlusion', `${keyboardOpen ? layoutPixels(occlusion) : 0}px`);

    const normalHeight = isAndroid()
      ? 'calc(100 * var(--app-dvh))'
      : 'calc(100 * var(--app-dvh) + var(--safe-bottom))';
    const orientationSettling = performance.now() < orientationSettlingUntil;
    const restoring = standalone && !keyboardVisible && !orientationSettling && layoutShrink > 16;
    root.style.setProperty('--app-height', keyboardOpen
      ? `${layoutPixels(vv.height)}px`
      : restoring ? `${layoutPixels(closedShellHeight)}px` : normalHeight);

    // Keep the measured pre-keyboard height if WebKit's 100dvh is still short.
    const element = shell();
    if (standalone && !keyboardVisible && !restoring && !orientationSettling && element
      && element.getBoundingClientRect().height < closedShellHeight - 16) {
      root.style.setProperty('--app-height', `${layoutPixels(closedShellHeight)}px`);
    }

    if (standalone && !keyboardVisible && !orientationSettling && element) {
      const scrollOffset = window.scrollY || root.scrollTop || document.body.scrollTop;
      if (scrollOffset && !scrollResetAttempted) {
        scrollResetAttempted = true;
        window.scrollTo(0, 0);
        root.scrollTop = 0;
        document.body.scrollTop = 0;
      } else if (!scrollOffset) {
        const unadjustedTop = element.getBoundingClientRect().top - shellOffset;
        const nextOffset = Math.max(0, closedShellTop - unadjustedTop);
        if (Math.abs(nextOffset - shellOffset) > 1) {
          shellOffset = nextOffset;
          root.style.setProperty('--mobile-shell-offset', `${layoutPixels(shellOffset)}px`);
        }
      }
    } else if (shellOffset) {
      shellOffset = 0;
      root.style.setProperty('--mobile-shell-offset', '0px');
    }

    if (!keyboardVisible && !focused && innerHeight >= closedInnerHeight - 16 && element
      && Math.abs(shellOffset) < 1) {
      closedShellHeight = Math.max(closedShellHeight, element.getBoundingClientRect().height);
    }

    publish({
      value: keyboardOpen ? `${Math.round(layoutPixels(occlusion))}px` : 'var(--safe-bottom)',
      keyboardOpen,
      keyboardVisible,
      textInputFocused: focused,
      height: layoutPixels(vv.height),
      offsetTop: layoutPixels(vv.offsetTop),
    });
  };

  const schedule = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { raf = 0; measure(); });
  };

  // iOS can start changing viewport geometry after several apparently stable frames.
  const poll = () => {
    if (pollTimer) clearInterval(pollTimer);
    let ticks = 0;
    pollTimer = setInterval(() => {
      measure();
      if (++ticks >= 32) {
        clearInterval(pollTimer!);
        pollTimer = null;
        measure();
      }
    }, 32);
  };

  const onFocus = (event: FocusEvent) => {
    if (!isEditable(event.target as Element | null)) return;
    focused = event.type === 'focusin';
    focusPendingUntil = focused ? performance.now() + 700 : 0;
    scrollResetAttempted = false;
    schedule();
    poll();
  };
  const onViewportChange = () => { schedule(); if (focused) poll(); };
  const onReturn = () => { if (!document.hidden) { schedule(); poll(); } };
  const onOrientation = () => {
    shellOffset = 0;
    root.style.setProperty('--mobile-shell-offset', '0px');
    orientationSettlingUntil = performance.now() + 500;
    if (!focused) {
      closedInnerHeight = window.innerHeight;
      closedOcclusion = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      root.style.setProperty('--app-height', isAndroid()
        ? 'calc(100 * var(--app-dvh))'
        : 'calc(100 * var(--app-dvh) + var(--safe-bottom))');
      if (orientationTimer) clearTimeout(orientationTimer);
      orientationTimer = setTimeout(() => {
        closedInnerHeight = window.innerHeight;
        closedOcclusion = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
        closedShellHeight = shell()?.getBoundingClientRect().height ?? window.innerHeight;
        schedule();
      }, 500);
    }
    scrollResetAttempted = false;
    schedule();
    poll();
  };

  measure();
  vv.addEventListener('resize', onViewportChange);
  vv.addEventListener('scroll', onViewportChange);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('focusin', onFocus, true);
  window.addEventListener('focusout', onFocus, true);
  window.addEventListener('pageshow', onReturn);
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('orientationchange', onOrientation);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    if (pollTimer) clearInterval(pollTimer);
    if (orientationTimer) clearTimeout(orientationTimer);
    vv.removeEventListener('resize', onViewportChange);
    vv.removeEventListener('scroll', onViewportChange);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('focusin', onFocus, true);
    window.removeEventListener('focusout', onFocus, true);
    window.removeEventListener('pageshow', onReturn);
    document.removeEventListener('visibilitychange', onReturn);
    window.removeEventListener('orientationchange', onOrientation);
    root.style.removeProperty('--visual-viewport-height');
    root.style.removeProperty('--visual-viewport-top');
    root.style.removeProperty('--keyboard-occlusion');
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--mobile-shell-offset');
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) stop = start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
      snapshot = FALLBACK;
    }
  };
}

export function useVisualViewportInset(): VisualViewportInset {
  return useSyncExternalStore(subscribe, () => snapshot, () => FALLBACK);
}
