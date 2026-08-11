import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPermitSupplyProfile,
  isPermitResidentialCommonRow,
} from "../functions/_shared/permit-supply.js";

test("permit rows produce household-weighted supply-area candidates", () => {
  const typeRows = [
    typeRow(1, "122", 122.082, 58),
    typeRow(2, "59A", 59.981, 358),
    typeRow(3, "59B", 59.984, 103),
    typeRow(4, "84A", 84.923, 918),
    typeRow(5, "84B", 84.146, 421),
    typeRow(6, "84B-1", 84.146, 1),
    { ...typeRow(7, "store", 24.3, 0), hsTypeGbCd: "9" },
  ];
  const areaRows = [
    ...areaPattern("1026100001982", 84.923, 6.644, 19.701, 1.572),
    ...areaPattern("1026100001984", 122.082, 9.119, 21.187, 2.26),
    ...areaPattern("1026100001990", 59.984, 6.675, 17.99, 1.11),
    ...areaPattern("1026100001991", 84.146, 8.678, 19.522, 1.557),
    ...areaPattern("1026100001993", 59.981, 5.42, 17.989, 1.11),
    ...areaPattern("1026100005074", 84.146, 8.678, 19.787, 1.545),
  ];

  const profile = buildPermitSupplyProfile({
    complexKey: "permit-sample",
    source: {},
    service: "housing-permit",
    typeRows,
    areaRows,
    expectedHouseholds: 1859,
  });

  assert.equal(profile.unitCount, 1859);
  assert.equal(profile.householdValidation.status, "matched");
  assert.deepEqual(
    profile.groups.map((group) => [group.label, group.unitCount]),
    [["59\ud0c0\uc785", 461], ["84\ud0c0\uc785", 1340], ["122\ud0c0\uc785", 58]]
  );
  const group84 = profile.groups.find((group) => group.id === "84");
  assert.deepEqual(
    group84.candidates.map((candidate) => [candidate.supplyArea, candidate.unitCount]),
    [[112.84, 918], [113.903, 421], [114.156, 1]]
  );
  assert.equal(profile.provenance.matchedTypeRows, 6);
  assert.deepEqual(profile.provenance.unmatchedTypes, []);
});

test("large apartment household totals require an exact K-apt match", () => {
  const typeRows = [typeRow(1, "84A", 84.95, 316)];
  const areaRows = areaPattern("1000000000000000000001", 84.95, 6, 20, 1);

  const profile = buildPermitSupplyProfile({
    complexKey: "permit-tolerance",
    source: {},
    service: "housing-permit",
    typeRows,
    areaRows,
    expectedHouseholds: 318,
  });

  assert.equal(profile.householdValidation.status, "mismatch");
  assert.equal(profile.householdValidation.exactMatch, false);
  assert.equal(profile.householdValidation.difference, -2);
  assert.equal(profile.householdValidation.toleranceHouseholds, 4);
});

test("permit common-area rule includes apartment PIT stairs only", () => {
  assert.equal(isPermitResidentialCommonRow(common("0", "02001", "wall", 8)), true);
  assert.equal(
    isPermitResidentialCommonRow(common("1", "02005", "APARTMENT PIT \uacc4\ub2e8\uc2e4", 2)),
    true
  );
  assert.equal(isPermitResidentialCommonRow(common("1", "02005", "parking", 40)), false);
});

function typeRow(rnum, typeGb, exuseArea, hhldCnt) {
  return {
    rnum,
    typeGb,
    exuseArea,
    hhldCnt,
    hsTypeGbCd: "3",
    hsTypeGbCdNm: "\uc544\ud30c\ud2b8",
  };
}

function areaPattern(key, exclusive, wall, stair, pitStair) {
  return [
    {
      mgmTypeOulnPk: key,
      exposPubuseGbCd: "1",
      mainAtchGbCd: "0",
      purpsCd: "02001",
      etcPurps: "apartment",
      area: exclusive,
    },
    common("0", "02001", "wall", wall, key),
    common("0", "02001", "stair", stair, key),
    common("1", "02005", "APARTMENT PIT \uacc4\ub2e8\uc2e4", pitStair, key),
    common("1", "02005", "parking", 50, key),
  ];
}

function common(mainAtchGbCd, purpsCd, etcPurps, area, key = "pk") {
  return {
    mgmTypeOulnPk: key,
    exposPubuseGbCd: "2",
    mainAtchGbCd,
    purpsCd,
    etcPurps,
    area,
  };
}
