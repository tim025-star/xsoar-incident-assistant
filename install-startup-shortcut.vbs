Option Explicit

Dim fileSystem, shell, arguments, targetPath, shortcutPath, shortcut
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set arguments = WScript.Arguments

If arguments.Count <> 2 Then
  WScript.Echo "Usage: cscript //nologo install-startup-shortcut.vbs <target> <shortcut>"
  WScript.Quit 2
End If

targetPath = fileSystem.GetAbsolutePathName(arguments(0))
shortcutPath = fileSystem.GetAbsolutePathName(arguments(1))
If Not fileSystem.FileExists(targetPath) Then
  WScript.Echo "Launcher was not found: " & targetPath
  WScript.Quit 1
End If

If Not fileSystem.FolderExists(fileSystem.GetParentFolderName(shortcutPath)) Then
  fileSystem.CreateFolder(fileSystem.GetParentFolderName(shortcutPath))
End If

Set shortcut = shell.CreateShortcut(shortcutPath)
shortcut.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
shortcut.Arguments = Chr(34) & targetPath & Chr(34)
shortcut.WorkingDirectory = fileSystem.GetParentFolderName(targetPath)
shortcut.Description = "Start XSOAR Incident Assistant"
shortcut.Save
WScript.Quit 0
