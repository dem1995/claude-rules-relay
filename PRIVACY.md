# Rules Relay Privacy Policy

**Effective date:** September 27, 2026

Rules Relay is a Visual Studio Code extension that keeps a folder of Claude Code rule files in sync
between your computers, using a folder in your own Google Drive. This policy explains what
information Rules Relay accesses, how it uses that information, and how you can remove it.

Rules Relay has no servers. It runs entirely on your computer and talks directly to Google. The
developer of Rules Relay never receives, sees, or stores any of your information.

## Information Rules Relay accesses

When you sign in, Rules Relay asks Google for these permissions:

| Permission (scope) | What it allows | Why Rules Relay needs it |
|---|---|---|
| `https://www.googleapis.com/auth/drive.file` | Access only to Drive files and folders that Rules Relay itself creates | To create one sync folder in your Drive, and to upload, download, update, and trash the rule files inside it |
| `openid` and `email` | Your Google account's email address | To show which account you are signed in with |

The `drive.file` permission does not let Rules Relay see, read, or change any other file in your
Google Drive. Google enforces this limit, so Rules Relay can reach only the sync folder and the
files it created there.

Rules Relay does not access your Google contacts, calendar, Gmail, or any other Google service.

## How Rules Relay uses this information

Rules Relay uses the information it receives from Google only to provide its one feature, which is
syncing your rule files:

- **Your rule files** are copied between the sync folder on your computer and the sync folder in
  your Google Drive, in whichever direction you choose (Push, Pull, or Sync).
- **Your email address** is shown in VS Code so that you can see which Google account is signed
  in.

Rules Relay does not use your information for advertising, analytics, profiling, or any purpose
other than the sync you ask for. It does not collect usage statistics or send telemetry.

## Where your information is stored

All of it stays on your computer or in your own Google Drive:

- **Your sign-in**, meaning the refresh token Google issues, is stored in VS Code's secret storage.
  VS Code encrypts that storage with your operating system's credential manager (Windows Credential
  Manager, macOS Keychain, or the Linux Secret Service). Your email address is stored there too.
- **Sync bookkeeping** is stored in VS Code's extension storage on your computer. This consists of
  the relative path and a checksum (MD5) of each synced file, the ID of the Drive sync folder, and
  the time of your last sync. Rules Relay uses it to tell which side changed a file since the last
  sync. It does not include file contents.
- **Your rule files** are stored in the local sync folder and in the Drive sync folder, both of
  which you control.
- **A log of sync activity**, such as which files were uploaded or downloaded, is shown in VS
  Code's Output panel on your computer.

Rules Relay sends network requests only to Google's own services: `accounts.google.com` and
`oauth2.googleapis.com` for sign-in, and `www.googleapis.com` for Google Drive.

## Sharing

Rules Relay does not sell, rent, share, or transfer your information to anyone. The developer has no
access to it, so there is nothing to share. Your files move only between your computer and your own
Google Drive.

## Use of Google user data

Rules Relay's use and transfer to any other app of information received from Google APIs will
adhere to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

In particular, Rules Relay:

- uses Google user data only to provide the sync feature described above;
- does not transfer Google user data to others, except as needed to provide that feature, to comply
  with applicable law, or as part of a merger or acquisition with notice to you;
- does not use Google user data for advertising, including personalized or retargeted ads;
- does not allow any person to read Google user data;
- does not use Google user data to develop, improve, or train artificial intelligence or machine
  learning models.

## Removing your information

- **Sign out** in Rules Relay (the "Sign Out of Google Drive" command). This revokes the extension's
  access with Google and deletes your sign-in and email address from your computer.
- **Revoke access from your Google account** at any time at
  [myaccount.google.com/connections](https://myaccount.google.com/connections). This works even if
  the extension is no longer installed.
- **Uninstall the extension** from VS Code to remove its sync bookkeeping.
- **Delete the synced files** yourself if you no longer want them. Rules Relay never deletes the
  Drive sync folder, so the files in it stay in your Drive until you remove them. Files that Rules
  Relay removes during a sync go to your Drive trash or your computer's trash, where you can
  recover them.

## Changes to this policy

If this policy changes, the updated version will be published at this page with a new effective
date. If a change would let Rules Relay collect or use your information in a new way, the extension will ask
for your consent before doing so.

## Contact

Questions about this policy can be raised as an issue at
[github.com/dem1995/rules-relay/issues](https://github.com/dem1995/rules-relay/issues).
