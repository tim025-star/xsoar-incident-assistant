Option Explicit
Dim shell, fso, folder, programs, shortcut, link
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
programs = shell.SpecialFolders("Programs")
shortcut = programs & "\XSOAR Incident Assistant.lnk"
Set link = shell.CreateShortcut(shortcut)
link.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
link.Arguments = Chr(34) & folder & "\start-assistant-hidden.vbs" & Chr(34)
link.WorkingDirectory = folder
link.Description = "Open the local XSOAR Incident Assistant"
link.Save
WScript.Echo "Created: " & shortcut
