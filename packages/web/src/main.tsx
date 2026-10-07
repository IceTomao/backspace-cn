import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { startPendingMessageOrchestrator } from './stores/pendingMessageRehydrate';
import i18n, { initI18n } from './i18n';
import './styles/globals.css';
import { initializeInterfaceScale } from './platform/interfaceScale';
import compatibilityTheme from '../../desktop/resources/theme.css?raw';
import { isAndroid } from './platform/android';
import { isElectron } from './platform/platform';
import { initializeWebTheme } from './platform/webTheme';

const stopInterfaceScale = initializeInterfaceScale();
if (import.meta.hot) import.meta.hot.dispose(stopInterfaceScale);
const stopWebTheme = initializeWebTheme();
if (!isAndroid() && !isElectron()) {
  const themeStyle = document.createElement('style');
  themeStyle.textContent = compatibilityTheme;
  document.head.append(themeStyle);
}
if (import.meta.hot) import.meta.hot.dispose(stopWebTheme);

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null; showStack: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, showStack: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo.componentStack);
    // Renderer is alive enough to show the fallback UI — disarm the boot timer.
    // Without this, the timer fires 20s after a caught render error and
    // overrides the in-app error UI with native recovery, which is wrong.
    // Gated on VITE_FORCE_BOOT_STALL so the smoke harness can suppress both
    // ping paths simultaneously when testing the renderer-stalled recovery path.
    if (import.meta.env.VITE_FORCE_BOOT_STALL) return;
    if (typeof window.backspace?.rendererReady === 'function') {
      window.backspace.rendererReady();
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          height: 'calc(100*var(--app-vh))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgb(var(--bg-base))',
          color: 'rgb(var(--text-primary))',
          fontFamily: "'DM Sans', sans-serif",
          flexDirection: 'column',
          gap: '16px',
          padding: '24px',
        }}>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold' }}>{i18n.t('common:crash.title')}</h1>
          <p style={{ color: 'rgb(var(--text-secondary))', maxWidth: '480px', textAlign: 'center' }}>{this.state.error?.message}</p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{
                padding: '8px 24px',
                backgroundColor: 'rgb(var(--accent-primary))',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              {i18n.t('common:actions.tryAgain')}
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 24px',
                backgroundColor: 'transparent',
                color: 'rgb(var(--text-secondary))',
                border: '1px solid rgb(var(--border-soft))',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: "'DM Sans', sans-serif",
              }}
            >
              {i18n.t('common:crash.reload')}
            </button>
          </div>
          {this.state.error?.stack && (
            <details
              open={this.state.showStack}
              onToggle={(e) => this.setState({ showStack: (e.target as HTMLDetailsElement).open })}
              style={{ maxWidth: '600px', width: '100%', marginTop: '8px' }}
            >
              <summary style={{ color: 'rgb(var(--text-secondary))', cursor: 'pointer', fontSize: '13px' }}>
                {i18n.t('common:crash.details')}
              </summary>
              <pre style={{
                marginTop: '8px',
                padding: '12px',
                backgroundColor: 'rgb(var(--bg-elevated))',
                borderRadius: '8px',
                fontSize: '11px',
                color: 'rgb(var(--text-secondary))',
                overflow: 'auto',
                maxHeight: '200px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

startPendingMessageOrchestrator();

function render(): void {
  ReactDOM.createRoot(root!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

// The selected language's catalogs are loaded before the first paint, so
// nothing flashes English first. English itself is bundled, so if loading a
// language fails the app still renders, in English, rather than not at all.
initI18n()
  .catch((err) => { console.error('[i18n] Failed to initialise, rendering in English:', err); })
  .finally(render);
