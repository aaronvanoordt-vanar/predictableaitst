// js/config.js
window.PREDICTABLE_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxWQsb07WZxqbqld04M4rLIQRypONsY7s3EIczFBpV6PvIHDbSrSnfLp4nohLJTBG4jmw/exec",
 
  REQUEST_TIMEOUT_MS: 60000,
  APOLLO_DEFAULT_PER_PAGE: 25,
  CURRENT_USER_EMAIL: "aaronvanoordt@gmail.com",
 
  // ── Real-Time Coach (NUEVO) ──
  // URL de tu Cloudflare Worker (reemplaza TU-USUARIO)
  WORKER_URL: "https://predictable-coach-proxy.aaron-78b.workers.dev/",
  LLM_MODEL: "gpt-4o-mini",
  COACH_TRIGGER_UTTERANCES: 2,
};
