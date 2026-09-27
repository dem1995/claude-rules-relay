import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { Base, fileStates, isSafeName, isSyncable, listConflictCopies, md5, Mode, plan, RemoteFile, RemoteStore, runSync } from '../sync';

/** An in-memory stand-in for the Drive folder. */
class FakeRemote implements RemoteStore {
    files = new Map<string, { path: string; data: Uint8Array }>();
    trashed: string[] = [];
    private nextId = 1;

    async list(): Promise<Map<string, RemoteFile>> {
        return new Map([...this.files].map(([id, file]) => [file.path, { id, md5: md5(file.data) }]));
    }
    async download(id: string): Promise<Uint8Array> {
        return this.files.get(id)!.data;
    }
    async create(relPath: string, data: Uint8Array): Promise<RemoteFile> {
        const id = `id${this.nextId++}`;
        this.files.set(id, { path: relPath, data });
        return { id, md5: md5(data) };
    }
    async update(id: string, data: Uint8Array): Promise<RemoteFile> {
        this.files.get(id)!.data = data;
        return { id, md5: md5(data) };
    }
    async trash(id: string): Promise<void> {
        this.trashed.push(this.files.get(id)!.path);
        this.files.delete(id);
    }
    text(relPath: string): string | undefined {
        const file = [...this.files.values()].find((f) => f.path === relPath);
        return file && Buffer.from(file.data).toString('utf8');
    }
}

/** One machine: a local folder plus the base it remembers between runs. */
class Machine {
    base: Base = {};
    constructor(readonly root: string, readonly remote: FakeRemote) {}

    static async create(remote: FakeRemote): Promise<Machine> {
        return new Machine(await fs.mkdtemp(path.join(os.tmpdir(), 'rules-sync-')), remote);
    }
    run(mode: Mode) {
        return runSync(mode, {
            root: this.root,
            remote: this.remote,
            base: this.base,
            trashLocal: (abs) => fs.rm(abs),
            log: () => {},
            now: new Date('2026-09-27T12:34:56Z'),
        });
    }
    write(rel: string, text: string) {
        const abs = path.join(this.root, ...rel.split('/'));
        return fs.mkdir(path.dirname(abs), { recursive: true }).then(() => fs.writeFile(abs, text));
    }
    async read(rel: string): Promise<string | undefined> {
        try {
            return await fs.readFile(path.join(this.root, ...rel.split('/')), 'utf8');
        } catch {
            return undefined;
        }
    }
    remove(rel: string) {
        return fs.rm(path.join(this.root, ...rel.split('/')));
    }
    async names(): Promise<string[]> {
        return (await fs.readdir(this.root, { recursive: true })).map((n) => n.replace(/\\/g, '/')).sort();
    }
}

describe('plan', () => {
    const m = (entries: Record<string, string>) => new Map(Object.entries(entries));
    const kinds = (local: Record<string, string>, remote: Record<string, string>, base: Base, mode: Mode) =>
        plan(m(local), m(remote), base, mode).map((a) => a.kind);

    it('sends local-only changes on push and sync, but not on pull', () => {
        assert.deepEqual(kinds({ a: '2' }, { a: '1' }, { a: '1' }, 'push'), ['upload']);
        assert.deepEqual(kinds({ a: '2' }, { a: '1' }, { a: '1' }, 'sync'), ['upload']);
        assert.deepEqual(kinds({ a: '2' }, { a: '1' }, { a: '1' }, 'pull'), ['skip']);
    });

    it('fetches remote-only changes on pull and sync, but not on push', () => {
        assert.deepEqual(kinds({ a: '1' }, { a: '2' }, { a: '1' }, 'pull'), ['download']);
        assert.deepEqual(kinds({ a: '1' }, { a: '2' }, { a: '1' }, 'sync'), ['download']);
        assert.deepEqual(kinds({ a: '1' }, { a: '2' }, { a: '1' }, 'push'), ['skip']);
    });

    it('propagates deletions in the direction the command allows', () => {
        assert.deepEqual(kinds({}, { a: '1' }, { a: '1' }, 'sync'), ['trashRemote']);
        assert.deepEqual(kinds({ a: '1' }, {}, { a: '1' }, 'sync'), ['trashLocal']);
    });

    it('lets an edit win over a deletion', () => {
        assert.deepEqual(kinds({}, { a: '2' }, { a: '1' }, 'sync'), ['download']);
        assert.deepEqual(kinds({ a: '2' }, {}, { a: '1' }, 'sync'), ['upload']);
        assert.deepEqual(kinds({}, { a: '2' }, { a: '1' }, 'push'), ['skip']);
    });

    it('resolves a two-sided edit toward the command direction', () => {
        assert.deepEqual(kinds({ a: '2' }, { a: '3' }, { a: '1' }, 'sync'), ['keepLocal']);
        assert.deepEqual(kinds({ a: '2' }, { a: '3' }, { a: '1' }, 'push'), ['keepLocal']);
        assert.deepEqual(kinds({ a: '2' }, { a: '3' }, { a: '1' }, 'pull'), ['keepRemote']);
    });

    it('treats differing files with no history as a conflict', () => {
        assert.deepEqual(kinds({ a: '2' }, { a: '3' }, {}, 'sync'), ['keepLocal']);
    });

    it('records agreement and forgets paths gone from both sides', () => {
        assert.deepEqual(kinds({ a: '1' }, { a: '1' }, {}, 'sync'), ['record']);
        assert.deepEqual(kinds({}, {}, { a: '1' }, 'sync'), ['forget']);
        assert.deepEqual(kinds({ a: '1' }, { a: '1' }, { a: '1' }, 'sync'), []);
    });
});

