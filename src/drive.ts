/**
 * A RemoteStore backed by one folder at the top of the user's Google Drive, using the Drive v3
 * REST API directly.
 *
 * The extension asks only for the `drive.file` scope, so Drive shows it the files and folders it
 * created itself and nothing else in the user's Drive.
 */
import * as crypto from 'node:crypto';
import { isSafeName, RemoteFile, RemoteStore } from './sync';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface AccessTokenSource {
    getAccessToken(): Promise<string>;
    /** Forget a cached token that Drive rejected, so the next call refreshes it. */
    invalidate(): void;
}

interface DriveListing {
    nextPageToken?: string;
    files: { id: string; name: string; mimeType: string; md5Checksum?: string }[];
}

export class DriveStore implements RemoteStore {
    /** Relative folder path -> Drive folder id. The synced folder itself is ''. */
    private readonly folders = new Map<string, string>();

    constructor(
        private readonly auth: AccessTokenSource,
        private readonly folderName: string,
        private readonly log: (message: string) => void,
    ) {}

    /** Find the synced folder at the top of Drive, creating it on first use, and return its id. */
    async resolveRoot(): Promise<string> {
        const existing = this.folders.get('');
        if (existing) {
            return existing;
        }
        const query =
            `name = '${escapeQuery(this.folderName)}' and mimeType = '${FOLDER_MIME}' ` +
            `and 'root' in parents and trashed = false`;
        const found = await this.listPage(query, undefined, 'createdTime');
        let id: string;
        if (found.files.length > 0) {
            if (found.files.length > 1) {
                this.log(`Found ${found.files.length} Drive folders named ${this.folderName}; using the oldest.`);
            }
            id = found.files[0].id;
        } else {
            id = await this.createFolder(this.folderName, 'root');
            this.log(`Created the Drive folder ${this.folderName}`);
        }
        this.folders.set('', id);
        return id;
    }

    async list(): Promise<Map<string, RemoteFile>> {
        const files = new Map<string, RemoteFile>();
        const pending: [string, string][] = [['', await this.resolveRoot()]];

        while (pending.length > 0) {
            const [prefix, folderId] = pending.shift()!;
            let pageToken: string | undefined;
            do {
                const page = await this.listPage(`'${folderId}' in parents and trashed = false`, pageToken);
                for (const file of page.files) {
                    const rel = prefix ? `${prefix}/${file.name}` : file.name;
                    if (!isSafeName(file.name)) {
                        this.log(`Ignoring ${rel} in Drive: the name cannot be used as a local file name.`);
                    } else if (file.mimeType === FOLDER_MIME) {
                        this.folders.set(rel, file.id);
                        pending.push([rel, file.id]);
                    } else if (!file.md5Checksum) {
                        this.log(`Ignoring ${rel} in Drive: Google Docs files and shortcuts cannot be synced.`);
                    } else if (files.has(rel)) {
                        this.log(`Ignoring a second Drive file at ${rel}; rename or remove one of them.`);
                    } else {
                        files.set(rel, { id: file.id, md5: file.md5Checksum });
                    }
                }
                pageToken = page.nextPageToken;
            } while (pageToken);
        }
        return files;
    }

    async download(id: string): Promise<Uint8Array> {
        const response = await this.request(`${API}/files/${id}?alt=media`);
        return new Uint8Array(await response.arrayBuffer());
    }

    async create(relPath: string, data: Uint8Array): Promise<RemoteFile> {
        const parts = relPath.split('/');
        const name = parts.pop()!;
        const parent = await this.ensureFolder(parts);
        const boundary = `rules-relay-${crypto.randomUUID()}`;
        const metadata = JSON.stringify({ name, parents: [parent] });
        const body = Buffer.concat([
            Buffer.from(
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
                    `--${boundary}\r\nContent-Type: ${mimeType(name)}\r\n\r\n`,
            ),
            Buffer.from(data),
            Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const response = await this.request(`${UPLOAD_API}/files?uploadType=multipart&fields=id,md5Checksum`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body,
        });
        return toRemoteFile(await response.json());
    }

    async update(id: string, data: Uint8Array): Promise<RemoteFile> {
        const response = await this.request(`${UPLOAD_API}/files/${id}?uploadType=media&fields=id,md5Checksum`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: Buffer.from(data),
        });
        return toRemoteFile(await response.json());
    }

    async trash(id: string): Promise<void> {
        await this.request(`${API}/files/${id}?fields=id`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trashed: true }),
        });
    }

    /** Return the id of the folder at `parts` under the synced folder, creating missing levels. */
    private async ensureFolder(parts: string[]): Promise<string> {
        let current = await this.resolveRoot();
        for (let i = 0; i < parts.length; i++) {
            const rel = parts.slice(0, i + 1).join('/');
            let id = this.folders.get(rel);
            if (!id) {
                id = await this.createFolder(parts[i], current);
                this.folders.set(rel, id);
            }
            current = id;
        }
        return current;
    }

    private async createFolder(name: string, parent: string): Promise<string> {
        const response = await this.request(`${API}/files?fields=id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
        });
        return ((await response.json()) as { id: string }).id;
    }

    private async listPage(query: string, pageToken?: string, orderBy?: string): Promise<DriveListing> {
        const params = new URLSearchParams({
            q: query,
            fields: 'nextPageToken, files(id, name, mimeType, md5Checksum)',
            pageSize: '1000',
            spaces: 'drive',
        });
        if (pageToken) {
            params.set('pageToken', pageToken);
        }
        if (orderBy) {
            params.set('orderBy', orderBy);
        }
        const response = await this.request(`${API}/files?${params}`);
        return (await response.json()) as DriveListing;
    }

    /**
     * Send an authorized request. A rejected token is refreshed once, and rate limits and server
     * errors are retried with backoff.
     */
    private async request(url: string, init: RequestInit = {}): Promise<Response> {
        let refreshed = false;
        for (let attempt = 0; ; attempt++) {
            const token = await this.auth.getAccessToken();
            const response = await fetch(url, {
                ...init,
                headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                return response;
            }
            if (response.status === 401 && !refreshed) {
                refreshed = true;
                this.auth.invalidate();
                continue;
            }
            if (RETRYABLE.has(response.status) && attempt < 4) {
                await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
                continue;
            }
            throw new Error(`Google Drive returned ${response.status}: ${await errorMessage(response)}`);
        }
    }
}

function toRemoteFile(json: unknown): RemoteFile {
    const file = json as { id: string; md5Checksum: string };
    return { id: file.id, md5: file.md5Checksum };
}

async function errorMessage(response: Response): Promise<string> {
    const text = await response.text();
    try {
        return (JSON.parse(text) as { error: { message: string } }).error.message;
    } catch {
        return text || response.statusText;
    }
}

function escapeQuery(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function mimeType(name: string): string {
    if (/\.md$/i.test(name)) {
        return 'text/markdown';
    }
    if (/\.txt$/i.test(name)) {
        return 'text/plain';
    }
    return 'application/octet-stream';
}
