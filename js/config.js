// js/config.js
// ───────────────────────────────────────────────────────────
// Única cosa que tienes que editar cuando despliegues el Apps
// Script: pega aquí la URL /exec que te da Google al publicar
// como Web App.
// ───────────────────────────────────────────────────────────
window.PREDICTABLE_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxWQsb07WZxqbqld04M4rLIQRypONsY7s3EIczFBpV6PvIHDbSrSnfLp4nohLJTBG4jmw/exec",

  // Timeout defensivo para llamadas (ms)
  REQUEST_TIMEOUT_MS: 60000,

  // Tamaño de página por defecto en búsquedas Apollo
  APOLLO_DEFAULT_PER_PAGE: 25,

  // Email del usuario actual (se puede sobreescribir desde el login real)
  CURRENT_USER_EMAIL: "aaronvanoordt@gmail.com",
};
