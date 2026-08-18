import { json } from "./molit.js";
import { SUPPLY_CALCULATION_VERSION, SQUARE_METERS_PER_PYEONG, buildHouseholdValidation } from "./supply-area.js";

export function requireSupplyAdmin(request, env) {
  const expected = String(env?.SUPPLY_ADMIN_TOKEN || "");
  const received = String(request.headers.get("x-supply-admin-token") || "");
  if (!expected || !received || !constantTimeEqual(expected, received)) {
    throw new SupplyAdminError("관리자 인증이 필요합니다.", 401);
  }
}

export class SupplyAdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function adminError(error) {
  return json({ error: error?.message || "관리자 요청 처리에 실패했습니다." }, error?.status || 500);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new SupplyAdminError("JSON 본문이 필요합니다.");
  }
}

export function buildManualSupplyProfile(complexKey, input, fallback = {}) {
  const groups = Array.isArray(input?.groups) ? input.groups.map(normalizeGroup).filter(Boolean) : [];
  if (!groups.length) throw new SupplyAdminError("최소 한 개 이상의 면적 그룹이 필요합니다.");
  const unitCount = groups.reduce((sum, group) => sum + group.unitCount, 0);
  const expectedHouseholds = positiveInteger(input.expectedHouseholds || fallback?.metadata?.expectedHouseholds);
  const now = new Date().toISOString();
  return {
    sourceUrl: String(input.sourceUrl || "").trim(),
    note: String(input.note || "").trim(),
    profile: {
      complexKey,
      calculationVersion: SUPPLY_CALCULATION_VERSION,
      calculatedAt: now,
      source: { type: "manual-verified", label: "관리자 검증 수동 입력" },
      groups,
      unitCount,
      rentalHouseholds: 0,
      householdValidation: buildHouseholdValidation({
        profileUnitCount: unitCount,
        expectedHouseholds,
        rentalHouseholds: 0,
      }),
      areaValidation: { status: "manual-verified", issueCount: 0, issues: [] },
      manual: {
        verified: true,
        sourceUrl: String(input.sourceUrl || "").trim(),
        note: String(input.note || "").trim(),
        enteredAt: now,
      },
    },
  };
}

function normalizeGroup(group) {
  const exclusiveArea = positiveNumber(group?.exclusiveArea);
  const supplyArea = positiveNumber(group?.supplyArea);
  const unitCount = positiveInteger(group?.unitCount);
  if (!exclusiveArea || !supplyArea || !unitCount || supplyArea < exclusiveArea) return null;
  const label = String(group?.label || `${Math.round(exclusiveArea)}타입`).trim().slice(0, 40);
  const factor = SQUARE_METERS_PER_PYEONG / supplyArea;
  return {
    id: String(group?.id || Math.round(exclusiveArea)).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30) || String(Math.round(exclusiveArea)),
    label,
    method: "manual",
    exclusiveMin: exclusiveArea,
    exclusiveMax: exclusiveArea,
    exclusiveValues: [exclusiveArea],
    targetExclusiveArea: exclusiveArea,
    representativeSupplyArea: supplyArea,
    representativeSupplyPyeong: round(supplyArea / SQUARE_METERS_PER_PYEONG, 2),
    unitCount,
    candidates: [{ supplyArea, supplyPyeong: round(supplyArea / SQUARE_METERS_PER_PYEONG, 2), unitCount, weight: 1 }],
    factor: round(factor, 10),
    dongFactors: {},
  };
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}
