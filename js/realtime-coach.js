// js/realtime-coach.js
// ═══════════════════════════════════════════════════════════
// Real-Time Meeting Coach
// Captura audio del tab → AudioContext (PCM 16kHz) → Deepgram →
// OpenAI → render en vivo.
// Keys NO en repo — vienen de localStorage (prompt 1ra vez).
// ═══════════════════════════════════════════════════════════
(function (global) {
  const cfg = global.PREDICTABLE_CONFIG || {};
  const toast = (global.uiHelpers && global.uiHelpers.toast) ||
                function (msg) { console.log(msg); };

  let keys = null;
  let stream = null;
  let audioCtx = null;
  let audioSource = null;
  let audioProcessor = null;
  let dgSocket = null;
  let utteranceBuffer = [];
  let coachInFlight = false;
  let chunkQueue = [];
  let elapsedTimer = null;
  let elapsedSeconds = 0;
  let currentMeetingId = null;
  let recentTranscript = [];
  let active = false;

  // ─── KEYS via localStorage ────────────────────────────────
  function getKey(name, label) {
    let k = localStorage.getItem('px_' + name);
    if (!k) {
      k = prompt('Pega tu API key de ' + label + ' (se guarda solo en este navegador):');
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
      alert('Sin API keys el coach en vivo no funciona.');
      return null;
    }
    return { deepgram: dg, openai: oa };
  }
  function resetKeys() {
    localStorage.removeItem('px_deepgram');
    localStorage.removeItem('px_openai');
    alert('Keys borradas. Refresca y vuelve a iniciar coach.');
  }
  global.resetCoachKeys = resetKeys;

  // ─── INICIO ───────────────────────────────────────────────
  async function start(prospectContext) {
    keys = ensureKeys();
    if (!keys) return;

    try {
      console.log('[Coach] Solicitando captura de pantalla...');
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      const audioTracks = stream.getAudioTracks();
      console.log('[Coach] Audio tracks:', audioTracks.length);
      if (audioTracks.length === 0) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        toast('Debes marcar "Compartir audio del tab" al elegir la pantalla', 'error');
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
      console.log('[Coach] Meeting registrado:', currentMeetingId);

      clearUI();
      setStatus('connecting');
      elapsedSeconds = 0;
      elapsedTimer = setInterval(updateElapsed, 1000);

      connectDeepgram();
      startAudioCapture(stream);

      stream.getVideoTracks()[0].onended = function () {
        toast('Captura detenida desde el navegador', 'warn');
        end();
      };

      toast('Coach en vivo iniciado', 'success');
    } catch (e) {
      console.error('[Coach] Start error:', e);
      toast('Error iniciando coach: ' + e.message, 'error');
      cleanup();
    }
  }

  // ─── AUDIO CAPTURE con AudioContext (PCM 16kHz) ───────────
  function startAudioCapture(srcStream) {
    try {
      const audioOnly = new MediaStream(srcStream.getAudioTracks());
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      console.log('[Coach] AudioContext sampleRate:', audioCtx.sampleRate);

      audioSource = audioCtx.createMediaStreamSource(audioOnly);
      audioProcessor = audioCtx.createScriptProcessor(4096, 1, 1);

      audioProcessor.onaudioprocess = function (e) {
        if (!dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        dgSocket.send(int16.buffer);
      };

      audioSource.connect(audioProcessor);
      audioProcessor.connect(audioCtx.destination);
      console.log('[Coach] AudioContext capture iniciada');
    } catch (e) {
      console.error('[Coach] AudioContext error:', e);
      toast('Error de audio: ' + e.message, 'error');
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
      'punctuate=true',
      'encoding=linear16',
      'sample_rate=16000',
      'channels=1'
    ].join('&');

    const url = 'wss://api.deepgram.com/v1/listen?' + params;
    console.log('[Coach] Conectando Deepgram...');
    dgSocket = new WebSocket(url, ['token', keys.deepgram]);

    dgSocket.onopen = function () {
      console.log('[Coach] Deepgram WebSocket abierto');
      setStatus('live');
    };
    dgSocket.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'Results') handleTranscript(msg);
        else if (msg.type === 'UtteranceEnd') handleUtteranceEnd();
      } catch (e) { console.warn('[Coach] DG parse error', e); }
    };
    dgSocket.onerror = function (e) {
      console.error('[Coach] Deepgram error:', e);
      toast('Error de Deepgram. Verifica saldo y key. Consola: resetCoachKeys()', 'error');
    };
    dgSocket.onclose = function (e) {
      console.log('[Coach] Deepgram cerrado:', e.code, e.reason);
      if (e.code === 1006 || e.code === 1011) {
        toast('Deepgram se desconectó. Si la key es nueva, espera 1 min antes de probar.', 'warn');
      }
    };
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
      'Habla en español neutro. Sé directo. NO inventes alertas.'
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
        toast('Error OpenAI ' + resp.status, 'error');
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

  // ─── PERSISTENCE ──────────────────────────────────────────
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
        '<strong style="color:' + color + '">Di esto:</strong><br>' + phrase + '</div>';
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
    if (audioProcessor) { try { audioProcessor.disconnect(); } catch (e) {} audioProcessor = null; }
    if (audioSource) { try { audioSource.disconnect(); } catch (e) {} audioSource = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
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
