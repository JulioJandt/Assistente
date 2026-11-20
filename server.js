// Assistente pessoal - servidor local sem dependencias.
// Liga a interface (public/index.html) ao Claude Code rodando em modo headless,
// usando o login e o plano que voce ja tem - sem chave de API, sem custo extra.
// Nome, personalidade, voz e cores ficam em config.json (lido a cada mensagem).
//
// Uso:  node server.js          (so o servidor)
//       node server.js --open   (servidor + abre a janela no Edge)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.ASSISTENTE_PORT) || 7777;
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}`;
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const DATA_DIR = path.join(ROOT, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const LOG_FILE = path.join(DATA_DIR, 'actions.log');
// Acha o Claude Code mesmo quando a pasta dele nao esta no PATH (ex.: ao abrir pelo .bat).
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || 'claude';
}
const CLAUDE_BIN = findClaude();

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- configuracao ----------
function loadConfig() {
  try {
    return { nome: 'Assistente', ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (err) {
    console.error(`Nao consegui ler config.json (${err.message}); usando padroes.`);
    return { nome: 'Assistente' };
  }
}
function personaPrompt(cfg) {
  let p = `Seu nome é ${cfg.nome}. Apresente-se e refira-se a si mesmo sempre como ${cfg.nome}.`;
  if (cfg.personalidade) p += ` Personalidade: ${cfg.personalidade}`;
  p += ' A personalidade nunca se sobrepõe às regras de segurança do CLAUDE.md.';
  return p;
}

// ---------- estado ----------
function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).sessionId || null; } catch { return null; }
}
function saveSession(id) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id, updated: new Date().toISOString() }));
}
function clearSession() {
  sessionId = null;
  try { fs.unlinkSync(SESSION_FILE); } catch {}
}
function log(line) {
  fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, () => {});
}

let sessionId = loadSession();
let busy = false;

// ---------- verificacao de seguranca ----------
// O proprio servidor roda o script (somente leitura) e salva o relatorio;
// o assistente apenas LE o relatorio - assim ele nao precisa de acesso ao shell.
const SECURITY_SCRIPT = path.join(ROOT, 'scripts', 'security-check.ps1');
const SECURITY_REPORT = path.join(DATA_DIR, 'security-report.md');
const SECURITY_INTERVAL_MS = 30 * 60 * 1000;
let securityRun = null;

function runSecurityCheck(full = false) {
  if (securityRun) return securityRun;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SECURITY_SCRIPT];
  if (full) args.push('-Full');
  securityRun = new Promise((resolve) => {
    const ps = spawn('powershell.exe', args, { cwd: ROOT, windowsHide: true });
    let out = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', (err) => resolve({ ok: false, error: err.message }));
    ps.on('close', () => {
      fs.writeFileSync(SECURITY_REPORT, out);
      log('SEGURANCA: relatorio atualizado');
      resolve({ ok: true, updated: new Date().toISOString() });
    });
  }).finally(() => { securityRun = null; });
  return securityRun;
}

// ---------- voz (Piper, local e gratuito) ----------
// Um processo Python fica com o modelo de voz carregado e responde pedidos em fila.
const PIPER_PY = path.join(ROOT, 'tools', 'piper', 'venv', 'Scripts', 'python.exe');
const TTS_WORKER = path.join(ROOT, 'scripts', 'tts_worker.py');
const VOICES_DIR = path.join(ROOT, 'tools', 'piper', 'voices');
let tts = null;

function piperModel(cfg) {
  return path.join(VOICES_DIR, path.basename(cfg.voz?.piper?.modelo || 'pt_BR-faber-medium.onnx'));
}
function piperAvailable(cfg) {
  return fs.existsSync(PIPER_PY) && fs.existsSync(piperModel(cfg));
}
function getTts(cfg) {
  const model = piperModel(cfg);
  if (tts && tts.model === model) return tts;
  if (tts) tts.proc.kill();

  const proc = spawn(PIPER_PY, ['-I', TTS_WORKER, model], { cwd: ROOT, windowsHide: true });
  const w = { proc, model, pending: [], buf: Buffer.alloc(0) };
  const failAll = (err) => {
    for (const p of w.pending) p.reject(err);
    w.pending = [];
    if (tts === w) tts = null;
  };
  proc.stdout.on('data', (chunk) => {
    w.buf = Buffer.concat([w.buf, chunk]);
    while (w.buf.length >= 4) {
      const n = w.buf.readUInt32LE(0);
      if (w.buf.length < 4 + n) break;
      const wav = Buffer.from(w.buf.subarray(4, 4 + n));
      w.buf = w.buf.subarray(4 + n);
      w.pending.shift()?.resolve(wav);
    }
  });
  proc.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s && s !== 'pronto') console.error('[voz]', s);
  });
  proc.on('error', failAll);
  proc.on('close', () => failAll(new Error('o processo de voz encerrou')));
  tts = w;
  return w;
}
function synthesize(cfg, text) {
  return new Promise((resolve, reject) => {
    const w = getTts(cfg);
    w.pending.push({ resolve, reject });
    w.proc.stdin.write(JSON.stringify({ text, length_scale: cfg.voz?.piper?.lentidao || 1 }) + '\n');
  });
}
function handleTts(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 20_000) req.destroy(); });
  req.on('end', () => {
    let text;
    try { text = String(JSON.parse(body).text || '').trim().slice(0, 1500); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
    if (!text) return sendJson(res, 400, { error: 'Texto vazio' });
    const cfg = loadConfig();
    if (!piperAvailable(cfg)) return sendJson(res, 503, { error: 'Piper nao instalado' });
    synthesize(cfg, text)
      .then((wav) => {
        if (!wav.length) return sendJson(res, 500, { error: 'Falha ao gerar a voz' });
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
        res.end(wav);
      })
      .catch((err) => sendJson(res, 500, { error: err.message }));
  });
}

// ---------- acesso pelo celular (Tailscale) ----------
// O servidor continua ouvindo so em 127.0.0.1. O "tailscale serve" recebe o acesso
// em https://<pc>.<rede>.ts.net (visivel apenas para os aparelhos da sua rede Tailscale)
// e repassa para ca. O Tailscale informa em cada pedido quem e o usuario
// (cabecalho Tailscale-User-Login); so o dono deste PC e aceito.
const TAILSCALE_BIN = process.env.TAILSCALE_BIN || [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
].find((p) => fs.existsSync(p)) || 'tailscale';
let remote; // { host, login } quando o Tailscale esta conectado; null quando nao

function detectTailscale() {
  return new Promise((resolve) => {
    let out = '';
    let ps;
    try { ps = spawn(TAILSCALE_BIN, ['status', '--json'], { windowsHide: true }); } catch { return resolve(null); }
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('error', () => resolve(null));
    ps.on('close', () => {
      try {
        const st = JSON.parse(out);
        const host = String(st.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
        const login = st.User?.[st.Self?.UserID]?.LoginName;
        resolve(host && login && st.BackendState === 'Running' ? { host, login } : null);
      } catch { resolve(null); }
    });
  });
}

// ---------- seguranca do servidor ----------
// Recusa pedidos de outros sites abertos no navegador (CSRF) e DNS rebinding:
// so aceita Host local (ou o endereco Tailscale do PC) e, em requisicoes que nao sao GET,
// Origin da propria interface.
const LOCAL_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const LOCAL_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
function isTrusted(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (LOCAL_HOSTS.has(host)) {
    return req.method === 'GET' || LOCAL_ORIGINS.has(req.headers.origin);
  }
  if (remote && host === remote.host) {
    if (req.headers['tailscale-user-login'] !== remote.login) return false;
    return req.method === 'GET' || req.headers.origin === `https://${remote.host}`;
  }
  return false;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Resumo curto do que uma ferramenta esta fazendo, para mostrar no chat.
