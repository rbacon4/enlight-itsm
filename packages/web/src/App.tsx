import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.js';
import { BrandingProvider } from './lib/branding.js';
import { Layout } from './components/Layout.js';
import { LoginPage } from './pages/LoginPage.js';
import { AuthCallbackPage } from './pages/AuthCallbackPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { PortalPage } from './pages/PortalPage.js';
import { CsatPage } from './pages/CsatPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { RequestsPage } from './pages/RequestsPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage.js';
import { AnalyticsPage } from './pages/AnalyticsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { UsersPage } from './pages/UsersPage.js';
import { OffboardingPage } from './pages/OffboardingPage.js';
import { api } from './lib/api.js';

// ── Setup guard ────────────────────────────────────────────────────────────────
// On first load, probe /auth/setup-status. If the instance has never been
// initialised, redirect the browser to /setup before anything else renders.

function SetupGuard({ children }: { children: React.ReactNode }) {
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<{ needsSetup: boolean }>('/auth/setup-status')
      .then(({ needsSetup }) => {
        if (needsSetup) navigate('/setup', { replace: true });
        setNeedsSetup(needsSetup);
      })
      .catch(() => { /* network error — let the app render normally */ })
      .finally(() => setChecking(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (checking) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
        Loading…
      </div>
    );
  }

  if (needsSetup) return null; // navigation already fired
  return <>{children}</>;
}

// Inverse guard for the /setup route: once the instance is initialised the
// wizard must not render (the API also enforces this with a 409). Redirect a
// configured instance's /setup visitors to /login.
function SetupRoute() {
  const [checking, setChecking] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<{ needsSetup: boolean }>('/auth/setup-status')
      .then(({ needsSetup }) => {
        if (!needsSetup) navigate('/login', { replace: true });
        setAllowed(needsSetup);
      })
      .catch(() => setAllowed(true)) // network error — show the wizard rather than dead-end
      .finally(() => setChecking(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (checking) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
        Loading…
      </div>
    );
  }
  if (!allowed) return null; // navigation already fired
  return <SetupPage />;
}

// ── Protected routes ───────────────────────────────────────────────────────────

function ProtectedRoutes() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
        Loading…
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return (
    <BrandingProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="requests" element={<RequestsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:projectId" element={<ProjectSettingsPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="offboarding" element={<OffboardingPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="profile" element={<ProfilePage />} />
        </Route>
      </Routes>
    </BrandingProvider>
  );
}

// ── App root ───────────────────────────────────────────────────────────────────

export function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public routes — no setup check needed */}
        <Route path="/setup" element={<SetupRoute />} />
        <Route path="/portal/:token" element={<PortalPage />} />
        <Route path="/csat/:token" element={<CsatPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/login" element={<LoginPage />} />
        {/* Everything else: check setup first, then require auth */}
        <Route
          path="/*"
          element={
            <SetupGuard>
              <ProtectedRoutes />
            </SetupGuard>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
