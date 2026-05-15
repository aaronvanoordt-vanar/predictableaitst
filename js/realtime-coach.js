// js/realtime-coach.js
// ═══════════════════════════════════════════════════════════
// Real-Time Coach v2 — usa Cloudflare Worker como proxy.
// El usuario NO necesita API keys propias.
// ═══════════════════════════════════════════════════════════
(function (global) {
  const cfg = global.PREDICTABLE_CONFIG || {};
  const toast = (global.uiHelpers && global.uiHelpers.toast) ||
                function (msg) { console.log(msg); };
 
  let displayStream = null;
  let micStream = null;
  let audioCtx = null;
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
 
  function workerUrl(path) {
    const base = (cfg.WORKER_URL || '').replace(/\/$/, '');
    return base + path;
  }
  function workerWsUrl(path) {
    return workerUrl(path).replace(/^http/, 'ws');
  }
 
  // ─── INICIO ───────────────────────────────────────────────
  async function start(prospectContext) {
    if (!cfg.WORKER_URL) {
      alert('WORKER_URL no configurado en js/config.js'); return;
    }
    try {
      console.log('[Coach] 1/3 Pidiendo captura de pantalla...');
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
 
      if (displayStream.getAudioTracks().length === 0) {
        displayStream.getTracks().forEach(function (t) { t.stop(); });
        toast('Debes marcar "Compartir audio del tab"', 'error'); return;
      }
 
      console.log('[Coach] 2/3 Pidiendo permiso del mic...');
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } catch (e) { console.warn('[Coach] Sin mic:', e); micStream = null; }
 
      console.log('[Coach] 3/3 Registrando meeting...');
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
      startAudioCapture();
 
      displayStream.getVideoTracks()[0].onended = function () {
        toast('Captura detenida', 'warn'); end();
      };
      toast('Coach en vivo iniciado', 'success');
    } catch (e) {
      console.error('[Coach] Start error:', e);
      toast('Error iniciando coach: ' + e.message, 'error');
      cleanup();
    }
  }
 
  function startAudioCapture() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const tabAudio = new MediaStream(displayStream.getAudioTracks());
      const tabSource = audioCtx.createMediaStreamSource(tabAudio);
      const tabGain = audioCtx.createGain();
      tabGain.gain.value = 1.0;
      tabSource.connect(tabGain);
 
      const merger = audioCtx.createChannelMerger(2);
      tabGain.connect(merger, 0, 0);
 
      if (micStream) {
        const micSource = audioCtx.createMediaStreamSource(micStream);
        const micGain = audioCtx.createGain();
        micGain.gain.value = 0.8;
        micSource.connect(micGain);
        micGain.connect(merger, 0, 1);
      } else {
        const silent = audioCtx.createConstantSource();
        silent.offset.value = 0;
        silent.start();
        silent.connect(merger, 0, 1);
      }
 
      audioProcessor = audioCtx.createScriptProcessor(4096, 2, 2);
      audioProcessor.onaudioprocess = function (e) {
        if (!dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;
        const left = e.inputBuffer.getChannelData(0);
        const right = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : new Float32Array(left.length);
        const interleaved = new Int16Array(left.length * 2);
        for (let i = 0; i < left.length; i++) {
          const sL = Math.max(-1, Math.min(1, left[i]));
          const sR = Math.max(-1, Math.min(1, right[i]));
          interleaved[i*2] = sL < 0 ? sL * 0x8000 : sL * 0x7FFF;
          interleaved[i*2+1] = sR < 0 ? sR * 0x8000 : sR * 0x7FFF;
        }
        dgSocket.send(interleaved.buffer);
      };
 
      merger.connect(audioProcessor);
      audioProcessor.connect(audioCtx.destination);
    } catch (e) {
      console.error('[Coach] AudioContext error:', e);
      toast('Error de audio: ' + e.message, 'error');
    }
  }
 
  // ─── DEEPGRAM vía WORKER ───────────────────────────────────
  function connectDeepgram() {
    const params = [
      'model=nova-2-general', 'language=multi',
      'interim_results=true', 'endpointing=300',
      'utterance_end_ms=1000', 'smart_format=true', 'punctuate=true',
      'encoding=linear16', 'sample_rate=16000', 'channels=2', 'multichannel=true'
    ].join('&');
 
    const url = workerWsUrl('/deepgram?' + params);
    console.log('[Coach] Conectando al Worker...', url);
    dgSocket = new WebSocket(url);
 
    dgSocket.onopen = function () {
      console.log('[Coach] Worker WS abierto');
      setStatus('live');
    };
    dgSocket.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'Results') handleTranscript(msg);
        else if (msg.type === 'UtteranceEnd') handleUtteranceEnd();
      } catch (e) {}
    };
    dgSocket.onerror = function (e) {
      console.error('[Coach] WS error:', e);
      toast('Error de conexión al Worker', 'error');
    };
    dgSocket.onclose = function (e) {
      console.log('[Coach] WS cerrado:', e.code);
    };
  }
 
  function handleTranscript(msg) {
    const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
    if (!alt || !alt.transcript) return;
    const text = alt.transcript.trim();
    if (!text) return;
 
    const channelIdx = (msg.channel_index && msg.channel_index[0]) || 0;
    const speaker = channelIdx === 1 ? 'SDR' : 'Lead';
    const isFinal = msg.is_final;
    showInterim(speaker, text, isFinal);
 
    if (isFinal) {
      utteranceBuffer.push({ speaker: speaker, text: text, ts: new Date() });
      recentTranscript.push(speaker + ': ' + text);
      if (recentTranscript.length > 25) recentTranscript.shift();
      appendFinalToTranscript(speaker, text);
      enqueueChunkForBackend({ speaker: speaker, text: text, ts: new Date().toISOString() });
    }
  }
 
  function handleUtteranceEnd() {
    const trigger = cfg.COACH_TRIGGER_UTTERANCES || 2;
    if (utteranceBuffer.length >= trigger && !coachInFlight) runCoaching();
  }
 
  // ─── COACHING via WORKER ───────────────────────────────────
  async function runCoaching() {
    if (coachInFlight) return;
    coachInFlight = true;
    showThinking();
 
    const context = recentTranscript.slice(-15).join('\n');
    const systemPrompt = [
      'Eres el coach de ventas de Predictable.ai en vivo durante una llamada B2B.',
      'La conversación tiene 2 hablantes: "Lead" (prospecto) y "SDR" (vendedor).',
      'OUTPUT: SOLO JSON con schema:',
      '{',
      '  "alerts": [{',
      '    "type": "objection|positive_signal|risk|stage_guidance",',
      '    "title": "string corta",',
      '    "explanation": "máx 2 frases",',
      '    "suggested_phrase": "frase para que el SDR diga AHORA"',
      '  }],',
      '  "stage": "rapport|discovery|reframe|demo|negotiation|close",',
      '  "next_step": "1 acción inmediata"',
      '}',
      'Habla español neutro. NO inventes alertas.'
    ].join('\n');
 
    try {
      const resp = await fetch(workerUrl('/openai'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        console.error('Worker OpenAI ' + resp.status + ': ' + await resp.text());
        hideThinking(); coachInFlight = false; return;
      }
      const data = await resp.json();
      const content = data.choices && data.choices[0] && data.choices[0].message.content;
      if (!content) throw new Error('vacío');
      const parsed = JSON.parse(content);
      hideThinking();
      renderCoachOutput(parsed);
      enqueueEventForBackend(parsed);
      utteranceBuffer = [];
    } catch (e) {
      console.error('Coaching error', e);
      hideThinking();
    } finally { coachInFlight = false; }
  }
 
  // ─── Persistencia, UI, end(), cleanup() — IGUAL que antes ──
  function enqueueChunkForBackend(c) { chunkQueue.push(c); if (chunkQueue.length >= 3) flushChunks(); }
  async function flushChunks() {
    if (!currentMeetingId || chunkQueue.length === 0) return;
    const batch = chunkQueue.splice(0);
    try { await global.api.ingestLocalChunks({ meeting_id: currentMeetingId, chunks: batch }); }
    catch (e) { console.warn(e); chunkQueue = batch.concat(chunkQueue); }
  }
  async function enqueueEventForBackend(ev) {
    if (!currentMeetingId) return;
    try { await global.api.ingestLocalEvent({ meeting_id: currentMeetingId, event: ev }); }
    catch (e) {}
  }
 
  function clearUI() {
    const t = document.getElementById('mc-transcript'); if (t) t.innerHTML = '';
    const e = document.getElementById('mc-events');
    if (e) Array.from(e.querySelectorAll('.ai-alert-dynamic')).forEach(function (el) { el.remove(); });
    hideThinking();
  }
  function showInterim(speaker, text, isFinal) {
    const el = document.getElementById('mc-last-spoken');
    if (!el) return;
    const color = speaker === 'SDR' ? 'var(--green)' : 'var(--teal)';
    el.innerHTML =
      '<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">' +
      (isFinal ? 'Lo último que se dijo' : 'Escuchando...') + '</div>' +
      '<div style="font-size:15px;color:' + (isFinal ? 'var(--text)' : 'var(--text3)') +
      ';line-height:1.5;font-style:' + (isFinal ? 'normal' : 'italic') + '">' +
      '<strong style="color:' + color + '">' + esc(speaker) + ':</strong> ' + esc(text) + '</div>';
  }
  function appendFinalToTranscript(speaker, text) {
    const c = document.getElementById('mc-transcript'); if (!c) return;
    const color = speaker === 'SDR' ? 'var(--green)' : 'var(--teal)';
    const div = document.createElement('div');
    div.innerHTML = '<span style="color:' + color + ';font-weight:700">' + esc(speaker) + ':</span> <span style="color:var(--text2)">' + esc(text) + '</span>';
    c.appendChild(div);
    c.scrollTop = c.scrollHeight;
  }
  function renderCoachOutput(out) {
    const events = document.getElementById('mc-events'); if (!events) return;
    (out.alerts || []).forEach(function (a) { events.prepend(buildAlertCard(a)); });
    if (out.stage) {
      const stEl = document.getElementById('mc-stage');
      if (stEl) stEl.textContent = out.stage.charAt(0).toUpperCase() + out.stage.slice(1);
    }
    if (out.next_step) {
      const ns = document.getElementById('mc-next-steps');
      if (ns) ns.innerHTML = '<div style="font-size:12px;padding:6px 8px;background:var(--surface2);border-radius:6px">' + esc(out.next_step) + '</div>';
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
    el.id = 'mc-thinking'; el.className = 'ai-suggestion ai-alert-dynamic';
    el.style.cssText = 'border:1px dashed var(--teal);background:rgba(0,196,212,.05);animation:pulse 1.5s infinite';
    el.innerHTML = '<div class="ai-tag" style="color:var(--teal)">🧠 PROCESANDO</div>';
    const events = document.getElementById('mc-events'); if (events) events.prepend(el);
  }
  function hideThinking() { const el = document.getElementById('mc-thinking'); if (el) el.remove(); }
  function setStatus(s) {
    const el = document.getElementById('mc-status'); if (!el) return;
    const map = { connecting: 'Conectando al audio...', live: '🎙 Escuchando (tú + lead)', ended: 'Sesión finalizada' };
    el.textContent = map[s] || s;
  }
  function updateElapsed() {
    elapsedSeconds++;
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const el = document.getElementById('mc-timer');
    if (el) el.textContent = pad(Math.floor(elapsedSeconds/3600)) + ':' + pad(Math.floor((elapsedSeconds%3600)/60)) + ':' + pad(elapsedSeconds%60);
  }
  async function end() {
    await flushChunks();
    cleanup();
    setStatus('ended');
    if (currentMeetingId) {
      try {
        const final = await global.api.endMeeting({ meeting_id: currentMeetingId });
        toast('Sesión finalizada — score: ' + (final.score_total || 0), 'success');
        setTimeout(function () { if (typeof nav === 'function') nav(document.querySelector('[data-page=ventas-reportes]'), 'ventas-reportes'); }, 800);
      } catch (e) {}
    }
    currentMeetingId = null; active = false;
  }
  function cleanup() {
    if (audioProcessor) { try { audioProcessor.disconnect(); } catch(e){} audioProcessor = null; }
    if (audioCtx) { try { audioCtx.close(); } catch(e){} audioCtx = null; }
    if (displayStream) { displayStream.getTracks().forEach(function(t){t.stop();}); displayStream = null; }
    if (micStream) { micStream.getTracks().forEach(function(t){t.stop();}); micStream = null; }
    if (dgSocket) { try { dgSocket.close(); } catch(e){} dgSocket = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    utteranceBuffer = [];
  }
  function esc(s) {
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
 
  global.realtimeCoach = { start: start, end: end, isActive: function() { return active; } };
})(window);
