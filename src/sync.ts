/**
 * Three-way sync between a local folder and a remote store.
 *
 * Each machine keeps a "base": the MD5 of every file as it was when both sides last agreed.
 * Comparing the local and remote copies against the base tells us which side changed, so an
 * edit made on another machine is never overwritten by a stale local copy.
 *
 * Nothing here depends on VS Code, so the whole engine runs under plain Node in the tests.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type Mode = 'push' | 'pull' | 'sync';

/** Relative path (with `/` separators) -> MD5 at the last point both sides agreed. */
export type Base = Record<string, string>;

export interface RemoteFile {
    id: string;
    md5: string;
}

/** The operations the engine needs from a remote folder. Paths are relative, with `/`. */
export interface RemoteStore {
    list(): Promise<Map<string, RemoteFile>>;
    download(id: string): Promise<Uint8Array>;
    create(relPath: string, data: Uint8Array): Promise<RemoteFile>;
    update(id: string, data: Uint8Array): Promise<RemoteFile>;
    trash(id: string): Promise<void>;
}

export type ActionKind =
    | 'upload'
    | 'download'
    | 'trashRemote'
    | 'trashLocal'
    | 'keepLocal'
    | 'keepRemote'
    | 'record'
    | 'forget'
    | 'skip';

export interface Action {
    kind: ActionKind;
    path: string;
    reason?: string;
}

export interface Summary {
    uploaded: string[];
    downloaded: string[];
    trashedRemote: string[];
    trashedLocal: string[];
    /** Conflict copies written next to the original, as relative paths. */
    conflictCopies: string[];
    skipped: Action[];
    failed: { path: string; error: string }[];
}

// Conflict copies end in a timestamp instead of `.md`, so Claude Code does not load them as
// rules, and they are never synced.
const CONFLICT_SUFFIX = /\.(drive|local)-conflict-\d{8}T\d{6}$/;
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export function isSyncable(relPath: string): boolean {
    const name = relPath.split('/').pop() ?? '';
    return !IGNORED_NAMES.has(name) && !CONFLICT_SUFFIX.test(name);
}

/**
 * Check that a single path component is safe to create on Windows, macOS, and Linux.
 *
 * Remote names come from Drive, which allows almost anything, so this also stops a name such as
 * `..` from writing outside the synced folder.
 */
export function isSafeName(name: string): boolean {
    return (
        name.length > 0 &&
        name !== '.' &&
        name !== '..' &&
        !/[\\/:*?"<>|\x00-\x1f]/.test(name) &&
        !/[. ]$/.test(name)
    );
}

export function md5(data: Uint8Array): string {
    return crypto.createHash('md5').update(data).digest('hex');
}

/** Call `visit` for every regular file under `root`, with its `/`-separated relative path. */
async function walkFiles(root: string, visit: (rel: string, abs: string) => Promise<void>): Promise<void> {
    async function walk(dir: string, prefix: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return;
            }
            throw error;
        }
        for (const entry of entries) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(abs, rel);
            } else if (entry.isFile()) {
                await visit(rel, abs);
            }
        }
    }
    await walk(root, '');
}

/** Return the MD5 of every syncable file under `root`, keyed by relative path. */
export async function scanLocal(root: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    await walkFiles(root, async (rel, abs) => {
        if (isSyncable(rel)) {
            result.set(rel, md5(await fs.readFile(abs)));
        }
    });
    return result;
}

export interface ConflictCopy {
    /** Relative path of the copy itself. */
    path: string;
    /** Relative path of the file it is a copy of. */
    original: string;
    /** Which side's version the copy holds. */
    side: 'drive' | 'local';
    /** When the copy was made, as `YYYYMMDDTHHMMSS` in UTC. */
    stamp: string;
}

const CONFLICT_COPY = /^(.*)\.(drive|local)-conflict-(\d{8}T\d{6})$/;

/** Return every conflict copy under `root`, oldest first. */
export async function listConflictCopies(root: string): Promise<ConflictCopy[]> {
    const copies: ConflictCopy[] = [];
    await walkFiles(root, async (rel) => {
        const match = CONFLICT_COPY.exec(rel);
        if (match) {
            copies.push({ path: rel, original: match[1], side: match[2] as 'drive' | 'local', stamp: match[3] });
        }
    });
    return copies.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.path.localeCompare(b.path));
}

