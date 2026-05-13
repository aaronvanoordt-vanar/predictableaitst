// js/realtime-coach.js
// ═══════════════════════════════════════════════════════════
// Real-Time Meeting Coach
// Captura audio del tab del Meet → Deepgram streaming →
// OpenAI streaming → render en vivo.
// Keys NO en repo — vienen de localStorage (prompt 1ra vez).
// ═══════════════════════════════════════════════════════════
(function (global) {
  const cfg = global.PREDICTABLE_CONFIG || {};
  const toast = (global.uiHelpers && global.uiHelpers.toast) ||
                function (msg) { console.log(msg); };
 
  let keys = null;
  let stream = null;
  let mediaRecorder = null;
  let dgSocket = null;
  let utteranceBuffer = [];
  let coachInFlight = false;
  let chunkQueue = [];
  let elapsedTimer = null;
  let elapsedSeconds = 0;
  let currentMeetingId = null;
  let recentTranscript = [];
  let active = false;
 
  // ─── KEYS via localStorage (repo público) ─────────────────
  function getKey(name, label) {
    let k = localStorage.getItem('px_' + name);
    if (!k) {
      k = prompt('Pega tu API key de ' + label +
        ' (se guarda solo en este navegador, no en GitHub):');
      if (k) {
        k = k.trim();
        localStorage.setItem('px_' + name, k);
      }
    }
    return k && k.trim();
  }
  function ensureKeys() {
    const dg = getKey('deepgram', 'Deepgram');
    const oa = getKey('openai', 'OpenAI');
    if (!dg || !oa) {
      alert('Sin API keys el coach en vivo no funciona. Cancelado.');
      return null;
    }
    return { deepgram: dg, openai: oa };
  }
  function resetKeys() {
    localStorage.removeItem('px_deepgram');
    localStorage.removeItem('px_openai');
    alert('Keys borradas. Refresca la página y vuelve a iniciar coach.');
  }
  global.resetCoachKeys = resetKeys; // exponer en consola para debug
 
  // ─── INICIO ───────────────────────────────────────────────
  async function start(prospectContext) {
    keys = ensureKeys();
    if (!keys) return;
 
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });
 
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        toast('Debes marcar "Compartir audio del tab" en el cuadro de compartir', 'error');
        return;
      }
 
      const res = await global.api.startMeeting({
        meeting_url: 'local-capture://realtime',
        prospect_id: prospectContext && prospectContext.id,
        prospect_name: prospectContext && prospectContext.name,
        context: prospectContext || {},
        mode: 'live'
      });
      currentMeetingId = res.meeting_id;
      active = true;
 
      clearUI();
      setStatus('connecting');
      elapsedSeconds = 0;
      elapsedTimer = setInterval(updateElapsed, 1000);
 
      connectDeepgram();
 
// Separar audio del video — MediaRecorder solo necesita audio
const audioOnly = new MediaStream(stream.getAudioTracks());

// Detectar el primer mimeType soportado por este navegador
let mimeType = '';
const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
for (let i = 0; i < candidates.length; i++) {
  if (MediaRecorder.isTypeSupported(candidates[i])) {
    mimeType = candidates[i];
    break;
  }
}
console.log('MediaRecorder mimeType:', mimeType || 'default');

mediaRecorder = mimeType
  ? new MediaRecorder(audioOnly, { mimeType: mimeType })
  : new MediaRecorder(audioOnly);

mediaRecorder.ondataavailable = function (e) {
  if (e.data.size > 0 && dgSocket && dgSocket.readyState === WebSocket.OPEN) {
    dgSocket.send(e.data);
  }
};

mediaRecorder.onerror = function (ev) {
  console.error('MediaRecorder error:', ev.error);
  toast('Error de grabación: ' + (ev.error && ev.error.name), 'error');
};

