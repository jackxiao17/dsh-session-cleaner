<#
.SYNOPSIS
    dsh-session-cleaner 发版脚本：校验版本号 → 打包 zip → 提交打标签 → 推送 → 建 Release 并上传 zip。

.DESCRIPTION
    维护者工具，不属于插件运行时（不出现在 package.json 的 files 列表里，不会被装进发行包）。
    版本号以 package.json 的 version 为唯一来源，脚本会校验 lib/index.js 的 buildId 是否一致。

    鉴权与代理：
      - 优先用 GitHub CLI（已登录则直接使用）；
      - 否则从 Windows 凭据管理器取 git:https://github.com 的令牌，
        或由环境变量 GH_TOKEN / 参数 -Token 提供（令牌只放进程环境变量，不写日志、不进命令行历史）；
      - 代理默认 http://127.0.0.1:7890，可用 -Proxy '' 关闭。

.EXAMPLE
    # 先干跑一遍，只打印将要执行的动作，不改任何东西
    pwsh -NoProfile -File scripts/release.ps1 -DryRun

.EXAMPLE
    # 正式发版：打包 + 提交 + 打标签 + 推送 + 建 Release + 传 zip
    pwsh -NoProfile -File scripts/release.ps1

.EXAMPLE
    # 已手工建好 Release，只补传 zip
    pwsh -NoProfile -File scripts/release.ps1 -SkipGit -SkipRelease
#>
[CmdletBinding()]
param(
    # 只打印动作，不修改任何东西
    [switch]$DryRun,
    # 跳过 git 提交/打标签/推送
    [switch]$SkipGit,
    # 跳过创建 Release（若 Release 不存在则只提示命令）
    [switch]$SkipRelease,
    # 跳过同步到 DSH 的两处安装目录
    [switch]$SkipSync,
    # 代理地址；传空字符串表示直连
    [string]$Proxy = 'http://127.0.0.1:7890',
    # GitHub 令牌；默认依次取 $env:GH_TOKEN、凭据管理器
    [string]$Token,
    # DSH 主目录；默认 %USERPROFILE%\.dsh
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text)   { Write-Host "    [OK] $text" -ForegroundColor Green }
function Write-Skip([string]$text) { Write-Host "    [跳过] $text" -ForegroundColor DarkGray }
function Write-Warn2([string]$text){ Write-Host "    [!] $text" -ForegroundColor Yellow }
function Write-Plan([string]$text) { Write-Host "    [将执行] $text" -ForegroundColor Magenta }

# ── 仓库根目录（脚本位于 <repo>/scripts/）──────────────────────────────
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$proxyArgs = @()
if ($Proxy -ne '') { $proxyArgs = @('-x', $Proxy, '--ssl-no-revoke') }

# ── 1. 读取并校验版本号 ────────────────────────────────────────────────
Write-Step '1/7 校验版本号'
$pkgPath = Join-Path $repoRoot 'package.json'
$pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
$version = [string]$pkg.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "package.json 的 version 不是 x.y.z 形式: '$version'" }
$tag = "v$version"
Write-Ok "package.json version = $version  (标签 $tag)"

$indexPath = Join-Path $repoRoot 'lib\index.js'
$indexText = Get-Content -LiteralPath $indexPath -Raw
$buildMatch = [regex]::Match($indexText, 'buildId\s*=\s*"dsh-session-cleaner v([^"]+)"')
if (-not $buildMatch.Success) { throw 'lib/index.js 里找不到 buildId = "dsh-session-cleaner vX.Y.Z"' }
$buildVersion = $buildMatch.Groups[1].Value
if ($buildVersion -ne $version) {
    throw "版本号不一致：package.json=$version，lib/index.js buildId=v$buildVersion。请先把两处改成同一个版本号。"
}
Write-Ok "lib/index.js buildId = v$buildVersion（与 package.json 一致）"

# ── 2. 打包 zip ───────────────────────────────────────────────────────
Write-Step '2/7 打包发行 zip'
$zipName = "dsh-session-cleaner-$version.zip"
$zipPath = Join-Path $repoRoot $zipName
$stage = Join-Path $env:TEMP "scl-release-stage-$version"
$stageRoot = Join-Path $stage 'dsh-session-cleaner'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stageRoot 'lib') -Force | Out-Null
foreach ($f in 'package.json', 'README.md', 'README.en.md', 'LICENSE', 'cordis.patch.yml') {
    Copy-Item -LiteralPath (Join-Path $repoRoot $f) -Destination $stageRoot -Force
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'lib\client.js') -Destination (Join-Path $stageRoot 'lib') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'lib\index.js')  -Destination (Join-Path $stageRoot 'lib') -Force
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal
$sha = (Get-FileHash $zipPath -Algorithm SHA256).Hash
Write-Ok "$zipName  $([math]::Round((Get-Item $zipPath).Length / 1KB, 1)) KB"
Write-Ok "SHA256 = $sha"

