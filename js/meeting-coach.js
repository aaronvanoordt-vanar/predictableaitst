// js/meeting-coach.js
(function(global) {
  const { toast, setButtonLoading } = global.uiHelpers;
  let pollTimer = null;
  let currentMeetingId = null;
  let lastSeenTs = null;
  let elapsedSeconds = 0;
  let elapsedTimer = null;
 
  async function start(meetingUrl, prospectContext) {
    try {
      const res = await global.api.startMeeting({
        meeting_url: meetingUrl,
        prospect_id: prospectContext?.id,
        prospect_name: prospectContext?.name,
        context: prospectContext
      });
      currentMeetingId = res.meeting_id;
      lastSeenTs = null;
      elapsedSeconds = 0;
 
      // UI: cambiar el placeholder a "Bot conectándose..."
      setMeetingStatus('connecting');
 
      // Empezar polling cada 6s
      pollTimer = setInterval(poll, 4000);
      // Empezar timer
      elapsedTimer = setInterval(updateElapsed, 1000);
 
      toast('Bot lanzado a la reunión', 'success');
    } catch (e) {
      toast('Error iniciando reunión: ' + e.message, 'error');
    }
  }
 
  async function poll() {
    if (!currentMeetingId) return;
    try {
      const data = await global.api.getMeetingState({
        meeting_id: currentMeetingId,
        since_ts: lastSeenTs
      });
      lastSeenTs = data.server_ts;
 
      if (data.chunks?.length) renderTranscript(data.chunks);
      // Si hay chunks nuevos pero NO eventos nuevos, muestra "pensando"
      if (data.chunks?.length && !data.events?.length) {
        showThinking();
      }
      if (data.events?.length) {
        hideThinking();
      }
      if (data.events?.length) renderEvents(data.events);
      if (data.events?.length) {
        const latestState = data.events[data.events.length - 1].state;
        if (latestState) renderScores(latestState.scores);
      }
 
      setMeetingStatus(data.chunks?.length ? 'live' : 'connecting');
    } catch (e) {
      console.warn('Poll error', e);
    }
  }
 
  function renderTranscript(chunks) {
    const container = document.getElementById('mc-transcript');
    if (!container) return;
    chunks.forEach(c => {
      const div = document.createElement('div');
      div.innerHTML = '<span style="color:var(--teal);font-weight:700">' +
        escapeHTML(c.speaker) + ':</span> <span style="color:var(--text2)">' +
        escapeHTML(c.text) + '</span>';
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  }
 
  function renderEvents(events) {
    const container = document.getElementById('mc-events');
    if (!container) return;
    events.forEach(ev => {
      (ev.alerts || []).forEach(a => container.prepend(buildAlertCard(a)));
      if (ev.next_steps?.length) updateNextSteps(ev.next_steps, ev.state?.stage);
    });
  }
 
  function buildAlertCard(alert) {
    const card = document.createElement('div');
    card.className = 'ai-suggestion';
    const colorByType = {
      objection: 'var(--amber)',
      positive_signal: 'var(--green)',
      risk: 'var(--red)',
      stage_guidance: 'var(--gold)'
    };
    const color = colorByType[alert.type] || 'var(--teal)';
    card.style.cssText = 'border:2px solid ' + color + ';background:rgba(245,158,11,.06)';
    let html = '<div class="ai-tag" style="color:' + color + '">⚡ ' +
      escapeHTML(alert.title || alert.type.toUpperCase()) + '</div>' +
      '<div class="ai-text">' + escapeHTML(alert.explanation || '') + '</div>';
    if (alert.suggested_phrase) {
      const phrase = escapeHTML(alert.suggested_phrase);
      html += '<div style="background:var(--surface2);border-radius:6px;padding:10px;margin-top:8px;font-size:12px;line-height:1.7">' +
        '<strong style="color:' + color + '">Di esto:</strong><br>' + phrase + '</div>' +
        '<button class="ai-copy" data-phrase="' + phrase + '" onclick="navigator.clipboard.writeText(this.dataset.phrase); this.textContent=\'✓ Copiado\'">📋 Copiar</button>';
    }
    card.innerHTML = html;
    return card;
  }
 
  function renderScores(scores) {
    if (!scores) return;
    const map = {
      'mc-score-listening': scores.active_listening,
      'mc-score-pain': scores.pain_deepening,
      'mc-score-pace': scores.pace_control,
      'mc-score-objection': scores.objection_handling
    };
    Object.entries(map).forEach(([id, val]) => {
      if (val == null) return;
      const el = document.getElementById(id);
      if (!el) return;
      el.querySelector('.score-num').textContent = val + '%';
      el.querySelector('.score-fill').style.width = val + '%';
    });
  }
 
  function updateNextSteps(steps, stage) {
    const c = document.getElementById('mc-next-steps');
    if (!c) return;
    c.innerHTML = steps.map((s, i) =>
      '<div style="font-size:12px;padding:6px 8px;background:var(--surface2);border-radius:6px">' +
      (i+1) + '. ' + escapeHTML(s) + '</div>'
    ).join('');
    const stageEl = document.getElementById('mc-stage');
    if (stageEl && stage) stageEl.textContent = capitalize(stage);
  }
 
  function setMeetingStatus(status) {
    const el = document.getElementById('mc-status');
    if (!el) return;
    el.textContent = ({
      connecting: 'Bot conectándose...',
      live: '● Transcribiendo en vivo',
      ended: 'Reunión finalizada'
    })[status] || status;
  }
 
  function updateElapsed() {
    elapsedSeconds++;
    const h = Math.floor(elapsedSeconds/3600).toString().padStart(2,'0');
    const m = Math.floor((elapsedSeconds%3600)/60).toString().padStart(2,'0');
    const s = (elapsedSeconds%60).toString().padStart(2,'0');
    const el = document.getElementById('mc-timer');
    if (el) el.textContent = h + ':' + m + ':' + s;
  }
 
  async function end() {
    if (!currentMeetingId) return;
    clearInterval(pollTimer);
    clearInterval(elapsedTimer);
    try {
      const final = await global.api.endMeeting({ meeting_id: currentMeetingId });
      toast('Reunión finalizada — score: ' + final.score_total, 'success');
      setMeetingStatus('ended');
      // Redirigir a reportes
      setTimeout(() => {
        if (typeof nav === 'function') {
          nav(document.querySelector('[data-page=ventas-reportes]'), 'ventas-reportes');
        }
      }, 800);
    } catch (e) {
      toast('Error finalizando: ' + e.message, 'error');
    }
    currentMeetingId = null;
  }
 
  function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  }
  function capitalize(s) { return s.charAt(0).toUpperCase()+s.slice(1); }
 function showThinking() {
    let el = document.getElementById('mc-thinking');
    if (el) return; // ya está
    el = document.createElement('div');
    el.id = 'mc-thinking';
    el.className = 'ai-suggestion';
    el.style.cssText = 'border:1px dashed var(--teal);background:rgba(0,196,212,.05);animation:pulse 1.5s infinite';
    el.innerHTML = '<div class="ai-tag" style="color:var(--teal)">🧠 ANALIZANDO LO ÚLTIMO QUE SE DIJO</div><div class="ai-text" style="font-size:11px;color:var(--text3)">El coach está procesando la conversación...</div>';
    const events = document.getElementById('mc-events');
    if (events) events.prepend(el);
  }
  function hideThinking() {
    const el = document.getElementById('mc-thinking');
    if (el) el.remove();
  }
  global.meetingCoach = { start, end };
})(window);
 
