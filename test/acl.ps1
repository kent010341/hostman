param([string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::Write(([System.IO.FileInfo]::new($Path)).GetAccessControl().Sddl)
