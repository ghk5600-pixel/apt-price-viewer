import test from "node:test";
import assert from "node:assert/strict";
import { resolvePermitSourcesFromBasisRows } from "../functions/_shared/permit-match.js";

test("법정동 인허가 기본개요에서 단지명·세대수·사용승인일로 다른 지번을 찾는다", () => {
  const result = resolvePermitSourcesFromBasisRows({
    requestedSource: source("0067"),
    metadata: {
      complexName: "송파더플래티넘",
      expectedHouseholds: 328,
      approvalDate: "20240130",
    },
    rows: [
      row("0021", "무관한빌딩", 20, "20240130", "제1종근린생활시설"),
      row("0432", "송파 더 플래티넘 아파트", 328, "20240215", "공동주택(아파트)"),
    ],
  });

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].bun, "0432");
  assert.ok(result.candidates[0].score >= 0.9);
});

test("단지명이 없더라도 세대수와 사용승인일이 동시에 일치하면 후보로 선택한다", () => {
  const result = resolvePermitSourcesFromBasisRows({
    requestedSource: source("0067"),
    metadata: {
      complexName: "송파더플래티넘",
      expectedHouseholds: 328,
      approvalDate: "20240130",
    },
    rows: [row("0510", "", 328, "20240130", "공동주택 아파트")],
  });

  assert.equal(result.sources[0].bun, "0510");
});

test("세대수 차이가 크거나 오피스텔인 행은 선택하지 않는다", () => {
  const result = resolvePermitSourcesFromBasisRows({
    requestedSource: source("0067"),
    metadata: {
      complexName: "송파더플래티넘",
      expectedHouseholds: 328,
      approvalDate: "20240130",
    },
    rows: [
      row("0600", "송파더플래티넘", 80, "20240130", "업무시설 오피스텔"),
      row("0601", "무관한아파트", 700, "20240130", "공동주택 아파트"),
    ],
  });

  assert.deepEqual(result.sources, []);
});

test("아파트와 오피스텔이 함께 적힌 주상복합 사업은 후보에서 제외하지 않는다", () => {
  const result = resolvePermitSourcesFromBasisRows({
    requestedSource: source("0067"),
    metadata: {
      complexName: "서초센트럴아이파크",
      expectedHouseholds: 318,
      approvalDate: "20200907",
    },
    rows: [
      row(
        "1582",
        "서초센트럴아이파크",
        318,
        "20200907",
        "공동주택(아파트), 업무시설(오피스텔)"
      ),
    ],
  });

  assert.equal(result.sources[0].bun, "1582");
});

test("숫자 하나뿐인 건물명은 단지명 일치 근거로 사용하지 않는다", () => {
  const result = resolvePermitSourcesFromBasisRows({
    requestedSource: source("0067"),
    metadata: {
      complexName: "송파레이크파크호반써밋1차",
      expectedHouseholds: 689,
      approvalDate: "20220128",
    },
    rows: [row("0700", "1", 50, "20220128", "공동주택 아파트")],
  });

  assert.deepEqual(result.sources, []);
});

function source(bun) {
  return {
    sigunguCd: "11710",
    bjdongCd: "11200",
    platGbCd: "0",
    bun,
    ji: "0000",
  };
}

function row(bun, bldNm, hhldCnt, useAprDay, mainPurpsCdNm) {
  return {
    ...source(bun),
    bldNm,
    hhldCnt,
    useAprDay,
    mainPurpsCdNm,
    mgmPmsrgstPk: `pk-${bun}`,
  };
}
