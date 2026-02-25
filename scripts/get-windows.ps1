Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
    [PSCustomObject]@{
        ProcessName = $_.ProcessName
        Title = $_.MainWindowTitle
        Id = $_.Id
    }
} | ConvertTo-Json
