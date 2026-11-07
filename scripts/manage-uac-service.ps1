#Requires -RunAsAdministrator
[CmdletBinding(DefaultParameterSetName = 'Install', SupportsShouldProcess)]
param(
    [Parameter(Mandatory, ParameterSetName = 'Install')]
    [string] $Source,

    [Parameter(Mandatory, ParameterSetName = 'Install')]
    [ValidatePattern('^[0-9A-Fa-f]{64}$')]
    [string] $ExpectedSha256,

    [Parameter(Mandatory, ParameterSetName = 'Remove')]
    [switch] $Remove
)

$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Execute este script no PowerShell de 64 bits.' }

$serviceName = 'MyScreenUac'
$programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$destination = Join-Path $programFiles 'MyScreen UAC'
$exe = Join-Path $destination 'myscreen-uac.exe'
$commandLine = '"{0}" --service' -f $exe
$sc = Join-Path ([Environment]::SystemDirectory) 'sc.exe'
$serviceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName"
$directorySddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;GRGX;;;BU)'
$fileSddl = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;BU)'
$sections = [System.Security.AccessControl.AccessControlSections]'Owner, Group, Access'

function Assert-PlainItem([string] $LiteralPath) {
    $item = Get-Item -LiteralPath $LiteralPath -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Caminho com redirecionamento recusado: $LiteralPath"
    }
}

function Stop-MyScreenService {
    Stop-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
}

function Start-MyScreenService {
    Start-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
}

function Remove-MyScreenRegistration {
    & $sc delete $serviceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Falha ao remover o serviço $serviceName (código $LASTEXITCODE)." }
}

Assert-PlainItem $programFiles
$existing = Get-ItemProperty -LiteralPath $serviceKey -ErrorAction SilentlyContinue
if ($existing -and ($existing.ImagePath -ne $commandLine -or $existing.ObjectName -ne 'LocalSystem' -or $existing.Type -ne 16)) {
    throw "O nome $serviceName já pertence a uma configuração diferente."
}

$expected = [System.Security.AccessControl.DirectorySecurity]::new()
$expected.SetSecurityDescriptorSddlForm($directorySddl, $sections)
if (Test-Path -LiteralPath $destination) {
    Assert-PlainItem $destination
    if ((Get-Acl -LiteralPath $destination).GetSecurityDescriptorSddlForm($sections) -cne $expected.GetSecurityDescriptorSddlForm($sections)) {
        throw "A pasta $destination tem permissões diferentes das definidas pelo MyScreen."
    }
}
$fileSecurity = [System.Security.AccessControl.FileSecurity]::new()
$fileSecurity.SetSecurityDescriptorSddlForm($fileSddl, $sections)
if (Test-Path -LiteralPath $exe) {
    Assert-PlainItem $exe
    if ((Get-Acl -LiteralPath $exe).GetSecurityDescriptorSddlForm($sections) -cne $fileSecurity.GetSecurityDescriptorSddlForm($sections)) {
        throw "O executável instalado tem permissões diferentes das definidas pelo MyScreen."
    }
}

if ($Remove) {
    if (-not $existing) { throw "O serviço $serviceName não está instalado." }
    if ($PSCmdlet.ShouldProcess($serviceName, 'Remover serviço e executável')) {
        Stop-MyScreenService
        Remove-MyScreenRegistration
        if (Test-Path -LiteralPath $exe) { Remove-Item -LiteralPath $exe }
    }
    return
}

$sourceFile = Get-Item -LiteralPath $Source
if ($sourceFile.PSIsContainer -or $sourceFile.FullName -eq $exe) { throw 'Selecione o executável do pacote de distribuição.' }
if (-not $PSCmdlet.ShouldProcess($destination, 'Instalar ou atualizar serviço')) { return }

if (-not (Test-Path -LiteralPath $destination)) {
    New-Item -Path $destination -ItemType Directory | Out-Null
    Set-Acl -LiteralPath $destination -AclObject $expected
}

$id = [Guid]::NewGuid().ToString('N')
$stage = Join-Path $destination "$id.exe"
$backup = Join-Path $destination "$id.bak"
$wasRunning = $existing -and (Get-Service -Name $serviceName).Status -eq 'Running'
$replaced = $false
$registered = $false

try {
    [IO.File]::Copy($sourceFile.FullName, $stage, $false)
    Set-Acl -LiteralPath $stage -AclObject $fileSecurity
    if ((Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash -ne $ExpectedSha256) {
        throw 'O SHA-256 do executável não corresponde ao hash informado.'
    }

    if ($existing) { Stop-MyScreenService }
    if (Test-Path -LiteralPath $exe) {
        if (-not $existing) { throw "Já existe um executável em $exe sem registro de serviço." }
        [IO.File]::Replace($stage, $exe, $backup)
    } else {
        [IO.File]::Move($stage, $exe)
    }
    $replaced = $true
    if (-not $existing) {
        New-Service -Name $serviceName -BinaryPathName $commandLine -DisplayName 'MyScreen UAC' -StartupType Automatic | Out-Null
        $registered = $true
    }
    Start-MyScreenService
} catch {
    $failure = $_
    if ($registered -or $replaced -and $existing) { Stop-MyScreenService }
    if ($registered) { Remove-MyScreenRegistration }
    if (Test-Path -LiteralPath $backup) {
        [IO.File]::Replace($backup, $exe, [NullString]::Value)
    } elseif ($replaced -and (Test-Path -LiteralPath $exe)) {
        Remove-Item -LiteralPath $exe
    }
    if ($wasRunning) { Start-MyScreenService }
    throw $failure
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage }
}

if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup }
Get-Service -Name $serviceName
