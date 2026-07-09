import {
  assertRequired,
  buildBuildingHubUrl,
  errorJson,
  fetchJsonApi,
  getSearchParam,
  json,
  normalizeItems,
  requireServiceKey,
} from "../_shared/molit.js";

const ALLOWED_OPERATIONS = new Set(["getBrRecapTitleInfo", "getBrTitleInfo"]);

export async function onRequestGet({ request, env }) {
  try {
    const serviceKey = requireServiceKey(env);
    const operation = getSearchParam(request, "operation");
    const params = {
      sigunguCd: getSearchParam(request, "sigunguCd"),
      bjdongCd: getSearchParam(request, "bjdongCd"),
      platGbCd: getSearchParam(request, "platGbCd", "0"),
      bun: getSearchParam(request, "bun"),
      ji: getSearchParam(request, "ji"),
      pageNo: getSearchParam(request, "pageNo", "1"),
      numOfRows: getSearchParam(request, "numOfRows", "100"),
    };
    assertRequired({ operation, sigunguCd: params.sigunguCd, bjdongCd: params.bjdongCd, bun: params.bun, ji: params.ji });
    if (!ALLOWED_OPERATIONS.has(operation)) {
      return errorJson("Unsupported building ledger operation.", 400);
    }

    const payload = await fetchJsonApi(buildBuildingHubUrl({ serviceKey, operation, params }));
    const header = payload?.response?.header || {};
    if (header.resultCode && !["00", "000"].includes(String(header.resultCode))) {
      return errorJson(header.resultMsg || `Building ledger API error: ${header.resultCode}`, 502);
    }

    const body = payload?.response?.body || {};
    return json({
      items: normalizeItems(body.items || body.item),
      pageNo: Number(body.pageNo || params.pageNo),
      numOfRows: Number(body.numOfRows || params.numOfRows),
      totalCount: Number(body.totalCount || 0),
    });
  } catch (error) {
    return errorJson(error.message || "Building ledger request failed.", 500);
  }
}
