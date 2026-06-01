import React from 'react';

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 24 }}>{title}</h1>
      <div style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        padding: 60,
        textAlign: 'center',
        color: 'var(--color-text-muted)',
      }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⊕</div>
        <div style={{ fontSize: 15, color: 'var(--color-text)', marginBottom: 8 }}>{title}</div>
        <div>This section is ready to be implemented.</div>
      </div>
    </div>
  );
}
