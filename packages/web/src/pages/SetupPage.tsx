/**
 * First-run setup wizard.
 *
 * Shown automatically when /auth/setup-status returns { needsSetup: true }.
 * Three steps:
 *   1. Workspace  — organisation name
 *   2. Admin      — your name, email, password
 *   3. Done       — auto-logged-in, guided next steps
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

// ── Tiny shared primitives ─────────────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 14,
      padding: '40px 44px',
      width: '100%',
      maxWidth: 480,
    }}>
      {children}
    </div>
  );
}

function Field({
  label, children, hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-muted)' }}>{label}</label>
      {children}
      {hint && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{hint}</span>}
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  if (!msg) return null;
  return (
    <div style={{
      color: 'var(--color-danger)', fontSize: 13,
      padding: '10px 14px', background: '#ef444415', borderRadius: 8,
    }}>
      {msg}
    </div>
  );
}

function Btn({
  children, loading, secondary, type = 'button', onClick, disabled,
}: {
  children: React.ReactNode;
  loading?: boolean;
  secondary?: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={loading || disabled}
      style={{
        padding: '10px 22px', borderRadius: 8, fontSize: 14, fontWeight: 600,
        cursor: loading || disabled ? 'not-allowed' : 'pointer',
        opacity: loading || disabled ? 0.65 : 1,
        background: secondary ? 'transparent' : 'var(--color-primary)',
        color: secondary ? 'var(--color-text)' : '#fff',
        border: secondary ? '1px solid var(--color-border)' : 'none',
      }}
    >
      {loading ? 'Please wait…' : children}
    </button>
  );
}

function StepDots({ step, total }: { step: number; total: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 28 }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{
          width: i === step ? 20 : 8, height: 8, borderRadius: 4,
          background: i === step ? 'var(--color-primary)' : 'var(--color-border)',
          transition: 'width 0.25s, background 0.25s',
        }} />
      ))}
    </div>
  );
}

// ── Steps ─────────────────────────────────────────────────────────────────────

interface FormState {
  orgName: string;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

function StepWorkspace({
  form, setForm, onNext,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  onNext: () => void;
}) {
  const [err, setErr] = useState('');

  const handleNext = () => {
    if (!form.orgName.trim()) { setErr('Please enter a workspace name.'); return; }
    setErr('');
    onNext();
  };

  return (
    <>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Welcome to Enlight</h1>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 14, marginBottom: 28 }}>
        Let's get your IT workspace set up. This takes about a minute.
      </p>
      <StepDots step={0} total={2} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Field label="Workspace name" hint="Usually your company name — e.g. Acme Corp">
          <input
            autoFocus
            type="text"
            value={form.orgName}
            onChange={(e) => setForm((f) => ({ ...f, orgName: e.target.value }))}
            placeholder="Acme Corp"
            onKeyDown={(e) => e.key === 'Enter' && handleNext()}
          />
        </Field>
        <ErrorBox msg={err} />
        <Btn type="button" onClick={handleNext}>Continue →</Btn>
      </div>
    </>
  );
}

function StepAdmin({
  form, setForm, onBack, onDone,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  onBack: () => void;
  onDone: (token: string) => void;
}) {
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setErr('Please enter your name.'); return; }
    if (!form.email.trim()) { setErr('Please enter your email.'); return; }
    if (form.password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    if (form.password !== form.confirmPassword) { setErr('Passwords do not match.'); return; }
    setErr('');
    setLoading(true);
    try {
      const { token } = await api.post<{ token: string }>('/auth/setup', {
        orgName: form.orgName,
        name: form.name,
        email: form.email,
        password: form.password,
      });
      onDone(token);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Setup failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Create your admin account</h1>
      <p style={{ color: 'var(--color-text-muted)', fontSize: 14, marginBottom: 28 }}>
        This account will be the super admin for <strong>{form.orgName}</strong>.
      </p>
      <StepDots step={1} total={2} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Your name">
          <input
            autoFocus
            type="text"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Ada Lovelace"
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="ada@acme.com"
          />
        </Field>
        <Field label="Password" hint="Minimum 8 characters">
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            placeholder="••••••••"
          />
        </Field>
        <Field label="Confirm password">
          <input
            type="password"
            value={form.confirmPassword}
            onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
            placeholder="••••••••"
          />
        </Field>
        <ErrorBox msg={err} />
        <div style={{ display: 'flex', gap: 10 }}>
          <Btn secondary onClick={onBack}>← Back</Btn>
          <div style={{ flex: 1 }}><Btn type="submit" loading={loading}>Create workspace</Btn></div>
        </div>
      </div>
    </form>
  );
}

function StepDone({ orgName, navigate }: { orgName: string; navigate: (path: string) => void }) {
  const steps = [
    { icon: '💬', title: 'Connect Slack', desc: 'Enable the bot, DM intake, and App Home.', path: '/settings?tab=slack' },
    { icon: '🤖', title: 'Configure the AI agent', desc: 'Set your Anthropic API key and KB embedding provider.', path: '/settings?tab=ai' },
    { icon: '📂', title: 'Create your first project', desc: 'Projects hold tickets, members, SLA policies, and knowledge.', path: '/projects' },
    { icon: '📚', title: 'Add a knowledge source', desc: 'Upload docs or connect Confluence/Notion so the AI can answer questions.', path: '/knowledge' },
  ];

  return (
    <>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 44, marginBottom: 12 }}>🎉</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
          {orgName} is ready!
        </h1>
        <p style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
          You're logged in as a super admin. Here's what to do next:
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
        {steps.map((s) => (
          <button
            key={s.path}
            onClick={() => navigate(s.path)}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 14,
              background: 'var(--color-bg)',
              border: '1px solid var(--color-border)',
              borderRadius: 10, padding: '14px 16px', cursor: 'pointer', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 22, lineHeight: 1 }}>{s.icon}</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{s.title}</div>
              <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>{s.desc}</div>
            </div>
            <span style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: 18, alignSelf: 'center' }}>›</span>
          </button>
        ))}
      </div>

      <Btn type="button" onClick={() => navigate('/')}>Go to dashboard →</Btn>
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SetupPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [step, setStep] = useState<'workspace' | 'admin' | 'done'>('workspace');
  const [form, setForm] = useState<FormState>({
    orgName: '', name: '', email: '', password: '', confirmPassword: '',
  });

  const handleDone = (token: string) => {
    login(token);
    setStep('done');
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      background: 'var(--color-bg)',
    }}>
      <Card>
        {step === 'workspace' && (
          <StepWorkspace form={form} setForm={setForm} onNext={() => setStep('admin')} />
        )}
        {step === 'admin' && (
          <StepAdmin
            form={form}
            setForm={setForm}
            onBack={() => setStep('workspace')}
            onDone={handleDone}
          />
        )}
        {step === 'done' && (
          <StepDone orgName={form.orgName} navigate={navigate} />
        )}
      </Card>
    </div>
  );
}
