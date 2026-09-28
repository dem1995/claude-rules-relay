/**
 * Google sign-in for a desktop app: the OAuth authorization-code flow with PKCE and a loopback
 * redirect to 127.0.0.1, which is what Google documents for installed applications.
 *
 * The refresh token and the client secret live in VS Code's SecretStorage, which the operating
 * system's credential store encrypts. Neither is written to settings.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as vscode from 'vscode';
import { AccessTokenSource } from './drive';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

const REFRESH_TOKEN_KEY = 'rulesRelay.refreshToken';
const CLIENT_SECRET_KEY = 'rulesRelay.clientSecret';
const ACCOUNT_KEY = 'rulesRelay.account';

export class NotSignedInError extends Error {}

export interface OAuthClient {
    id: string;
    secret: string;
}

interface TokenResponse {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
}

export class GoogleAuth implements AccessTokenSource {
    private accessToken: string | undefined;
    private expiresAt = 0;

    constructor(
        private readonly secrets: vscode.SecretStorage,
        /** The OAuth client to use: a bundled one, or one the user configured. */
        private readonly client: () => Promise<OAuthClient | undefined>,
    ) {}

    async isSignedIn(): Promise<boolean> {
        return (await this.secrets.get(REFRESH_TOKEN_KEY)) !== undefined;
    }

    async account(): Promise<string | undefined> {
        return this.secrets.get(ACCOUNT_KEY);
    }

    async storedClientSecret(): Promise<string | undefined> {
        return this.secrets.get(CLIENT_SECRET_KEY);
    }

    async storeClientSecret(secret: string): Promise<void> {
        await this.secrets.store(CLIENT_SECRET_KEY, secret);
    }

    invalidate(): void {
        this.accessToken = undefined;
        this.expiresAt = 0;
    }

    async getAccessToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
            return this.accessToken;
        }
        const refreshToken = await this.secrets.get(REFRESH_TOKEN_KEY);
        const client = await this.client();
        if (!refreshToken || !client) {
            throw new NotSignedInError('Not signed in to Google Drive.');
        }
        const tokens = await postToken({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: client.id,
            client_secret: client.secret,
        });
        if (tokens.error === 'invalid_grant' || tokens.error === 'invalid_client') {
            // Revoked, expired, or issued to a different client. Only a new sign-in can fix it.
            await this.forgetSession();
            throw new NotSignedInError('Your Google sign-in has expired. Sign in again.');
        }
        this.remember(tokens);
        return this.accessToken!;
    }

    /** Run the browser sign-in and store the resulting refresh token. Returns the account email. */
    async signIn(client: OAuthClient, cancel: vscode.CancellationToken): Promise<string | undefined> {
        const verifier = base64url(crypto.randomBytes(32));
        const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
        const state = base64url(crypto.randomBytes(16));

        const { code, redirectUri } = await waitForRedirect(state, cancel, (redirect) => {
            const params = new URLSearchParams({
                client_id: client.id,
                redirect_uri: redirect,
                response_type: 'code',
                scope: SCOPES,
                code_challenge: challenge,
                code_challenge_method: 'S256',
                state,
                // Ask for a refresh token every time, so signing in again always yields one.
                access_type: 'offline',
                prompt: 'consent',
            });
            void vscode.env.openExternal(vscode.Uri.parse(`${AUTH_URL}?${params}`));
        });

        const tokens = await postToken({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            client_id: client.id,
            client_secret: client.secret,
        });
        if (tokens.error === 'invalid_client') {
            // Forget the secret so the next sign-in asks for it again.
            await this.secrets.delete(CLIENT_SECRET_KEY);
            throw new Error(
                'Google rejected the OAuth client. Check the client ID setting, then sign in again and re-enter the secret.',
            );
        }
        if (tokens.error || !tokens.refresh_token) {
            throw new Error(`Google sign-in failed: ${tokens.error_description ?? tokens.error ?? 'no refresh token'}`);
        }
        await this.secrets.store(REFRESH_TOKEN_KEY, tokens.refresh_token);
        this.remember(tokens);

        const email = emailFromIdToken(tokens.id_token);
        if (email) {
            await this.secrets.store(ACCOUNT_KEY, email);
        }
        return email;
    }

    /** Revoke the refresh token with Google (best effort) and forget it locally. */
    async signOut(): Promise<void> {
        const refreshToken = await this.secrets.get(REFRESH_TOKEN_KEY);
        if (refreshToken) {
            try {
                await fetch(REVOKE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ token: refreshToken }),
                });
            } catch {
                // Offline: the token is still forgotten locally, and Google expires unused tokens.
            }
        }
        await this.forgetSession();
    }

    private async forgetSession(): Promise<void> {
        this.invalidate();
        await this.secrets.delete(REFRESH_TOKEN_KEY);
        await this.secrets.delete(ACCOUNT_KEY);
    }

    private remember(tokens: TokenResponse): void {
        if (tokens.error || !tokens.access_token) {
            throw new Error(`Google token request failed: ${tokens.error_description ?? tokens.error}`);
        }
        this.accessToken = tokens.access_token;
        this.expiresAt = Date.now() + tokens.expires_in * 1000;
    }
}

