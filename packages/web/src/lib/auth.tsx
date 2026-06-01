import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getToken, setToken, clearToken, api } from './api.js';
import type { GlobalRole } from '@enlight/shared';

interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  globalRole: GlobalRole;
  /** Resolved global permissions (from /users/me). */
  permissions?: string[];
}

interface AuthContext {
  user: AuthUser | null;
  isLoading: boolean;
  login: (token: string) => void;
  logout: () => void;
  /** True if the current user has the given global permission. */
  can: (perm: string) => boolean;
}

const Ctx = createContext<AuthContext>({
  user: null,
  isLoading: true,
  login: () => {},
  logout: () => {},
  can: () => false,
});

function decodeToken(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!)) as AuthUser & { exp: number };
    if (payload.exp * 1000 > Date.now()) return payload;
    return null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Pull the live user (incl. resolved permissions) from the API so role/
  // permission changes take effect without re-login.
  const refreshMe = useCallback(async () => {
    try {
      const me = await api.get<AuthUser>('/users/me');
      setUser((prev) => ({ ...(prev ?? me), ...me }));
    } catch {
      /* token decode already populated identity; ignore */
    }
  }, []);

  useEffect(() => {
    const token = getToken();
    if (token) {
      const decoded = decodeToken(token);
      if (decoded) {
        setUser(decoded);
        void refreshMe();
      } else clearToken();
    }
    setIsLoading(false);
  }, [refreshMe]);

  const login = (token: string) => {
    setToken(token);
    const decoded = decodeToken(token);
    if (decoded) setUser(decoded);
    void refreshMe();
  };

  const logout = () => {
    clearToken();
    setUser(null);
    window.location.href = '/login';
  };

  const can = useCallback(
    (perm: string) => Boolean(user?.permissions?.includes(perm)),
    [user],
  );

  return <Ctx.Provider value={{ user, isLoading, login, logout, can }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
