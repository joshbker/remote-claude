$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"F:\Projects\Other\remote-claude\start.vbs"' -WorkingDirectory 'F:\Projects\Other\remote-claude'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 9999) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'RemoteClaude' -Action $action -Trigger $trigger -Settings $settings -Description 'Auto-start Remote Claude Discord bot on login' -Force
