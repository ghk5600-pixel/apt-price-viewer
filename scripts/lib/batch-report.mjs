const LATE_CATALOG_REASONS = new Set([
  "apartment-component-match-uncertain",
  "apartment-component-not-found",
  "building-purpose-unverified",
  "no-apartment-sale-trade-match",
  "rtms-verification-incomplete",
]);

const REASON_LABELS = {
  "apartment-component-match-uncertain": "아파트 관리번호 확정 실패",
  "apartment-component-not-found": "아파트 용도 건물 미확인",
  "building-purpose-unverified": "건축물 용도 검증 실패",
  "no-apartment-sale-trade-match": "최근 24개월 아파트 매매 실거래 연결 실패",
  "rtms-verification-incomplete": "실거래 검증 API 일부 실패",
  "built-before-target-range": "대상 준공기간 이전",
  "built-after-target-range": "대상 준공기간 이후",
  "under-200-households": "200세대 미만",
  "non-sale-tenure": "분양형 아님",
  "unsupported-housing-type": "일반 아파트·주상복합 아님",
  "excluded-housing-program": "제외 주택 유형",
  "unmapped-lot": "지번 변환 실패",
  NO_RESIDENTIAL_UNITS: "공급면적을 계산할 아파트 세대 미확인",
};

export function renderBatchReport(report) {
  const view = buildReportView(report);
  return {
    html: renderHtml(report, view),
    csv: renderCsv(view),
  };
}

export function buildReportView(report) {
  const collectionResults = asArray(report?.collection?.results);
  const ready = collectionResults.filter((result) => result?.status === "ready");
  const successes = ready.filter((result) => coverage(result) >= 0.95);
  const reviews = ready.filter((result) => coverage(result) < 0.95);
  const failures = collectionResults.filter(
    (result) => result?.status && result.status !== "ready"
  );
  const lateExclusions = asArray(report?.catalog?.excludedComplexes)
    .filter((entry) =>
      asArray(entry?.reasons).some((reason) => LATE_CATALOG_REASONS.has(reason))
    )
    .map((entry) => ({
      ...entry,
      reasonLabels: asArray(entry.reasons)
        .filter((reason) => LATE_CATALOG_REASONS.has(reason))
        .map(reasonLabel),
    }));

  return {
    successes,
    reviews,
    failures,
    lateExclusions,
    staticExclusions: Object.entries(report?.catalog?.exclusions || {})
      .map(([reason, count]) => ({
        reason,
        label: reasonLabel(reason),
        count: Number(count) || 0,
      }))
      .sort((left, right) => right.count - left.count),
    apiErrors: asArray(report?.catalog?.errors),
    summary: {
      sourceRows: Number(report?.catalog?.sourceApartmentRows) || 0,
      discovered: Number(report?.catalog?.discoveredComplexes) || 0,
      eligible: Number(report?.catalog?.eligibleComplexes) || 0,
      success: successes.length,
      review: reviews.length,
      failure: failures.length,
      lateExcluded: lateExclusions.length,
      apiError: asArray(report?.catalog?.errors).length,
      apiCalls: Number(report?.apiCallCount) || 0,
    },
  };
}

