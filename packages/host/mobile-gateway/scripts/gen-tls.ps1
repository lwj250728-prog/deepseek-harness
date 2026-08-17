# gen-tls.ps1 — generate a self-signed certificate (cert.pem + key.pem) for the
# gateway's HTTPS listener, with zero external dependencies.
# Use cases: TLS termination when reaching the gateway over the public internet
# directly; the Android app has a "trust self-signed certificate" switch.
# NOTE: self-signed certs still warn in phone browsers (iOS needs a profile,
# Android needs manual trust). For production prefer Let's Encrypt (needs a
# domain) or Cloudflare Tunnel (automatic HTTPS).
#
# Usage:
#   .\gen-tls.ps1                                  # -> .\tls\, SAN = 127.0.0.1 + local LAN IPv4s
#   .\gen-tls.ps1 -OutDir .\tls -Days 825
#   .\gen-tls.ps1 -AltNames "IP:203.0.113.10,DNS:dsm.example.com"   # the IP/DNS phones use MUST be in SAN
#
# After generation, point tlsKeyPath / tlsCertPath at the two files in the
# mobile-gateway row of the profile patch; saving hot-applies it.

param(
    [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'tls'),
    [int]$Days = 825,
    [string]$AltNames = ''
)

$ErrorActionPreference = 'Stop'

# ---- minimal ASN.1 DER helpers (just enough for this script) ----
function ConvertTo-BigEndian([byte[]]$littleEndian) {
    $big = [byte[]]::new($littleEndian.Length)
    [Array]::Copy($littleEndian, 0, $big, 0, $littleEndian.Length)
    [Array]::Reverse($big)
    return ,$big
}

function New-DerInteger([byte[]]$bigEndian) {
    $start = 0
    while ($start -lt $bigEndian.Length - 1 -and $bigEndian[$start] -eq 0) { $start++ }
    $trimmed = [byte[]]($bigEndian[$start..($bigEndian.Length - 1)])
    $needPad = (($trimmed[0] -band 0x80) -ne 0)   # negative-looking value needs a 0x00 sign prefix
    $out = New-Object System.Collections.Generic.List[byte]
    $out.Add(0x02)
    $out.AddRange((New-DerLength ($trimmed.Length + $(if ($needPad) { 1 } else { 0 }))))
    if ($needPad) { $out.Add(0x00) }
    $out.AddRange($trimmed)
    return ,$out.ToArray()
}

function New-DerLength([int]$len) {
    if ($len -lt 128) { return ,[byte[]]@([byte]$len) }
    $bytes = New-Object System.Collections.Generic.List[byte]
    $l = $len
    while ($l -gt 0) { $bytes.Insert(0, [byte]($l -band 0xFF)); $l = $l -shr 8 }
    $out = New-Object System.Collections.Generic.List[byte]
    $out.Add([byte](0x80 -bor $bytes.Count))
    $out.AddRange($bytes)
    return ,$out.ToArray()
}

function New-DerSequence([byte[]]$content) {
    $out = New-Object System.Collections.Generic.List[byte]
    $out.Add(0x30)
    $out.AddRange((New-DerLength $content.Length))
    $out.AddRange($content)
    return ,$out.ToArray()
}

function Format-Pem([string]$label, [byte[]]$der) {
    $b64 = [Convert]::ToBase64String($der)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("-----BEGIN $label-----")
    for ($i = 0; $i -lt $b64.Length; $i += 64) {
        $len = [Math]::Min(64, $b64.Length - $i)
        [void]$sb.AppendLine($b64.Substring($i, $len))
    }
    [void]$sb.Append("-----END $label-----")
    return $sb.ToString()
}

# ---- build the self-signed certificate ----
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$dn = New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName('CN=DSH Mobile Gateway')
$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest(
    $dn,
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

# Basic Constraints: CA=FALSE -> 30 03 01 01 00
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509Extension(
    '2.5.29.19', [byte[]]@(0x30, 0x03, 0x01, 0x01, 0x00), $true)))
