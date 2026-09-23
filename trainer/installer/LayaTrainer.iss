#define AppName "XSOAR Laya Trainer"
#define AppPublisher "XSOAR Incident Assistant contributors"
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef TrainerBackend
  #define TrainerBackend "cpu"
#endif
#ifndef StageDir
  #define StageDir "..\\release-stage\\app"
#endif

[Setup]
AppId={{93D7419E-FB6E-47B5-A3E7-92A1F1E9B08D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputBaseFilename=XSOAR-Laya-Trainer-Setup-{#AppVersion}-{#TrainerBackend}-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName} ({#TrainerBackend})
UninstallDisplayIcon={cmd}

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{cmd}"; Parameters: "/K """"{app}\Laya Trainer Console.cmd"""""; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{cmd}"; Parameters: "/K """"{app}\Laya Trainer Console.cmd"""""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{cmd}"; Parameters: "/K """"{app}\Laya Trainer Console.cmd"""""; WorkingDir: "{app}"; Description: "Open {#AppName}"; Flags: nowait postinstall skipifsilent
