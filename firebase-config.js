// Firebase principal de EXPLORA — reutiliza la base histórica de Santander Main.
export const firebaseConfig = {
  apiKey: "AIzaSyDbTWF8fVVMMk2b8eWYv_0mHSl-AQmW2qs",
  authDomain: "explora-control-operativo.firebaseapp.com",
  projectId: "explora-control-operativo",
  storageBucket: "explora-control-operativo.firebasestorage.app",
  messagingSenderId: "708368554540",
  appId: "1:708368554540:web:05871472b575484bc98f89"
};

// Se conserva por compatibilidad con la interfaz nueva. Los datos operativos
// reales viven en las colecciones históricas de nivel raíz de EXPLORA.
export const BUSINESS_ID = "explora-control-operativo";
export const USER_EMAIL_DOMAIN = "explora.local";

// El login prioriza usuario@explora.local y luego consulta login_aliases.
// Se dejan aliases opcionales para accesos directos conocidos.
export const LOGIN_ALIASES = {};
