Add-Type -AssemblyName System.Windows.Forms

Write-Output "=== MONITORS ==="
$screens = [System.Windows.Forms.Screen]::AllScreens
foreach ($screen in $screens) {
    $primary = if ($screen.Primary) { " [PRIMARY]" } else { "" }
    Write-Output "$($screen.DeviceName) - $($screen.Bounds.Width)x$($screen.Bounds.Height) at ($($screen.Bounds.X),$($screen.Bounds.Y))$primary"
}

Write-Output ""
Write-Output "=== OPEN WINDOWS ==="
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
    Write-Output "$($_.ProcessName) | $($_.MainWindowTitle)"
}
