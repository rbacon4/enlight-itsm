/**
 * Public CSAT (customer satisfaction) rating page.
 * URL: /csat/:token  or  /csat/:token?rating=N
 *
 * The email resolution email includes emoji star links (?rating=1..5).
 * Clicking one pre-fills the form.
 */
import React, { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';

const API_BASE = import.meta.env['VITE_API_URL'] ?? '/api';

async function csatFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, opts);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

interface SurveyInfo {
  id: string;
  respondedAt: string | null;
  requestTitle: string;
  requestTicketNumber: number;
  projectName: string;
  projectKey: string;
}

const EMOJIS = ['😞', '😕', '😐', '🙂', '😄'];
const LABELS = ['Very dissatisfied', 'Dissatisfied', 'Neutral', 'Satisfied', 'Very satisfied'];

export function CsatPage() {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const preRating = parseInt(searchParams.get('rating') ?? '0', 10);

  const [rating, setRating] = useState<number>(preRating >= 1 && preRating <= 5 ? preRating : 0);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);

  const { data: survey, isLoading, error } = useQuery<SurveyInfo>({
    queryKey: ['csat', token],
    queryFn: () => csatFetch(`/csat/${token}`),
    retry: false,
  });

  // If a pre-rating came via query string and form loads, auto-submit after brief delay
  useEffect(() => {
    if (preRating >= 1 && preRating <= 5 && survey && !survey.respondedAt) {
      setRating(preRating);
    }
  }, [preRating, survey]);

  const submitMut = useMutation({
    mutationFn: () => csatFetch(`/csat/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, comment: comment || undefined }),
    }),
    onSuccess: () => setDone(true),
  });

  if (isLoading) {
    return <Wrap><p style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>Loading…</p></Wrap>;
  }

  if (error || !survey) {
    return (
      <Wrap>
        <p style={{ color: 'var(--color-danger)', fontSize: 14 }}>
          This survey link is not valid or has expired.
        </p>
      </Wrap>
    );
  }

  if (survey.respondedAt || done) {
    return (
      <Wrap>
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🙏</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Thanks for your feedback!</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>
            Your response has been recorded and will help us improve our support.
          </p>
        </div>
      </Wrap>
    );
  }

  return (
    <Wrap>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 4 }}>
          {survey.projectName} · {survey.projectKey}-{survey.requestTicketNumber}
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{survey.requestTitle}</h2>
      </div>

      <p style={{ fontSize: 14, color: 'var(--color-text-muted)', marginBottom: 24 }}>
        How satisfied were you with the support you received?
      </p>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 20 }}>
        {EMOJIS.map((emoji, i) => {
          const val = i + 1;
          const selected = rating === val;
          return (
            <button
              key={val}
              onClick={() => setRating(val)}
              title={LABELS[i]}
              style={{
                fontSize: 32, padding: '8px 12px', borderRadius: 12, border: '2px solid',
                borderColor: selected ? 'var(--color-primary)' : 'var(--color-border)',
                background: selected ? 'var(--color-primary)10' : 'var(--color-surface)',
                cursor: 'pointer', lineHeight: 1, transform: selected ? 'scale(1.15)' : 'scale(1)',
                transition: 'transform 0.15s, border-color 0.15s',
              }}
            >
              {emoji}
            </button>
          );
        })}
      </div>

      {rating > 0 && (
        <div style={{ textAlign: 'center', marginBottom: 20, fontSize: 13, color: 'var(--color-text-muted)' }}>
          {LABELS[rating - 1]}
        </div>
      )}

      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6, color: 'var(--color-text-muted)' }}>
          Additional comments (optional)
        </label>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          placeholder="Tell us more about your experience…"
          rows={3}
          style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box' }}
        />
      </div>

      {submitMut.error && (
        <div style={{ color: 'var(--color-danger)', fontSize: 13, marginBottom: 12 }}>
          {(submitMut.error as Error).message}
        </div>
      )}

      <button
        onClick={() => submitMut.mutate()}
        disabled={rating === 0 || submitMut.isPending}
        style={{
          width: '100%', padding: '10px 0', borderRadius: 8,
          background: rating > 0 ? 'var(--color-primary)' : 'var(--color-border)',
          color: rating > 0 ? '#fff' : 'var(--color-text-muted)',
          border: 'none', cursor: rating > 0 ? 'pointer' : 'default',
          fontSize: 14, fontWeight: 600,
        }}
      >
        {submitMut.isPending ? 'Submitting…' : 'Submit feedback'}
      </button>
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 14, padding: 36, width: '100%', maxWidth: 480 }}>
        {children}
      </div>
    </div>
  );
}
