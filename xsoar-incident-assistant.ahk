#Requires AutoHotkey v2.0
#SingleInstance Force

SetWorkingDir(A_ScriptDir)
global AssistantBusy := false
global AssistantDebugEnabled := false
global AssistantDebugGui := 0
global AssistantDebugStageText := 0
global AssistantDebugDetailText := 0
global AssistantDebugElapsedText := 0
global AssistantDebugStartTick := 0

NumpadAdd:: {
    global AssistantBusy, AssistantDebugEnabled

    if AssistantBusy {
        TrayTip("A template is already being prepared.", "XSOAR Incident Assistant", "Iconi")
        return
    }

    DebugOverlayDestroy()
    AssistantBusy := true
    AssistantDebugEnabled := false
    outputText := ""

    try {
        configPath := A_ScriptDir "\config.json"
        scriptPath := A_ScriptDir "\search-xsoar.js"

        if !FileExist(configPath)
            throw Error("config.json is missing.")

        configText := FileRead(configPath, "UTF-8")
        AssistantDebugEnabled := JsonBoolean(configText, "debugMode", false)
        if AssistantDebugEnabled
            DebugOverlayStart()
        notepadPath := ExpandEnvironmentPath(JsonString(configText, "notepadPlusPlusPath"))
        if !FileExist(notepadPath)
            throw Error("Notepad++ was not found at:`n" notepadPath)

        protocol := RunNodeAndReadProtocol('node.exe "' scriptPath '"')
        exitCode := protocol.exitCode
        outputText := protocol.resultText
        if AssistantDebugEnabled
            DebugOverlaySetState("checking_result", "Checking the browser automation result.")
        if !outputText {
            message := protocol.stderrText ? protocol.stderrText : "The browser helper returned no result."
            throw Error(message)
        }
        if exitCode != 0 || !RegExMatch(outputText, 'i)"ok"\s*:\s*true') {
            message := JsonString(outputText, "error", protocol.stderrText ? protocol.stderrText : "The browser helper failed.")
            throw Error(message)
        }

        templateText := JsonString(outputText, "template")
        if !templateText
            throw Error("The browser helper returned an empty template.")
        if AssistantDebugEnabled
            DebugOverlaySetState("opening_notepad", "Opening or activating the configured Notepad++.")
        notepadHwnd := FindWindowForExecutable(notepadPath)
        if !notepadHwnd {
            Run('"' notepadPath '"',,, &launchedPid)
            if WinWait("ahk_pid " launchedPid,, 10)
                notepadHwnd := WinExist("ahk_pid " launchedPid)
            if !notepadHwnd
                notepadHwnd := WaitForExecutableWindow(notepadPath, 2)
            if !notepadHwnd
                throw Error("The configured Notepad++ did not open within 12 seconds.")
        }

        notepadPid := WinGetPID("ahk_id " notepadHwnd)
        if StrLower(ProcessGetPath(notepadPid)) != StrLower(notepadPath)
            throw Error("The active Notepad++ window does not belong to the configured executable.")

        WinActivate("ahk_id " notepadHwnd)
        if !WinWaitActive("ahk_id " notepadHwnd,, 5)
            throw Error("The configured Notepad++ window could not be activated.")

        if AssistantDebugEnabled
            DebugOverlaySetState("writing_template", "Creating a new Notepad++ tab and writing the template.")
        WriteNotepadDocument(notepadHwnd, notepadPath, templateText)
        warning := JsonString(outputText, "warning")
        if AssistantDebugEnabled
            DebugOverlayFinish("completed", "Template opened in Notepad++.", 8000)
        if warning
            TrayTip("Template created with warnings: " warning, "XSOAR Incident Assistant", "Icon!")
        else
            TrayTip("Template created successfully.", "XSOAR Incident Assistant", "Iconi")
    } catch as err {
        if AssistantDebugEnabled
            DebugOverlayFinish("failed", err.Message)
        MsgBox(err.Message, "XSOAR Incident Assistant", "Iconx")
    } finally {
        outputText := ""
        templateText := ""
        protocol := ""
        AssistantBusy := false
    }
}

