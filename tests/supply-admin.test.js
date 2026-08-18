import assert from "node:assert/strict";
import test from "node:test";
import { buildManualSupplyProfile } from "../functions/_shared/supply-admin.js";

test("관리자 수동 공급면적은 세대수 가중 프로필과 검증 상태를 만든다", () => {
  const manual = buildManualSupplyProfile("kapt:A10020267", {
    expectedHouseholds: 283,
    sourceUrl: "https://example.test/source",
    groups: [
      { label: "81타입", exclusiveArea: 81.27, supplyArea: 108.14, unitCount: 100 },
      { label: "98타입", exclusiveArea: 98.45, supplyArea: 130.12, unitCount: 183 },
    ],
  });
  assert.equal(manual.profile.groups.length, 2);
  assert.equal(manual.profile.unitCount, 283);
  assert.equal(manual.profile.householdValidation.status, "matched");
  assert.equal(manual.profile.manual.verified, true);
});

test("수동 공급면적은 공급면적이 전용면적보다 작으면 거절한다", () => {
  assert.throws(() => buildManualSupplyProfile("kapt:bad", {
    groups: [{ label: "84타입", exclusiveArea: 84, supplyArea: 80, unitCount: 1 }],
  }));
});
