Option Explicit

Dim shell, fileSystem, scriptFolder, batchPath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptFolder = fileSystem.GetParentFolderName(WScript.ScriptFullName)
batchPath = fileSystem.BuildPath(scriptFolder, "start-chrome-debug.bat")

If Not fileSystem.FileExists(batchPath) Then
  MsgBox "start-chrome-debug.bat was not found beside this launcher.", vbExclamation, "XSOAR Incident Assistant"
  WScript.Quit 1
End If

shell.Environment("PROCESS")("XSOAR_ASSISTANT_HIDDEN_LAUNCH") = "1"
shell.CurrentDirectory = scriptFolder
command = Chr(34) & batchPath & Chr(34)
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
  MsgBox "XSOAR Incident Assistant could not start. Run start-chrome-debug.bat manually to see the detailed error.", vbExclamation, "XSOAR Incident Assistant"
End If

WScript.Quit exitCode