async function postToken(form: Record<string, string>): Promise<TokenResponse> {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
    });
    // Google answers a bad grant with a 400 and a JSON error, so the body is parsed regardless of
    // status, and only a body that is not JSON at all is reported by status.
    const text = await response.text();
    try {
        return JSON.parse(text) as TokenResponse;
    } catch {
        throw new Error(`Google's sign-in service returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
}

/**
 * Listen on a free loopback port, call `open` with the redirect URI, and resolve with the
 * authorization code once Google redirects the browser back to us.
 */
function waitForRedirect(
    state: string,
    cancel: vscode.CancellationToken,
    open: (redirectUri: string) => void,
): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
        let redirectUri = '';
        const server = http.createServer((request, response) => {
            const url = new URL(request.url ?? '/', redirectUri);
            if (url.pathname !== '/') {
                response.writeHead(404).end();
                return;
            }
            const error = url.searchParams.get('error');
            const code = url.searchParams.get('code');
            const ok = !error && code && url.searchParams.get('state') === state;
            response.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(page(ok ? 'Signed in. You can close this tab and return to VS Code.' : 'Sign-in failed. Return to VS Code and try again.'));
            if (ok) {
                finish(() => resolve({ code: code!, redirectUri }));
            } else {
                finish(() => reject(new Error(`Google sign-in failed: ${error ?? 'the response did not match this request'}`)));
            }
        });

        const timer = setTimeout(() => finish(() => reject(new Error('Google sign-in timed out.'))), SIGN_IN_TIMEOUT_MS);
        const cancelled = cancel.onCancellationRequested(() => finish(() => reject(new vscode.CancellationError())));

        let settled = false;
        function finish(settle: () => void): void {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            cancelled.dispose();
            server.close();
            settle();
        }

        server.on('error', (error) => finish(() => reject(error)));
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address === null || typeof address === 'string') {
                finish(() => reject(new Error('Could not open a local port for the sign-in redirect.')));
                return;
            }
            redirectUri = `http://127.0.0.1:${address.port}`;
            open(redirectUri);
        });
    });
}

function page(message: string): string {
    return `<!doctype html><meta charset="utf-8"><title>Rules Relay</title>` +
        `<body style="font-family: system-ui, sans-serif; margin: 3rem">${message}</body>`;
}

function emailFromIdToken(idToken: string | undefined): string | undefined {
    if (!idToken) {
        return undefined;
    }
    try {
        // The token came straight from Google's token endpoint over TLS, so its payload is
        // read for display without verifying the signature.
        const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
        return typeof payload.email === 'string' ? payload.email : undefined;
    } catch {
        return undefined;
    }
}

function base64url(data: Buffer): string {
    return data.toString('base64url');
}