mediaRecorder.start(250);
 
      stream.getVideoTracks()[0].onended = function () {
        toast('Captura detenida desde el navegador', 'warn');
        end();
      };
 
      toast('Coach en vivo iniciado', 'success');
    } catch (e) {
      console.error('Start error', e);
      toast('Error iniciando coach: ' + e.message, 'error');
      cleanup();
    }
  }
 
  // ─── DEEPGRAM ─────────────────────────────────────────────
  function connectDeepgram() {
    const params = [
      'model=nova-2-general',
      'language=multi',
      'interim_results=true',
      'endpointing=300',
      'utterance_end_ms=1000',
      'smart_format=true',
      'punctuate=true'
    ].join('&');
 
    const url = 'wss://api.deepgram.com/v1/listen?' + params;
    dgSocket = new WebSocket(url, ['token', keys.deepgram]);
 
    dgSocket.onopen = function () { setStatus('live'); };
    dgSocket.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'Results') handleTranscript(msg);
        else if (msg.type === 'UtteranceEnd') handleUtteranceEnd();
      } catch (e) { console.warn('DG parse error', e); }
    };
    dgSocket.onerror = function (e) {
      console.error('Deepgram error', e);
      toast('Error de Deepgram. Si la key está mal, en consola: resetCoachKeys()', 'error');
    };
    dgSocket.onclose = function () { console.log('Deepgram desconectado'); };
  }
 
  function handleTranscript(msg) {
    const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
    if (!alt || !alt.transcript) return;
    const text = alt.transcript.trim();
    if (!text) return;
 
    const isFinal = msg.is_final;
    const speaker = 'Lead';
    showInterim(speaker, text, isFinal);
 
    if (isFinal) {
      utteranceBuffer.push({ speaker: speaker, text: text, ts: new Date() });
      recentTranscript.push(speaker + ': ' + text);
      if (recentTranscript.length > 20) recentTranscript.shift();
      appendFinalToTranscript(speaker, text);
      enqueueChunkForBackend({ speaker: speaker, text: text, ts: new Date().toISOString() });
    }
  }
 
  function handleUtteranceEnd() {
    const trigger = cfg.COACH_TRIGGER_UTTERANCES || 2;
    if (utteranceBuffer.length >= trigger && !coachInFlight) runCoaching();
  }
 
  // ─── COACHING ─────────────────────────────────────────────
  async function runCoaching() {
    if (coachInFlight || !keys) return;
    coachInFlight = true;
    showThinking();
 
    const context = recentTranscript.slice(-15).join('\n');
    const systemPrompt = [
      'Eres el coach de ventas de Predictable.ai en vivo durante una llamada B2B.',
      'Recibes la conversación reciente y decides si hay algo accionable.',
      'Si no hay nada, devuelve alerts: [].',
      'OUTPUT: SOLO JSON con schema:',
      '{',
      '  "alerts": [{',
      '    "type": "objection|positive_signal|risk|stage_guidance",',
      '    "title": "string corta",',
      '    "explanation": "máx 2 frases",',
      '    "suggested_phrase": "frase exacta para que el SDR diga AHORA"',
      '  }],',
      '  "stage": "rapport|discovery|reframe|demo|negotiation|close",',
      '  "next_step": "1 acción inmediata"',
      '}',
      'Habla en español neutro. Sé directo. NO inventes alertas si no hay nada.'
    ].join('\n');
 
    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + keys.openai
        },
        body: JSON.stringify({
          model: cfg.LLM_MODEL || 'gpt-4o-mini',
          temperature: 0.3,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Conversación reciente:\n' + context }
          ]
        })
      });
 
      if (!resp.ok) {
        const errTxt = await resp.text();
        console.error('OpenAI ' + resp.status + ': ' + errTxt);
        toast('Error OpenAI ' + resp.status + ' (key inválida?). Consola: resetCoachKeys()', 'error');
        hideThinking();
        coachInFlight = false;
        return;
      }
 
      const data = await resp.json();
      const content = data.choices && data.choices[0] && data.choices[0].message.content;
      if (!content) throw new Error('respuesta vacía');
      const parsed = JSON.parse(content);
 
      hideThinking();
      renderCoachOutput(parsed);
      enqueueEventForBackend(parsed);
      utteranceBuffer = [];
    } catch (e) {
      console.error('Coaching error', e);
      hideThinking();
    } finally {
      coachInFlight = false;
    }
  }
 
  // ─── BACKEND PERSISTENCE ──────────────────────────────────
  function enqueueChunkForBackend(c) {
    chunkQueue.push(c);
    if (chunkQueue.length >= 3) flushChunks();
  }
  async function flushChunks() {
    if (!currentMeetingId || chunkQueue.length === 0) return;
    const batch = chunkQueue.splice(0);
    try {
      await global.api.ingestLocalChunks({ meeting_id: currentMeetingId, chunks: batch });
    } catch (e) {
      console.warn('flushChunks error', e);
      chunkQueue = batch.concat(chunkQueue);
    }
  }
  async function enqueueEventForBackend(ev) {
    if (!currentMeetingId) return;
    try {
      await global.api.ingestLocalEvent({ meeting_id: currentMeetingId, event: ev });
    } catch (e) { console.warn('event persist error', e); }
  }
 
  // ─── UI ───────────────────────────────────────────────────
  function clearUI() {
    const t = document.getElementById('mc-transcript'); if (t) t.innerHTML = '';
    const e = document.getElementById('mc-events');
    if (e) Array.from(e.querySelectorAll('.ai-alert-dynamic')).forEach(function (el) { el.remove(); });
    hideThinking();
  }
  function showInterim(speaker, text, isFinal) {
    const el = document.getElementById('mc-last-spoken');
    if (!el) return;
    el.innerHTML =
      '<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">' +
      (isFinal ? 'Lo último que se dijo' : 'Escuchando...') + '</div>' +
      '<div style="font-size:15px;color:' + (isFinal ? 'var(--text)' : 'var(--text3)') +
      ';line-height:1.5;font-style:' + (isFinal ? 'normal' : 'italic') + '">' +
      '<strong style="color:var(--teal)">' + esc(speaker) + ':</strong> ' + esc(text) + '</div>';
  }
  function appendFinalToTranscript(speaker, text) {
    const c = document.getElementById('mc-transcript');
    if (!c) return;
    const div = document.createElement('div');
    div.innerHTML = '<span style="color:var(--teal);font-weight:700">' + esc(speaker) + ':</span> ' +
      '<span style="color:var(--text2)">' + esc(text) + '</span>';
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
  }
  function renderCoachOutput(out) {
    const events = document.getElementById('mc-events');
    if (!events) return;
    (out.alerts || []).forEach(function (a) { events.prepend(buildAlertCard(a)); });
    if (out.stage) {
      const stEl = document.getElementById('mc-stage');
      if (stEl) stEl.textContent = capitalize(out.stage);
    }
    if (out.next_step) {
      const ns = document.getElementById('mc-next-steps');
      if (ns) ns.innerHTML = '<div style="font-size:12px;padding:6px 8px;background:var(--surface2);border-radius:6px">' +
        esc(out.next_step) + '</div>';
    }
  }
  function buildAlertCard(alert) {
    const card = document.createElement('div');
    card.className = 'ai-suggestion ai-alert-dynamic';
    const colors = { objection: 'var(--amber)', positive_signal: 'var(--green)', risk: 'var(--red)', stage_guidance: 'var(--gold)' };
    const color = colors[alert.type] || 'var(--teal)';
    card.style.cssText = 'border:2px solid ' + color + ';background:rgba(245,158,11,.06)';
    let html = '<div class="ai-tag" style="color:' + color + '">' + esc(alert.title || alert.type.toUpperCase()) + '</div>' +
               '<div class="ai-text">' + esc(alert.explanation || '') + '</div>';
    if (alert.suggested_phrase) {
      const phrase = esc(alert.suggested_phrase);
      html += '<div style="background:var(--surface2);border-radius:6px;padding:10px;margin-top:8px;font-size:12px;line-height:1.7">' +
        '<strong style="color:' + color + '">Di esto:</strong><br>' + phrase + '</div>' +
        '<button class="ai-copy" data-phrase="' + phrase + '" onclick="navigator.clipboard.writeText(this.dataset.phrase);this.textContent=&quot;Copiado&quot;">📋 Copiar</button>';
    }
    card.innerHTML = html;
    return card;
  }
  function showThinking() {
    if (document.getElementById('mc-thinking')) return;
    const el = document.createElement('div');
    el.id = 'mc-thinking';
    el.className = 'ai-suggestion ai-alert-dynamic';
    el.style.cssText = 'border:1px dashed var(--teal);background:rgba(0,196,212,.05);animation:pulse 1.5s infinite';
    el.innerHTML = '<div class="ai-tag" style="color:var(--teal)">🧠 PROCESANDO</div>';
    const events = document.getElementById('mc-events');
    if (events) events.prepend(el);
  }
  function hideThinking() {
    const el = document.getElementById('mc-thinking');
    if (el) el.remove();
  }
  function setStatus(s) {
    const el = document.getElementById('mc-status');
    if (!el) return;
    const map = { connecting: 'Conectando al audio del tab...', live: '🎙 Escuchando en vivo', ended: 'Sesión finalizada' };
    el.textContent = map[s] || s;
  }
  function updateElapsed() {
    elapsedSeconds++;
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const el = document.getElementById('mc-timer');
    if (el) el.textContent = pad(Math.floor(elapsedSeconds / 3600)) + ':' +
      pad(Math.floor((elapsedSeconds % 3600) / 60)) + ':' + pad(elapsedSeconds % 60);
  }
 
  // ─── FINALIZAR ────────────────────────────────────────────
  async function end() {
    await flushChunks();
    cleanup();
    setStatus('ended');
    if (currentMeetingId) {
      try {
        const final = await global.api.endMeeting({ meeting_id: currentMeetingId });
        toast('Sesión finalizada — score: ' + (final.score_total || 0), 'success');
        setTimeout(function () {
          if (typeof nav === 'function') nav(document.querySelector('[data-page=ventas-reportes]'), 'ventas-reportes');
        }, 800);
      } catch (e) { console.warn(e); }
    }
    currentMeetingId = null;
    active = false;
  }
  function cleanup() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch (e) {} }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (dgSocket) { try { dgSocket.close(); } catch (e) {} dgSocket = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    utteranceBuffer = [];
  }
 
  // ─── HELPERS ──────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
 
  global.realtimeCoach = { start: start, end: end, isActive: function () { return active; } };
})(window);
