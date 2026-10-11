#ifndef PackageRoot
  #define PackageRoot "..\..\dist\windows"
#endif

#define MyAppName "Plekt"
#define MyAppPublisher "Plekt"
#define MyAppURL "https://plekt.net"

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppChannel
  #define AppChannel "release"
#endif

[Setup]
AppId={{6B30F782-3A46-4F1B-9A69-9A0B17F4C58D}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\Plekt
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#PackageRoot}\installer
OutputBaseFilename=Plekt-Setup-{#AppChannel}-{#AppVersion}
SetupIconFile={#PackageRoot}\app\plekt.ico
UninstallDisplayIcon={app}\plekt.ico
LicenseFile=..\..\LICENSE.md
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartIfNeededByRun=no
CreateUninstallRegKey=yes
Uninstallable=yes
AllowNoIcons=yes
AppMutex=PlektService
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Plekt Windows installer
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoTextVersion={#AppVersion}
VersionInfoCopyright=Copyright (C) Plekt contributors

[Tasks]
Name: "tray"; Description: "Start Plekt in the notification area when I sign in (quick access and server status)"; GroupDescription: "Startup options:"; Flags: checkedonce
Name: "desktopicon"; Description: "Create a desktop shortcut (quick access to the dashboard)"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce
Name: "firewall"; Description: "Allow private-network connections to the selected port (needed only for access from other devices on your LAN)"; GroupDescription: "Network access:"; Flags: checkedonce
Name: "launch"; Description: "Open Plekt in your browser after installation (recommended to finish setup)"; GroupDescription: "After installation:"; Flags: checkedonce

[Dirs]
Name: "{commonappdata}\Plekt"
Name: "{commonappdata}\Plekt\logs"

[Files]
Source: "{#PackageRoot}\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Plekt\Open Plekt"; Filename: "{app}\PlektTray.exe"; Parameters: "--open"; WorkingDir: "{app}"; IconFilename: "{app}\plekt.ico"; Comment: "Open the Plekt dashboard"
Name: "{autoprograms}\Plekt\Plekt notification area"; Filename: "{app}\PlektTray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\plekt.ico"; Comment: "Show Plekt status in the notification area"
Name: "{autodesktop}\Plekt"; Filename: "{app}\PlektTray.exe"; Parameters: "--open"; WorkingDir: "{app}"; IconFilename: "{app}\plekt.ico"; Tasks: desktopicon; Comment: "Open the Plekt dashboard"

Name: "{userstartup}\Plekt notification area"; Filename: "{app}\PlektTray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\plekt.ico"; Comment: "Start Plekt in the notification area at sign-in"; Tasks: tray

[InstallDelete]
Type: files; Name: "{userstartup}\Plembfin notification area.lnk"
Type: files; Name: "{autodesktop}\Plembfin.lnk"
Type: filesandordirs; Name: "{autoprograms}\Plembfin"
Type: files; Name: "{app}\PlembfinTray.exe"
Type: files; Name: "{app}\PlembfinService.exe"
Type: files; Name: "{app}\PlembfinService.xml"
Type: files; Name: "{app}\plembfin.ico"
Type: files; Name: "{userstartup}\Plekt notification area.lnk"

[Run]
Filename: "{app}\PlektTray.exe"; Description: "Start Plekt in the notification area"; Flags: postinstall nowait runasoriginaluser; Tasks: tray
Filename: "{app}\PlektTray.exe"; Parameters: "--open"; Description: "Open Plekt"; Flags: postinstall nowait skipifsilent runasoriginaluser; Tasks: launch

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Plekt (Private)"""; Flags: runhidden waituntilterminated

[Code]
const
  PlektServiceName = 'Plekt';
  PlektRegistryKey = 'Software\Plekt';

var
  PortPage: TInputQueryWizardPage;
  PortInitialized: Boolean;

function IsValidPort(const PortText: String): Boolean;
var
  PortNumber: Integer;
  PortValue: String;
  Index: Integer;
begin
  Result := False;
  PortValue := Trim(PortText);
  if PortValue = '' then Exit;
  for Index := 1 to Length(PortValue) do begin
    if (PortValue[Index] < '0') or (PortValue[Index] > '9') then Exit;
  end;
  PortNumber := StrToIntDef(PortValue, 0);
  Result := (PortNumber >= 1) and (PortNumber <= 65535);
end;

function ExistingPort: String;
var
  Candidate: String;
  ServiceXml: AnsiString;
  Marker: AnsiString;
  MarkerPosition: Integer;
  ValuePosition: Integer;
  QuotePosition: Integer;
begin
  Result := '5056';
  if (RegQueryStringValue(HKEY_LOCAL_MACHINE, PlektRegistryKey, 'Port', Candidate) or
      RegQueryStringValue(HKEY_LOCAL_MACHINE, 'Software\Plembfin', 'Port', Candidate)) and IsValidPort(Candidate) then begin
    Result := Trim(Candidate);
    Exit;
  end;

  { Older installations do not have the registry value, so preserve their configured port. }
  if not LoadStringFromFile(ExpandConstant('{app}\PlektService.xml'), ServiceXml) then
    if not LoadStringFromFile(ExpandConstant('{app}\PlembfinService.xml'), ServiceXml) then Exit;
  Marker := 'name="PORT" value="';
  MarkerPosition := Pos(Marker, ServiceXml);
  if MarkerPosition = 0 then Exit;
  ValuePosition := MarkerPosition + Length(Marker);
  QuotePosition := Pos('"', Copy(ServiceXml, ValuePosition, Length(ServiceXml) - ValuePosition + 1));
  if QuotePosition = 0 then Exit;
  Candidate := Copy(ServiceXml, ValuePosition, QuotePosition - 1);
  if IsValidPort(Candidate) then Result := Trim(Candidate);
end;

function SelectedPort: String;
begin
  Result := Trim(PortPage.Values[0]);
end;

procedure InitializePortValue;
var
  CommandLinePort: String;
begin
  if PortInitialized then Exit;
  PortPage.Values[0] := ExistingPort;

  { This also lets administrators supply the same value to a silent installation. }
  CommandLinePort := ExpandConstant('{param:PLEKTPORT|}');
  if CommandLinePort = '' then CommandLinePort := ExpandConstant('{param:PLEMBFINPORT|}');
  if CommandLinePort <> '' then PortPage.Values[0] := CommandLinePort;
  PortInitialized := True;
end;

function CheckPortAvailability(var PortInUse: Boolean): Boolean;
var
  PowerShellPath: String;
  Arguments: String;
  ResultCode: Integer;
begin
  Result := False;
  PortInUse := False;
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  if not FileExists(PowerShellPath) then Exit;

  Arguments :=
    '-NoProfile -NonInteractive -Command "$ErrorActionPreference=''Stop''; ' +
    '$port=' + SelectedPort + '; $current=' + ExistingPort + '; ' +
    '$service=Get-Service -Name ''Plekt'',''Plembfin'' -ErrorAction SilentlyContinue; ' +
    'if ($service -and $service.Status -eq ''Running'' -and $port -eq $current) { exit 0 }; ' +
    'try { $listeners=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue); ' +
    'if ($listeners.Count -gt 0) { exit 2 } else { exit 0 } } catch { exit 3 }"';

  if not Exec(PowerShellPath, Arguments, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then Exit;
  if ResultCode = 0 then begin
    Result := True;
  end else if ResultCode = 2 then begin
    Result := True;
    PortInUse := True;
  end;
end;

procedure InitializeWizard;
begin
  PortPage := CreateInputQueryPage(
    wpSelectDir,
    'Plekt server port',
    'Choose the port for the Plekt dashboard',
    'The current port is prefilled. Keep it to leave the address unchanged, or enter a different TCP port. Existing installations will be updated to use the port entered here.');
  PortPage.Add('TCP port:', False);
  PortPage.Values[0] := '5056';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = PortPage.ID then InitializePortValue;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  PortInUse: Boolean;
begin
  Result := True;
  if CurPageID = wpSelectDir then InitializePortValue;
  if CurPageID <> PortPage.ID then Exit;
  InitializePortValue;
  if not IsValidPort(SelectedPort) then begin
    MsgBox('Enter a TCP port number from 1 to 65535.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  if not CheckPortAvailability(PortInUse) then begin
    MsgBox('Windows could not confirm that this port is available. Close PowerShell networking tools or choose another port, then try again.', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  if PortInUse then begin
    MsgBox('TCP port ' + SelectedPort + ' is already in use by another app. Choose another port or stop that app, then try again.', mbError, MB_OK);
    Result := False;
  end;
end;

function ApplySelectedPort: Boolean;
var
  ConfigPath: String;
  ServiceXml: AnsiString;
  Marker: AnsiString;
  MarkerPosition: Integer;
  ValuePosition: Integer;
  QuotePosition: Integer;
begin
  Result := False;
  ConfigPath := ExpandConstant('{app}\PlektService.xml');
  if not LoadStringFromFile(ConfigPath, ServiceXml) then Exit;
  Marker := 'name="PORT" value="';
  MarkerPosition := Pos(Marker, ServiceXml);
  if MarkerPosition = 0 then Exit;
  ValuePosition := MarkerPosition + Length(Marker);
  QuotePosition := Pos('"', Copy(ServiceXml, ValuePosition, Length(ServiceXml) - ValuePosition + 1));
  if QuotePosition = 0 then Exit;
  ServiceXml :=
    Copy(ServiceXml, 1, ValuePosition - 1) +
    SelectedPort +
    Copy(ServiceXml, ValuePosition + QuotePosition - 1, Length(ServiceXml));
  if not SaveStringToFile(ConfigPath, ServiceXml, False) then Exit;
  Result := RegWriteStringValue(HKEY_LOCAL_MACHINE, PlektRegistryKey, 'Port', SelectedPort);
end;

function RunNetsh(const Arguments: String; var ResultCode: Integer): Boolean;
begin
  Result := Exec(ExpandConstant('{sys}\netsh.exe'), Arguments, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure UpdateFirewallRule;
var
  ResultCode: Integer;
begin
  { Replace the old rule on upgrades, and remove it if LAN access was unchecked. }
  Exec(
    ExpandConstant('{sys}\netsh.exe'),
    'advfirewall firewall delete rule name="Plekt (Private)"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode);

  if WizardIsTaskSelected('firewall') and not RunNetsh(
    'advfirewall firewall add rule name="Plekt (Private)" dir=in action=allow protocol=TCP localport=' + SelectedPort + ' profile=private',
    ResultCode) then begin
    MsgBox('Plekt was installed, but its private-network firewall rule could not be updated. You can allow TCP port ' + SelectedPort + ' in Windows Firewall settings.', mbInformation, MB_OK);
  end;
end;

function RunServiceCommand(const Arguments: String; var ResultCode: Integer): Boolean;
begin
  Result := Exec(
    ExpandConstant('{app}\PlektService.exe'),
    Arguments,
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode) and (ResultCode = 0);
end;

function ServiceExists: Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec(
    ExpandConstant('{sys}\sc.exe'),
    'query "' + PlektServiceName + '"',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode) and (ResultCode = 0);
end;

function StopRegisteredService: Boolean;
var
  ResultCode: Integer;
begin
  Result := False;

  if FileExists(ExpandConstant('{app}\PlektService.exe')) then begin
    Result := RunServiceCommand('stop', ResultCode);
  end;

  { Fall back to the Service Control Manager if the wrapper is missing or cannot stop the service. }
  if not Result then begin
    Exec(
      ExpandConstant('{sys}\sc.exe'),
      'stop "' + PlektServiceName + '"',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode);
    { 1062 means the service was already stopped. }
    Result := (ResultCode = 0) or (ResultCode = 1062);
  end;
  if Result then begin
    Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -NonInteractive -Command "try { $service=Get-Service -Name ''Plekt'' -ErrorAction Stop; $service.WaitForStatus(''Stopped'',[TimeSpan]::FromSeconds(45)); exit 0 } catch { exit 1 }"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  end;
end;

function RemoveRegisteredService: Boolean;
var
  ResultCode: Integer;
begin
  Result := False;

  if FileExists(ExpandConstant('{app}\PlektService.exe')) then begin
    Result := RunServiceCommand('uninstall', ResultCode);
  end;

  { Do not leave a stale service behind if the wrapper was already removed. }
  if not Result then begin
    Exec(
      ExpandConstant('{sys}\sc.exe'),
      'delete "' + PlektServiceName + '"',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode);
    { 1060 means the service no longer exists. }
    Result := (ResultCode = 0) or (ResultCode = 1060);
  end;
end;

procedure CloseInstalledProcesses;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM PlembfinTray.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  { The tray is not a Windows service, so stop it explicitly before files are removed. }
  Exec(
    ExpandConstant('{sys}\taskkill.exe'),
    '/F /T /IM PlektTray.exe',
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode);
end;

function MigrateLegacyInstall: String;
var
  ResultCode: Integer;
  LegacyData: String;
  NewData: String;
  Arguments: String;
begin
  Result := '';
  LegacyData := ExpandConstant('{commonappdata}\Plembfin');
  NewData := ExpandConstant('{commonappdata}\Plekt');
  if DirExists(LegacyData) and DirExists(NewData) then begin
    Result := 'Both Plembfin and Plekt data folders exist. Resolve the data-folder conflict before retrying setup; neither folder has been changed.';
    Exit;
  end;
  Arguments := '-NoProfile -NonInteractive -Command "$ErrorActionPreference=''Stop''; ' +
    '$service=Get-Service -Name ''Plembfin'' -ErrorAction SilentlyContinue; ' +
    'if ($service) { if ($service.Status -ne ''Stopped'') { Stop-Service -InputObject $service; ' +
    '$service.WaitForStatus(''Stopped'',[TimeSpan]::FromSeconds(45)) }; ' +
    '& sc.exe delete Plembfin; if ($LASTEXITCODE -ne 0) { exit 1 }; ' +
    'for ($i=0; $i -lt 45; $i++) { if (!(Get-Service -Name ''Plembfin'' -ErrorAction SilentlyContinue)) { exit 0 }; Start-Sleep -Seconds 1 }; exit 1 }; exit 0"';
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Arguments, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then begin
    Result := 'Could not stop and remove the old Plembfin service. No data has been moved; retry setup after stopping the service.';
    Exit;
  end;
  if DirExists(LegacyData) and not RenameFile(LegacyData, NewData) then begin
    Result := 'Could not move the Plembfin data folder to Plekt. The old data is preserved and the service is stopped; retry setup.';
    Exit;
  end;
  RegDeleteKeyIncludingSubkeys(HKEY_LOCAL_MACHINE, 'Software\Plembfin');
  RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Plembfin');
  Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="Plembfin (Private)"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  PortInUse: Boolean;
begin
  Result := '';
  NeedsRestart := False;
  InitializePortValue;
  if not IsValidPort(SelectedPort) then begin
    Result := 'Enter a TCP port number from 1 to 65535.';
    Exit;
  end;
  if not CheckPortAvailability(PortInUse) then begin
    Result := 'Windows could not confirm that TCP port ' + SelectedPort + ' is available. Choose another port and try again.';
    Exit;
  end;
  if PortInUse then begin
    Result := 'TCP port ' + SelectedPort + ' is already in use by another app. Choose another port or stop that app, then try again.';
    Exit;
  end;
  CloseInstalledProcesses;
  if ServiceExists and not StopRegisteredService then begin
    Result := 'Could not stop the Plekt service. Stop it before retrying setup.';
    Exit;
  end;
  Result := MigrateLegacyInstall;

end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ServiceReady: Boolean;
begin
  if CurStep <> ssPostInstall then Exit;

  if not ApplySelectedPort then begin
    MsgBox('Plekt was installed, but its selected server port could not be saved. The Windows service was left stopped; rerun setup to try again.', mbError, MB_OK);
    Exit;
  end;

  UpdateFirewallRule;

  { The Startup shortcut now owns sign-in startup. Remove the old Run entry
    whether the tray option is enabled or disabled. }
  RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Plekt');

  ServiceReady := False;
  if ServiceExists then begin
    { WinSW 2.11 has no refresh command. The stopped service reads the
      updated XML when it starts; preserve its existing registration. }
    ServiceReady := True;
  end else begin
    ServiceReady := RunServiceCommand('install', ResultCode);
  end;

  if not ServiceReady then begin
    MsgBox(
      'Plekt was installed, but its Windows service could not be registered. You can retry from an elevated terminal with PlektService.exe install.',
      mbError,
      MB_OK);
    Exit;
  end;

  if not RunServiceCommand('start', ResultCode) then begin
    MsgBox(
      'Plekt was installed, but its Windows service could not be started. Check the service logs under %ProgramData%\\Plekt\\logs\\service.',
      mbError,
      MB_OK);
  end;
end;

function InitializeUninstall: Boolean;
begin
  Result := True;
  CloseInstalledProcesses;
  DeleteFile(ExpandConstant('{userstartup}\Plekt notification area.lnk'));
  RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Plekt');
  RegDeleteValue(HKEY_LOCAL_MACHINE, PlektRegistryKey, 'Port');
  if not ServiceExists then Exit;

  { Stop and unregister the service before Inno deletes the installed files. }
  StopRegisteredService;
  RemoveRegisteredService;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep <> usPostUninstall) or UninstallSilent then Exit;
  if not DirExists(ExpandConstant('{commonappdata}\Plekt')) then Exit;

  if MsgBox(
    'Do you also want to delete Plekt''s database, artwork cache, logs, and backups? This cannot be undone.',
    mbConfirmation,
    MB_YESNO) = IDYES then begin
    DelTree(ExpandConstant('{commonappdata}\Plekt'), True, True, True);
  end;
end;
