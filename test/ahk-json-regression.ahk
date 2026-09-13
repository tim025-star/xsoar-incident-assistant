#Requires AutoHotkey v2.0
#Include ..\xsoar-incident-assistant.ahk

configText := FileRead(A_ScriptDir "\..\config.example.json", "UTF-8")
expectedPath := "%LOCALAPPDATA%\Programs\Notepad++\notepad++.exe"
if JsonString(configText, "notepadPlusPlusPath") != expectedPath
    ExitApp(1)

sample := '{"value":"line\nquote\" slash\\ unicode\u0041 pair\uD83D\uDE00"}'
expectedValue := "line`nquote" Chr(34) " slash\ unicodeA pair" Chr(0x1F600)
if JsonString(sample, "value") != expectedValue
    ExitApp(2)

nested := '{"historical":[{"error":"ticket failure","matches":99}],"error":"aggregate failure","matches":3}'
if JsonString(nested, "error") != "aggregate failure"
    ExitApp(3)
if JsonNumber(nested, "matches") != 3
    ExitApp(4)

ExitApp(0)
