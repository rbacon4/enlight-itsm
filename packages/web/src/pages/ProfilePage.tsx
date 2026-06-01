/**
 * User profile — account settings for the signed-in user.
 *
 * Sections:
 *   • Profile     — display name (editable), email, role
 *   • Password    — change password (hidden for SSO-only accounts)
 *   • 2FA         — set up / disable TOTP
 *   • Notifications — per-user email opt-ins
 *
 * These are per-USER settings, distinct from the org-level Settings page.
 */
import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, User as UserIcon, KeyRound, Smartphone, Bell } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

// ── Shared bits ─────────────────────────────────────────────────────────────

interface Me {
  id: string; name: string; email: string; globalRole: string;
  totpEnabled?: boolean; hasPassword?: boolean;
  emailPreferences?: Record<string, boolean>;
}

function Section({ icon, title, subtitle, children }: {
  icon: React.ReactNode; title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--color-surface)', border: '1px solid var(--color-border)',
      borderRadius: 10, padding: 24, marginBottom: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: subtitle ? 4 : 16 }}>
        <span style={{ color: 'var(--color-text-muted)', display: 'inline-flex' }}>{icon}</span>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>{title}</h2>
      </div>
      {subtitle && <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>{subtitle}</p>}
      {children}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 14 }}>
      <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-muted)' }}>{label}</label>
      {children}
      {hint && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{hint}</span>}
    </div>
  );
}

function Notice({ kind, children }: { kind: 'error' | 'success'; children: React.ReactNode }) {
  const c = kind === 'error'
    ? { color: 'var(--color-danger)', bg: '#ef444415' }
    : { color: 'var(--color-success)', bg: '#10b98115' };
  return (
    <div style={{ color: c.color, background: c.bg, fontSize: 13, padding: '8px 12px', borderRadius: 6, marginTop: 8 }}>
      {children}
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: '8px 18px', borderRadius: 6, background: 'var(--color-primary)',
  color: '#fff', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
};
const btnGhost: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 6, background: 'none',
  border: '1px solid var(--color-border)', cursor: 'pointer', fontSize: 13,
};

// ── Page ────────────────────────────────────────────────────────────────────

export function ProfilePage() {
  const { data: me } = useQuery<Me>({ queryKey: ['me'], queryFn: () => api.get('/users/me') });

  return (
    <div style={{ maxWidth: 680 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 6 }}>Your Profile</h1>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 14, marginBottom: 28 }}>
        Manage your account, security, and notification preferences.
      </p>

      <ProfileSection me={me} />
      {me?.hasPassword !== false && <PasswordSection />}
      <TwoFactorSection />
      <NotificationsSection />
    </div>
  );
}

// ── Profile (name / email / role) ───────────────────────────────────────────

function ProfileSection({ me }: { me: Me | undefined }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (me) setName(me.name); }, [me]);

  const mut = useMutation({
    mutationFn: (newName: string) => api.patch('/users/me/profile', { name: newName }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['me'] }); setSaved(true); setTimeout(() => setSaved(false), 2000); },
  });

  const initial = (me?.name ?? '?').charAt(0).toUpperCase();
  const dirty = me ? name.trim() !== me.name && name.trim().length > 0 : false;

  return (
    <Section icon={<UserIcon size={18} />} title="Profile">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%', background: 'var(--color-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, fontWeight: 700, color: '#fff', flexShrink: 0,
        }}>{initial}</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{me?.name ?? '…'}</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{me?.email}</div>
        </div>
      </div>

      <Field label="Display name">
        <input value={name} onChange={e => setName(e.target.value)} style={{ maxWidth: 360 }} />
      </Field>
      <Field label="Email">
        <input value={me?.email ?? ''} disabled style={{ maxWidth: 360, opacity: 0.6 }} />
      </Field>
      <Field label="Role">
        <input value={me?.globalRole ?? ''} disabled style={{ maxWidth: 360, opacity: 0.6, textTransform: 'capitalize' }} />
      </Field>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button style={{ ...btnPrimary, opacity: dirty ? 1 : 0.5, cursor: dirty ? 'pointer' : 'default' }}
          disabled={!dirty || mut.isPending} onClick={() => mut.mutate(name.trim())}>
          {mut.isPending ? 'Saving…' : 'Save changes'}
        </button>
        {saved && <span style={{ fontSize: 13, color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}><Check size={14} /> Saved</span>}
      </div>
    </Section>
  );
}

// ── Password change ─────────────────────────────────────────────────────────

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const mut = useMutation({
    mutationFn: () => api.patch('/users/me/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setDone(true); setError(''); setCurrent(''); setNext(''); setConfirm('');
      setTimeout(() => setDone(false), 3000);
    },
    onError: (e: Error) => setError(e.message),
  });

  const submit = () => {
    setError('');
    if (next.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (next !== confirm) { setError('New passwords do not match.'); return; }
    mut.mutate();
  };

  return (
    <Section icon={<KeyRound size={18} />} title="Password"
      subtitle="Change the password you use to sign in.">
      <Field label="Current password">
        <input type="password" value={current} onChange={e => setCurrent(e.target.value)}
          placeholder="••••••••" style={{ maxWidth: 360 }} />
      </Field>
      <Field label="New password" hint="At least 8 characters.">
        <input type="password" value={next} onChange={e => setNext(e.target.value)}
          placeholder="••••••••" style={{ maxWidth: 360 }} />
      </Field>
      <Field label="Confirm new password">
        <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
          placeholder="••••••••" style={{ maxWidth: 360 }} />
      </Field>
      <button style={btnPrimary} disabled={!current || !next || !confirm || mut.isPending} onClick={submit}>
        {mut.isPending ? 'Updating…' : 'Update password'}
      </button>
      {error && <Notice kind="error">{error}</Notice>}
      {done && <Notice kind="success">Password updated successfully.</Notice>}
    </Section>
  );
}

