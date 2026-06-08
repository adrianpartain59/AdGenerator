// ============================================================================
//  Authentication — email + password via Supabase, with a full-screen sign-in
//  gate. The app requires an account: nothing behind the gate renders until a
//  session exists. Adapted from the Mockup repo's auth flow.
// ============================================================================
import { supabase, isConfigured } from "./supabaseClient.js";

let currentSession = null;
const listeners = new Set();

export function getSession() {
  return currentSession;
}
export function getUser() {
  return currentSession?.user ?? null;
}

// Subscribe to auth changes; returns an unsubscribe fn. Fires immediately with
// the current session so callers don't need a separate initial read.
export function onAuthChange(fn) {
  listeners.add(fn);
  fn(currentSession);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(currentSession);
}

export async function signOut() {
  await supabase.auth.signOut();
}

// --------------------------------------------------------------------------
//  The gate overlay. Built once and shown/hidden based on session state.
// --------------------------------------------------------------------------
function buildGate() {
  const gate = document.createElement("div");
  gate.className = "auth-gate";
  gate.innerHTML = `
    <div class="auth-card">
      <div class="auth-brand">AI Ad Studio</div>
      <p class="auth-tagline">Sign in to generate, edit, and save your ads.</p>
      <input id="authEmail" class="auth-field" type="email" placeholder="email"
             autocomplete="username" />
      <input id="authPassword" class="auth-field" type="password" placeholder="password"
             autocomplete="current-password" />
      <div class="auth-actions">
        <button id="authSignIn" class="btn primary">Sign in</button>
        <button id="authSignUp" class="btn">Create account</button>
      </div>
      <div id="authNote" class="auth-note"></div>
    </div>`;
  document.body.appendChild(gate);

  const email = gate.querySelector("#authEmail");
  const password = gate.querySelector("#authPassword");
  const note = gate.querySelector("#authNote");
  const setNote = (m, err = false) => {
    note.textContent = m || "";
    note.classList.toggle("error", !!err);
  };

  if (!isConfigured) {
    setNote(
      "Supabase isn't configured yet — add your project URL + anon key in src/supabaseClient.js.",
      true
    );
    gate.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
  }

  gate.querySelector("#authSignIn").addEventListener("click", async () => {
    setNote("Signing in…");
    const { error } = await supabase.auth.signInWithPassword({
      email: email.value.trim(),
      password: password.value,
    });
    if (error) setNote(error.message, true);
  });

  gate.querySelector("#authSignUp").addEventListener("click", async () => {
    setNote("Creating account…");
    const { data, error } = await supabase.auth.signUp({
      email: email.value.trim(),
      password: password.value,
    });
    if (error) return setNote(error.message, true);
    setNote(
      data.session
        ? "Account created — signing you in…"
        : "Account created. Check your email to confirm, then sign in."
    );
  });

  password.addEventListener("keydown", (e) => {
    if (e.key === "Enter") gate.querySelector("#authSignIn").click();
  });

  return gate;
}

let gateEl = null;
function showGate(show) {
  if (!gateEl) gateEl = buildGate();
  gateEl.hidden = !show;
  document.body.classList.toggle("signed-out", show);
}

// --------------------------------------------------------------------------
//  Wire up Supabase auth state → gate + listeners. Call once on boot.
// --------------------------------------------------------------------------
export async function initAuth() {
  // Without real credentials there's no point hitting the network — just show
  // the gate (with its setup hint) and stop.
  if (!isConfigured) {
    showGate(true);
    emit();
    return null;
  }
  supabase.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
    showGate(!session);
    emit();
  });
  const { data } = await supabase.auth.getSession();
  currentSession = data.session;
  showGate(!currentSession);
  emit();
  return currentSession;
}
