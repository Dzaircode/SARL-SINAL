import { onAuthStateChanged, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { auth } from "./firebase.js";

const form = document.querySelector("#login-form");
const message = document.querySelector("#login-message");
const button = form.querySelector('button[type="submit"]');

const ERROR_MESSAGES = {
  "auth/invalid-credential": "Adresse e-mail ou mot de passe incorrect.",
  "auth/invalid-login-credentials": "Adresse e-mail ou mot de passe incorrect.",
  "auth/wrong-password": "Mot de passe incorrect.",
  "auth/invalid-email": "Adresse e-mail invalide.",
  "auth/user-not-found": "Aucun utilisateur ne correspond à cette adresse e-mail.",
  "auth/user-disabled": "Ce compte est désactivé.",
  "auth/operation-not-allowed": "La connexion e-mail/mot de passe n’est pas activée dans Firebase Authentication.",
  "auth/too-many-requests": "Trop de tentatives. Réessayez plus tard.",
  "auth/network-request-failed": "Connexion impossible. Vérifiez votre connexion Internet."
};

onAuthStateChanged(auth, user => {
  if (user) window.location.replace("app.html");
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  message.textContent = "";
  button.disabled = true;
  try {
    await signInWithEmailAndPassword(
      auth,
      document.querySelector("#email").value.trim(),
      document.querySelector("#password").value
    );
    window.location.replace("app.html");
  } catch (error) {
    console.error(error);
    message.textContent = (ERROR_MESSAGES[error.code] || "Connexion impossible.") + ` (${error.code || error.message})`;
  } finally {
    button.disabled = false;
  }
});