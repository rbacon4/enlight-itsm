import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard, Inbox, FolderKanban, BarChart3, Users, UserMinus, Settings,
  Sun, Moon, Monitor,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../lib/auth.js';
import { useBranding } from '../lib/branding.js';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme.js';

function ThemeSwitcher() {
  const [pref, setPref] = React.useState<ThemePref>(getThemePref());
  const opts: { val: ThemePref; Icon: LucideIcon; label: string }[] = [
    { val: 'light',  Icon: Sun,     label: 'Light' },
    { val: 'dark',   Icon: Moon,    label: 'Dark' },
    { val: 'system', Icon: Monitor, label: 'System' },
  ];
  const choose = (v: ThemePref) => { setThemePref(v); setPref(v); };
  return (
    <div style={{ padding: '10px 12px', borderTop: '1px solid var(--color-border)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-muted)', marginBottom: 6 }}>
        Theme
      </div>
      <div style={{ display: 'flex', gap: 3, background: 'var(--color-surface-2)', borderRadius: 8, padding: 3 }}>
        {opts.map(({ val, Icon, label }) => (
          <button
            key={val}
            onClick={() => choose(val)}
            title={label}
            aria-pressed={pref === val}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '5px 0', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: pref === val ? 'var(--color-primary)' : 'transparent',
              color: pref === val ? '#fff' : 'var(--color-text-muted)',
            }}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

const NAV_ITEMS: { to: string; label: string; icon: LucideIcon; perm?: string }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/requests', label: 'Requests', icon: Inbox },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/users', label: 'Users', icon: Users },
  { to: '/offboarding', label: 'Offboarding', icon: UserMinus, perm: 'offboarding.run' },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Layout() {
  const { user, logout, can } = useAuth();
  const { org } = useBranding();
  const brandName = org?.settings.brandName ?? org?.name ?? 'Enlight';
  const logoUrl = org?.settings.brandLogoUrl;

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* Sidebar */}
      <aside style={{
        width: 220,
        background: 'var(--color-surface)',
        borderRight: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        <div style={{ padding: '20px 16px 16px', borderBottom: '1px solid var(--color-border)' }}>
          {logoUrl && (
            <img
              src={logoUrl}
              alt={brandName}
              style={{ maxHeight: 32, maxWidth: 160, objectFit: 'contain', display: 'block', marginBottom: 6 }}
            />
          )}
          <div style={{ fontSize: logoUrl ? 13 : 18, fontWeight: 700, lineHeight: 1.2 }}>{brandName}</div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>ITSM Platform</div>
        </div>

        <nav style={{ flex: 1, padding: '8px 8px' }}>
          {NAV_ITEMS.filter((item) => !item.perm || can(item.perm)).map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                style={({ isActive }) => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 6,
                  color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
                  background: isActive ? 'var(--color-surface-2)' : 'transparent',
                  textDecoration: 'none',
                  marginBottom: 2,
                  fontSize: 14,
                  transition: 'all 0.1s',
                })}
              >
                <span style={{ width: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon size={17} strokeWidth={1.75} />
                </span>
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <ThemeSwitcher />

        {user && (
          <div style={{
            padding: 12,
            borderTop: '1px solid var(--color-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'var(--color-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 600,
              flexShrink: 0,
            }}>
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {user.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{user.globalRole}</div>
            </div>
            <button
              onClick={logout}
              style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 4, fontSize: 16 }}
              title="Sign out"
            >
              ⎋
            </button>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, overflow: 'auto', padding: 32 }}>
        <Outlet />
      </main>
    </div>
  );
}
