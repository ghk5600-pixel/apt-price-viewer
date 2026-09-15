import {
  assertRequired,
  buildAptBasisUrl,
  errorJson,
  fetchJsonApi,
  getSearchParam,
  json,
  requireServiceKey,
} from "../_shared/molit.js";

const ALLOWED_OPERATIONS = new Set(["getAphusBassInfoV5", "getAphusDtlInfoV5"]);

export async function onRequestGet({ request, env }) {
  try {
    const serviceKey = requireServiceKey(env);
    const requestedOperation = getSearchParam(request, "operation");
    // Existing open tabs can still send the previous operation names.
    const operation = ({ getAphusBassInfoV4: "getAphusBassInfoV5", getAphusDtlInfoV4: "getAphusDtlInfoV5" })[requestedOperation] || requestedOperation;
    const kaptCode = getSearchParam(request, "kaptCode");
    assertRequired({ operation, kaptCode });
    if (!ALLOWED_OPERATIONS.has(operation)) {
      return errorJson("Unsupported apartment basis operation.", 400);
    }

    const payload = await fetchJsonApi(buildAptBasisUrl({ serviceKey, operation, kaptCode }));
    const header = payload?.response?.header || {};
    if (header.resultCode && header.resultCode !== "00") {
      return errorJson(header.resultMsg || `AptBasis API error: ${header.resultCode}`, 502);
    }

    return json({ item: payload?.response?.body?.item || {} });
  } catch (error) {
    return errorJson(error.message || "Apartment basis request failed.", 500);
  }
}
