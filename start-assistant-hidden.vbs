Option Explicit
Dim shell, fso, folder, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Environment("Process")("XSOAR_ASSISTANT_HIDDEN_LAUNCH") = "1"
exitCode = shell.Run(Chr(34) & folder & "\start-assistant.bat" & Chr(34), 0, True)
If exitCode <> 0 Then
  shell.Popup "XSOAR Incident Assistant could not start. Run start-assistant.bat from the application folder to see the error.", 0, "XSOAR Incident Assistant", 16
End If