# ── 3. 同步到 DSH 的两处安装目录 ───────────────────────────────────────
Write-Step '3/7 同步到 DSH 安装目录'
if ($SkipSync) {
    Write-Skip '按参数要求跳过'
} else {
    $targets = @(
        (Join-Path $DshHome 'profiles\desktop\local\dsh-session-cleaner'),
        (Join-Path $DshHome 'profiles\desktop\node_modules\dsh-session-cleaner')
    )
    foreach ($t in $targets) {
        if (-not (Test-Path $t)) { Write-Warn2 "不存在（跳过）: $t"; continue }
        if ($DryRun) { Write-Plan "覆盖 $t\lib\client.js、lib\index.js、package.json"; continue }
        Copy-Item -LiteralPath (Join-Path $repoRoot 'lib\client.js') -Destination (Join-Path $t 'lib\client.js') -Force
        Copy-Item -LiteralPath (Join-Path $repoRoot 'lib\index.js')  -Destination (Join-Path $t 'lib\index.js')  -Force
        Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json')  -Destination (Join-Path $t 'package.json')  -Force
        $installed = (Get-Content -LiteralPath (Join-Path $t 'package.json') -Raw | ConvertFrom-Json).version
        Write-Ok "$t  ->  $installed"
    }
}

# ── 4. git 提交、打标签、推送 ──────────────────────────────────────────
Write-Step '4/7 git 提交 / 标签 / 推送'
if ($SkipGit) {
    Write-Skip '按参数要求跳过'
} else {
    $dirty = @(git status --porcelain)
    if ($dirty.Count -eq 0) {
        Write-Ok '没有待提交改动'
    } elseif ($DryRun) {
        Write-Plan "提交 $($dirty.Count) 个文件并推送 main"
    } else {
        git add -A
        git commit -m "release: $tag" | Out-Null
        Write-Ok "已提交: release: $tag"
        git push origin main
        Write-Ok 'main 已推送'
    }
    $tagExists = [bool](git tag -l $tag)
    if ($tagExists) {
        Write-Ok "标签 $tag 已存在（指向 $(git rev-list -n 1 $tag))"
    } elseif ($DryRun) {
        Write-Plan "创建标签 $tag 并推送"
    } else {
        git tag -a $tag -m "dsh-session-cleaner $tag"
        git push origin $tag
        Write-Ok "标签 $tag 已创建并推送"
    }
}

# ── 5. 取得 GitHub 令牌 ────────────────────────────────────────────────
Write-Step '5/7 准备 GitHub 鉴权'
$useGh = $false
if (Get-Command gh -ErrorAction SilentlyContinue) {
    gh auth status *> $null
    if ($LASTEXITCODE -eq 0) { $useGh = $true }
}
if ($useGh) {
    Write-Ok '检测到已登录的 GitHub CLI，用 gh 调用 API'
} else {
    if (-not $Token) { $Token = $env:GH_TOKEN }
    if (-not $Token) {
        try {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SclCred {
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void CredFree(IntPtr buffer);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
}
'@ -Language CSharp
            $ptr = [IntPtr]::Zero
            if ([SclCred]::CredRead('git:https://github.com', 1, 0, [ref]$ptr)) {
                $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][SclCred+CREDENTIAL])
                $Token = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, $cred.CredentialBlobSize / 2)
                [SclCred]::CredFree($ptr) | Out-Null
            }
        } catch { $Token = $null }
    }
    if ($Token) {
        $env:GH_TOKEN = $Token   # 只放环境变量，绝不打印，也不进命令行
        Write-Ok '令牌已就绪（来自环境变量或 Windows 凭据管理器）'
    } else {
        Write-Warn2 '没拿到令牌：将跳过 Release 创建，只把 zip 留在本地并打印手工操作提示'
    }
}

$repoSlug = 'jackxiao17/dsh-session-cleaner'
$remoteUrl = (git remote get-url origin) 2>$null
if ($remoteUrl -match 'github\.com[:/]([^/]+)/([^/.]+)') { $repoSlug = "$($matches[1])/$($matches[2])" }
Write-Ok "目标仓库: $repoSlug"