function summarizeInput(input = {}) {
  const v = input.file_path || input.path || input.command || input.query || input.url || input.pattern || input.description || '';
  const s = String(v).replace(/\s+/g, ' ');
  return s.length > 90 ? s.slice(0, 87) + '...' : s;
}

// ---------- chat ----------
function handleChat(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; if (body.length > 200_000) req.destroy(); });
  req.on('end', () => {
    let message;
    try { message = String(JSON.parse(body).message || '').trim(); } catch { return sendJson(res, 400, { error: 'JSON invalido' }); }
    if (!message) return sendJson(res, 400, { error: 'Mensagem vazia' });
    if (busy) return sendJson(res, 409, { error: 'Ainda estou respondendo a mensagem anterior.' });

    busy = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const cfg = loadConfig();
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--append-system-prompt', personaPrompt(cfg)];
    const resumed = Boolean(sessionId);
    if (resumed) args.push('--resume', sessionId);

    const env = { ...process.env };
    delete env.CLAUDECODE; // permite iniciar o servidor de dentro de uma sessao do Claude Code

    log(`USUARIO: ${message.slice(0, 500)}`);
    const child = spawn(CLAUDE_BIN, args, { cwd: ROOT, env, windowsHide: true });
    child.stdin.end(message, 'utf8'); // mensagem via stdin: sem problemas de aspas ou tamanho

    let finished = false;
    let closed = false;
    let stderr = '';
    let buf = '';

    const finish = () => {
      if (closed) return;
      closed = true;
      busy = false;
      res.end();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });

    function handleLine(line) {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }

      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
        sessionId = ev.session_id;
        saveSession(sessionId);
      } else if (ev.type === 'stream_event') {
        const e = ev.event || {};
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') emit('delta', { text: e.delta.text });
        else if (e.type === 'message_start') emit('turn', {});
      } else if (ev.type === 'assistant') {
        for (const b of ev.message?.content || []) {
          if (b.type === 'tool_use') {
            emit('tool', { name: b.name, detail: summarizeInput(b.input) });
            log(`FERRAMENTA: ${b.name} ${JSON.stringify(b.input).slice(0, 300)}`);
          }
        }
      } else if (ev.type === 'result') {
        finished = true;
        if (ev.session_id) { sessionId = ev.session_id; saveSession(sessionId); }
        const denials = [...new Set((ev.permission_denials || []).map((d) => d.tool_name))];
        emit('done', { ok: !ev.is_error, error: ev.is_error ? String(ev.result || ev.subtype) : null, denials });
        log(`${cfg.nome.toUpperCase()}: ${String(ev.result || '').slice(0, 500).replace(/\s+/g, ' ')}`);
      }
    }

    child.on('error', (err) => {
      emit('done', { ok: false, error: `Nao consegui iniciar o Claude Code (${err.message}). Ele esta instalado e no PATH?` });
      finish();
    });
    child.on('close', (code) => {
      if (!finished) {
        const err = stderr.trim();
        if (resumed && /no conversation found/i.test(err)) clearSession();
        emit('done', { ok: false, error: err.slice(-600) || `O Claude Code encerrou com codigo ${code}.` });
      }
      finish();
    });

    // Se a janela fechar ou o usuario clicar em "parar", encerra o Claude Code.
    res.on('close', () => { if (child.exitCode === null) child.kill(); });
  });
}