// ── Two-factor authentication ───────────────────────────────────────────────

function TwoFactorSection() {
  const qc = useQueryClient();
  const [step, setStep] = useState<'idle' | 'confirm' | 'disable'>('idle');
  const [qrData, setQrData] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const { data: me } = useQuery<Me>({ queryKey: ['me'], queryFn: () => api.get('/users/me') });
  const totpEnabled = me?.totpEnabled ?? false;

  const setupMut = useMutation({
    mutationFn: () => api.post<{ qrDataUrl: string; secret: string }>('/auth/totp/setup', {}),
    onSuccess: (d) => { setQrData(d); setStep('confirm'); setError(''); },
    onError: (e: Error) => setError(e.message),
  });
  const confirmMut = useMutation({
    mutationFn: (c: string) => api.post('/auth/totp/confirm', { code: c }),
    onSuccess: () => { setStep('idle'); setCode(''); qc.invalidateQueries({ queryKey: ['me'] }); },
    onError: (e: Error) => setError(e.message),
  });
  const disableMut = useMutation({
    mutationFn: (c: string) => api.post('/auth/totp/disable', { code: c }),
    onSuccess: () => { setStep('idle'); setCode(''); qc.invalidateQueries({ queryKey: ['me'] }); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Section icon={<Smartphone size={18} />} title="Two-Factor Authentication"
      subtitle="Add a second step at sign-in using an authenticator app (Google Authenticator, Authy, 1Password, etc.).">

      {totpEnabled && step !== 'disable' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12,
          background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: 8, padding: '12px 16px' }}>
          <Check size={16} color="#065f46" />
          <span style={{ fontSize: 13, color: '#065f46', fontWeight: 500 }}>2FA is enabled on your account.</span>
          <button onClick={() => { setStep('disable'); setCode(''); setError(''); }}
            style={{ marginLeft: 'auto', fontSize: 12, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer' }}>
            Disable
          </button>
        </div>
      )}

      {!totpEnabled && step === 'idle' && (
        <button style={btnPrimary} disabled={setupMut.isPending} onClick={() => setupMut.mutate()}>
          {setupMut.isPending ? 'Generating…' : 'Set up 2FA'}
        </button>
      )}

      {step === 'confirm' && qrData && (
        <div>
          <p style={{ fontSize: 13, marginBottom: 12 }}>
            Scan this QR code with your authenticator app, then enter the 6-digit code to confirm.
          </p>
          <img src={qrData.qrDataUrl} alt="TOTP QR code"
            style={{ display: 'block', marginBottom: 12, border: '1px solid var(--color-border)', borderRadius: 6 }} />
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 16 }}>
            Manual entry key: <code style={{ fontFamily: 'monospace' }}>{qrData.secret}</code>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="123456" style={{ width: 120 }} maxLength={8} />
            <button style={btnPrimary} disabled={code.length < 6 || confirmMut.isPending}
              onClick={() => { setError(''); confirmMut.mutate(code); }}>
              {confirmMut.isPending ? 'Verifying…' : 'Confirm'}
            </button>
            <button style={btnGhost} onClick={() => { setStep('idle'); setQrData(null); setCode(''); }}>Cancel</button>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
        </div>
      )}

      {step === 'disable' && (
        <div>
          <p style={{ fontSize: 13, marginBottom: 12 }}>Enter your current 6-digit code to confirm disabling 2FA.</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="123456" style={{ width: 120 }} maxLength={8} />
            <button style={{ ...btnPrimary, background: 'var(--color-danger)' }}
              disabled={code.length < 6 || disableMut.isPending}
              onClick={() => { setError(''); disableMut.mutate(code); }}>
              {disableMut.isPending ? 'Disabling…' : 'Disable 2FA'}
            </button>
            <button style={btnGhost} onClick={() => { setStep('idle'); setCode(''); setError(''); }}>Cancel</button>
          </div>
          {error && <Notice kind="error">{error}</Notice>}
        </div>
      )}
    </Section>
  );
}

// ── Notification preferences ────────────────────────────────────────────────

const NOTIF_PREFS: { key: string; label: string; hint: string }[] = [
  { key: 'ticketCreated',    label: 'Ticket confirmation',    hint: 'A confirmation email when you open a new ticket.' },
  { key: 'agentReplied',     label: 'Agent replies',          hint: 'When an agent replies to one of your tickets.' },
  { key: 'ticketResolved',   label: 'Ticket resolved',        hint: 'When your ticket is marked resolved or closed.' },
  { key: 'assigned',         label: 'Ticket assigned to you', hint: 'When a ticket is assigned to you.' },
  { key: 'requesterReplied', label: 'Requester replies',      hint: 'When the requester replies to a ticket assigned to you.' },
];

function NotificationsSection() {
  const qc = useQueryClient();
  const { data: me } = useQuery<Me>({ queryKey: ['me'], queryFn: () => api.get('/users/me') });
  const prefs = (me?.emailPreferences ?? {}) as Record<string, boolean>;

  const mut = useMutation({
    mutationFn: (body: Record<string, boolean>) => api.patch('/users/me/preferences', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  const toggle = (key: string) => mut.mutate({ [key]: !(prefs[key] ?? true) });

  return (
    <Section icon={<Bell size={18} />} title="Email Notifications"
      subtitle="Choose which emails you receive. Changes take effect immediately.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {NOTIF_PREFS.map(({ key, label, hint }) => {
          const enabled = prefs[key] ?? true;
          return (
            <label key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={enabled} onChange={() => toggle(key)} style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>{label}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{hint}</div>
              </div>
            </label>
          );
        })}
      </div>
    </Section>
  );
}
