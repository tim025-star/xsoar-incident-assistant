#define AppName "XSOAR Incident Assistant"
#define AppPublisher "XSOAR Incident Assistant contributors"
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\\release-stage\\app"
#endif
[Setup]
AppId={{60EBD23D-706E-4D31-AC14-431621E99316}
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
OutputBaseFilename=XSOAR-Incident-Assistant-Setup-{#AppVersion}-x64
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={sys}\wscript.exe

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce
Name: "installollama"; Description: "Install local &Ollama and qwen3.5:9b from GitHub (about 8.2 GB)"; GroupDescription: "Optional local AI:"; Flags: unchecked

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\XSOAR Incident Assistant.vbs"""; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\XSOAR Incident Assistant.vbs"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\scripts\install-local-ai.mjs"""; WorkingDir: "{app}"; Description: "Install Ollama and the default local model from GitHub"; Tasks: installollama; Flags: postinstall skipifsilent
Filename: "{sys}\wscript.exe"; Parameters: """{app}\XSOAR Incident Assistant.vbs"""; WorkingDir: "{app}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
