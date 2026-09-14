Option Explicit

Dim shell, fileSystem, installDirectory, nodePath, serverPath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

installDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
nodePath = fileSystem.BuildPath(installDirectory, "runtime\node.exe")
serverPath = fileSystem.BuildPath(installDirectory, "src\server.js")

If Not fileSystem.FileExists(nodePath) Or Not fileSystem.FileExists(serverPath) Then
  MsgBox "The XSOAR Incident Assistant installation is incomplete. Reinstall the current release.", vbCritical, "XSOAR Incident Assistant"
  WScript.Quit 1
End If

shell.CurrentDirectory = installDirectory
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & serverPath & Chr(34)
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
  MsgBox "XSOAR Incident Assistant could not start. Reinstall the current release, then contact support if the problem continues.", vbCritical, "XSOAR Incident Assistant"
End If

WScript.Quit exitCode