RunNodeAndReadProtocol(command) {
    global AssistantDebugEnabled

    shell := ComObject("WScript.Shell")
    process := shell.Exec(command)
    resultText := ""
    stderrText := ""

    while process.Status = 0 || !process.StdOut.AtEndOfStream || !process.StdErr.AtEndOfStream {
        readStream := false
        if !process.StdOut.AtEndOfStream {
            line := process.StdOut.ReadLine()
            readStream := true
            if line {
                messageType := JsonString(line, "type")
                if messageType = "progress" {
                    if AssistantDebugEnabled
                        DebugOverlaySetState(
                            JsonString(line, "stage", "working"),
                            JsonString(line, "detail", "Working.")
                        )
                } else if messageType = "result" {
                    resultText := line
                }
            }
        }
        if !process.StdErr.AtEndOfStream {
            line := process.StdErr.ReadLine()
            readStream := true
            if line
                stderrText .= line "`n"
        }
        if !readStream
            Sleep(50)
    }

    return {
        exitCode: process.ExitCode,
        resultText: resultText,
        stderrText: Trim(stderrText)
    }
}

WriteNotepadDocument(notepadHwnd, expectedExecutablePath, text) {
    ; NPPM_GETCURRENTBUFFERID = WM_USER + 1000 + 60.
    currentBufferId := SendMessage(2084, 0, 0, , "ahk_id " notepadHwnd)
    ControlSend("^n", , "ahk_id " notepadHwnd)
    deadline := A_TickCount + 2000
    newBufferId := currentBufferId
    while newBufferId = currentBufferId && A_TickCount < deadline {
        Sleep(25)
        newBufferId := SendMessage(2084, 0, 0, , "ahk_id " notepadHwnd)
    }
    if !newBufferId || newBufferId = currentBufferId
        throw Error("Notepad++ did not create a new document; no text was written.")

    focusedControl := ControlGetFocus("ahk_id " notepadHwnd)
    if !RegExMatch(focusedControl, "i)^Scintilla\d+$")
        throw Error("The active Notepad++ editor control could not be identified.")

    editorHwnd := ControlGetHwnd(focusedControl, "ahk_id " notepadHwnd)
    notepadPid := WinGetPID("ahk_id " notepadHwnd)
    if StrLower(ProcessGetPath(notepadPid)) != StrLower(expectedExecutablePath)
        throw Error("The Notepad++ destination changed before the template was written.")
    if WinGetPID("ahk_id " editorHwnd) != notepadPid
        throw Error("The active editor does not belong to the configured Notepad++ process.")
    if SendMessage(2084, 0, 0, , "ahk_id " notepadHwnd) != newBufferId
        throw Error("The active Notepad++ document changed before the template was written.")
    ; ControlSetText targets the verified editor HWND and avoids exposing
    ; incident content through the system-wide Windows clipboard.
    ControlSetText(text, , "ahk_id " editorHwnd)
}

DebugOverlayStart() {
    global AssistantDebugGui, AssistantDebugStageText, AssistantDebugDetailText
    global AssistantDebugElapsedText, AssistantDebugStartTick

    DebugOverlayDestroy()
    AssistantDebugStartTick := A_TickCount
    AssistantDebugGui := Gui("+AlwaysOnTop +ToolWindow -MaximizeBox -MinimizeBox", "XSOAR Incident Assistant debug")
    AssistantDebugGui.BackColor := "F7F9FC"
    AssistantDebugGui.MarginX := 14
    AssistantDebugGui.MarginY := 12
    AssistantDebugGui.SetFont("s10", "Segoe UI")
    AssistantDebugStageText := AssistantDebugGui.AddText("w420 c1F4E79", "● Starting")
    AssistantDebugStageText.SetFont("s11 Bold")
    AssistantDebugDetailText := AssistantDebugGui.AddEdit("xm y+8 w420 r4 ReadOnly", "Starting the browser helper.")
    AssistantDebugElapsedText := AssistantDebugGui.AddText("xm y+8 w420 c667085", "Elapsed: 0 seconds")
    AssistantDebugGui.OnEvent("Close", DebugOverlayClosed)
    x := Max(0, A_ScreenWidth - 470)
    y := Max(0, A_ScreenHeight - 250)
    AssistantDebugGui.Show("NoActivate AutoSize x" x " y" y)
    SetTimer(DebugOverlayPoll, 250)
}

