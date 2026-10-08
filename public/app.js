import { clusterApiUrl, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

const $ = (selector, root = document) => root.querySelector(selector);
const eventsList = $('#events-list');
const eventCount = $('#event-count');
const eventForm = $('#event-form');
const scanForm = $('#scan-form');
const scanEvent = $('#scan-event');
const scanToken = $('#scan-token');
const scanResult = $('#scan-result');
const toast = $('#toast');
let events = [];
let toastTimer;
let cameraStream;
let cameraFrame;
let walletProvider;
let walletAddress = '';
let chainProgram;
let chainConnection;
let chainReady = false;
const walletButton = $('#wallet-button');
const demoNotice = $('.demo-notice p');

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Не удалось выполнить действие.');
  return data;
}

function hexToBytes(hex) {
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('Некорректный идентификатор Solana.');
  return Uint8Array.from(hex.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function encodeBase58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = BigInt(`0x${bytesToHex(bytes)}`);
  let encoded = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = alphabet[remainder] + encoded;
    number /= 58n;
  }
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  return `${'1'.repeat(leadingZeros)}${encoded}` || '1';
}

function uint32Le(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function random32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomToken() {
  return btoa(String.fromCharCode(...random32()))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function sha256(value) {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

async function anchorInstruction(name, args, keys) {
  const discriminator = (await sha256(`global:${name}`)).slice(0, 8);
  const chunks = [discriminator, ...args.map((arg) => new Uint8Array(arg))];
  const data = concatBytes(...chunks);
  return new TransactionInstruction({ programId: chainProgram, keys, data });
}

async function sendAnchor(instruction) {
  if (!chainReady || !chainProgram || !chainConnection) {
    throw new Error('Devnet-программа не настроена. Сейчас доступно локальное демо.');
  }
  if (!walletProvider?.publicKey) throw new Error('Сначала подключите кошелёк организатора в сети Devnet.');
  const recent = await chainConnection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: walletProvider.publicKey,
    recentBlockhash: recent.blockhash,
  }).add(instruction);
  const result = await walletProvider.signAndSendTransaction(transaction);
  const signature = typeof result.signature === 'string' ? result.signature : encodeBase58(result.signature);
  await chainConnection.confirmTransaction({ signature, ...recent }, 'confirmed');
  return signature;
}

async function initializeChain(health) {
  if (!health.programId) {
    $('#chain-status').textContent = 'Локальное демо';
    $('#chain-detail').textContent = 'Anchor-программа ещё не настроена';
    return;
  }
  chainProgram = new PublicKey(health.programId);
  chainConnection = new Connection(clusterApiUrl('devnet'), 'confirmed');
  $('#chain-status').textContent = 'Проверка Devnet';
  $('#chain-detail').textContent = `программа ${chainProgram.toBase58().slice(0, 8)}…`;
  try {
    const programAccount = await chainConnection.getAccountInfo(chainProgram, 'confirmed');
    chainReady = Boolean(programAccount?.executable);
    if (chainReady) {
      $('#chain-status').textContent = 'Программа в Devnet';
      $('#chain-detail').textContent = `gateproof · ${chainProgram.toBase58().slice(0, 8)}…`;
      demoNotice.innerHTML = '<b>Режим прототипа.</b> Программа доступна в Devnet. Сервер пока хранит QR-секреты и локальную копию данных; перед реальными продажами нужна проверка транзакций сервером.';
    } else {
      $('#chain-status').textContent = 'Ожидает деплоя';
      $('#chain-detail').textContent = 'настройте адрес программы после Anchor deploy';
    }
  } catch {
    $('#chain-status').textContent = 'Devnet недоступен';
    $('#chain-detail').textContent = 'локальное демо продолжает работать';
  }
}

function walletLabel() {
  if (walletAddress) return `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`;
  return 'Подключить кошелёк';
}

walletButton.addEventListener('click', async () => {
  const provider = window.phantom?.solana ?? window.solana;
  if (!provider) {
    notify('Установите совместимый кошелёк Solana, чтобы подписывать транзакции Devnet.');
    return;
  }
  try {
    const response = await provider.connect();
    walletProvider = provider;
    walletAddress = response.publicKey.toString();
    walletButton.textContent = walletLabel();
    walletButton.classList.add('wallet-connected');
    if (chainReady) {
      const walletBalance = await chainConnection.getBalance(provider.publicKey, 'confirmed');
      if (walletBalance === 0) notify('Подключено. Для Devnet-транзакций пополните тестовый кошелёк Devnet SOL.');
      else notify('Кошелёк подключён к Devnet.');
    } else {
      notify('Кошелёк подключён. Создание билетов остаётся в локальном демо до деплоя программы.');
    }
  } catch {
    notify('Подключение кошелька отменено или не удалось.');
  }
});

window.addEventListener('load', () => {
  const provider = window.phantom?.solana ?? window.solana;
  provider?.on?.('disconnect', () => {
    walletProvider = undefined;
    walletAddress = '';
    walletButton.textContent = walletLabel();
    walletButton.classList.remove('wallet-connected');
  });
});

function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function statusLabel(status) {
  return ({ issued: 'активен', checked_in: 'вошёл', revoked: 'отозван' })[status] ?? status;
}

function formatDate(value) {
  if (!value) return 'Дата не указана';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(date);
}

function render() {
  eventCount.textContent = String(events.length);
  const current = scanEvent.value;
  scanEvent.innerHTML = events.length
    ? events.map((event) => `<option value="${escapeHtml(event.id)}">${escapeHtml(event.title)}</option>`).join('')
    : '<option value="">Сначала создайте событие</option>';
  if (events.some((event) => event.id === current)) scanEvent.value = current;

  if (!events.length) {
    eventsList.innerHTML = '<div class="empty-state"><div class="empty-icon">◇</div><b>Пока нет событий</b><span>Создайте первое — здесь появится управление билетами.</span></div>';
    return;
  }

  eventsList.innerHTML = events.map((event) => `
    <article class="event-card" data-event="${escapeHtml(event.id)}">
      <div class="event-card-header">
        <div><h4>${escapeHtml(event.title)}</h4><div class="event-meta">${escapeHtml(event.venue || 'Площадка не указана')} · ${escapeHtml(formatDate(event.date))}</div></div>
        <div class="event-counter">${event.issued} / ${event.capacity}</div>
      </div>
      <div class="event-card-actions">
        <button class="small-button" data-action="issue" data-event-id="${escapeHtml(event.id)}" ${event.issued >= event.capacity ? 'disabled' : ''}>＋ Выдать тестовый билет</button>
        <span class="event-counter">${event.checkedIn} вошли</span>
      </div>
      ${event.tickets.length ? `<div class="ticket-list">${event.tickets.map((ticket, index) => `
        <div class="ticket-row">
          ${ticket.qrDataUrl ? `<img class="ticket-qr" src="${ticket.qrDataUrl}" alt="QR билета ${index + 1}" />` : '<div class="ticket-qr qr-placeholder">×</div>'}
          <div class="ticket-info"><b>GP-${escapeHtml(ticket.id.slice(0, 8).toUpperCase())}</b><small>${escapeHtml(ticket.transfers ? `Передач: ${ticket.transfers}` : 'Тестовый билет')}</small></div>
          <span class="state-pill ${escapeHtml(ticket.status)}">${escapeHtml(statusLabel(ticket.status))}</span>
          ${ticket.status === 'issued' ? `<div class="ticket-actions"><button class="small-button" data-action="copy" data-ticket-id="${escapeHtml(ticket.id)}">Скопировать код</button><button class="small-button" data-action="transfer" data-ticket-id="${escapeHtml(ticket.id)}">Передать</button><button class="small-button small-button-danger" data-action="revoke" data-ticket-id="${escapeHtml(ticket.id)}">Отозвать</button></div>` : '<div class="ticket-actions"></div>'}
        </div>`).join('')}</div>` : '<div class="empty-state event-empty"><div class="empty-icon">⌁</div><b>Билетов пока нет</b><span>Выдайте тестовый билет, чтобы проверить вход.</span></div>'}
    </article>`).join('');
}

async function refresh() {
  const data = await api('/api/events');
  events = data.events;
  render();
}

eventForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('button[type="submit"]', eventForm);
  submit.disabled = true;
  try {
    const form = new FormData(eventForm);
    const title = String(form.get('title') ?? '').trim();
    const capacity = Number(form.get('capacity'));
    let chainData = {};
    if (chainReady) {
      if (!walletProvider?.publicKey) throw new Error('Для события в Devnet подключите кошелёк организатора.');
      const eventId = random32();
      const nameHash = await sha256(title);
      const capacityBytes = uint32Le(capacity);
      const [eventPda] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode('event'), walletProvider.publicKey.toBytes(), eventId],
        chainProgram,
      );
      const instruction = await anchorInstruction('create_event', [eventId, nameHash, capacityBytes], [
        { pubkey: walletProvider.publicKey, isSigner: true, isWritable: true },
        { pubkey: eventPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ]);
      const signature = await sendAnchor(instruction);
      chainData = {
        chainEventId: bytesToHex(eventId),
        chainPda: eventPda.toBase58(),
        organizerWallet: walletProvider.publicKey.toBase58(),
        createSignature: signature,
      };
    }
    const result = await api('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        title,
        venue: form.get('venue'),
        date: form.get('date'),
        capacity,
        ...chainData,
      }),
    });
    eventForm.reset();
    $('input[name="capacity"]', eventForm).value = '50';
    await refresh();
    scanEvent.value = result.event.id;
    notify(chainData.createSignature ? 'Транзакция создания события подтверждена в Devnet.' : 'Событие создано в локальном демо.');
  } catch (error) {
    notify(error.message);
  } finally {
    submit.disabled = false;
  }
});