// ---------- servidor ----------
const server = http.createServer((req, res) => {
  if (!isTrusted(req)) return sendJson(res, 403, { error: 'Origem nao permitida' });
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url === '/manifest.webmanifest') {
    const { nome } = loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      name: nome, short_name: nome, start_url: '/', scope: '/', display: 'standalone',
      background_color: '#04070c', theme_color: '#04070c', lang: 'pt-BR',
      icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
    }));
  }
  if (req.method === 'GET' && (url === '/icon.png' || url === '/apple-touch-icon.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
    return fs.createReadStream(path.join(ROOT, 'public', 'icon.png')).pipe(res);
  }
  if (req.method === 'GET' && url === '/api/config') {
    const cfg = loadConfig();
    const { nome, voz, cores } = cfg;
    return sendJson(res, 200, { nome, voz, cores, piperOk: piperAvailable(cfg) });
  }
  if (req.method === 'POST' && url === '/api/tts') return handleTts(req, res);
  if (req.method === 'GET' && url === '/api/status') return sendJson(res, 200, { busy, hasSession: Boolean(sessionId) });
  if (req.method === 'POST' && url === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && url === '/api/security') {
    const full = req.url.includes('full=1');
    return runSecurityCheck(full).then((r) => sendJson(res, r.ok ? 200 : 500, r));
  }
  if (req.method === 'POST' && url === '/api/reset') {
    if (busy) return sendJson(res, 409, { error: 'Aguarde a resposta atual terminar.' });
    clearSession();
    log('--- nova conversa ---');
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 404, { error: 'Nao encontrado' });
});

server.listen(PORT, HOST, () => {
  const cfg = loadConfig();
  console.log(`${cfg.nome} online em ${URL}  (Ctrl+C para desligar)`);
  if (cfg.voz?.motor === 'piper') {
    if (piperAvailable(cfg)) getTts(cfg); // ja carrega a voz para a primeira fala sair rapido
    else console.log('Piper nao encontrado; usando a voz do navegador.');
  }
  runSecurityCheck();
  setInterval(() => runSecurityCheck(), SECURITY_INTERVAL_MS);
  const refreshRemote = () => detectTailscale().then((r) => {
    const changed = JSON.stringify(r) !== JSON.stringify(remote);
    remote = r;
    if (changed) console.log(r ? `Celular: https://${r.host}  (somente ${r.login})` : 'Acesso pelo celular desligado (Tailscale nao conectado).');
  });
  refreshRemote();
  setInterval(refreshRemote, 60 * 1000); // acompanha se o Tailscale ligar/desligar
  if (process.argv.includes('--open')) {
    // Abre no Edge em modo app (janela propria, sem barra de endereco); o Edge tem vozes naturais em pt-BR.
    spawn('cmd', ['/c', 'start', '', 'msedge', `--app=${URL}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});
