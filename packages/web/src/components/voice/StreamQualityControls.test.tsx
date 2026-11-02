import React, { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamQualityControls } from './StreamQualityControls';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUIStore } from '../../stores/uiStore';
import i18n from '../../i18n';
import { useNativeHdrStore } from '../../stores/nativeHdrStore';
import { DEFAULT_STREAM_COLOR } from '../../utils/streamColor';
import { resetCodecCapabilityCacheForTests } from '../../utils/codecCapabilities';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { streamingLimits: null }) => unknown) =>
    selector({ streamingLimits: null }),
  getStreamingLimits: () => ({
    minBitrateKbps: 500,
    maxBitrateKbps: 20_000,
    allowCustomBitrate: true,
    bitrateMatrixOverrides: null,
  }),
}));

beforeEach(() => {
  resetCodecCapabilityCacheForTests();
  vi.stubGlobal('RTCRtpSender', {
    getCapabilities: () => ({ codecs: [{ mimeType: 'video/H265' }] }),
  });
  localStorage.clear();
  useVoiceStore.setState({ ...useVoiceStore.getInitialState() });
  useNativeHdrStore.setState({ available: false, publisherAvailable: false });
});

afterEach(() => {
  resetCodecCapabilityCacheForTests();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('screen-share codec & color controls', () => {
  it('shows the native HDR gate, fixed Main10 codec and live lock while retaining the SDR preference', async () => {
    vi.spyOn(useNativeHdrStore.getState(), 'refresh').mockResolvedValue();
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    const { rerender } = render(<StreamQualityControls />);
    const toggle = screen.getByRole('switch', { name: i18n.t('voice:streamSettings.hdrEnabled') });
    expect(toggle).toBeDisabled();
    useNativeHdrStore.setState({ available: true, publisherAvailable: true });
    rerender(<StreamQualityControls />);
    expect(toggle).toBeEnabled();
    await act(async () => { fireEvent.click(toggle); });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(i18n.t('voice:streamSettings.hdrCodec'))).toBeVisible();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
    useVoiceStore.setState({ isScreenSharing: true }); rerender(<StreamQualityControls />);
    expect(toggle).toBeDisabled();
    expect(screen.getByText(i18n.t('voice:streamSettings.hdrLocked'))).toBeVisible();
    useVoiceStore.setState({ isScreenSharing: false }); rerender(<StreamQualityControls />);
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'H264' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('persists HDR exposure adjustments and resets without native control traffic before streaming', async () => {
    vi.spyOn(useNativeHdrStore.getState(), 'refresh').mockResolvedValue();
    useNativeHdrStore.setState({ publisherAvailable: true, experimental: true, colorControl: true, pendingColor: null });
    useVoiceStore.getState().setScreenShareConfig({ hdrEnabled: true });
    render(<StreamQualityControls />);
    const exposure = screen.getByRole('slider', { name: i18n.t('voice:streamSettings.hdrExposure') });
    fireEvent.change(exposure, { target: { value: '1.5' } });
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({ hdrExposureEv: 1.5 });
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.hdrExposureEv).toBe(1.5);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('voice:streamSettings.hdrReset') }));
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({ hdrExposureEv: 0 });
  });

  it('expands Color Channels, preserves per-channel R/G/B curves independently from All Channels, supports double-click single reset and full reset', async () => {
    render(<StreamQualityControls />);

    const headerBtn = screen.getByRole('button', { name: i18n.t('voice:streamSettings.colorChannels.title') });
    expect(headerBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('slider', { name: i18n.t('voice:streamSettings.colorChannels.brightness') })).toBeNull();

    fireEvent.click(headerBtn);
    expect(headerBtn).toHaveAttribute('aria-expanded', 'true');

    const allTab = screen.getByRole('button', { name: i18n.t('voice:streamSettings.colorChannels.channel.all') });
    const redTab = screen.getByRole('button', { name: i18n.t('voice:streamSettings.colorChannels.channel.red') });
    expect(allTab).toHaveAttribute('aria-pressed', 'true');

    // Adjust Red channel independently
    fireEvent.click(redTab);
    expect(redTab).toHaveAttribute('aria-pressed', 'true');
    const brightnessSlider = screen.getByRole('slider', { name: i18n.t('voice:streamSettings.colorChannels.brightness') });
    const gammaSlider = screen.getByRole('slider', { name: i18n.t('voice:streamSettings.colorChannels.gamma') });
    fireEvent.change(brightnessSlider, { target: { value: '72' } });
    fireEvent.change(gammaSlider, { target: { value: '1.45' } });

    // Switch back to All Channels and adjust Contrast + global Digital Vibrance + Hue
    fireEvent.click(allTab);
    expect(brightnessSlider).toHaveValue('50');
    const contrastSlider = screen.getByRole('slider', { name: i18n.t('voice:streamSettings.colorChannels.contrast') });
    const vibranceSlider = screen.getByRole('slider', { name: i18n.t('voice:streamSettings.colorChannels.digitalVibrance') });
    const hueSlider = screen.getByRole('slider', { name: i18n.t('voice:streamSettings.colorChannels.hue') });

    fireEvent.change(contrastSlider, { target: { value: '64' } });
    fireEvent.change(vibranceSlider, { target: { value: '80' } });
    fireEvent.change(hueSlider, { target: { value: '120' } });

    const saved = useVoiceStore.getState().screenShareConfig.streamColor;
    expect(saved.red).toEqual({ brightness: 72, contrast: 50, gamma: 1.45 });
    expect(saved.all).toEqual({ brightness: 50, contrast: 64, gamma: 1 });
    expect(saved.digitalVibrance).toBe(80);
    expect(saved.hue).toBe(120);
    expect(screen.getByText(i18n.t('voice:streamSettings.colorChannels.modified'))).toBeVisible();

    // Rehydrate from localStorage and confirm persistence
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.streamColor.red.gamma).toBe(1.45);

    // Double-click Hue slider resets only Hue back to 0
    fireEvent.doubleClick(hueSlider);
    expect(useVoiceStore.getState().screenShareConfig.streamColor.hue).toBe(0);
    expect(useVoiceStore.getState().screenShareConfig.streamColor.digitalVibrance).toBe(80);

    // Reset all restores DEFAULT_STREAM_COLOR
    fireEvent.click(screen.getByRole('button', { name: i18n.t('voice:streamSettings.colorChannels.reset') }));
    expect(useVoiceStore.getState().screenShareConfig.streamColor).toEqual(DEFAULT_STREAM_COLOR);
  });

  it('offers and persists H.265 when the sender supports it', () => {
    render(<StreamQualityControls />);
    const option = screen.getByRole('button', { name: 'H.265/HEVC' });
    expect(option).toBeEnabled();
    fireEvent.click(option);
    expect(option).toHaveAttribute('aria-pressed', 'true');
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h265');
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('h265');
  });

  it.each([
    ['unsupported codecs', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) }],
    ['missing WebRTC API', undefined],
    ['failed detection', { getCapabilities: () => { throw new Error('unavailable'); } }],
  ])('keeps H.265 visible but unselectable with an explanation for %s', (_label, sender) => {
    vi.stubGlobal('RTCRtpSender', sender);
    render(<StreamQualityControls />);
    const option = screen.getByRole('button', { name: 'H.265/HEVC' });
    expect(option).toBeDisabled();
    expect(option).toHaveAccessibleDescription(i18n.t('voice:streamSettings.h265Unsupported'));
    fireEvent.click(option);
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('auto');
    expect(screen.getByRole('button', { name: i18n.t('voice:streamSettings.codecOption.auto') })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'VP9' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'H264' })).toBeEnabled();
  });

  it('resets a restored unsupported choice once to Auto (HW), including StrictMode effect replay, and persists congestion strategy', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h265' });
    await useVoiceStore.persist.rehydrate();
    vi.stubGlobal('RTCRtpSender', undefined);
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');
    const { rerender } = render(<StrictMode><StreamQualityControls /></StrictMode>);

    expect(screen.getByRole('button', { name: i18n.t('voice:streamSettings.codecOption.auto') })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'H.265/HEVC' })).toBeDisabled();
    expect(addToast).toHaveBeenCalledWith(i18n.t('voice:streamSettings.h265Fallback'), 'warning', 8000);
    rerender(<StrictMode><StreamQualityControls /></StrictMode>);
    expect(addToast).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('auto');

    // Verify 3-way Congestion Strategy selector defaults to Maintain Resolution and updates cleanly
    const maintainResBtn = screen.getByRole('button', { name: i18n.t('voice:streamSettings.degradation.maintainResolution') });
    const maintainFpsBtn = screen.getByRole('button', { name: i18n.t('voice:streamSettings.degradation.maintainFramerate') });
    expect(maintainResBtn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(maintainFpsBtn);
    expect(maintainFpsBtn).toHaveAttribute('aria-pressed', 'true');
    expect(useVoiceStore.getState().screenShareConfig.degradationPreference).toBe('maintain-framerate');
  });
});