DebugOverlayPoll() {
    global AssistantDebugGui
    if !IsObject(AssistantDebugGui)
        return

    DebugOverlayUpdateElapsed()
}

DebugOverlaySetState(stage, detail) {
    global AssistantDebugGui, AssistantDebugStageText, AssistantDebugDetailText
    if !IsObject(AssistantDebugGui)
        return

    label := StrTitle(StrReplace(stage, "_", " "))
    AssistantDebugStageText.Text := "● " label
    AssistantDebugDetailText.Text := detail
    if InStr(stage, "failed")
        AssistantDebugStageText.SetFont("cB42318")
    else if stage = "completed"
        AssistantDebugStageText.SetFont("c027A48")
    else
        AssistantDebugStageText.SetFont("c1F4E79")
    DebugOverlayUpdateElapsed()
}

DebugOverlayUpdateElapsed() {
    global AssistantDebugGui, AssistantDebugElapsedText, AssistantDebugStartTick
    if !IsObject(AssistantDebugGui)
        return
    elapsed := Floor((A_TickCount - AssistantDebugStartTick) / 1000)
    AssistantDebugElapsedText.Text := "Elapsed: " elapsed " second" (elapsed = 1 ? "" : "s")
}

DebugOverlayFinish(stage, detail, autoCloseMs := 0) {
    SetTimer(DebugOverlayPoll, 0)
    DebugOverlaySetState(stage, detail)
    if autoCloseMs > 0
        SetTimer(DebugOverlayDestroy, -autoCloseMs)
}

DebugOverlayClosed(*) {
    DebugOverlayDestroy()
}

DebugOverlayDestroy() {
    global AssistantDebugGui, AssistantDebugStageText, AssistantDebugDetailText
    global AssistantDebugElapsedText
    SetTimer(DebugOverlayPoll, 0)
    SetTimer(DebugOverlayDestroy, 0)
    if IsObject(AssistantDebugGui) {
        try AssistantDebugGui.Destroy()
    }
    AssistantDebugGui := 0
    AssistantDebugStageText := 0
    AssistantDebugDetailText := 0
    AssistantDebugElapsedText := 0
}

JsonString(json, key, defaultValue := "") {
    valueStart := JsonTopLevelValueStart(json, key)
    if !valueStart || SubStr(json, valueStart, 1) != Chr(34)
        return defaultValue

    index := valueStart + 1
    escaped := false
    while index <= StrLen(json) {
        character := SubStr(json, index, 1)
        if escaped
            escaped := false
        else if character = "\"
            escaped := true
        else if character = Chr(34)
            return JsonUnescape(SubStr(json, valueStart + 1, index - valueStart - 1))
        index += 1
    }
    return defaultValue
}

JsonBoolean(json, key, defaultValue := false) {
    valueStart := JsonTopLevelValueStart(json, key)
    if !valueStart
        return defaultValue
    remaining := SubStr(json, valueStart)
    if RegExMatch(remaining, "i)^true\b")
        return true
    if RegExMatch(remaining, "i)^false\b")
        return false
    return defaultValue
}

