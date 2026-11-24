import assert from 'node:assert/strict';
import {
  createAgentHandleCapture,
  disposeLiveSessionsForTrash,
} from '../lib/index.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    → ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fakeLifecycle(id, { dispose, status = 'idle' } = {}) {
  const agent = { id, status };
  const session = { id, header: { id } };
  const agents = new Map([[id, agent]]);
  const sessions = new Map([[id, session]]);
  const handle = {
    agent,
    calls: 0,
    async dispose() {
      this.calls++;
      if (dispose) return await dispose({ id, agent, session, agents, sessions });
      agents.delete(id);
      sessions.delete(id);
    }
  };
  return { id, agent, session, agents, sessions, handle };
}

console.log('force delete: official AgentHandle lifecycle');
try {
  await test('captures createAgent and resume handles and restores wrappers without disposing', async () => {
    const created = { agent: { id: 'created' }, dispose: async () => { throw new Error('must not dispose on uninstall'); } };
    const resumed = { agent: { id: 'resumed' }, dispose: async () => { throw new Error('must not dispose on uninstall'); } };
    const originalCreate = async () => created;
    const originalResume = async () => resumed;
    const agentLoop = { createAgent: originalCreate, resume: originalResume };
    const capture = createAgentHandleCapture();
    const restore = capture.install(agentLoop);
    assert.equal(await agentLoop.createAgent({ sessionId: 'created' }), created);
    assert.equal(await agentLoop.resume({ resumeSessionId: 'resumed' }), resumed);
    assert.equal(capture.handles.get('created'), created);
    assert.equal(capture.handles.get('resumed'), resumed);
    restore();
    assert.equal(agentLoop.createAgent, originalCreate);
    assert.equal(agentLoop.resume, originalResume);
    assert.equal(capture.handles.size, 0);
  });

  await test('restore deactivates capture under an outer wrapper and restores prototype descriptors', async () => {
    const handle = { agent: { id: 'outer' }, dispose: async () => {} };
    const original = async function () { return handle; };
    class Loop {}
    Loop.prototype.createAgent = original;
    Loop.prototype.resume = original;
    const agentLoop = new Loop();
    const capture = createAgentHandleCapture();
    const restore = capture.install(agentLoop);
    const innerCreate = agentLoop.createAgent;
    const outerCreate = async function (...args) { return await innerCreate.apply(this, args); };
    agentLoop.createAgent = outerCreate;
    restore();
    assert.equal(agentLoop.createAgent, outerCreate, 'outer wrapper must remain installed');
    await agentLoop.createAgent();
    assert.equal(capture.handles.size, 0, 'inactive inner wrapper must not repopulate handles');
    agentLoop.createAgent = innerCreate;
    restore();
    assert.equal(Object.hasOwn(agentLoop, 'createAgent'), false, 'prototype method must be revealed again');
    assert.equal(agentLoop.createAgent, original);
  });

  await test('cold sessions need no handle and are skipped', async () => {
    const capture = createAgentHandleCapture();
    const result = await disposeLiveSessionsForTrash(['cold'], {
      agents: new Map(), sessions: new Map(), capture,
    });
    assert.deepEqual(result, []);
  });

  await test('disposes child before parent through official handles', async () => {
    const child = fakeLifecycle('child');
    const parent = fakeLifecycle('parent');
    const agents = new Map([...child.agents, ...parent.agents]);
    const sessions = new Map([...child.sessions, ...parent.sessions]);
    const capture = createAgentHandleCapture();
    capture.handles.set('child', child.handle);
    capture.handles.set('parent', parent.handle);
    const order = [];
    for (const [item, id] of [[child, 'child'], [parent, 'parent']]) {
      item.handle.dispose = async () => {
        order.push(id);
        agents.delete(id);
        sessions.delete(id);
      };
    }
    const result = await disposeLiveSessionsForTrash(['child', 'parent'], { agents, sessions, capture });
    assert.deepEqual(order, ['child', 'parent']);
    assert.deepEqual(result.map(row => row.sessionId), ['child', 'parent']);
    assert.equal(result[0].session, child.session);
    assert.equal(result[1].session, parent.session);
    assert.equal(capture.handles.size, 0);
  });

  await test('missing child handle rejects before disposing parent', async () => {
    const child = fakeLifecycle('child');
    const parent = fakeLifecycle('parent');
    const agents = new Map([...child.agents, ...parent.agents]);
    const sessions = new Map([...child.sessions, ...parent.sessions]);
    const capture = createAgentHandleCapture();
    capture.handles.set('parent', parent.handle);
    await assert.rejects(
      disposeLiveSessionsForTrash(['child', 'parent'], { agents, sessions, capture }),
      error => error.code === 'live-handle-unavailable' && /child/.test(error.message)
    );
    assert.equal(parent.handle.calls, 0);
    assert.equal(agents.size, 2);
  });

  await test('identity mismatch is rejected before any disposal', async () => {
    const item = fakeLifecycle('target');
    const capture = createAgentHandleCapture();
    capture.handles.set('target', { agent: { id: 'other' }, dispose: async () => {} });
    await assert.rejects(
      disposeLiveSessionsForTrash(['target'], { agents: item.agents, sessions: item.sessions, capture }),
      error => error.code === 'live-handle-unavailable'
    );
    assert.equal(item.agents.size, 1);
  });

  await test('official dispose rejection keeps the handle and stops the family', async () => {
    const child = fakeLifecycle('child', { dispose: async () => { throw new Error('injected dispose failure'); } });
    const parent = fakeLifecycle('parent');
    const agents = new Map([...child.agents, ...parent.agents]);
    const sessions = new Map([...child.sessions, ...parent.sessions]);
    const capture = createAgentHandleCapture();
    capture.handles.set('child', child.handle);
    capture.handles.set('parent', parent.handle);
    await assert.rejects(
      disposeLiveSessionsForTrash(['child', 'parent'], { agents, sessions, capture }),
      error => error.code === 'force-dispose-failed' && /injected dispose failure/.test(error.message)
    );
    assert.equal(parent.handle.calls, 0);
    assert.equal(capture.handles.get('child'), child.handle);
  });

  await test('timeout fails closed and retains the handle', async () => {
    const item = fakeLifecycle('slow', { dispose: () => new Promise(() => {}) });
    const capture = createAgentHandleCapture();
    capture.handles.set('slow', item.handle);
    await assert.rejects(
      disposeLiveSessionsForTrash(['slow'], { agents: item.agents, sessions: item.sessions, capture, timeoutMs: 5 }),
      error => error.code === 'lifecycle-check-failed' && /超时/.test(error.message)
    );
    assert.equal(capture.handles.get('slow'), item.handle);
  });

  await test('retry after timeout joins the same in-flight official dispose', async () => {
    const item = fakeLifecycle('slow-retry', {
      dispose: ({ agents, sessions }) => new Promise(resolve => setTimeout(() => { agents.delete('slow-retry'); sessions.delete('slow-retry'); resolve(); }, 20))
    });
    const capture = createAgentHandleCapture();
    capture.handles.set('slow-retry', item.handle);
    await assert.rejects(
      disposeLiveSessionsForTrash(['slow-retry'], { agents: item.agents, sessions: item.sessions, capture, timeoutMs: 5 }),
      error => error.code === 'lifecycle-check-failed'
    );
    const result = await disposeLiveSessionsForTrash(['slow-retry'], { agents: item.agents, sessions: item.sessions, capture, timeoutMs: 100 });
    assert.deepEqual(result.map(row => row.sessionId), ['slow-retry']);
    assert.equal(item.handle.calls, 1, 'retry must reuse the same official dispose promise');
  });

  await test('registry still live after dispose is rejected', async () => {
    const item = fakeLifecycle('zombie', { dispose: async () => {} });
    const capture = createAgentHandleCapture();
    capture.handles.set('zombie', item.handle);
    await assert.rejects(
      disposeLiveSessionsForTrash(['zombie'], { agents: item.agents, sessions: item.sessions, capture }),
      error => error.code === 'lifecycle-check-failed' && /仍为 live/.test(error.message)
    );
    assert.equal(capture.handles.get('zombie'), item.handle);
  });
} finally {
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}
