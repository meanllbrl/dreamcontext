// The CloudProvider fake (lane I points it at a local cloud-mode server): start/stop flip its
// state and call the hooks; a quota refusal throws; the template repo reports blob shas.
import { describe, it, expect } from 'vitest';
import { readTemplateFiles } from '../../src/lib/handsfree/laptop-env.js';
import { coresFor, FakeCloudProvider, gitBlobSha, ProviderQuotaError } from '../../src/lib/handsfree/provider.js';

describe('FakeCloudProvider', () => {
  it('create starts the machine; stop/start flip the state and call the hooks', async () => {
    const events: string[] = [];
    const p = new FakeCloudProvider({ url: 'http://127.0.0.1:9999/', onStart: (n) => { events.push(`start:${n}`); }, onStop: (n) => { events.push(`stop:${n}`); } });
    const m = await p.create({ machine: 'basicLinux32gb' });
    expect(m.url).toBe('http://127.0.0.1:9999');
    expect((await p.get(m.name))!.state).toBe('available');
    await p.stop(m.name);
    expect((await p.get(m.name))!.state).toBe('stopped');
    await p.start(m.name);
    await p.start(m.name); // already available: no second hook
    expect(events).toEqual([`start:${m.name}`, `stop:${m.name}`, `start:${m.name}`]);
    await p.delete(m.name);
    expect(await p.get(m.name)).toBeNull();
  });

  it('a quota refusal throws ProviderQuotaError and leaves the machine stopped', async () => {
    const p = new FakeCloudProvider({ url: 'http://x' });
    const m = await p.create({ machine: 'basicLinux32gb' });
    await p.stop(m.name);
    p.quotaRefusal = new ProviderQuotaError('used up', '2026-11-01T00:00:00.000Z');
    await expect(p.start(m.name)).rejects.toBeInstanceOf(ProviderQuotaError);
    expect((await p.get(m.name))!.state).toBe('stopped');
  });

  it('the template repo answers blob shas of what was written (null when absent)', async () => {
    const p = new FakeCloudProvider({ url: 'http://x' });
    const b = Buffer.from('x');
    await p.writeFiles({ 'a/b': b });
    expect(await p.blobShas(['a/b', 'c'])).toEqual({ 'a/b': gitBlobSha(b), c: null });
  });

  it('coresFor maps machine types (the laptop counts uptime in core-minutes)', () => {
    expect(coresFor('basicLinux32gb')).toBe(2);
    expect(coresFor('standardLinux32gb')).toBe(4);
    expect(coresFor('premiumLinux')).toBe(8);
    expect(coresFor('largePremiumLinux')).toBe(16);
  });
});

describe('template files', () => {
  it('the private repo gets every cloud/ file verbatim, supervisor.mjs included', () => {
    expect(Object.keys(readTemplateFiles()).sort()).toEqual([
      '.devcontainer/Dockerfile', '.devcontainer/devcontainer.json', '.devcontainer/entrypoint.sh',
      '.devcontainer/poststart.sh', '.devcontainer/stop-helper.sh', '.devcontainer/supervisor.mjs',
    ]);
  });
});
