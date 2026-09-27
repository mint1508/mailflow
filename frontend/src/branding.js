import { useEffect, useState } from 'react';

export const DEFAULT_BRANDING = { name: 'MailFlow', shortName: 'MailFlow', logo: null };
let currentBranding = { ...DEFAULT_BRANDING };
const listeners = new Set();

export function getBranding() { return currentBranding; }

export function setBranding(next) {
  currentBranding = {
    name: next?.name || DEFAULT_BRANDING.name,
    shortName: next?.shortName || DEFAULT_BRANDING.shortName,
    logo: next?.logo || null,
  };
  if (typeof document !== 'undefined') applyBrandingToDocument(currentBranding);
  listeners.forEach(listener => listener(currentBranding));
  return currentBranding;
}

export function subscribeBranding(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBranding() {
  const [, rerender] = useState(0);
  useEffect(() => subscribeBranding(() => rerender(value => value + 1)), []);
  return currentBranding;
}

export async function loadBranding() {
  try {
    const response = await fetch('/api/branding', { credentials: 'include' });
    if (!response.ok) throw new Error('Branding request failed');
    const data = await response.json();
    return setBranding(data.branding);
  } catch {
    return currentBranding;
  }
}

export function applyBrandingToDocument(branding) {
  if (typeof document === 'undefined') return;
  document.title = branding.name;
  document.querySelector('meta[name="description"]')?.setAttribute('content', `${branding.name} — your unified inbox`);
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', branding.shortName);
  document.querySelector('link[rel="manifest"]')?.setAttribute('href', '/api/branding/manifest.json');
  document.querySelector('link[rel="icon"]')?.setAttribute('href', branding.logo ? '/api/branding/logo' : '/favicon.svg');
  document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', branding.logo ? '/api/branding/logo' : '/icon-512.png');
}
