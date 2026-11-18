import { createLocalBackend } from './local.js';
import { createRestBackend } from './rest.js';

export function createBackend(config, params) {
  const b = config.backend;
  if (b.type === 'rest' && b.url) return createRestBackend({ url: b.url });
  if (b.type === 'rest') console.warn('backend.type is "rest" but backend.url is empty; falling back to local storage');
  return createLocalBackend({ studyDefaults: config.studyDefaults, params });
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const ID_RE = /^[A-Za-z0-9._@+-]{2,64}$/;
