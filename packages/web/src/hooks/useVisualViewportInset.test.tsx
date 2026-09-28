import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useVisualViewportInset } from './useVisualViewportInset';

let innerHeight = 1100;
let visualHeight = 1075;
let visualTop = 0;
let shellTop = 0;
let shellHeight = 1125;
let viewport: EventTarget & { height: number; offsetTop: number; pageTop: number };

function Probe() {
  const state = useVisualViewportInset();
  return <output data-testid="viewport-state">{JSON.stringify(state)}</output>;
}

function state() {
  return JSON.parse(screen.getAllByTestId('viewport-state')[0]?.textContent || '{}') as ReturnType<typeof useVisualViewportInset>;
}

beforeEach(() => {
  vi.useFakeTimers();
  innerHeight = 1100;
  visualHeight = 1075;
  visualTop = 0;
  shellTop = 0;
  shellHeight = 1125;
  viewport = new EventTarget() as typeof viewport;
  Object.defineProperties(viewport, {
    height: { get: () => visualHeight },
    offsetTop: { get: () => visualTop },
    pageTop: { get: () => visualTop },
  });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => innerHeight });
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  const shell = document.createElement('div');
  shell.dataset.mobileShell = '';
  shell.getBoundingClientRect = () => {
    const offset = parseFloat(document.documentElement.style.getPropertyValue('--mobile-shell-offset')) || 0;
    return { top: shellTop + offset, bottom: shellTop + offset + shellHeight, height: shellHeight,
      left: 0, right: 400, width: 400, x: 0, y: shellTop + offset, toJSON: () => ({}) };
  };
  document.body.appendChild(shell);
});

afterEach(() => {
  cleanup();
  document.querySelector('[data-mobile-shell]')?.remove();
  vi.useRealTimers();
  delete (navigator as Navigator & { standalone?: boolean }).standalone;
  delete (window as Window & { visualViewport?: VisualViewport }).visualViewport;
});

it('keeps polling through delayed keyboard geometry and ignores the resting safe-area gap', () => {
  const addListener = vi.spyOn(viewport, 'addEventListener');
  render(<><Probe /><Probe /></>);
  expect(addListener.mock.calls.filter(([event]) => event === 'resize')).toHaveLength(1);
  const input = document.createElement('textarea');
  document.body.appendChild(input);
  act(() => input.focus());
  act(() => vi.advanceTimersByTime(300));
  visualHeight = 700;
  act(() => vi.advanceTimersByTime(40));
  expect(state().keyboardOpen).toBe(true);
  expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('700px');

  act(() => vi.advanceTimersByTime(500));
  visualHeight = 1075;
  act(() => vi.advanceTimersByTime(40));
  expect(state().keyboardOpen).toBe(false);
  expect(state().keyboardVisible).toBe(false);
  expect(state().textInputFocused).toBe(true);
  input.remove();
});

it('holds the closed shell height while dynamic viewport sizing is stale', () => {
  render(<Probe />);
  shellHeight = 1060;
  act(() => viewport.dispatchEvent(new Event('resize')));
  act(() => vi.advanceTimersByTime(20));
  expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('1125px');
});

it('restores the measured closed height while layout viewport recovery lags', () => {
  render(<Probe />);
  const input = document.createElement('textarea');
  document.body.appendChild(input);
  act(() => input.focus());
  innerHeight = 800;
  visualHeight = 775;
  act(() => vi.advanceTimersByTime(800));
  expect(state().keyboardOpen).toBe(false);
  expect(state().keyboardVisible).toBe(true);

  act(() => input.blur());
  act(() => vi.advanceTimersByTime(40));
  expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('1125px');
  innerHeight = 1100;
  visualHeight = 1075;
  act(() => vi.advanceTimersByTime(40));
  expect(document.documentElement.style.getPropertyValue('--app-height')).toContain('var(--app-dvh)');
  input.remove();
});

it('compensates a panned standalone shell and clears the offset when it recovers', () => {
  render(<Probe />);
  shellTop = -42;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  act(() => vi.advanceTimersByTime(20));
  expect(document.documentElement.style.getPropertyValue('--mobile-shell-offset')).toBe('42px');

  shellTop = 0;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  act(() => vi.advanceTimersByTime(20));
  expect(document.documentElement.style.getPropertyValue('--mobile-shell-offset')).toBe('0px');
});

it('does not compensate an ordinary Safari tab', () => {
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: false });
  render(<Probe />);
  shellTop = -42;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  act(() => vi.advanceTimersByTime(20));
  expect(document.documentElement.style.getPropertyValue('--mobile-shell-offset')).toBe('');
});

it('clears an old offset and takes a new height baseline after rotation', () => {
  render(<Probe />);
  shellTop = -42;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  act(() => vi.advanceTimersByTime(20));
  expect(document.documentElement.style.getPropertyValue('--mobile-shell-offset')).toBe('42px');

  innerHeight = 700;
  visualHeight = 675;
  shellHeight = 725;
  act(() => window.dispatchEvent(new Event('orientationchange')));
  expect(document.documentElement.style.getPropertyValue('--mobile-shell-offset')).toBe('0px');
  shellTop = 0;
  act(() => vi.advanceTimersByTime(550));
  expect(document.documentElement.style.getPropertyValue('--mobile-shell-offset')).toBe('0px');

  innerHeight = 550;
  visualHeight = 525;
  const input = document.createElement('textarea');
  document.body.appendChild(input);
  act(() => input.focus());
  act(() => vi.advanceTimersByTime(750));
  expect(state().keyboardVisible).toBe(true);
  act(() => input.blur());
  act(() => vi.advanceTimersByTime(40));
  expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('725px');
  input.remove();
});
