import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyPermitProfileFailure,
  migrateCompatiblePermitProfileRecord,
} from "../functions/_shared/permit-supply.js";

test("인허가 사업 세대수가 K-apt 단지보다 크면 사업 범위 불일치로 분류한다", () => {
  const failure = classifyPermitProfileFailure([
    {
      typeRows: 60,
      areaRows: 269,
      matchedTypeRows: 50,
      validation: {
        expectedHouseholds: 610,
        collectedHouseholds: 1163,
        toleranceHouseholds: 7,
      },
    },
  ]);

  assert.equal(failure.resultCode, "PERMIT_PROJECT_SCOPE_MISMATCH");
  assert.equal(failure.retryable, false);
});

test("타입과 면적 행이 있지만 연결되지 않으면 면적 매핑 실패로 분류한다", () => {
  const failure = classifyPermitProfileFailure([
    { typeRows: 5, areaRows: 20, matchedTypeRows: 0 },
  ]);

  assert.equal(failure.resultCode, "PERMIT_AREA_MAPPING_FAILED");
});

test("인허가 세대수가 부족하면 세대수 커버리지 불일치로 분류한다", () => {
  const failure = classifyPermitProfileFailure([
    {
      typeRows: 10,
      areaRows: 40,
      matchedTypeRows: 8,
      validation: {
        expectedHouseholds: 500,
        collectedHouseholds: 420,
        toleranceHouseholds: 5,
      },
    },
  ]);

  assert.equal(failure.resultCode, "PERMIT_HOUSEHOLD_COVERAGE_MISMATCH");
});

test("인허가 타입 행이 없으면 자료 미발견으로 분류한다", () => {
  const failure = classifyPermitProfileFailure([
    { typeRows: 0, areaRows: 0, matchedTypeRows: 0 },
  ]);

  assert.equal(failure.resultCode, "PERMIT_PROFILE_NOT_FOUND");
});

test("기존 인허가 성공 프로필도 엄격 검증 버전에서는 다시 계산한다", () => {
  const record = {
    status: "ready",
    calculationVersion: "supply-model-v7-permit-type-weighted",
    sourceSignature: "same-source",
    profile: {
      calculationVersion: "supply-model-v7-permit-type-weighted",
      groups: [{ label: "84타입" }],
    },
  };

  const migrated = migrateCompatiblePermitProfileRecord(
    record,
    "same-source"
  );

  assert.equal(migrated, false);
  assert.equal(record.calculationVersion, "supply-model-v7-permit-type-weighted");
  assert.equal(
    record.profile.calculationVersion,
    "supply-model-v7-permit-type-weighted"
  );
});

test("지번 서명이 달라진 성공 프로필은 자동 이관하지 않는다", () => {
  const record = {
    status: "ready",
    calculationVersion: "supply-model-v7-permit-type-weighted",
    sourceSignature: "old-source",
    profile: {},
  };

  assert.equal(
    migrateCompatiblePermitProfileRecord(record, "new-source"),
    false
  );
});