JsonTopLevelValueStart(json, key) {
    depth := 0
    inString := false
    escaped := false
    stringStart := 0
    index := 1
    length := StrLen(json)
    while index <= length {
        character := SubStr(json, index, 1)
        if inString {
            if escaped
                escaped := false
            else if character = "\"
                escaped := true
            else if character = Chr(34) {
                inString := false
                if depth = 1 {
                    propertyName := JsonUnescape(SubStr(json, stringStart + 1, index - stringStart - 1))
                    cursor := index + 1
                    while cursor <= length && RegExMatch(SubStr(json, cursor, 1), "\s")
                        cursor += 1
                    if propertyName = key && SubStr(json, cursor, 1) = ":" {
                        cursor += 1
                        while cursor <= length && RegExMatch(SubStr(json, cursor, 1), "\s")
                            cursor += 1
                        return cursor
                    }
                }
            }
        } else {
            if character = Chr(34) {
                inString := true
                stringStart := index
            } else if character = "{" || character = "["
                depth += 1
            else if character = "}" || character = "]"
                depth -= 1
        }
        index += 1
    }
    return 0
}

JsonUnescape(value) {
    result := ""
    index := 1
    length := StrLen(value)
    while index <= length {
        character := SubStr(value, index, 1)
        if character != "\" {
            result .= character
            index += 1
            continue
        }

        index += 1
        if index > length {
            result .= "\"
            break
        }

        escaped := SubStr(value, index, 1)
        switch escaped {
            case Chr(34), "\", "/":
                result .= escaped
            case "b":
                result .= Chr(8)
            case "f":
                result .= Chr(12)
            case "n":
                result .= "`n"
            case "r":
                result .= "`r"
            case "t":
                result .= "`t"
            case "u":
                hexadecimal := SubStr(value, index + 1, 4)
                if !RegExMatch(hexadecimal, "i)^[0-9a-f]{4}$") {
                    result .= "\u"
                    index += 1
                    continue
                }
                codePoint := Integer("0x" hexadecimal)
                if codePoint >= 0xD800 && codePoint <= 0xDBFF
                    && SubStr(value, index + 5, 2) = "\u" {
                    lowHexadecimal := SubStr(value, index + 7, 4)
                    if RegExMatch(lowHexadecimal, "i)^[0-9a-f]{4}$") {
                        lowCodePoint := Integer("0x" lowHexadecimal)
                        if lowCodePoint >= 0xDC00 && lowCodePoint <= 0xDFFF {
                            codePoint := 0x10000 + ((codePoint - 0xD800) << 10) + (lowCodePoint - 0xDC00)
                            index += 6
                        }
                    }
                }
                result .= Chr(codePoint)
                index += 4
            default:
                result .= "\" escaped
        }
        index += 1
    }
    return result
}

JsonNumber(json, key, defaultValue := 0) {
    valueStart := JsonTopLevelValueStart(json, key)
    if !valueStart || !RegExMatch(SubStr(json, valueStart), "^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", &match)
        return defaultValue
    return match[0] + 0
}

FindWindowForExecutable(executablePath) {
    for hwnd in WinGetList("ahk_exe notepad++.exe") {
        try {
            pid := WinGetPID("ahk_id " hwnd)
            if StrLower(ProcessGetPath(pid)) = StrLower(executablePath)
                return hwnd
        }
    }
    return 0
}

WaitForExecutableWindow(executablePath, timeoutSeconds) {
    deadline := A_TickCount + (timeoutSeconds * 1000)
    while A_TickCount < deadline {
        hwnd := FindWindowForExecutable(executablePath)
        if hwnd
            return hwnd
        Sleep(100)
    }
    return 0
}

ExpandEnvironmentPath(value) {
    result := value
    loop {
        if !RegExMatch(result, "i)%([^%]+)%", &match)
            break
        replacement := EnvGet(match[1])
        if !replacement
            break
        result := StrReplace(result, match[0], replacement)
    }
    return result
}
