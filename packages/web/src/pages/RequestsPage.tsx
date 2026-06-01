import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { ticketId } from '@enlight/shared';
import type { Project, Request, Comment, PaginatedResponse, Attachment } from '@enlight/shared';

// ── Badges ────────────────────────────────────────────────────────────────────

function PriorityBadge({ priority }: { priority: string }) {
  return <span className={`badge badge-${priority}`}>{priority}</span>;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status.replace(/_/g, ' ')}</span>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OrgMember {
  id: string;
  name: string;
  email: string;
  globalRole: string;
}

interface RequestWithComments extends Request {
  comments: Comment[];
  attachments: unknown[];
}

// ── New Request Modal ─────────────────────────────────────────────────────────

interface RequestTemplate {
  id: string; name: string; description: string | null;
  title: string; body: string; priority: string; category: string | null;
}

function NewRequestModal({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'medium' as const,
    category: '',
  });

  // Load templates for this project
  const { data: templates } = useQuery<RequestTemplate[]>({
    queryKey: ['templates', project.id],
    queryFn: () => api.get(`/projects/${project.id}/templates`),
    staleTime: 60_000,
  });

  const applyTemplate = (t: RequestTemplate) => {
    setForm(f => ({
      ...f,
      title: t.title || f.title,
      description: t.body || f.description,
      priority: (t.priority as typeof f.priority) || f.priority,
      category: t.category || f.category,
    }));
  };

  const canSubmit = user?.globalRole === 'admin' || user?.globalRole === 'super_admin' || user?.globalRole === 'agent' || user?.globalRole === 'viewer' || user?.globalRole === 'customer';

  const mutation = useMutation({
    mutationFn: () =>
      api.post<Request>(`/projects/${project.id}/requests`, {
        title: form.title,
        description: form.description,
        priority: form.priority,
        category: form.category || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['requests', project.id] });
      onClose();
    },
  });

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: '#00000080', zIndex: 200,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        padding: 28,
        width: 520,
        maxWidth: '95vw',
        maxHeight: '90vh',
        overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>New Request</h2>
          <button className="btn-ghost" onClick={onClose} style={{ padding: '4px 10px', fontSize: 13 }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {templates && templates.length > 0 && (
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
                Start from a template
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {templates.map(t => (
                  <button key={t.id} onClick={() => applyTemplate(t)} title={t.description ?? undefined}
                    style={{ fontSize: 12, padding: '4px 10px', borderRadius: 16, border: '1px solid var(--color-border)', background: 'var(--color-surface-2)', cursor: 'pointer' }}>
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
              Title <span style={{ color: 'var(--color-danger)' }}>*</span>
            </label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Brief summary of the issue"
              autoFocus
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Describe the issue in detail…"
              rows={4}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>Priority</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as typeof form.priority })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>

            {project.categories.length > 0 && (
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>Category</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  <option value="">Select category…</option>
                  {project.categories.map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        {mutation.error && (
          <p style={{ color: 'var(--color-danger)', fontSize: 13, marginTop: 12 }}>
            {(mutation.error as Error).message}
          </p>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => mutation.mutate()}
            disabled={!form.title.trim() || mutation.isPending || !canSubmit}
          >
            {mutation.isPending ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Request Detail Panel ──────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentsSection({ projectId, requestId, canDelete }: { projectId: string; requestId: string; canDelete: boolean }) {
  const qc = useQueryClient();
  const base = `/projects/${projectId}/requests/${requestId}/attachments`;
  const [error, setError] = useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);

  const { data: items } = useQuery({ queryKey: ['attachments', requestId], queryFn: () => api.get<Attachment[]>(base) });

  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(new Error('Could not read file'));
        r.readAsDataURL(file);
      });
      return api.post<Attachment>(base, { filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64 });
    },
    onSuccess: () => { setError(''); qc.invalidateQueries({ queryKey: ['attachments', requestId] }); },
    onError: (e: Error) => setError(e.message),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.delete(`${base}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['attachments', requestId] }),
  });

  const download = async (id: string) => {
    try {
      const { url } = await api.get<{ url: string }>(`${base}/${id}/download`);
      window.open(url, '_blank');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--color-border)', padding: '16px 20px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
        Attachments {items && items.length > 0 && `(${items.length})`}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {(items ?? []).map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '6px 10px' }}>
            <button onClick={() => download(a.id)} style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', padding: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.filename}>
              {a.filename}
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{formatBytes(a.sizeBytes)}</span>
              {canDelete && <button onClick={() => delMut.mutate(a.id)} style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: 12 }}>✕</button>}
            </div>
          </div>
        ))}
        {items && items.length === 0 && <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>No attachments.</div>}
      </div>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => { const file = e.target.files?.[0]; if (file) uploadMut.mutate(file); e.target.value = ''; }} />
      <button className="btn-secondary" style={{ fontSize: 13 }} onClick={() => fileRef.current?.click()} disabled={uploadMut.isPending}>
        {uploadMut.isPending ? 'Uploading…' : '+ Attach file'}
      </button>
      {error && <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function RequestDetailPanel({
  requestId,
  projectId,
  projectSlug,
  memberMap,
  agentMembers,
  onClose,
}: {
  requestId: string;
  projectId: string;
  projectSlug: string;
  memberMap: Record<string, string>;
  agentMembers: OrgMember[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEdit = user?.globalRole === 'admin' || user?.globalRole === 'super_admin' || user?.globalRole === 'agent';

  const [commentText, setCommentText] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [editStatus, setEditStatus] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [editAssignee, setEditAssignee] = useState('');

  const { data: req, isLoading } = useQuery({
    queryKey: ['request', projectId, requestId],
    queryFn: () => api.get<RequestWithComments>(`/projects/${projectId}/requests/${requestId}`),
  });

  // Sync edit fields when request loads
  useEffect(() => {
    if (req) {
      setEditStatus(req.status);
      setEditPriority(req.priority);
      setEditAssignee(req.assigneeId ?? '');
    }
  }, [req?.id, req?.status, req?.priority, req?.assigneeId]);

  const updateMutation = useMutation({
    mutationFn: (fields: Record<string, unknown>) =>
      api.patch<Request>(`/projects/${projectId}/requests/${requestId}`, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['request', projectId, requestId] });
      qc.invalidateQueries({ queryKey: ['requests', projectId] });
    },
  });

  const commentMutation = useMutation({
    mutationFn: () =>
      api.post<Comment>(`/projects/${projectId}/requests/${requestId}/comments`, {
        body: commentText,
        isInternal,
      }),
    onSuccess: () => {
      setCommentText('');
      qc.invalidateQueries({ queryKey: ['request', projectId, requestId] });
    },
  });

  const handleFieldChange = (field: string, value: string) => {
    if (field === 'status') setEditStatus(value);
    if (field === 'priority') setEditPriority(value);
    if (field === 'assigneeId') setEditAssignee(value);

    const payload: Record<string, string | null> = { [field]: value || null };
    updateMutation.mutate(payload);
  };

  const publicComments = req?.comments.filter((c) => !c.isInternal) ?? [];
  const allComments = req?.comments ?? [];
  const visibleComments = canEdit ? allComments : publicComments;

  return (
    <div style={{
      position: 'fixed',
      top: 0, right: 0, bottom: 0,
      width: 520,
      background: 'var(--color-surface)',
      borderLeft: '1px solid var(--color-border)',
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      boxShadow: '-8px 0 32px #00000040',
    }}>
      {/* Panel header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 13, fontWeight: 700, fontFamily: 'monospace',
          color: 'var(--color-primary)', letterSpacing: '0.02em',
        }}>
          {req ? ticketId(projectSlug, req.ticketNumber) : '…'}
        </span>
        <button className="btn-ghost" onClick={onClose} style={{ padding: '4px 10px', fontSize: 13 }}>✕</button>
      </div>

      {isLoading && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-muted)' }}>Loading…</div>
      )}

      {req && (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {/* Title + meta */}
          <div style={{ padding: '20px 20px 0' }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.4, marginBottom: 14 }}>{req.title}</h2>

            {/* Status / Priority / Assignee controls */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</label>
                {canEdit ? (
                  <select
                    value={editStatus}
                    onChange={(e) => handleFieldChange('status', e.target.value)}
                    style={{ fontSize: 13, padding: '5px 10px' }}
                  >
                    <option value="open">Open</option>
                    <option value="in_progress">In Progress</option>
                    <option value="pending_user">Pending User</option>
                    <option value="resolved">Resolved</option>
                    <option value="closed">Closed</option>
                  </select>
                ) : (
                  <StatusBadge status={req.status} />
                )}
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Priority</label>
                {canEdit ? (
                  <select
                    value={editPriority}
                    onChange={(e) => handleFieldChange('priority', e.target.value)}
                    style={{ fontSize: 13, padding: '5px 10px' }}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                ) : (
                  <PriorityBadge priority={req.priority} />
                )}
              </div>

              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Assignee</label>
                {canEdit ? (
                  <select
                    value={editAssignee}
                    onChange={(e) => handleFieldChange('assigneeId', e.target.value)}
                    style={{ fontSize: 13, padding: '5px 10px' }}
                  >
                    <option value="">Unassigned</option>
                    {agentMembers
                      .filter((m) => ['super_admin', 'admin', 'agent'].includes(m.globalRole))
                      .map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                  </select>
                ) : (
                  <span style={{ fontSize: 13 }}>
                    {req.assigneeId ? (memberMap[req.assigneeId] ?? req.assigneeId.slice(0, 8)) : '—'}
                  </span>
                )}
              </div>
            </div>

            {/* Timestamps */}
            <div style={{ display: 'flex', gap: 16, marginBottom: 16, fontSize: 12, color: 'var(--color-text-muted)' }}>
              <span>Created {new Date(req.createdAt).toLocaleString()}</span>
              {req.resolvedAt && <span>· Resolved {new Date(req.resolvedAt).toLocaleString()}</span>}
            </div>

            {/* Description */}
            {req.description && (
              <div style={{
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                padding: 14,
                fontSize: 13,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                marginBottom: 20,
              }}>
                {req.description}
              </div>
            )}
          </div>

          {/* Attachments */}
          <AttachmentsSection projectId={projectId} requestId={requestId} canDelete={canEdit} />

          {/* Comments */}
          <div style={{
            borderTop: '1px solid var(--color-border)',
            padding: '16px 20px',
            flex: 1,
          }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Comments {visibleComments.length > 0 && `(${visibleComments.length})`}
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {visibleComments.map((c) => (
                <div key={c.id} style={{
                  background: c.isInternal ? '#f59e0b08' : 'var(--color-surface-2)',
                  border: `1px solid ${c.isInternal ? '#f59e0b30' : 'var(--color-border)'}`,
                  borderRadius: 8,
                  padding: 12,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>
                      {c.aiGenerated ? '🤖 Enlight AI' : (memberMap[c.authorId] ?? c.authorId.slice(0, 8))}
                    </span>
                    {c.isInternal && (
                      <span style={{ fontSize: 10, background: '#f59e0b20', color: '#f59e0b', padding: '1px 6px', borderRadius: 4, fontWeight: 600, textTransform: 'uppercase' }}>
                        Internal
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-muted)' }}>
                      {new Date(c.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0 }}>{c.body}</p>
                </div>
              ))}

              {visibleComments.length === 0 && (
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)', textAlign: 'center', padding: '16px 0' }}>
                  No comments yet
                </p>
              )}
            </div>

            {/* Reply form */}
            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Write a reply…"
                rows={3}
                style={{ width: '100%', resize: 'vertical', marginBottom: 8 }}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                {canEdit && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: 'var(--color-text-muted)' }}>
                    <input
                      type="checkbox"
                      checked={isInternal}
                      onChange={(e) => setIsInternal(e.target.checked)}
                    />
                    Internal note
                  </label>
                )}
                <button
                  className="btn-primary"
                  style={{ marginLeft: 'auto', padding: '6px 16px', fontSize: 13 }}
                  onClick={() => commentMutation.mutate()}
                  disabled={!commentText.trim() || commentMutation.isPending}
                >
                  {commentMutation.isPending ? 'Sending…' : 'Reply'}
                </button>
              </div>
              {commentMutation.error && (
                <p style={{ color: 'var(--color-danger)', fontSize: 12, marginTop: 6 }}>
                  {(commentMutation.error as Error).message}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function RequestsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [page, setPage] = useState(1);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkPriority, setBulkPriority] = useState('');

  const bulkMut = useMutation({
    mutationFn: (updates: Record<string, unknown>) =>
      api.post(`/projects/${selectedProjectId}/requests/bulk`, { ids: [...selectedIds], ...updates }),
    onSuccess: () => {
      setSelectedIds(new Set());
      setBulkStatus('');
      setBulkPriority('');
      qc.invalidateQueries({ queryKey: ['requests', selectedProjectId] });
    },
  });

  const toggleSelect = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const canEdit = user?.globalRole === 'admin' || user?.globalRole === 'super_admin' || user?.globalRole === 'agent';

  // Projects list
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/projects'),
  });

  // Auto-select first project
  useEffect(() => {
    if (projects?.length && !selectedProjectId) {
      setSelectedProjectId(projects[0]!.id);
    }
  }, [projects, selectedProjectId]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [selectedProjectId, statusFilter, priorityFilter]);

  // Org members (for name resolution and assignee dropdown)
  const { data: members } = useQuery({
    queryKey: ['users', 'agents'],
    queryFn: () => api.get<OrgMember[]>('/users/agents'),
  });

  const memberMap = useMemo(() => {
    const m: Record<string, string> = {};
    members?.forEach((u) => { m[u.id] = u.name; });
    return m;
  }, [members]);

  // Requests list
  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (statusFilter) params.set('status', statusFilter);
  if (priorityFilter) params.set('priority', priorityFilter);

  const { data, isLoading } = useQuery({
    queryKey: ['requests', selectedProjectId, statusFilter, priorityFilter, page],
    queryFn: () =>
      api.get<PaginatedResponse<Request>>(`/projects/${selectedProjectId}/requests?${params}`),
    enabled: !!selectedProjectId,
  });

  const selectedProject = projects?.find((p) => p.id === selectedProjectId);
  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 1;

  return (
    <>
      {/* Shift content left when panel is open */}
      <div style={{
        marginRight: selectedRequestId ? 520 : 0,
        transition: 'margin-right 0.2s ease',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700 }}>Requests</h1>
          {canEdit && selectedProject && (
            <button className="btn-primary" onClick={() => setShowNewModal(true)}>
              + New Request
            </button>
          )}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
          <select
            value={selectedProjectId}
            onChange={(e) => {
              setSelectedProjectId(e.target.value);
              setSelectedRequestId(null);
            }}
            style={{ minWidth: 180 }}
          >
            {!projects && <option value="">Loading projects…</option>}
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ minWidth: 150 }}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In Progress</option>
            <option value="pending_user">Pending User</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>

          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} style={{ minWidth: 150 }}>
            <option value="">All priorities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          {(statusFilter || priorityFilter) && (
            <button
              className="btn-ghost"
              onClick={() => { setStatusFilter(''); setPriorityFilter(''); }}
              style={{ fontSize: 12, padding: '5px 12px' }}
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Table */}
        {!selectedProjectId && (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--color-text-muted)' }}>
            Select a project to view requests
          </div>
        )}

        {isLoading && (
          <div style={{ color: 'var(--color-text-muted)', padding: 40, textAlign: 'center' }}>Loading…</div>
        )}

        {data && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                {data.total} request{data.total !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Bulk action toolbar */}
            {selectedIds.size > 0 && canEdit && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
                background: 'var(--color-primary)10', border: '1px solid var(--color-primary)30',
                borderRadius: 8, padding: '8px 14px' }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{selectedIds.size} selected</span>
                <select value={bulkStatus} onChange={e => setBulkStatus(e.target.value)}
                  style={{ fontSize: 12, padding: '3px 8px' }}>
                  <option value="">Set status…</option>
                  {['open','in_progress','pending_user','resolved','closed'].map(s =>
                    <option key={s} value={s}>{s.replace('_',' ')}</option>)}
                </select>
                <select value={bulkPriority} onChange={e => setBulkPriority(e.target.value)}
                  style={{ fontSize: 12, padding: '3px 8px' }}>
                  <option value="">Set priority…</option>
                  {['critical','high','medium','low'].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <button
                  disabled={!bulkStatus && !bulkPriority || bulkMut.isPending}
                  onClick={() => {
                    const updates: Record<string,unknown> = {};
                    if (bulkStatus) updates['status'] = bulkStatus;
                    if (bulkPriority) updates['priority'] = bulkPriority;
                    bulkMut.mutate(updates);
                  }}
                  style={{ fontSize: 12, padding: '3px 12px', borderRadius: 6, background: 'var(--color-primary)', color: '#fff', border: 'none', cursor: 'pointer' }}>
                  {bulkMut.isPending ? 'Applying…' : 'Apply'}
                </button>
                <button onClick={() => setSelectedIds(new Set())}
                  style={{ fontSize: 12, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  Clear
                </button>
              </div>
            )}

            <div style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 10,
              overflow: 'hidden',
            }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface-2)' }}>
                    {canEdit && <th style={{ padding: '10px 8px 10px 16px', width: 32 }}></th>}
                    {['ID', 'Title', 'Status', 'Priority', 'Assignee', 'Created'].map((h) => (
                      <th key={h} style={{
                        padding: '10px 16px', textAlign: 'left',
                        fontSize: 11, color: 'var(--color-text-muted)',
                        fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((req) => (
                    <tr
                      key={req.id}
                      onClick={() => setSelectedRequestId(selectedRequestId === req.id ? null : req.id)}
                      style={{
                        borderBottom: '1px solid var(--color-border)',
                        cursor: 'pointer',
                        background: selectedRequestId === req.id ? 'var(--color-surface-2)' : 'transparent',
                        transition: 'background 0.1s',
                      }}
                      onMouseEnter={(e) => {
                        if (selectedRequestId !== req.id)
                          (e.currentTarget as HTMLTableRowElement).style.background = 'var(--color-surface-2)';
                      }}
                      onMouseLeave={(e) => {
                        if (selectedRequestId !== req.id)
                          (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                      }}
                    >
                      {canEdit && (
                        <td style={{ padding: '12px 8px 12px 16px', width: 32 }}
                          onClick={e => { e.stopPropagation(); toggleSelect(req.id); }}>
                          <input type="checkbox" checked={selectedIds.has(req.id)} readOnly />
                        </td>
                      )}
                      <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                        <span style={{
                          fontSize: 12, fontWeight: 700, fontFamily: 'monospace',
                          color: 'var(--color-primary)',
                        }}>
                          {ticketId(selectedProject!.key, req.ticketNumber)}
                        </span>
                      </td>
                      <td style={{ padding: '12px 16px', maxWidth: 280 }}>
                        <span style={{ fontWeight: 500, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {req.title}
                        </span>
                        {req.category && (
                          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{req.category}</span>
                        )}
                      </td>
                      <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                        <StatusBadge status={req.status} />
                      </td>
                      <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                        <PriorityBadge priority={req.priority} />
                      </td>
                      <td style={{ padding: '12px 16px', color: 'var(--color-text-muted)', fontSize: 13, whiteSpace: 'nowrap' }}>
                        {req.assigneeId
                          ? (memberMap[req.assigneeId] ?? `…${req.assigneeId.slice(-6)}`)
                          : <span style={{ opacity: 0.5 }}>Unassigned</span>
                        }
                      </td>
                      <td style={{ padding: '12px 16px', color: 'var(--color-text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {new Date(req.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}

                  {data.data.length === 0 && (
                    <tr>
                      <td colSpan={6} style={{ padding: 48, textAlign: 'center', color: 'var(--color-text-muted)' }}>
                        No requests match the current filters
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16 }}>
                <button
                  className="btn-ghost"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={page === 1}
                  style={{ padding: '5px 12px', fontSize: 13 }}
                >
                  ← Prev
                </button>
                <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                  Page {page} of {totalPages}
                </span>
                <button
                  className="btn-ghost"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= totalPages}
                  style={{ padding: '5px 12px', fontSize: 13 }}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Detail panel */}
      {selectedRequestId && selectedProject && (
        <RequestDetailPanel
          key={selectedRequestId}
          requestId={selectedRequestId}
          projectId={selectedProjectId}
          projectSlug={selectedProject.key}
          memberMap={memberMap}
          agentMembers={members ?? []}
          onClose={() => setSelectedRequestId(null)}
        />
      )}

      {/* New request modal */}
      {showNewModal && selectedProject && (
        <NewRequestModal
          project={selectedProject}
          onClose={() => setShowNewModal(false)}
        />
      )}
    </>
  );
}
