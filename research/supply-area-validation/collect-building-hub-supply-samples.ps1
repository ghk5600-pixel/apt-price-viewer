param(
  [string]$SecretPath = (Join-Path $env:LOCALAPPDATA "Temp\apt-price-viewer-molit-key.dpapi"),
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\output\supply-area-validation"),
  [int]$SamplePageCount = 7,
  [int]$RowsPerPage = 100
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$samples = @(
  [pscustomobject]@{ Decade = "1990s"; Name = "수서한아름"; Usedate = "19931101"; BjdCode = "1168011500"; Lot = "712" },
  [pscustomobject]@{ Decade = "1990s"; Name = "이촌한가람"; Usedate = "19980918"; BjdCode = "1117012900"; Lot = "404" },
  [pscustomobject]@{ Decade = "1990s"; Name = "신도림동아1차"; Usedate = "19991130"; BjdCode = "1153010100"; Lot = "643" },
  [pscustomobject]@{ Decade = "2000s"; Name = "타워팰리스1차"; Usedate = "20021023"; BjdCode = "1168011800"; Lot = "467" },
  [pscustomobject]@{ Decade = "2000s"; Name = "잠실엘스"; Usedate = "20080930"; BjdCode = "1171010100"; Lot = "19" },
  [pscustomobject]@{ Decade = "2000s"; Name = "반포자이"; Usedate = "20090313"; BjdCode = "1165010700"; Lot = "20-43" },
  [pscustomobject]@{ Decade = "2010s"; Name = "래미안대치팰리스"; Usedate = "20150922"; BjdCode = "1168010600"; Lot = "1027" },
  [pscustomobject]@{ Decade = "2010s"; Name = "아크로리버파크"; Usedate = "20160830"; BjdCode = "1165010700"; Lot = "2-12" },
  [pscustomobject]@{ Decade = "2010s"; Name = "헬리오시티"; Usedate = "20181228"; BjdCode = "1171010700"; Lot = "913" },
  [pscustomobject]@{ Decade = "2020s"; Name = "고덕아르테온"; Usedate = "20200226"; BjdCode = "1174010300"; Lot = "519" },
  [pscustomobject]@{ Decade = "2020s"; Name = "디에이치자이개포"; Usedate = "20210730"; BjdCode = "1168011400"; Lot = "743" },
  [pscustomobject]@{ Decade = "2020s"; Name = "래미안원베일리"; Usedate = "20230830"; BjdCode = "1165010700"; Lot = "1" }
)

function Get-LotParts {
  param([Parameter(Mandatory)][string]$Lot)

  $parts = $Lot.Split("-")
  return [pscustomobject]@{
    Bun = $parts[0].PadLeft(4, "0")
    Ji = if ($parts.Count -gt 1) { $parts[1].PadLeft(4, "0") } else { "0000" }
  }
}

function Get-BuildingHubPage {
  param(
    [Parameter(Mandatory)][string]$EncodedServiceKey,
    [Parameter(Mandatory)]$Sample,
    [Parameter(Mandatory)][int]$PageNumber,
    [Parameter(Mandatory)][int]$PageSize
  )

  $lot = Get-LotParts -Lot $Sample.Lot
  $sigunguCode = $Sample.BjdCode.Substring(0, 5)
  $legalDongCode = $Sample.BjdCode.Substring(5, 5)
  $uri = "https://apis.data.go.kr/1613000/BldRgstHubService/getBrExposPubuseAreaInfo" +
    "?serviceKey=$EncodedServiceKey" +
    "&sigunguCd=$sigunguCode" +
    "&bjdongCd=$legalDongCode" +
    "&platGbCd=0" +
    "&bun=$($lot.Bun)" +
    "&ji=$($lot.Ji)" +
    "&numOfRows=$PageSize" +
    "&pageNo=$PageNumber" +
    "&_type=json"

  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $raw = ((& curl.exe -sS --max-time 60 $uri) -join "")
    if ($LASTEXITCODE -eq 0 -and $raw.StartsWith("{")) {
      try {
        $payload = $raw | ConvertFrom-Json
        if ($payload.response.header.resultCode -eq "00") {
          return $payload
        }
      } catch {
        # Retry malformed or transient gateway responses.
      }
    }
    Start-Sleep -Seconds ([Math]::Min(10, $attempt * 2))
  }

  throw "Building HUB request failed: $($Sample.Name), page $PageNumber"
}

function Get-SamplePages {
  param(
    [Parameter(Mandatory)][int]$TotalCount,
    [Parameter(Mandatory)][int]$PageSize,
    [Parameter(Mandatory)][int]$DesiredPageCount
  )

  $totalPages = [Math]::Max(1, [Math]::Ceiling($TotalCount / $PageSize))
  if ($totalPages -le $DesiredPageCount) {
    return 1..$totalPages
  }

  $pages = for ($index = 0; $index -lt $DesiredPageCount; $index++) {
    1 + [Math]::Round(($totalPages - 1) * $index / ($DesiredPageCount - 1))
  }
  return @($pages | Sort-Object -Unique)
}

