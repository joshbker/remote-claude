Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [PSCustomObject]@{
        Device = $_.DeviceName
        Width = $_.Bounds.Width
        Height = $_.Bounds.Height
        X = $_.Bounds.X
        Y = $_.Bounds.Y
        Primary = $_.Primary
    }
} | ConvertTo-Json
