; ═══════════════════════════════════════════════════════════════
; Dwatrex — Inno Setup Installer Script
; Creates a professional Windows setup wizard (DwatrexSetup.exe)
;
; Prerequisites:
;   1. Build the app first: python build.py
;   2. Install Inno Setup: https://jrsoftware.org/isdl.php
;   3. Compile this script from Inno Setup, or run from command line:
;      "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer.iss
; ═══════════════════════════════════════════════════════════════

#define AppName      "Dwatrex"
#define AppVersion   "1.0.0"
#define AppPublisher "Dwatrex"
#define AppURL       "https://dwatrex.com"
#define AppExeName   "Dwatrex.exe"
#define AppDesc      "Retail Operations Platform"

[Setup]
; App identity
AppId={{B7E3F8A1-2D4C-4F6E-9A1B-3C5D7E8F0A2B}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
; Output installer
OutputDir=installer_output
OutputBaseFilename=DwatrexSetup
; Compression
Compression=lzma2/ultra64
SolidCompression=yes
; Icon
SetupIconFile=dwatrex.ico
UninstallDisplayIcon={app}\{#AppExeName}
; Appearance
WizardStyle=modern
WizardSizePercent=110
; Privileges — per-user install doesn't need admin
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
; Minimum Windows version (Windows 10)
MinVersion=10.0
; Misc
DisableProgramGroupPage=yes
LicenseFile=LICENSE.txt
; Uninstaller
UninstallDisplayName={#AppName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checked
Name: "startmenu"; Description: "Create a &Start Menu entry"; GroupDescription: "Additional shortcuts:"; Flags: checked

[Files]
; Include the entire PyInstaller dist/Dwatrex folder
Source: "dist\Dwatrex\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Desktop shortcut
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon; \
  Comment: "{#AppDesc}"; IconFilename: "{app}\{#AppExeName}"
; Start Menu shortcut
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: startmenu; \
  Comment: "{#AppDesc}"; IconFilename: "{app}\{#AppExeName}"
; Start Menu password-reset shortcut (offline account recovery)
Name: "{group}\Reset {#AppName} Password"; Filename: "{app}\reset_password.bat"; Tasks: startmenu; \
  Comment: "Reset a {#AppName} account password (offline)"; IconFilename: "{app}\{#AppExeName}"
; Start Menu uninstall shortcut
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"; Tasks: startmenu

[Run]
; Offer to launch after install
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; \
  Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The database now lives in the per-user data directory (%LOCALAPPDATA%\Dwatrex).
; Leave user data in place by default; uncomment below to remove it on uninstall.
; Type: filesandordirs; Name: "{localappdata}\Dwatrex"

[Code]
{ ── WebView2 runtime check ──────────────────────────────────────────────
  pywebview uses the Edge WebView2 runtime on Windows. It is preinstalled on
  current Windows 11 and most updated Windows 10, but may be missing on older
  builds. If absent, the app launches to a blank/black window. We detect it and
  silently install the Evergreen bootstrapper before proceeding. }

function IsWebView2Installed(): Boolean;
var
  pv: string;
begin
  Result := False;
  // System-wide (per-machine) install, 64-bit OS
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', pv) then
    if (pv <> '') and (pv <> '0.0.0.0') then Result := True;
  // System-wide, 32-bit OS
  if (not Result) and RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', pv) then
    if (pv <> '') and (pv <> '0.0.0.0') then Result := True;
  // Per-user install
  if (not Result) and RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', pv) then
    if (pv <> '') and (pv <> '0.0.0.0') then Result := True;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  TmpFile: string;
  ResultCode: Integer;
begin
  Result := '';
  if IsWebView2Installed() then
    Exit;

  try
    DownloadTemporaryFile('https://go.microsoft.com/fwlink/p/?LinkId=2124703',
      'MicrosoftEdgeWebview2Setup.exe', '', nil);
    TmpFile := ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe');
  except
    Result := 'Could not download the required Microsoft Edge WebView2 runtime. '
            + 'Please connect to the internet and try again, or install WebView2 manually.';
    Exit;
  end;

  if not Exec(TmpFile, '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := 'Failed to install the Microsoft Edge WebView2 runtime (error ' + IntToStr(ResultCode) + ').';
end;
