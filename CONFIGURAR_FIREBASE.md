# Conectar República Argentina con Firebase

Esta versión ya tiene código para:

- Firebase Authentication
- Firestore en tiempo real
- Firebase Storage para comprobantes
- Pedido de cierre guardado en Firestore

## 1. Crear o elegir proyecto Firebase

Entrá a Firebase Console y creá un proyecto para la barbería, por ejemplo:

`republica-argentina-barberia`

## 2. Crear una app Web

En Configuración del proyecto > Tus apps > Web, registrá una app Web.

Firebase te mostrará algo parecido a:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

Copiá esos valores dentro de `firebase-config.js`.

## 3. Authentication

Firebase Console > Authentication > Sign-in method

Activá:

- Email/Password

La interfaz permite ingresar con el correo completo o con un usuario simple.

Para el usuario principal de esta versión, tanto `barberia` como
`barberia@gmail.com` intentan acceder al mismo usuario de Authentication.

Internamente se convierte en:

`barbero01@republica-argentina.local`

Entonces, en Authentication > Users, creá al empleado con ese email y la contraseña que quieras.

Ejemplo:

- Usuario en la app: `barbero01`
- Email que creás en Firebase: `barbero01@republica-argentina.local`
- Contraseña: la que vos elijas

El alias principal se configura en `LOGIN_ALIASES`, dentro de
`firebase-config.js`. No se guarda ninguna contraseña en los archivos de la app.

## 4. Firestore

Creá Firestore Database.

Después publicá el contenido de `firestore.rules`.

Los datos se guardan así:

`businesses/republica-argentina/users/{uid}/payments`

y los cierres en:

`businesses/republica-argentina/users/{uid}/closures`

## 5. Storage

Activá Firebase Storage.

Publicá el contenido de `storage.rules`.

Los comprobantes se guardan dentro de una carpeta privada por usuario.

## 6. Dominio autorizado

En Authentication > Settings > Authorized domains agregá tu dominio de GitHub Pages si no aparece automáticamente:

`davidmanu97bj-lgtm.github.io`

## 7. Subir al GitHub

Subí estos archivos al repositorio:

- `index.html`
- `app.js`
- `styles.css`
- `firebase-config.js`

Los archivos `.rules` y `firebase.json` no necesitan estar publicados en GitHub Pages para que la web funcione, pero conviene guardarlos en el repo.

## Importante

La configuración web de Firebase no es una contraseña secreta. La seguridad real está en Authentication y en las Rules.

Esta primera versión hace que cada empleado vea únicamente sus propios cobros y cierres. Después se puede agregar un usuario administrador para ver toda la barbería.

## Cierres semanales de Uber

La app guarda un comprobante semanal de Uber por usuario en:

`businesses/{businessId}/users/{uid}/uber/{YYYY-Www}`

El identificador de semana evita que el mismo usuario cargue más de un comprobante para la misma semana. El cierre de Uber impacta el día en que se registra: suma al lado Efectivo/chofer y el 5% de caja chica se calcula sobre `Efectivo + Uber`.

Si ya tenías Firebase configurado, vuelve a desplegar `firestore.rules` para habilitar la colección `uber`.
