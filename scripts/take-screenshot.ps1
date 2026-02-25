param(
    [string]$OutputPath,
    [string]$Monitor = "primary",  # "primary", "all", or monitor index (0, 1, 2...)
    [int]$WindowId = 0  # Process ID of window to capture (0 = screen capture)
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-ScreenBounds {
    param([string]$Monitor)

    $screens = [System.Windows.Forms.Screen]::AllScreens

    if ($Monitor -eq "all") {
        # Get bounds encompassing all monitors
        $left = ($screens | ForEach-Object { $_.Bounds.X } | Measure-Object -Minimum).Minimum
        $top = ($screens | ForEach-Object { $_.Bounds.Y } | Measure-Object -Minimum).Minimum
        $right = ($screens | ForEach-Object { $_.Bounds.X + $_.Bounds.Width } | Measure-Object -Maximum).Maximum
        $bottom = ($screens | ForEach-Object { $_.Bounds.Y + $_.Bounds.Height } | Measure-Object -Maximum).Maximum

        return @{
            X = $left
            Y = $top
            Width = $right - $left
            Height = $bottom - $top
        }
    }
    elseif ($Monitor -eq "primary") {
        $primary = $screens | Where-Object { $_.Primary }
        return @{
            X = $primary.Bounds.X
            Y = $primary.Bounds.Y
            Width = $primary.Bounds.Width
            Height = $primary.Bounds.Height
        }
    }
    else {
        # Monitor index
        $index = [int]$Monitor
        if ($index -ge 0 -and $index -lt $screens.Count) {
            $screen = $screens[$index]
            return @{
                X = $screen.Bounds.X
                Y = $screen.Bounds.Y
                Width = $screen.Bounds.Width
                Height = $screen.Bounds.Height
            }
        }
        else {
            throw "Invalid monitor index: $index"
        }
    }
}

function Capture-Window {
    param([int]$ProcessId, [string]$OutputPath)

    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern IntPtr GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT {
            public int Left, Top, Right, Bottom;
        }
    }
"@

    $proc = Get-Process -Id $ProcessId -ErrorAction Stop
    $hwnd = $proc.MainWindowHandle

    if ($hwnd -eq [IntPtr]::Zero) {
        throw "Window not found for process $ProcessId"
    }

    # Use DWM extended frame bounds for accurate size (accounts for shadows/DPI)
    $rect = New-Object Win32+RECT
    $hr = [Win32]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf($rect))
    if ($hr -ne 0) {
        # Fallback to GetWindowRect
        [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top

    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    # PW_RENDERFULLCONTENT (2) captures even offscreen/obscured content
    [Win32]::PrintWindow($hwnd, $hdc, 2) | Out-Null
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()

    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

function Capture-Screen {
    param($Bounds, [string]$OutputPath)

    $w = [int]$Bounds.Width
    $h = [int]$Bounds.Height
    $x = [int]$Bounds.X
    $y = [int]$Bounds.Y

    $bitmap = New-Object System.Drawing.Bitmap($w, $h)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $size = New-Object System.Drawing.Size($w, $h)
    $graphics.CopyFromScreen($x, $y, 0, 0, $size)
    $graphics.Dispose()

    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
}

# Main logic
try {
    if ($WindowId -gt 0) {
        Capture-Window -ProcessId $WindowId -OutputPath $OutputPath
    }
    else {
        $bounds = Get-ScreenBounds -Monitor $Monitor
        Capture-Screen -Bounds $bounds -OutputPath $OutputPath
    }
    Write-Output "OK"
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
