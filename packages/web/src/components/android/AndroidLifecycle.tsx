import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { androidCall, onAndroid } from '../../platform/android';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { AndroidSettings } from './AndroidSettings';

export function AndroidLifecycle() {
  const navigate = useNavigate();
  useEffect(() => {
    const back = onAndroid('back', () => {
      const ui = useUIStore.getState();
      if (ui.mobileStack.length) history.back();
      else if (window.location.pathname !== '/channels/@me' && !window.location.pathname.startsWith('/login')) navigate('/channels/@me');
      else void androidCall('minimize');
    });
    const storageError = () => useUIStore.getState().addToast(i18n.t('settings:android.storageFailed'), 'warning');
    window.addEventListener('android-storage-error', storageError);
    return () => { back(); window.removeEventListener('android-storage-error', storageError); };
  }, [navigate]);
  return null;
}

export function AndroidRecovery() {
  const { t } = useTranslation('settings');
  const error = useAuthStore(s => s.error);
  const loading = useAuthStore(s => s.isLoading);
  return <main className="h-full overflow-y-auto bg-surface-base text-txt-primary p-6">
    <div className="max-w-md mx-auto space-y-6">
      <h1 className="text-xl font-semibold">{t('android.offline')}</h1>
      <p role="alert">{error}</p>
      <button disabled={loading} className="px-4 py-2 bg-accent-primary text-white rounded" onClick={() => void useAuthStore.getState().loadUser()}>{t('android.retry')}</button>
      <AndroidSettings serverOnly />
    </div>
  </main>;
}
