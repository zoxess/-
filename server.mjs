import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusterApiUrl, Connection, PublicKey } from '@solana/web3.js';
import QRCode from 'qrcode';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(root, 'public');
const events = new Map();
const tickets = new Map();
const port = Number(process.env.PORT ?? 4173);
const programId = String(process.env.GATEPROOF_PROGRAM_ID ?? '').trim();
const chainProgram = programId ? new PublicKey(programId) : null;
const chainConnection = chainProgram ? new Connection(clusterApiUrl('devnet'), 'confirmed') : null;

const hashToken = (value) => createHash('sha256').update(value).digest('hex');
const newTicketToken = () => randomBytes(32).toString('base64url');

function bytes32Hex(value, field) {
  const hex = String(value ?? '');
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error(`${field} must be 32 bytes encoded as hex.`);
  return Buffer.from(hex, 'hex');
}

function ticketToken(value) {
  const token = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Ticket token must be a 32-byte base64url value.');
  return token;
}

function accountKey(value) {
  try {
    return new PublicKey(String(value));
  } catch {
    throw new Error('Invalid Solana account address.');
  }
}

function deriveEventPda(organizer, eventId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('event'), accountKey(organizer).toBuffer(), eventId],
    chainProgram,
  )[0];
}

function deriveTicketPda(eventAddress, ticketId) {
  const event = accountKey(eventAddress);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('ticket'), event.toBuffer(), ticketId],
    chainProgram,
  )[0];
}

function transactionKeys(message) {
  if (message.staticAccountKeys) return message.staticAccountKeys;
  if (message.accountKeys) return message.accountKeys;
  return message.getAccountKeys().staticAccountKeys;
}

function isMessageSigner(message, accountIndex) {
  if (typeof message.isAccountSigner === 'function') return message.isAccountSigner(accountIndex);
  return accountIndex < (message.header?.numRequiredSignatures ?? 0);
}

async function verifyProgramTransaction(signature, requiredAccounts, signer) {
  if (!chainConnection || !chainProgram) throw new Error('Devnet program verification is not configured.');
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(String(signature ?? ''))) {
    throw new Error('A valid confirmed Devnet transaction signature is required.');
  }
  const tx = await chainConnection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta?.err) throw new Error('The Devnet transaction is missing or failed.');

  const message = tx.transaction.message;
  const keys = transactionKeys(message).map((key) => new PublicKey(key));
  const signerKey = accountKey(signer);
  const signerIndex = keys.findIndex((key) => key.equals(signerKey));
  if (signerIndex < 0 || !isMessageSigner(message, signerIndex)) {
    throw new Error('The expected organizer or gate did not sign this transaction.');
  }
  const required = requiredAccounts.map((address) => accountKey(address));
  const instructions = message.compiledInstructions ?? message.instructions ?? [];
  const hasExpectedInstruction = instructions.some((instruction) => {
    const programIndex = instruction.programIdIndex;
    if (!keys[programIndex]?.equals(chainProgram)) return false;
    const indexes = instruction.accountKeyIndexes ?? instruction.accounts ?? [];
    const accounts = indexes.map((index) => keys[index]);
    return required.every((key) => accounts.some((account) => account?.equals(key)));
  });
  if (!hasExpectedInstruction) throw new Error('The confirmed transaction does not contain the expected GateProof instruction.');
}

async function readProgramAccount(address, minimumLength) {
  if (!chainConnection || !chainProgram) throw new Error('Devnet program verification is not configured.');
  const account = await chainConnection.getAccountInfo(accountKey(address), 'confirmed');
  if (!account || !account.owner.equals(chainProgram) || account.data.length < minimumLength) {
    throw new Error('The expected GateProof account does not exist on Devnet.');
  }
  return account.data;
}