eventsList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  button.disabled = true;
  try {
    if (action === 'issue') {
      const eventData = events.find((item) => item.id === button.dataset.eventId);
      let chainData = {};
      if (eventData?.chainPda) {
        if (!chainReady) throw new Error('Событие в Devnet, но программа сейчас недоступна. Проверьте её адрес и RPC.');
        if (!walletProvider?.publicKey) throw new Error('Подключите кошелёк организатора для выпуска on-chain билета.');
        const ticketId = random32();
        const token = randomToken();
        const holderCommitment = await sha256(token);
        const eventPda = new PublicKey(eventData.chainPda);
        const [ticketPda] = PublicKey.findProgramAddressSync(
          [new TextEncoder().encode('ticket'), eventPda.toBytes(), ticketId],
          chainProgram,
        );
        const instruction = await anchorInstruction('issue_ticket', [ticketId, holderCommitment], [
          { pubkey: walletProvider.publicKey, isSigner: true, isWritable: true },
          { pubkey: eventPda, isSigner: false, isWritable: true },
          { pubkey: ticketPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]);
        const signature = await sendAnchor(instruction);
        chainData = {
          chainTicketId: bytesToHex(ticketId),
          holderCommitment: bytesToHex(holderCommitment),
          chainPda: ticketPda.toBase58(),
          token,
          signature,
        };
      }
      const result = await api(`/api/events/${button.dataset.eventId}/tickets`, {
        method: 'POST', body: JSON.stringify(chainData),
      });
      await refresh();
      scanEvent.value = result.ticket.eventId;
      scanToken.value = result.ticket.token;
      notify(chainData.signature ? 'Билет создан в Devnet; QR-секрет хранится локально.' : 'Тестовый QR-билет выдан.');
    } else if (action === 'transfer') {
      const ticket = events.flatMap((item) => item.tickets).find((item) => item.id === button.dataset.ticketId);
      const eventData = events.find((item) => item.id === ticket?.eventId);
      let chainData = {};
      if (ticket?.chainPda && eventData?.chainPda) {
        if (!chainReady) throw new Error('Событие в Devnet, но программа сейчас недоступна.');
        if (!walletProvider?.publicKey) throw new Error('Подключите кошелёк организатора для передачи билета.');
        const token = randomToken();
        const commitment = await sha256(token);
        const instruction = await anchorInstruction('transfer_ticket', [commitment], [
          { pubkey: walletProvider.publicKey, isSigner: true, isWritable: false },
          { pubkey: new PublicKey(eventData.chainPda), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(ticket.chainPda), isSigner: false, isWritable: true },
        ]);
        chainData = { holderCommitment: bytesToHex(commitment), token, signature: await sendAnchor(instruction) };
      }
      const result = await api(`/api/tickets/${button.dataset.ticketId}/transfer`, {
        method: 'POST', body: JSON.stringify(chainData),
      });
      await refresh();
      scanEvent.value = result.ticket.eventId;
      scanToken.value = result.ticket.token;
      notify('Билет передан: старый QR больше не действителен.');
    } else if (action === 'revoke') {
      if (!window.confirm('Отозвать билет? Его QR больше не будет работать.')) return;
      const ticket = events.flatMap((item) => item.tickets).find((item) => item.id === button.dataset.ticketId);
      const eventData = events.find((item) => item.id === ticket?.eventId);
      let chainData = {};
      if (ticket?.chainPda && eventData?.chainPda) {
        if (!chainReady) throw new Error('Событие в Devnet, но программа сейчас недоступна.');
        if (!walletProvider?.publicKey) throw new Error('Подключите кошелёк организатора для отзыва билета.');
        const instruction = await anchorInstruction('revoke_ticket', [], [
          { pubkey: walletProvider.publicKey, isSigner: true, isWritable: false },
          { pubkey: new PublicKey(eventData.chainPda), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(ticket.chainPda), isSigner: false, isWritable: true },
        ]);
        chainData = { signature: await sendAnchor(instruction) };
      }
      await api(`/api/tickets/${button.dataset.ticketId}/revoke`, {
        method: 'POST', body: JSON.stringify(chainData),
      });
      await refresh();
      notify('Билет отозван.');
    } else if (action === 'copy') {
      const ticket = events.flatMap((item) => item.tickets).find((item) => item.id === button.dataset.ticketId);
      if (!ticket?.token) throw new Error('Код больше недоступен. Выпустите новый билет.');
      await navigator.clipboard.writeText(ticket.token);
      scanToken.value = ticket.token;
      notify('Код билета скопирован.');
    }
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});

scanForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('button[type="submit"]', scanForm);
  submit.disabled = true;
  scanResult.hidden = true;
  const tokenOrUrl = scanToken.value.trim();
  let token = tokenOrUrl;
  try {
    if (tokenOrUrl.startsWith('http://') || tokenOrUrl.startsWith('https://')) {
      token = new URL(tokenOrUrl).searchParams.get('ticket') ?? tokenOrUrl;
    }
    const resolved = await api('/api/resolve-ticket', {
      method: 'POST', body: JSON.stringify({ eventId: scanEvent.value, token }),
    });
    let signature;
    if (resolved.chainEnabled) {
      if (!chainReady) throw new Error('Devnet-билет найден, но программа недоступна. Вход не зафиксирован.');
      if (!walletProvider?.publicKey) throw new Error('Подключите авторизованный кошелёк контроля входа.');
      const instruction = await anchorInstruction('check_in', [], [
        { pubkey: walletProvider.publicKey, isSigner: true, isWritable: false },
        { pubkey: new PublicKey(resolved.eventPda), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(resolved.ticketPda), isSigner: false, isWritable: true },
      ]);
      signature = await sendAnchor(instruction);
    }
    const result = await api('/api/check-in', {
      method: 'POST', body: JSON.stringify({ eventId: scanEvent.value, token, signature }),
    });
    showScanResult(true, result.message ?? 'Вход разрешён.', `Билет GP-${result.ticketId.slice(0, 8).toUpperCase()}`);
    scanToken.value = '';
    await refresh();
  } catch (error) {
    showScanResult(false, 'Вход не разрешён', error.message);
  } finally {
    submit.disabled = false;
  }
});