# Key Usage: digitalSignature + keyEncipherment -> 03 02 05 A0
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509Extension(
    '2.5.29.15', [byte[]]@(0x03, 0x02, 0x05, 0xA0), $true)))
# Extended Key Usage: serverAuth -> 30 0A 06 08 2B 06 01 05 05 07 03 01
$req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509Extension(
    '2.5.29.37', [byte[]]@(0x30, 0x0A, 0x06, 0x08, 0x2B, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01), $false)))

# Subject Alternative Name: by default 127.0.0.1 + local LAN IPv4s; or explicit via -AltNames
$sanItems = New-Object System.Collections.Generic.List[byte]
if ($AltNames -eq '') {
    $ips = New-Object System.Collections.Generic.List[string]
    $ips.Add('127.0.0.1')
    try {
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
            ForEach-Object { $ips.Add($_.IPAddress) }
    } catch { }
    $AltNames = ($ips | Select-Object -Unique | ForEach-Object { "IP:$_" }) -join ','
}
foreach ($item in ($AltNames -split ',')) {
    $item = $item.Trim()
    if ($item -match '^IP:(.+)$') {
        $octets = ($matches[1].Trim() -split '\.')
        if ($octets.Count -eq 4) {
            $sanItems.Add(0x87); $sanItems.Add(0x04)
            foreach ($o in $octets) { $sanItems.Add([byte][int]$o) }
        }
    } elseif ($item -match '^DNS:(.+)$') {
        $name = [System.Text.Encoding]::ASCII.GetBytes($matches[1].Trim())
        $sanItems.Add(0x82); $sanItems.Add([byte]$name.Length)
        $sanItems.AddRange($name)
    }
}
if ($sanItems.Count -gt 0) {
    $sanDer = New-DerSequence $sanItems.ToArray()
    $req.CertificateExtensions.Add((New-Object System.Security.Cryptography.X509Certificates.X509Extension(
        '2.5.29.17', $sanDer, $false)))
}

$cert = $req.CreateSelfSigned(
    [DateTimeOffset]::Now.AddDays(-1),
    [DateTimeOffset]::Now.AddDays($Days)
)

# ---- export PEM ----
$certDer = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$certPem = Format-Pem 'CERTIFICATE' $certDer

# CreateSelfSigned signs with the very RSA object we created above, so export
# the key material from that object (X509Certificate2.PrivateKey is unreliable
# on .NET Framework for ephemeral certs).
$rsaParams = $rsa.ExportParameters($true)
# RSAParameters fields are already big-endian unsigned integers (with possible
# leading zero padding), so no byte-order conversion is applied here.
$intFields = @('Modulus', 'Exponent', 'D', 'P', 'Q', 'DP', 'DQ', 'InverseQ')
$content = New-Object System.Collections.Generic.List[byte]
$versionBytes = [byte[]]@(0x00)   # version 0
$content.AddRange((New-DerInteger $versionBytes))
foreach ($field in $intFields) {
    $raw = $rsaParams.$field
    if ($null -eq $raw) { throw "RSAParameters missing field $field" }
    $content.AddRange((New-DerInteger $raw))
}
$keyPem = Format-Pem 'RSA PRIVATE KEY' (New-DerSequence $content.ToArray())

# ---- write files ----
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$certPath = Join-Path $OutDir 'cert.pem'
$keyPath = Join-Path $OutDir 'key.pem'
Set-Content -Path $certPath -Value $certPem -Encoding ascii
Set-Content -Path $keyPath -Value $keyPem -Encoding ascii

Write-Host "Self-signed certificate generated:"
Write-Host "  cert: $certPath"
Write-Host "  key : $keyPath"
Write-Host "  SAN : $AltNames"
Write-Host ""
Write-Host "Wire it into the profile patch (mobile-gateway row of data/profiles/web/cordis.patch.yml):"
Write-Host "        tlsKeyPath: $keyPath"
Write-Host "        tlsCertPath: $certPath"
Write-Host "Saving hot-applies it; phones then use https://<IP>:4080/ (Android app: tick 'trust self-signed')."
