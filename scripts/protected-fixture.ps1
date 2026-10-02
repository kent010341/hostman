param([string]$Path, [ValidateSet('Protect','Restore','Reset')][string]$Mode, [string]$Descriptor)
$ErrorActionPreference = 'Stop'
if ($Mode -eq 'Restore') {
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetSecurityDescriptorSddlForm($Descriptor, [System.Security.AccessControl.AccessControlSections]::Access)
    [System.IO.Directory]::SetAccessControl($Path, $security)
    exit 0
}
if ($Mode -eq 'Reset') {
    $security = [System.Security.AccessControl.DirectorySecurity]::new()
    $security.SetAccessRuleProtection($false, $false)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
    [System.IO.Directory]::SetAccessControl($Path, $security)
    exit 0
}
$original = [System.IO.Directory]::GetAccessControl($Path)
$security = [System.Security.AccessControl.DirectorySecurity]::new()
$security.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
foreach ($sid in @('S-1-5-32-544','S-1-5-18')) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inherit, $propagation, $allow)
    $security.AddAccessRule($rule)
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'ReadAndExecute', $inherit, $propagation, $allow)
$security.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($Path, $security)
[Console]::Write($original.Sddl)
