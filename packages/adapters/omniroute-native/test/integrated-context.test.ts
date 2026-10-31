import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearModelContextCache, loadRemoteModelContext, findLocalModelContext } from '../src/shared/context-window.js';

let home: string;
beforeEach(async () => {
  clearModelContextCache();
  home = await mkdtemp(path.join(os.tmpdir(), 'integrated-context-'));
  vi.stubEnv('PAPERCLIP_HOME', home);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearModelContextCache();
  await rm(home, { recursive: true, force: true });
});

describe('R4 — combo context is discovered, never a private universal assumption', () => {
  it.each(['AC-pro-coding', 'AC-main', 'AC-fast', 'auto/best-coding'])('discovers %s and falls back conservatively when offline', async (model) => {
    expect(findLocalModelContext(model)).toBeNull();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ context_length: 48_000 })));
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadRemoteModelContext('http://gateway.test', 'test-key', model)).contextTokens).toBe(48_000);
    expect(fetchMock).toHaveBeenCalled();
    clearModelContextCache();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const fallback = await loadRemoteModelContext('http://other-gateway.test', 'test-key', model);
    expect(fallback).toMatchObject({ source: 'default_fallback', contextTokens: 128_000 });
  });
});

describe('R5 — memory context cache isolation and expiry', () => {
  it.each(['expired', 'missing timestamp', 'future timestamp', 'invalid tokens', 'legacy', 'different credential', 'different gateway'])('does not trust a disk entry with %s', async (variant) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ context_length: 48_000 }))));
    await loadRemoteModelContext('http://a.test', 'key-a', 'disk-model');
    const file = path.join(home, 'adapter-data/omniroute-native/context-cache.json');
    const cache = JSON.parse(await readFile(file, 'utf8'));
    expect(JSON.stringify(cache)).not.toContain('key-a');
    if (variant === 'expired') cache.specs['disk-model'].fetchedAt = Date.now() - 3_600_001;
    if (variant === 'missing timestamp') delete cache.specs['disk-model'].fetchedAt;
    if (variant === 'future timestamp') cache.specs['disk-model'].fetchedAt = Date.now() + 60_000;
    if (variant === 'invalid tokens') cache.specs['disk-model'].contextTokens = -1;
    if (variant === 'legacy') delete cache.version;
    await writeFile(file, JSON.stringify(cache));
    clearModelContextCache();
    const refresh = vi.fn(async () => new Response(JSON.stringify({ context_length: 24_000 })));
    vi.stubGlobal('fetch', refresh);
    const gateway = variant === 'different gateway' ? 'http://b.test' : 'http://a.test';
    const key = variant === 'different credential' ? 'key-b' : 'key-a';
    expect((await loadRemoteModelContext(gateway, key, 'disk-model')).contextTokens).toBe(24_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reuses a fresh scoped disk entry after clearing memory', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ context_length: 48_000 }))));
    await loadRemoteModelContext('http://a.test', 'key-a', 'disk-model');
    clearModelContextCache();
    const offline = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', offline);
    expect(await loadRemoteModelContext('http://a.test/', 'key-a', 'disk-model')).toMatchObject({ source: 'disk_cache', contextTokens: 48_000 });
    expect(offline).not.toHaveBeenCalled();
  });

  it('does not reuse a model context across gateways or credentials', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ context_length: 48_000 })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ context_length: 64_000 })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ context_length: 96_000 })));
    vi.stubGlobal('fetch', fetchMock);
    expect((await loadRemoteModelContext('http://a.test', 'key-a', 'tenant-model')).contextTokens).toBe(48_000);
    expect((await loadRemoteModelContext('http://b.test', 'key-a', 'tenant-model')).contextTokens).toBe(64_000);
    expect((await loadRemoteModelContext('http://b.test', 'key-b', 'tenant-model')).contextTokens).toBe(96_000);
    expect((await loadRemoteModelContext('http://a.test/', 'key-a', 'tenant-model')).contextTokens).toBe(48_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refreshes memory entries after one hour instead of trusting them indefinitely', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ context_length: 48_000 }))));
      await loadRemoteModelContext('http://a.test', 'key', 'expiring-model');
      clock.mockReturnValue(1_800_000_000_000 + 3_600_001);
      const refresh = vi.fn(async () => new Response(JSON.stringify({ context_length: 24_000 })));
      vi.stubGlobal('fetch', refresh);
      expect((await loadRemoteModelContext('http://a.test', 'key', 'expiring-model')).contextTokens).toBe(24_000);
      expect(refresh).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });
});
