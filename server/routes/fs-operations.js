import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import express from 'express';
import { PROJECT_ROOT } from '../shared/constants.js';

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const quoteCmdArg = (value) => {
      const text = String(value ?? '');
      if (text.length === 0) return '""';
      if (!/[ \t"&()^<>|]/.test(text)) return text;
      return `"${text.replace(/"/g, '\\"')}"`;
    };

    const child = isWindows
      ? spawn(process.env.ComSpec || 'cmd.exe', [
          '/d',
          '/s',
          '/c',
          [quoteCmdArg(command), ...(args || []).map(quoteCmdArg)].join(' '),
        ], {
          windowsHide: false,
          cwd: options.cwd || PROJECT_ROOT,
        })
      : spawn(command, args, {
          windowsHide: false,
          cwd: options.cwd || PROJECT_ROOT,
        });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function selectEmptyDirectory() {
  const selectedPath = await runInteractiveSelectionScript([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; WindowState = \'Minimized\'; ShowInTaskbar = $false }',
    '$owner.Show()',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    '$dialog.Title = "选择一个空文件夹"',
    '$dialog.Filter = "文件夹|*.folder"',
    '$dialog.CheckFileExists = $false',
    '$dialog.CheckPathExists = $true',
    '$dialog.ValidateNames = $false',
    '$dialog.FileName = "选择此文件夹.folder"',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", (Split-Path $dialog.FileName -Parent), [Text.Encoding]::UTF8)',
    '} else {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", "CANCELLED", [Text.Encoding]::UTF8)',
    '}',
  ]);
  if (!selectedPath) {
    return { path: '', cancelled: true };
  }

  return { path: selectedPath, cancelled: false };
}

async function selectFiles() {
  const stdout = await runInteractiveSelectionScript([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; WindowState = \'Minimized\'; ShowInTaskbar = $false }',
    '$owner.Show()',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    '$dialog.Title = "选择资料文件"',
    '$dialog.Multiselect = $true',
    '$dialog.CheckFileExists = $true',
    '$dialog.CheckPathExists = $true',
    '$dialog.Filter = "所有文件|*.*"',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllLines("__OUT__", $dialog.FileNames, [Text.Encoding]::UTF8)',
    '} else {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", "CANCELLED", [Text.Encoding]::UTF8)',
    '}',
  ]);
  const paths = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== 'CANCELLED');
  return { paths, cancelled: paths.length === 0 };
}

async function selectDirectory() {
  const selectedPath = await runInteractiveSelectionScript([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; WindowState = \'Minimized\'; ShowInTaskbar = $false }',
    '$owner.Show()',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    '$dialog.Title = "选择资料文件夹"',
    '$dialog.Filter = "文件夹|*.folder"',
    '$dialog.CheckFileExists = $false',
    '$dialog.CheckPathExists = $true',
    '$dialog.ValidateNames = $false',
    '$dialog.FileName = "选择此文件夹.folder"',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", (Split-Path $dialog.FileName -Parent), [Text.Encoding]::UTF8)',
    '} else {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", "CANCELLED", [Text.Encoding]::UTF8)',
    '}',
  ]);
  return { path: selectedPath, cancelled: !selectedPath };
}

async function runInteractiveSelectionScript(scriptLines, options = {}) {
  const outputPath = path.join(os.tmpdir(), `agentdevclaw-select-${randomUUID()}.txt`);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5 * 60 * 1000;
  const selectionScript = Array.isArray(scriptLines) ? scriptLines.join('\n') : String(scriptLines || '');
  const escapedOutputPath = outputPath.replace(/\\/g, '\\\\');
  const finalScript = selectionScript.replace(/__OUT__/g, escapedOutputPath);
  const encodedSelection = Buffer.from(finalScript, 'utf16le').toString('base64');
  const launcherScript = [
    '$ErrorActionPreference = "Stop"',
    `$outputPath = "${escapedOutputPath}"`,
    'if (Test-Path $outputPath) { Remove-Item $outputPath -Force -ErrorAction SilentlyContinue }',
    `$encoded = "${encodedSelection}"`,
    '$proc = Start-Process powershell.exe -ArgumentList \'-NoProfile\',\'-STA\',\'-EncodedCommand\',$encoded -WindowStyle Hidden -PassThru',
    'Write-Output $proc.Id',
  ].join('\n');
  const encodedLauncher = Buffer.from(launcherScript, 'utf16le').toString('base64');
  const { stdout } = await runCommand('powershell.exe', ['-NoProfile', '-EncodedCommand', encodedLauncher]);
  const childPid = Number.parseInt(stdout.trim(), 10);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const content = await fs.readFile(outputPath, 'utf8').catch(() => null);
    if (typeof content === 'string') {
      await fs.unlink(outputPath).catch(() => {});
      return content.trim() === 'CANCELLED' ? '' : content.trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (Number.isFinite(childPid) && childPid > 0) {
    await runCommand('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${childPid} -Force -ErrorAction SilentlyContinue`]).catch(() => {});
  }
  await fs.unlink(outputPath).catch(() => {});
  const error = new Error('Selection dialog timed out');
  error.statusCode = 504;
  throw error;
}

async function validateEmptyDirectory(dirPath) {
  const selectedPath = path.resolve(String(dirPath || '').trim());
  const stat = await fs.stat(selectedPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    const error = new Error('Selected path is not a directory');
    error.statusCode = 400;
    throw error;
  }
  const entries = await fs.readdir(selectedPath).catch(() => []);
  if (entries.length > 0) {
    const error = new Error('Selected directory is not empty');
    error.statusCode = 400;
    throw error;
  }

  return { path: selectedPath, valid: true };
}

export function setupFsOperationsRoutes(app) {
  app.post('/protoclaw/select_empty_directory', async (_req, res, next) => {
    try {
      res.json(await selectEmptyDirectory());
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/select_files', async (_req, res, next) => {
    try {
      res.json(await selectFiles());
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/select_directory', async (_req, res, next) => {
    try {
      res.json(await selectDirectory());
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/validate_empty_directory', express.json(), async (req, res, next) => {
    try {
      if (typeof req.body?.path !== 'string' || !req.body.path.trim()) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      res.json(await validateEmptyDirectory(req.body.path));
    } catch (error) {
      next(error);
    }
  });
}
