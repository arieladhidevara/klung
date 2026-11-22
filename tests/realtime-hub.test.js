import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Supabase Realtime waits for both channel join acknowledgments', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const sent = [];
  let readyCalls = 0;

  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      });
    }
    send(json) {
      const packet = JSON.parse(json);
      sent.push(packet);
      if (packet.event === 'phx_join') {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
          topic: packet.topic,
          event: 'phx_reply',
          ref: packet.ref,
          join_ref: packet.join_ref,
          payload: { status: 'ok', response: {} }
        }) }));
      }
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async () => ({ ok: true });
  let hub;
  try {
    const text = await readFile(new URL('../src/realtime-hub.js', import.meta.url), 'utf8');
    const env = '({ VITE_KLUNG_SUPABASE_URL: "https://example.supabase.co", VITE_KLUNG_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" })';
    const source = text.replaceAll('import.meta.env', env);
    const { createRealtimeHub } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

    hub = createRealtimeHub({
      code: 'TESTROOM', clientId: 'master-1', role: 'master',
      onReady: () => { readyCalls++; }
    });
    await hub.firstConnection;

    const joins = sent.filter(packet => packet.event === 'phx_join');
    assert.equal(joins.length, 2);
    assert.equal(readyCalls, 1);
    assert.equal(hub.connected(), true);
    assert.notEqual(joins[0].ref, joins[1].ref);
    assert.equal(joins[0].join_ref !== undefined, true);
    assert.equal(joins[1].join_ref !== undefined, true);

    assert.equal(hub.send('transport', { sequence: 1 }), true);
    assert.ok(sent.some(packet => packet.event === 'broadcast'));
  } finally {
    hub?.close();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
  }
});
