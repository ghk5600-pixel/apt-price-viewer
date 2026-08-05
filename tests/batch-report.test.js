import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReportView,
  renderBatchReport,
} from "../scripts/lib/batch-report.mjs";

test("배치 보고서를 성공·재검토·실패·계산 전 실패로 분류한다", () => {
  const report = {
    version: "v-test",
    scope: {
      approvalDateFrom: "20100101",
      approvalDateTo: "20191231",
    },
    catalog: {
      sourceApartmentRows: 100,
      discoveredComplexes: 100,
      masterComplexes: 70,
      eligibleComplexes: 3,
      exclusions: {
        "built-before-target-range": 30,
        "apartment-component-match-uncertain": 1,
      },
      excludedComplexes: [
        {
          complexName: "관리번호 실패 단지",
          kaptCode: "A4",
          approvalDate: "20150101",
          households: 400,
          buildingPurpose: "공동주택 / 아파트",
          reasons: ["apartment-component-match-uncertain"],
        },
        {
          complexName: "기간 외 단지",
          kaptCode: "A5",
          reasons: ["built-before-target-range"],
        },
      ],
      errors: [
        {
          stage: "apt-basis",
          complexName: "API 오류 단지",
          kaptCode: "A6",
          error: "HTTP 500",
        },
      ],
    },
    collection: {
      results: [
        result("정상 단지", "A1", "ready", 500, 490, 0.98),
        result("재검토 단지", "A2", "ready", 300, 30, 0.1),
        {
          ...result("실패 단지", "A3", "failed", 200, 0, 0),
          failureReason: "NO_RESIDENTIAL_UNITS",
          error: "공급면적 그룹 없음",
          completedPages: 10,
          totalPages: 11,
        },
      ],
    },
    apiCallCount: 123,
    finishedAt: "2026-07-31T00:00:00.000Z",
  };

  const view = buildReportView(report);
  assert.equal(view.successes.length, 1);
  assert.equal(view.reviews.length, 1);
  assert.equal(view.failures.length, 1);
  assert.equal(view.lateExclusions.length, 1);
  assert.equal(view.apiErrors.length, 1);
  assert.equal(view.summary.apiError, 1);
  assert.equal(view.summary.master, 70);

  const rendered = renderBatchReport(report);
  assert.match(rendered.html, /서울 아파트 공급면적 배치 보고서/);
  assert.match(rendered.html, /공통 카탈로그/);
  assert.match(rendered.html, /정상 단지/);
  assert.match(rendered.html, /재검토 단지/);
  assert.match(rendered.html, /관리번호 실패 단지/);
  assert.match(rendered.html, /API 오류 단지/);
  assert.match(rendered.html, /HTTP 500/);
  assert.match(rendered.csv, /^\uFEFF/);
  assert.match(rendered.csv, /"성공","정상 단지"/);
  assert.match(rendered.csv, /"계산 실패","실패 단지"/);
});

function result(name, kaptCode, status, households, collected, coverageRate) {
  return {
    complexName: name,
    kaptCode,
    approvalDate: "20150630",
    households,
    status,
    validation: {
      collectedHouseholds: collected,
      coverageRate,
    },
    supplyGroups: [
      {
        label: "84타입",
        representativeSupplyArea: 112.5,
        representativeSupplyPyeong: 34.03,
        unitCount: collected,
      },
    ],
  };
}
