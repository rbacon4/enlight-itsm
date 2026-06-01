import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';

/**
 * Lands here after SSO. The API redirects to /auth/callback#token=<jwt>;
 * we read the token from the URL fragment, store it, and enter the app.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    const token = new URLSearchParams(hash).get('token');
    if (token) {
      login(token);
      // Clear the token from the URL before entering the app.
      window.history.replaceState(null, '', '/');
      navigate('/', { replace: true });
    } else {
      setFailed(true);
      const t = setTimeout(() => navigate('/login', { replace: true }), 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [login, navigate]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
      {failed ? 'No sign-in token found — returning to login…' : 'Completing sign-in…'}
    </div>
  );
}
