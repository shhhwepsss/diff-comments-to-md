'use strict';

const { spawn } = require('node:child_process');

/**
 * Opens the operating system's "choose folder" dialog on the machine the
 * server runs on. The browser cannot do this itself: showDirectoryPicker()
 * hands out a handle, never an absolute path, and the rest of the tool needs
 * the path.
 *
 * Same spawn rules as lib/git.js and lib/gh.js: an argv array, shell:false.
 *
 * LOCAL_REVIEW_FOLDER_DIALOG_BIN is the substitution point for the smoke test,
 * run with the current node binary when it names a .js file.
 */

// Windows PowerShell 5.1 ships everywhere. WinForms' FolderBrowserDialog is
// the old tree-only window, so this goes straight to the Explorer dialog
// (IFileOpenDialog with FOS_PICKFOLDERS): address bar, search, quick access.
// IFileDialog is declared only up to GetResult: a COM interface may stop
// early, the vtable order before that point is what matters.
// The owner form is TopMost so the dialog is not hidden behind the browser.
// Stdout is switched to UTF-8 so Cyrillic paths survive the pipe; progress
// records are silenced so they do not end up in an error message as CLIXML.
const WINDOWS_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LocalReviewFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  class FileOpenDialog {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }

  const uint FOS_PICKFOLDERS = 0x20;
  const uint FOS_FORCEFILESYSTEM = 0x40;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  const int ERROR_CANCELLED = unchecked((int)0x800704C7);

  // null when the dialog was closed without choosing.
  public static string Pick(IntPtr owner, string title) {
    IFileDialog dialog = (IFileDialog)new FileOpenDialog();
    try {
      uint options;
      dialog.GetOptions(out options);
      dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
      dialog.SetTitle(title);
      int hr = dialog.Show(owner);
      if (hr == ERROR_CANCELLED) return null;
      Marshal.ThrowExceptionForHR(hr);
      IShellItem item;
      dialog.GetResult(out item);
      string path;
      item.GetDisplayName(SIGDN_FILESYSPATH, out path);
      return path;
    } finally {
      Marshal.ReleaseComObject(dialog);
    }
  }
}
'@
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$picked = [LocalReviewFolderPicker]::Pick($owner.Handle, 'Выбери корень git-репозитория')
$owner.Dispose()
if ($picked) { [Console]::Out.Write($picked) }
`;

// osascript reports a cancel as "User canceled. (-128)" on stderr, exit 1.
const CANCEL_MESSAGE = /\(-128\)|cancel/i;

let busy = false;

/**
 * @returns {Promise<{ path: string } | { cancelled: true } | { busy: true } | { error: string }>}
 */
async function pickFolder() {
  if (busy) return { busy: true };
  busy = true;
  try {
    for (const command of commands()) {
      const run = await runDialog(command);
      if (run.notFound) continue; // Linux: zenity missing, try kdialog
      return interpret(run);
    }
    return {
      error:
        process.platform === 'linux'
          ? 'Не найдена программа системного диалога: установи zenity или kdialog, либо вставь путь вручную.'
          : 'Не найдена программа системного диалога — вставь путь вручную.',
    };
  } finally {
    busy = false;
  }
}

function commands() {
  const override = process.env.LOCAL_REVIEW_FOLDER_DIALOG_BIN;
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return [{ bin: process.execPath, args: [override] }];
    return [{ bin: override, args: [] }];
  }
  if (process.platform === 'win32') {
    // -EncodedCommand (UTF-16LE base64) keeps quotes and Cyrillic in the script
    // away from Windows command-line quoting.
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
    return [{ bin: 'powershell', args: ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded] }];
  }
  if (process.platform === 'darwin') {
    return [{ bin: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "Выбери корень git-репозитория")'] }];
  }
  return [
    { bin: 'zenity', args: ['--file-selection', '--directory', '--title=Выбери корень git-репозитория'] },
    { bin: 'kdialog', args: ['--getexistingdirectory', '.', '--title', 'Выбери корень git-репозитория'] },
  ];
}

function runDialog({ bin, args }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, shell: false });
    } catch (e) {
      resolve(e.code === 'ENOENT' ? { notFound: true } : { spawnError: e.message });
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (b) => out.push(b));
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', (e) => resolve(e.code === 'ENOENT' ? { notFound: true } : { spawnError: e.message }));
    child.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}

function interpret(run) {
  if (run.spawnError) return { error: `Не удалось открыть системный диалог: ${run.spawnError}` };
  const picked = run.stdout.trim();
  const stderr = run.stderr.trim();
  if (run.code === 0) return picked ? { path: stripTrailingSeparator(picked) } : { cancelled: true };
  // zenity and kdialog exit 1 silently on cancel; osascript says so on stderr.
  if (run.code === 1 && !picked && (!stderr || CANCEL_MESSAGE.test(stderr))) return { cancelled: true };
  return { error: `Системный диалог завершился с ошибкой (код ${run.code})${stderr ? `: ${stderr}` : ''}` };
}

// osascript returns "/Users/me/repo/"; keep the root itself ("/", "C:\") intact.
function stripTrailingSeparator(p) {
  return p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p) ? p.slice(0, -1) : p;
}

module.exports = { pickFolder };
