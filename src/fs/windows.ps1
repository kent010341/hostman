param(
    [Parameter(Mandatory=$true)][ValidateSet('Replace','Elevate','IsAdmin')][string]$Mode,
    [string]$SourcePath,
    [string]$DestinationPath,
    [string]$NodePath,
    [string]$HelperPath,
    [string]$RequestPath,
    [string]$RequestHash
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    if ($Mode -eq 'IsAdmin') {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString().ToLowerInvariant()
        exit 0
    }
    if ($Mode -eq 'Replace') {
        [System.IO.File]::Replace($SourcePath, $DestinationPath, [System.Management.Automation.Language.NullString]::Value, $false)
        exit 0
    }
    # Paths are passed as arguments; no user input is evaluated as PowerShell code.
    $arguments = @($HelperPath, '--commit-request', $RequestPath, $RequestHash)
    $quoted = $arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
    $process = Start-Process -FilePath $NodePath -ArgumentList ($quoted -join ' ') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    exit $process.ExitCode
} catch {
    if ($_.Exception -is [System.UnauthorizedAccessException] -or $_.Exception.InnerException -is [System.UnauthorizedAccessException]) {
        [Console]::Error.WriteLine('HOSTMAN_PERMISSION: ' + $_.Exception.Message)
        exit 1
    }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