export type FileStatus =
    | 'inSync'
    | 'newLocal'
    | 'localChange'
    | 'localDelete'
    | 'newRemote'
    | 'remoteChange'
    | 'remoteDelete'
    | 'conflict';

export interface FileState {
    path: string;
    status: FileStatus;
    /** Whether the file exists in the local folder right now. */
    local: boolean;
}

/** Describe every file by what the next sync would do with it, without changing anything. */
export function fileStates(local: Map<string, string>, remote: Map<string, string>, base: Base): FileState[] {
    const actions = new Map(plan(local, remote, base, 'sync').map((action) => [action.path, action]));
    const paths = [...new Set([...local.keys(), ...remote.keys()])].filter(isSyncable).sort();

    return paths.map((p) => {
        const isNew = base[p] === undefined;
        let status: FileStatus;
        switch (actions.get(p)?.kind) {
            case 'upload':
                status = isNew ? 'newLocal' : 'localChange';
                break;
            case 'download':
                status = isNew ? 'newRemote' : 'remoteChange';
                break;
            case 'trashRemote':
                status = 'localDelete';
                break;
            case 'trashLocal':
                status = 'remoteDelete';
                break;
            case 'keepLocal':
                status = 'conflict';
                break;
            default:
                status = 'inSync';
        }
        return { path: p, status, local: local.has(p) };
    });
}

/**
 * Decide what to do with every path, given both sides and the base.
 *
 * Push only sends local changes and pull only fetches remote ones, while sync does both. When
 * both sides edited the same file, the side the command favours wins (local for push and sync,
 * remote for pull), and the other version is kept as a conflict copy. When one side deleted a file
 * that the other side edited, the edit wins, because a deletion is easier to redo than lost work.
 */
export function plan(
    local: Map<string, string>,
    remote: Map<string, string>,
    base: Base,
    mode: Mode,
): Action[] {
    const canPush = mode !== 'pull';
    const canPull = mode !== 'push';
    const paths = new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)]);
    const actions: Action[] = [];

    for (const p of [...paths].filter(isSyncable).sort()) {
        const l = local.get(p);
        const r = remote.get(p);
        const b = base[p];

        if (l === r) {
            if (l === undefined) {
                actions.push({ kind: 'forget', path: p });
            } else if (b !== l) {
                actions.push({ kind: 'record', path: p });
            }
            continue;
        }

        const localChanged = l !== b;
        const remoteChanged = r !== b;

        if (!remoteChanged) {
            actions.push(
                canPush
                    ? { kind: l === undefined ? 'trashRemote' : 'upload', path: p }
                    : skip(p, 'changed locally; push or sync to send it'),
            );
        } else if (!localChanged) {
            actions.push(
                canPull
                    ? { kind: r === undefined ? 'trashLocal' : 'download', path: p }
                    : skip(p, 'changed in Drive; pull or sync to get it'),
            );
        } else if (l === undefined) {
            actions.push(
                canPull
                    ? { kind: 'download', path: p }
                    : skip(p, 'deleted locally but edited in Drive; pull or sync to restore it'),
            );
        } else if (r === undefined) {
            actions.push(
                canPush
                    ? { kind: 'upload', path: p }
                    : skip(p, 'deleted in Drive but edited locally; push or sync to restore it'),
            );
        } else {
            actions.push({ kind: mode === 'pull' ? 'keepRemote' : 'keepLocal', path: p });
        }
    }
    return actions;
}

function skip(p: string, reason: string): Action {
    return { kind: 'skip', path: p, reason };
}

export interface ApplyOptions {
    root: string;
    remote: RemoteStore;
    /** The remote listing the plan was made from. Updated as files are created. */
    remoteFiles: Map<string, RemoteFile>;
    /** Updated in place after each successful action, so a partial run keeps its progress. */
    base: Base;
    trashLocal(absPath: string): Promise<void>;
    log(message: string): void;
    now?: Date;
}

