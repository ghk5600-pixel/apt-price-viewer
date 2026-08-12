import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSupplyProfile,
  consumeBuildingAreaRows,
  createCollectionState,
  isApartmentExclusivePurpose,
} from "../functions/_shared/supply-area.js";

function row(key, useType, area, purpose, dong) {
  return {
    mgmBldrgstPk: key,
    exposPubuseGbCdNm: useType,
    area,
    mainPurpsCdNm: purpose,
    etcPurps: "",
    dongNm: dong,
    hoNm: key,
  };
}

test("rental apartment units remain eligible while non-apartment uses stay excluded", () => {
  assert.equal(isApartmentExclusivePurpose("아파트 공공임대"), true);
  assert.equal(isApartmentExclusivePurpose("아파트 민간임대"), true);
  assert.equal(isApartmentExclusivePurpose("아파트 도시형생활주택"), false);
  assert.equal(isApartmentExclusivePurpose("업무시설 오피스텔"), false);
});

test("rental units are included in the same supply-area group and household validation", () => {
  const state = consumeBuildingAreaRows(
    createCollectionState(),
    [
      row("sale-unit", "전유", 84.95, "아파트", "101동"),
      row("sale-unit", "공용", 26.77, "계단", "101동"),
      row("rental-unit", "전유", 84.95, "아파트 공공임대", "102동"),
      row("rental-unit", "공용", 27.9, "계단", "102동"),
    ],
    { isFinal: true }
  );
  const profile = buildSupplyProfile({
    complexKey: "rental-inclusive-complex",
    source: {},
    collectionState: state,
    expectedHouseholds: 2,
  });

  assert.equal(profile.unitCount, 2);
  assert.equal(profile.rentalHouseholds, 1);
  assert.equal(profile.groups[0].unitCount, 2);
  assert.equal(profile.householdValidation.status, "rental-included");
  assert.equal(profile.householdValidation.exactMatch, true);
});
