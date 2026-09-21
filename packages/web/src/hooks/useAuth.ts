import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { isAndroid } from '../platform/android';

export function useAuth() {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const loadUser = useAuthStore((s) => s.loadUser);
  const error = useAuthStore((s) => s.error);
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) {
      navigate('/login');
      return;
    }

    if (!user && !isLoading && !(isAndroid() && error)) {
      loadUser();
    }
  }, [token, user, isLoading, loadUser, navigate, error]);

  return { user, isLoading, isAuthenticated: !!token };
}