function showScanResult(accepted, title, message) {
  scanResult.hidden = false;
  scanResult.classList.toggle('fail', !accepted);
  scanResult.innerHTML = `<b>${accepted ? '✓ ' : '× '}${escapeHtml(title)}</b><span>${escapeHtml(message)}</span>`;
}

const cameraWrap = $('#camera-wrap');
const cameraVideo = $('#camera-video');
const cameraButton = $('#camera-button');

async function stopCamera() {
  if (cameraFrame) cancelAnimationFrame(cameraFrame);
  cameraFrame = undefined;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = undefined;
  cameraVideo.srcObject = null;
  cameraWrap.hidden = true;
  cameraButton.disabled = false;
}

cameraButton.addEventListener('click', async () => {
  if (!('BarcodeDetector' in window)) {
    notify('Сканирование камерой не поддерживается этим браузером. Введите код вручную.');
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    cameraVideo.srcObject = cameraStream;
    await cameraVideo.play();
    cameraWrap.hidden = false;
    cameraButton.disabled = true;
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const scan = async () => {
      if (!cameraStream) return;
      try {
        const codes = await detector.detect(cameraVideo);
        if (codes[0]?.rawValue) {
          scanToken.value = codes[0].rawValue;
          await stopCamera();
          scanForm.requestSubmit();
          return;
        }
      } catch {
        // Camera can be between frames; continue scanning.
      }
      cameraFrame = requestAnimationFrame(scan);
    };
    cameraFrame = requestAnimationFrame(scan);
  } catch {
    await stopCamera();
    notify('Не удалось открыть камеру. Проверьте доступ и используйте HTTPS или localhost.');
  }
});

$('#camera-stop').addEventListener('click', stopCamera);

api('/api/health').then(initializeChain).catch(() => {
  $('#chain-status').textContent = 'Сервер недоступен';
  $('#chain-detail').textContent = 'перезапустите pnpm dev';
});

refresh().catch((error) => notify(error.message));
