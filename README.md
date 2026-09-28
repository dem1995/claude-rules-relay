# Rules Relay

Rules Relay keeps a folder of Claude Code rule files in step between your computers, through a
folder in your own Google Drive. Write a rule once, sync, and every machine you use Claude Code on
has it.

Rules Relay is an independent project. It is not made by, affiliated with, or endorsed by Anthropic
or Google.

## Getting started

1. Install Rules Relay and click its icon in the activity bar.
2. Click **Sign In to Google Drive**. Your browser opens Google's sign-in page, where you choose
   your account and allow access to the files Rules Relay creates.
3. Put your rule files (`.md`) in the synced folder. **Open Synced Folder** in the view's `...`
   menu takes you there.
4. Click **Sync**. On your other computers, install Rules Relay, sign in with the same Google
   account, and click **Sync** to bring the rules down.

The synced folder is `~/.claude/rules/vs_code_synced` on each computer, or `rules/vs_code_synced`
under `CLAUDE_CONFIG_DIR` when that is set. In your Drive it is the `vs_code_synced` folder at the
top level.

## The Synced Rules view

- **Each rule file** is listed with what the next sync would do with it: in sync, changed here,
  changed in Drive, new on either side, deleted on either side, or changed on both sides. Click a
  file to open it.
- **Title bar buttons:** Sync, Pull, Push, and Refresh. The `...` menu holds Open Synced Folder,
  Open Folder in Google Drive, Show Log, Open Setup Guide, and Sign Out.
- **Conflict copies** appear under the file they belong to. Click one to compare it side by side
  with the current file. When you have merged what you need, use its check button to delete it.

The status bar shows the same state at a glance: a check when everything is in sync, an upload
icon with a count when files are waiting, a warning when something needs attention, and a spinner
while syncing. Clicking it opens the view. Local edits update the view straight away, while Google
Drive is re-read on Refresh and after every sync.

Every command is also in the Command Palette (Ctrl+Shift+P) under **Rules Relay**, and every file
action is logged in the **Rules Relay** output channel.

## How syncing decides what to do

Each computer remembers what every file looked like the last time both sides agreed. That lets it
tell which side changed a file, so an edit made on another computer is not overwritten by an older
local copy.

- **Push** sends files you changed locally, including deletions. It leaves changes made in Drive
  alone and tells you it skipped them.
- **Pull** is the reverse: it takes changes made in Drive and leaves your local changes alone.
- **Sync** does both. This is the one to use day to day.
- **Both sides edited the same file:** the command's own side wins (local for Push and Sync, Drive
  for Pull). The other version is saved next to the file as `name.md.drive-conflict-<time>` or
  `name.md.local-conflict-<time>`. Those names do not end in `.md`, so Claude Code does not load
  them as rules, and they are never synced.
- **One side deleted a file that the other side edited:** the edit wins and the file comes back.
- **Deletions are recoverable.** Local files go to the Recycle Bin or Trash, and Drive files go to
  the Drive trash.

Subfolders are synced too. Google Docs files and shortcuts in the Drive folder are ignored,
because they have no plain file contents to download.

## Privacy and what Rules Relay can see

Rules Relay asks Google only for access to the files it creates (the `drive.file` permission) and
for your email address, which it shows so you know which account is signed in. It cannot see
anything else in your Drive.

Rules Relay has no servers. Your sign-in stays in your operating system's credential store, and
your files travel only between your computer and your own Google Drive. **Sign Out** revokes the
sign-in and deletes everything Rules Relay stored on the computer. Do that before uninstalling if
you want nothing left behind, because VS Code keeps an uninstalled extension's stored state. The
[privacy policy](PRIVACY.md) has the details.

Because Google limits Rules Relay to the files it created, a file you upload into the Drive folder
through the Drive website stays invisible to it. Add new rules through the local folder instead.

## Does Claude Code load the synced rules?

Yes. Claude Code's documentation only promises recursive loading for project rules in
`.claude/rules/`, so this was checked by hand on Claude Code 2.1.274. Marker files were placed in
three spots, and a fresh session reported which markers it could see:

| File | Loaded |
|---|---|
| `~/.claude/rules/canary_top.md` | yes |
| `~/.claude/rules/vs_code_synced/canary_sub.md` | yes |
| `~/.claude/rules/vs_code_synced/canary_sub.md.drive-conflict-20260927T120000` | no |

So files in the synced subfolder load as user-level rules, and conflict copies stay out of
context. If a later Claude Code release changes this, run `/memory` to see which rule files it
loaded, then set `rulesRelay.localFolder` to `~/.claude/rules` to sync the rules folder itself.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `rulesRelay.localFolder` | empty | Local folder to sync. Empty means `rules/vs_code_synced` in the Claude config directory. `~` is expanded. |
| `rulesRelay.driveFolderName` | `vs_code_synced` | Name of the folder at the top of your Drive. |
| `rulesRelay.syncOnStartup` | `false` | Sync when VS Code starts. Only conflicts and errors are reported. |
| `rulesRelay.showStatusBar` | `true` | Show the sync status in the status bar. |
| `rulesRelay.oauthClientId` | empty | Only for builds from source; see below. |

## Building from source

```
npm install
npm test          # compiles, then runs the sync-engine tests under Node
npm run package   # produces rules-relay-<version>.vsix
```

Google requires every app that uses the Drive API to have its own OAuth client, and the client
used by the published extension is not in this repository. A build from source therefore needs a
client of your own:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable
   the **Google Drive API**.
2. Under **Google Auth Platform**, set up the consent screen with an **External** audience, then
   **Publish app**. While an app is in *Testing* status, Google expires its sign-ins after seven
   days.
3. Create an OAuth client of type **Desktop app** and select **Download JSON**.
4. Either save that file as `oauth-client.json` in the project root before packaging, so the build
   carries it, or leave it out and paste the client ID and secret when **Sign In** asks for them.

`oauth-client.json` is in `.gitignore`. A client ID set in `rulesRelay.oauthClientId` overrides a
bundled client, and its secret is kept in VS Code's secret storage.
