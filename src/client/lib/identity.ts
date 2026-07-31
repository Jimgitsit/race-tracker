/**
 * Racer identity is a token in localStorage — no password (DESIGN §3.1).
 *
 * A `?t=` in the URL adopts an identity: that is how the director's re-link QR
 * restores someone who cleared their browser or switched phones. The parameter is
 * stripped from the address bar immediately so it can't be shared onward by
 * accident.
 */
const KEY = "race-tracker.token";

export function adoptTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("t");

  if (!token) {
    return;
  }

  localStorage.setItem(KEY, token);
  url.searchParams.delete("t");
  window.history.replaceState({}, "", url.toString());
}

export function getToken(): string | null {
  return localStorage.getItem(KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}
