import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GoogleAuth, NotSignedInError, OAuthClient } from './auth';
import { DriveStore } from './drive';
import { Base, fileStates, listConflictCopies, Mode, RemoteFile, runSync, scanLocal, Summary } from './sync';
import { formatStamp, Node, pendingCount, RulesTreeProvider, ViewState } from './view';

const SECTION = 'rulesRelay';
const VIEW_ID = 'rulesRelay.files';
const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';
const LAST_SYNC_KEY = 'lastSync';
const MODE_LABELS: Record<Mode, string> = { push: 'Push', pull: 'Pull', sync: 'Sync' };

export function activate(context: vscode.ExtensionContext): void {
    const controller = new Controller(context);
    const command = (name: string, run: (...args: any[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(`${SECTION}.${name}`, run));

    command('signIn', () => controller.signIn());
    command('signOut', () => controller.signOut());
    command('pull', () => controller.run('pull'));
    command('push', () => controller.run('push'));
    command('sync', () => controller.run('sync'));
    command('refresh', () => controller.refresh(true));
    command('openFolder', () => controller.openFolder());
    command('openDrive', () => controller.openDrive());
    command('showLog', () => controller.output.show());
    command('compareConflict', (node: Node) => controller.compareConflict(node));
    command('resolveConflict', (node: Node) => controller.resolveConflict(node));
    command('revealFile', (node: Node) => controller.revealFile(node));
    command('openReadme', () => openReadme(context.extensionUri));

    void controller.start();
}

export function deactivate(): void {}

class Controller {
    readonly output = vscode.window.createOutputChannel('Rules Relay');
    private readonly auth: GoogleAuth;
    private readonly tree: RulesTreeProvider;
    private readonly view: vscode.TreeView<Node>;
    private readonly statusItem: vscode.StatusBarItem;
    private watcher: vscode.FileSystemWatcher | undefined;
    private watchDebounce: NodeJS.Timeout | undefined;
    private queue: Promise<unknown> = Promise.resolve();
    private loading = false;
    /** The last Drive listing, reused when only local files changed. */
    private remote: { key: string; rootId: string; files: Map<string, RemoteFile> } | undefined;
    private state: ViewState;
    private bundled: Promise<OAuthClient | undefined> | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.auth = new GoogleAuth(context.secrets, () => this.client());
        this.state = {
            signedIn: false,
            loaded: false,
            running: false,
            root: localFolder(this.config()),
            files: [],
            copies: [],
            lastSync: context.globalState.get<number>(LAST_SYNC_KEY),
        };
        this.tree = new RulesTreeProvider(
            () => this.state,
            () => {
                if (!this.loading) {
                    // Claimed now rather than when the queued load starts, so a second render
                    // in the meantime does not queue a second Drive listing.
                    this.loading = true;
                    void this.refresh(true);
                }
            },
        );
        this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this.tree, showCollapseAll: false });
        this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
        this.statusItem.command = `${VIEW_ID}.focus`;

        context.subscriptions.push(
            this.output,
            this.view,
            this.statusItem,
            { dispose: () => this.watcher?.dispose() },
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(SECTION)) {
                    this.watchLocalFolder();
                    this.render();
                    // A client ID typed into settings changes which welcome text applies.
                    void this.updateClientContext().then(() => this.refresh(true));
                }
            }),
        );
    }

    async start(): Promise<void> {
        this.watchLocalFolder();
        await this.updateClientContext();
        this.state.signedIn = await this.auth.isSignedIn();
        this.state.account = await this.auth.account();
        this.render();
        if (this.state.signedIn && this.config().get<boolean>('syncOnStartup', false)) {
            await this.run('sync', true);
        }
    }

    /**
     * Tell the welcome view whether a sign-in would have to ask for a client. The key is only ever
     * set to true after the check has run, so the welcome text does not mention a missing client in
     * the moment before the bundled one has been read.
     */
    private async updateClientContext(): Promise<void> {
        await vscode.commands.executeCommand('setContext', `${SECTION}.noClient`, (await this.client()) === undefined);
    }

    // --- Commands ---------------------------------------------------------------------------

    /**
     * Return the OAuth client to sign in with. A client ID in settings takes precedence, so a
     * bundled client can be overridden; otherwise the client bundled into the build is used.
     */
    private async client(): Promise<OAuthClient | undefined> {
        const configuredId = this.config().get<string>('oauthClientId', '').trim();
        if (configuredId) {
            const secret = await this.auth.storedClientSecret();
            return secret ? { id: configuredId, secret } : undefined;
        }
        this.bundled ??= readBundledClient(this.context.extensionUri);
        return this.bundled;
    }

    async signIn(): Promise<boolean> {
        const client = (await this.client()) ?? (await this.askForClient());
        if (!client) {
            return false;
        }

        try {
            const email = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Waiting for Google sign-in in your browser...',
                    cancellable: true,
                },
                (_progress, cancel) => this.auth.signIn(client, cancel),
            );
            void vscode.window.showInformationMessage(`Signed in to Google Drive${email ? ` as ${email}` : ''}.`);
            await this.refresh(true);
            return true;
        } catch (error) {
            if (!(error instanceof vscode.CancellationError)) {
                this.log(`Sign-in failed: ${describe(error)}`);
                void vscode.window.showErrorMessage(describe(error));
            }
            return false;
        }
    }

    /** Ask for a client by hand, for builds made without a bundled `oauth-client.json`. */
    private async askForClient(): Promise<OAuthClient | undefined> {
        const config = this.config();
        let id = config.get<string>('oauthClientId', '').trim();
        if (!id) {
            id = (await vscode.window.showInputBox({
                title: 'Google OAuth client ID',
                prompt: 'Paste the client ID of your Desktop app OAuth client. The setup guide explains how to create one.',
                ignoreFocusOut: true,
                validateInput: (value) =>
                    value.trim().endsWith(CLIENT_ID_SUFFIX) ? undefined : `A client ID ends with ${CLIENT_ID_SUFFIX}`,
            }))?.trim() ?? '';
            if (!id) {
                return undefined;
            }
            // A user setting, so VS Code Settings Sync can carry it to other machines.
            await config.update('oauthClientId', id, vscode.ConfigurationTarget.Global);
        }
        let secret = await this.auth.storedClientSecret();
        if (!secret) {
            secret = (await vscode.window.showInputBox({
                title: 'Google OAuth client secret',
                prompt: 'Paste the client secret of the same OAuth client. It is kept in your OS credential store.',
                password: true,
                ignoreFocusOut: true,
            }))?.trim();
            if (!secret) {
                return undefined;
            }
            await this.auth.storeClientSecret(secret);
        }
        return { id, secret };
    }

    async signOut(): Promise<void> {
        const account = await this.auth.account();
        await this.auth.signOut();
        this.remote = undefined;
        await this.refresh(false);
        void vscode.window.showInformationMessage(`Signed out of Google Drive${account ? ` (${account})` : ''}.`);
    }

    async run(mode: Mode, quiet = false): Promise<void> {
        if (this.state.running) {
            void vscode.window.showInformationMessage('Rules Relay is already running.');
            return;
        }
        if (!(await this.auth.isSignedIn())) {
            if (quiet) {
                return;
            }
            const choice = await vscode.window.showWarningMessage('Sign in to Google Drive first.', 'Sign In');
            if (choice !== 'Sign In' || !(await this.signIn())) {
                return;
            }
        }

        this.state.running = true;
        this.render();
        await this.enqueue(async () => {
            const root = localFolder(this.config());
            try {
                const summary = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Window, title: `Rules Relay: ${MODE_LABELS[mode]}` },
                    async () => {
                        this.log(`${MODE_LABELS[mode]} started: ${root}`);
                        const drive = this.drive();
                        const rootId = await drive.resolveRoot();
                        const key = baseKey(rootId, root);
                        const base: Base = { ...this.context.globalState.get<Base>(key, {}) };
                        try {
                            return await runSync(mode, {
                                root,
                                remote: drive,
                                base,
                                log: (message) => this.log(message),
                                trashLocal: (abs) => trash(abs),
                            });
                        } finally {
                            await this.context.globalState.update(key, base);
                        }
                    },
                );
                this.state.lastSync = Date.now();
                await this.context.globalState.update(LAST_SYNC_KEY, this.state.lastSync);
                this.report(mode, summary, quiet);
            } catch (error) {
                await this.reportError(`${MODE_LABELS[mode]} failed`, error);
            } finally {
                this.state.running = false;
                this.remote = undefined;
                await this.load(true);
            }
        });
    }

    refresh(network: boolean): Promise<void> {
        return this.enqueue(() => this.load(network));
    }

    async openFolder(): Promise<void> {
        const root = localFolder(this.config());
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(root));
        await vscode.env.openExternal(vscode.Uri.file(root));
    }

    async openDrive(): Promise<void> {
        const id = this.remote?.rootId;
        const url = id ? `https://drive.google.com/drive/folders/${id}` : 'https://drive.google.com/drive/my-drive';
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    async compareConflict(node: Node): Promise<void> {
        if (node.kind !== 'copy') {
            return;
        }
        const { copy } = node;
        const side = copy.side === 'drive' ? 'Drive' : 'Local';
        await vscode.commands.executeCommand(
            'vscode.diff',
            this.uri(copy.path),
            this.uri(copy.original),
            `${path.posix.basename(copy.original)} (${side} version from ${formatStamp(copy.stamp)} ↔ current)`,
        );
    }

    async resolveConflict(node: Node): Promise<void> {
        if (node.kind !== 'copy') {
            return;
        }
        const choice = await vscode.window.showWarningMessage(
            `Delete the conflict copy of ${node.copy.original}? Merge anything you need from it first. It will go to the trash.`,
            { modal: true },
            'Delete Copy',
        );
        if (choice === 'Delete Copy') {
            await trash(path.join(this.state.root, ...node.copy.path.split('/')));
            await this.refresh(false);
        }
    }

    async revealFile(node: Node): Promise<void> {
        if (node.kind === 'file') {
            await vscode.commands.executeCommand('revealFileInOS', this.uri(node.path));
        }
    }

    // --- State ------------------------------------------------------------------------------

    /**
     * Recompute every file's status. With `network` false, the last Drive listing is reused, so
     * local edits update the view without a round trip.
     */
    private async load(network: boolean): Promise<void> {
        this.loading = true;
        const root = localFolder(this.config());
        this.state.root = root;
        // Everything that can fail sits inside the try, so `loading` is always cleared. A read of
        // secret storage that throws (a locked keychain, say) must not leave the view stuck.
        try {
            this.state.signedIn = await this.auth.isSignedIn();
            this.state.account = this.state.signedIn ? await this.auth.account() : undefined;
            if (!this.state.signedIn) {
                this.remote = undefined;
                Object.assign(this.state, { loaded: false, files: [], copies: [], error: undefined, driveFolderId: undefined });
                return;
            }
            const remoteKey = `${this.config().get<string>('driveFolderName', 'vs_code_synced')}|${root}`;
            if (network || !this.remote || this.remote.key !== remoteKey) {
                const drive = this.drive();
                const rootId = await drive.resolveRoot();
                this.remote = { key: remoteKey, rootId, files: await drive.list() };
            }
            const remoteMd5 = new Map([...this.remote.files].map(([p, file]) => [p, file.md5]));
            const base = this.context.globalState.get<Base>(baseKey(this.remote.rootId, root), {});
            this.state.files = fileStates(await scanLocal(root), remoteMd5, base);
            this.state.copies = await listConflictCopies(root);
            this.state.driveFolderId = this.remote.rootId;
            this.state.error = undefined;
            this.state.loaded = true;
        } catch (error) {
            this.log(`Status check failed: ${describe(error)}`);
            this.state.error = describe(error);
            this.state.loaded = true;
            if (error instanceof NotSignedInError) {
                this.state.signedIn = false;
            }
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private render(): void {
        const state = this.state;
        const pending = pendingCount(state);
        const conflicts = state.copies.length + state.files.filter((f) => f.status === 'conflict').length;
        const empty = state.loaded && !state.error && state.files.length === 0 && state.copies.length === 0;

        void vscode.commands.executeCommand('setContext', `${SECTION}.signedIn`, state.signedIn);
        void vscode.commands.executeCommand('setContext', `${SECTION}.empty`, state.signedIn && empty);
        this.tree.refresh();

        this.view.description = state.account;
        if (!state.signedIn || empty) {
            this.view.message = undefined;
        } else if (state.running) {
            this.view.message = 'Syncing...';
        } else if (!state.loaded) {
            this.view.message = 'Checking Google Drive...';
        } else if (state.error) {
            this.view.message = `Could not check Google Drive: ${state.error}`;
        } else {
            const summary = pending === 0 ? 'Everything is in sync.' : `${pending} ${pending === 1 ? 'file' : 'files'} to sync.`;
            const last = state.lastSync ? ` Last synced ${new Date(state.lastSync).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.` : '';
            this.view.message = summary + last;
        }

        const item = this.statusItem;
        if (!this.config().get<boolean>('showStatusBar', true)) {
            item.hide();
            return;
        }
        if (!state.signedIn) {
            item.text = '$(cloud) Rules';
            item.tooltip = 'Rules Relay: not signed in';
        } else if (state.running) {
            item.text = '$(sync~spin) Rules';
            item.tooltip = 'Rules Relay: syncing';
        } else if (!state.loaded) {
            item.text = '$(cloud) Rules';
            item.tooltip = 'Rules Relay: not checked yet. Click to check Google Drive.';
        } else if (state.error || conflicts > 0) {
            item.text = '$(warning) Rules';
            item.tooltip = state.error ? `Rules Relay: ${state.error}` : `Rules Relay: ${conflicts} to resolve`;
        } else if (pending > 0) {
            item.text = `$(cloud-upload) Rules ${pending}`;
            item.tooltip = `Rules Relay: ${pending} ${pending === 1 ? 'file' : 'files'} to sync`;
        } else {
            item.text = '$(check) Rules';
            item.tooltip = 'Rules Relay: everything is in sync';
        }
        item.show();
    }

    private report(mode: Mode, summary: Summary, quiet: boolean): void {
        const parts = [
            count(summary.uploaded.length, 'uploaded'),
            count(summary.downloaded.length, 'downloaded'),
            count(summary.trashedRemote.length + summary.trashedLocal.length, 'moved to trash'),
            count(summary.skipped.length, 'skipped'),
        ].filter(Boolean);
        this.log(`${MODE_LABELS[mode]} finished: ${parts.join(', ') || 'already up to date'}`);

        if (summary.failed.length > 0 || summary.conflictCopies.length > 0) {
            const problems = [
                count(summary.failed.length, 'failed'),
                summary.conflictCopies.length > 0
                    ? `${summary.conflictCopies.length} conflict ${summary.conflictCopies.length === 1 ? 'copy' : 'copies'} saved for you to merge`
                    : '',
            ].filter(Boolean);
            void vscode.window
                .showWarningMessage(`Rules Relay: ${problems.join('; ')}.`, 'Show Files', 'Show Log')
                .then((choice) => {
                    if (choice === 'Show Files') {
                        void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
                    } else if (choice === 'Show Log') {
                        this.output.show();
                    }
                });
        } else if (!quiet) {
            void vscode.window.setStatusBarMessage(
                `Rules Relay ${MODE_LABELS[mode]}: ${parts.length > 0 ? parts.join(', ') : 'already up to date'}`,
                5000,
            );
        }
    }

    private async reportError(context: string, error: unknown): Promise<void> {
        this.log(`${context}: ${describe(error)}`);
        if (error instanceof NotSignedInError) {
            const choice = await vscode.window.showWarningMessage(error.message, 'Sign In');
            if (choice === 'Sign In') {
                // Deferred, because signing in refreshes through the queue this call is running in.
                setTimeout(() => void this.signIn(), 0);
            }
            return;
        }
        const choice = await vscode.window.showErrorMessage(`Rules Relay: ${describe(error)}`, 'Show Log');
        if (choice === 'Show Log') {
            this.output.show();
        }
    }

    /** Refresh from the local files whenever something in the synced folder changes. */
    private watchLocalFolder(): void {
        this.watcher?.dispose();
        const root = vscode.Uri.file(localFolder(this.config()));
        this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
        const changed = () => {
            clearTimeout(this.watchDebounce);
            this.watchDebounce = setTimeout(() => {
                if (this.state.signedIn && !this.state.running) {
                    void this.refresh(false);
                }
            }, 400);
        };
        this.watcher.onDidCreate(changed);
        this.watcher.onDidChange(changed);
        this.watcher.onDidDelete(changed);
    }

    /** Run operations one at a time, so a refresh never reads a half-finished sync. */
    private enqueue(operation: () => Promise<void>): Promise<void> {
        const next = this.queue.then(operation, operation);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private drive(): DriveStore {
        return new DriveStore(this.auth, this.config().get<string>('driveFolderName', 'vs_code_synced'), (m) => this.log(m));
    }

    private uri(rel: string): vscode.Uri {
        return vscode.Uri.file(path.join(this.state.root, ...rel.split('/')));
    }

    private config(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration(SECTION);
    }

    private log(message: string): void {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }
}

/** The configured local folder, or `rules/vs_code_synced` in the Claude config directory. */
function localFolder(config: vscode.WorkspaceConfiguration): string {
    const configured = config.get<string>('localFolder', '').trim();
    if (configured) {
        return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(claudeDir, 'rules', 'vs_code_synced');
}

/** The base describes one local folder against one Drive folder, on this machine. */
function baseKey(driveFolderId: string, root: string): string {
    return `base:${driveFolderId}:${path.resolve(root).toLowerCase()}`;
}

/**
 * Read the OAuth client baked into this build, if any. The file may be the JSON that the Google
 * Cloud console downloads (`{"installed": {"client_id": ..., "client_secret": ...}}`) or the same
 * two fields at the top level.
 */
async function readBundledClient(extensionUri: vscode.Uri): Promise<OAuthClient | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'oauth-client.json'));
        const json = JSON.parse(Buffer.from(bytes).toString('utf8'));
        const fields = json.installed ?? json;
        if (typeof fields.client_id === 'string' && typeof fields.client_secret === 'string') {
            return { id: fields.client_id, secret: fields.client_secret };
        }
    } catch {
        // No bundled client: sign-in asks for one instead.
    }
    return undefined;
}

/** Show the bundled README. The packager may lower-case its name, so both spellings are tried. */
async function openReadme(extensionUri: vscode.Uri): Promise<void> {
    for (const name of ['README.md', 'readme.md']) {
        const uri = vscode.Uri.joinPath(extensionUri, name);
        try {
            await vscode.workspace.fs.stat(uri);
            await vscode.commands.executeCommand('markdown.showPreview', uri);
            return;
        } catch {
            // Try the next spelling.
        }
    }
    void vscode.window.showErrorMessage('The setup guide is missing from this installation.');
}

async function trash(abs: string): Promise<void> {
    await vscode.workspace.fs.delete(vscode.Uri.file(abs), { useTrash: true });
}

function count(n: number, label: string): string {
    return n > 0 ? `${n} ${label}` : '';
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