export async function applyPlan(actions: Action[], options: ApplyOptions): Promise<Summary> {
    const { root, remote, remoteFiles, base, log } = options;
    const stamp = timestamp(options.now ?? new Date());
    const summary: Summary = {
        uploaded: [],
        downloaded: [],
        trashedRemote: [],
        trashedLocal: [],
        conflictCopies: [],
        skipped: [],
        failed: [],
    };

    const absolute = (rel: string): string => {
        const abs = path.resolve(root, ...rel.split('/'));
        const relative = path.relative(path.resolve(root), abs);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`refusing to write outside the synced folder: ${rel}`);
        }
        return abs;
    };

    const writeLocal = async (rel: string, data: Uint8Array): Promise<void> => {
        const abs = absolute(rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, data);
    };

    const upload = async (rel: string): Promise<void> => {
        const data = await fs.readFile(absolute(rel));
        const existing = remoteFiles.get(rel);
        const written = existing ? await remote.update(existing.id, data) : await remote.create(rel, data);
        if (written.md5 !== md5(data)) {
            throw new Error('the uploaded file does not match the local copy');
        }
        remoteFiles.set(rel, written);
        base[rel] = written.md5;
    };

    const fetchRemote = async (rel: string): Promise<Uint8Array> => {
        const file = remoteFiles.get(rel);
        if (!file) {
            throw new Error('the file is no longer in Drive');
        }
        const data = await remote.download(file.id);
        if (md5(data) !== file.md5) {
            throw new Error('the downloaded file does not match its Drive checksum');
        }
        return data;
    };

    for (const action of actions) {
        const p = action.path;
        try {
            switch (action.kind) {
                case 'upload':
                    await upload(p);
                    summary.uploaded.push(p);
                    log(`Uploaded ${p}`);
                    break;
                case 'download': {
                    const data = await fetchRemote(p);
                    await writeLocal(p, data);
                    base[p] = md5(data);
                    summary.downloaded.push(p);
                    log(`Downloaded ${p}`);
                    break;
                }
                case 'trashRemote': {
                    const file = remoteFiles.get(p);
                    if (file) {
                        await remote.trash(file.id);
                        remoteFiles.delete(p);
                    }
                    delete base[p];
                    summary.trashedRemote.push(p);
                    log(`Moved ${p} to the Drive trash`);
                    break;
                }
                case 'trashLocal':
                    await options.trashLocal(absolute(p));
                    delete base[p];
                    summary.trashedLocal.push(p);
                    log(`Moved ${p} to the local trash`);
                    break;
                case 'keepLocal': {
                    // Save the Drive version beside the local file, then send the local version.
                    const copy = `${p}.drive-conflict-${stamp}`;
                    await writeLocal(copy, await fetchRemote(p));
                    await upload(p);
                    summary.conflictCopies.push(copy);
                    summary.uploaded.push(p);
                    log(`Conflict on ${p}: kept the local version, saved the Drive version as ${copy}`);
                    break;
                }
                case 'keepRemote': {
                    // Save the local version beside the file, then take the Drive version.
                    const copy = `${p}.local-conflict-${stamp}`;
                    await writeLocal(copy, await fs.readFile(absolute(p)));
                    const data = await fetchRemote(p);
                    await writeLocal(p, data);
                    base[p] = md5(data);
                    summary.conflictCopies.push(copy);
                    summary.downloaded.push(p);
                    log(`Conflict on ${p}: kept the Drive version, saved the local version as ${copy}`);
                    break;
                }
                case 'record':
                    base[p] = remoteFiles.get(p)?.md5 ?? base[p];
                    break;
                case 'forget':
                    delete base[p];
                    break;
                case 'skip':
                    summary.skipped.push(action);
                    log(`Skipped ${p}: ${action.reason}`);
                    break;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            summary.failed.push({ path: p, error: message });
            log(`Failed on ${p}: ${message}`);
        }
    }
    return summary;
}

/** Scan both sides, plan, and apply. `base` is updated in place for the caller to save. */
export async function runSync(
    mode: Mode,
    options: Omit<ApplyOptions, 'remoteFiles'>,
): Promise<Summary> {
    await fs.mkdir(options.root, { recursive: true });
    const [local, remoteFiles] = await Promise.all([scanLocal(options.root), options.remote.list()]);
    const remote = new Map([...remoteFiles].map(([p, file]) => [p, file.md5]));
    const actions = plan(local, remote, options.base, mode);
    return applyPlan(actions, { ...options, remoteFiles });
}

function timestamp(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').slice(0, 15);
}