describe('names', () => {
    it('never syncs conflict copies or OS clutter', () => {
        assert.equal(isSyncable('commit.md'), true);
        assert.equal(isSyncable('sub/commit.md'), true);
        assert.equal(isSyncable('commit.md.drive-conflict-20260927T123456'), false);
        assert.equal(isSyncable('sub/commit.md.local-conflict-20260927T123456'), false);
        assert.equal(isSyncable('Thumbs.db'), false);
    });

    it('rejects names that are unsafe on disk', () => {
        for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'con?', 'trailing.', 'trailing ']) {
            assert.equal(isSafeName(bad), false, bad);
        }
        assert.equal(isSafeName('commit_instructions.md'), true);
    });
});

describe('two machines', () => {
    it('carries files, edits, and deletions from one machine to the other', async () => {
        const remote = new FakeRemote();
        const a = await Machine.create(remote);
        const b = await Machine.create(remote);

        await a.write('commit.md', 'v1');
        await a.write('prose/style.md', 'plain');
        await a.run('push');
        assert.equal(remote.text('prose/style.md'), 'plain');

        const pulled = await b.run('pull');
        assert.deepEqual(pulled.downloaded, ['commit.md', 'prose/style.md']);
        assert.equal(await b.read('prose/style.md'), 'plain');

        await b.write('commit.md', 'v2');
        await b.remove('prose/style.md');
        await b.run('sync');
        assert.equal(remote.text('commit.md'), 'v2');
        assert.deepEqual(remote.trashed, ['prose/style.md']);

        const synced = await a.run('sync');
        assert.deepEqual(synced.downloaded, ['commit.md']);
        assert.deepEqual(synced.trashedLocal, ['prose/style.md']);
        assert.equal(await a.read('commit.md'), 'v2');
        assert.equal(await a.read('prose/style.md'), undefined);
    });

    it('keeps both versions when both machines edit the same file', async () => {
        const remote = new FakeRemote();
        const a = await Machine.create(remote);
        const b = await Machine.create(remote);
        await a.write('commit.md', 'v1');
        await a.run('sync');
        await b.run('sync');

        await a.write('commit.md', 'from A');
        await a.run('sync');
        await b.write('commit.md', 'from B');
        const summary = await b.run('sync');

        const copy = 'commit.md.drive-conflict-20260927T123456';
        assert.deepEqual(summary.conflictCopies, [copy]);
        assert.equal(await b.read('commit.md'), 'from B');
        assert.equal(await b.read(copy), 'from A');
        assert.equal(remote.text('commit.md'), 'from B');

        // The conflict copy stays local, and the next sync is quiet.
        const again = await b.run('sync');
        assert.deepEqual([again.uploaded, again.downloaded, again.conflictCopies], [[], [], []]);
        assert.equal(remote.text(copy), undefined);
    });

    it('keeps the local version as a copy when a pull overwrites it', async () => {
        const remote = new FakeRemote();
        const a = await Machine.create(remote);
        const b = await Machine.create(remote);
        await a.write('commit.md', 'v1');
        await a.run('sync');
        await b.run('sync');

        await a.write('commit.md', 'from A');
        await a.run('push');
        await b.write('commit.md', 'from B');
        await b.run('pull');

        assert.equal(await b.read('commit.md'), 'from A');
        assert.equal(await b.read('commit.md.local-conflict-20260927T123456'), 'from B');
    });

    it('does not send local edits on pull', async () => {
        const remote = new FakeRemote();
        const a = await Machine.create(remote);
        await a.write('commit.md', 'v1');
        const summary = await a.run('pull');
        assert.equal(summary.skipped.length, 1);
        assert.equal(remote.files.size, 0);
        assert.deepEqual(await a.names(), ['commit.md']);
    });
});

describe('status for the view', () => {
    const m = (entries: Record<string, string>) => new Map(Object.entries(entries));

    it('labels each file by what the next sync would do', () => {
        const states = fileStates(
            m({ same: '1', edited: '2', fresh: '1', both: '2', gone_there: '1' }),
            m({ same: '1', edited: '1', theirs: '1', both: '3', gone_here: '1' }),
            { same: '1', edited: '1', both: '1', gone_here: '1', gone_there: '1' },
        );
        assert.deepEqual(
            states.map((s) => [s.path, s.status, s.local]),
            [
                ['both', 'conflict', true],
                ['edited', 'localChange', true],
                ['fresh', 'newLocal', true],
                ['gone_here', 'localDelete', false],
                ['gone_there', 'remoteDelete', true],
                ['same', 'inSync', true],
                ['theirs', 'newRemote', false],
            ],
        );
    });

    it('finds conflict copies and the file each belongs to', async () => {
        const remote = new FakeRemote();
        const a = await Machine.create(remote);
        await a.write('commit.md.drive-conflict-20260927T120000', 'x');
        await a.write('prose/style.md.local-conflict-20260926T090000', 'y');
        await a.write('prose/style.md', 'z');
        assert.deepEqual(await listConflictCopies(a.root), [
            { path: 'prose/style.md.local-conflict-20260926T090000', original: 'prose/style.md', side: 'local', stamp: '20260926T090000' },
            { path: 'commit.md.drive-conflict-20260927T120000', original: 'commit.md', side: 'drive', stamp: '20260927T120000' },
        ]);
    });
});
