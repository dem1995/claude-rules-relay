/**
 * The "Synced Rules" tree in the Rules Relay sidebar.
 *
 * Each rule file is one row showing what the next sync would do with it. Conflict copies appear
 * as children of the file they belong to, so they can be compared and resolved in place.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConflictCopy, FileState, FileStatus } from './sync';

export interface ViewState {
    signedIn: boolean;
    account?: string;
    root: string;
    /** Whether a status check has finished since signing in. */
    loaded: boolean;
    running: boolean;
    files: FileState[];
    copies: ConflictCopy[];
    error?: string;
    lastSync?: number;
    driveFolderId?: string;
}

export type Node =
    | { kind: 'file'; path: string; state?: FileState; copies: ConflictCopy[] }
    | { kind: 'copy'; copy: ConflictCopy };

interface StatusStyle {
    label: string;
    icon: string;
    color?: string;
}

const STATUS: Record<FileStatus, StatusStyle> = {
    inSync: { label: 'In sync', icon: 'check', color: 'testing.iconPassed' },
    newLocal: { label: 'New here, will upload', icon: 'cloud-upload', color: 'gitDecoration.untrackedResourceForeground' },
    localChange: { label: 'Changed here, will upload', icon: 'arrow-up', color: 'gitDecoration.modifiedResourceForeground' },
    localDelete: { label: 'Deleted here, will trash in Drive', icon: 'trash', color: 'gitDecoration.deletedResourceForeground' },
    newRemote: { label: 'New in Drive, will download', icon: 'cloud-download', color: 'gitDecoration.untrackedResourceForeground' },
    remoteChange: { label: 'Changed in Drive, will download', icon: 'arrow-down', color: 'gitDecoration.modifiedResourceForeground' },
    remoteDelete: { label: 'Deleted in Drive, will trash here', icon: 'trash', color: 'gitDecoration.deletedResourceForeground' },
    conflict: { label: 'Changed on both sides', icon: 'warning', color: 'problemsWarningIcon.foreground' },
};

export function pendingCount(state: ViewState): number {
    return state.files.filter((file) => file.status !== 'inSync').length;
}

export class RulesTreeProvider implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(
        private readonly state: () => ViewState,
        /** Called when the tree is first shown after signing in, before any status is known. */
        private readonly needsLoad: () => void,
    ) {}

    refresh(): void {
        this.changed.fire();
    }

    getChildren(node?: Node): Node[] {
        if (node) {
            return node.kind === 'file' ? node.copies.map((copy) => ({ kind: 'copy', copy })) : [];
        }
        const state = this.state();
        if (!state.signedIn) {
            return [];
        }
        if (!state.loaded) {
            this.needsLoad();
            return [];
        }

        const files = new Map<string, Node & { kind: 'file' }>();
        for (const file of state.files) {
            files.set(file.path, { kind: 'file', path: file.path, state: file, copies: [] });
        }
        for (const copy of state.copies) {
            // A copy whose original was since deleted still gets a row, so it can be resolved.
            let parent = files.get(copy.original);
            if (!parent) {
                parent = { kind: 'file', path: copy.original, copies: [] };
                files.set(copy.original, parent);
            }
            parent.copies.push(copy);
        }
        return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    }

    getTreeItem(node: Node): vscode.TreeItem {
        const root = this.state().root;
        if (node.kind === 'copy') {
            const { copy } = node;
            const item = new vscode.TreeItem(`${copy.side === 'drive' ? 'Drive' : 'Local'} version from ${formatStamp(copy.stamp)}`);
            item.description = 'conflict copy';
            item.tooltip = `${copy.path}\nCompare it with the current file, merge what you need, then resolve it.`;
            item.iconPath = new vscode.ThemeIcon('git-compare', new vscode.ThemeColor('problemsWarningIcon.foreground'));
            item.contextValue = 'conflictCopy';
            item.command = { command: 'rulesRelay.compareConflict', title: 'Compare with Current', arguments: [node] };
            return item;
        }

        const style: StatusStyle = node.state
            ? STATUS[node.state.status]
            : { label: 'Only a conflict copy remains', icon: 'warning', color: 'problemsWarningIcon.foreground' };
        const folder = path.posix.dirname(node.path);
        const item = new vscode.TreeItem(
            path.posix.basename(node.path),
            node.copies.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
        );
        item.description = folder === '.' ? style.label : `${folder}  ·  ${style.label}`;
        item.tooltip = `${node.path}\n${style.label}`;
        item.iconPath = new vscode.ThemeIcon(style.icon, style.color ? new vscode.ThemeColor(style.color) : undefined);
        item.contextValue = node.state?.local ? 'localFile' : 'file';
        if (node.state?.local) {
            item.command = {
                command: 'vscode.open',
                title: 'Open',
                arguments: [vscode.Uri.file(path.join(root, ...node.path.split('/')))],
            };
        }
        return item;
    }
}

/** `20260927T123456` (UTC) -> a short local date and time. */
export function formatStamp(stamp: string): string {
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? stamp : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
