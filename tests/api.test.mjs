import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, test } from 'node:test';

let processHandle;
let baseUrl;

before(async () => {
  processHandle = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const started = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 8_000);
    processHandle.stdout.setEncoding('utf8');
    processHandle.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    processHandle.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    processHandle.once('exit', (code) => {
      if (!output.includes('GateProof local demo')) {
        clearTimeout(timeout);
        reject(new Error(`Server exited before starting (${code}): ${output}`));
      }
    });
  });
  const port = await started;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (processHandle && processHandle.exitCode === null) {
    processHandle.kill();
    await once(processHandle, 'exit').catch(() => {});
  }
});

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test('tickets are issued with QR, can transfer, and only check in once', async () => {
  const health = await request('/api/health');
  assert.equal(health.data.mode, 'local-demo');

  const created = await request('/api/events', {
    title: 'Open Air Demo', venue: 'Almaty', date: '2026-10-10', capacity: 2,
  });
  assert.equal(created.response.status, 201);
  const event = created.data.event;

  const issued = await request(`/api/events/${event.id}/tickets`, {});
  assert.equal(issued.response.status, 201);
  assert.match(issued.data.ticket.qrDataUrl, /^data:image\/png;base64,/);
  const firstToken = issued.data.ticket.token;

  const transferred = await request(`/api/tickets/${issued.data.ticket.id}/transfer`, {});
  assert.equal(transferred.response.status, 200);
  assert.notEqual(transferred.data.ticket.token, firstToken);

  const oldCode = await request('/api/check-in', { eventId: event.id, token: firstToken });
  assert.equal(oldCode.response.status, 404);

  const accepted = await request('/api/check-in', { eventId: event.id, token: transferred.data.ticket.token });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.data.accepted, true);

  const duplicate = await request('/api/check-in', { eventId: event.id, token: transferred.data.ticket.token });
  assert.equal(duplicate.response.status, 409);
});

test('event capacity and revoked tickets are enforced by the demo API', async () => {
  const created = await request('/api/events', { title: 'Small Room', capacity: 1 });
  const event = created.data.event;
  const ticket = await request(`/api/events/${event.id}/tickets`, {});

  const overCapacity = await request(`/api/events/${event.id}/tickets`, {});
  assert.equal(overCapacity.response.status, 409);

  const revoked = await request(`/api/tickets/${ticket.data.ticket.id}/revoke`, {});
  assert.equal(revoked.data.ticket.status, 'revoked');

  const scan = await request('/api/check-in', { eventId: event.id, token: ticket.data.ticket.token });
  assert.equal(scan.response.status, 409);
});