async function verifyChainEvent({ eventId, eventPda, organizerWallet, nameHash, capacity, signature }) {
  const id = bytes32Hex(eventId, 'chainEventId');
  const expectedPda = deriveEventPda(organizerWallet, id);
  if (!expectedPda.equals(accountKey(eventPda))) throw new Error('Event PDA does not match the organizer and event ID.');
  await verifyProgramTransaction(signature, [expectedPda], organizerWallet);
  const data = await readProgramAccount(expectedPda, 146);
  if (!new PublicKey(data.subarray(8, 40)).equals(accountKey(organizerWallet))
    || !data.subarray(72, 104).equals(id)
    || !data.subarray(104, 136).equals(nameHash)
    || data.readUInt32LE(136) !== capacity
    || data[144] !== 1) {
    throw new Error('The on-chain event state does not match the submitted event.');
  }
}

async function verifyChainTicket({ event, ticketId, ticketPda, holderCommitment, token, signature, signer, expectedState = 0 }) {
  const id = bytes32Hex(ticketId, 'chainTicketId');
  const commitment = bytes32Hex(holderCommitment, 'holderCommitment');
  const secret = ticketToken(token);
  if (!createHash('sha256').update(secret).digest().equals(commitment)) {
    throw new Error('The QR secret does not match the on-chain holder commitment.');
  }
  const expectedPda = deriveTicketPda(event.chainPda, id);
  if (!expectedPda.equals(accountKey(ticketPda))) throw new Error('Ticket PDA does not match the event and ticket ID.');
  await verifyProgramTransaction(signature, [accountKey(event.chainPda), expectedPda], signer);
  const data = await readProgramAccount(expectedPda, 106);
  if (!new PublicKey(data.subarray(8, 40)).equals(accountKey(event.chainPda))
    || !data.subarray(40, 72).equals(id)
    || !data.subarray(72, 104).equals(commitment)
    || data[104] !== expectedState) {
    throw new Error('The on-chain ticket state does not match the submitted ticket.');
  }
  return expectedPda;
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error('Request body is too large.');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function publicTicket(ticket) {
  return {
    id: ticket.id,
    eventId: ticket.eventId,
    status: ticket.status,
    transfers: ticket.transfers,
    qrDataUrl: ticket.qrDataUrl,
    token: ticket.token,
    createdAt: ticket.createdAt,
    chainTicketId: ticket.chainTicketId ?? null,
    chainPda: ticket.chainPda ?? null,
    holderCommitment: ticket.holderCommitment ?? null,
    lastSignature: ticket.lastSignature ?? null,
  };
}

function publicEvent(event) {
  const eventTickets = [...tickets.values()]
    .filter((ticket) => ticket.eventId === event.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    ...event,
    tickets: eventTickets.map(publicTicket),
    issued: eventTickets.length,
    checkedIn: eventTickets.filter((ticket) => ticket.status === 'checked_in').length,
  };
}

async function issueTicket(event, chain = {}) {
  const token = chain.token ? ticketToken(chain.token) : newTicketToken();
  const ticket = {
    id: randomBytes(16).toString('hex'),
    eventId: event.id,
    token,
    tokenHash: hashToken(token),
    status: 'issued',
    transfers: 0,
    createdAt: new Date().toISOString(),
    chainTicketId: chain.chainTicketId ?? null,
    chainPda: chain.chainPda ?? null,
    holderCommitment: chain.holderCommitment ?? null,
    lastSignature: chain.signature ?? null,
  };
  ticket.qrDataUrl = await QRCode.toDataURL(token, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
    color: { dark: '#101820', light: '#ffffff' },
  });
  tickets.set(ticket.id, ticket);
  return ticket;
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  if (req.method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      mode: programId ? 'devnet-configured' : 'local-demo',
      programId: programId || null,
      chain: programId ? 'Configured program id; deployment is checked by the browser' : 'Solana program source is present but no deployed program id is configured',
    });
  }

  if (req.method === 'GET' && path === '/api/events') {
    return sendJson(res, 200, { events: [...events.values()].map(publicEvent) });
  }

  if (req.method === 'POST' && path === '/api/events') {
    const body = await readJson(req);
    const title = String(body.title ?? '').trim();
    const venue = String(body.venue ?? '').trim();
    const date = String(body.date ?? '').trim();
    const capacity = Number(body.capacity);
    if (title.length < 3 || title.length > 80) {
      return sendJson(res, 400, { error: 'Название должно содержать от 3 до 80 символов.' });
    }
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 5000) {
      return sendJson(res, 400, { error: 'Укажите лимит от 1 до 5000 билетов.' });
    }
    if (body.chainPda) {
      if ([...events.values()].some((existing) => existing.chainPda === body.chainPda)) {
        return sendJson(res, 409, { error: 'Это on-chain событие уже привязано к другому событию демо.' });
      }
      await verifyChainEvent({
        eventId: body.chainEventId,
        eventPda: body.chainPda,
        organizerWallet: body.organizerWallet,
        nameHash: createHash('sha256').update(title).digest(),
        capacity,
        signature: body.createSignature,
      });
    }
    const event = {
      id: randomUUID(),
      title,
      venue: venue.slice(0, 100),
      date,
      capacity,
      createdAt: new Date().toISOString(),
      chainEventId: body.chainEventId ?? null,
      chainPda: body.chainPda ?? null,
      organizerWallet: body.organizerWallet ?? null,
      createSignature: body.createSignature ?? null,
    };
    events.set(event.id, event);
    return sendJson(res, 201, { event: publicEvent(event) });
  }

  const eventMatch = path.match(/^\/api\/events\/([\w-]+)$/);
  if (req.method === 'GET' && eventMatch) {
    const event = events.get(eventMatch[1]);
    return event
      ? sendJson(res, 200, { event: publicEvent(event) })
      : sendJson(res, 404, { error: 'Событие не найдено.' });
  }

  const issueMatch = path.match(/^\/api\/events\/([\w-]+)\/tickets$/);
  if (req.method === 'POST' && issueMatch) {
    const event = events.get(issueMatch[1]);
    if (!event) return sendJson(res, 404, { error: 'Событие не найдено.' });
    const issuedCount = [...tickets.values()].filter((ticket) => ticket.eventId === event.id).length;
    if (issuedCount >= event.capacity) return sendJson(res, 409, { error: 'Лимит билетов исчерпан.' });
    const body = await readJson(req);
    if (event.chainPda) {
      if ([...tickets.values()].some((existing) => existing.chainPda === body.chainPda)) {
        return sendJson(res, 409, { error: 'Этот on-chain билет уже привязан к событию демо.' });
      }
      await verifyChainTicket({
        event,
        ticketId: body.chainTicketId,
        ticketPda: body.chainPda,
        holderCommitment: body.holderCommitment,
        token: body.token,
        signature: body.signature,
        signer: event.organizerWallet,
      });
    }
    const ticket = await issueTicket(event, body);
    if (event.chainPda) {
      ticket.chainTicketId = body.chainTicketId;
      ticket.chainPda = body.chainPda;
      ticket.holderCommitment = body.holderCommitment;
    }
    return sendJson(res, 201, { ticket: publicTicket(ticket) });
  }

  const ticketAction = path.match(/^\/api\/tickets\/([a-f0-9]{32})\/(transfer|revoke)$/);
  if (req.method === 'POST' && ticketAction) {
    const body = await readJson(req);
    const ticket = tickets.get(ticketAction[1]);
    if (!ticket) return sendJson(res, 404, { error: 'Билет не найден.' });
    if (ticket.status !== 'issued') return sendJson(res, 409, { error: 'Изменить можно только активный билет.' });
    const action = ticketAction[2];
    const event = events.get(ticket.eventId);
    if (event?.chainPda) {
      if (action === 'transfer') {
        await verifyChainTicket({
          event,
          ticketId: ticket.chainTicketId,
          ticketPda: ticket.chainPda,
          holderCommitment: body.holderCommitment,
          token: body.token,
          signature: body.signature,
          signer: event.organizerWallet,
        });
      } else {
        await verifyChainTicket({
          event,
          ticketId: ticket.chainTicketId,
          ticketPda: ticket.chainPda,
          holderCommitment: ticket.holderCommitment,
          token: ticket.token,
          signature: body.signature,
          signer: event.organizerWallet,
          expectedState: 2,
        });
      }
    }
    if (action === 'revoke') {
      ticket.status = 'revoked';
      ticket.token = '';
      ticket.qrDataUrl = '';
      ticket.lastSignature = body.signature ?? ticket.lastSignature;
      return sendJson(res, 200, { ticket: publicTicket(ticket) });
    }
    const token = event?.chainPda ? ticketToken(body.token) : newTicketToken();
    ticket.token = token;
    ticket.tokenHash = hashToken(token);
    ticket.qrDataUrl = await QRCode.toDataURL(token, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
      color: { dark: '#101820', light: '#ffffff' },
    });
    ticket.transfers += 1;
    ticket.holderCommitment = body.holderCommitment ?? ticket.holderCommitment;
    ticket.lastSignature = body.signature ?? ticket.lastSignature;
    return sendJson(res, 200, { ticket: publicTicket(ticket) });
  }

  if (req.method === 'POST' && path === '/api/resolve-ticket') {
    const body = await readJson(req);
    const event = events.get(String(body.eventId ?? ''));
    const token = String(body.token ?? '');
    if (!event || token.length < 32 || token.length > 128) {
      return sendJson(res, 400, { valid: false, error: 'Проверьте QR-код и событие.' });
    }
    const digest = hashToken(token);
    const ticket = [...tickets.values()].find((item) => item.eventId === event.id && item.tokenHash === digest);
    if (!ticket) return sendJson(res, 404, { valid: false, error: 'Билет недействителен или код заменён.' });
    if (ticket.status !== 'issued') {
      return sendJson(res, 409, { valid: false, error: ticket.status === 'checked_in' ? 'Этот билет уже использован.' : 'Билет отозван.' });
    }
    return sendJson(res, 200, {
      valid: true,
      eventId: event.id,
      chainEventId: event.chainEventId,
      eventPda: event.chainPda,
      ticketId: ticket.id,
      chainTicketId: ticket.chainTicketId,
      ticketPda: ticket.chainPda,
      chainEnabled: Boolean(event.chainPda && ticket.chainPda),
    });
  }

  if (req.method === 'POST' && path === '/api/check-in') {
    const body = await readJson(req);
    const event = events.get(String(body.eventId ?? ''));
    const token = String(body.token ?? '');
    if (!event || token.length < 32 || token.length > 128) {
      return sendJson(res, 400, { accepted: false, error: 'Проверьте QR-код и событие.' });
    }
    const digest = hashToken(token);
    const ticket = [...tickets.values()].find((item) => item.eventId === event.id && item.tokenHash === digest);
    if (!ticket) return sendJson(res, 404, { accepted: false, error: 'Билет недействителен или код уже заменён.' });
    if (ticket.status === 'checked_in') return sendJson(res, 409, { accepted: false, error: 'Этот билет уже использован.' });
    if (ticket.status !== 'issued') return sendJson(res, 409, { accepted: false, error: 'Билет отозван.' });
    if (ticket.chainPda && !String(body.signature ?? '').trim()) {
      return sendJson(res, 400, { accepted: false, error: 'Для Devnet-билета сначала подтвердите транзакцию check-in.' });
    }
    if (ticket.chainPda) {
      const eventData = await readProgramAccount(event.chainPda, 146);
      const gateAuthority = new PublicKey(eventData.subarray(40, 72)).toBase58();
      await verifyChainTicket({
        event,
        ticketId: ticket.chainTicketId,
        ticketPda: ticket.chainPda,
        holderCommitment: ticket.holderCommitment,
        token,
        signature: body.signature,
        signer: gateAuthority,
        expectedState: 1,
      });
    }
    ticket.status = 'checked_in';
    ticket.token = '';
    ticket.qrDataUrl = '';
    ticket.lastSignature = body.signature ?? ticket.lastSignature;
    return sendJson(res, 200, { accepted: true, ticketId: ticket.id, message: 'Вход разрешён.' });
  }

  return sendJson(res, 404, { error: 'Маршрут не найден.' });
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function serveStatic(req, res, url) {
  const requestPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const safePath = normalize(requestPath).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : 'Не удалось обработать запрос.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`GateProof local demo: http://localhost:${typeof address === 'object' && address ? address.port : port}`);
});