function renderHtml(report, view) {
  const range = [
    displayDate(report?.scope?.approvalDateFrom),
    displayDate(report?.scope?.approvalDateTo),
  ]
    .filter(Boolean)
    .join(" ~ ");
  const generatedAt = displayDateTime(report?.finishedAt || report?.startedAt);
  const summaryCards = [
    ["서울 K-apt 후보", view.summary.sourceRows, "neutral"],
    ["최종 계산 대상", view.summary.eligible, "neutral"],
    ["성공", view.summary.success, "success"],
    ["재검토", view.summary.review, "review"],
    ["계산 실패", view.summary.failure, "failure"],
    ["계산 전 검증 실패", view.summary.lateExcluded, "failure"],
  ]
    .map(
      ([label, value, tone]) =>
        `<article class="metric ${tone}"><span>${escapeHtml(label)}</span>` +
        `<strong>${formatNumber(value)}</strong></article>`
    )
    .join("");

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>서울 아파트 공급면적 배치 보고서</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #111827;
      --muted: #64748b;
      --line: #dbe3ed;
      --surface: #ffffff;
      --canvas: #f4f7fb;
      --blue: #2563eb;
      --green: #15803d;
      --green-bg: #ecfdf3;
      --amber: #a16207;
      --amber-bg: #fffbeb;
      --red: #b91c1c;
      --red-bg: #fef2f2;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--canvas);
      color: var(--ink);
      font-family: Arial, "Noto Sans KR", sans-serif;
      letter-spacing: 0;
    }
    main { width: min(1500px, calc(100% - 32px)); margin: 28px auto 60px; }
    header { padding: 26px 0 20px; border-bottom: 1px solid var(--line); }
    h1 { margin: 0 0 10px; font-size: 30px; }
    h2 { margin: 34px 0 12px; font-size: 20px; }
    p { margin: 6px 0; color: var(--muted); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(130px, 1fr));
      gap: 10px;
      margin-top: 20px;
    }
    .metric {
      min-height: 94px;
      padding: 16px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric span { display: block; color: var(--muted); font-size: 13px; }
    .metric strong { display: block; margin-top: 12px; font-size: 28px; }
    .metric.success { background: var(--green-bg); border-color: #bbf7d0; }
    .metric.success strong { color: var(--green); }
    .metric.review { background: var(--amber-bg); border-color: #fde68a; }
    .metric.review strong { color: var(--amber); }
    .metric.failure { background: var(--red-bg); border-color: #fecaca; }
    .metric.failure strong { color: var(--red); }
    .table-wrap {
      overflow-x: auto;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    table { width: 100%; border-collapse: collapse; min-width: 980px; }
    th, td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 13px;
    }
    th { background: #eef3f9; color: #475569; white-space: nowrap; }
    tr:last-child td { border-bottom: 0; }
    .number { text-align: right; white-space: nowrap; }
    .status {
      display: inline-block;
      min-width: 58px;
      padding: 4px 8px;
      border-radius: 999px;
      font-weight: 700;
      text-align: center;
    }
    .status.success { color: var(--green); background: var(--green-bg); }
    .status.review { color: var(--amber); background: var(--amber-bg); }
    .status.failure { color: var(--red); background: var(--red-bg); }
    .empty { padding: 24px; color: var(--muted); background: var(--surface); border: 1px solid var(--line); }
    .footnote { margin-top: 26px; font-size: 12px; }
    @media (max-width: 980px) {
      .metrics { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
      main { width: min(100% - 20px, 1500px); }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>서울 아파트 공급면적 배치 보고서</h1>
    <p>대상 준공일: ${escapeHtml(range || "-")} · 최소 200세대 · 분양형 아파트 및 아파트형 주상복합</p>
    <p>버전 ${escapeHtml(report?.version || "-")} · 생성 ${escapeHtml(generatedAt || "-")} · API ${formatNumber(view.summary.apiCalls)}회</p>
    <section class="metrics">${summaryCards}</section>
  </header>

  <h2>성공 단지</h2>
  ${renderResultTable(view.successes, "success")}

  <h2>재검토 단지</h2>
  <p>계산은 완료됐지만 K-apt 세대수 대비 수집률이 95% 미만입니다.</p>
  ${renderResultTable(view.reviews, "review")}

  <h2>공급면적 계산 실패</h2>
  ${renderFailureTable(view.failures)}

  <h2>계산 전 검증 실패</h2>
  <p>실거래 연결 또는 아파트 건축물 관리번호 확정 단계에서 제외된 단지입니다.</p>
  ${renderLateExclusionTable(view.lateExclusions)}

  <h2>API 수집 오류</h2>
  <p>K-apt, 국토부 실거래가 또는 건축HUB 요청 중 응답 오류가 발생한 항목입니다.</p>
  ${renderApiErrorTable(view.apiErrors)}

  <h2>전체 제외 사유 집계</h2>
  ${renderExclusionCounts(view.staticExclusions)}

  <p class="footnote">성공 결과는 Cloudflare D1 공급면적 캐시에 저장됩니다. 재검토 결과도 기술적으로 저장되므로 수집률을 확인한 뒤 사용해야 합니다.</p>
</main>
</body>
</html>`;
}

function renderResultTable(results, tone) {
  if (!results.length) return `<div class="empty">해당 단지가 없습니다.</div>`;
  const rows = results
    .map((result) => {
      const validation = result.validation || {};
      return `<tr>
        <td><span class="status ${tone}">${tone === "success" ? "성공" : "재검토"}</span></td>
        <td>${escapeHtml(result.complexName || "")}</td>
        <td>${escapeHtml(result.kaptCode || "")}</td>
        <td>${escapeHtml(displayDate(result.approvalDate))}</td>
        <td class="number">${formatNumber(result.households)}</td>
        <td class="number">${formatNumber(validation.collectedHouseholds)}</td>
        <td class="number">${formatPercent(validation.coverageRate)}</td>
        <td>${escapeHtml(formatSupplyGroups(result.supplyGroups))}</td>
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table>
    <thead><tr><th>상태</th><th>단지</th><th>K-apt 코드</th><th>준공일</th><th>전체 세대</th><th>수집 세대</th><th>수집률</th><th>공급면적 그룹</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderFailureTable(results) {
  if (!results.length) return `<div class="empty">계산 실패 단지가 없습니다.</div>`;
  const rows = results
    .map(
      (result) => `<tr>
        <td><span class="status failure">실패</span></td>
        <td>${escapeHtml(result.complexName || "")}</td>
        <td>${escapeHtml(result.kaptCode || "")}</td>
        <td>${escapeHtml(displayDate(result.approvalDate))}</td>
        <td>${escapeHtml(reasonLabel(result.failureReason || result.errorDetails?.resultCode || result.status))}</td>
        <td>${escapeHtml(result.error || "")}</td>
        <td class="number">${formatNumber(result.completedPages)} / ${formatNumber(result.totalPages)}</td>
      </tr>`
    )
    .join("");
  return `<div class="table-wrap"><table>
    <thead><tr><th>상태</th><th>단지</th><th>K-apt 코드</th><th>준공일</th><th>실패 분류</th><th>상세 사유</th><th>처리 페이지</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderLateExclusionTable(results) {
  if (!results.length) return `<div class="empty">계산 전 검증 실패 단지가 없습니다.</div>`;
  const rows = results
    .map(
      (result) => `<tr>
        <td><span class="status failure">제외</span></td>
        <td>${escapeHtml(result.complexName || "")}</td>
        <td>${escapeHtml(result.kaptCode || "")}</td>
        <td>${escapeHtml(displayDate(result.approvalDate))}</td>
        <td>${escapeHtml(result.reasonLabels.join(", "))}</td>
        <td>${escapeHtml(result.buildingPurpose || "")}</td>
      </tr>`
    )
    .join("");
  return `<div class="table-wrap"><table>
    <thead><tr><th>상태</th><th>단지</th><th>K-apt 코드</th><th>준공일</th><th>실패 사유</th><th>확인된 건축물 용도</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderApiErrorTable(results) {
  if (!results.length) return `<div class="empty">API 수집 오류가 없습니다.</div>`;
  const rows = results
    .map(
      (result) => `<tr>
        <td>${escapeHtml(result.stage || "")}</td>
        <td>${escapeHtml(result.complexName || result.kaptName || "")}</td>
        <td>${escapeHtml(result.kaptCode || "")}</td>
        <td>${escapeHtml(result.lawdCd || result.bjdCode || "")}</td>
        <td>${escapeHtml(result.dealYmd || result.approvalDate || "")}</td>
        <td>${escapeHtml(result.error || result.message || "")}</td>
      </tr>`
    )
    .join("");
  return `<div class="table-wrap"><table>
    <thead><tr><th>단계</th><th>단지</th><th>K-apt 코드</th><th>지역 코드</th><th>기준일</th><th>오류 내용</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderExclusionCounts(items) {
  if (!items.length) return `<div class="empty">제외 사유가 없습니다.</div>`;
  const rows = items
    .map(
      (item) => `<tr><td>${escapeHtml(item.label)}</td>` +
        `<td><code>${escapeHtml(item.reason)}</code></td>` +
        `<td class="number">${formatNumber(item.count)}</td></tr>`
    )
    .join("");
  return `<div class="table-wrap"><table>
    <thead><tr><th>사유</th><th>코드</th><th>단지 수</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderCsv(view) {
  const rows = [
    [
      "상태",
      "단지명",
      "K-apt코드",
      "준공일",
      "K-apt세대수",
      "수집세대수",
      "수집률",
      "공급면적그룹",
      "실패분류",
      "상세사유",
    ],
  ];

  for (const [items, status] of [
    [view.successes, "성공"],
    [view.reviews, "재검토"],
  ]) {
    for (const result of items) {
      rows.push([
        status,
        result.complexName,
        result.kaptCode,
        displayDate(result.approvalDate),
        result.households,
        result.validation?.collectedHouseholds,
        formatPercent(result.validation?.coverageRate),
        formatSupplyGroups(result.supplyGroups),
        "",
        "",
      ]);
    }
  }

  for (const result of view.failures) {
    rows.push([
      "계산 실패",
      result.complexName,
      result.kaptCode,
      displayDate(result.approvalDate),
      result.households,
      result.validation?.collectedHouseholds,
      formatPercent(result.validation?.coverageRate),
      "",
      reasonLabel(result.failureReason || result.errorDetails?.resultCode || result.status),
      result.error,
    ]);
  }

  for (const result of view.lateExclusions) {
    rows.push([
      "계산 전 검증 실패",
      result.complexName,
      result.kaptCode,
      displayDate(result.approvalDate),
      result.households,
      "",
      "",
      "",
      result.reasonLabels.join(", "),
      result.buildingPurpose,
    ]);
  }

  return `\uFEFF${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}\r\n`;
}

function coverage(result) {
  const value = Number(result?.validation?.coverageRate);
  return Number.isFinite(value) ? value : 0;
}

function formatSupplyGroups(groups) {
  return asArray(groups)
    .map((group) => {
      const area = Number(group?.representativeSupplyArea);
      const pyeong = Number(group?.representativeSupplyPyeong);
      const units = Number(group?.unitCount) || 0;
      return `${group?.label || group?.id || "-"} ${formatDecimal(area)}㎡/${formatDecimal(pyeong)}평 (${formatNumber(units)}세대)`;
    })
    .join("; ");
}

function reasonLabel(reason) {
  const normalized = String(reason || "").trim();
  return REASON_LABELS[normalized] || normalized || "원인 미상";
}

function displayDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 8) return String(value || "");
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function displayDateTime(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return String(value || "");
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("ko-KR") : "-";
}

function formatDecimal(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString("ko-KR", { maximumFractionDigits: 4 })
    : "-";
}

function formatPercent(value) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "-";
}

function csvValue(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
