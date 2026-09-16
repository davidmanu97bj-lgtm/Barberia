// Start email/password session restoration before the large dashboard modules.
// No popup/redirect resolver: Explora does not use federated popup/redirect login.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  initializeAuth, browserLocalPersistence, indexedDBLocalPersistence,
  browserSessionPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js?v=20260824-15";

export const app = initializeApp(firebaseConfig);
export const auth = initializeAuth(app, {
  // Keep legacy IndexedDB sessions readable; use local storage first for new ones.
  persistence: [browserLocalPersistence, indexedDBLocalPersistence, browserSessionPersistence, inMemoryPersistence]
});
export const authReady = auth.authStateReady();