# 该标签的 Release 是否已存在（重跑脚本时给明确提示，不当成失败）
$existingRelease = $null
if (-not $SkipRelease) {
    if ($useGh) {
        $ghOut = gh release view $tag --json url 2>$null
        if ($LASTEXITCODE -eq 0 -and $ghOut) { $existingRelease = @{ html_url = (($ghOut | ConvertFrom-Json).url) } }
    } elseif ($env:GH_TOKEN) {
        $exFile = Join-Path $env:TEMP "scl-release-exists-$version.json"
        $exCode = & curl.exe -sS -o $exFile -w '%{http_code}' @proxyArgs `
            -H 'User-Agent: dsh-release' -H "Authorization: Bearer $env:GH_TOKEN" `
            -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repoSlug/releases/tags/$tag"
        if ($exCode -eq '200') {
            $existingRelease = [System.IO.File]::ReadAllText($exFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        }
        Remove-Item $exFile -Force -ErrorAction SilentlyContinue
    }
}

# ── 6. 创建 Release 并上传 zip ─────────────────────────────────────────
Write-Step '6/7 创建 Release 并上传 zip'
$assetUrl = "https://github.com/$repoSlug/releases/download/$tag/$zipName"
if ($SkipRelease) {
    Write-Skip '按参数要求跳过'
} elseif (-not $useGh -and -not $env:GH_TOKEN) {
    Write-Warn2 '无令牌，跳过。可手工在 GitHub 上以标签建 Release 并上传下列文件：'
    Write-Host "      $zipPath"
} elseif ($existingRelease) {
    Write-Warn2 "Release $tag 已存在（$(if ($existingRelease.html_url) { $existingRelease.html_url } else { '见仓库 Releases' })）"
    Write-Warn2 "如需重发请先去 GitHub 删除该 Release，再重跑本脚本：$zipPath"
} elseif ($DryRun) {
    Write-Plan "创建 Release $tag（标题 dsh-session-cleaner $tag）并上传 $zipName"
} else {
    $notesPath = Join-Path $env:TEMP "scl-release-notes-$version.md"
    @(
        "## dsh-session-cleaner $tag"
        ''
        '### 安装'
        "下载下方 ``$zipName`` 解压得到 ``dsh-session-cleaner/`` 文件夹，按 README「安装」小节放入 ``~/.dsh/profiles/desktop/local/`` 并在 profile 的 ``package.json`` 里登记后重启 DSH。"
        '已装用户直接覆盖两处插件目录即可（详见 README「开发与同步」）。'
        ''
        '### 校验'
        "``SHA256($zipName) = $sha``"
    ) | Set-Content -LiteralPath $notesPath -Encoding utf8

    if ($useGh) {
        gh release create $tag --title "dsh-session-cleaner $tag" --notes-file $notesPath $zipPath
        Write-Ok "Release $tag 已创建并上传"
    } else {
        $api = "https://api.github.com/repos/$repoSlug/releases"
        $payloadFile = Join-Path $env:TEMP "scl-release-body-$version.json"
        $bodyText = [System.IO.File]::ReadAllText($notesPath, [System.Text.Encoding]::UTF8)
        $payload = @{ tag_name = $tag; name = "dsh-session-cleaner $tag"; body = $bodyText; draft = $false; prerelease = $false } | ConvertTo-Json -Depth 4
        [System.IO.File]::WriteAllText($payloadFile, $payload, (New-Object System.Text.UTF8Encoding($false)))

        $respFile = Join-Path $env:TEMP "scl-release-resp-$version.json"
        $code = & curl.exe -sS -o $respFile -w '%{http_code}' @proxyArgs `
            -H 'User-Agent: dsh-release' -H "Authorization: Bearer $env:GH_TOKEN" `
            -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json; charset=utf-8' `
            --data-binary "@$payloadFile" $api
        $resp = [System.IO.File]::ReadAllText($respFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($code -ne '201') { throw "创建 Release 失败（HTTP $code）: $($resp.message)" }
        $uploadUrl = $resp.upload_url -replace '\{.*$', ''
        Write-Ok "Release 已创建: $($resp.html_url)"

        $assetRespFile = Join-Path $env:TEMP "scl-asset-resp-$version.json"
        $code2 = & curl.exe -sS -o $assetRespFile -w '%{http_code}' @proxyArgs `
            -H 'User-Agent: dsh-release' -H "Authorization: Bearer $env:GH_TOKEN" `
            -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/zip' `
            --data-binary "@$zipPath" "$uploadUrl`?name=$zipName"
        $asset = [System.IO.File]::ReadAllText($assetRespFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($code2 -ne '201') { throw "上传 zip 失败（HTTP $code2）: $($asset.message)" }
        Write-Ok "附件已上传: $($asset.name)  $([math]::Round($asset.size / 1KB, 1)) KB"
        Remove-Item $payloadFile, $respFile, $assetRespFile, $notesPath -Force -ErrorAction SilentlyContinue
    }
}

# ── 7. 结果汇总 ────────────────────────────────────────────────────────
Write-Step '7/7 汇总'
Write-Host "    版本      : $version"
Write-Host "    标签      : $tag"
Write-Host "    发行包    : $zipPath"
Write-Host "    SHA256    : $sha"
Write-Host "    下载直链  : $assetUrl"
Write-Host "    Release   : https://github.com/$repoSlug/releases/tag/$tag"
Write-Host ''
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
