import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import type { OrgDetails } from '@enlight/shared';

interface BrandingCtx {
  org: OrgDetails | null;
  refetch: () => void;
}

const Ctx = createContext<BrandingCtx>({ org: null, refetch: () => {} });

/** Darken a #rrggbb hex color by `amount` (0–1). */
export function darken(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) * (1 - amount)));
  const g = Math.max(0, Math.round(((n >> 8) & 0xff) * (1 - amount)));
  const b = Math.max(0, Math.round((n & 0xff) * (1 - amount)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Apply org branding (color, page title) to the document. */
export function applyBranding(settings: OrgDetails['settings'], name: string): void {
  const root = document.documentElement;
  const color = settings.brandPrimaryColor;
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
    root.style.setProperty('--color-primary', color);
    root.style.setProperty('--color-primary-hover', darken(color, 0.15));
  }
  const brand = settings.brandName ?? name;
  if (brand) document.title = brand;
}

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [org, setOrg] = useState<OrgDetails | null>(null);

  const refetch = useCallback(() => {
    api.get<OrgDetails>('/org')
      .then((data) => {
        setOrg(data);
        applyBranding(data.settings, data.name);
      })
      .catch(() => {/* auth errors handled in api.ts */});
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  return <Ctx.Provider value={{ org, refetch }}>{children}</Ctx.Provider>;
}

export const useBranding = () => useContext(Ctx);
