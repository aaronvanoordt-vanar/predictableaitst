// js/config.js
// ───────────────────────────────────────────────────────────
// Configuración pública del frontend.
// Las API keys (Deepgram, OpenAI) NO van aquí — el repo es público.
// Se piden con prompt() al SDR la primera vez y se guardan en
// localStorage del navegador.
// ───────────────────────────────────────────────────────────
window.PREDICTABLE_CONFIG = {
  // Backend Apps Script
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxWQsb07WZxqbqld04M4rLIQRypONsY7s3EIczFBpV6PvIHDbSrSnfLp4nohLJTBG4jmw/exec",
 
  REQUEST_TIMEOUT_MS: 60000,
  APOLLO_DEFAULT_PER_PAGE: 25,
  CURRENT_USER_EMAIL: "aaronvanoordt@gmail.com",
 
  // ── Real-Time Coach ─────────────────────────────────────
  LLM_MODEL: "gpt-4o-mini",          // modelo para coaching live
  COACH_TRIGGER_UTTERANCES: 2,       // cuántas frases del lead antes de pedir coaching
};
