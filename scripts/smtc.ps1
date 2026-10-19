# Reads the Spotify desktop session from the Windows media controls (SMTC) and
# talks to server.js over stdin/stdout, one JSON object per line. The SMTC is
# local, so it keeps working when the network breaks Spotify Connect.
#
# Out: {type:"state", session:false} | {type:"state", session:true, ...}
#      {type:"thumb", key, mime, data}   (base64 cover, once per track)
#      {type:"result", id, ok, error?}   (reply to a command)
#      {type:"log", message}
# In:  {id, cmd, value}  with cmd in play|pause|next|previous|shuffle|repeat|seek|open

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait(5000)) { throw 'WinRT call timed out' }
    $task.Result
}

function Send($message) {
    [Console]::Out.WriteLine(($message | ConvertTo-Json -Compress))
}

function Get-SpotifySession {
    foreach ($s in $manager.GetSessions()) {
        if ($s.SourceAppUserModelId -like '*Spotify*') { return $s }
    }
    $null
}

$REPEAT_OUT = @{ None = 'off'; Track = 'track'; List = 'context' }
$REPEAT_IN  = @{
    off     = [Windows.Media.MediaPlaybackAutoRepeatMode]::None
    track   = [Windows.Media.MediaPlaybackAutoRepeatMode]::Track
    context = [Windows.Media.MediaPlaybackAutoRepeatMode]::List
}

$lastJson     = $null
$trackKey     = $null
$thumbDueAt   = $null

function Publish {
    $session = Get-SpotifySession
    if (-not $session) {
        $state = @{ type = 'state'; session = $false }
    } else {
        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        # Spotify blanks the title for a moment while switching tracks; keep the last state.
        if (-not $props.Title) { return }
        $info = $session.GetPlaybackInfo()
        $timeline = $session.GetTimelineProperties()
        $state = @{
            type        = 'state'
            session     = $true
            playing     = $info.PlaybackStatus.ToString() -eq 'Playing'
            title       = $props.Title
            artist      = $props.Artist
            album       = $props.AlbumTitle
            position_ms = [long]$timeline.Position.TotalMilliseconds
            duration_ms = [long]($timeline.EndTime - $timeline.StartTime).TotalMilliseconds
            updated_at  = $timeline.LastUpdatedTime.ToUnixTimeMilliseconds()
            shuffle     = $info.IsShuffleActive -eq $true
            repeat      = if ($null -ne $info.AutoRepeatMode) { $REPEAT_OUT[$info.AutoRepeatMode.ToString()] } else { 'off' }
            can_shuffle = $info.Controls.IsShuffleEnabled
            can_repeat  = $info.Controls.IsRepeatEnabled
            can_seek    = $info.Controls.IsPlaybackPositionEnabled
        }

        $key = "$($props.Title)`n$($props.Artist)`n$($props.AlbumTitle)"
        if ($key -ne $trackKey) {
            $script:trackKey = $key
            # The thumbnail lags behind the title, so wait a bit before reading it.
            $script:thumbDueAt = (Get-Date).AddMilliseconds(1200)
        }
        if ($thumbDueAt -and (Get-Date) -ge $thumbDueAt) {
            $script:thumbDueAt = $null
            if ($props.Thumbnail) {
                try {
                    $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
                    $buffer = [System.IO.MemoryStream]::new()
                    [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream).CopyTo($buffer)
                    Send @{ type = 'thumb'; key = $key; mime = $stream.ContentType; data = [Convert]::ToBase64String($buffer.ToArray()) }
                } catch {
                    Send @{ type = 'log'; message = "thumbnail read failed: $($_.Exception.Message)" }
                }
            }
        }
    }

    $json = $state | ConvertTo-Json -Compress
    if ($json -ne $lastJson) {
        $script:lastJson = $json
        [Console]::Out.WriteLine($json)
    }
}

function Invoke-SmtcCommand($line) {
    $msg = $line | ConvertFrom-Json
    $result = @{ type = 'result'; id = $msg.id; ok = $false }
    try {
        if ($msg.cmd -eq 'open') {
            Start-Process $msg.value
            $result.ok = $true
        } else {
            $session = Get-SpotifySession
            if (-not $session) { throw 'Spotify desktop is not open' }
            $operation = switch ($msg.cmd) {
                'play'     { $session.TryPlayAsync() }
                'pause'    { $session.TryPauseAsync() }
                'next'     { $session.TrySkipNextAsync() }
                'previous' { $session.TrySkipPreviousAsync() }
                'shuffle'  { $session.TryChangeShuffleActiveAsync([bool]$msg.value) }
                'repeat'   { $session.TryChangeAutoRepeatModeAsync($REPEAT_IN[[string]$msg.value]) }
                'seek'     { $session.TryChangePlaybackPositionAsync([long]$msg.value * 10000) }
                default    { throw "unknown command $($msg.cmd)" }
            }
            $result.ok = Await $operation ([bool])
        }
    } catch {
        $result.error = $_.Exception.Message
    }
    Send $result
    $script:lastJson = $null
}

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
Send @{ type = 'log'; message = 'reading Windows media controls' }

# Console.In reads synchronously even through ReadLineAsync, so read stdin with our own reader.
$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput())
$nextLine = $stdin.ReadLineAsync()

while ($true) {
    while ($nextLine.IsCompleted) {
        $line = $nextLine.Result
        if ($null -eq $line) { exit 0 } # server.js went away
        if ($line.Trim()) { Invoke-SmtcCommand $line }
        $nextLine = $stdin.ReadLineAsync()
    }
    try {
        Publish
    } catch {
        Send @{ type = 'log'; message = "read failed: $($_.Exception.Message)" }
    }
    Start-Sleep -Milliseconds 400
}
