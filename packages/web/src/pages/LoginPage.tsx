import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Surface any SSO error passed back as ?sso_error= after a failed redirect.
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get('sso_error') ?? '');
  const [loading, setLoading] = useState(false);

  // TOTP second-step state
  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');

  const startSso = () => {
    window.location.href = '/api/auth/saml/login';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const resp = await api.post<{ token?: string; requiresTotp?: boolean; totpToken?: string }>(
        '/auth/login', { email, password },
      );
      if (resp.requiresTotp && resp.totpToken) {
        setTotpToken(resp.totpToken);
      } else if (resp.token) {
        login(resp.token);
        navigate('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await api.post<{ token: string }>('/auth/totp/verify', {
        totpToken, code: totpCode,
      });
      login(token);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        padding: 40,
        width: '100%',
        maxWidth: 400,
      }}>
        <div style={{ marginBottom: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Enlight</div>
          <div style={{ color: 'var(--color-text-muted)' }}>
            {totpToken ? 'Two-factor authentication' : 'Sign in to your workspace'}
          </div>
        </div>

        {/* ── TOTP second step ── */}
        {totpToken ? (
          <form onSubmit={handleTotpSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>
              Open your authenticator app and enter the 6-digit code.
            </p>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
                Authentication code
              </label>
              <input
                autoFocus
                type="text"
                inputMode="numeric"
                value={totpCode}
                onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                placeholder="123456"
                maxLength={8}
                style={{ letterSpacing: '0.2em', textAlign: 'center', fontSize: 20 }}
                required
              />
            </div>
            {error && (
              <div style={{ color: 'var(--color-danger)', fontSize: 13, padding: '8px 12px', background: '#ef444415', borderRadius: 6 }}>
                {error}
              </div>
            )}
            <button type="submit" className="btn-primary" disabled={loading || totpCode.length < 6}
              style={{ marginTop: 4, padding: '10px 0', fontWeight: 600 }}>
              {loading ? 'Verifying…' : 'Verify'}
            </button>
            <button type="button" onClick={() => { setTotpToken(null); setTotpCode(''); setError(''); }}
              style={{ fontSize: 12, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
              ← Back to sign in
            </button>
          </form>
        ) : (
          /* ── Password step ── */
          <>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
                  Email
                </label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
                  Password
                </label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
              </div>
              {error && (
                <div style={{ color: 'var(--color-danger)', fontSize: 13, padding: '8px 12px', background: '#ef444415', borderRadius: 6 }}>
                  {error}
                </div>
              )}
              <button type="submit" className="btn-primary" disabled={loading} style={{ marginTop: 8, padding: '10px 0', fontWeight: 600 }}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0', color: 'var(--color-text-muted)', fontSize: 12 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
              <span>or</span>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
            </div>

            <button type="button" onClick={startSso} className="btn-ghost"
              style={{ width: '100%', padding: '10px 0', fontWeight: 600, border: '1px solid var(--color-border)', borderRadius: 6 }}>
              Sign in with SSO
            </button>
          </>
        )}
      </div>
    </div>
  );
}