function Test-ResidentialCommonPurpose {
  param([string]$Purpose)

  $hasResidentialElement = $Purpose -match "계단|복도|홀|현관|승강기|엘리베이터|코아|코어|로비|라운지|벽체"
  $hasNonResidentialElement = $Purpose -match "관리|경비|보육|어린이|노인|경로|독서|회의|주민|커뮤니티|주차|기계|전기|발전|펌프|변전|급수|저수|정화|쓰레기|근린|판매|상가|문화|스튜디오|아트|도서|열람|생태|학습|화장실|창고|공조|방재|MDF|휀룸|체육|운동|수영|사우나|골프|게스트|세탁|공중정원|아이돌봄|인포|행사|건강|창업|지역"
  return $hasResidentialElement -and -not $hasNonResidentialElement
}

function Test-ShelterPurpose {
  param([string]$Purpose)
  return $Purpose -match "대피"
}

if (-not (Test-Path -LiteralPath $SecretPath)) {
  throw "Temporary DPAPI key file was not found."
}

$encryptedKey = (Get-Content -LiteralPath $SecretPath -Raw).Trim()
$secureKey = ConvertTo-SecureString -String $encryptedKey
$keyPointer = [IntPtr]::Zero

try {
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $serviceKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  $encodedServiceKey = [Uri]::EscapeDataString($serviceKey)

  $unitRows = New-Object System.Collections.Generic.List[object]
  $complexAudits = New-Object System.Collections.Generic.List[object]

  foreach ($sample in $samples) {
    $countPayload = Get-BuildingHubPage -EncodedServiceKey $encodedServiceKey -Sample $sample -PageNumber 1 -PageSize 1
    $totalCount = [int]$countPayload.response.body.totalCount
    if ($totalCount -le 0) {
      throw "Building HUB returned no rows for $($sample.Name)."
    }

    $pages = Get-SamplePages -TotalCount $totalCount -PageSize $RowsPerPage -DesiredPageCount $SamplePageCount
    $records = New-Object System.Collections.Generic.List[object]
    $edgeKeys = New-Object "System.Collections.Generic.HashSet[string]"

    foreach ($page in $pages) {
      $payload = Get-BuildingHubPage -EncodedServiceKey $encodedServiceKey -Sample $sample -PageNumber $page -PageSize $RowsPerPage
      $items = @($payload.response.body.items.item)
      if ($items.Count -eq 0) {
        continue
      }

      [void]$edgeKeys.Add([string]$items[0].mgmBldrgstPk)
      [void]$edgeKeys.Add([string]$items[-1].mgmBldrgstPk)
      foreach ($item in $items) {
        $records.Add($item)
      }
      Start-Sleep -Milliseconds 900
    }

    $completeGroups = @($records | Group-Object mgmBldrgstPk | Where-Object {
      -not $edgeKeys.Contains([string]$_.Name)
    })

    foreach ($group in $completeGroups) {
      $exclusiveRows = @($group.Group | Where-Object { $_.exposPubuseGbCdNm.Trim() -eq "전유" })
      $commonRows = @($group.Group | Where-Object { $_.exposPubuseGbCdNm.Trim() -eq "공용" })
      if ($exclusiveRows.Count -ne 1 -or $commonRows.Count -eq 0) {
        continue
      }

      $exclusiveArea = [double]$exclusiveRows[0].area
      $exclusivePurpose = ("{0} {1}" -f $exclusiveRows[0].mainPurpsCdNm, $exclusiveRows[0].etcPurps).Trim()
      if ($exclusiveArea -le 10 -or $exclusivePurpose -notmatch "아파트|공동주택") {
        continue
      }

      $structuralCommonArea = 0.0
      $shelterArea = 0.0
      $otherCommonArea = 0.0
      $purposeParts = New-Object System.Collections.Generic.List[string]

      foreach ($common in $commonRows) {
        $area = [double]$common.area
        $purpose = ("{0} {1}" -f $common.mainPurpsCdNm, $common.etcPurps).Trim()
        $purposeParts.Add(("{0}:{1:N4}" -f $purpose, $area))
        if (Test-ResidentialCommonPurpose -Purpose $purpose) {
          $structuralCommonArea += $area
        } elseif (Test-ShelterPurpose -Purpose $purpose) {
          $shelterArea += $area
        } else {
          $otherCommonArea += $area
        }
      }

      $residentialCommonArea = $structuralCommonArea + $shelterArea
      $candidateSupplyArea = $exclusiveArea + $residentialCommonArea
      $unitRows.Add([pscustomobject]@{
        Decade = $sample.Decade
        Complex = $sample.Name
        Usedate = $sample.Usedate
        Lot = $sample.Lot
        RegisterKey = [string]$group.Name
        Dong = [string]$exclusiveRows[0].dongNm
        Ho = [string]$exclusiveRows[0].hoNm
        ExclusiveM2 = [Math]::Round($exclusiveArea, 4)
        StructuralCommonM2 = [Math]::Round($structuralCommonArea, 4)
        ShelterM2 = [Math]::Round($shelterArea, 4)
        ResidentialCommonM2 = [Math]::Round($residentialCommonArea, 4)
        OtherCommonM2 = [Math]::Round($otherCommonArea, 4)
        CandidateSupplyM2 = [Math]::Round($candidateSupplyArea, 4)
        CandidatePyeong = [Math]::Round($candidateSupplyArea / 3.305785, 2)
        CommonPurposes = ($purposeParts -join " | ")
      })
    }

    $complexAudits.Add([pscustomobject]@{
      Decade = $sample.Decade
      Complex = $sample.Name
      Usedate = $sample.Usedate
      BuildingHubLot = $sample.Lot
      TotalApiRows = $totalCount
      SampledPages = ($pages -join ",")
      SampledApiRows = $records.Count
      CompleteUnits = @($unitRows | Where-Object { $_.Complex -eq $sample.Name }).Count
    })
  }

  $clusters = @($unitRows |
    Group-Object Complex, @{ Expression = { "{0:N3}" -f $_.ExclusiveM2 } }, @{ Expression = { "{0:N1}" -f $_.CandidateSupplyM2 } } |
    ForEach-Object {
      $first = $_.Group[0]
      [pscustomobject]@{
        Decade = $first.Decade
        Complex = $first.Complex
        Usedate = $first.Usedate
        BuildingHubLot = $first.Lot
        ExclusiveM2 = $first.ExclusiveM2
        StructuralCommonM2 = $first.StructuralCommonM2
        ShelterM2 = $first.ShelterM2
        ResidentialCommonM2 = $first.ResidentialCommonM2
        CandidateSupplyM2 = $first.CandidateSupplyM2
        CandidatePyeong = $first.CandidatePyeong
        SampleUnitCount = $_.Count
        SampleDong = $first.Dong
        SampleHo = $first.Ho
        CommonPurposes = $first.CommonPurposes
      }
    } |
    Sort-Object Decade, Complex, ExclusiveM2, CandidateSupplyM2)

  $representatives = foreach ($sample in $samples) {
    $complexClusters = @($clusters | Where-Object { $_.Complex -eq $sample.Name })
    $near84 = @($complexClusters | Where-Object { $_.ExclusiveM2 -ge 82 -and $_.ExclusiveM2 -le 86 })
    $pool = if ($near84.Count -gt 0) { $near84 } else { $complexClusters }
    $selected = @($pool | Sort-Object @{ Expression = "SampleUnitCount"; Descending = $true }, @{ Expression = { [Math]::Abs($_.ExclusiveM2 - 84) } })[0]
    if ($null -eq $selected) {
      continue
    }

    [pscustomobject]@{
      Decade = $selected.Decade
      Complex = $selected.Complex
      Usedate = $selected.Usedate
      BuildingHubLot = $selected.BuildingHubLot
      HubExclusiveM2 = $selected.ExclusiveM2
      HubStructuralCommonM2 = $selected.StructuralCommonM2
      HubShelterM2 = $selected.ShelterM2
      HubResidentialCommonM2 = $selected.ResidentialCommonM2
      HubCandidateSupplyM2 = $selected.CandidateSupplyM2
      HubCandidatePyeong = $selected.CandidatePyeong
      SampleUnitCount = $selected.SampleUnitCount
      NaverExclusiveM2 = ""
      NaverSupplyM2 = ""
      SupplyDifferenceM2 = ""
      Validation = ""
    }
  }

  $resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
  New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
  $complexAudits | Export-Csv -LiteralPath (Join-Path $resolvedOutput "building-hub-audit.csv") -NoTypeInformation -Encoding UTF8
  $unitRows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $resolvedOutput "building-hub-sampled-units.json") -Encoding UTF8
  $clusters | Export-Csv -LiteralPath (Join-Path $resolvedOutput "building-hub-area-clusters.csv") -NoTypeInformation -Encoding UTF8
  $representatives | Export-Csv -LiteralPath (Join-Path $resolvedOutput "naver-validation-input.csv") -NoTypeInformation -Encoding UTF8

  [pscustomobject]@{
    OutputDirectory = $resolvedOutput
    ComplexCount = $samples.Count
    UnitCount = $unitRows.Count
    ClusterCount = $clusters.Count
    RepresentativeCount = @($representatives).Count
  } | ConvertTo-Json -Depth 3
} finally {
  if ($keyPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
  Remove-Variable serviceKey, encodedServiceKey -ErrorAction SilentlyContinue
}
