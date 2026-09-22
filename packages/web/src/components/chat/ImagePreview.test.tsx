import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useUIStore } from '../../stores/uiStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { isElectron } from '../../platform/platform';
import { copyImageToClipboard, saveImage } from '../../utils/imageActions';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { ImagePreview } from './ImagePreview';

vi.mock('../../platform/platform', () => ({
  isElectron: vi.fn(),
}));

vi.mock('../../utils/imageActions', () => ({
  saveImage: vi.fn(),
  copyImageToClipboard: vi.fn(),
}));

describe('ImagePreview', () => {
  beforeEach(() => {
    vi.mocked(isElectron).mockReturnValue(false);
    useUIStore.setState({
      activeModal: 'imagePreview',
      imagePreviewUrl: '/test-image.png',
      isMobile: false,
    });
    useContextMenuStore.getState().close();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    useContextMenuStore.getState().close();
    useUIStore.getState().closeImagePreview();
  });

  it('covers the complete browser viewport', () => {
    const { container } = render(<ImagePreview />);

    expect(container.firstElementChild).toHaveClass('top-0');
    expect(container.firstElementChild).not.toHaveClass('top-[var(--titlebar-inset)]');
  });

  it('stays below the native window controls in Electron', () => {
    vi.mocked(isElectron).mockReturnValue(true);

    const { container } = render(<ImagePreview />);

    expect(container.firstElementChild).toHaveClass('top-[var(--titlebar-inset)]');
    expect(container.firstElementChild).not.toHaveClass('top-0');
  });

  it('keeps only the close action in the top-right toolbar', () => {
    render(<ImagePreview />);

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('opens copy and save actions from the desktop image context menu', () => {
    render(<ImagePreview />);
    fireEvent.contextMenu(screen.getByRole('img'), { clientX: 30, clientY: 40 });

    const items = useContextMenuStore.getState().menu?.items ?? [];
    expect(items.map((item) => item.key)).toEqual([
      'copy-preview-image',
      'save-preview-image',
    ]);

    if (items[0]?.type === 'action') items[0].onClick();
    if (items[1]?.type === 'action') items[1].onClick();
    expect(copyImageToClipboard).toHaveBeenCalledWith('/test-image.png');
    expect(saveImage).toHaveBeenCalledWith('/test-image.png');
  });

  it('zooms with the desktop wheel and resets on resize', () => {
    const { container } = render(<ImagePreview />);
    const viewport = container.firstElementChild as HTMLDivElement;
    const image = screen.getByRole('img');
    Object.defineProperties(image, {
      offsetWidth: { configurable: true, value: 400 },
      offsetHeight: { configurable: true, value: 300 },
    });
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });

    fireEvent.wheel(viewport, { deltaY: -300, clientX: 500, clientY: 400 });
    expect(image.style.transform).not.toContain('scale(1)');

    fireEvent.resize(window);
    expect(image.style.transform).toContain('translate3d(0px, 0px, 0) scale(1)');
  });

  it('closes from the backdrop or Escape but not from an image click', () => {
    const { container } = render(<ImagePreview />);
    const viewport = container.firstElementChild as HTMLDivElement;

    fireEvent.click(screen.getByRole('img'));
    expect(useUIStore.getState().activeModal).toBe('imagePreview');

    fireEvent.click(viewport);
    expect(useUIStore.getState().activeModal).toBeNull();

    act(() => useUIStore.getState().openImagePreview('/test-image.png'));
    act(() => fireEvent.keyDown(document, { key: 'Escape' }));
    expect(useUIStore.getState().activeModal).toBeNull();
  });

  it('opens the same actions after a mobile long-press', () => {
    vi.useFakeTimers();
    useUIStore.setState({ isMobile: true });
    render(
      <>
        <ImagePreview />
        <ContextMenuRenderer />
      </>,
    );
    const image = screen.getByRole('img');

    fireEvent.touchStart(image, {
      touches: [{ clientX: 40, clientY: 50 }],
    });
    act(() => vi.advanceTimersByTime(500));

    expect(useContextMenuStore.getState().menu?.items.map((item) => item.key)).toEqual([
      'copy-preview-image',
      'save-preview-image',
    ]);
    expect(useUIStore.getState().activeModal).toBe('imagePreview');
  });
});
