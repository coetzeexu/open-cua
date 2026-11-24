# Acceptance only: allocate a dedicated console and inject synthetic keyboard events.
param([string]$SpecPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CuaTestConsole {
  [DllImport("kernel32.dll")] public static extern bool AllocConsole();
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Info { public Coord Size, Cursor; public ushort Attributes; public Rect Window; public Coord Maximum; }
  [DllImport("kernel32.dll")] public static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacter(IntPtr handle, StringBuilder text, uint count, Coord origin, out uint read);
  [StructLayout(LayoutKind.Explicit, Size=20)] public struct Input {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(4)] public int Down;
    [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort Key;
    [FieldOffset(14)] public char Character;
    [FieldOffset(16)] public uint Control;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool WriteConsoleInput(IntPtr handle, Input[] records, uint count, out uint written);
  public static string Screen(IntPtr output) {
    Info info; if (!GetConsoleScreenBufferInfo(output, out info)) throw new Exception("Cannot read test console");
    uint count=(uint)(info.Size.X*info.Size.Y), read;
    var result=new StringBuilder((int)count);
    if (!ReadConsoleOutputCharacter(output,result,count,new Coord(),out read)) throw new Exception("Cannot capture test console");
    return result.ToString();
  }
  public static void Type(IntPtr input, string value) {
    foreach(char c in value) {
      var record = new Input { Type=1, Down=1, Repeat=1, Character=c, Key=(ushort)(c=='\r'?13:c==3?67:0), Control=(uint)(c==3?8:0) };
      uint written;
      if (!WriteConsoleInput(input,new Input[]{record},1,out written)) throw new Exception("Cannot type into test console");
      record.Down=0; WriteConsoleInput(input,new Input[]{record},1,out written);
    }
  }
}
'@
$Spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
# This driver is spawned detached from a terminal; only its new console is touched.
[CuaTestConsole]::FreeConsole() | Out-Null
if (-not [CuaTestConsole]::AllocConsole()) { throw 'Cannot allocate test console' }
$InputHandle = [CuaTestConsole]::CreateFile('CONIN$', 3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
$OutputHandle = [CuaTestConsole]::CreateFile('CONOUT$', 3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
$Child = $null
try {
  $Start = New-Object System.Diagnostics.ProcessStartInfo
  $Start.FileName = $Spec.command
  # Test arguments contain file paths and fixed IDs, never embedded quotes.
  $Start.Arguments = (($Spec.args | ForEach-Object { if ($_ -match '"') { throw 'Unsupported test argument' }; '"' + $_ + '"' }) -join ' ')
  $Start.UseShellExecute = $false
  $Start.CreateNoWindow = $false
  $Start.RedirectStandardOutput = $true
  $Start.RedirectStandardError = $true
  $Child = [System.Diagnostics.Process]::Start($Start)
  $Stdout = $Child.StandardOutput.ReadToEndAsync()
  $Stderr = $Child.StandardError.ReadToEndAsync()
  $Transcript = ''
  foreach ($Step in $Spec.steps) {
    $Deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ($true) {
      $Screen = [CuaTestConsole]::Screen($OutputHandle)
      $Transcript += $Screen
      if ($Screen.Contains($Step.wait)) { break }
      if ($Child.HasExited -or [DateTime]::UtcNow -gt $Deadline) { throw ('Missing terminal prompt: ' + $Step.wait) }
      Start-Sleep -Milliseconds 50
    }
    [CuaTestConsole]::Type($InputHandle, $Step.text)
  }
  if (-not $Child.WaitForExit(20000)) { throw 'Terminal child timed out' }
  $Transcript += [CuaTestConsole]::Screen($OutputHandle)
  $Combined = $Transcript + $Stdout.Result + $Stderr.Result
  foreach ($Secret in $Spec.secrets) { if ($Combined.Contains($Secret)) { throw 'Secret appeared in terminal output' } }
  $Expected = 0
  if ($null -ne $Spec.exitCode) { $Expected = $Spec.exitCode }
  if ($Child.ExitCode -ne $Expected) { throw ('Unexpected terminal exit: ' + $Stderr.Result) }
  @{ ok=$true; noEcho=$true; output=$Stdout.Result; error=$Stderr.Result } | ConvertTo-Json -Compress
} finally {
  if ($Child -and -not $Child.HasExited) { $Child.Kill(); $Child.WaitForExit() }
  [CuaTestConsole]::CloseHandle($InputHandle) | Out-Null
  [CuaTestConsole]::CloseHandle($OutputHandle) | Out-Null
  [CuaTestConsole]::FreeConsole() | Out-Null
}
