/**
 * auto/lib/sanitize-env.mjs — import FIRST from every auto/ entrypoint.
 *
 * The user's interactive shell exports SSL_CERT_FILE=~/.codex/glm-gateway-tls.crt
 * (a single leaf cert for an unrelated local gateway). OpenSSL treats that file
 * as the ENTIRE trust store, so every Node fetch to a public ATS API fails with
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY while curl (macOS keychain) works —
 * diagnosed 2026-10-07 against boards-api.greenhouse.io.
 *
 * The auto layer only talks to public ATS endpoints with publicly trusted
 * chains, so it never needs a custom trust store: drop the override before the
 * first TLS use. Spawned children (ollama-eval.mjs, the headless agent)
 * inherit the sanitized environment.
 */

for (const key of ['SSL_CERT_FILE', 'SSL_CERT_DIR']) {
  if (process.env[key]) {
    console.warn(`auto: unsetting ${key}=${process.env[key]} (would replace the default CA store and break ATS API fetches)`);
    delete process.env[key];
  }
}
