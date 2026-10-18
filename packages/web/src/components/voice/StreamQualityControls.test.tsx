import React, { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamQualityControls } from './StreamQualityControls';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUIStore } from '../../stores/uiStore';
import i18n from '../../i18n';
import { useNativeHdrStore } from '../../stores/nativeHdrStore';

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
  vi.stubGlobal('RTCRtpSender', {
    getCapabilities: () => ({ codecs: [{ mimeType: 'video/H265' }] }),
  });
  localStorage.clear();
  useVoiceStore.setState({ ...useVoiceStore.getInitialState() });
  useNativeHdrStore.setState({ available: false, publisherAvailable: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('screen-share codec controls', () => {
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
  it('persists HDR adjustments and resets without native control traffic before streaming', async () => {
    vi.spyOn(useNativeHdrStore.getState(), 'refresh').mockResolvedValue();
    useNativeHdrStore.setState({ publisherAvailable: true, experimental: true, colorControl: true, pendingColor: null });
    useVoiceStore.getState().setScreenShareConfig({ hdrEnabled: true });
    render(<StreamQualityControls />);
    const exposure = screen.getByRole('slider', { name: i18n.t('voice:streamSettings.hdrExposure') });
    const brightness = screen.getByRole('slider', { name: i18n.t('voice:streamSettings.hdrBrightness') });
    fireEvent.change(exposure, { target: { value: '1.5' } });
    fireEvent.change(brightness, { target: { value: '25' } });
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({ hdrExposureEv: 1.5, hdrBrightness: 25 });
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.hdrExposureEv).toBe(1.5);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('voice:streamSettings.hdrReset') }));
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({ hdrExposureEv: 0, hdrBrightness: 0 });
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
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('vp9');
    expect(screen.getByRole('button', { name: 'VP9' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'H264' })).toBeEnabled();
  });

  it('resets a restored unsupported choice once, including StrictMode effect replay', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h265' });
    await useVoiceStore.persist.rehydrate();
    vi.stubGlobal('RTCRtpSender', undefined);
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');
    const { rerender } = render(<StrictMode><StreamQualityControls /></StrictMode>);

    expect(screen.getByRole('button', { name: 'VP9' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'H.265/HEVC' })).toBeDisabled();
    expect(addToast).toHaveBeenCalledWith(i18n.t('voice:streamSettings.h265Fallback'), 'warning', 8000);
    rerender(<StrictMode><StreamQualityControls /></StrictMode>);
    expect(addToast).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('vp9');
  });
});
